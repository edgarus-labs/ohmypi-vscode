# Changelog

## 0.5.0

- OMP's `auto` reasoning effort is selectable in the effort selector and `OMP: Select Thinking Level` for every reasoning model, and is honored: OMP picks the effort for each turn, and the selector keeps showing `auto` (as `auto · low` once OMP resolved the turn) instead of jumping to the resolved level.
- The effort selector reflects OMP's own selector on startup, resume and new sessions, read from the session journal, so an `auto` default from OMP's configuration shows as `auto`.
- Fixed: an edit could be missing from Changes (and its diff empty) when OMP wrote the file before the extension processed the tool's start event. The diff baseline now comes from the edit's own reported original content in that case.

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
