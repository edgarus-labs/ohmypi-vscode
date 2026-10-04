/** Ids of the chat, agents and changes views in whichever container is active. */
export interface OmpViewIds {
	chat: string;
	agents: string;
	changes: string;
}

/** `viewsContainers.secondarySidebar` is honored from VS Code 1.106 on. */
export function supportsSecondarySidebar(version: string): boolean {
	const match = /^(\d+)\.(\d+)/.exec(version);
	if (!match) return false;
	const [major, minor] = [Number(match[1]), Number(match[2])];
	return major > 1 || (major === 1 && minor >= 106);
}

/** Secondary Sidebar views, or their Activity Bar fallbacks on older VS Code. */
export function chatViewIds(secondary: boolean): OmpViewIds {
	return secondary
		? { chat: "omp.chat", agents: "omp.agents", changes: "omp.changes" }
		: { chat: "omp.chatSidebar", agents: "omp.agentsSidebar", changes: "omp.changesSidebar" };
}
