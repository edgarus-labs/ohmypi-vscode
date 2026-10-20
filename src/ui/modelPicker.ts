import * as vscode from "vscode";
import type { ModelView, OmpServiceApi } from "../omp/api";
import { catalogGroups, modelItemText } from "./modelCatalog";
import { type ModelPreferences, modelKey } from "./modelPreferences";

type ModelItem = vscode.QuickPickItem & { model?: ModelView; key?: string };

const STAR: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("star-empty"), tooltip: "Add to favorites" };
const UNSTAR: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("star-full"), tooltip: "Remove from favorites" };
const COPY_ID: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("copy"), tooltip: "Copy model id" };
const FAVORITES_OFF: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("star-empty"), tooltip: "Show favorites only" };
const FAVORITES_ON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("star-full"), tooltip: "Favorites filter on: show all models" };
const RECENT_OFF: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("history"), tooltip: "Show recently picked models only" };
const RECENT_ON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("filter-filled"), tooltip: "Recent filter on: show all models" };

/**
 * Lets the user pick the model of the session from the models OMP reports, grouped per provider with the
 * current one marked, and switches to it. Each row stars the model as a favorite or copies its id; the title
 * bar toggles the Favorites and Recent filters, which are remembered. Picking records the model as recent.
 * Resolves once the picker closes; rejects when a preference cannot be stored, the id cannot be copied or
 * the switch fails.
 */
export async function pickModel(service: OmpServiceApi, preferences: ModelPreferences): Promise<void> {
	const models = await service.listModels();
	if (models.length === 0) {
		void vscode.window.showWarningMessage("OMP reports no available models. Configure providers in OMP.");
		return;
	}
	const current = service.session.model;
	const currentKey = current ? modelKey(current) : undefined;
	const picker = vscode.window.createQuickPick<ModelItem>();
	picker.placeholder = "Search models by name, id or provider";
	picker.matchOnDescription = true;
	picker.matchOnDetail = true;

	const render = () => {
		const { favorites, favoritesOnly, recentOnly } = preferences;
		const filters = [favoritesOnly ? "Favorites" : "", recentOnly ? "Recent" : ""].filter(Boolean);
		picker.title = filters.length > 0 ? `Select Model (${filters.join(", ")})` : "Select Model";
		picker.buttons = [favoritesOnly ? FAVORITES_ON : FAVORITES_OFF, recentOnly ? RECENT_ON : RECENT_OFF];
		const active = picker.activeItems[0]?.key ?? currentKey;
		const items: ModelItem[] = [];
		for (const group of catalogGroups(models, { favorites, recents: preferences.recents, favoritesOnly, recentOnly, currentProvider: current?.provider })) {
			items.push({ label: group.provider, kind: vscode.QuickPickItemKind.Separator });
			for (const entry of group.entries) {
				const isCurrent = entry.key === currentKey;
				const { description, detail } = modelItemText(entry.model);
				items.push({
					label: `${isCurrent ? "$(check) " : ""}${entry.label}`,
					description: isCurrent ? [description, "current"].filter(Boolean).join(" · ") : description,
					detail,
					buttons: [favorites.includes(entry.key) ? UNSTAR : STAR, COPY_ID],
					model: entry.model,
					key: entry.key,
				});
			}
		}
		picker.items = items;
		const keep = items.find(item => item.key !== undefined && item.key === active);
		if (keep) picker.activeItems = [keep];
	};

	return new Promise<void>((resolve, reject) => {
		let accepted: ModelItem | undefined;
		let failure: { error: unknown } | undefined;
		const run = (action: () => Promise<void>) =>
			action().then(undefined, error => {
				failure ??= { error };
				picker.hide();
			});
		const subscriptions = [
			picker.onDidTriggerButton(button =>
				run(async () => {
					if (button === FAVORITES_ON || button === FAVORITES_OFF) await preferences.setFavoritesOnly(!preferences.favoritesOnly);
					else if (button === RECENT_ON || button === RECENT_OFF) await preferences.setRecentOnly(!preferences.recentOnly);
					render();
				}),
			),
			picker.onDidTriggerItemButton(({ item, button }) =>
				run(async () => {
					if (!item.model || !item.key) return;
					if (button === COPY_ID) {
						await vscode.env.clipboard.writeText(item.model.id);
						return;
					}
					await preferences.toggleFavorite(item.key);
					render();
				}),
			),
			picker.onDidAccept(() => {
				const pick = picker.selectedItems[0];
				if (!pick?.model || !pick.key) return;
				accepted = pick;
				picker.hide();
			}),
			picker.onDidHide(() => {
				for (const subscription of subscriptions) subscription.dispose();
				picker.dispose();
				if (failure) reject(failure.error);
				else if (accepted?.model && accepted.key) {
					const { model, key } = accepted;
					resolve(preferences.recordPicked(key).then(() => service.setModel(model.provider, model.id)));
				} else resolve();
			}),
		];
		render();
		picker.show();
	});
}
