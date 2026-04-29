import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta, GlobalConfig } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { sanitizeFilename } from "../utils/sanitize";
import { promptForLabel } from "../versioning/prompt";

// "Add note" — creates a new markdown note in the contextually appropriate
// Notes folder for the active file. The placement rule:
//
//   target = <parent folder of active file>/<cfg.notesSubfolder>/
//
// With two adjustments:
//
//   1. If the active file is at the project root (e.g. Index.md), fall back
//      to <Project>/<developmentFolder>/<notesSubfolder>/ — the user said
//      they don't want a Notes folder at the project root.
//   2. If the active file is inside the screenplay folder (the fountain
//      sequence folder, project.sequenceFolderPath), route to the dev-side
//      counterpart: <Project>/Development/<sequencesSubfolder>/Notes/. Notes
//      are dev/planning material; the screenplay folder stays clean.
//
// Prompts for a title (default Untitled YYYY-MM-DD), creates the folder
// chain if missing, opens the new file. Empty body — no template baggage.

export async function runCreateProjectNoteCommand(
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

	const targetFolder = computeTargetNotesFolder(active, project, cfg);

	const title = await promptForTitle(plugin.app, cfg.filenameReplacementChar);
	if (!title) return;

	await ensureFolderExists(plugin.app, targetFolder);

	const filename = `${title}.md`;
	const path = normalizePath(`${targetFolder}/${filename}`);
	if (plugin.app.vault.getAbstractFileByPath(path)) {
		new Notice(`A note named "${title}" already exists in ${targetFolder}.`);
		return;
	}

	const created = await plugin.app.vault.create(path, "");
	await plugin.app.workspace.getLeaf(false).openFile(created);
	new Notice(`Created note in ${displayFolder(project, targetFolder)}.`);
}

// Exposed for the view's Add-note button so it can show the user where the
// note will land before they confirm. (The button could also call
// runCreateProjectNoteCommand directly; this exists for inspection.)
export function computeTargetNotesFolder(
	activeFile: TFile,
	project: ProjectMeta,
	cfg: GlobalConfig,
): string {
	const notesName = cfg.notesSubfolder;
	const parent = activeFile.parent?.path ?? "";

	// Edge case 1: file is at project root → route to Development/Notes.
	if (parent === project.projectRootPath) {
		return normalizePath(
			`${project.projectRootPath}/${cfg.developmentFolder}/${notesName}`,
		);
	}

	// Edge case 2: file is in the screenplay (fountain) folder → route to
	// the dev-side Sequences/Notes folder.
	if (parent === project.sequenceFolderPath) {
		return normalizePath(
			`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.sequencesSubfolder}/${notesName}`,
		);
	}

	// Default: sibling Notes folder inside the active file's parent.
	return normalizePath(`${parent}/${notesName}`);
}

async function promptForTitle(
	app: App,
	replacementChar: string,
): Promise<string | null> {
	const today = new Date();
	const yyyy = today.getFullYear();
	const mm = String(today.getMonth() + 1).padStart(2, "0");
	const dd = String(today.getDate()).padStart(2, "0");
	const defaultTitle = `Untitled ${yyyy}-${mm}-${dd}`;

	let candidate = defaultTitle;
	let description: string | undefined;

	while (true) {
		const name = await promptForLabel(app, {
			title: "New project note",
			description: description ?? "Title for the new note:",
			defaultValue: candidate,
		});
		if (name === null) return null;
		const sanitized = sanitizeFilename(name, replacementChar);
		if (!sanitized) {
			candidate = defaultTitle;
			description = "Name has no valid filename characters. Try another.";
			continue;
		}
		return sanitized;
	}
}

async function ensureFolderExists(app: App, path: string): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFolder) return;
	if (existing instanceof TFile) {
		throw new Error(`Path is a file, not a folder: ${path}`);
	}
	// Walk up creating any missing segments. createFolder doesn't recursive-
	// create on its own across multi-level paths in some Obsidian versions.
	const segments = path.split("/");
	let cumulative = "";
	for (const seg of segments) {
		cumulative = cumulative ? `${cumulative}/${seg}` : seg;
		const at = app.vault.getAbstractFileByPath(cumulative);
		if (at) continue;
		await app.vault.createFolder(cumulative);
	}
}

function displayFolder(project: ProjectMeta, fullPath: string): string {
	if (fullPath.startsWith(project.projectRootPath + "/")) {
		return fullPath.slice(project.projectRootPath.length + 1);
	}
	return fullPath;
}
