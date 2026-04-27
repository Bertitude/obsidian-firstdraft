import { Plugin } from "obsidian";
import type { FirstDraftSettings } from "./types";
import { DEFAULT_SETTINGS } from "./settings/defaults";
import { mergeSettings } from "./settings/merge";
import { FirstDraftSettingTab } from "./settings/settings-tab";
import { ProjectScanner } from "./projects/scanner";
import { registerEventHandlers } from "./events/register";
import { DevNotesView, activateDevNotesView } from "./views/dev-notes-view";
import { TreatmentView, activateTreatmentView } from "./views/treatment-view";
import { VIEW_TYPE_DEV_NOTES, VIEW_TYPE_TREATMENT } from "./views/view-types";
import { runCreateOutlineCommand, runPromoteOutlineCommand } from "./outline/promote";
import {
	runSnapshotFileCommand,
	runSnapshotProjectCommand,
	runBrowseVersionsCommand,
	runRestoreFromSnapshotCommand,
} from "./versioning/snapshot-commands";
import { CharacterCueSuggest } from "./autocomplete/character-suggest";

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
		this.registerView(VIEW_TYPE_TREATMENT, (leaf) => new TreatmentView(leaf, this));
		this.registerEditorSuggest(new CharacterCueSuggest(this));
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
			id: "open-treatment-view",
			name: "Open treatment view",
			callback: () => {
				void activateTreatmentView(this);
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

		this.addCommand({
			id: "snapshot-file",
			name: "Snapshot file",
			callback: () => {
				void runSnapshotFileCommand(this);
			},
		});

		this.addCommand({
			id: "snapshot-project",
			name: "Snapshot project draft",
			callback: () => {
				void runSnapshotProjectCommand(this);
			},
		});

		this.addCommand({
			id: "browse-versions",
			name: "Browse file versions",
			callback: () => {
				void runBrowseVersionsCommand(this);
			},
		});

		this.addCommand({
			id: "restore-from-snapshot",
			name: "Restore file from snapshot",
			callback: () => {
				void runRestoreFromSnapshotCommand(this);
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
