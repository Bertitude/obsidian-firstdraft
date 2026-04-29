import { TFile } from "obsidian";
import type FirstDraftPlugin from "../main";
import { getDevNotesView } from "../views/dev-notes-view";
import { getTreatmentView } from "../views/treatment-view";
import { getCharacterMatrixView } from "../views/character-matrix-view";

// Centralised event wiring. Listeners are attached via plugin.registerEvent so they
// detach automatically on unload.

export function registerEventHandlers(plugin: FirstDraftPlugin): void {
	const { app, scanner } = plugin;

	plugin.registerEvent(
		app.metadataCache.on("changed", (file) => {
			if (!(file instanceof TFile)) return;
			scanner.updateFile(file);

			// Re-render the dev notes panel if the changed file is the dev note (or
			// scene file) it's currently displaying — keeps the inline content live.
			const dev = getDevNotesView(plugin);
			if (dev) {
				const active = app.workspace.getActiveFile();
				if (file.path === dev.getCurrentDevNotePath() || file.path === active?.path) {
					void dev.refresh();
				}
			}

			// Treatment view: any frontmatter change to a dev note in the active
			// project's scenes folder, or to the project's Index.md, can affect the
			// list. Cheap to just rebuild.
			void getTreatmentView(plugin)?.refresh();
			void getCharacterMatrixView(plugin)?.refresh();
		}),
	);

	plugin.registerEvent(
		app.vault.on("delete", (file) => {
			scanner.removeFile(file.path);
			const dev = getDevNotesView(plugin);
			if (dev && file.path === dev.getCurrentDevNotePath()) void dev.refresh();
			void getTreatmentView(plugin)?.refresh();
			void getCharacterMatrixView(plugin)?.refresh();
		}),
	);

	plugin.registerEvent(
		app.vault.on("rename", (file, oldPath) => {
			if (file instanceof TFile) {
				scanner.handleRename(file, oldPath);
				// Migrate per-project settings overrides when an index file is
				// renamed, so user-set overrides survive.
				const override = plugin.settings.projects[oldPath];
				if (override !== undefined) {
					delete plugin.settings.projects[oldPath];
					plugin.settings.projects[file.path] = override;
					void plugin.saveSettings();
				}
			}
			void getDevNotesView(plugin)?.refresh();
			void getTreatmentView(plugin)?.refresh();
			void getCharacterMatrixView(plugin)?.refresh();
		}),
	);

	plugin.registerEvent(
		app.workspace.on("active-leaf-change", () => {
			void getDevNotesView(plugin)?.refresh();
			void getTreatmentView(plugin)?.refresh();
			void getCharacterMatrixView(plugin)?.refresh();
		}),
	);

	plugin.registerEvent(
		app.vault.on("create", (file) => {
			const dev = getDevNotesView(plugin);
			if (dev && file.path === dev.getCurrentDevNotePath()) void dev.refresh();
			void getTreatmentView(plugin)?.refresh();
			void getCharacterMatrixView(plugin)?.refresh();
		}),
	);
}
