import { TFile } from "obsidian";
import type FirstDraftPlugin from "../main";

// Centralised event wiring. Listeners are attached via plugin.registerEvent so they
// detach automatically on unload. Phase 2/6 hook implementations live here as stubs.

export function registerEventHandlers(plugin: FirstDraftPlugin): void {
	const { app, scanner } = plugin;

	plugin.registerEvent(
		app.metadataCache.on("changed", (file) => {
			if (file instanceof TFile) scanner.updateFile(file);
		}),
	);

	plugin.registerEvent(
		app.vault.on("delete", (file) => {
			scanner.removeFile(file.path);
		}),
	);

	plugin.registerEvent(
		app.vault.on("rename", (file, oldPath) => {
			// Phase 1: keep the scanner map consistent when an index file moves.
			// Phase 6: also rename the matching dev note when a .fountain file moves.
			if (file instanceof TFile) scanner.handleRename(file, oldPath);
		}),
	);

	plugin.registerEvent(
		app.workspace.on("active-leaf-change", () => {
			// Phase 2: update the dev notes panel for the new active leaf.
		}),
	);

	plugin.registerEvent(
		app.vault.on("create", () => {
			// Phase 2: respond to new dev notes / scenes.
			// Note: 'changed' covers new files for scanner purposes, so this stays a no-op.
		}),
	);
}
