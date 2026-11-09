export interface BridgePluginOptions {
	/** The per-instance endpoint, including /bridge/INSTANCE. */
	url: string;
	/** A fresh bearer token used only for this instance. */
	token: string;
}

export const BRIDGE_PLUGIN_MANIFEST = {
	name: "myharness-bridge",
	version: "0.1.0",
	description: "MyHarness interactive Claude Code event bridge",
	author: { name: "MyHarness" },
} as const;

export const BRIDGE_PLUGIN_HOOKS = { modules: ["./register.js"] } as const;

/** A single event, or a batch whose events each have their own sequence number. */
export type BridgePluginEvent =
	| { seq: number; type: "ready"; sessionId: string; version?: unknown; surfaces?: unknown }
	| { seq: number; type: "prompt_accepted"; nonce: string; turnId?: string }
	| { seq: number; type: "turn_start"; turnId: string }
	| { seq: number; type: "step_start"; turnId: string; index: number; agentId?: string }
	| { seq: number; type: "chunk"; turnId: string; index: number; agentId?: string; chunk: unknown }
	| { seq: number; type: "step_end"; turnId: string; index: number; agentId?: string; result: unknown }
	| { seq: number; type: "turn_end"; [key: string]: unknown }
	| { seq: number; type: "measure"; [key: string]: unknown }
	| {
			seq: number;
			type: "tool_start" | "tool_end";
			event: {
				id: string;
				name: string;
				input: Record<string, unknown>;
				agentId?: string;
				turnId?: string;
				result?: unknown;
			};
	  }
	| { seq: number; type: "bridge_error"; error: string; turnId?: string }
	| { seq: number; type: "control_result"; id: string; result?: unknown; error?: string };

export type BridgePluginMessage = BridgePluginEvent | { type: "batch"; events: BridgePluginEvent[] };
export type BridgePluginCommand =
	| { id: string; type: "cancel"; turnId: string }
	| { id: string; type: "compact"; instructions?: string };

/**
 * Generates an ES module for hooks/register.js. Claude Code executes it in its
 * isolated Mod environment, not Node. Each instance owns its URL and token.
 */
export function createBridgePluginSource({ url, token }: BridgePluginOptions): string {
	const parsed = new URL(url);
	if (
		parsed.protocol !== "http:" ||
		parsed.hostname !== "127.0.0.1" ||
		!parsed.port ||
		!/^\/bridge\/[^/]+$/.test(parsed.pathname) ||
		parsed.search ||
		parsed.hash ||
		parsed.username ||
		parsed.password
	) {
		throw new Error("Bridge URL must be an HTTP loopback /bridge/INSTANCE endpoint with a port");
	}
	if (typeof token !== "string" || !token || /[\r\n]/.test(token)) {
		throw new Error("Bridge bearer token must be a non-empty single-line string");
	}
	const config = JSON.stringify({ url, token })
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
	return `const CONFIG = ${config};
let state;

async function request($, url, init) {
  const response = await $.http.fetch(url, init);
  if (!response.ok) throw new Error('Bridge HTTP status ' + response.status);
  return response;
}
function headers() {
  return { Authorization: 'Bearer ' + CONFIG.token, 'Content-Type': 'application/json' };
}
async function stop($, error, turnId, report = true) {
  const first = !state.failure;
  if (first) {
    state.failure = error instanceof Error ? error : new Error(String(error));
    if (state.flushTimer) state.flushTimer.cancel();
    if (state.pollTimer) state.pollTimer.cancel();
    $.ui.log('MyHarness bridge failed: ' + state.failure.message, { to: 'debug' });
  }
  const id = turnId || state.turnId;
  if (id) {
    try { await $.turn.abort({ turnId: id }); }
    catch (abortError) { $.ui.log('Bridge abort failed: ' + String(abortError), { to: 'debug' }); }
  }
  if (first && report) {
    state.pending.push({ type: 'bridge_error', error: state.failure.message, ...(id ? { turnId: id } : {}), seq: ++state.seq });
    try { await flush($, true); }
    catch (reportError) { $.ui.log('Bridge failure report failed: ' + String(reportError), { to: 'debug' }); }
  }
}
async function flush($, reporting = false) {
  if (state.failure && !reporting) throw state.failure;
  if (state.flushTimer) { state.flushTimer.cancel(); state.flushTimer = null; }
  while (state.sending) {
    await state.sending;
    if (state.failure && !reporting) throw state.failure;
  }
  if (!state.pending.length) return;
  const events = state.pending.splice(0, 32);
  const payload = events.length === 1 ? events[0] : { type: 'batch', events };
  const body = JSON.stringify(payload);
  if (body.length > 4000000) {
    const error = new Error('Bridge event exceeds HTTP request body limit');
    await stop($, error, undefined, false);
    throw error;
  }
  const sending = request($, CONFIG.url, { method: 'POST', headers: headers(), body });
  state.sending = sending;
  try { await sending; }
  catch (error) { await stop($, error, undefined, false); throw error; }
  finally { if (state.sending === sending) state.sending = null; }
  if (state.pending.length) await flush($, reporting);
}
async function flushTimer($) {
  state.flushTimer = null;
  await flush($);
}
function enqueue($, event) {
  if (state.failure) throw state.failure;
  state.pending.push({ ...event, seq: ++state.seq });
  if (!state.flushTimer) state.flushTimer = $.clock.after(25, () => flushTimer($));
}
async function emit($, event) {
  enqueue($, event);
  await flush($);
}
async function poll($) {
  if (state.failure || state.ended) return;
  try {
    const response = await request($, CONFIG.url + '/commands', { method: 'GET', headers: headers() });
    if (response.status !== 204) {
      const data = JSON.parse(response.text);
      if (!data || !Array.isArray(data.commands) || data.commands.length > 32) throw new Error('Invalid bridge commands response');
      for (const command of data.commands) {
        if (!command || typeof command.id !== 'string' || !command.id) throw new Error('Invalid bridge command id');
        let result;
        let error;
        try {
          if (command.type === 'cancel' && typeof command.turnId === 'string' && command.turnId) {
            await $.turn.abort({ turnId: command.turnId });
            result = {};
          } else if (command.type === 'compact' && (command.instructions === undefined || typeof command.instructions === 'string')) {
            result = await $.session.compact(command.instructions === undefined ? {} : { instructions: command.instructions });
          } else {
            throw new Error('Unsupported or invalid bridge command');
          }
        } catch (commandError) { error = String(commandError && commandError.message || commandError); }
        await emit($, error === undefined ? { type: 'control_result', id: command.id, result } : { type: 'control_result', id: command.id, error });
      }
    }
  } catch (error) {
    await stop($, error);
    throw error;
  }
  if (!state.ended && !state.failure) state.pollTimer = $.clock.after(250, () => poll($));
}
async function start($) {
  try {
    const sessionId = await $.session.id();
    const version = await $.session.version();
    const surfaces = await $.session.surfaces();
    await emit($, { type: 'ready', sessionId, version, surfaces });
    if (!state.ended) state.pollTimer = $.clock.after(0, () => poll($));
  } catch (error) { await stop($, error); throw error; }
}
function toolEvent(type, e, result) {
  const { tool, tool_use_id, agentId, consent, ...input } = e;
  const event = { id: tool_use_id, name: tool, input };
  if (agentId !== undefined) event.agentId = agentId;
  if (state.turnId && agentId === undefined) event.turnId = state.turnId;
  if (result !== undefined) event.result = result;
  return { type, event };
}

export function register(on) {
  state = { seq: 0, pending: [], sending: null, failure: null, turnId: null, flushTimer: null, pollTimer: null, ended: false, toolTail: Promise.resolve() };
  on('session.start', async ($, e, next) => {
    const result = await next(e);
    $.clock.after(0, () => start($));
    return result;
  });
  on('session.end', async ($, e, next) => {
    state.ended = true;
    if (state.pollTimer) state.pollTimer.cancel();
    if (state.flushTimer) state.flushTimer.cancel();
    await flush($);
    return next(e);
  });
  on('prompt.submit', async ($, e, next) => {
    if (state.failure) throw state.failure;
    const match = /^MYHARNESS_INPUT_([0-9a-f]{32})$/.exec(e.text);
    if (!match) return next(e);
    try {
      const response = await request($, CONFIG.url + '/input/' + match[1], { method: 'GET', headers: headers() });
      const input = JSON.parse(response.text);
      if (!input || typeof input.text !== 'string' || (input.context !== undefined && (!Array.isArray(input.context) || !input.context.every(item => typeof item === 'string')))) throw new Error('Invalid bridge input response');
      const event = input.context === undefined ? { ...e, text: input.text } : { ...e, text: input.text, context: [...(e.context || []), ...input.context] };
      const result = await next(event);
      if (!result.drop) await emit($, { type: 'prompt_accepted', nonce: match[1], ...(state.turnId ? { turnId: state.turnId } : {}) });
      return result;
    } catch (error) { await stop($, error); throw error; }
  }).catch(async ($, e, next) => {
    await stop($, new Error('Bridge prompt hook failed'));
    if (next.called) return next(e);
    return { drop: 'MyHarness bridge failed; prompt was not submitted.' };
  });
  on('prompt.attachment', ($, e, next) => {
    if (e.origin.kind !== 'engine') return next(e);
    return { text: null };
  });
  on('turn.start', async ($, e, next) => {
    state.turnId = e.turnId;
    await emit($, { type: 'turn_start', turnId: e.turnId });
    return next(e);
  }).catch(async ($, e) => {
    await stop($, new Error('Bridge turn start failed'), e.turnId);
    return { turnId: e.turnId };
  });
  on('turn.step', async function* ($, e, next) {
    const position = { turnId: e.turnId, index: e.index, ...(e.agentId === undefined ? {} : { agentId: e.agentId }) };
    try {
      await emit($, { type: 'step_start', ...position });
      const stream = next(e);
      const finished = stream.result.then(result => ({ result }), error => ({ error }));
      for await (const chunk of stream) {
        enqueue($, { type: 'chunk', ...position, chunk });
        if (chunk.kind === 'stop' || state.pending.length >= 32 || JSON.stringify(state.pending).length > 64000) await flush($);
        yield chunk;
      }
      const completion = await finished;
      if ('error' in completion) throw completion.error;
      const result = completion.result;
      await emit($, { type: 'step_end', ...position, result });
      return result;
    } catch (error) { await stop($, error, e.turnId); throw error; }
  }).catch(async function* ($, e) {
    await stop($, new Error('Bridge stream hook failed'), e.turnId);
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null };
  });
  on('turn.complete', async ($, e, next) => {
    await emit($, { ...e, type: 'turn_end' });
    if (!e.agentId && state.turnId === e.turnId) state.turnId = null;
    return next(e);
  });
  on('session.measure', async ($, e, next) => {
    await emit($, { ...e, type: 'measure' });
    return next(e);
  });
  on('tool.call', async ($, e, next) => {
    const run = state.toolTail.then(async () => {
      await emit($, toolEvent('tool_start', e));
      const unsupported = !e.tool.startsWith('mcp__myharness__') && e.tool !== 'EndConversation';
      const result = unsupported ? { deny: 'This session only supports MyHarness MCP tools.' } : await next(e);
      await emit($, toolEvent('tool_end', e, result));
      if (unsupported) await stop($, new Error('Unsupported Claude Code tool: ' + e.tool));
      return result;
    });
    state.toolTail = run.then(() => undefined, () => undefined);
    return run;
  }).catch(async ($, e, next) => {
    await stop($, new Error('Bridge tool hook failed'));
    return { deny: 'MyHarness bridge failed; this tool call was stopped.' };
  });
}
`;
}
