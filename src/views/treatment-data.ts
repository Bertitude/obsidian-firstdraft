import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { GlobalConfig, ProjectMeta } from "../types";
import { readScenesArray } from "../longform/scenes-array";
import {
	fountainPathCandidates,
	isFountainFile,
	sceneNameFromArrayEntry,
} from "../fountain/file-detection";

// Builds the row data the treatment view renders. Source of truth for order is
// Longform's `scenes:` array; dev notes that aren't in the array are surfaced
// at the bottom as orphans.

export interface TreatmentRow {
	sceneName: string; // basename without extension
	devNoteFile: TFile | null;
	fountainFile: TFile | null;
	intentExcerpt: string;
	characters: string[];
	locations: string[];
	sluglines: string[];
	versionCount: number;
	orphan: boolean; // dev note exists but not in Longform's scenes array
	missing: boolean; // listed in scenes array but no dev note or fountain found
	indexFilePath: string; // Index.md this row belongs to — needed in season mode
}

export interface TreatmentData {
	project: ProjectMeta;
	rows: TreatmentRow[];
	scenesArray: string[];
}

const VERSIONS_FOLDER = "_versions";
const SEPARATOR = " — ";
const INTENT_HEADING = /^##\s+Sequence intent\s*$/m;

export function buildTreatmentData(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
): TreatmentData {
	const scenesArray = readScenesArray(app, project.indexFilePath);

	const fountainFolderPath = project.sceneFolderPath;
	const devScenesPath = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.scenesSubfolder}`,
	);

	const seen = new Set<string>();
	const rows: TreatmentRow[] = [];

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
): TreatmentRow {
	const sceneName = sceneNameFromArrayEntry(entry);
	const devNotePath = normalizePath(`${devScenesPath}/${sceneName}.md`);

	// Try both fountain formats — the array entry may be either a plain
	// basename (legacy .fountain) or a basename ending in .fountain (new
	// .fountain.md). Use whichever file exists.
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

	const devNoteFile = fileAt(app, devNotePath);

	const fmRecord = devNoteFile
		? (app.metadataCache.getFileCache(devNoteFile)?.frontmatter as
				| Record<string, unknown>
				| undefined)
		: undefined;

	const characters = collectStringArray(fmRecord?.characters);
	const locations = collectLocations(fmRecord);

	const intentExcerpt = devNoteFile ? extractIntentExcerpt(app, devNoteFile) : "";
	const sluglines = fountainFile ? extractSluglines(app, fountainFile) : [];
	const versionCount = countVersions(app, devNoteFile, fountainFile, sceneName);

	const missing = !devNoteFile && !fountainFile;

	return {
		sceneName,
		devNoteFile,
		fountainFile,
		intentExcerpt,
		characters,
		locations,
		sluglines,
		versionCount,
		orphan,
		missing,
		indexFilePath,
	};
}

function fileAt(app: App, path: string): TFile | null {
	const f = app.vault.getAbstractFileByPath(path);
	return f instanceof TFile ? f : null;
}

function extractIntentExcerpt(app: App, devNote: TFile): string {
	const cache = app.metadataCache.getFileCache(devNote);
	const sections = cache?.sections ?? [];
	const headings = cache?.headings ?? [];

	// Find the "## Sequence intent" heading; the excerpt is the prose between
	// that heading and the next heading (or end of file).
	const intentHeadingIdx = headings.findIndex(
		(h) => h.level === 2 && h.heading.toLowerCase() === "sequence intent",
	);
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
	sceneName: string,
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
		const prefix = `${sceneName}${SEPARATOR}`;
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

export async function enrichRowAsync(
	app: App,
	row: TreatmentRow,
	maxIntentChars = 200,
): Promise<TreatmentRow> {
	const next = { ...row };

	if (row.devNoteFile) {
		const text = await app.vault.cachedRead(row.devNoteFile);
		next.intentExcerpt = sliceIntent(text, maxIntentChars);
	}

	if (row.fountainFile) {
		const text = await app.vault.cachedRead(row.fountainFile);
		next.sluglines = parseSluglines(text);
	}

	return next;
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
