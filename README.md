# oh-my-pi for VS Code

A native VS Code client for the [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi) coding-agent runtime.

The extension is a frontend only. OMP remains the runtime and the source of truth for providers, credentials, models, sessions, agents and subagents, tools (including LSP, DAP and MCP), approval policy and session persistence. The extension starts `omp --mode rpc-ui` and talks to it over OMP's documented JSONL RPC protocol (`docs/rpc.md` in the OMP repository). It never parses terminal output.

## Requirements

- VS Code 1.95 or newer.
- An installed and configured OMP (`omp`, tested with 18.5.1). Configure providers, logins and models with OMP itself, for example by running `omp` once in a terminal. The extension has no provider settings and stores no credentials.

## Installation

```sh
code --install-extension oh-my-pi.vsix
```

Or open the Extensions view, choose `...` > `Install from VSIX...` and select the file.

To build the VSIX from source:

```sh
npm install
npm run package          # writes dist-vsix/oh-my-pi.vsix
```

## Finding the OMP executable

When `omp.executablePath` is empty, the extension looks for `omp` on `PATH` (on Windows, `omp.exe` and `omp.cmd` as well), then in `~/.local/bin/omp` and `~/.bun/bin/omp`. If it can't find one, the views show an "OMP not found" banner with a link to the setting.

## Layout

OMP lives in its own panel in the **Secondary Side Bar** on the right, like Claude Code, GitHub Copilot Chat and Codex, so the Explorer and your editors stay where they are. Open it with the OMP icon on the right, `OMP: Open in Side Bar`, or the `OMP: …` status bar item; toggle the whole right panel with `View > Appearance > Secondary Side Bar` (Ctrl+Alt+B / Cmd+Option+B). The panel has three sections:

- **Chat**: the conversation and the input box. The section title bar has New Session, Session History and Abort (while busy); Rename, Open Session File, Restart, Show Log and Settings are in its `...` menu.
- **Agents** (collapsed by default): one row per agent, labelled with the subagent's OMP name (`ReviewAuth  scout · running · read src/auth.ts`), subagents nested under their parent, running agents first. The section title shows how many are running.
- **Changes** (collapsed by default): one row per file changed by OMP, with status, folder and line counts (`M · src/auth · +3 −1`). Click a file for VS Code's native diff in the editor area. Starting a new session clears the list and closes its diff editors.

On VS Code older than 1.106, which has no extension containers in the Secondary Side Bar, the same panel appears in the Activity Bar on the left; drag it to the right with `Move To > Secondary Side Bar` if you prefer.

## Features

- **Chat**: a thin header shows state, session name (click to rename), elapsed time while working, and context and cost. User and assistant messages stream in as they arrive. Thinking is collapsed (`thinking · N lines`). Tool calls are one-line rows with workspace-relative paths (`▸ grep "X" in src ✓ 8 hits · 5ms`) that expand to arguments, output and diff, with a Diff button; failed tools show their first error line even when collapsed. The transcript follows new output only while scrolled to the bottom (otherwise a "jump to latest" button appears).
- **Input box**: the toolbar inside the input box has the **model** (`Claude Haiku 4.5 ▾`, opens the searchable model list), the **reasoning effort** (`auto · low ▾`, see below), **fast** mode, the **editor context** checkbox, and Send. Enter sends and Shift+Enter starts a new line. While the agent is working, Send becomes Steer, Follow-up queues a message for after the turn, and Stop aborts the turn; on a narrow panel these buttons wrap onto their own row. Queued-message chips, a todos strip (`todos 2/5 · current: …`) and pending approvals and questions sit above the input box. `OMP: Send Prompt` reveals the panel and focuses the input. With editor context on, the prompt is prefixed with the workspace folder, the active file and cursor position, the selection (up to 8 KB), the other open editors and the active file's diagnostics.
- **Reasoning effort**: the selector lists `off`, OMP's `auto` (for every reasoning model) and the efforts OMP reports for the current model. With `auto`, OMP chooses the effort for each turn; the selector keeps showing `auto`, as `auto · low` once OMP has resolved the turn, and its tooltip shows the effective level. Picking an explicit level replaces `auto` until you pick `auto` again. The selector shows OMP's own setting on startup and after switching sessions (read from the session journal), so an `auto` default in OMP's configuration appears as `auto`. The setting applies to the current session, as in OMP; the default stays in OMP's configuration.
- **Attachments**: everything attached to the next message is shown as a chip above the input with an `×` to remove it.
  - **Files and folders**: the `+` button in the input toolbar opens a picker over the open editors and workspace files (select several with Space); `Add File to OMP Chat` is also in the editor, editor tab and Explorer context menus (multi-select works). Files are sent as OMP `@path` mentions, so OMP reads them itself with its own size limits and formatting.
  - **Long pasted text** (more than 10 lines or 1000 characters) becomes a `Pasted text N · L lines` chip instead of landing in the input; it is sent as a `<pasted-text>` block and shown collapsed in the conversation. Shorter pastes go into the input as usual.
  - **Images** pasted into the input or dropped onto it (up to 10 MB each) become thumbnail chips and are sent to OMP as image content, so vision-capable models see them.
- **Prompt lifecycle**: the extension follows OMP's lifecycle. A prompt is accepted, the agent works, the agent yields (`prompt_result`) and the session settles (`session_settled`). An acknowledgement on its own is never treated as completion, and the UI stays "busy" until the session settles.
- **Model picker** (the model button in the input box, or `OMP: Select Model`): lists the models OMP reports through `get_available_models`, grouped by provider and searchable. Each entry shows the context window, max output, thinking efforts, input modalities and pricing. Nothing is hard-coded. Fast mode (the `fast` toggle or `OMP: Toggle Fast Mode`) shows OMP's error when the current model doesn't support it.
- **Sessions**: New Session and Session History (resume any session stored next to the current OMP session) in the Chat title bar; rename, open the raw session file, and abort. The last session of each workspace is resumed when the extension starts.
- **Agents view**: shows the main agent and OMP subagents. Click an agent to open its transcript; the tooltip lists status, model, activity, tool count, tokens, cost and duration. It updates from OMP's `subagent_lifecycle` and `subagent_progress` events, with no polling. Actions: open transcript, inspect, steer, and cancel (cancel kills the subagent through OMP's `cancel_subagent`).
- **Tool rendering**: specialized renderers for read, write, edit and ast_edit (path links and colored diff), grep, glob and ast_grep, bash and eval (live output, exit code), task (subagents), lsp, debug, MCP tools and jobs. Any unknown tool falls back to a generic renderer.
- **Changes view**: lists files changed by OMP tools. Click a file to open VS Code's native diff of the content before the change against the current file, or open the file itself.
- **Approvals and questions**: OMP `confirm`, `select`, `input`, `editor` and `ask` requests appear inline in the conversation. When the conversation is hidden, a notification with a native quick-pick or input-box fallback also appears. Nothing is ever auto-approved. Inputs marked secret are masked and never logged. OMP's approval policy (`tools.approvalMode`) is configured in OMP.
- **Process management**: the extension negotiates protocol v2, including reassembly of chunked frames, and handles stdout and stderr separately. If OMP exits unexpectedly, it restarts it with bounded backoff (3 attempts within 60 s) and re-binds the current session. On shutdown it closes stdin, then sends SIGTERM and then SIGKILL to the process group (`taskkill /T` on Windows), so no OMP processes are left behind.

## Commands

`OMP: Open in Side Bar`, `OMP: Add File to OMP Chat`, `OMP: New Session`, `OMP: Session History`, `OMP: Rename Session`, `OMP: Select Model`, `OMP: Select Thinking Level`, `OMP: Toggle Fast Mode`, `OMP: Send Prompt`, `OMP: Abort`, `OMP: Restart`, `OMP: Open Session`, `OMP: Open Settings`, `OMP: Show Agents`, `OMP: Show Log`. The extension adds no keybindings. VS Code also generates `Focus on Chat View`-style commands for each view; `Open in Side Bar` is the one to use.

## Configuration

These settings cover the frontend only:

| Setting | Default | Purpose |
| --- | --- | --- |
| `omp.executablePath` | `""` | Path to `omp`; empty means search as described above. |
| `omp.extraArgs` | `[]` | Extra CLI arguments for `omp --mode rpc-ui`, for example `["--profile", "work"]` or `["--approval-mode", "always-ask"]`. |
| `omp.startup` | `resumeLast` | `resumeLast`, `newSession` or `manual`. |
| `omp.autoRestart` | `true` | Restart OMP after an unexpected exit. |
| `omp.logLevel` | `info` | Verbosity of the `oh-my-pi` output channel. |
| `omp.traceRpc` | `false` | Log abbreviated RPC frames, with secret responses redacted. |
| `omp.includeEditorContext` | `true` | Default state of the composer's editor-context toggle. |

Providers, models, MCP servers, agents, approval policy and session storage are configured in OMP (`~/.omp/agent/config.yml`, `omp` commands), not here.

## Development

```sh
npm install
npm run typecheck
npm run test:unit         # mocha, plain Node (protocol, process, session, agents, UI helpers)
npm run test:integration  # VS Code extension host against test/fixtures/fake-omp.mjs
npm run test:real         # VS Code extension host against a real OMP (sends real model requests)
```

On a machine without a display, wrap the integration runs in `xvfb-run -a`. Set `OMP_IT_VSCODE=<path to code binary>` to reuse an already downloaded VS Code. Set `OMP_IT_EXECUTABLE=<path to omp>` for `test:real`.
