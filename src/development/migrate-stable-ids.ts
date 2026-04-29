import { Notice, TFile, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { buildOutlineData, type OutlineRow } from "../views/outline-data";
import {
	fountainScenesArrayEntry,
	sceneNameFromArrayEntry,
} from "../fountain/file-detection";
import { readScenesArray, writeScenesArray } from "../longform/scenes-array";
import { snapshotFile, todayLabel } from "../versioning/snapshot";
import { applyId, extractId, generateUniqueId } from "../utils/stable-id";

// Migration command: walks the active project's scenes, generates a stable
// 4-char ID for each scene that doesn't have one, renames the fountain +
// paired dev note to include the ID, writes `id:` to the dev note's
// frontmatter, and updates Longform scenes:.
//
// Idempotent — scenes that already have IDs are skipped. Snapshots all
// affected files first so the migration is reversible via Browse file
// versions.

export async function runMigrateStableIdsCommand(
	plugin: FirstDraftPlugin,
): Promise<void> {
	const active = plugin.app.workspace.getActiveFile();
	if (!active) {
		new Notice("Open a file inside a project first.");
		return;
	}
	const project = resolveActiveProject(active, plugin.scanner);
	if (!project) {
		new Notice("Active file isn't inside a recognised project.");
		return;
	}
	const cfg = resolveProjectSettings(project, plugin.settings);
	const treatment = buildOutlineData(plugin.app, project, cfg);

	// Collect scenes that need migration (no existing ID on either side).
	const candidates: OutlineRow[] = [];
	const usedIds = new Set<string>();
	for (const row of treatment.rows) {
		const fountainId = row.fountainFile ? extractId(stemOfFountain(row.fountainFile)) : null;
		const devId = row.devNoteFile ? extractId(row.devNoteFile.basename) : null;
		const id = fountainId ?? devId;
		if (id) {
			usedIds.add(id);
			continue;
		}
		candidates.push(row);
	}

	if (candidates.length === 0) {
		new Notice("All scenes in this project already have stable IDs.");
		return;
	}

	const stamp = `pre-stable-id-migrate ${todayLabel()}`;
	let renamedFountains = 0;
	let renamedDevNotes = 0;
	let updatedScenesArray = false;

	const scenesArray = readScenesArray(plugin.app, project.indexFilePath);
	const scenesArrayMutable = [...scenesArray];

	for (const row of candidates) {
		const id = generateUniqueId(usedIds);
		usedIds.add(id);

		// Snapshot original files before destructive renames.
		if (row.fountainFile) {
			await snapshotFile(plugin.app, row.fountainFile, stamp);
		}
		if (row.devNoteFile) {
			await snapshotFile(plugin.app, row.devNoteFile, stamp);
		}

		const oldSceneName = row.sequenceName;
		const newSceneName = applyId(oldSceneName, id);

		// Rename fountain (if present). Filename pattern preserves the existing
		// fountain format (.fountain or .fountain.md).
		if (row.fountainFile) {
			const folder = parentPath(row.fountainFile.path);
			const newPath = normalizePath(
				`${folder}/${newFountainFilename(row.fountainFile, newSceneName)}`,
			);
			await plugin.app.fileManager.renameFile(row.fountainFile, newPath);
			renamedFountains += 1;
		}

		// Rename dev note + write id: to its frontmatter.
		if (row.devNoteFile) {
			const folder = parentPath(row.devNoteFile.path);
			const newDevPath = normalizePath(`${folder}/${newSceneName}.md`);
			await plugin.app.fileManager.renameFile(row.devNoteFile, newDevPath);
			// Re-resolve the file at the new path; renameFile mutates the
			// original TFile but using a fresh lookup is safer.
			const renamedDev = plugin.app.vault.getAbstractFileByPath(newDevPath);
			if (renamedDev instanceof TFile) {
				await plugin.app.fileManager.processFrontMatter(
					renamedDev,
					(fm: Record<string, unknown>) => {
						fm.id = id;
					},
				);
			}
			renamedDevNotes += 1;
		}

		// Update Longform scenes: array entry. Match by either format.
		for (let i = 0; i < scenesArrayMutable.length; i++) {
			const entry = scenesArrayMutable[i];
			if (entry === undefined) continue;
			const entrySceneName = sceneNameFromArrayEntry(entry);
			if (entrySceneName !== oldSceneName) continue;
			// Rebuild entry with the new scene name + same format suffix.
			const entryHasFountainSuffix = entry.endsWith(".fountain");
			scenesArrayMutable[i] = entryHasFountainSuffix
				? fountainScenesArrayEntry(newSceneName, "fountain-md")
				: fountainScenesArrayEntry(newSceneName, "fountain");
			updatedScenesArray = true;
			break;
		}
	}

	if (updatedScenesArray) {
		await writeScenesArray(plugin.app, project.indexFilePath, scenesArrayMutable);
	}

	new Notice(
		`Migrated ${candidates.length} scene${candidates.length === 1 ? "" : "s"} to stable IDs (${renamedFountains} fountain${renamedFountains === 1 ? "" : "s"}, ${renamedDevNotes} dev note${renamedDevNotes === 1 ? "" : "s"}).`,
		8000,
	);
}

function stemOfFountain(file: TFile): string {
	if (file.extension === "fountain") return file.basename;
	if (file.extension === "md" && file.basename.endsWith(".fountain")) {
		return file.basename.slice(0, -".fountain".length);
	}
	return file.basename;
}

function newFountainFilename(file: TFile, newStem: string): string {
	if (file.extension === "fountain") return `${newStem}.fountain`;
	// .fountain.md format: extension is "md", basename ends with ".fountain"
	return `${newStem}.fountain.md`;
}

function parentPath(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i);
}
