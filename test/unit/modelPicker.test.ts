import * as assert from "node:assert/strict";
import type { ModelView, OmpServiceApi } from "../../src/omp/api";
import { pickModel } from "../../src/ui/modelPicker";
import { ModelPreferences, type PreferenceMemento } from "../../src/ui/modelPreferences";
import { tick } from "./helpers";
import { env, EventEmitter, stub, window } from "./stubs/vscode";

interface FakeButton {
	tooltip?: string;
}

interface FakeItem {
	label: string;
	key?: string;
	buttons?: FakeButton[];
}

class FakeQuickPick {
	title = "";
	placeholder = "";
	matchOnDescription = false;
	matchOnDetail = false;
	buttons: FakeButton[] = [];
	items: FakeItem[] = [];
	selectedItems: FakeItem[] = [];
	activeItems: FakeItem[] = [];
	readonly accepted = new EventEmitter<void>();
	readonly hidden = new EventEmitter<void>();
	readonly buttonTriggered = new EventEmitter<FakeButton>();
	readonly itemButtonTriggered = new EventEmitter<{ item: FakeItem; button: FakeButton }>();
	readonly onDidAccept = this.accepted.event;
	readonly onDidHide = this.hidden.event;
	readonly onDidTriggerButton = this.buttonTriggered.event;
	readonly onDidTriggerItemButton = this.itemButtonTriggered.event;
	show(): void {}
	hide(): void {
		this.hidden.fire();
	}
	dispose(): void {}

	item(key: string): FakeItem {
		const found = this.items.find(item => item.key === key);
		if (!found) assert.fail(`no item ${key}`);
		return found;
	}

	pressItemButton(key: string, tooltip: string): void {
		const item = this.item(key);
		const button = item.buttons?.find(candidate => candidate.tooltip === tooltip);
		if (!button) assert.fail(`no ${tooltip} button on ${key}`);
		this.itemButtonTriggered.fire({ item, button });
	}
}

class MemoryMemento implements PreferenceMemento {
	readonly values = new Map<string, unknown>();
	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}
	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
}

function model(provider: string, id: string): ModelView {
	return { provider, id, name: id, reasoning: false, thinkingEfforts: [], input: ["text"] };
}

describe("pickModel", () => {
	const patched = { window: window as Record<string, unknown>, env: env as Record<string, unknown> };
	let picker: FakeQuickPick;
	let preferences: ModelPreferences;
	let switched: string[];
	let clipboard: string[];
	let service: OmpServiceApi;

	beforeEach(() => {
		stub.reset();
		picker = new FakeQuickPick();
		preferences = new ModelPreferences(new MemoryMemento());
		switched = [];
		clipboard = [];
		patched.window.createQuickPick = () => picker;
		patched.env.clipboard = { writeText: async (text: string) => void clipboard.push(text) };
		service = {
			session: { model: model("p", "a") },
			listModels: async () => [model("p", "a"), model("p", "b"), model("q", "c")],
			setModel: async (provider: string, id: string) => void switched.push(`${provider}/${id}`),
		} as unknown as OmpServiceApi;
	});

	afterEach(() => {
		delete patched.window.createQuickPick;
		delete patched.env.clipboard;
	});

	it("switches to the picked model and records it as recent", async () => {
		const picked = pickModel(service, preferences);
		await tick();
		assert.equal(picker.item("p/a").label, "$(check) a");
		picker.selectedItems = [picker.item("q/c")];
		picker.accepted.fire();
		await picked;
		assert.deepEqual(switched, ["q/c"]);
		assert.deepEqual(preferences.recents, ["q/c"]);
	});

	it("stars a model and copies its id from its row", async () => {
		const picked = pickModel(service, preferences);
		await tick();
		picker.pressItemButton("p/b", "Add to favorites");
		await tick();
		assert.deepEqual(preferences.favorites, ["p/b"]);
		assert.ok(picker.item("p/b").buttons?.some(button => button.tooltip === "Remove from favorites"));
		picker.pressItemButton("q/c", "Copy model id");
		await tick();
		assert.deepEqual(clipboard, ["c"]);
		picker.hide();
		await picked;
		assert.deepEqual(switched, []);
	});

	it("narrows the list with the Favorites filter and remembers it", async () => {
		await preferences.toggleFavorite("q/c");
		const picked = pickModel(service, preferences);
		await tick();
		picker.buttonTriggered.fire(picker.buttons[0]);
		await tick();
		assert.equal(preferences.favoritesOnly, true);
		assert.deepEqual(
			picker.items.filter(item => item.key).map(item => item.key),
			["q/c"],
		);
		assert.equal(picker.title, "Select Model (Favorites)");
		picker.hide();
		await picked;
	});
});
