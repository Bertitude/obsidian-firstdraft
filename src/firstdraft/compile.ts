import { Notice, TFile, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "../projects/resolver";
import { readScenesArray } from "../longform/scenes-array";
import { fountainPathCandidates, sceneNameFromArrayEntry } from "../fountain/file-detection";

// FirstDraft compile. Concatenates each fountain in the project's `scenes:`
// order into a single Manuscript.md at the project root. Replaces the
// dependency on Longform's compile feature.
//
// Output format mirrors what Longform emits: each fountain's content is
// appended in order, separated by blank lines. The file is overwritten on
// each compile (snapshot-aware via the existing Browse file versions path,
// since we snapshot the manuscript before writing).
//
// Skips entries whose fountain file isn't found (notice with count).

const MANUSCRIPT_FILENAME = "Manuscript.md";

export async function runCompileManuscriptCommand(
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

	const scenes = readScenesArray(plugin.app, project.indexFilePath);
	if (scenes.length === 0) {
		new Notice("Project has no scenes to compile.");
		return;
	}

	const parts: string[] = [];
	let included = 0;
	let missing = 0;

	for (const entry of scenes) {
		const file = findFountainForEntry(plugin, project.sequenceFolderPath, entry);
		if (!file) {
			missing += 1;
			continue;
		}
		const content = await plugin.app.vault.read(file);
		parts.push(content.replace(/\s+$/, ""));
		included += 1;
	}

	if (included === 0) {
		new Notice("No fountain files found for this project's scenes.");
		return;
	}

	const manuscript = parts.join("\n\n") + "\n";
	const manuscriptPath = normalizePath(`${project.projectRootPath}/${MANUSCRIPT_FILENAME}`);
	await writeOrCreate(plugin, manuscriptPath, manuscript);

	const tail = missing > 0 ? ` ${missing} entr${missing === 1 ? "y" : "ies"} skipped (no fountain found).` : "";
	new Notice(
		`Compiled ${included} scene${included === 1 ? "" : "s"} → ${MANUSCRIPT_FILENAME}.${tail}`,
		6000,
	);
}

function findFountainForEntry(
	plugin: FirstDraftPlugin,
	sequenceFolderPath: string,
	entry: string,
): TFile | null {
	for (const candidate of fountainPathCandidates(sequenceFolderPath, entry)) {
		const path = normalizePath(candidate);
		const f = plugin.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) return f;
	}
	// Fallback: try the bare scene name with both extensions in case the entry
	// shape doesn't match expectations.
	const sequenceName = sceneNameFromArrayEntry(entry);
	for (const ext of [".fountain.md", ".fountain"]) {
		const path = normalizePath(`${sequenceFolderPath}/${sequenceName}${ext}`);
		const f = plugin.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) return f;
	}
	return null;
}

async function writeOrCreate(
	plugin: FirstDraftPlugin,
	path: string,
	content: string,
): Promise<void> {
	const existing = plugin.app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await plugin.app.vault.modify(existing, content);
		return;
	}
	await plugin.app.vault.create(path, content);
}
