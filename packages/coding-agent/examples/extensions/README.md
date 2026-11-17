# Extension Examples

Example extensions for myharness-coding-agent.

## Usage

```bash
# Load an extension with --extension flag
myharness --extension examples/extensions/permission-gate.ts

# Or copy to extensions directory for auto-discovery
cp permission-gate.ts ~/.myharness/agent/extensions/
```

## Examples

### Lifecycle & Safety

| Extension | Description |
|-----------|-------------|
| `permission-gate.ts` | Prompts for confirmation before dangerous bash commands (rm -rf, sudo, etc.) |
| `bash-spawn-hook.ts` | Adjusts command, cwd, and env before bash execution |
| `project-trust.ts` | Demonstrates the `project_trust` event for user/global and CLI extensions |
| `protected-paths.ts` | Blocks writes to protected paths (.env, .git/, node_modules/) |
| `confirm-destructive.ts` | Confirms before destructive session actions (clear, switch, fork) |
| `dirty-repo-guard.ts` | Prevents session changes with uncommitted git changes |
| `sandbox/` | OS-level sandboxing using `@anthropic-ai/sandbox-runtime` with per-project config |
| `gondolin/` | Route built-in tools and `!` commands into a Gondolin micro-VM |

### Custom Tools

| Extension | Description |
|-----------|-------------|
| `hello.ts` | Minimal custom tool example |
| `tool-override.ts` | Override built-in tools (e.g., add logging/access control to `read`) |
| `dynamic-tools.ts` | Register tools after startup (`session_start`) and at runtime via command, with prompt snippets and tool-specific prompt guidelines |
| `kimi-deferred-tools.ts` | Search for and progressively activate tools for Kimi's deferred-tool loading protocol |
| `subagent/` | Delegate tasks to specialized subagents with isolated context windows |

### Commands & UI

| Extension | Description |
|-----------|-------------|
| `commands.ts` | Lists all available slash commands via a `/commands` command |
| `plan-mode/` | Two-phase planning example with full tools, a Phase 2 Bash allowlist, and step tracking |
| `widget-placement.ts` | Shows widgets above and below the editor via `ctx.ui.setWidget()` placement |
| `hidden-thinking-label.ts` | Customizes the collapsed thinking label via `ctx.ui.setHiddenThinkingLabel()` |
| `model-status.ts` | Shows model changes in status bar via `model_select` hook |
| `send-user-message.ts` | Demonstrates `pi.sendUserMessage()` for sending user messages from extensions |
| `timed-confirm.ts` | Demonstrates AbortSignal for auto-dismissing `ctx.ui.confirm()` and `ctx.ui.select()` dialogs |
| `notify.ts` | Desktop notifications via OSC 777 when agent finishes (Ghostty, iTerm2, WezTerm) |
| `titlebar-spinner.ts` | Braille spinner animation in terminal title while the agent is working |
| `working-message-test.ts` | Sets a custom working message/indicator to verify they survive loader recreations |
| `shutdown-command.ts` | Demonstrates `ctx.shutdown()` |
| `input-transform.ts` | Intercepts user input via the `input` event (`?quick`, `ping`, `time`) |
| `reload-runtime.ts` | Adds a `reload_runtime` tool showing safe reload flow |
| `inline-bash.ts` | Expands `!{command}` patterns in prompts via `input` event transformation |
| `input-transform-streaming.ts` | Skips expensive input preprocessing for mid-stream steering via `streamingBehavior` |

### Git Integration

| Extension | Description |
|-----------|-------------|
| `git-checkpoint.ts` | Creates git stash checkpoints at each turn for code restoration on fork |
| `git-merge-and-resolve.ts` | Fetches/merges the upstream tracking ref after each turn and surfaces conflict blocks for resolution |
| `auto-commit-on-exit.ts` | Deprecated no-op; use the built-in `/commit` command |

### System Prompt & Compaction

| Extension | Description |
|-----------|-------------|
| `pirate.ts` | Demonstrates the `before_agent_start` event to dynamically modify the system prompt |
| `claude-rules.ts` | Scans `.claude/rules/` folder and lists rules in system prompt |
| `custom-compaction.ts` | Custom compaction that summarizes entire conversation |
| `trigger-compact.ts` | Triggers compaction when context usage exceeds 100k tokens |
| `prompt-customizer.ts` | Adds tool- and skill-aware guidance to the system prompt via systemPromptOptions |
| `system-prompt-header.ts` | Shows system prompt length via `ctx.getSystemPrompt()` |

### System Integration

| Extension | Description |
|-----------|-------------|
| `provider-payload.ts` | Logs (and optionally replaces) the provider request payload via `before_provider_request` |

### Resources

| Extension | Description |
|-----------|-------------|
| `dynamic-resources/` | Loads skills, prompts, and themes using `resources_discover` |

### Messages & Communication

| Extension | Description |
|-----------|-------------|
| `event-bus.ts` | Inter-extension communication via `pi.events` |

### Session Metadata

| Extension | Description |
|-----------|-------------|
| `session-name.ts` | Name sessions for the session selector via `setSessionName` |
| `bookmark.ts` | Bookmark entries with labels for session-tree navigation via `setLabel` |

### Custom Providers

| Extension | Description |
|-----------|-------------|
| `custom-provider-anthropic/` | Custom Anthropic provider with OAuth support and custom streaming implementation |
| `custom-provider-gitlab-duo/` | GitLab Duo provider using myharness-ai's built-in Anthropic/OpenAI streaming via proxy |
| `claude-code-shell.ts` | Runs the installed, signed-in `claude` program as a provider on the user's Claude subscription, under the client name `myharness`. The Windows installer carries it and loads it by itself. `claude` keeps its own system prompt, and MyHarness's whole prompt (built-in prompt, personal prompt, project and workspace context, the model's own prompt) is appended to it after a short section saying that MyHarness's instructions win; no CLAUDE.md and no auto memory files are loaded, and a changed prompt applies from the next turn. Which tools a chat has is MyHarness's decision: `claude` gets one of its own tools (Read, Write, Edit, Grep, Glob, Bash) only while the MyHarness tool it stands in for is switched on in that chat, shown as a `claude_code_tool` card with a one-line summary, and every other switched-on MyHarness tool (to-do list, questions, sub-agents, web search, memory, schedules, background jobs and so on) over a local MCP endpoint, all of them in every request, run by MyHarness with its own card and approval. The `claude_code_tool` card tool is registered with `autoActive: true`: the extension itself switches it on while the chat's model is a Claude Code one and off for any other model, so the Tools list in the Web UI shows it as an automatic switch that cannot be flipped by hand. Claude Code's own sub-agents, skills, web search and fetch, question tool, tool search, the user's other MCP servers and claude.ai connectors are off. `claude` compacts these chats itself, by the length set with `/context-length`. What is left of the subscription's plan limits (the 5-hour and the weekly window, a single model's weekly limit such as Fable's when `claude` lists one, and when each resets) is read from a short-lived `claude` (`get_usage`, no model request) and shown by MyHarness's plan limits meter in the composer bar (`pi.registerPlanUsageSource`), the same in every chat; a MyHarness without that meter shows the two windows in the status bar of Claude Code chats as before. A request may write at most the model's `maxTokens` (thinking included); one that reaches it ends the round as cut off and the turn in `claude` is stopped before it can ask the model to go on by itself. The task then goes on through MyHarness, as often as it takes (Stop ends it): tool calls in the cut response are failed and asked for again, and a cut response without one is followed by a hidden note asking the model to go on more briefly. A request `claude` starts over by itself after a dropped connection leaves nothing behind: what was read of the dead attempt is taken back, and none of its calls gets a card. A tool of `claude`'s own that says nothing for its time limit and five more minutes is taken as stuck: the request is stopped, its cards end with an error and the task goes on through MyHarness. `claude` runs with bypassPermissions, so its own tools do not ask before they act. MyHarness's sub-agents can run on these models: there `claude` gets none of its own tools and every tool call goes through MyHarness (so the sub-agent's read-only guard and its sandbox or worktree hold), nothing is kept in the Claude Code history, and Claude Code's memory folder is off so that sub-agents share one cached prompt. It also registers `claude`'s own WebSearch as a search source of `web_search` ("Claude Code" in Web Search settings, off by default, Haiku 5.5 on `--effort low` unless the user picks another model or reasoning level): one short `claude` run with WebSearch as its only tool searches all queries of a call and is stopped when the results are in; MyHarness reads the pages itself |
| `agy-shell.ts` | Runs the installed `agy` program (Google's Antigravity CLI, 1.5.0 or newer) as a provider, the way its documentation describes for editors: `agy acp`, an Agent Client Protocol server spoken to over stdin/stdout, one per chat. The Windows installer carries it and loads it by itself. Sign-in is `agy`'s own (`/agy-login` asks `agy` to sign in; a Gemini API key saved on the provider's card is handed to `agy` as `GEMINI_API_KEY`); an older `agy` is never started and the user is told to run `agy update`. Chat sessions select a managed custom agent (`~/.gemini/config/agents/myharness-host-v2/agent.md`, never overwriting an edited definition), with `excludeDefaultComponents: true`, native action tools removed, inherited MCP/customizations disabled, and hidden from the normal agent list. agy 1.5.9 still exposes `manage_task`, `list_resources` and `read_resource`; the prompt prohibits their use and native permission requests are refused. Temporary title and summary requests also select this host agent. The web-search source alone keeps its separate search connection. MyHarness's whole prompt supplies the authoritative instruction hierarchy, including its built-in rules, user personalization, project context and tool rules; the adapter preserves the priorities within that prompt. Each turn also carries a short host reminder. Existing default-agent conversations are replaced with a new host conversation carrying MyHarness's saved history. The prompt is part of `agy`'s system prompt, not of a message: it travels as `_meta.antigravity.systemPrompt.append` on the request that opens the conversation (`agy` says in its `initialize` answer that it takes one; seen with agy 1.5.9), and again every time the conversation is opened, because `agy` does not keep it with the conversation. So it is in force for the whole conversation and `agy`'s own compaction cannot summarize it away; when it changed (a setting, a tool switch), the conversation is closed and resumed with the new one. A chat refuses an `agy` without system append or HTTP MCP support rather than falling back to instructions in a user message. When a message is sent in a chat on agy, `agy` is started and the chat's conversation opened at once, while MyHarness still looks up memories, so the model request does not wait for the start (not while a saved Gemini API key is in use, and not for the first message after MyHarness started or its prompt changed: the conversation is opened with the finished prompt, which the plugin sees with the first request). Every `agy` the plugin starts has `agy`'s own background updater switched off (`AGY_CLI_DISABLE_AUTO_UPDATE=true`): started without a console, that updater opened a terminal window for a moment after a task on Windows. The plugin runs `agy update` hidden in its place, at most every 15 minutes while agy is in use. Every switched-on MyHarness tool, including reading and changing files and running commands, is offered over the authenticated local MCP endpoint and run by MyHarness with its own card and approval. Unexpected native permission requests are refused; native file or command names are not mistaken for MyHarness MCP tools. The separate web-search source keeps its native search tool and does not select the host agent. The conversation and its context are `agy`'s (`managesOwnContext`, `runsOwnTools`); a chat's conversation is resumed after `agy` restarts when `agy` supports that. The models are the ones `agy` lists for the account, each with the thinking levels `agy` has for it: read from `agy models` (no model request) until a conversation has listed them, from the conversation's own list after that. There is no "default model" entry any more; a chat saved on it opens on the model MyHarness falls back to. `agy` adds an argument of its own, `toolSummary`, to every tool call and checks the call against the tool's schema, so each MyHarness tool is offered as one open object (a tool whose parameters are a choice of objects, like the built-in browser's `workspace`, becomes a single object with an `operation` list, and its description says what each operation takes) and that argument is taken out before MyHarness checks the call. What is left of the plan (each pool of models `agy` lists, its 5-hour and weekly window and when each resets; a window nothing was used of has no reset time yet) is read with `agy -p /usage`, which makes no model request, and shown by MyHarness's plan limits meter in the composer bar (`pi.registerPlanUsageSource`); a MyHarness without that meter shows it in the status line of chats on agy as before (`agy 额度剩余 5h … · 7d …`, and the model's own limit when `agy` lists one). It is not read while a saved Gemini API key is in use. Settings → Provider → agy lists the models, and each has a context length (50K up to the model's window): a conversation that has reached it is compacted by `agy`'s own /compact before the next message. The cache hit rate and the speed of a chat come from the record `agy` keeps of the conversation (`~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl`); that place is not documented by `agy`, and a chat shows the context size alone when it is not there. A call `agy` reports and never finishes ends its card with an error two seconds after `agy` ends the turn, and Stop also ends an `agy` that hangs while it starts or opens the conversation. Meant for the person at the keyboard, not for schedules, sub-agents or workflows; Google's terms restrict using Antigravity sign-in from other software. It also registers `agy`'s own search_web as a search source of `web_search` ("agy" in Web Search settings, off by default, Gemini 3.8 Flash on its lowest thinking level unless the user picks another model or level): a conversation of its own that only searches, with every other permission refused; each search stays as a short conversation in `agy`'s history, and MyHarness reads the pages itself |

### agy adapter behavior and remaining upstream limits

- Requests without tools (titles, memory, translations and handoff summaries) use independent managed-host conversations. They cannot interrupt or change the main chat's tools. Their supplied history goes as one message within the size limit below: newest messages first, so an instruction at the end stays; a single message that is too long keeps its beginning and end, with how many bytes were left out between them.
- `agy` passes on only the beginning of a long message (with agy 1.5.9 and Gemini 4 Hydrogen the first 192,000 UTF-8 bytes of the request, its own wrapping included, measured 2026-11-17; text and embedded resources count, images do not) and drops the rest without telling the client. So whatever the plugin builds into one message stays under 150,000 bytes (`MAX_PROMPT_BYTES`): when a new agy conversation gets the chat's earlier messages as text (after a branch, an edit and resend, compaction, switching back to agy, or a conversation that cannot be resumed), the new message goes whole, what was said comes next, newest first, and tool results fill the rest, newest first, each at most 20,000 bytes and otherwise named with its size; older messages that do not fit are left out with a note saying how many. When `agy`'s record still shows that it cut a message, the user is warned, later messages on that model stay under what it took, and a conversation whose history was cut is replaced by a new one at the next message.
- Manual compaction uses MyHarness's normal checkpoint generator, including custom instructions, instead of saving an empty placeholder for agy's private `/compact` summary. After success the next agy conversation is rebuilt from that checkpoint. Switching to another provider also invalidates the old agy link so intervening history is included when switching back.
- Rotating a saved Gemini API key restarts the process between turns. Fixed-level CLI model ids can resolve to ACP's separate model and thinking-level options. Unsupported requested levels fail explicitly.
- A turn with no ACP activity for ten minutes is cancelled; this watchdog pauses while a MyHarness MCP tool is pending. The private automatic `/compact` request has a ten-minute timeout. Output truncation queues a follow-up; request-count limits and unknown stop reasons report an error with partial output retained. Failed requests account their recorded usage separately from the next turn.
- Unsupported image input fails visibly before sending the prompt. ACP text resources and resource links are rendered as text; model image/audio generation is not implemented by this text-response adapter.
- agy models remain unavailable as MyHarness delegated workers: upstream auxiliary tools are still exposed outside MyHarness's tool guard. Do not declare `delegatedHostTools` until that boundary is enforceable. The official ACP guide also restricts third-party models to specified editors; the adapter identifies itself as MyHarness and cannot promise access to every model printed by `agy models`. See [the official guide](https://antigravity.google/docs/ide/extensions/acp/).

### External Dependencies

| Extension | Description |
|-----------|-------------|
| `with-deps/` | Extension with its own package.json and dependencies (demonstrates jiti module resolution) |
| `file-trigger.ts` | Watches a trigger file and injects contents into conversation |

## Writing Extensions

See [docs/extensions.md](../../docs/extensions.md) for full documentation.

```typescript
import type { ExtensionAPI } from "@myharness/coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // Subscribe to lifecycle events
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  // Register custom tools
  pi.registerTool({
    name: "greet",
    label: "Greeting",
    description: "Generate a greeting",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });

  // Register commands
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify("Hello!", "info");
    },
  });
}
```

## Key Patterns

**Use StringEnum for string parameters** (required for Google API compatibility):
```typescript
import { StringEnum } from "@myharness/ai";

// Good
action: StringEnum(["list", "add"] as const)

// Bad - doesn't work with Google
action: Type.Union([Type.Literal("list"), Type.Literal("add")])
```

**State persistence via details:**
```typescript
// Store state in tool result details for proper forking support
return {
  content: [{ type: "text", text: "Done" }],
  details: { todos: [...todos], nextId },  // Persisted in session
};

// Reconstruct on session events
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.toolName === "my_tool") {
      const details = entry.message.details;
      // Reconstruct state from details
    }
  }
});
```
