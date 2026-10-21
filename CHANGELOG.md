# Changelog

## 0.6.0

- OMP's agent can operate VS Code through `vscode_*` host tools, registered on every OMP start: workspace and open editors; open, read (including unsaved edits), edit (in the buffer, with undo), save and close documents; the selection; Problems diagnostics; listing and running tasks with their exit code and errors; starting, stepping and inspecting the debugger and managing breakpoints; finding and running VS Code commands. Paths must lie inside OMP's working directory or a workspace folder. OMP's `host_tool_cancel` cancels a call, calls in flight are cancelled when OMP stops, and results are capped at 40,000 characters.
- The chat header lists the status texts OMP extensions publish. The tier router's status is shortened (`router auto · standard`, `router paused · …`), a **Resume auto** button sends `/tier-auto` while the router is paused, and the composer model reads `<model> · tier auto` while it routes. The status bar items show the short tier text too.
- `OMP: Show Usage` and a header button open a popup with each provider's rate limits from `/usage` (bar, percent, reset time, Refresh), named by quota bucket from `omp usage --json`. The report stays out of the conversation.
- Tool calls: a header row over an always visible, dim `IN`/`OUT` preview, with `show more`, `collapse` and `Copy all`; a finished `read` shows only its header until opened; background calls show a clock. Shell rows show the description in the header and drop the `Wall time` / exit-code trailer.
- Syntax highlighting in tool output, arguments and Markdown code blocks; a line-number gutter for `read` listings; marked search matches; stripped code fences and indented one-line JSON.
- Inline diffs with the changed words marked and a 20-line preview; output that looks like a diff renders as one; multi-file edits get a link and `Diff <file>` per file. Markdown rendering of tool results only for Markdown reads and Markdown-looking MCP or generic results.
- Replies: italics, clickable web and mail links (bare `https://` URLs too; other schemes are refused) and a Copy button on code blocks. Copy buttons on your messages and finished replies; slash commands render in monospace beside a slash icon; a rule separates an answer from the tool calls before it; the turn summary's tooltip lists input, cache read, cache write and output tokens.
- Model picker: favorites (star button), remembered Favorites and Recent filters, your last 20 picks, a copy-id button; models grouped by provider (current first) and family, newest revision first, in natural order, with context and price on each row.
- Abort also cancels every running or pending subagent.
- Composer: Esc stops the turn and Alt+Enter queues a follow-up while the agent works.
- The todos strip can be closed; it stays hidden, also after a reload, until the todos change.
- The empty chat follows the connection (`Starting OMP…`, `OMP stopped: …`) and offers **Start OMP** while OMP is not running.
- Ask options show their preview as a tooltip.
- Only PNG, JPEG, GIF and WebP images are attached; Send waits for pasted images to finish loading, and text pasted together with an image is kept. File and pasted-text attachments survive a webview reload, and you are told which images were lost.
- Escape cancels a question, a half-typed answer survives a chat refresh, and a question that cannot be shown is cancelled at once instead of making OMP wait for its timeout.
- The `+` file picker respects `files.exclude` and `search.exclude` and stops searching when closed. The `Add File to OMP Chat` menus also appear in remote windows; the Explorer entry shows only for local and remote files and folders.
- OMP no longer starts on its own in a window with no folder open; it starts on first use. Virtual workspaces are declared unsupported.
- The editor context leaves out the active editor when it is outside the workspace (user settings, untitled buffers, files elsewhere) and caps each diagnostic message at 300 characters.
- When OMP exits, running subagents are marked failed, a streaming reply stops streaming and running tools show `Interrupted: …`. Reloaded compacted sessions show where the conversation was compacted.
- Startup fails instead of silently staying on protocol v1 when OMP never answers the protocol negotiation. Protocol v2 chunks are validated as OMP does (chunk count, 256 KiB payload, canonical base64), and inconsistent frame limits in OMP's `ready` frame are ignored with a warning.
- Fixed: a message with a long run of `@` mentions froze the chat.
- Fixed: editor context containing `</editor-context>`, or pasted text containing `</pasted-text>` in any letter case, ended its block early.
- Fixed: after OMP failed, the next prompt or command bound a different session instead of resuming the current one; with `omp.startup: manual` the first prompt now resumes the last session. Prompts and commands issued during an automatic or settings-change restart wait for OMP instead of failing.
- Fixed: closing the window while OMP restarted after a settings change could leave an OMP process running.
- Fixed: a Stop pressed before OMP accepted a prompt showed the next prompt as "aborting".
- Fixed: finished subagents loaded after a reload or session switch showed a growing duration; a retry error stayed after the retry succeeded; a late progress update marked a finished subagent as running again; a running subagent's transcript showed its current tool as failed.
- Fixed: a tool that wrote a file without reporting its previous content could be missing from Changes; a file created by a tool that reports empty previous content showed as modified and its tool diff said `No diff recorded`; switching sessions could bring the previous session's changes back.
- Fixed: agents whose parents form a loop disappeared from the Agents view; the view also refreshes faster with many subagents.
- Fixed: after the extension host restarted, reopening an agent summary, transcript or tool diff could show the previous session's content. Generated documents also have a total memory budget, and transcripts with very large tool output open again.
- Fixed: durations just under a minute showed as `60.0s` and durations over an hour had no hours unit; costs just under $1 show as `$1.00`; restored tool calls no longer show bogus durations; todo counts leave out abandoned tasks; the effort selector no longer shows a stale level; models whose pricing lacks cache rates no longer lose their price.
- Fixed: file links for `read` calls with `:conflicts`, `:img` or video time selectors; Windows paths shown relative to the workspace whatever the drive-letter case or separator; full MCP tool names when the server name contains underscores; no Diff button on failed edits; removed `--` and added `++` lines keep their diff colors.
- Fixed: login URLs and chat links opened with re-encoded query values; they now open exactly as written.
- Fixed: OMP's stderr broke characters split across output chunks and logged very long lines unbounded; output from a leftover process that still holds OMP's pipe was delivered after OMP exited; on Windows `omp` was not found in quoted `PATH` entries or ones containing `;`.
- Fixed: short panels keep the input box visible; high-contrast themes show hover outlines; light themes get readable warning text; long text in questions wraps.
- `omp.executablePath` and `omp.extraArgs` now have machine scope: a repository's `.vscode/settings.json` can no longer choose which executable runs or with which arguments (for example `--approval-mode`). Set them in your user settings, or the remote machine's settings. Workspace-level values are ignored.
- The message meta line (model of a reply) is shown in the muted color at full opacity instead of dimmed, for readable contrast.

## 0.5.0

- OMP's `auto` reasoning effort is selectable in the effort selector and `OMP: Select Thinking Level` for every reasoning model, and is honored: OMP picks the effort for each turn, and the selector keeps showing `auto` (as `auto · low` once OMP resolved the turn) instead of jumping to the resolved level.
- The effort selector reflects OMP's own selector on startup, resume and new sessions, read from the session journal, so an `auto` default from OMP's configuration shows as `auto`.
- Fixed: an edit could be missing from Changes (and its diff empty) when OMP wrote the file before the extension processed the tool's start event. The diff baseline now comes from the edit's own reported original content in that case.
- Fixed (Windows): an `omp.cmd` launcher (as installed by npm) failed to start when its path or `omp.extraArgs` contained spaces or cmd.exe metacharacters such as `&`, `(` or `%`. The launcher command line is now quoted and escaped.
- Fixed (Windows): change diffs showed an empty baseline when OMP reported a path whose drive-letter case differed from VS Code's (`C:\` vs `c:\`). Changes are now matched case-insensitively on Windows.
- Slash commands: typing `/` in the input lists OMP's commands (builtins, skills, extension, custom and file commands) with aliases, hints, descriptions and subcommands, as reported by OMP's `get_available_commands` and `available_commands_update`. Up/Down, Enter/Tab to insert, Escape to close.
- Fixed: slash commands sent with editor context on (the default) were passed to the model instead of being run, because the editor context came first. Commands are now sent without it.
- Your message appears in the conversation as soon as you press Enter (dimmed until OMP records it), instead of after OMP's echo; sent commands stay visible above their output.
- A status row at the end of the conversation shows that the agent is working (state, elapsed time, output tokens), and each finished turn gets a summary line with its duration, tokens and cost. The per-reply line shows the model; tokens and cost moved to its tooltip.
- File names in replies and file-tool rows open the file in the editor; bare names are searched in the workspace.
- The chat lists the most recent sessions while the conversation is empty, with a link to the full session history.
- The extension runs in remote extension hosts on VS Code 1.95–1.100 (Node 20) again.
- Workspace trust: in Restricted Mode OMP is not started and `omp.executablePath` / `omp.extraArgs` from workspace settings are ignored. `omp.executablePath` must be absolute (or start with `~`); on Windows it must be a `.exe`, `.com`, `.cmd` or `.bat` file, and an extensionless `omp` shim on `PATH` is no longer picked. Invalid `omp.extraArgs` values are rejected with an error.
- Change tracking and file links stay inside the workspace: tool paths outside OMP's working directory and the workspace folders are not read, and opening such a file or diff asks first. Editor context no longer lists open editors outside the workspace folders.
- Failures are visible: an unexpected OMP exit, each restart and running out of restarts show a chat notice and a notification with Restart and Show Log, including OMP's last stderr lines and pid. Failures to open files or diffs, deliver an answer, steer an agent or search workspace files are shown instead of only logged. A UI request that cannot be shown is cancelled so OMP stops waiting.
- Fixed: restarting while OMP was still starting left it stopped and showed a spurious "OMP failed to start"; restarts now run one at a time. A spawn error no longer leaves OMP permanently "already running", and a failed shutdown no longer leaves the state at "ready".
- Fixed: after Stop on a yielded session the next prompt was shown as "aborting" for its whole turn.
- Fixed: a prompt that could not be sent cleared the input box; the text and attachments now stay with the error shown.
- Fixed: the editor-context toggle could start off after a reload although `omp.includeEditorContext` is on; it follows the setting until you change it yourself.
- Fixed: the composer buttons no longer overflow narrow panels; they wrap onto their own row again.
- Fixed: one unreadable session file no longer breaks the whole session list; non-ASCII titles are no longer dropped.
- Fixed: user messages without an id appeared twice; stored tool calls without a result looked failed (they now show "no result").
- Fixed: file links for `read` selectors such as `:5-16,960-973`, `:-60` or `:raw`, failed searches counting error lines as hits, and expanded sections carrying over to another session.
- Accessibility: screen readers hear each finished reply, notice and question once instead of re-reading streaming text and the elapsed timer; notices expand with Enter or Space; questions take focus and return it after answering; Enter submits a question's "Other…" answer.
- Images: at most 8 per message and 20 MB in total; dropping non-image files shows a warning.
- The Session History picker uses the same titles and compact ages as the Recent list; tool durations of a minute or more show as `2m 5s`.
- `omp.traceRpc` takes effect immediately; `input` answers are redacted from the trace. Input boxes are no longer masked, because OMP never marks an input as secret.
- Warning and error log lines include the cause with OMP's error code and command.
- Removed the hidden `omp.switchSession` command.
- Development: Node 22.12 or newer; TypeScript 7, esbuild 0.28, mocha 12, vsce 4; separate type checks for host, webview, shared code and tests; `npm run test:integration:min` runs against the oldest supported VS Code.

## 0.4.0

- Attach files to a message: the `+` button in the input toolbar (open editors and workspace files, multi-select) or `Add File to OMP Chat` in the editor, editor tab and Explorer context menus. Files are sent as OMP `@path` mentions.
- Long pasted text (more than 10 lines or 1000 characters) becomes a removable `Pasted text N · L lines` chip and is sent as a `<pasted-text>` block, shown collapsed in the conversation.
- Pasted or dropped images become thumbnail chips and are sent to OMP as image content.
- Every attachment has an `×` to remove it before sending; messages with only attachments can be sent.
- `OMP: Open Chat` is now `OMP: Open in Side Bar`.

## 0.3.0

OMP moved into a right-hand panel, like Claude Code, Copilot Chat and Codex.

- The chat is a webview view in the Secondary Side Bar (Activity Bar fallback on VS Code < 1.106) instead of an editor tab. Agents and Changes are collapsible sections of the same panel. The editor-tab conversation, its editor-group lock and the separate cockpit tree are removed.
- Model, reasoning effort, fast mode and the editor-context toggle are in the input box toolbar, next to Send. While the agent works, Follow-up, Stop and Steer wrap onto their own row on narrow panels.
- The Chat title bar has New Session, Session History and Abort; Rename, Open Session File, Restart, Show Log and Settings are in its `...` menu.
- The header is a thin line with state, session, elapsed time, context and cost.

## 0.2.0

New layout: the conversation moved to the editor area and the sidebar became native trees.

- Conversation opens as an editor tab (`OMP: Open Conversation`) in its own locked editor group beside the code, so files and diffs opened from the Explorer, Quick Open or OMP land in another group. It survives window reloads and supports Find. It opens automatically, without focus, the first time the OMP sidebar is shown in a window. The tab's title bar has New Session, Resume Session and Abort.
- Conversation layout: one-row header (state, session name with click-to-rename, model, thinking, fast mode, context and cost, collapsing on narrow tabs); a single scrolling transcript, centered, that follows output only at the bottom and otherwise offers "jump to latest"; one-line collapsible tool rows with workspace-relative paths, a Diff button and the first error line on failures; collapsed thinking; one-line notices; queue chips, a todos strip and approvals docked above an auto-growing composer that shows elapsed time.
- `OMP: Send Prompt` now opens the conversation and focuses its composer instead of showing an input box.
- The sidebar session webview is replaced by the **OMP** cockpit tree: session state with recent sessions, model, thinking level, fast mode, context usage, cost and queued messages, each a click away from its picker or toggle.
- Agents: rows labelled with the subagent's OMP name and `type · status · activity`, running agents first, click opens the transcript, model moved to the tooltip, running count in the view title.
- Changes: `M · folder · +a −d` rows with file icons, file count in the view title, and a hint when empty. A new session closes the previous session's change diffs instead of leaving them showing an empty baseline.
- New commands: `OMP: Open Conversation`, `OMP: Toggle Fast Mode`, and `omp.switchSession` (used by the cockpit's recent-session rows).

## 0.1.0

First release.

- Session webview that streams output incrementally and renders tool calls, approvals, queued messages, todos, context usage and cost.
- RPC client for `omp --mode rpc-ui`: protocol v2 negotiation, chunk reassembly, request correlation, and prompt yield/settle lifecycle.
- Model and thinking-level selection that uses only the models OMP reports.
- New, resume and rename session; abort; steering and follow-up messages.
- Agents view for subagents, built from OMP subagent events, with inspect, transcript, steer and cancel actions.
- Changes view that opens VS Code's native diff for files changed by OMP tools.
- OMP process management: automatic restart with bounded backoff, and shutdown that leaves no OMP processes running.
