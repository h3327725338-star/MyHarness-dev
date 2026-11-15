# Extensions

Extensions are TypeScript modules for tools, commands, lifecycle events and Provider registration. MyHarness exposes browser dialogs and plain-text presentation, not terminal components or terminal input handlers.

## Loading

- Global discovery: `~/.myharness/agent/extensions/`.
- Project discovery: `.myharness/extensions/`, subject to Project Trust.
- Explicit startup input: `--extension <source>` (repeatable).
- Disable discovery: `--no-extensions`.

Use the browser resource reload action or restart the backend after changing extension code. Existing terminal extensions must migrate; terminal render callbacks, component factories, custom terminal editors, overlays and `onTerminalInput` are not supported.

## Public API

Import `ExtensionAPI` and related types from `@myharness/coding-agent`. The package facade and `src/extensions/api-entry.ts` define the public exports; `src/extensions/runtime/types.ts` defines the complete contracts.

```typescript
import type { ExtensionAPI } from "@myharness/coding-agent";

export default function (api: ExtensionAPI) {
  api.registerCommand("hello", {
    description: "Show a browser notification",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Hello from an extension", "info");
    },
  });
}
```

## Host and UI

`ctx.mode` is `"web"` for browser hosts and `"headless"` for SDK/delegated workers. `ctx.hasUI` reports whether the host actually supplied dialogs. Check it before asking for user input; do not infer UI availability from a process having a console.

`ctx.agentRole` is `"main"` in a chat and `"delegated"` in the worker process of a sub-agent. A provider extension is loaded there when the sub-agent's model is one of its own (see [custom-provider.md](custom-provider.md)); tools an extension registers are not offered to a sub-agent.

Browser UI methods include `select`, `confirm`, `input`, `notify`, editor text access, status text and plain-text widgets. Message and entry renderers return strings. Tool output is rendered from structured results by the Web frontend. Legacy persisted Theme resources remain readable for data compatibility; they do not provide terminal rendering or control browser appearance.

## Tools, commands and events

- `registerTool` registers execution contracts with parameters, cancellation, progress and results. It does not accept terminal `renderCall` or `renderResult` callbacks. A tool may set `autoActive: true` when its extension switches it on and off by itself (for example with `setActiveTools`, to follow the current model): the Web UI's Tools list then shows its real state as an automatic switch that users cannot change by hand, and `POST /api/tools/active` keeps its current state. A MyHarness that does not know the field ignores it.
- `registerCommand` adds slash commands; use `ctx.waitForIdle()` before operations that require an idle runtime.
- `on` subscribes to resource, Session, Agent, message, model, tool, compaction and request events.
- `sendMessage` / `sendUserMessage` inject messages with the delivery semantics defined by their options.
- `appendEntry`, session names and labels persist extension state in the existing Session format.
- `registerProvider` / `unregisterProvider` extend the model runtime; preserve credential and model ownership when changing registration.
- `registerWebSearchSource` adds a search source to the built-in `web_search` tool: a function that takes all queries of one call and returns titles, URLs and optional snippets per query. MyHarness merges them with its engines' results and reads the pages itself. The source is listed with the search engines in Web Search settings while its `unavailable()` returns nothing, is off until the user switches it on, and may offer `models` for the user to choose from. A model may list the reasoning levels a search can run on (`efforts`, MyHarness's names: `low` … `max`); a model with more than one gets a second row in settings, and the search receives the chosen one as `effort` (or the source's `defaultEffort`, or the model's lowest). Honor `signal` and `timeoutMs`, and throw with the reason when nothing could be searched. See [Web Search](web-search.md).
- `registerPlanUsageSource` adds a plan usage source: what is left of the subscription plan behind a provider (the 5-hour window and the weekly window, each with the percentage left and when it resets), which the Web UI shows beside that provider's models. A source has an `id` (the provider id: lowercase letters, digits and dashes), a `label`, a `snapshot()` that answers at once with what is known (`groups` of `windows`, plus optional `observedAt`, `refreshing`, `unavailable`, `error`, `nextRefreshAt`) and a `refresh({ maxAgeMs })` that reads the numbers again when the newest reading is older than that, keeps its own minimum interval between two real reads and must never reject. Sources are per process, not per chat: registering the same id again replaces the earlier one. `registerPlanUsageSource` returns a function that the source calls whenever its snapshot changed; it stays valid after the chat that registered the source is gone. MyHarness clamps `leftPercent` to 0–100 and drops windows with no usable percentage or of an unknown kind before the browser sees them. The browser reads the numbers through `GET /api/plan-usage`, `POST /api/plan-usage/refresh` and the `plan_usage` event, see [Web UI](web-ui.md).
- `exec` runs external commands through the existing process execution contract.

Cancellation, tool permission checks, error reporting, resource disposal and Session replacement must use the existing contracts. A module's long-lived resources should be released on shutdown. Do not introduce a second Agent loop or write Session files directly.

## Session and runtime operations

`ExtensionContext` exposes read-only Session access, model state, abort/idle state, context usage, compaction and shutdown. Command contexts additionally expose Session creation, fork, tree navigation, switching and resource reload. These operations can replace the active Session; do not retain stale Session references after replacement.

Provider credentials must never be logged or stored as ordinary extension messages. Project-local code is subject to Trust. See [Security](security.md), [Custom providers](custom-provider.md), [SDK](sdk.md) and [Session format](session-format.md).

Examples under `examples/extensions/` and the extension tests are executable references. Verify an example's imports and host requirements before reuse; historical terminal examples are not a supported API.
