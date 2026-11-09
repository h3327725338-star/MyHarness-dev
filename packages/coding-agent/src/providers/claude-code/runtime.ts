import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	ToolCall,
	Usage,
} from "@myharness/ai";
import { createAssistantMessageEventStream } from "@myharness/ai";
import { MCP_PREFIX, outputLimitFor, providerDirectory, readContextWindow } from "./config.ts";
import { ConversationLinks, canResume, digest, durableHistory, historyDigest, reconstructPrompt } from "./history.ts";
import { type InteractiveDependencies, InteractiveSession } from "./interactive-session.ts";
import type { BridgeEvent } from "./local-bridge.ts";

export function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function fromCliUsage(value: unknown): Usage {
	const source = value as Record<string, unknown> | undefined;
	const number = (key: string) =>
		typeof source?.[key] === "number" && Number.isFinite(source[key]) && source[key] >= 0
			? (source[key] as number)
			: 0;
	const usage = zeroUsage();
	usage.input = number("input_tokens");
	usage.output = number("output_tokens");
	usage.cacheRead = number("cache_read_input_tokens");
	usage.cacheWrite = number("cache_creation_input_tokens");
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	usage.reported = {
		input: source?.input_tokens !== undefined,
		output: source?.output_tokens !== undefined,
		cacheRead: source?.cache_read_input_tokens !== undefined,
		cacheWrite: source?.cache_creation_input_tokens !== undefined,
	};
	usage.cacheReported = !!usage.reported.cacheRead || !!usage.reported.cacheWrite;
	return usage;
}

export interface ClaudeRuntimeOptions extends InteractiveDependencies {
	cwd?: (sessionId: string | undefined) => string;
	onMeasure?: (sessionId: string, event: BridgeEvent) => void;
}

/** Provider-owned state; helpers with a chat id never share its native conversation. */
export class ClaudeCodeRuntime {
	private sessions = new Map<string, InteractiveSession>();
	private busy = new Set<string>();
	private toolExecutions = new Map<string, number>();
	private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly links: ConversationLinks;

	private readonly dependencies: ClaudeRuntimeOptions;
	constructor(dependencies: ClaudeRuntimeOptions = {}) {
		this.dependencies = dependencies;
		this.links = new ConversationLinks(dependencies.dataDirectory?.() || providerDirectory());
	}

	stream(model: Model<any>, context: Context, options: SimpleStreamOptions = {}): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			void this.run(stream, model, context, options);
		});
		return stream;
	}

	async reset(sessionId: string, forget = true): Promise<void> {
		const session = this.sessions.get(sessionId);
		this.sessions.delete(sessionId);
		const timer = this.idleTimers.get(sessionId);
		if (timer) clearTimeout(timer);
		this.idleTimers.delete(sessionId);
		try {
			if (forget) this.links.write(sessionId, undefined);
		} finally {
			await session?.close();
		}
	}

	async compact(
		sessionId: string,
		instructions?: string,
		signal?: AbortSignal,
	): Promise<{ summary: string; tokensBefore: number } | undefined> {
		if (this.busy.has(sessionId)) throw new Error("Claude Code 正在处理请求，请在当前轮结束后压缩。");
		const session = this.sessions.get(sessionId);
		if (!session?.ready) return undefined;
		this.busy.add(sessionId);
		const commandId = session.bridge.command("compact", { instructions });
		const deadline = Date.now() + 120_000;
		try {
			while (Date.now() < deadline) {
				const event = await session.next(signal, Math.max(1, deadline - Date.now()));
				if (event.type === "measure") this.dependencies.onMeasure?.(sessionId, event);
				if (event.type !== "control_result" || event.id !== commandId) continue;
				if (event.error) throw new Error(String(event.error));
				const result = event.result as {
					skip?: string;
					messages?: { role: string; text: string; toolUses?: unknown[]; toolResults?: unknown[] }[];
					tokensBefore?: number;
				};
				if (result.skip || !Array.isArray(result.messages))
					throw new Error(result.skip || "Claude Code 没有返回压缩后的对话。");
				const summary = result.messages
					.map(({ role, text, toolUses, toolResults }) =>
						JSON.stringify({
							role,
							text,
							...(toolUses?.length ? { toolUses } : {}),
							...(toolResults?.length ? { toolResults } : {}),
						}),
					)
					.join("\n");
				// The host writes a new compaction checkpoint after this callback; rebuild once from that exact branch.
				// Reusing the old link would compare against a history which no longer exists.
				await this.reset(sessionId);
				return { summary, tokensBefore: result.tokensBefore || 0 };
			}
			throw new Error("Claude Code 压缩超时。");
		} catch (error) {
			await this.reset(sessionId);
			throw error;
		} finally {
			this.busy.delete(sessionId);
		}
	}

	async close(): Promise<void> {
		await Promise.all([...this.sessions.keys()].map((id) => this.reset(id, false)));
	}

	private async run(
		stream: AssistantMessageEventStream,
		model: Model<any>,
		context: Context,
		options: SimpleStreamOptions,
	): Promise<void> {
		const output: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [],
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const started = Date.now();
		let session: InteractiveSession | undefined;
		let release: (() => void) | undefined;
		// The host injects this callback only for its inference loop, including chats with zero enabled tools.
		const persistent = !!options.sessionId && typeof options.toolCallHandler === "function";
		const sessionId = persistent ? options.sessionId! : undefined;
		let claimedBusy = false;
		const hostMessages: Message[] = [];
		const messages = durableHistory([...context.messages]);
		const transient = context.messages.filter((message) => message.timestamp === 0);
		const totals = zeroUsage();
		let stepCount = 0;
		let currentStep = -1;
		let lengthReached = false;
		const blocks = new Map<string, number>();
		const openBlocks = new Set<number>();
		const endBlocks = () => {
			for (const contentIndex of openBlocks) {
				const block = output.content[contentIndex];
				if (block.type === "text")
					stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
				else if (block.type === "thinking")
					stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
			}
			openBlocks.clear();
		};
		const append = (kind: "text" | "thinking", text: string, index: number) => {
			if (!text) return;
			const key = `${currentStep}:${index}:${kind}`;
			let contentIndex = blocks.get(key);
			if (contentIndex === undefined) {
				contentIndex = output.content.length;
				blocks.set(key, contentIndex);
				openBlocks.add(contentIndex);
				output.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
				if (kind === "text") stream.push({ type: "text_start", contentIndex, partial: output });
				else stream.push({ type: "thinking_start", contentIndex, partial: output });
			}
			const block = output.content[contentIndex];
			if (kind === "text" && block.type === "text") {
				block.text += text;
				stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
			} else if (kind === "thinking" && block.type === "thinking") {
				block.thinking += text;
				stream.push({ type: "thinking_delta", contentIndex, delta: text, partial: output });
			}
		};
		const recordUsage = (usage: unknown) => {
			if (!usage) return;
			output.usage = fromCliUsage(usage); // Last request, not the sum of input contexts, drives the context meter.
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
				totals[key] += output.usage[key];
		};
		stream.push({ type: "start", partial: output });
		try {
			if (options.signal?.aborted) throw new Error("Operation aborted");
			if (sessionId) {
				if (this.toolExecutions.get(sessionId))
					throw new Error("上一轮 MyHarness 工具仍在结束处理中，请待工具退出后继续。");
				if (this.busy.has(sessionId)) throw new Error("同一 Claude Code 会话正在处理另一轮请求。");
				this.busy.add(sessionId);
				claimedBusy = true;
				const idle = this.idleTimers.get(sessionId);
				if (idle) clearTimeout(idle);
				this.idleTimers.delete(sessionId);
			}
			if (
				messages.some(
					(message) =>
						message.role === "user" &&
						Array.isArray(message.content) &&
						message.content.some((part) => part.type === "image"),
				)
			)
				throw new Error("当前 Claude Code 交互 Provider 支持文本输入；请使用图片助手把图片内容转为文本后重试。");
			const cwd = this.dependencies.cwd?.(sessionId) || process.cwd();
			const tools = persistent ? (context.tools || []).filter((tool) => tool.name !== "claude_code_tool") : [];
			const uniqueNames = new Set(tools.map((tool) => tool.name));
			if (uniqueNames.size !== tools.length || tools.some((tool) => !/^[\w-]{1,64}$/.test(tool.name)))
				throw new Error("MyHarness 工具名称需唯一且符合 MCP 命名规则。");
			const effort =
				options.reasoning && ["low", "medium", "high", "xhigh", "max"].includes(options.reasoning)
					? options.reasoning
					: undefined;
			const maxOutputTokens = outputLimitFor(model, options.maxTokens);
			const contextWindow = readContextWindow();
			session = sessionId ? this.sessions.get(sessionId) : undefined;
			const profile =
				session?.profile || this.dependencies.profile?.() || (await import("./config.ts")).profileDirectory();
			let link = sessionId ? this.links.read(sessionId) : undefined;
			let resumable = canResume(link, cwd, profile, messages);
			// A provider switch may have inserted assistant/tool messages after our checkpoint. Rebuild from the actual
			// host branch instead of hiding these messages or pretending they were native turns.
			if (resumable && messages.slice(link!.historyCount).some((message) => message.role !== "user"))
				resumable = false;
			if (!resumable) {
				link = undefined;
				if (sessionId) this.links.write(sessionId, undefined);
			}
			const signature = digest({
				model: model.id,
				effort,
				prompt: context.systemPrompt || "",
				tools,
				maxOutputTokens,
				contextWindow,
				cwd,
				profile,
			});
			if (session && (session.signature !== signature || !link)) {
				await this.reset(sessionId!, false);
				session = undefined;
			}
			const makeSession = async (resume: boolean) => {
				const current = new InteractiveSession(this.dependencies);
				session = current;
				current.signature = signature;
				if (sessionId) this.sessions.set(sessionId, current);
				await current.start({
					cwd,
					model: model.id,
					effort,
					systemPrompt: context.systemPrompt || "",
					tools,
					contextWindow,
					maxOutputTokens,
					sessionId: resume ? link!.claudeSessionId : undefined,
					resume,
					signal: options.signal,
				});
			};
			if (!session) {
				try {
					await makeSession(!!link);
				} catch (error) {
					if (!link || options.signal?.aborted) throw error;
					await (session as InteractiveSession | undefined)?.close();
					link = undefined;
					if (sessionId) this.links.write(sessionId, undefined);
					await makeSession(false); // Only retry before any prompt or host tool has been submitted.
				}
			}
			const active = session!;
			release = active.bridge.setTurn(
				tools,
				options.toolCallHandler
					? async (call: ToolCall, signal) => {
							if (sessionId) this.toolExecutions.set(sessionId, (this.toolExecutions.get(sessionId) || 0) + 1);
							try {
								const result = await options.toolCallHandler!(call, signal);
								if (signal?.aborted) throw new Error("Host tool cancelled");
								hostMessages.push(
									{
										role: "assistant",
										api: model.api,
										provider: model.provider,
										model: model.id,
										content: [call],
										usage: zeroUsage(),
										stopReason: "toolUse",
										timestamp: Date.now(),
									},
									result,
								);
								return result;
							} finally {
								if (sessionId) {
									const count = (this.toolExecutions.get(sessionId) || 1) - 1;
									if (count) this.toolExecutions.set(sessionId, count);
									else this.toolExecutions.delete(sessionId);
								}
							}
						}
					: undefined,
				options.signal,
			);
			const pending = reconstructPrompt([...transient, ...messages.slice(link?.historyCount || 0)], 0);
			if (!pending.trim()) throw new Error("Claude Code 请求没有待发送的对话内容。");
			const nonce = active.submit(pending);
			const acknowledgeDeadline = Date.now() + 30_000;
			let accepted = false;
			let ended = false;
			while (!ended) {
				if (!accepted && Date.now() >= acknowledgeDeadline)
					throw new Error("Claude Code 尚未接收输入；请在独立配置终端中完成登录和当前项目的信任确认。");
				const event = await active.next(
					options.signal,
					accepted ? options.timeoutMs || 120_000 : Math.max(1, acknowledgeDeadline - Date.now()),
				);
				if (
					event.type === "heartbeat" ||
					event.type === "tool_start" ||
					event.type === "tool_end" ||
					event.type === "control_result"
				)
					continue;
				if (event.type === "prompt_accepted") {
					if (event.nonce === nonce) accepted = true;
					continue;
				}
				if (event.type === "fatal" || event.type === "bridge_error")
					throw new Error("Claude Code Mod bridge reported an internal failure");
				if (event.type === "measure") {
					if (sessionId) this.dependencies.onMeasure?.(sessionId, event);
					continue;
				}
				if (event.agentId) {
					// Never mix a native helper/compaction loop's output into the user's answer.
					// Native helper/compaction costs are tracked separately, never used as the main context anchor.
					if (event.type === "step_end") {
						const result = event.result as Record<string, unknown> | undefined;
						const usage = fromCliUsage(result?.usage);
						for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
							totals[key] += usage[key];
					}
					continue;
				}
				if (event.type === "turn_start") {
					active.turnId = String(event.turnId || "");
					continue;
				}
				if (event.type === "step_start") {
					currentStep = Number(event.index || 0);
					stepCount++;
					continue;
				}
				if (event.type === "chunk") {
					const chunk = event.chunk as Record<string, unknown> | undefined;
					if (!chunk) throw new Error("Malformed Claude Code stream chunk");
					if (chunk.kind === "text" || chunk.kind === "thinking")
						append(chunk.kind, String(chunk.text || ""), Number(chunk.index || 0));
					if (
						chunk.kind === "tool" &&
						!String(chunk.name).startsWith(MCP_PREFIX) &&
						chunk.name !== "EndConversation"
					)
						throw new Error("Claude Code offered an unexpected native business tool");
					if (chunk.kind === "stop" && chunk.stopReason === "max_tokens") {
						recordUsage(chunk.usage);
						lengthReached = true;
						output.stopReason = "length";
						active.interrupt();
						ended = true;
					}
					continue;
				}
				if (event.type === "step_end") {
					const result = event.result as Record<string, unknown> | undefined;
					recordUsage(result?.usage);
					endBlocks();
					if (result?.stopReason === "max_tokens") {
						lengthReached = true;
						output.stopReason = "length";
						active.interrupt();
						ended = true;
					}
					if (result?.stopReason === "model_context_window_exceeded")
						throw new Error("Claude Code reached its model context window");
					continue;
				}
				if (event.type === "turn_end") {
					if (!accepted) throw new Error("Claude Code did not acknowledge the submitted MyHarness prompt");
					if (event.reason === "error")
						throw new Error("Claude Code model request failed; check isolated login, model access and network");
					if (event.isAborted || event.reason === "aborted") throw new Error("Claude Code turn was interrupted");
					if (
						!output.content.some((part) => part.type === "text" && part.text) &&
						typeof event.answer === "string"
					)
						append("text", event.answer, 0);
					ended = true;
				}
			}
			await active.bridge.drainTools();
			endBlocks();
			output.requestDurationMs = Date.now() - started;
			output.diagnostics = [
				{
					type: "claude-code-interactive-usage",
					timestamp: Date.now(),
					details: {
						version: 1,
						transport: "interactive-pty-mod",
						requestCount: stepCount,
						turnTokens: totals,
						contextUsage: "last-main-request",
						subscriptionWeight: "not-measured",
						usageIncludesOnlyObservedModSteps: true,
					},
				},
			];
			if (sessionId && !lengthReached)
				this.links.write(sessionId, {
					version: 1,
					claudeSessionId: active.claudeSessionId,
					cwd,
					profile: active.profile,
					historyCount: messages.length + hostMessages.length + 1,
					historyDigest: historyDigest([...messages, ...hostMessages, output]),
				});
			if (sessionId && lengthReached) await this.reset(sessionId);
			if (!sessionId) await active.close();
			stream.push({ type: "done", reason: output.stopReason as "stop" | "length", message: output });
		} catch (error) {
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = options.signal?.aborted
				? "Request was aborted"
				: error instanceof Error
					? error.message
					: String(error);
			output.requestDurationMs = Date.now() - started;
			// Preserve the original failure even if checkpoint I/O or best-effort process cleanup also fails.
			if (sessionId && claimedBusy) await this.reset(sessionId).catch(() => session?.close().catch(() => undefined));
			else await session?.close().catch(() => undefined);
			endBlocks();
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			release?.();
			if (sessionId && claimedBusy) {
				this.busy.delete(sessionId);
				if (this.sessions.has(sessionId)) {
					const timer = setTimeout(() => {
						void this.reset(sessionId, false);
					}, 15 * 60_000);
					timer.unref();
					this.idleTimers.set(sessionId, timer);
				}
			}
			stream.end();
		}
	}
}
