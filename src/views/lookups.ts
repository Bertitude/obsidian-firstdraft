import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { GlobalConfig, ProjectMeta } from "../types";

// Folder/file lookups for the dev-notes panel. Phase 5 will extend the GlobalConfig
// argument with per-project overrides; the call sites stay the same.

export interface DevNoteRef {
	path: string;
	file: TFile | null; // null if the note hasn't been created yet
}

export interface ScenePair {
	sceneName: string; // shared basename
	fountainPath: string;
	fountainFile: TFile | null;
	devNotePath: string;
	devNoteFile: TFile | null;
	activeMode: "fountain" | "dev-note"; // which side the user has open
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

// Given any active file inside a project, return the matching pair of fountain +
// dev note paths/files (whichever side exists). Returns null if the file is not a
// recognised scene fountain or scene dev note.
export function scenePairFromActive(
	app: App,
	active: TFile,
	project: ProjectMeta,
	cfg: GlobalConfig,
): ScenePair | null {
	const devScenesPath = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.scenesSubfolder}`,
	);
	const fountainFolderPath = project.sceneFolderPath;

	let mode: "fountain" | "dev-note" | null = null;
	if (active.extension === "fountain" && active.path.startsWith(fountainFolderPath + "/")) {
		mode = "fountain";
	} else if (
		active.extension === "md" &&
		active.path.startsWith(devScenesPath + "/")
	) {
		mode = "dev-note";
	}
	if (!mode) return null;

	const sceneName = active.basename;
	const fountainPath = normalizePath(`${fountainFolderPath}/${sceneName}.fountain`);
	const devNotePath = normalizePath(`${devScenesPath}/${sceneName}.md`);

	return {
		sceneName,
		fountainPath,
		fountainFile: lookupFile(app.vault as unknown, fountainPath),
		devNotePath,
		devNoteFile: lookupFile(app.vault as unknown, devNotePath),
		activeMode: mode,
	};
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

// ── Autocomplete roster (Phase 4) ────────────────────────────────────────

export interface AutocompleteRosterEntry {
	name: string; // uppercase form, used for matching and cue insertion
	folderCasing: string | null; // folder basename if exists, else null
}

const SCENE_HEADING_RE_FOR_CUES = /^(INT|EXT|INT\.\/EXT|I\/E)[.\s]/i;
const CUE_LINE_RE = /^[A-Z][A-Z\s]*$/;

// Parse character cues out of a fountain document. A cue is an uppercase line
// preceded by a blank line (or the start of file), excluding scene headings.
// Parenthetical extensions like "(V.O.)" are stripped before the uppercase check.
export function parseCharacterCues(fountain: string): string[] {
	const out: string[] = [];
	const lines = fountain.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		const line = raw.trim();
		if (line === "") continue;
		if (SCENE_HEADING_RE_FOR_CUES.test(line)) continue;

		const prevIsBlank = i === 0 || (lines[i - 1] ?? "").trim() === "";
		if (!prevIsBlank) continue;

		const cue = line.split("(")[0]?.trim() ?? line;
		if (cue === "" || !CUE_LINE_RE.test(cue)) continue;
		out.push(cue);
	}
	return out;
}

// Combine three roster sources into a single deduplicated list:
//   1. Character folders in Development/Characters/
//   2. Names already in the active scene dev note's `characters:` array
//   3. Cues parsed from every .fountain file in project.sceneFolderPath
//
// Folder-derived entries provide canonical casing; the other sources contribute
// names with `folderCasing: null`. Caller passes a cache keyed by file path so
// repeated suggestion lookups don't re-read every fountain on each keystroke.
//
// excludePath: optional file path to skip during cue parsing. Used by the
// autocomplete and picker when the user is typing in a fountain file — their
// in-progress (auto-saved) cue text shouldn't suggest itself as a roster
// member, otherwise the "Create new" entry never appears.
export async function buildExpandedRoster(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
	devNoteFile: TFile | null,
	cueCache: Map<string, string[]>,
	excludePath?: string,
): Promise<AutocompleteRosterEntry[]> {
	const map = new Map<string, AutocompleteRosterEntry>();

	for (const entry of characterRoster(app, project, cfg)) {
		map.set(entry.name, { name: entry.name, folderCasing: entry.folderName });
	}

	if (devNoteFile) {
		const fm = app.metadataCache.getFileCache(devNoteFile)?.frontmatter as
			| Record<string, unknown>
			| undefined;
		const chars = Array.isArray(fm?.characters) ? (fm?.characters as unknown[]) : [];
		for (const raw of chars) {
			if (typeof raw !== "string") continue;
			const key = raw.trim().toUpperCase();
			if (key === "" || map.has(key)) continue;
			map.set(key, { name: key, folderCasing: null });
		}
	}

	const fountainFolder = app.vault.getAbstractFileByPath(project.sceneFolderPath);
	if (fountainFolder instanceof TFolder) {
		for (const child of fountainFolder.children) {
			if (!(child instanceof TFile) || child.extension !== "fountain") continue;
			if (excludePath && child.path === excludePath) continue;
			let cues = cueCache.get(child.path);
			if (!cues) {
				const text = await app.vault.cachedRead(child);
				cues = parseCharacterCues(text);
				cueCache.set(child.path, cues);
			}
			for (const cue of cues) {
				const key = cue.toUpperCase();
				if (map.has(key)) continue;
				map.set(key, { name: key, folderCasing: null });
			}
		}
	}

	return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}
