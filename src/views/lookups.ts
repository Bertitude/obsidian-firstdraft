import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { GlobalConfig, ProjectMeta } from "../types";
import {
	devNotePathCandidates,
	fountainFilename,
	fountainSceneName,
	isFountainFile,
} from "../fountain/file-detection";

// Folder/file lookups for the dev-notes panel. Phase 5 will extend the GlobalConfig
// argument with per-project overrides; the call sites stay the same.

export interface DevNoteRef {
	path: string;
	file: TFile | null; // null if the note hasn't been created yet
}

export interface SequencePair {
	sequenceName: string; // shared basename
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
	// Phase 4g — alias and group metadata. Populated from the canonical file's
	// frontmatter at roster build time. Empty arrays / false when absent.
	aliases: string[]; // alias names as authored (preserves casing)
	isGroup: boolean; // true if frontmatter `type: group`
	groupMembers: string[]; // names of member characters (group's `members:` array)
	// Resolved role for the current project scope (main / recurring / guest).
	// Read from frontmatter `roles` map: prefer `roles.S<NN>` for the project's
	// season (when in season/episode scope), fall back to `roles.default`.
	// null when the file has no roles field at all (legacy / unclassified).
	role: string | null;
}

export interface LocationEntry {
	name: string;
	folderName: string;
	folder: TFolder;
	canonicalFile: TFile | null;
	// Resolved role: primary / recurring / one-off (or null = unclassified).
	// Same per-season fallback rule as character roles.
	role: string | null;
	// Optional parent-location reference for nested sluglines (e.g. BEDROOM
	// inside SMITH HOUSE). Stored as the parent's display name in
	// frontmatter `parent_location`. null when the location stands alone.
	parentLocation: string | null;
}

// Scene dev note path = <project>/<dev>/<sequencesSubfolder>/<sequenceName>.md
// sequenceName is the human-friendly name without fountain extension parts so
// the same dev note matches both .fountain and .fountain.md scene files.
//
// Tolerates atomized (folder-shape) sequences: the dev note may live at
// `<dev>/<sequencesSubfolder>/<name>/<name>.md` instead of the flat
// `<dev>/<sequencesSubfolder>/<name>.md`. First existing match wins.
// `path` returned is the canonical (flat) shape when neither file exists yet
// — that's where new dev notes get created by default; atomization moves
// existing flat dev notes into folder shape on its first run.
export function sequenceDevNotePath(
	scene: TFile,
	project: ProjectMeta,
	cfg: GlobalConfig,
): DevNoteRef {
	const sequenceName = fountainSceneName(scene);
	const devFolder = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.sequencesSubfolder}`,
	);
	const candidates = devNotePathCandidates(devFolder, sequenceName).map((p) =>
		normalizePath(p),
	);
	for (const candidate of candidates) {
		const file = lookupFile(scene.vault as unknown, candidate);
		if (file) return { path: candidate, file };
	}
	// No existing match — return the flat path as the default creation
	// target. Atomization promotes flat to folder when needed.
	return { path: candidates[0]!, file: null };
}

// Given any active file inside a project, return the matching pair of fountain +
// dev note paths/files (whichever side exists). Returns null if the file is not a
// recognised scene fountain or scene dev note.
//
// Handles both fountain formats (.fountain and .fountain.md) on the fountain
// side. For the dev note path, uses the human-friendly scene name (without any
// .fountain suffix) so a single dev note pairs with either format.
export function sequencePairFromActive(
	app: App,
	active: TFile,
	project: ProjectMeta,
	cfg: GlobalConfig,
): SequencePair | null {
	const devScenesPath = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.sequencesSubfolder}`,
	);
	const fountainFolderPath = project.sequenceFolderPath;

	let mode: "fountain" | "dev-note" | null = null;
	if (isFountainFile(active) && active.path.startsWith(fountainFolderPath + "/")) {
		mode = "fountain";
	} else if (
		active.extension === "md" &&
		!isFountainFile(active) &&
		active.path.startsWith(devScenesPath + "/")
	) {
		mode = "dev-note";
	}
	if (!mode) return null;

	const sequenceName = mode === "fountain" ? fountainSceneName(active) : active.basename;
	const devNotePath = normalizePath(`${devScenesPath}/${sequenceName}.md`);

	// On the fountain side, look for both formats and prefer whichever exists.
	// If neither exists, the path returned uses the configured format (the one
	// we'd create if asked).
	const fountainMdPath = normalizePath(
		`${fountainFolderPath}/${fountainFilename(sequenceName, "fountain-md")}`,
	);
	const fountainPathLegacy = normalizePath(
		`${fountainFolderPath}/${fountainFilename(sequenceName, "fountain")}`,
	);
	const fountainMdFile = lookupFile(app.vault as unknown, fountainMdPath);
	const fountainLegacyFile = lookupFile(app.vault as unknown, fountainPathLegacy);
	const fountainFile = fountainMdFile ?? fountainLegacyFile;
	const fountainPath = fountainFile
		? fountainFile.path
		: normalizePath(
				`${fountainFolderPath}/${fountainFilename(sequenceName, cfg.fountainFileFormat)}`,
			);

	return {
		sequenceName,
		fountainPath,
		fountainFile,
		devNotePath,
		devNoteFile: lookupFile(app.vault as unknown, devNotePath),
		activeMode: mode,
	};
}

// Roster of characters for a project. Each .md file inside a character folder
// becomes its own roster entry — the file matching the folder name is the
// "primary" character; other .md files are versions (e.g. YOUNG MARCUS,
// OLD MARCUS sharing the Marcus folder). For TV episodes, episode-level
// characters shadow series-level characters of the same name.
export function characterRoster(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
): CharacterEntry[] {
	const seen = new Set<string>();
	const out: CharacterEntry[] = [];

	const seasonKey = seasonKeyForProject(project);

	const collectFromFolder = (root: TFolder | null) => {
		if (!root) return;
		for (const folder of root.children) {
			if (!(folder instanceof TFolder)) continue;
			for (const file of folder.children) {
				if (!(file instanceof TFile) || file.extension !== "md") continue;
				const name = file.basename.toUpperCase();
				if (seen.has(name)) continue;
				seen.add(name);
				const fm = app.metadataCache.getFileCache(file)?.frontmatter as
					| Record<string, unknown>
					| undefined;
				out.push({
					name,
					folderName: folder.name,
					folder,
					canonicalFile: file,
					aliases: collectStringArray(fm?.aliases),
					isGroup: typeof fm?.type === "string" && fm.type.toLowerCase() === "group",
					groupMembers: collectStringArray(fm?.members),
					role: resolveRole(fm?.roles, seasonKey),
				});
			}
		}
	};

	collectFromFolder(devSubfolder(app, project.projectRootPath, cfg.developmentFolder, cfg.charactersSubfolder));

	if (project.seriesDevelopmentPath) {
		collectFromFolder(devSubfolder(app, project.seriesDevelopmentPath, "", cfg.charactersSubfolder));
	}

	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

// Roster of locations for a project. Each .md file inside a location folder
// becomes a roster entry. The file matching the folder name is the "primary"
// location; other .md files are sub-areas combined as
// "<PARENT> - <SUB>" (matching Fountain slugline format).
//
// For TV projects, also pulls from the series-level Locations/ tree (parity
// with character roster) so recurring locations created at the series root
// surface in episode/season views.
export function locationRoster(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
): LocationEntry[] {
	const out: LocationEntry[] = [];
	const seen = new Set<string>();
	const seasonKey = seasonKeyForProject(project);

	const collectFromFolder = (folder: TFolder | null) => {
		if (!folder) return;
		for (const child of folder.children) {
			if (!(child instanceof TFolder)) continue;
			const expectedPrimary = `${child.name}.md`;
			for (const file of child.children) {
				if (!(file instanceof TFile) || file.extension !== "md") continue;
				const isPrimary = file.name === expectedPrimary;
				const name = isPrimary
					? child.name.toUpperCase()
					: `${child.name.toUpperCase()} - ${file.basename.toUpperCase()}`;
				if (seen.has(name)) continue;
				seen.add(name);
				const fm = app.metadataCache.getFileCache(file)?.frontmatter as
					| Record<string, unknown>
					| undefined;
				const parentRaw = fm?.parent_location;
				out.push({
					name,
					folderName: child.name,
					folder: child,
					canonicalFile: file,
					role: resolveRole(fm?.roles, seasonKey),
					parentLocation: typeof parentRaw === "string" && parentRaw.trim() !== ""
						? parentRaw.trim()
						: null,
				});
			}
		}
	};

	collectFromFolder(devSubfolder(app, project.projectRootPath, cfg.developmentFolder, cfg.locationsSubfolder));
	if (project.seriesDevelopmentPath) {
		collectFromFolder(devSubfolder(app, project.seriesDevelopmentPath, "", cfg.locationsSubfolder));
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

// Look up a location by name (case-insensitive). Accepts both primary location
// names (e.g. "PARK") and parent-sub combined names (e.g. "MARCUS' HOUSE - LIVING ROOM").
export function findLocation(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
	name: string,
): LocationEntry | null {
	const target = name.trim().toUpperCase();
	if (!target) return null;
	for (const entry of locationRoster(app, project, cfg)) {
		if (entry.name === target) return entry;
	}
	return null;
}

// Phase 4g — Resolve a name (canonical OR alias, any casing) to the canonical
// character entry. Returns null if no match.
export function resolveCharacterByNameOrAlias(
	roster: CharacterEntry[],
	name: string,
): CharacterEntry | null {
	const target = name.trim().toUpperCase();
	if (target === "") return null;
	for (const entry of roster) {
		if (entry.name === target) return entry;
	}
	for (const entry of roster) {
		for (const alias of entry.aliases) {
			if (alias.trim().toUpperCase() === target) return entry;
		}
	}
	return null;
}

// ── role resolution ──────────────────────────────────────────────────────

// Returns the season key (e.g. "S01") relevant for a project's role-resolution
// scope. Episode and season projects both yield their own season; series and
// feature scopes yield null (use `roles.default` only).
function seasonKeyForProject(project: ProjectMeta): string | null {
	if (project.season && project.season.trim() !== "") {
		const n = parseInt(project.season, 10);
		if (!Number.isNaN(n)) return `S${String(n).padStart(2, "0")}`;
	}
	if (project.episode) {
		const m = /^s(\d+)e/i.exec(project.episode.trim());
		if (m) {
			const n = parseInt(m[1] ?? "", 10);
			if (!Number.isNaN(n)) return `S${String(n).padStart(2, "0")}`;
		}
	}
	return null;
}

// Resolve a role from a frontmatter `roles` field given the active season
// key. Order: explicit per-season override (`roles.S01`), then `roles.default`,
// then null (= unclassified). Tolerates both well-formed maps and missing/
// malformed inputs.
function resolveRole(roles: unknown, seasonKey: string | null): string | null {
	if (!roles || typeof roles !== "object" || Array.isArray(roles)) return null;
	const map = roles as Record<string, unknown>;
	if (seasonKey && typeof map[seasonKey] === "string" && map[seasonKey].toString().trim() !== "") {
		return map[seasonKey].toString().trim().toLowerCase();
	}
	if (typeof map.default === "string" && map.default.trim() !== "") {
		return map.default.trim().toLowerCase();
	}
	return null;
}

// ── internals ────────────────────────────────────────────────────────────

function collectStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	for (const item of v) {
		if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
	}
	return out;
}

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
	// Phase 4g — set when this entry is an alias (virtual roster entry that
	// resolves back to a canonical character). The folder name of the canonical
	// character. null for canonical entries.
	canonicalFolder?: string | null;
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
//   3. Cues parsed from every .fountain file in project.sequenceFolderPath
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
		// Phase 4g — emit a virtual roster entry per alias, pointing back to
		// the canonical character via canonicalFolder.
		for (const alias of entry.aliases) {
			const aliasKey = alias.trim().toUpperCase();
			if (aliasKey === "" || map.has(aliasKey)) continue;
			map.set(aliasKey, {
				name: aliasKey,
				folderCasing: alias.trim(),
				canonicalFolder: entry.folderName,
			});
		}
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

	const fountainFolder = app.vault.getAbstractFileByPath(project.sequenceFolderPath);
	if (fountainFolder instanceof TFolder) {
		for (const child of fountainFolder.children) {
			if (!(child instanceof TFile)) continue;
			if (!isFountainFile(child)) continue;
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
