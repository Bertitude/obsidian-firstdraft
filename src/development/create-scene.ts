import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { sanitizeFilename } from "../utils/sanitize";
import { applyId, generateId } from "../utils/stable-id";
import { promptForLabel } from "../versioning/prompt";
import { appendSceneToArray } from "../longform/scenes-array";
import { fountainScenesArrayEntry } from "../fountain/file-detection";

// Create a fresh dev note for a new scene. Dev-note-first workflow: this
// creates only the dev note; the paired fountain comes later via the
// "Create scene file" button in the dev notes panel.
//
// Auto-generates a stable ID; dev note filename and `id:` frontmatter both
// carry it. The scene is added to the project's sequences: array immediately
// so it's part of the project from the moment it's created — not just when
// the fountain side is later authored. Rename-sync's auto-inject on fountain
// create stays idempotent (no-op if entry already exists).

export async function runCreateNewSceneCommand(
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

	const userTypedName = await promptForNewSceneName(plugin, project, cfg);
	if (!userTypedName) return;

	const id = generateId();
	const sequenceName = applyId(userTypedName, id);

	const scenesFolderPath = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.sequencesSubfolder}`,
	);
	await ensureFolderExists(plugin.app, scenesFolderPath);

	const devNotePath = normalizePath(`${scenesFolderPath}/${sequenceName}.md`);
	if (plugin.app.vault.getAbstractFileByPath(devNotePath)) {
		new Notice(`A dev note named "${sequenceName}" already exists.`);
		return;
	}

	const created = await plugin.app.vault.create(devNotePath, cfg.sceneNoteTemplate);
	await plugin.app.fileManager.processFrontMatter(
		created,
		(fm: Record<string, unknown>) => {
			fm.id = id;
		},
	);
	const arrayEntry = fountainScenesArrayEntry(sequenceName, cfg.fountainFileFormat);
	await appendSceneToArray(plugin.app, project.indexFilePath, arrayEntry);
	await plugin.app.workspace.getLeaf(false).openFile(created);
	new Notice(`Created sequence "${userTypedName}".`);
}

async function promptForNewSceneName(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	cfg: { filenameReplacementChar: string },
): Promise<string | null> {
	let candidate = "New Sequence";
	let description: string | undefined;

	while (true) {
		const name = await promptForLabel(plugin.app, {
			title: "Create new sequence",
			description: description ?? "Working title for the new sequence:",
			defaultValue: candidate,
		});
		if (name === null) return null;
		const sanitized = sanitizeFilename(name, cfg.filenameReplacementChar);
		if (!sanitized) {
			candidate = "New Sequence";
			description = "Name has no valid filename characters. Try another.";
			continue;
		}
		void project; // reserved for future cross-folder validation
		return sanitized;
	}
}

async function ensureFolderExists(app: App, path: string): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFolder) return;
	if (existing instanceof TFile) {
		throw new Error(`Path is a file, not a folder: ${path}`);
	}
	await app.vault.createFolder(path);
}
