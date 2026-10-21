import type { ConnectionStatus, SessionView } from "../omp/api";
import { errorMessage } from "../shared/errors";
import { isRouterRouting, TIER_STATUS_KEY } from "../shared/router";
import { emptySessionView } from "../shared/session";
import { Composer } from "./composer";
import { OpenStateStore, type RenderContext } from "./context";
import { h } from "./dom";
import { listenForLinks } from "./fileLinks";
import { Banner, Header } from "./header";
import { InteractionsView } from "./interactions";
import { listenForCodeCopy } from "./markdown";
import type { HostMessage, StatusEntry, WebviewMessage } from "./protocol";
import { RenderReporter } from "./report";
import { ScrollArea } from "./scroll";
import { SessionControls } from "./sessionControls";
import { SessionPanel } from "./sessionPanel";
import { PersistedState, type VsCodeApi } from "./state";
import { TranscriptView } from "./transcript";
import { UsagePopup } from "./usagePopup";
import { WelcomeView } from "./welcome";
import { WorkingIndicator } from "./working";

export interface WebviewApp {
	handle(message: HostMessage): void;
}

/** Builds the chat UI into `root`, announces `ready` to the host and returns the host message handler. */
export function startWebviewApp(api: VsCodeApi, root: HTMLElement): WebviewApp {
	const post = (message: WebviewMessage) => api.postMessage(message);
	const state = new PersistedState(api);
	const ctx: OpenStateStore & RenderContext = Object.assign(new OpenStateStore(), { post });

	let session: SessionView = emptySessionView();
	let connection: ConnectionStatus = { state: "stopped" };
	let unavailable: string | undefined;
	/**
	 * A prompt sent while the session was idle, until the host reports the turn it started has ended, or
	 * that it took the prompt without one (a local command), or could not send it. The host posts
	 * `sendResult` before the session the prompt changed, so the row shows from Enter on without a gap.
	 */
	let localSend: { at: number; accepted: boolean; sawTurn: boolean } | undefined;

	/** Screen-reader announcements: finished replies, notices and new questions. */
	const liveRegion = h("div", { class: "sr-only", attrs: { "aria-live": "polite" } });
	const announce = (text: string) => liveRegion.replaceChildren(h("div", undefined, text));

	const header = new Header(post, () => usage.toggle());
	const banner = new Banner(post);
	const working = new WorkingIndicator();
	const transcript = new TranscriptView(ctx, announce, working.element);
	const welcome = new WelcomeView(post);
	const scroll = new ScrollArea(transcript.element, welcome.element);
	const panel = new SessionPanel(ctx, key => post({ type: "dismissTodos", key }));
	const controls = new SessionControls(post);
	const notice = (level: "info" | "warning" | "error", text: string) => {
		transcript.notice(level, text);
		afterTranscriptChange();
	};
	const reporter = new RenderReporter(post, () => ({
		counts: transcript.counts(),
		lastAssistantText: transcript.lastAssistantText(),
		interactions: interactions.ids(),
		collapsedTools: transcript.collapsedTools(),
		attachments: composer.attachmentLabels,
		recentSessions: welcome.recentRows,
	}));
	const composer = new Composer(
		{
			post,
			state,
			notice,
			onSubmit: () => {
				if (session.phase === "idle") localSend = { at: Date.now(), accepted: false, sawTurn: false };
				renderWorking();
				scroll.toBottom();
			},
			onAttachmentsChange: () => reporter.schedule(),
			closePopup: () => usage.close(),
		},
		controls,
	);
	const usage = new UsagePopup(scroll.element, post, () => composer.input.focus());
	const interactions = new InteractionsView({
		post,
		announce,
		composerHasFocus: () => document.activeElement === composer.input,
		focusComposer: () => composer.input.focus(),
	});

	root.append(
		header.element,
		banner.element,
		scroll.element,
		h(
			"div",
			{ class: "dock" },
			h("div", { class: "dock-inner" }, h("div", { class: "dock-stack" }, panel.statusLine, panel.queue, panel.todos, interactions.element), composer.element),
		),
		liveRegion,
	);
	listenForLinks(root, post);
	listenForCodeCopy(root);

	const renderHeader = () => header.render({ session, connection, pendingInteractions: interactions.size, unavailable });

	const updateWelcome = () => {
		transcript.element.classList.toggle("hidden", transcript.isEmpty && !working.visible);
		welcome.update({ empty: !transcript.hasConversation, unavailable, connection });
	};

	/** OMP's statuses: listed in the header; the tier router's marks the composer model while it routes. */
	const applyStatuses = (statuses: readonly StatusEntry[]) => {
		header.setStatuses(statuses);
		const tier = statuses.find(status => status.key === TIER_STATUS_KEY);
		controls.setTierAuto(tier !== undefined && isRouterRouting(tier.text));
	};

	function afterTranscriptChange(): void {
		updateWelcome();
		scroll.follow();
	}

	/** Ends the local send once the host reported what became of it. */
	const followLocalSend = () => {
		if (!localSend) return;
		if (session.turn) localSend.sawTurn = true;
		else if (localSend.sawTurn || (localSend.accepted && session.phase === "idle")) localSend = undefined;
	};

	function renderWorking(): void {
		const shown = working.visible;
		const turnStart = session.turn?.startedAt;
		working.render({
			phase: session.phase === "idle" && localSend ? "submitting" : session.phase,
			isCompacting: session.isCompacting,
			pendingInteractions: interactions.size,
			startedAt: localSend ? Math.min(localSend.at, turnStart ?? localSend.at) : turnStart,
			outputTokens: session.turn?.outputTokens,
		});
		if (working.visible !== shown) afterTranscriptChange();
	}

	const renderSession = () => {
		followLocalSend();
		renderHeader();
		controls.render(session);
		composer.setStatus({ busy: session.phase !== "idle", unavailable: unavailable !== undefined });
		composer.setCommands(session.commands);
		panel.render(session);
		renderWorking();
		updateWelcome();
	};

	/** Applies each part of a reset on its own so one failing part does not leave the rest stale. */
	const applyReset = (message: Extract<HostMessage, { type: "reset" }>) => {
		reporter.enabled = message.testHooks;
		const failures: string[] = [];
		const step = (part: () => void) => {
			try {
				part();
			} catch (error) {
				failures.push(errorMessage(error));
			}
		};
		if (message.session.sessionId !== session.sessionId) ctx.clear();
		session = message.session;
		ctx.cwd = message.cwd;
		connection = message.connection;
		unavailable = message.unavailable;
		state.setHostDefault(message.includeEditorContext);
		step(() => transcript.reset(message.items));
		const lostImages = state.takeLostImages();
		if (lostImages.length > 0)
			step(() => notice("warning", `The chat reloaded and did not keep these attached images; attach them again: ${lostImages.join(", ")}.`));
		const pendingIds = new Set(message.interactions.map(pending => pending.request.id));
		for (const id of interactions.ids()) if (!pendingIds.has(id)) interactions.remove(id);
		for (const pending of message.interactions) step(() => interactions.add(pending));
		step(() => banner.render(unavailable));
		step(() => applyStatuses(message.statuses));
		step(() => panel.setDismissedTodos(message.dismissedTodos));
		step(renderSession);
		scroll.toBottom();
		afterTranscriptChange();
		if (failures.length > 0) throw new Error(failures.join("; "));
	};

	const apply = (message: HostMessage) => {
		switch (message.type) {
			case "reset":
				applyReset(message);
				break;
			case "sendResult":
				composer.handleSendResult(message);
				if (localSend && !message.ok) localSend = undefined;
				else if (localSend) localSend.accepted = true;
				renderWorking();
				break;
			case "item":
				transcript.upsert(message.item);
				afterTranscriptChange();
				break;
			case "session":
				session = message.session;
				renderSession();
				break;
			case "connection":
				connection = message.connection;
				renderHeader();
				updateWelcome();
				break;
			case "interaction":
				interactions.add(message.pending);
				renderHeader();
				renderWorking();
				break;
			case "interactionClosed":
				interactions.remove(message.id);
				renderHeader();
				renderWorking();
				break;
			case "notice":
				notice(message.level, message.text);
				break;
			case "setComposer":
				composer.setText(message.text);
				break;
			case "focusComposer":
				composer.input.focus();
				break;
			case "addAttachments":
				composer.addAttachments(message.attachments);
				break;
			case "recentSessions":
				welcome.setRecent(message.sessions, message.total);
				updateWelcome();
				break;
			case "statuses":
				applyStatuses(message.statuses);
				break;
			case "toggleUsage":
				usage.toggle();
				break;
			case "usage":
				usage.handleResult(message);
				break;
		}
	};

	const handle = (message: HostMessage) => {
		try {
			apply(message);
		} catch (error) {
			notice("error", `Could not show the ${message.type} message: ${errorMessage(error)}`);
		}
		reporter.schedule();
	};

	window.setInterval(() => {
		if (welcome.visible && welcome.hasRecent) welcome.renderRecent();
	}, 60_000);
	composer.autosize();
	renderSession();
	post({ type: "ready" });
	return { handle };
}
