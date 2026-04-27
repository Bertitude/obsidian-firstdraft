import { Plugin } from "obsidian";
import type { FirstDraftSettings } from "./types";
import { DEFAULT_SETTINGS } from "./settings/defaults";
import { mergeSettings } from "./settings/merge";
import { FirstDraftSettingTab } from "./settings/settings-tab";
import { ProjectScanner } from "./projects/scanner";
import { registerEventHandlers } from "./events/register";
import { DevNotesView, activateDevNotesView } from "./views/dev-notes-view";
import { VIEW_TYPE_DEV_NOTES } from "./views/view-types";
import { runCreateOutlineCommand, runPromoteOutlineCommand } from "./outline/promote";

export default class FirstDraftPlugin extends Plugin {
	settings!: FirstDraftSettings;
	scanner!: ProjectScanner;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.scanner = new ProjectScanner(
			this.app,
			() => this.settings.global.developmentFolder,
			() => this.settings.global.debugLogging,
		);

		this.registerView(VIEW_TYPE_DEV_NOTES, (leaf) => new DevNotesView(leaf, this));
		this.addSettingTab(new FirstDraftSettingTab(this.app, this));
		registerEventHandlers(this);

		this.addRibbonIcon("notebook-pen", "Open dev notes panel", () => {
			void activateDevNotesView(this);
		});

		this.addCommand({
			id: "open-dev-notes-panel",
			name: "Open dev notes panel",
			callback: () => {
				void activateDevNotesView(this);
			},
		});

		this.addCommand({
			id: "create-outline",
			name: "Create outline",
			callback: () => {
				void runCreateOutlineCommand(this);
			},
		});

		this.addCommand({
			id: "promote-outline",
			name: "Promote outline to scenes",
			callback: () => {
				void runPromoteOutlineCommand(this);
			},
		});

		this.app.workspace.onLayoutReady(() => this.scanner.scanAll());
	}

	onunload(): void {
		// Listeners, commands, and registered views clean up automatically. Leaves of
		// our view type stay open across reloads — Obsidian will recreate them via the
		// view factory we registered.
	}

	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<FirstDraftSettings> | null;
		this.settings = mergeSettings(loaded, DEFAULT_SETTINGS);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
