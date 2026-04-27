import { Notice, Plugin } from "obsidian";
import type { FirstDraftSettings } from "./types";
import { DEFAULT_SETTINGS } from "./settings/defaults";
import { mergeSettings } from "./settings/merge";
import { FirstDraftSettingTab } from "./settings/settings-tab";
import { ProjectScanner } from "./projects/scanner";
import { resolveActiveProject } from "./projects/resolver";
import { registerEventHandlers } from "./events/register";

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

		this.addSettingTab(new FirstDraftSettingTab(this.app, this));
		registerEventHandlers(this);
		this.registerDebugCommands();

		this.app.workspace.onLayoutReady(() => this.scanner.scanAll());
	}

	onunload(): void {
		// Listeners and commands registered via the plugin API clean up automatically.
	}

	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<FirstDraftSettings> | null;
		this.settings = mergeSettings(loaded, DEFAULT_SETTINGS);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// Phase 1 verification helpers — removed when Phase 2 ships its own panel.
	private registerDebugCommands(): void {
		this.addCommand({
			id: "debug-log-projects",
			name: "Debug: log detected projects",
			callback: () => {
				const rows = [...this.scanner.projects.values()];
				console.debug(`[FirstDraft] ${rows.length} project(s) detected:`, rows);
				new Notice(`FirstDraft: ${rows.length} project(s) — see console.`);
			},
		});

		this.addCommand({
			id: "debug-log-active-project",
			name: "Debug: log active project",
			callback: () => {
				const file = this.app.workspace.getActiveFile();
				const meta = resolveActiveProject(file, this.scanner);
				console.debug("[FirstDraft] Active file:", file?.path ?? "(none)");
				console.debug("[FirstDraft] Resolved project:", meta);
				new Notice(
					meta
						? `FirstDraft: project "${meta.title ?? meta.indexFilePath}"`
						: "FirstDraft: no project for active file.",
				);
			},
		});
	}
}
