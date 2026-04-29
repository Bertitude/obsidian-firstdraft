import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { GlobalConfig, ProjectMeta } from "../types";
import { readScenesArray } from "../longform/scenes-array";
import {
	devNotePathCandidates,
	fountainPathCandidates,
	isFountainFile,
	sceneNameFromArrayEntry,
} from "../fountain/file-detection";

// Builds the row data the outline view renders. Source of truth for order is
// the project's `scenes:` array; dev notes that aren't in the array are
// surfaced at the bottom as orphans.

export interface OutlineRow {
	sequenceName: string; // basename without extension
	devNoteFile: TFile | null;
	fountainFile: TFile | null;
	intentExcerpt: string;
	characters: string[];
	locations: string[];
	sluglines: string[];
	versionCount: number;
	orphan: boolean; // dev note exists but not in the project's scenes array
	missing: boolean; // listed in scenes array but no dev note or fountain found
	atomized: boolean; // dev note's parent folder contains a populated Scenes/ subfolder
	atomizedSceneCount: number; // number of scene dev notes; 0 when not atomized
	indexFilePath: string; // Index.md this row belongs to — needed in season mode
}

export interface OutlineData {
	project: ProjectMeta;
	rows: OutlineRow[];
	scenesArray: string[];
}

const VERSIONS_FOLDER = "_versions";
const SEPARATOR = " — ";
// Matches both the new "Sequence Overview" label and the legacy "Sequence intent"
// label so dev notes authored before the rename continue to render in treatment.
const INTENT_HEADING = /^##\s+Sequence (?:Overview|intent)\s*$/im;

export function buildOutlineData(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
): OutlineData {
	const scenesArray = readScenesArray(app, project.indexFilePath);

	const fountainFolderPath = project.sequenceFolderPath;
	const devScenesPath = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.sequencesSubfolder}`,
	);

	const seen = new Set<string>();
	const rows: OutlineRow[] = [];

	for (const entry of scenesArray) {
		const row = buildRow(app, entry, fountainFolderPath, devScenesPath, false, project.indexFilePath);
		rows.push(row);
		// Track by human-friendly name so .fountain and .fountain.md entries
		// match orphan dev notes correctly.
		seen.add(sceneNameFromArrayEntry(entry));
	}

	// Orphans: dev notes in Development/Scenes/ not listed in Longform's scenes array
	const devFolder = app.vault.getAbstractFileByPath(devScenesPath);
	if (devFolder instanceof TFolder) {
		for (const child of devFolder.children) {
			if (!(child instanceof TFile)) continue;
			if (child.extension !== "md") continue;
			// Skip .fountain.md files — those are scene fountains, not dev notes.
			if (isFountainFile(child)) continue;
			if (seen.has(child.basename)) continue;
			rows.push(buildRow(app, child.basename, fountainFolderPath, devScenesPath, true, project.indexFilePath));
		}
	}

	return { project, rows, scenesArray };
}

function buildRow(
	app: App,
	entry: string,
	fountainFolderPath: string,
	devScenesPath: string,
	orphan: boolean,
	indexFilePath: string,
): OutlineRow {
	const sequenceName = sceneNameFromArrayEntry(entry);

	// Try both fountain formats — the array entry may be either a plain
	// basename (legacy .fountain) or a basename ending in .fountain (new
	// .fountain.md). Also tolerates folder-shape (atomized) sequences.
	let fountainFile: TFile | null = null;
	let fountainPath = "";
	for (const candidate of fountainPathCandidates(fountainFolderPath, entry)) {
		const normalized = normalizePath(candidate);
		const f = fileAt(app, normalized);
		if (f) {
			fountainFile = f;
			fountainPath = normalized;
			break;
		}
		if (!fountainPath) fountainPath = normalized;
	}

	// Dev note path: try flat first, then folder-shape (matches the same
	// promotion atomization performs on the fountain side).
	let devNotePath = "";
	let devNoteFile: TFile | null = null;
	for (const candidate of devNotePathCandidates(devScenesPath, sequenceName)) {
		const normalized = normalizePath(candidate);
		const f = fileAt(app, normalized);
		if (f) {
			devNotePath = normalized;
			devNoteFile = f;
			break;
		}
		if (!devNotePath) devNotePath = normalized;
	}
	void devNotePath;

	const fmRecord = devNoteFile
		? (app.metadataCache.getFileCache(devNoteFile)?.frontmatter as
				| Record<string, unknown>
				| undefined)
		: undefined;

	const characters = collectStringArray(fmRecord?.characters);
	const locations = collectLocations(fmRecord);

	const intentExcerpt = devNoteFile ? extractIntentExcerpt(app, devNoteFile) : "";
	const sluglines = fountainFile ? extractSluglines(app, fountainFile) : [];
	const versionCount = countVersions(app, devNoteFile, fountainFile, sequenceName);

	const missing = !devNoteFile && !fountainFile;

	// Atomized when the dev note lives in folder shape AND its parent folder
	// has a populated Scenes/ subfolder. We probe the dev side because that's
	// where slugline_key frontmatter (the canonical scene identity) lives;
	// the fountain side could in theory be in folder shape without dev-side
	// scenes, but in practice atomize creates both at once.
	const { atomized, atomizedSceneCount } = probeAtomized(app, devNoteFile);

	return {
		sequenceName,
		devNoteFile,
		fountainFile,
		intentExcerpt,
		characters,
		locations,
		sluglines,
		versionCount,
		orphan,
		missing,
		atomized,
		atomizedSceneCount,
		indexFilePath,
	};
}

function probeAtomized(
	app: App,
	devNote: TFile | null,
): { atomized: boolean; atomizedSceneCount: number } {
	if (!devNote) return { atomized: false, atomizedSceneCount: 0 };
	const parent = devNote.parent;
	if (!parent) return { atomized: false, atomizedSceneCount: 0 };
	// Folder shape: the dev note's parent folder name matches the dev note's
	// basename. Flat shape's parent is just the Sequences/ subfolder, which
	// won't match.
	if (parent.name !== devNote.basename) return { atomized: false, atomizedSceneCount: 0 };
	const scenesFolder = app.vault.getAbstractFileByPath(
		normalizePath(`${parent.path}/Scenes`),
	);
	if (!(scenesFolder instanceof TFolder)) return { atomized: false, atomizedSceneCount: 0 };
	let count = 0;
	for (const child of scenesFolder.children) {
		if (child instanceof TFile && child.extension === "md") count += 1;
	}
	return { atomized: count > 0, atomizedSceneCount: count };
}

function fileAt(app: App, path: string): TFile | null {
	const f = app.vault.getAbstractFileByPath(path);
	return f instanceof TFile ? f : null;
}

function extractIntentExcerpt(app: App, devNote: TFile): string {
	const cache = app.metadataCache.getFileCache(devNote);
	const sections = cache?.sections ?? [];
	const headings = cache?.headings ?? [];

	// Find the "## Sequence Overview" heading (or legacy "Sequence intent");
	// the excerpt is the prose between that heading and the next heading (or
	// end of file).
	const intentHeadingIdx = headings.findIndex((h) => {
		if (h.level !== 2) return false;
		const lc = h.heading.toLowerCase();
		return lc === "sequence overview" || lc === "sequence intent";
	});
	if (intentHeadingIdx === -1) return "";

	// Use synchronous metadata only — read the source via the cache's section
	// info if available, otherwise return empty (we don't want async reads
	// during a synchronous build pass).
	void sections;
	// Since we have no cheap way to get the body slice without reading the file,
	// fall back to reading. This is fine since dev notes are small.
	return readIntentSync(app, devNote, intentHeadingIdx, headings);
}

function readIntentSync(
	app: App,
	devNote: TFile,
	intentIdx: number,
	headings: { level: number; heading: string; position: { start: { offset: number }; end: { offset: number } } }[],
): string {
	// cachedRead is async, so this function is actually async-via-then. We
	// can't avoid reading file contents to get the prose. The treatment view
	// caller is fine with this returning empty initially and updating later;
	// for v1 we just return empty here and let the row render without an
	// excerpt. A follow-up can wire async reads.
	void app;
	void devNote;
	void intentIdx;
	void headings;
	return "";
}

function extractSluglines(app: App, fountain: TFile): string[] {
	// We can't read file contents synchronously; rely on metadata if possible,
	// otherwise return empty. Fountain files don't get markdown-style headings
	// in the metadata cache, so this stays empty in v1. A follow-up can add
	// async reads + caching.
	void app;
	void fountain;
	return [];
}

function countVersions(
	app: App,
	devNote: TFile | null,
	fountain: TFile | null,
	sequenceName: string,
): number {
	let total = 0;
	for (const source of [devNote, fountain]) {
		if (!source) continue;
		const parent = source.parent;
		if (!parent) continue;
		const versionsFolder = app.vault.getAbstractFileByPath(
			normalizePath(`${parent.path}/${VERSIONS_FOLDER}`),
		);
		if (!(versionsFolder instanceof TFolder)) continue;
		const prefix = `${sequenceName}${SEPARATOR}`;
		for (const child of versionsFolder.children) {
			if (child instanceof TFile && child.basename.startsWith(prefix)) total += 1;
		}
	}
	return total;
}

function collectStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	for (const item of v) {
		if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
	}
	return out;
}

function collectLocations(fm: Record<string, unknown> | undefined): string[] {
	if (!fm) return [];
	const fromArray = collectStringArray(fm.locations);
	const legacy =
		typeof fm.location === "string" && fm.location.trim() !== "" ? fm.location.trim() : null;
	const out = [...fromArray];
	if (legacy && !out.some((n) => n.toUpperCase() === legacy.toUpperCase())) out.push(legacy);
	return out;
}

// Extract intent excerpt + sluglines asynchronously. Used by the view to enrich
// rows after the initial synchronous build returns. Splitting these out keeps
// the synchronous build cheap and the file reads predictable.
//
// Mutates the row in place rather than returning a new object so reference
// equality with group.rows is preserved. Replacing the reference (the previous
// behavior) made drag-reorder fail because this.rows[i] would diverge from
// group.rows[i], and orderable.indexOf(sourceRow) would return -1.

export async function enrichRowAsync(
	app: App,
	row: OutlineRow,
	maxIntentChars = 200,
): Promise<OutlineRow> {
	if (row.devNoteFile) {
		const text = await app.vault.cachedRead(row.devNoteFile);
		row.intentExcerpt = sliceIntent(text, maxIntentChars);
	}

	if (row.fountainFile) {
		const text = await app.vault.cachedRead(row.fountainFile);
		row.sluglines = parseSluglines(text);
	}

	return row;
}

function sliceIntent(markdown: string, max: number): string {
	const match = INTENT_HEADING.exec(markdown);
	if (!match) return "";
	const after = markdown.slice(match.index + match[0].length);
	const nextHeading = /^##\s+/m.exec(after);
	const body = nextHeading ? after.slice(0, nextHeading.index) : after;
	const trimmed = body
		.split("\n")
		.filter((l) => !l.startsWith("<!--") && l.trim() !== "")
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	if (trimmed.length <= max) return trimmed;
	return trimmed.slice(0, max - 1).trimEnd() + "…";
}

function parseSluglines(fountain: string): string[] {
	const out: string[] = [];
	const lines = fountain.split(/\r?\n/);
	for (const raw of lines) {
		const line = raw.trim();
		if (line === "") continue;
		// Forced scene heading: line starting with a single dot (not ..)
		if (/^\.[^.]/.test(line)) {
			out.push(line.slice(1).trim());
			continue;
		}
		if (/^(INT|EXT|INT\.?\s*\/\s*EXT|I\s*\/\s*E)[.\s]/i.test(line)) {
			out.push(line);
		}
	}
	return out;
}
