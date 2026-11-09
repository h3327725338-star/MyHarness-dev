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
| `claude-code-shell.ts` | Runs the installed, signed-in `claude` program as a provider that only carries MyHarness's requests on the user's Claude subscription. The Windows installer carries it and loads it by itself. `claude` gets MyHarness's system prompt (built-in prompt, personal prompt, the model's own prompt, project and workspace context), rendered fresh for every request (a prompt changed while a turn runs applies from the next turn), and only MyHarness's tools, under their own names, through an SDK MCP server on its control channel; a call comes back as an ordinary tool call, so MyHarness runs it with its own approval and card. Claude Code's own tools, CLAUDE.md files, auto memory, skills, slash commands, settings files (hooks, plugins, output styles), other MCP servers, claude.ai connectors, tool search and its compaction are off. MyHarness's record is the conversation and MyHarness compacts it (by the length set with `/context-length`); `claude`'s transcript is only a cache, which a chat goes on with, also after a restart, only while the record still starts with exactly what it holds. An idle `claude` closes after an hour, the lifetime of the subscription's prompt cache, and the compaction summary runs in a fork of the chat's conversation to read its cache. A request may write at most the model's `maxTokens` (thinking included); one that reaches it ends the round as cut off and `claude` is ended before it can ask the model to go on by itself. The task then goes on through MyHarness, as often as it takes (Stop ends it): tool calls in the cut response are failed and asked for again, and a cut response without one is followed by a hidden note asking the model to go on more briefly. What `claude` still adds by itself is listed at the top of the file |

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
