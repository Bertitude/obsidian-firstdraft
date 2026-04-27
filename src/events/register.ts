import { TFile } from "obsidian";
import type FirstDraftPlugin from "../main";
import { getDevNotesView } from "../views/dev-notes-view";

// Centralised event wiring. Listeners are attached via plugin.registerEvent so they
// detach automatically on unload.

export function registerEventHandlers(plugin: FirstDraftPlugin): void {
	const { app, scanner } = plugin;

	plugin.registerEvent(
		app.metadataCache.on("changed", (file) => {
			if (!(file instanceof TFile)) return;
			scanner.updateFile(file);

			// Re-render the panel if the changed file is the dev note (or scene file)
			// the panel is currently displaying — keeps the inline content live.
			const view = getDevNotesView(plugin);
			if (!view) return;
			const active = app.workspace.getActiveFile();
			if (file.path === view.getCurrentDevNotePath() || file.path === active?.path) {
				void view.refresh();
			}
		}),
	);

	plugin.registerEvent(
		app.vault.on("delete", (file) => {
			scanner.removeFile(file.path);
			const view = getDevNotesView(plugin);
			if (view && file.path === view.getCurrentDevNotePath()) void view.refresh();
		}),
	);

	plugin.registerEvent(
		app.vault.on("rename", (file, oldPath) => {
			// Phase 1: keep the scanner map consistent when an index file moves.
			// Phase 6: also rename the matching dev note when a .fountain file moves.
			if (file instanceof TFile) scanner.handleRename(file, oldPath);
			void getDevNotesView(plugin)?.refresh();
		}),
	);

	plugin.registerEvent(
		app.workspace.on("active-leaf-change", () => {
			void getDevNotesView(plugin)?.refresh();
		}),
	);

	plugin.registerEvent(
		app.vault.on("create", (file) => {
			// If the user just created a scene dev note via the panel button, refresh
			// to pick it up immediately. (For other files, 'changed' will cover us.)
			const view = getDevNotesView(plugin);
			if (view && file.path === view.getCurrentDevNotePath()) void view.refresh();
		}),
	);
}
