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
import {
	runCreateCharacterFromSelection,
	runCreateLocationFromSelection,
	runLinkifyAllCommand,
} from "./development/create-entity";
import {
	runInsertCharacterCueCommand,
	runInsertLocationReferenceCommand,
} from "./development/insert-cue";
import {
	runDeleteCharacterCommand,
	runDeleteLocationCommand,
} from "./development/delete-entity";
import { isPluginEnabled, KNOWN_PLUGIN_IDS, resolveFountainMode } from "./fountain/plugin-mode";
import { runMigrateProjectCommand } from "./fountain/migrate";
import { runSyncSluglinesCommand } from "./fountain/sync-sluglines";
import { installRenameSync } from "./rename-sync/handler";
import { runSyncScreenplayScenesCommand } from "./longform/sync-scenes";
import { toggleFirstDraftMode, exitFirstDraftModeSync } from "./firstdraft-mode/toggle";
import { installCursorScrollHandler } from "./cursor-scroll/handler";
import { Notice } from "obsidian";

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
		installCursorScrollHandler(this);
		installRenameSync(this);

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

		this.addCommand({
			id: "create-character-from-selection",
			name: "Create character from selection",
			editorCallback: (editor) => {
				runCreateCharacterFromSelection(this, editor);
			},
		});

		this.addCommand({
			id: "create-location-from-selection",
			name: "Create location from selection",
			editorCallback: (editor) => {
				runCreateLocationFromSelection(this, editor);
			},
		});

		this.addCommand({
			id: "linkify-all-entities",
			name: "Linkify all entities",
			callback: () => {
				void runLinkifyAllCommand(this);
			},
		});

		this.addCommand({
			id: "insert-character-cue",
			name: "Insert character cue",
			callback: () => {
				runInsertCharacterCueCommand(this);
			},
		});

		this.addCommand({
			id: "insert-location-reference",
			name: "Insert location reference",
			callback: () => {
				runInsertLocationReferenceCommand(this);
			},
		});

		this.addCommand({
			id: "delete-character",
			name: "Delete character",
			callback: () => {
				runDeleteCharacterCommand(this);
			},
		});

		this.addCommand({
			id: "delete-location",
			name: "Delete location",
			callback: () => {
				runDeleteLocationCommand(this);
			},
		});

		this.addCommand({
			id: "sync-screenplay-scenes",
			name: "Sync screenplay scenes to project",
			callback: () => {
				void runSyncScreenplayScenesCommand(this);
			},
		});

		this.addCommand({
			id: "migrate-to-fountain-md",
			name: "Migrate project to .fountain.md",
			callback: () => {
				void runMigrateProjectCommand(this);
			},
		});

		this.addCommand({
			id: "toggle-first-draft-mode",
			name: "Toggle First Draft Mode",
			callback: () => {
				void toggleFirstDraftMode(this);
			},
		});

		this.addCommand({
			id: "sync-sluglines-to-fountain",
			name: "Sync sluglines from dev note to fountain",
			callback: () => {
				void runSyncSluglinesCommand(this);
			},
		});

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				if (!editor.getSelection().trim()) return;
				menu.addItem((item) =>
					item
						.setTitle("Create character from selection")
						.setIcon("user")
						.onClick(() => runCreateCharacterFromSelection(this, editor)),
				);
				menu.addItem((item) =>
					item
						.setTitle("Create location from selection")
						.setIcon("map-pin")
						.onClick(() => runCreateLocationFromSelection(this, editor)),
				);
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			this.scanner.scanAll();
			this.applyFountainPluginMode();
		});
	}

	onunload(): void {
		// Strip First Draft Mode body classes so they don't leak when the plugin is
		// disabled. Listeners, commands, and views clean up automatically.
		exitFirstDraftModeSync(this);
	}

	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<FirstDraftSettings> | null;
		this.settings = mergeSettings(loaded, DEFAULT_SETTINGS);
		// First Draft Mode is session-only — reset transient fields on load.
		this.settings.global.firstDraftMode.active = false;
		this.settings.global.firstDraftMode.savedLayout = null;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// Apply the resolved fountain plugin mode at startup. When chuangcaleb mode
	// is in effect, register .fountain → markdown view so EditorSuggest fires
	// inline. Refuses to register if bgrundmann's plugin is also enabled
	// (prevents the silent crash documented in the Custom File Extensions
	// Plugin issue tracker).
	private applyFountainPluginMode(): void {
		const mode = resolveFountainMode(this);
		if (mode !== "chuangcaleb") return;

		if (isPluginEnabled(this, KNOWN_PLUGIN_IDS.bgrundmann)) {
			new Notice(
				"Disable the other fountain plugin before switching modes.",
				8000,
			);
			return;
		}

		try {
			this.registerExtensions(["fountain"], "markdown");
		} catch (e) {
			new Notice(
				`FirstDraft: could not register .fountain as Markdown — ${(e as Error).message}`,
			);
		}
	}
}
