import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { GlobalConfig, ProjectMeta } from "../types";

// Folder/file lookups for the dev-notes panel. Phase 5 will extend the GlobalConfig
// argument with per-project overrides; the call sites stay the same.

export interface DevNoteRef {
	path: string;
	file: TFile | null; // null if the note hasn't been created yet
}

export interface CharacterEntry {
	name: string; // display name as used in fountain cues (uppercase)
	folderName: string; // original folder casing
	folder: TFolder;
	canonicalFile: TFile | null;
}

export interface LocationEntry {
	name: string;
	folderName: string;
	folder: TFolder;
	canonicalFile: TFile | null;
}

// Scene dev note path = projectRoot/Development/Scenes/<sceneBasename>.md
export function sceneDevNotePath(
	scene: TFile,
	project: ProjectMeta,
	cfg: GlobalConfig,
): DevNoteRef {
	const path = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.scenesSubfolder}/${scene.basename}.md`,
	);
	return { path, file: lookupFile(scene.vault as unknown, path) };
}

// Roster of characters for a project. For TV episodes, episode-level characters
// shadow series-level characters of the same name (case-insensitive).
export function characterRoster(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
): CharacterEntry[] {
	const seen = new Set<string>();
	const out: CharacterEntry[] = [];

	const episodeFolder = devSubfolder(app, project.projectRootPath, cfg.developmentFolder, cfg.charactersSubfolder);
	collectFolders(episodeFolder, (folder) => {
		const key = folder.name.toUpperCase();
		if (seen.has(key)) return;
		seen.add(key);
		out.push(makeCharacterEntry(app, folder));
	});

	if (project.seriesDevelopmentPath) {
		const seriesFolder = devSubfolder(app, project.seriesDevelopmentPath, "", cfg.charactersSubfolder);
		collectFolders(seriesFolder, (folder) => {
			const key = folder.name.toUpperCase();
			if (seen.has(key)) return;
			seen.add(key);
			out.push(makeCharacterEntry(app, folder));
		});
	}

	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

// Look up a single character by name (case-insensitive) within the project's roster.
export function findCharacter(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
	name: string,
): CharacterEntry | null {
	const target = name.trim().toUpperCase();
	if (!target) return null;
	for (const entry of characterRoster(app, project, cfg)) {
		if (entry.name === target) return entry;
	}
	return null;
}

// Look up a location by folder name (case-insensitive). Episode-level only — locations
// rarely span the whole series the way characters do, and the spec keeps location
// folders at episode level for TV.
export function findLocation(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
	name: string,
): LocationEntry | null {
	const target = name.trim().toUpperCase();
	if (!target) return null;

	const folder = devSubfolder(app, project.projectRootPath, cfg.developmentFolder, cfg.locationsSubfolder);
	if (!folder) return null;

	for (const child of folder.children) {
		if (child instanceof TFolder && child.name.toUpperCase() === target) {
			return {
				name: target,
				folderName: child.name,
				folder: child,
				canonicalFile: canonicalFileInside(child),
			};
		}
	}
	return null;
}

// ── internals ────────────────────────────────────────────────────────────

function devSubfolder(
	app: App,
	rootPath: string,
	developmentFolder: string,
	subfolder: string,
): TFolder | null {
	const segments = [rootPath, developmentFolder, subfolder].filter((s) => s !== "");
	const path = normalizePath(segments.join("/"));
	const f = app.vault.getAbstractFileByPath(path);
	return f instanceof TFolder ? f : null;
}

function collectFolders(parent: TFolder | null, visit: (folder: TFolder) => void): void {
	if (!parent) return;
	for (const child of parent.children) {
		if (child instanceof TFolder) visit(child);
	}
}

function makeCharacterEntry(_app: App, folder: TFolder): CharacterEntry {
	return {
		name: folder.name.toUpperCase(),
		folderName: folder.name,
		folder,
		canonicalFile: canonicalFileInside(folder),
	};
}

// Canonical doc convention: a folder named "Marcus" contains "Marcus.md" as its
// canonical document. Falls back to the first .md child if the convention isn't met.
function canonicalFileInside(folder: TFolder): TFile | null {
	const expectedName = `${folder.name}.md`;
	let fallback: TFile | null = null;
	for (const child of folder.children) {
		if (!(child instanceof TFile)) continue;
		if (child.name === expectedName) return child;
		if (child.extension === "md" && !fallback) fallback = child;
	}
	return fallback;
}

// Tiny shim so the helper above doesn't need the App passed everywhere — TFile carries
// a reference to its vault. Kept generic to avoid coupling.
function lookupFile(vaultLike: unknown, path: string): TFile | null {
	const v = vaultLike as { getAbstractFileByPath?: (p: string) => unknown };
	const f = v.getAbstractFileByPath?.(path);
	return f instanceof TFile ? f : null;
}
