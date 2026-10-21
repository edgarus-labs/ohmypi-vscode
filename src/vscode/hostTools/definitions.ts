import type { HostToolDefinition } from "../../omp/api";

export const SEVERITIES = ["error", "warning", "info", "hint", "all"] as const;
export const TASK_ACTIONS = ["list", "run"] as const;
export const DEBUG_ACTIONS = ["start", "stop", "pause", "continue", "step_into", "step_over", "step_out", "state"] as const;
export const BREAKPOINT_ACTIONS = ["list", "add", "remove"] as const;
export const INSPECT_KINDS = ["evaluate", "callstack", "locals"] as const;

const PATH_NOTE = "Relative paths are resolved against the working directory; the file must be inside the workspace.";

const str = (description: string) => ({ type: "string", description });
const int = (description: string, minimum: number) => ({ type: "integer", description, minimum });
const bool = (description: string) => ({ type: "boolean", description });
const choice = (description: string, values: readonly string[]) => ({ type: "string", description, enum: values });

function tool<N extends string>(name: N, description: string, properties: Record<string, unknown> = {}, required: string[] = []) {
	return { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } satisfies HostToolDefinition;
}

/** The tools OMP's agent can call to operate VS Code, in the order the agent sees them. */
export const TOOL_DEFINITIONS = [
	tool(
		"vscode_workspace",
		"Describe what VS Code has open: the workspace folders, the working directory, the active editor and every open editor. Use it first to learn what the IDE has loaded.",
	),
	tool(
		"vscode_documents",
		"List the documents open in VS Code editor tabs with their state (active, unsaved changes, preview). Use it to see what the user is looking at or which files carry unsaved edits.",
	),
	tool(
		"vscode_open_document",
		`Open a file in a VS Code editor tab (or activate it) and optionally move the cursor there. Use it to show the user a file or a location, for example after finding a bug or an error. ${PATH_NOTE}`,
		{ path: str("File to open."), line: int("1-based line to place the cursor on.", 1), column: int("1-based column to place the cursor on.", 1) },
		["path"],
	),
	tool(
		"vscode_read_document",
		`Read a file with line numbers through VS Code: the editor buffer including unsaved edits when the file is open, otherwise the file on disk. Use it instead of reading from disk when the user may have unsaved changes, and to get the line numbers vscode_replace_lines needs. ${PATH_NOTE}`,
		{
			path: str("File to read."),
			startLine: int("First line to read (1-based). Defaults to the first line.", 1),
			endLine: int("Last line to read (inclusive). Defaults to the last line.", 1),
		},
		["path"],
	),
	tool(
		"vscode_replace_lines",
		`Replace a range of lines of a file in the VS Code editor buffer, which keeps the editor's undo history and shows the edit live. The document is left unsaved; call vscode_save to write it. Use it to edit a file the user has open. To insert before a line set endLine to startLine - 1; to delete lines pass empty text. ${PATH_NOTE}`,
		{
			path: str("File to edit."),
			startLine: int("First line to replace (1-based). May be one past the last line to append.", 1),
			endLine: int("Last line to replace (inclusive). startLine - 1 inserts before startLine.", 0),
			text: str("Replacement text; empty deletes the lines."),
		},
		["path", "startLine", "endLine", "text"],
	),
	tool(
		"vscode_save",
		`Save one document, or every document with unsaved changes when no path is given. Use it after vscode_replace_lines, before running tasks or debugging so they see the edits. ${PATH_NOTE}`,
		{ path: str("File to save. Omit to save all unsaved documents.") },
	),
	tool(
		"vscode_close_document",
		`Close a document's editor tabs in VS Code. Unsaved changes are discarded unless save is true. ${PATH_NOTE}`,
		{ path: str("File whose tabs to close."), save: bool("Save the document before closing. Defaults to false (unsaved changes are discarded).") },
		["path"],
	),
	tool(
		"vscode_selection",
		'Get the active editor\'s selection (or cursor position) and the selected text. Use it when the user refers to "this", "the selected code" or "here".',
	),
	tool(
		"vscode_diagnostics",
		`List the diagnostics VS Code shows in the Problems panel (language servers, linters, task problem matchers). Use it to see what is wrong without running a build. ${PATH_NOTE}`,
		{
			severity: choice("Which diagnostics to list. Defaults to error.", SEVERITIES),
			path: str("Only list the diagnostics of this file. Omit for every file."),
			max: int("Maximum number of entries. Defaults to 100.", 1),
		},
	),
	tool(
		"vscode_tasks",
		"List the VS Code tasks (tasks.json and auto-detected ones such as npm scripts), or run one and wait for it to end. Running returns the exit code and up to 50 errors and warnings from the Problems panel; a background task (a watcher) is only started. Use it to build or test with the workspace's own tasks; call vscode_save first so unsaved edits are included.",
		{
			action: choice("list shows the available tasks, run starts one and waits for it to end. Defaults to list.", TASK_ACTIONS),
			name: str("Task name or label as listed by action list. Required for run."),
		},
	),
	tool(
		"vscode_debug",
		"Control the VS Code debugger: start a launch configuration (with or without debugging), stop, pause, continue and step. Stepping, continuing and pausing wait until the debuggee stops again or ends and report where it stopped. Use action state to see the current mode and location.",
		{
			action: choice("Debugger operation.", DEBUG_ACTIONS),
			configuration: str("Launch configuration name for start. Omit to start the configuration selected in the Run and Debug view."),
			noDebug: bool("For start: run without debugging. Defaults to false."),
		},
		["action"],
	),
	tool(
		"vscode_breakpoints",
		`List, add or remove breakpoints in VS Code. Use it to prepare a debugging session before vscode_debug start. ${PATH_NOTE}`,
		{
			action: choice("list shows all breakpoints, add sets one, remove deletes the ones at a location.", BREAKPOINT_ACTIONS),
			path: str("File of the breakpoint. Required for add and remove."),
			line: int("1-based line. Required for add; remove deletes every breakpoint in the file when omitted.", 1),
			condition: str("Condition expression for add; the breakpoint only hits when it is true."),
		},
		["action"],
	),
	tool(
		"vscode_debug_inspect",
		"Inspect the program stopped in the VS Code debugger: evaluate an expression in the top frame of the stopped thread, show its call stack or its local variables. The debuggee must be stopped (see vscode_debug).",
		{ kind: choice("What to inspect.", INSPECT_KINDS), expression: str("Expression to evaluate. Required for kind evaluate.") },
		["kind"],
	),
	tool(
		"vscode_find_commands",
		"Search VS Code command ids (such as editor.action.formatDocument or workbench.action.files.saveAll) by substring. Use it to discover the exact id before vscode_execute_command.",
		{ filter: str("Case-insensitive text the command id must contain."), max: int("Maximum number of commands. Defaults to 50.", 1) },
		["filter"],
	),
	tool(
		"vscode_execute_command",
		"Run any VS Code command by id, as if chosen from the Command Palette, for IDE features the other vscode_ tools do not cover (format document, organize imports, refactorings, ...). Find the id with vscode_find_commands. Most editor commands act on the active editor. Returns the command's result when it is JSON.",
		{
			command: str("Command id, for example editor.action.formatDocument."),
			arguments: str('Arguments passed to the command, as a JSON array, for example [true, "text"].'),
		},
		["command"],
	),
] as const satisfies readonly HostToolDefinition[];

export type ToolName = (typeof TOOL_DEFINITIONS)[number]["name"];
