<p align="right"><a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a></p>

<p align="center">
  <a href="https://youtu.be/0QUhR5p5z0c"><img src="packages/coding-agent/docs/images/readme-demo-video.png" alt="MyHarness. Less to worry about. Watch the 2:29 demo video on YouTube." width="820"></a>
</p>

<p align="center">
  MyHarness is a personal AI for your Windows PC that works inside the websites you're already signed into, remembers what matters to you, keeps chats and schedules in sync across your computers, and still handles coding when you need it. Bring your own model: add any OpenAI-, Anthropic-, Gemini- or Mistral-compatible Provider, and give each job its own model.
</p>

<p align="center">
  <a href="https://github.com/h3327725338-star/MyHarness/releases/latest"><img alt="Download for Windows" src="packages/coding-agent/docs/images/readme-button-download.svg" height="38"></a>
  <a href="https://youtu.be/0QUhR5p5z0c"><img alt="Demo video" src="packages/coding-agent/docs/images/readme-button-demo.svg" height="38"></a>
  <a href="docs/evaluation/README.md"><img alt="Evaluation: real runs and results" src="packages/coding-agent/docs/images/readme-button-evaluation.svg" height="38"></a>
  <a href="docs/JUDGE_TESTING.md"><img alt="Judge testing guide" src="packages/coding-agent/docs/images/readme-button-guide.svg" height="38"></a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/github/license/h3327725338-star/MyHarness"></a>
  &nbsp;·&nbsp; <a href="docs/JUDGE_TESTING.md#known-limitations">Known limitations</a>
</p>

<p align="center"><strong>Measured on real runs, with the main chat on NVIDIA Nemotron 3.5 Lightning.</strong> <a href="docs/evaluation/README.md">Methods, every failure and how to repeat the runs</a>.</p>

<table>
  <tr>
    <td align="center" valign="top" width="25%"><h3>196 / 200</h3>random SimpleQA questions answered correctly with web search (Google + Tavily)</td>
    <td align="center" valign="top" width="25%"><h3>111 / 120</h3>memory questions answered correctly in brand-new chats</td>
    <td align="center" valign="top" width="25%"><h3>8 / 9</h3>tasks done on a signed-in website</td>
    <td align="center" valign="top" width="25%"><h3>15 / 15</h3>image questions answered correctly through Nemotron 3.5 Super VL</td>
  </tr>
</table>

## Why MyHarness

AI assistants have become smart, but in daily use they still leave the legwork to you. These are the gaps MyHarness was built to close:

- **They can't reach the real web.** Ask about a page and many assistants say they can't open it, or answer from a few search snippets; a wide search that actually reads the sources is rare. *MyHarness searches several engines, reads the full pages, and opens a blocked page in a real browser.*
- **They can't use your accounts.** Your course portal, inbox, GitHub and cloud console sit behind sign-ins, and handing an agent your passwords is not an option. *MyHarness works in the browser you're already signed into. Saved passwords are filled in by the app and never reach the model, and sign-ins and human checks are handed back to you.*
- **They only work when you ask.** Nothing happens at 8:00 unless you open the chat and type. *MyHarness runs reminders, agent tasks and emails on a schedule, keeps running from the tray, and can start with Windows.*
- **They forget you when you switch computers.** Your history and context stay on one machine or one account; move from the desktop at home to the laptop you carry and you start from zero. *MyHarness syncs memories, everyday chats, schedules, bookmarks and prompts through your own Google Drive.*
- **One assistant fits nobody.** A course, a job and a side project each need their own instructions, memory and documents, but most assistants offer one global prompt at best. *MyHarness gives each part of your life a workspace with its own instructions, memory and document library.*
- **Long work falls apart.** Long chats overflow the context, and what you settled last week is gone unless you paste it in again. *MyHarness compacts long chats, continues them in a fresh chat with a handoff summary, and looks up your earlier chats when they matter.*
- **The small things feel rough.** Quoting part of an answer for a follow-up, translating a word or a sentence, or getting back to the line you quoted takes more steps than it should. *In MyHarness you select text to quote it or translate it in place, and a quote jumps back to its source.*
- **Your data sits on someone else's server.** Chats, memories and keys end up in a cloud you don't control. *MyHarness keeps them on your PC, with no MyHarness server; if you turn on sync, the copy goes to your own Google Drive.*

MyHarness started as one computer-science student's fix for these problems, built around a real week of course portals, deadlines and two PCs.

## What it does

### In the real web

![MyHarness with its built-in browser beside the chat: the agent read a made-up demo course portal in its own browser and listed the deadlines](packages/coding-agent/docs/images/myharness-browser-chat.png)

<table>
  <tr>
    <td><img src="packages/coding-agent/docs/images/readme-web-search.png" alt="Searches the web, with Tavily: MyHarness answers a question about APA citations after one search round and three opened pages" width="400"></td>
    <td><img src="packages/coding-agent/docs/images/readme-human-check.png" alt="Hands it to me: the agent stops at a human check on a demo site and asks the user to complete it" width="400"></td>
  </tr>
</table>

<details>
<summary>Works in the sites you're signed into · Bookmarks it understands · Reads real pages, not just snippets · Stops where only you should act</summary>

- **Works in the sites you're signed into.** A real Chromium browser is built in, with one persistent profile, so your sign-ins survive restarts. The agent opens its own background tabs, reads whole pages, clicks, types and downloads files, while you keep browsing in yours.
- **Bookmarks it understands.** Every bookmark carries a one-line note of what you use the site for, written by you or by a helper model, so "check what's due this week" reaches the right portal without you naming it.
- **Reads real pages, not just snippets.** Web search runs on Tavily (no key needed) and Google, then reads the full text of the top results. When a site or search engine blocks a plain request, MyHarness opens it in a real browser instead of giving up.
- **Stops where only you should act.** Saved passwords are filled in by the app itself and never reach the model. When a page needs your sign-in or a human check, a request bar appears on that tab; the agent waits and carries on once you're done. On CAPTCHA and bot-check pages its clicks and typing are refused.

</details>

### Memory and your profile

![It remembers: an email drafted for the user already names the lecturer, the assignment and the due date](packages/coding-agent/docs/images/readme-memory.png)

<details>
<summary>Memory at three levels · Saves without being asked · Builds your profile · Keeps itself tidy · Recalls within a budget</summary>

- **Memory at three levels.** Global memories go everywhere with you, each workspace keeps its own, and each chat keeps its own notes, so one course's details don't spill into another's chats.
- **Saves without being asked.** After each task, Auto Memory picks out what is worth keeping and files it at the right level. You can still say "remember this" or "forget that" at any time.
- **Builds your profile.** A resident user profile grows out of your conversations and goes with every turn, so the assistant knows your goals, habits and preferences from the first message.
- **Keeps itself tidy.** In the background, MyHarness merges related memories, settles contradictions in favour of the newer fact and keeps every replaced version in an archive, without asking you to approve each change.
- **Recalls within a budget.** Memories are recalled on every turn within a fixed budget, so a large profile never crowds out the conversation.

</details>

### Conversations that connect

<details>
<summary>Many chats at once · Chats that know each other · Long work keeps going · Rewind or fork · Steer while it works · Find and keep</summary>

- **Many chats at once.** Several chats can run at the same time without blocking each other, each with its own task and tools.
- **Chats that know each other.** When a question touches an earlier conversation, the assistant looks it up by itself and links its answer back to the exact message it used.
- **Long work keeps going.** Long chats are compacted to stay within the context window, and any chat can continue in a fresh one that starts from a handoff summary.
- **Rewind or fork.** Rewind to any message, or fork a new chat from it while the original stays as it was.
- **Steer while it works.** Send a message while a task is running, to steer it on the spot or queue the next step.
- **Find and keep.** Search and filter your chats, archive old ones, and export a chat as a self-contained HTML page.

</details>

### Workspaces and personalization

![A desktop, a work PC and a laptop drawn as small white cities, connected through your own Google Drive](packages/coding-agent/docs/images/readme-sync.png)

<details>
<summary>A workspace for each part of your life · Your own prompts · Follows you to your other PCs</summary>

- **A workspace for each part of your life.** General-mode workspaces, for example one per course or project, each have their own instructions, memory and document library.
- **Your own prompts.** A personal prompt for each mode, a list of saved prompts to reuse in any chat, and skills and prompt templates for more.
- **Follows you to your other PCs.** Memories at every level, your profile, everyday (General-mode) chats with their branches, schedules, bookmarks, prompts and drafts sync through your own Google Drive, and changes made on two PCs are merged instead of overwritten.

</details>

### Works on its own

![Every morning: a scheduled task opened a demo course portal and listed this week's deadlines](packages/coding-agent/docs/images/readme-schedules.png)

<details>
<summary>Runs on a schedule · Keeps you posted · Handles email and GitHub</summary>

- **Runs on a schedule.** Reminders, agent tasks ("every weekday at 8:00, check my portal and inbox and note new deadlines") and emails sent exactly on time. They run while MyHarness is open, including from the tray, and it can start with Windows.
- **Keeps you posted.** A card tells you when a task starts, finishes or fails, with a system notification and an optional sound when you're in another window.
- **Handles email and GitHub.** Gmail and Outlook, through their API or the webmail page you're already signed into; GitHub through the sign-in already on your PC.

</details>

### Big jobs, in parallel

- **Sub-agents that split the work.** For research or other big jobs, the assistant hands parts to sub-agents that run in parallel, and you can stop any one of them. Staged workflows handle longer jobs step by step.

### Polished for daily use

<details>
<summary>Quote and ask · Translate anything you select · Sees images and opens your files · A browser that comes first · Made to feel like yours</summary>

- **Quote and ask.** Select any part of an answer to quote it in your next message; a quote in a sent message jumps back to the original text.
- **Translate anything you select.** In the chat, files or panels, a translation card opens in place, and a single word gets a dictionary entry with UK and US pronunciation.
- **Sees images and opens your files.** Drop in files and images; images are read by a vision model, and PDFs and images open in the side panel next to the chat.
- **A browser that comes first.** Full-screen browsing keeps the chat one edge away, websites follow the app's dark mode, and each site keeps its own zoom.
- **Made to feel like yours.** Three color themes, an English or Chinese interface, and keyboard shortcuts for the common actions.

</details>

### Your models, your data

- **A model for every job.** Sub-agents, memory, chat naming, translation, vision, schedules and the other helper jobs can each have their own model and thinking level.
- **Your data stays on your PC.** The interface listens only on `127.0.0.1`; the Android app reaches the PC either on your local network after you turn the phone link on and scan its QR code, or from any network when the phone is signed in with the same Google account (connection details and, without a direct path, the messages themselves go as encrypted files through your own Drive; Google's public STUN servers see the two devices' addresses), and every message is encrypted with the phone's own key. Chats, memories, settings and keys live in `%USERPROFILE%\.myharness` (a source build run from a checkout keeps chats and memories in that checkout's `data` folder), and there is no MyHarness server. Model calls go to the Provider you choose, and sync goes through your own Google Drive. Sync is not end-to-end encrypted, except the browser's sign-ins, which are sealed with your passphrase before upload.

### Still writes code

- **Coding mode** works inside a repository with Git, worktrees, per-turn change review and sub-agents.

> Status: usable today on Windows x64, from the desktop app or a source checkout. No model Provider is built in: any OpenAI-, Anthropic-, Gemini- or Mistral-compatible Provider can be added by hand (Settings → Providers → **Add provider**). The verified boundaries are listed in [PROJECT_STATUS.md](PROJECT_STATUS.md).

## A model for every job

![Every job, its own model: Settings → Agent lists a model for each job, such as conversation naming, Auto Memory, sub-agents and the vision assistant](packages/coding-agent/docs/images/readme-models.png)

*Settings → Agent. Any job can use a different model, with its own thinking level.*

No model Provider is built in. Add one in Settings → **Providers** → **Add provider** (see [Providers](packages/coding-agent/docs/providers.md)), then pick the main model in the composer and, if you like, a model for each helper job in Settings → Agent.

## Memory, user profile and cross-device sync

- A resident user profile (`global/用户画像`) is sent on every turn instead of being ranked against the query, with a layered recall budget (profile slot, catalog slot, dynamic cards) so a large profile cannot crowd out the rest of the context.
- Three memory scopes — global, workspace and session — plus archives and a pending quarantine, with tools to search, read, write, delete and claim an entry. Background maintenance folds new material into the profile and merges related memories without per-item approval.
- MyHarness talks to the Google Drive API directly and syncs all memory scopes (archives, pending entries, the profile), General-mode workspaces and chats with their branches and handoff summaries, session attachments and artifacts, workspace library sources, drafts, the General-mode personal prompt, saved prompts (My prompts), scheduled tasks, the configuration (Providers with their models and API keys, the portable preferences, model prompts, skills, prompt templates and themes; never subscription or other OAuth sign-ins), and the built-in browser's bookmarks, new-tab shortcuts and site settings. The Android app signed in with the same Google account gets the chats, Providers with their keys, memories and bookmarks from there and sends its own chats back; the browser's sign-ins and saved passwords travel only when a sync passphrase is set, sealed with it on the device before upload.
- It does not sync API keys, OAuth tokens, trust decisions, tool permissions, locks, running tasks, Coding-mode chats or repositories, or other Web UI preferences.
- Merging uses a stable key plus a per-device version vector: memories merge three-way against the last version both devices agreed on, chats merge by entry id so both branches survive, and a conflict that cannot be merged keeps the local version and saves the other as a recoverable copy listed in Settings. Nothing arriving from Drive can grant Project Trust or execute a command.
- Boundary: sync talks to the Drive API directly. Besides the in-memory-transport tests, the maintainer has run it for real across at least four PCs. Sync stops when the app quits, and apart from the browser's sealed sign-in vault there is no end-to-end encryption. See [Google Drive sync](packages/coding-agent/docs/google-drive-sync.md).

## Quick Start (Windows)

**Installer.** Download `MyHarness-Setup-<version>.exe` from the MyHarness release on the [Releases](https://github.com/h3327725338-star/MyHarness/releases) page and run it.
- It is not code-signed, so SmartScreen asks first: click **More info**, then **Run anyway**.
- Choose **Only for me** to install without administrator rights.
- Uninstalling keeps your data in `%USERPROFILE%\.myharness`.

**From source.** Requirements:

- Windows 10 or 11, x64;
- Node.js `>=22.19.0`;
- Git for Windows if you want to use the `bash` tool;
- a model Provider key: no Provider is built in; add one by hand.

```powershell
git clone https://github.com/h3327725338-star/MyHarness.git
cd MyHarness
npm.cmd install --ignore-scripts
npm.cmd run build
.\dev-desktop.cmd
```

`dev-desktop.cmd` builds and starts the Electron desktop app, which is the normal way to use MyHarness. To run the sources from a command line instead, use `node --import ./scripts/dev-fast-loader.mjs ./packages/coding-agent/src/web.ts` from the repository root; it opens no browser and prints the actual address as `MyHarness Web UI: <url>`.

After startup, the start screen links to Settings → Providers, where you add a Provider. Providers are described in [Providers](packages/coding-agent/docs/providers.md) and [Settings](packages/coding-agent/docs/settings.md).

To check that the Web source entry can start without a Provider credential:

```powershell
node --import ./scripts/dev-fast-loader.mjs ./packages/coding-agent/src/web.ts --help
```

This smoke check does not prove that an external Provider, OAuth flow, Web Search service, or real model conversation works.

## Evaluating this project

[Evaluation: real runs on NVIDIA Nemotron](docs/evaluation/README.md) reports what MyHarness did on web search, signed-in website tasks, human-check handoff, memory, images, sub-agents and schedules: the setup, every failure with its cause, the cost at list prices, and the scripts to repeat the runs.

<p align="center">
  <img src="packages/coding-agent/docs/images/readme-eval-search.png" alt="Short fact questions answered correctly (SimpleQA), graded with OpenAI's own grader prompt. This evaluation on Nemotron 3.5 Lightning: 97 of 100 and 99 of 100 with Google and a Tavily key, 90 of 100 with Bing and keyless Tavily, 10 of 100 with the same model and no search. Vendors' published numbers, on other dates and samples and not head-to-head: 97%, 93.3%, 93.25%, 90% and 38%." width="640">
</p>

<p align="center">
  <img src="packages/coding-agent/docs/images/readme-eval-workflows.png" alt="Core workflows, runs that gave the right result: reading images 15 of 15; signed-in website tasks 3 of 3, 3 of 3 and 2 of 3; handing a human check to a real person 3 of 3; scheduled tasks 3 of 3, 2 of 3, 2 of 3 and 6 of 6; sub-agent reports 4 of 5; memory in new chats 55 of 60, 56 of 60 and 24 of 24." width="640">
</p>

[Judge testing guide](docs/JUDGE_TESTING.md) covers installing (or building from source), adding the judge Provider, a five-minute test script, what to inspect in the source, and the known limitations.

## For developers

Under the hood, an Electron shell runs a local-only Web UI (`127.0.0.1`) and a shared backend that connects the model Provider to your files, shell commands, a built-in browser, tools and resumable sessions.

<details>
<summary>Architecture and feature details</summary>

- **Code collaboration**: file, shell, PowerShell, editing, writing, Symbols, Git, and GitHub workflows exposed through the Coding Agent product layer.
- **Entry points**: a local browser **Web UI** (`myharness`, loopback only), packaged as a Windows desktop app, plus a Node.js SDK for in-process integrations. Terminal Interactive, Print and JSON modes have been removed; the Web Terminal panel is retained.
- **Conversations and changes**: resumable sessions, per-turn change review, branch summaries, and context compaction over long sessions.
- **Project context**: project trust, `AGENTS.md` / `CLAUDE.md` context files, Workspace and Session management, Git integration.
- **Extensibility**: TypeScript extensions, skills, prompt templates, themes, custom Providers, and MyHarness packages.
- **Code Intelligence**: semantic Symbols navigation through optional Windows language-server modules installed per language. The `symbols` tool is disabled by default and can be enabled with `codeIntelligence.symbolsEnabled`; changes take effect after restart.
- **Two modes, one backend**: Coding mode works inside a repository; General mode handles research, writing and everyday tasks with per-workspace instructions, workspace memory and a document library. Chat lists, drafts and color themes are kept per mode.
- **A browser the agent can drive**: the right panel hosts real Chromium tabs (`WebContentsView` on desktop, one persistent partition so logins survive restarts); the `workspace` tool navigates, clicks, types, reads the page or its accessibility tree, runs page scripts, screenshots, downloads files and inspects requests.
- **Multi-agent work**: `agent` (foreground and background batches), `workflow` (staged) and `ultracode` (multi-pass) dispatch, with a three-level activity bar, per-agent stop and explicit terminal states; `agent_tasks` lets the main agent list and stop its own dispatches.
- **Per-role model binding**: the main model is picked in the composer's model menu, and Settings → Agent binds a Provider, model and thinking level for each helper role — sub-agents, Auto Memory, chat naming, compaction, branch and handoff summaries, commit descriptions, worktree naming, translation, vision, and a fallback model. A role set to “Use the main model” follows the main chat's model and effort; for the fallback model that means no fallback.
- **Web search on by default**: Tavily and Google. Without a key Tavily answers through its free keyless access (rate limited by Tavily); Settings → Web search has a **Get a free key** link for 1,000 searches a month. Bing, DuckDuckGo and Brave can be added, and an engine that blocks the lightweight request falls back to a browser.
- **Optional extras**: TypeScript extensions, skills and prompt templates.

</details>

The source and status documents deliberately separate implemented contracts, configured runtime behavior, and machine- or credential-dependent validation.

## Documentation

- [Coding Agent documentation index](packages/coding-agent/docs/index.md)
- [Quickstart](packages/coding-agent/docs/quickstart.md)
- [Usage and Web startup](packages/coding-agent/docs/usage.md)
- [Providers and models](packages/coding-agent/docs/providers.md)
- [Google Drive sync](packages/coding-agent/docs/google-drive-sync.md)
- [Windows setup](packages/coding-agent/docs/windows.md)
- [Project status and validation boundaries](PROJECT_STATUS.md)
- [Architecture and development handbook](ARCHITECTURE_AND_DEVELOPMENT.md)
- [Development guide](packages/coding-agent/docs/development.md)
- [Source module map](packages/coding-agent/docs/source-modules.md)
- [Storage and data boundaries](docs/STORAGE.md)
- [Maintenance guide](MAINTENANCE.md)
- [GitHub automation](docs/maintenance/github-automation.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Documentation map](DOCUMENTATION_INDEX.md)
- [简体中文 README](README.zh-CN.md)

## Development and contribution

From the repository root:

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run audit:release
```

`npm.cmd run check` runs Biome with write enabled and can modify formatted files. See [CONTRIBUTING.md](CONTRIBUTING.md) for the supported checks, release/privacy boundaries, and pull-request expectations.

## Acknowledgements

MyHarness began as a fork of [pi-mono](https://github.com/badlogic/pi-mono) by Mario Zechner (MIT) and has since been extensively rewritten and extended. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the original license.

## License

MyHarness-owned work is distributed under the [Apache License 2.0](LICENSE). Inherited and third-party components retain their own licenses, copyrights, and attributions; see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
