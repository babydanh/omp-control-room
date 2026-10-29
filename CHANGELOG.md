# Changelog

## Unreleased

### Features

- **Compact squad runs** — one fresh worker session per repository completes and self-reviews its task; child work bypasses per-item judging and stays off the main board lanes. The squad leader gathers results, asks once for user decisions, and keeps the completed summary available until closed.

- **Faster, safer squad worktrees** — Editing worktree setup runs concurrently while reserving each selected item's folder and repo slots; setup waits when the repo drive has less than the configurable 10 GB free-disk default. Squad settings expose the threshold, including per-project and per-folder overrides, and omp leaders cap thinking at `high`.

- **Windows' own folder dialog** — every place that asks for a folder ("Mở thư mục…" in the folder menu and the palette, "+ Phiên mới" when no folder is open, the sidebar's "Tạo project" ➕, and "Duyệt…" when adding a folder to a Project) opens Windows' folder dialog, with its address bar and "New folder" button, instead of a board-made browser. The dialog opens on the monitor of the browser window it was asked from. "Tạo project" now asks for the folder first: the new Project is named after it, holds it at once, and the sidebar shows it on its own with "Đã tạo project …"; a folder already in the tree is refused with that reason and its Project is shown. "Duyệt…" in a Project's "Thêm thư mục" adds the folder chosen straight away ("Đã thêm thư mục … vào project …"), whether or not the menu is still open; a typed path that is refused keeps the form open with the reason. The board-made browser and its folder listing and folder creation commands are gone.
- **Unfinished and recently stopped sessions** — a sidebar session that stopped with its work not done says so: "bị ngắt" (its last turn was cut off, the reason on hover) or "dở" (it stopped with todo tasks left). "Làm dở (N)" beside "Ẩn phiên rảnh" keeps only those, exited ones included. Above the tree, "Vừa ngủ / tắt" lists the six sessions put to sleep or exited last, newest first, with how long ago and what they left undone. Resting the pointer on a session shows its first request and the user's five newest prompts. The server keeps the main sessions that exited within the last day (at most 20) as `ended` rows with `stoppedAt`; `board status` still lists live sessions only.
- **Wake a stopped session from its details** - each "Vừa ngủ / tắt" row shows the session's code (`#` and the last 8 characters of its id). Clicking it opens a card with the full code (copyable), the progress and why it stopped, what the agent last answered, the newest prompts and the first request, and "Đánh thức" with an optional prompt. A sleeping herdr pane wakes through herdr; an exited omp session a board chat ran reopens as that chat; any other exited omp or Claude Code session resumes in a new herdr tab (`omp --resume <file>`, `claude --resume <id>`). The board then opens where it runs. Clicking an exited session in the tree opens the same card. A session whose process was killed (a closed terminal, a crash) counts as exited when it was last seen, so it is listed and can be woken. A board chat that moves to a new omp file in the same process (the fresh session of an approved plan, `/new`, `/resume`) now records that file, so reopening it resumes where it was.
- **Questions from chat sessions are board cards** - an `ask` from a board chat session (like one from a worker) shows in the attention bar, the session banner and the "Chờ bạn" lane. Answering it on the board closes the terminal dialog with those choices, question by question, including typed answers; answering in the terminal still works. Neither path adds a second "The user answered…" turn.
- **Idle omp browsers are stopped** — omp keeps a headless Chrome (~300 MB) alive for hours after its last page closes. The server now stops one that has had no open page for 10 minutes (checked every 2 minutes), shows them in the status pill as "Trình duyệt ẩn của omp", and offers "Dọn ngay" to stop the idle ones at once. Pass `--no-browser-reaper` or set `PIXEL_AGENTS_BROWSER_REAPER=0` to keep them running.
- **Squad run controls** — right-click (or Shift+F10 / long-press) a Đội card to cancel an unfinished run or remove a finished run from the board. Approved work items are kept.
- **Usage page** — a board page shows every omp account's limits (with the reported capacity), the recorded limit history for 1, 7 or 30 days with per-client token burn, and the full token-usage picture: totals, the time series, usage by model, folder and agent type, the cost breakdown, and model performance. Reads run only when the page asks; limits are cached for a minute, history and stats for five minutes, and a forced refresh is limited to one read per 30–60 seconds.
- **Cloud fleet view** — The privileged Agent Board lists InstaBox machines reported to the configured fleet hub, including last-seen/stale state, sessions, repository branches and dirty-file counts, with same-file overlap warnings against other cloud machines and local Git checkouts. Hub settings live in optional `~/.pixel-agents/fleet.json`; the key and short-lived read token stay on the server.
- **Unified CLI sessions** — “Phiên agent” combines every local `activity.db` session with the Cloud fleet’s tmux sessions, with engine and machine filters, cwd, branch and running/idle/ended state. Codex, pi and ThinkRail launches use their lane-wrapper `.cmd` files in Herdr tabs; one core engine catalog supplies provider labels and launch kinds.
- **Cloud PR and CI status** — local and cloud branch rows show origin ahead/behind counts, linked PR state/draft status, and CI health; a red check can be sent to an open session on that exact branch. No merge action is exposed.
- **Local pull-request actions** — work branches can be pushed, opened as draft PRs with commit subjects and a matching OpenSpec proposal, marked ready, and removed from origin only when their PR is merged or closed. Push and removal ask for confirmation; `main` and `staging` stay protected, and merges go through merge-lane.
- **Branch analysis** — background analysis compares each local and cloud work branch with `origin/main`, reports changed modules, shared files and verified merge-tree conflicts, and suggests the next step. The same-file collision count appears in `board status`.
- **Cloud diff comments** — select one or more lines in a cloud diff and send a file/line/code comment to the matching open tmux session without placing comment text in a shell command.
- **Git guard and worktree shelf** — the board scans configurable local roots every 10 minutes, backs up unpushed commits every 30 minutes to `refs/backup/<machine>/<branch>`, and combines local plus cloud guard reports in “Rủi ro mất code” with red counts and `board status` summary. Worktrees are grouped as “Đang làm / Ngủ / Rác”; safe cleanup uses the existing local `who.py prune --yes` rules and cloud `git worktree remove` without `--force`. Set `PIXEL_AGENTS_GIT_GUARD_ROOTS` to override local roots or `GIT_GUARD_PRUNE=0` to disable cloud cleanup.
- **Claude Code worker MCP servers** — the squad settings list the MCP servers defined in your Claude Code config (`~/.claude.json`, top level and this folder's entry) as chips; the ones you pick are the only servers a worker run loads, copied at run time into a temporary file (mode 0600, removed when the run ends) and never logged. A server that writes a credential inline (`headers`, or an env name with TOKEN, KEY, SECRET, PASSWORD, PAT, AUTH or CREDENTIAL) is not offered; `headersHelper` is.

- **Agent Board and per-role CLIs** — The board is now named Agent Board. Squad settings choose omp, Claude Code or agy (Antigravity) independently for the leader, judge and auto-assigned workers, with separate Claude and agy concurrency limits.

### Changes

- Folders whose directory has gone are no longer listed in the tree, the switcher or the rail. An open folder that disappears stays once as "Thư mục không còn" with a "Gỡ khỏi danh sách" action; the recent list drops missing folders and keeps their display names.
- Cards that move between lanes glide along a slow arc instead of snapping, and opening or collapsing a lane eases its width. Reduced motion keeps the instant layout.
- The board's header is one row: the title, the folder switcher, "+ Phiên mới", the status pill, search, and a "⋯" menu holding Đàn agent, Tệp (Ctrl+Shift+F), Cây git (Ctrl+Shift+L) and Phím tắt, each labelled. The duplicate "Duyệt thư mục" and "Chọn thư mục…" buttons are gone; the status pill reads as one word, and its runner and quota counts stay in its popover. On a phone the title is hidden from view to make room.
- Empty lanes fold to narrow strips until you open them, and a lane that empties again folds back.
- The board's scroll areas no longer draw scrollbars. An edge with more content beyond it fades out instead; scrolling works as before.
- Claude Code worker runs load no MCP server by default. The squad settings choose which servers from `~/.claude.json` a run may load (`--strict-mcp-config`); leader and judge turns also pass `--disable-slash-commands`.

## v1.5.0

### Features

- **Embedded terminal in the browser** ([#347](https://github.com/pixel-agents-hq/pixel-agents/pull/347)) — `npx pixel-agents` is now a full surface: **+ Agent** launches Claude Code in a server-side terminal that streams into a drawer beside the office, so you can launch, watch, type into and close agents without VS Code. Terminals outlive the page, so a reload reattaches to the running session with its current screen. Pass `--no-terminal` to keep the office watch-only.
- **Mobile web app** ([#404](https://github.com/pixel-agents-hq/pixel-agents/pull/404)) — On a phone the standalone office becomes a home-screen web app: office and terminal as two pages you swipe between, a bar of agent cards, touch gestures on the office, touch scrolling and long-press selection in the terminal, and an accessory key bar above the keyboard (esc, shift+tab, paste, a trackpad key).
- **Agent cards in VS Code** ([#404](https://github.com/pixel-agents-hq/pixel-agents/pull/404)) — Every agent gets a mug shot and status dot along the office's right edge; clicking one raises its terminal and selects the character.
- **Directories** ([#405](https://github.com/pixel-agents-hq/pixel-agents/pull/405)) — **+ Agent** opens a drawer of Directories to launch into, on both hosts: your workspace folders (or the directory the CLI started in) plus your own, each with a name, a path and optionally the Areas its agents should sit in. Paths are suggested from your past Claude Code sessions. The host's own Directories are listed only when **Show Workspace Folders** (VS Code) or **Show Start Directory** (standalone) is on in Settings; both are off by default.
- **Layout editor upgrades** ([#426](https://github.com/pixel-agents-hq/pixel-agents/pull/426)) — Alt+drag drops a copy; desks carry the items standing on them when moved, rotated or copied; Erase removes furniture it passes over; each floor, wall or erase stroke is one undo step; the colour sliders gain an eyedropper, and selecting a placed item opens its colours directly.

### Changes

- **Skip permissions is a setting** ([#405](https://github.com/pixel-agents-hq/pixel-agents/pull/405)) — Launching with `--dangerously-skip-permissions` is no longer chosen per launch: a **Settings** toggle (off by default) applies it to every launch, including auto-spawned agents.
- **Standalone access token** ([#347](https://github.com/pixel-agents-hq/pixel-agents/pull/347)) — The standalone URL carries a `?token=` that is now kept across restarts in `~/.pixel-agents/standalone-token`, so bookmarks and home-screen apps keep working. Launching, terminals and hook installs need it; a browser without it can only watch. Treat the URL as a secret. `--rotate-token` replaces it, and `--allowed-host` admits a reverse proxy's hostname (such as Tailscale Serve).
- Agents restored from v1.4.x keep their labels and Area assignments.

### Maintenance

- `@vscode/test-electron` 3.1 so the VS Code e2e tests launch the renamed macOS binary ([#428](https://github.com/pixel-agents-hq/pixel-agents/pull/428)).

### Contributors

Thank you to the contributors who made this release possible:

- [@pablodelucca](https://github.com/pablodelucca) — Embedded terminal, mobile web app, agent cards, Directories, and layout editor upgrades

## v1.4.1

### Features

- **Render headless agents as ghosts** ([#369](https://github.com/pixel-agents-hq/pixel-agents/pull/369)) — Agents adopted from outside the office (`claude -p`, Watch All Sessions) have no terminal to focus; a new **Display Headless as Ghosts** setting renders them translucent so they read differently from clickable agents. Off by default.

### Fixes

- **Never overwrite user settings** ([#378](https://github.com/pixel-agents-hq/pixel-agents/pull/378)) — The hook installer now aborts instead of rewriting `~/.claude/settings.json` when the file is unparseable or holds shapes it did not author, takes a one-time backup before the first write, verifies every write, and serializes consent answers. Closes [#377](https://github.com/pixel-agents-hq/pixel-agents/issues/377).
- **Sync agent state on standalone webview connect** ([#371](https://github.com/pixel-agents-hq/pixel-agents/pull/371)) — A standalone browser client that connects while agents are mid-work now receives active tool statuses, waiting status, and team metadata instead of showing every agent as idle until its next update.
- **Consistent palette and hue for every client** ([#370](https://github.com/pixel-agents-hq/pixel-agents/pull/370)) — Character palette and hue shift are now assigned server-side at agent creation, so every connecting webview (including read-only viewers) sees the same colors instead of each connection rolling its own.

### Maintenance

- Dependency updates: Vitest 4, ESLint 10, and GitHub Actions bumps, with the accompanying test and lint fixes.

### Contributors

Thank you to the contributors who made this release possible:

- [@giawa](https://github.com/giawa) — Standalone connect state sync and server-side palette assignment
- [@pablodelucca](https://github.com/pablodelucca) — Merge-safe hook installer and headless-agent ghosts
- [@florintimbuc](https://github.com/florintimbuc) — Merge-safe hook installer review and fixes

## v1.4.0

### Features

- **Claude Code Agent Teams visualization** ([#218](https://github.com/pixel-agents-hq/pixel-agents/pull/218)) — Renders team leads and teammates as coordinated characters in both tmux and inline modes, with role labels, lead badges, token fuel gauges, tool activity, persistence, and coordinated cleanup. Builds on the early implementations in [#79](https://github.com/pixel-agents-hq/pixel-agents/pull/79) and [#177](https://github.com/pixel-agents-hq/pixel-agents/pull/177). Closes [#65](https://github.com/pixel-agents-hq/pixel-agents/issues/65).
- **Claude Code sub-agents and teammates compatible up to v2.1.220** ([#351](https://github.com/pixel-agents-hq/pixel-agents/pull/351)) — Supports the newer Claude harness, where every `Agent` spawn runs in the background against an implicit per-session team. Named spawns become seated teammate characters with their own hook routing; unnamed spawns stay Subtask sub-agents whose transcripts are watched for live tool activity. Resumed leads re-latch to their newest team instead of stranding departed teammates or showing a phantom lead, and teammates take the free seat closest to their lead.
- **Context gauge on every agent** ([#351](https://github.com/pixel-agents-hq/pixel-agents/pull/351)) — Shows each agent's context occupancy above its character, sized to the context window of the model that session actually runs.
- **Animated pets** ([#315](https://github.com/pixel-agents-hq/pixel-agents/pull/315)) — Adds Claudio and Gitcat to the layout editor, autonomous walking and idle animations, petting interactions, saved placement, and custom pets loaded from external asset directories. Reimplements and supersedes [#219](https://github.com/pixel-agents-hq/pixel-agents/pull/219) on the new architecture.
- **Carpets and workspace Areas** ([#316](https://github.com/pixel-agents-hq/pixel-agents/pull/316)) — Adds three auto-tiling carpet styles with WYSIWYG color controls, paint/erase/eyedropper tools, undo, and persistence. Named Areas can be painted onto the office, mapped to workspace folders, and used to seat agents in the right part of the layout. Integrates the original carpet work from [#213](https://github.com/pixel-agents-hq/pixel-agents/pull/213) and Areas work from [#259](https://github.com/pixel-agents-hq/pixel-agents/pull/259).
- **Optional startup automation** ([#221](https://github.com/pixel-agents-hq/pixel-agents/pull/221)) — Adds `pixel-agents.autoShowPanel` and `pixel-agents.autoSpawnAgent` settings to open the panel and launch an agent automatically when VS Code starts. Both remain off by default.

### Standalone and Architecture

- **Layered architecture and provider-ready core** ([#236](https://github.com/pixel-agents-hq/pixel-agents/pull/236), [#238](https://github.com/pixel-agents-hq/pixel-agents/pull/238), [#273](https://github.com/pixel-agents-hq/pixel-agents/pull/273), merged through [#275](https://github.com/pixel-agents-hq/pixel-agents/pull/275)) — Separates shared contracts, the runtime server, the VS Code adapter, and the webview; centralizes lifecycle state in `AgentRuntime` and `AgentStateStore`; and removes runtime VS Code dependencies from the server. Provider, adapter, transport, and state interfaces now give future clients and agent providers stable integration points.
- **Standalone browser app and npm package** ([#273](https://github.com/pixel-agents-hq/pixel-agents/pull/273), [#344](https://github.com/pixel-agents-hq/pixel-agents/pull/344)) — `npx pixel-agents` starts a local Fastify server and browser office with WebSocket state delivery. The standalone UI now covers the core VS Code experience, including settings, diagnostics, asset reloads, layout import/export, Areas, carpets, and pets, while user state is centralized under `~/.pixel-agents/`. Closes [#120](https://github.com/pixel-agents-hq/pixel-agents/issues/120).
- **Multi-server hook discovery and fan-out** ([#344](https://github.com/pixel-agents-hq/pixel-agents/pull/344)) — Lets the VS Code extension and one or more standalone servers run together. Each server registers independently, Claude hook events fan out to every live server, and each surface adopts only the sessions in its configured scope.
- **Published WebSocket protocol contract** ([#273](https://github.com/pixel-agents-hq/pixel-agents/pull/273)) — Makes `core/asyncapi.yaml` the authoritative AsyncAPI contract and generates the shared TypeScript message bindings with CI drift detection.

### Fixes

- **Agent and teammate lifecycle reliability** ([#287](https://github.com/pixel-agents-hq/pixel-agents/pull/287), [#344](https://github.com/pixel-agents-hq/pixel-agents/pull/344)) — Fixes idle/done state regressions, aligns teammate lifecycle behavior, and preserves agent tracking when terminals move between VS Code locations.
- **Standalone server and development reliability** ([#316](https://github.com/pixel-agents-hq/pixel-agents/pull/316), [#344](https://github.com/pixel-agents-hq/pixel-agents/pull/344)) — Honors an explicit `--port`, restores browser-mock hot reload, adds connection-state feedback, and fixes Windows e2e startup behavior.
- **Areas editor and seating polish** ([#316](https://github.com/pixel-agents-hq/pixel-agents/pull/316)) — Correctly seats agents from custom-named workspace folders, fits four Area cards per row, and prevents the folder picker from being clipped.
- **File watching and session adoption** ([#352](https://github.com/pixel-agents-hq/pixel-agents/pull/352)) — Fixes duplicate agent adoption on Windows, where case-sensitive path comparison let the same session be adopted twice, and closes a `/clear` race in which the external scanner could adopt a replacement transcript before `SessionStart` reassigned it.
- **Hook install failures and restored-agent rendering** ([#351](https://github.com/pixel-agents-hq/pixel-agents/pull/351)) — Hook installation now reports failure instead of logging false success, and restored agents render regardless of the order in which `layoutLoaded` and `existingAgents` arrive. Closes [#333](https://github.com/pixel-agents-hq/pixel-agents/issues/333), [#334](https://github.com/pixel-agents-hq/pixel-agents/issues/334).
- **Standalone rendering of already-running agents** ([#349](https://github.com/pixel-agents-hq/pixel-agents/pull/349)) — Sends `layoutLoaded` after `existingAgents` on `webviewReady`, so a standalone client that connects once agents already exist renders their characters instead of an empty office.
- **Workspace transcript discovery with hooks enabled** ([#330](https://github.com/pixel-agents-hq/pixel-agents/pull/330)) — Keeps workspace JSONL discovery active when hooks are installed, so sessions are still found by file path rather than relying on hook delivery alone.
- **Cross-platform build and server tests** ([#289](https://github.com/pixel-agents-hq/pixel-agents/pull/289)) — Fixes `npm run build` failing outright on Windows for paths containing spaces, and server tests that bypassed temp-home isolation and wrote to the real `~/.pixel-agents`.

### Testing and Release Infrastructure

- **Comprehensive Playwright e2e suite** ([#287](https://github.com/pixel-agents-hq/pixel-agents/pull/287), [#344](https://github.com/pixel-agents-hq/pixel-agents/pull/344)) — Expands coverage across VS Code and standalone, hooks-on and hooks-off lifecycles, Agent Teams, pets, carpets, Areas, and multi-server behavior. Adds a deterministic mock Claude process, narrated run videos, an in-repo coverage inventory, and combined Allure reporting.
- **Verified npm publishing pipeline** ([#344](https://github.com/pixel-agents-hq/pixel-agents/pull/344)) — Adds package-contract tests, installed-tarball smoke verification, release tag/version checks, and provenance-ready npm publishing for the standalone package.
- **CI gating and platform coverage** ([#352](https://github.com/pixel-agents-hq/pixel-agents/pull/352)) — Adds a single aggregate `Required Checks` job so branch protection can gate on one stable check instead of every shard name, and unblocks the e2e suite on macOS Tahoe by making video recording optional.

### Maintenance

- **Move project links to `pixel-agents-hq`** ([#274](https://github.com/pixel-agents-hq/pixel-agents/pull/274)) — Updates repository, issue, and community links after the GitHub organization migration.
- Dependency and release-action updates ([#224](https://github.com/pixel-agents-hq/pixel-agents/pull/224), [#225](https://github.com/pixel-agents-hq/pixel-agents/pull/225), [#226](https://github.com/pixel-agents-hq/pixel-agents/pull/226), [#227](https://github.com/pixel-agents-hq/pixel-agents/pull/227))

### Contributors

Thank you to the contributors who made this release possible:

- [@itsManeka](https://github.com/itsManeka) — Animated pet system, bundled pet sprites, and pet interactions
- [@NNTin](https://github.com/NNTin) — Carpet system and foundational Playwright e2e infrastructure
- [@balgaly](https://github.com/balgaly) — Automatic panel display and agent startup settings
- [@elietwd](https://github.com/elietwd) — Cross-platform Windows build script and server test isolation
- [@snvtac](https://github.com/snvtac) — Workspace JSONL discovery with hooks enabled
- [@bezzborodth-tech](https://github.com/bezzborodth-tech) — Standalone rendering fix for agents that already exist on connect
- [@srasantos](https://github.com/srasantos) — Reported the hook-install and restored-agent rendering bugs
- [@ErickGross-19](https://github.com/ErickGross-19), [@ZenidX](https://github.com/ZenidX) — Early Agent Teams implementations that informed the shipped design
- [@pablodelucca](https://github.com/pablodelucca) — Claude 2.1.220 sub-agent and teammate support, context gauge, Workspace Areas, layout-editor polish, and watchable narrated e2e review
- [@modtanoii](https://github.com/modtanoii) — Architecture refactor collaboration, server and WebSocket design, and extensibility hardening
- [@florintimbuc](https://github.com/florintimbuc) — Architecture refactor, Agent Teams integration, standalone and npm package, multi-server support, file-watcher and CI hardening, e2e expansion, and release coordination

### Community acknowledgements

#### Architecture and standalone direction

Earlier standalone implementations from [@rollecode](https://github.com/rollecode) ([#156](https://github.com/pixel-agents-hq/pixel-agents/pull/156)), [@MikaelDDavidd](https://github.com/MikaelDDavidd) ([#166](https://github.com/pixel-agents-hq/pixel-agents/pull/166)), and [@TimpiaAI](https://github.com/TimpiaAI) ([#63](https://github.com/pixel-agents-hq/pixel-agents/pull/63)) demonstrated community demand and validated the browser SPA, WebSocket, and server discovery direction. These PRs were closed as superseded, with many thanks to their authors.

#### Independent fixes

Several community PRs independently diagnosed or fixed issues resolved in v1.4.0. Some overlapped with the final implementation, but each helped validate and strengthen the release:

- **Standalone hook path:** [@sakuramoon44](https://github.com/sakuramoon44) ([#283](https://github.com/pixel-agents-hq/pixel-agents/pull/283)), [@joemanat1997](https://github.com/joemanat1997) ([#292](https://github.com/pixel-agents-hq/pixel-agents/pull/292)), [@Ralphive](https://github.com/Ralphive) ([#295](https://github.com/pixel-agents-hq/pixel-agents/pull/295)), [@AxlLinares](https://github.com/AxlLinares) ([#306](https://github.com/pixel-agents-hq/pixel-agents/pull/306)), [@mariopablobarron](https://github.com/mariopablobarron) ([#325](https://github.com/pixel-agents-hq/pixel-agents/pull/325)), and [@NatVich](https://github.com/NatVich) ([#326](https://github.com/pixel-agents-hq/pixel-agents/pull/326)).
- **Windows message generation:** [@sakuramoon44](https://github.com/sakuramoon44) ([#280](https://github.com/pixel-agents-hq/pixel-agents/pull/280)) and [@joemanat1997](https://github.com/joemanat1997) ([#291](https://github.com/pixel-agents-hq/pixel-agents/pull/291)).
- **Standalone agent rendering:** shipped through [@bezzborodth-tech](https://github.com/bezzborodth-tech) ([#349](https://github.com/pixel-agents-hq/pixel-agents/pull/349)), with independent fixes and tests from [@miguemlima-creator](https://github.com/miguemlima-creator) ([#324](https://github.com/pixel-agents-hq/pixel-agents/pull/324)), [@Ralphive](https://github.com/Ralphive) ([#297](https://github.com/pixel-agents-hq/pixel-agents/pull/297)), [@meganechan](https://github.com/meganechan) ([#299](https://github.com/pixel-agents-hq/pixel-agents/pull/299)), [@SichAlexander](https://github.com/SichAlexander) ([#336](https://github.com/pixel-agents-hq/pixel-agents/pull/336)), and [@yshyuk](https://github.com/yshyuk) ([#338](https://github.com/pixel-agents-hq/pixel-agents/pull/338)).
- **Windows test isolation:** [@sakuramoon44](https://github.com/sakuramoon44) ([#281](https://github.com/pixel-agents-hq/pixel-agents/pull/281)), consolidated by [@elietwd](https://github.com/elietwd) ([#289](https://github.com/pixel-agents-hq/pixel-agents/pull/289)).
- **Dependency audit cleanup:** [@Suoriks](https://github.com/Suoriks) ([#345](https://github.com/pixel-agents-hq/pixel-agents/pull/345)).

Special thanks to [@sakuramoon44](https://github.com/sakuramoon44), [@Ralphive](https://github.com/Ralphive), and [@joemanat1997](https://github.com/joemanat1997) for contributing multiple fixes during this release cycle.

## v1.3.0

### Features

- **Hooks-first session management with dual-mode architecture** ([#214](https://github.com/pablodelucca/pixel-agents/pull/214)) — Splits agent detection into a preferred hooks path and a heuristic fallback. When Claude Code hooks are available, session lifecycle, tool activity, permissions, and sub-agent events are reported instantly via a local HTTP server; when unavailable, the extension transparently falls back to JSONL polling. Builds on [#187](https://github.com/pablodelucca/pixel-agents/pull/187). Closes [#188](https://github.com/pablodelucca/pixel-agents/issues/188), [#201](https://github.com/pablodelucca/pixel-agents/issues/201).
- **Claude Code hooks for instant agent status detection** ([#187](https://github.com/pablodelucca/pixel-agents/pull/187)) — Adds a standalone HTTP server and hook installer that routes 11 Claude Code hook events (SessionStart, Stop, PreToolUse, PostToolUse, SubagentStart, Notification, and others) to the webview for sub-second status updates, replacing filesystem polling when hooks are installed.
- **External session support and Agent tool recognition** ([#115](https://github.com/pablodelucca/pixel-agents/pull/115)) — Detects Claude sessions launched outside the extension (external CLIs, other editors) and recognizes the renamed `Agent` sub-agent tool so sub-agent characters spawn correctly with current Claude Code versions. Closes [#184](https://github.com/pablodelucca/pixel-agents/issues/184), [#74](https://github.com/pablodelucca/pixel-agents/issues/74), [#9](https://github.com/pablodelucca/pixel-agents/issues/9), [#8](https://github.com/pablodelucca/pixel-agents/issues/8), [#1](https://github.com/pablodelucca/pixel-agents/issues/1). Supersedes [#2](https://github.com/pablodelucca/pixel-agents/pull/2), [#77](https://github.com/pablodelucca/pixel-agents/pull/77), [#101](https://github.com/pablodelucca/pixel-agents/pull/101), [#141](https://github.com/pablodelucca/pixel-agents/pull/141).
- **Multi-root workspace agent detection** ([#102](https://github.com/pablodelucca/pixel-agents/pull/102)) — Scans all workspace folders in multi-root workspaces instead of only the first, so agents launched in any folder are discovered and adopted. Closes [#30](https://github.com/pablodelucca/pixel-agents/issues/30). Supersedes [#103](https://github.com/pablodelucca/pixel-agents/pull/103), [#157](https://github.com/pablodelucca/pixel-agents/pull/157).
- **Load custom characters from external asset directories** ([#208](https://github.com/pablodelucca/pixel-agents/pull/208)) — Users can drop custom character PNGs into an external asset directory and have them loaded alongside the built-in palettes, enabling community-contributed character skins without forking the extension.
- **Tailwind CSS v4 migration for the webview UI** ([#204](https://github.com/pablodelucca/pixel-agents/pull/204)) — Modernizes the webview styling stack to Tailwind v4, simplifying theming, reducing custom CSS, and improving build times.

### Fixes

- **Prevent duplicate restores, fix tool status reconnect, and improve agent tool detection** ([#197](https://github.com/pablodelucca/pixel-agents/pull/197)) — Stops agents being restored twice on reload, restores tool status correctly after a reconnect, and tightens the tool-name detection heuristics so active tool animations match the running tool.

### Maintenance

- **Add `shared/` to lint, format, and lint-staged** ([#212](https://github.com/pablodelucca/pixel-agents/pull/212)) — Brings the shared package under the project's lint, format, and pre-commit pipeline so cross-package code stays consistent.
- Dependabot dev-dependency group bumps ([#209](https://github.com/pablodelucca/pixel-agents/pull/209), [#210](https://github.com/pablodelucca/pixel-agents/pull/210))

### Contributors

Thank you to the contributors who made this release possible:

- [@drewf](https://github.com/drewf) — External session support and Agent tool recognition
- [@Commandershadow9](https://github.com/Commandershadow9) — Multi-root workspace agent detection
- [@mitre88](https://github.com/mitre88), [@noam971](https://github.com/noam971) — Duplicate restore, tool status reconnect, and tool detection fixes
- [@itsManeka](https://github.com/itsManeka) — Custom characters from external asset directories
- [@pablodelucca](https://github.com/pablodelucca), [@NNTin](https://github.com/NNTin) — Claude Code hooks integration, Tailwind v4 migration
- [@florintimbuc](https://github.com/florintimbuc) — Hooks-first dual-mode architecture, review coordination

## v1.2.0

### Features

- **External asset packs** ([#169](https://github.com/pablodelucca/pixel-agents/pull/169)) — Load furniture assets from user-defined directories outside the extension, enabling third-party asset packs alongside built-in furniture. Add/remove directories via Settings modal with live palette refresh.
- **Bypass permissions mode** ([#170](https://github.com/pablodelucca/pixel-agents/pull/170)) — Right-click the "+ Agent" button to launch with `--dangerously-skip-permissions`, skipping all tool-call approval prompts.
- **Improved seating, sub-agent spawning, and background agents** ([#180](https://github.com/pablodelucca/pixel-agents/pull/180)) — Agents prefer seats facing electronics (PCs, monitors). Sub-agents spawn on the closest walkable tile to their parent instead of claiming seats. Background agents stay alive until their queue-operation completes.
- **Agent connection diagnostics and JSONL parser resilience** ([#183](https://github.com/pablodelucca/pixel-agents/pull/183)) — Debug View shows agent connection state with diagnostic info. JSONL parser handles malformed/partial records gracefully. Simplified file watching to single poll for reliability.
- **Browser preview mode** ([#143](https://github.com/pablodelucca/pixel-agents/pull/143)) — Preview the Pixel Agents webview in a browser for development and review.
- **Always show overlay setting** — Option to keep agent overlay labels visible at all times, with reduced opacity for non-focused agents.

### Fixes

- **Agents not appearing on Linux Mint and macOS without a folder open** ([#70](https://github.com/pablodelucca/pixel-agents/pull/70)) — Falls back to `os.homedir()` when no workspace folder is open, matching Claude Code's own behavior.

### Testing

- **Playwright e2e tests** ([#161](https://github.com/pablodelucca/pixel-agents/pull/161)) — End-to-end test infrastructure using Playwright's Electron API with a mock Claude CLI, validating agent spawn flow in a real VS Code instance.

### Maintenance

- Add feature request template and update community docs ([#164](https://github.com/pablodelucca/pixel-agents/pull/164))
- Bump Vite 8.0, ESLint 10, and various dependency updates
- CI improvements: skip PR title check for Dependabot, restrict badge updates to main repo ([#181](https://github.com/pablodelucca/pixel-agents/pull/181))

### Contributors

Thank you to the contributors who made this release possible:

- [@marctebo](https://github.com/marctebo) — External asset packs support
- [@dankadr](https://github.com/dankadr) — Bypass permissions mode
- [@d4rkd0s](https://github.com/d4rkd0s) — Linux/macOS fix for no-folder workspaces
- [@daniel-dallimore](https://github.com/daniel-dallimore) — Always show overlay setting
- [@NNTin](https://github.com/NNTin) — Playwright e2e tests, browser preview mode
- [@florintimbuc](https://github.com/florintimbuc) — Agent diagnostics, JSONL resilience, CI improvements, code review

## v1.1.1

### Fixes

- **Fix Open VSX publishing** — Created namespace on Open VSX and added `skipDuplicate` to publish workflow for idempotent releases.

## v1.1.0

### Features

- **Migrate to open-source assets with modular manifest-based loading** ([#117](https://github.com/pablodelucca/pixel-agents/pull/117)) — Replaces bundled proprietary tileset with open-source assets loaded via a manifest system, enabling community contributions and modding.
- **Recognize 'Agent' tool name for sub-agent visualization** ([#76](https://github.com/pablodelucca/pixel-agents/pull/76)) — Claude Code renamed the sub-agent tool from 'Task' to 'Agent'; sub-agent characters now spawn correctly with current Claude Code versions.
- **Dual-publish workflow for VS Code Marketplace + Open VSX** ([#44](https://github.com/pablodelucca/pixel-agents/pull/44)) — Automates extension releases to both VS Code Marketplace and Open VSX via GitHub Actions.

### Maintenance

- **Add linting, formatting, and repo infrastructure** ([#82](https://github.com/pablodelucca/pixel-agents/pull/82)) — ESLint, Prettier, Husky pre-commit hooks, and lint-staged for consistent code quality.
- **Add CI workflow, Dependabot, and ESLint contributor rules** ([#116](https://github.com/pablodelucca/pixel-agents/pull/116)) — Continuous integration, automated dependency updates, and shared linting configuration.
- **Lower VS Code engine requirement to ^1.105.0** — Broadens compatibility with older VS Code versions and forks (Cursor, Antigravity, Windsurf, VSCodium, Kiro, TRAE, Positron, etc.).

### Contributors

Thank you to the contributors who made this release possible:

- [@drewf](https://github.com/drewf) — Agent tool recognition for sub-agent visualization
- [@Matthew-Smith](https://github.com/Matthew-Smith) — Open VSX publishing workflow
- [@florintimbuc](https://github.com/florintimbuc) — Project coordination, CI workflow, Dependabot, linting infrastructure, publish workflow hardening, code review

## v1.0.2

### Bug Fixes

- **macOS path sanitization and file watching reliability** ([#45](https://github.com/pablodelucca/pixel-agents/pull/45)) — Comprehensive path sanitization for workspace paths with underscores, Unicode/CJK chars, dots, spaces, and special characters. Added `fs.watchFile()` as reliable secondary watcher on macOS. Fixes [#32](https://github.com/pablodelucca/pixel-agents/issues/32), [#39](https://github.com/pablodelucca/pixel-agents/issues/39), [#40](https://github.com/pablodelucca/pixel-agents/issues/40).

### Features

- **Workspace folder picker for multi-root workspaces** ([#12](https://github.com/pablodelucca/pixel-agents/pull/12)) — Clicking "+ Agent" in a multi-root workspace now shows a picker to choose which folder to open Claude Code in.

### Maintenance

- **Lower VS Code engine requirement to ^1.107.0** ([#13](https://github.com/pablodelucca/pixel-agents/pull/13)) — Broadens compatibility with older VS Code versions and forks (Cursor, etc.) without code changes.

### Contributors

Thank you to the contributors who made this release possible:

- [@johnnnzhub](https://github.com/johnnnzhub) — macOS path sanitization and file watching fixes
- [@pghoya2956](https://github.com/pghoya2956) — multi-root workspace folder picker, VS Code engine compatibility

## v1.0.1

Initial public release.
