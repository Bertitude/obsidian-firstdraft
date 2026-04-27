import { Notice, TFile, TFolder } from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "../projects/resolver";
import { readScenesArray, writeScenesArray } from "./scenes-array";

// One-shot reconciliation between the project's screenplay folder and Longform's
// scenes: array. Useful when scene files were created or renamed outside the
// auto-add path (e.g. the user moved files manually, or they pre-existed before
// FirstDraft started auto-adding on Create scene file). For each .fountain file
// in the configured sceneFolder, add the basename to scenes: if not already
// present. Existing entries are left untouched (preserves user-defined ordering).

export async function runSyncScreenplayScenesCommand(plugin: FirstDraftPlugin): Promise<void> {
	const activeFile = plugin.app.workspace.getActiveFile();
	const project = activeFile ? resolveActiveProject(activeFile, plugin.scanner) : null;
	if (!project) {
		new Notice("Open a file inside a project first.");
		return;
	}

	const folder = plugin.app.vault.getAbstractFileByPath(project.sceneFolderPath);
	if (!(folder instanceof TFolder)) {
		new Notice(`Scene folder not found: ${project.sceneFolderPath}`);
		return;
	}

	const existing = readScenesArray(plugin.app, project.indexFilePath);
	const existingSet = new Set(existing);

	const toAdd: string[] = [];
	for (const child of folder.children) {
		if (!(child instanceof TFile)) continue;
		if (child.extension !== "fountain") continue;
		if (existingSet.has(child.basename)) continue;
		toAdd.push(child.basename);
	}

	if (toAdd.length === 0) {
		new Notice("Scenes array is already up to date.");
		return;
	}

	toAdd.sort((a, b) => a.localeCompare(b));
	const next = [...existing, ...toAdd];

	try {
		await writeScenesArray(plugin.app, project.indexFilePath, next);
		new Notice(`Added ${toAdd.length} scene(s) to the project.`);
	} catch (e) {
		new Notice(`Sync failed: ${(e as Error).message}`);
	}
}
