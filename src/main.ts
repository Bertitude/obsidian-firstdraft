import { Plugin } from "obsidian";
import type { FirstDraftSettings } from "./types";
import { DEFAULT_SETTINGS } from "./settings/defaults";
import { mergeSettings } from "./settings/merge";
import { normaliseDelimiterValue } from "./settings/slugline-delimiter";
import { FirstDraftSettingTab } from "./settings/settings-tab";
import { ProjectScanner } from "./projects/scanner";
import { registerEventHandlers } from "./events/register";
import { DevNotesView, activateDevNotesView } from "./views/dev-notes-view";
import { OutlineView, activateOutlineView } from "./views/outline-view";
import {
	CharacterMatrixView,
	activateCharacterMatrixView,
} from "./views/character-matrix-view";
import {
	BeatSheetView,
	activateBeatSheetView,
} from "./views/beat-sheet-view";
import {
	ProjectHomeView,
	activateProjectHomeView,
} from "./views/project-home-view";
import {
	ProjectNotesView,
	activateProjectNotesView,
	activateProjectNotesViewSplit,
} from "./views/project-notes-view";
import { runCreateProjectNoteCommand } from "./development/create-project-note";
import { openFirstDraftPalette } from "./views/firstdraft-palette";
import {
	VIEW_TYPE_DEV_NOTES,
	VIEW_TYPE_OUTLINE,
	VIEW_TYPE_CHARACTER_MATRIX,
	VIEW_TYPE_BEAT_SHEET,
	VIEW_TYPE_PROJECT_HOME,
	VIEW_TYPE_PROJECT_NOTES,
} from "./views/view-types";
import { runCreateTreatmentCommand, runPromoteTreatmentCommand } from "./treatment/promote";
import {
	runSnapshotFileCommand,
	runSnapshotProjectCommand,
	runBrowseVersionsCommand,
	runRestoreFromSnapshotCommand,
} from "./versioning/snapshot-commands";
import { CharacterCueSuggest } from "./autocomplete/character-suggest";
import { SluglineSuggest } from "./autocomplete/slugline-suggest";
import {
	runCreateCharacterCommand,
	runCreateCharacterFromSelection,
	runCreateLocationCommand,
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
import { runTagSelectionAsAliasCommand } from "./development/aliases";
import { runAuditAliasesCommand } from "./development/audit-aliases";
import { runTagSelectionAsGroupCommand } from "./development/groups";
import {
	runApplyBeatTemplateCommand,
	runAssignSceneToBeatCommand,
	runClearBeatSheetCommand,
} from "./development/assign-beat";
import { runSplitSceneCommand } from "./development/split-scene";
import { runMergeSceneCommand } from "./development/merge-scenes";
import { runAtomizeSequenceCommand } from "./development/atomize";
import { runUpdateSequenceCommand } from "./development/update-sequence";
import { runMigrateStableIdsCommand } from "./development/migrate-stable-ids";
import { runCreateNewSceneCommand } from "./development/create-scene";
import { toggleProjectLock, clearProjectLockOnUnload } from "./project-lock/lock";
import { runOpenFirstDraftProjectCommand } from "./projects/open-project";
import { runCreateProjectCommand } from "./projects/create-project";
import { runCreateEpisodeCommand } from "./projects/create-episode";
import { runCreateSeasonCommand } from "./projects/create-season";
import { runInitializeSeriesRootCommand } from "./projects/init-series";
import { runInitializeSeasonRootCommand } from "./projects/init-season";
import { runMakeEpisodesFromSeasonOutlineCommand } from "./projects/promote-season-outline";
import { runSetProjectTitleCommand } from "./projects/set-title";
import { resolveActiveProject } from "./projects/resolver";
import { openProjectSettingsModal } from "./settings/project-settings-modal";
import { runMigrateSchemaFromLongformCommand } from "./projects/migrate-schema";
import { runMigrateSequencesNamingCommand } from "./projects/migrate-sequences";
import { runCompileManuscriptCommand } from "./firstdraft/compile";
import { isPluginEnabled, KNOWN_PLUGIN_IDS, resolveFountainMode } from "./fountain/plugin-mode";
import { runMigrateProjectCommand } from "./fountain/migrate";
import { runSyncSluglinesCommand } from "./fountain/sync-sluglines";
import { runSyncSluglinesToDevNoteCommand } from "./fountain/sync-sluglines-to-devnote";
import { runCleanupSluglinesCommand } from "./fountain/cleanup-sluglines";
import { runSyncCharactersCommand } from "./fountain/sync-characters";
import { runSyncCharactersFromProseCommand } from "./fountain/sync-characters-prose";
import { installRenameSync } from "./rename-sync/handler";
import { runSyncScreenplaySequencesCommand } from "./longform/sync-scenes";
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
		this.registerView(VIEW_TYPE_OUTLINE, (leaf) => new OutlineView(leaf, this));
		this.registerView(
			VIEW_TYPE_CHARACTER_MATRIX,
			(leaf) => new CharacterMatrixView(leaf, this),
		);
		this.registerView(
			VIEW_TYPE_BEAT_SHEET,
			(leaf) => new BeatSheetView(leaf, this),
		);
		this.registerView(
			VIEW_TYPE_PROJECT_HOME,
			(leaf) => new ProjectHomeView(leaf, this),
		);
		this.registerView(
			VIEW_TYPE_PROJECT_NOTES,
			(leaf) => new ProjectNotesView(leaf, this),
		);
		this.registerEditorSuggest(new CharacterCueSuggest(this));
		this.registerEditorSuggest(new SluglineSuggest(this));
		this.addSettingTab(new FirstDraftSettingTab(this.app, this));
		registerEventHandlers(this);
		installCursorScrollHandler(this);
		installRenameSync(this);

		this.addRibbonIcon("notebook-pen", "Open dev notes panel", () => {
			void activateDevNotesView(this);
		});
		this.addRibbonIcon("home", "Open project home", () => {
			void activateProjectHomeView(this);
		});

		this.addCommand({
			id: "open-dev-notes-panel",
			name: "Open dev notes panel",
			callback: () => {
				void activateDevNotesView(this);
			},
		});

		this.addCommand({
			id: "open-project-home",
			name: "Open project home",
			callback: () => {
				void activateProjectHomeView(this);
			},
		});

		this.addCommand({
			id: "open-project-notes-panel",
			name: "Open project notes panel",
			callback: () => {
				void activateProjectNotesView(this);
			},
		});

		this.addCommand({
			id: "open-project-notes-panel-split",
			name: "Open project notes panel (split with dev notes)",
			callback: () => {
				void activateProjectNotesViewSplit(this);
			},
		});

		this.addCommand({
			id: "create-project-note",
			name: "Add note (contextual)",
			callback: () => {
				void runCreateProjectNoteCommand(this);
			},
		});

		// FirstDraft palette: a SuggestModal scoped to FirstDraft commands only.
		// We don't try to intercept Cmd/Ctrl+P automatically — Obsidian's hotkey
		// dispatcher operates above any DOM event layer we can reach (tested both
		// document keydown with capture phase and app.scope.register; neither
		// wins the race against the built-in palette binding). Users bind their
		// own hotkey in Settings → Hotkeys.
		this.addCommand({
			id: "open-firstdraft-palette",
			name: "Open FirstDraft palette",
			callback: () => {
				openFirstDraftPalette(this);
			},
		});

		this.addCommand({
			id: "open-firstdraft-project",
			name: "Open FirstDraft project",
			callback: () => {
				runOpenFirstDraftProjectCommand(this);
			},
		});

		this.addCommand({
			id: "create-firstdraft-project",
			name: "Create FirstDraft project",
			callback: () => {
				runCreateProjectCommand(this);
			},
		});

		this.addCommand({
			id: "set-project-title",
			name: "Set project title",
			callback: () => {
				void runSetProjectTitleCommand(this);
			},
		});

		this.addCommand({
			id: "open-project-settings",
			name: "Open project settings",
			callback: () => {
				const active = this.app.workspace.getActiveFile();
				if (!active) {
					new Notice("Open a file inside a project first.");
					return;
				}
				const project = resolveActiveProject(active, this.scanner);
				if (!project) {
					new Notice("Active file isn't inside a recognised project.");
					return;
				}
				openProjectSettingsModal(this, project);
			},
		});

		this.addCommand({
			id: "create-season",
			name: "Create season",
			callback: () => {
				runCreateSeasonCommand(this);
			},
		});

		this.addCommand({
			id: "create-episode",
			name: "Create episode",
			callback: () => {
				runCreateEpisodeCommand(this);
			},
		});

		this.addCommand({
			id: "make-episodes-from-season-outline",
			name: "Make episodes from season outline",
			callback: () => {
				void runMakeEpisodesFromSeasonOutlineCommand(this);
			},
		});

		this.addCommand({
			id: "initialize-series-root",
			name: "Initialize series root",
			callback: () => {
				runInitializeSeriesRootCommand(this);
			},
		});

		this.addCommand({
			id: "initialize-season-root",
			name: "Initialize season root",
			callback: () => {
				runInitializeSeasonRootCommand(this);
			},
		});

		this.addCommand({
			id: "migrate-schema-from-longform",
			name: "Migrate project schema from Longform to FirstDraft",
			callback: () => {
				void runMigrateSchemaFromLongformCommand(this);
			},
		});

		this.addCommand({
			id: "migrate-sequences-naming",
			name: "Migrate project to sequences naming",
			callback: () => {
				void runMigrateSequencesNamingCommand(this);
			},
		});

		this.addCommand({
			id: "compile-manuscript",
			name: "Compile manuscript",
			callback: () => {
				void runCompileManuscriptCommand(this);
			},
		});

		this.addCommand({
			id: "open-treatment-view",
			name: "Open outline view",
			callback: () => {
				void activateOutlineView(this);
			},
		});

		this.addCommand({
			id: "open-character-matrix",
			name: "Open character matrix",
			callback: () => {
				void activateCharacterMatrixView(this);
			},
		});

		this.addCommand({
			id: "open-beat-sheet",
			name: "Open beat sheet",
			callback: () => {
				void activateBeatSheetView(this);
			},
		});

		this.addCommand({
			id: "apply-beat-template",
			name: "Apply beat template…",
			callback: () => {
				void runApplyBeatTemplateCommand(this);
			},
		});

		this.addCommand({
			id: "clear-beat-sheet",
			name: "Clear beat sheet",
			callback: () => {
				void runClearBeatSheetCommand(this);
			},
		});

		this.addCommand({
			id: "assign-scene-to-beat",
			name: "Assign sequence to beat…",
			callback: () => {
				void runAssignSceneToBeatCommand(this);
			},
		});

		this.addCommand({
			id: "split-scene-at-cursor",
			name: "Split sequence at cursor",
			editorCallback: (editor) => {
				void runSplitSceneCommand(this, editor);
			},
		});

		this.addCommand({
			id: "merge-scene-with",
			name: "Merge sequence with…",
			callback: () => {
				void runMergeSceneCommand(this);
			},
		});

		this.addCommand({
			id: "atomize-sequence",
			name: "Atomize sequence into scenes",
			callback: () => {
				void runAtomizeSequenceCommand(this);
			},
		});

		this.addCommand({
			id: "update-sequence-from-scenes",
			name: "Update sequence from scenes",
			callback: () => {
				void runUpdateSequenceCommand(this);
			},
		});

		this.addCommand({
			id: "migrate-stable-ids",
			name: "Migrate sequences to stable IDs",
			callback: () => {
				void runMigrateStableIdsCommand(this);
			},
		});

		this.addCommand({
			id: "create-outline",
			name: "Create treatment",
			callback: () => {
				void runCreateTreatmentCommand(this);
			},
		});

		this.addCommand({
			id: "create-new-scene",
			name: "Create new sequence",
			callback: () => {
				void runCreateNewSceneCommand(this);
			},
		});

		this.addCommand({
			id: "promote-outline",
			name: "Make sequences from treatment",
			callback: () => {
				void runPromoteTreatmentCommand(this);
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
			id: "create-character",
			name: "Create character",
			callback: () => {
				void runCreateCharacterCommand(this);
			},
		});

		this.addCommand({
			id: "create-location",
			name: "Create location",
			callback: () => {
				void runCreateLocationCommand(this);
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
			name: "Insert character",
			callback: () => {
				runInsertCharacterCueCommand(this);
			},
		});

		this.addCommand({
			id: "insert-location-reference",
			name: "Insert location",
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
			id: "tag-selection-as-alias",
			name: "Tag selection as alias of…",
			editorCallback: (editor) => {
				runTagSelectionAsAliasCommand(this, editor);
			},
		});

		this.addCommand({
			id: "audit-alias-collisions",
			name: "Audit alias collisions",
			callback: () => {
				runAuditAliasesCommand(this);
			},
		});

		this.addCommand({
			id: "tag-selection-as-group",
			name: "Tag selection as group…",
			editorCallback: (editor) => {
				runTagSelectionAsGroupCommand(this, editor);
			},
		});

		this.addCommand({
			id: "sync-screenplay-scenes",
			name: "Sync screenplay sequences to project",
			callback: () => {
				void runSyncScreenplaySequencesCommand(this);
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
			id: "toggle-project-lock",
			name: "Lock to active project",
			callback: () => {
				toggleProjectLock(this);
			},
		});

		this.addCommand({
			id: "sync-sluglines-to-fountain",
			name: "Sync sluglines from dev note to fountain",
			callback: () => {
				void runSyncSluglinesCommand(this);
			},
		});

		this.addCommand({
			id: "sync-sluglines-to-devnote",
			name: "Sync sluglines from fountain to dev note",
			callback: () => {
				void runSyncSluglinesToDevNoteCommand(this);
			},
		});

		this.addCommand({
			id: "cleanup-sluglines",
			name: "Clean up sluglines",
			callback: () => {
				void runCleanupSluglinesCommand(this);
			},
		});

		this.addCommand({
			id: "sync-characters-from-fountain",
			name: "Sync characters from sequence to dev note",
			callback: () => {
				void runSyncCharactersCommand(this);
			},
		});

		this.addCommand({
			id: "sync-characters-from-prose",
			name: "Sync characters from dev note prose",
			callback: () => {
				void runSyncCharactersFromProseCommand(this);
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
				menu.addItem((item) =>
					item
						.setTitle("Tag selection as alias of…")
						.setIcon("tag")
						.onClick(() => runTagSelectionAsAliasCommand(this, editor)),
				);
				menu.addItem((item) =>
					item
						.setTitle("Tag selection as group…")
						.setIcon("users")
						.onClick(() => runTagSelectionAsGroupCommand(this, editor)),
				);
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			this.scanner.scanAll();
			void this.dropOrphanedTvOverrides();
			this.applyFountainPluginMode();
		});
	}

	// One-time cleanup: project-settings used to be stored per tv-episode and
	// per-season, which never aligned with how a series actually works (every
	// episode inherits the show's structure). The new model keys settings by
	// the series Index for any TV project. Existing per-episode/season
	// overrides become inert orphans — we delete them on load so data.json
	// doesn't accumulate cruft. Settings on actual series, features, and
	// standalone projects are untouched.
	private async dropOrphanedTvOverrides(): Promise<void> {
		let removed = 0;
		for (const key of Object.keys(this.settings.projects)) {
			const project = this.scanner.projects.get(key);
			if (!project) continue;
			if (project.projectType === "tv-episode" || project.projectType === "season") {
				delete this.settings.projects[key];
				removed++;
			}
		}
		if (removed > 0) {
			await this.saveSettings();
			if (this.settings.global.debugLogging) {
				console.debug(`[FirstDraft] Dropped ${removed} orphan TV episode/season override(s).`);
			}
		}
	}

	onunload(): void {
		// Strip First Draft Mode body classes + project-lock styles so they
		// don't leak when the plugin is disabled. Listeners, commands, and
		// views clean up automatically.
		exitFirstDraftModeSync(this);
		clearProjectLockOnUnload();
	}

	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<FirstDraftSettings> | null;
		this.settings = mergeSettings(loaded, DEFAULT_SETTINGS);
		// First Draft Mode is session-only — reset transient fields on load.
		this.settings.global.firstDraftMode.active = false;
		this.settings.global.firstDraftMode.savedLayout = null;
		// Legacy installs may have stored delimiter values that don't match
		// any of the current presets (e.g. the bare "-" produced by the
		// pre-fix trim bug). Coerce on load so the dropdown's setValue
		// always finds a matching option.
		this.settings.global.sluglineSubLocationDelimiter =
			normaliseDelimiterValue(this.settings.global.sluglineSubLocationDelimiter);
		for (const override of Object.values(this.settings.projects)) {
			if (override.sluglineSubLocationDelimiter !== undefined) {
				override.sluglineSubLocationDelimiter = normaliseDelimiterValue(
					override.sluglineSubLocationDelimiter,
				);
			}
		}
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
