import { App, TFile, TFolder, getAllTags, normalizePath } from "obsidian";
import type { ProjectMeta, GlobalConfig, FirstDraftSettings } from "../types";
import { resolveNoteTag, tagMatchesProject } from "../projects/note-tag";

// Aggregates the data the project notes panel renders. Two sections:
//
//   - References: every .md file under <Project>/Development/References/
//     (recursively). Curated external material — research, photos, articles.
//
//   - Notes: union of three sources, deduped by path:
//       1. Files inside any folder named <cfg.notesSubfolder> anywhere under
//          the project root (recursively).
//       2. Files anywhere in the vault tagged with the project's note tag
//          (frontmatter or inline). Hierarchy-aware: subtags also match.
//       3. (TODO v2) Notes that wikilink to anything in the project. Tabled
//          for now — likely to be noisy.
//
// Each entry carries a "source" badge so the user knows why it's surfaced.

export type NoteSource = "folder" | "tag" | "reference";

export interface NoteEntry {
	file: TFile;
	source: NoteSource;
	excerpt: string;
	mtime: number;
	// For inline-tag matches, the offset where the tag occurs — lets the view
	// jump to that line on click. Null for whole-file matches.
	matchOffset: number | null;
}

export interface ProjectNotesData {
	project: ProjectMeta;
	noteTag: string;
	references: NoteEntry[];
	notes: NoteEntry[];
}

const EXCERPT_MAX = 180;

export function buildProjectNotesData(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
	settings: FirstDraftSettings,
): ProjectNotesData {
	const noteTag = resolveNoteTag(project, settings);

	const references = collectReferences(app, project, cfg);
	const notes = collectNotes(app, project, cfg, noteTag);

	return { project, noteTag, references, notes };
}

// ── References ──────────────────────────────────────────────────────────

function collectReferences(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
): NoteEntry[] {
	const refsPath = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.referencesSubfolder}`,
	);
	const folder = app.vault.getAbstractFileByPath(refsPath);
	if (!(folder instanceof TFolder)) return [];

	const out: NoteEntry[] = [];
	walkMarkdownFiles(folder, (file) => {
		out.push({
			file,
			source: "reference",
			excerpt: synchronousExcerpt(app, file),
			mtime: file.stat.mtime,
			matchOffset: null,
		});
	});
	return sortByMtimeDesc(out);
}

// ── Notes ───────────────────────────────────────────────────────────────

function collectNotes(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
	noteTag: string,
): NoteEntry[] {
	const seen = new Set<string>();
	const out: NoteEntry[] = [];

	// Source 1: files inside any folder named cfg.notesSubfolder under the
	// project root. Walk the project tree, identify every matching folder,
	// then collect their .md children (non-recursive within each Notes folder
	// — Notes/Subfolder/x.md gets surfaced too, but we keep it scoped).
	const projectRoot = app.vault.getAbstractFileByPath(project.projectRootPath);
	if (projectRoot instanceof TFolder) {
		for (const folder of findFoldersByName(projectRoot, cfg.notesSubfolder)) {
			walkMarkdownFiles(folder, (file) => {
				if (seen.has(file.path)) return;
				seen.add(file.path);
				out.push({
					file,
					source: "folder",
					excerpt: synchronousExcerpt(app, file),
					mtime: file.stat.mtime,
					matchOffset: null,
				});
			});
		}
	}

	// Source 2: vault-wide tag search. For each file, check tags via
	// metadataCache.getFileCache. Skips files inside the project root (those
	// are picked up by Source 1 if they belong, and tagging your own dev
	// notes doesn't add information). Skips files in the References folder
	// (those have their own section).
	const referencesPrefix = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.referencesSubfolder}/`,
	);

	for (const file of app.vault.getMarkdownFiles()) {
		if (seen.has(file.path)) continue;
		// Files inside the project root are handled by Source 1 (Notes folder
		// walk); avoid double-counting (and avoid pulling in dev notes that
		// happen to be tagged with the project tag, which would be noise).
		if (file.path.startsWith(project.projectRootPath + "/")) continue;
		// References get their own section.
		if (file.path.startsWith(referencesPrefix)) continue;

		const cache = app.metadataCache.getFileCache(file);
		if (!cache) continue;
		const allTags = getAllTags(cache) ?? [];
		const matched = allTags.find((t) => tagMatchesProject(t, noteTag));
		if (!matched) continue;

		seen.add(file.path);

		// If the match was inline, locate it for the click-to-jump affordance.
		const inline = cache.tags?.find((t) => tagMatchesProject(t.tag, noteTag));
		const matchOffset = inline ? inline.position.start.offset : null;

		out.push({
			file,
			source: "tag",
			excerpt: synchronousExcerpt(app, file, matchOffset),
			mtime: file.stat.mtime,
			matchOffset,
		});
	}

	return sortByMtimeDesc(out);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function findFoldersByName(root: TFolder, name: string): TFolder[] {
	const out: TFolder[] = [];
	const stack: TFolder[] = [root];
	while (stack.length > 0) {
		const folder = stack.pop()!;
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				if (child.name === name) out.push(child);
				stack.push(child);
			}
		}
	}
	return out;
}

function walkMarkdownFiles(folder: TFolder, visit: (file: TFile) => void): void {
	const stack: TFolder[] = [folder];
	while (stack.length > 0) {
		const f = stack.pop()!;
		for (const child of f.children) {
			if (child instanceof TFile && child.extension === "md") visit(child);
			else if (child instanceof TFolder) stack.push(child);
		}
	}
}

function sortByMtimeDesc(entries: NoteEntry[]): NoteEntry[] {
	return entries.slice().sort((a, b) => b.mtime - a.mtime);
}

// Synchronous excerpt placeholder — the actual file body isn't available
// without an async read. Returns "" for v1; the view's enrichRowAsync-style
// pass replaces it with real text after build returns. matchOffset is
// reserved for the async pass to locate the relevant paragraph.
function synchronousExcerpt(
	app: App,
	file: TFile,
	matchOffset: number | null = null,
): string {
	void app;
	void file;
	void matchOffset;
	return "";
}

// Async excerpt: reads file body, extracts a small chunk. For inline-tag
// matches, prefers the paragraph containing the tag. Otherwise the first
// non-empty paragraph after frontmatter.
export async function enrichEntryAsync(
	app: App,
	entry: NoteEntry,
): Promise<NoteEntry> {
	const text = await app.vault.cachedRead(entry.file);
	const body = stripFrontmatter(text);
	let excerpt: string;
	if (entry.matchOffset !== null) {
		excerpt = paragraphAroundOffset(text, entry.matchOffset, EXCERPT_MAX);
	} else {
		excerpt = firstParagraph(body, EXCERPT_MAX);
	}
	entry.excerpt = excerpt;
	return entry;
}

function stripFrontmatter(text: string): string {
	if (!text.startsWith("---")) return text;
	const end = text.indexOf("\n---", 3);
	if (end === -1) return text;
	return text.slice(end + 4).replace(/^\n+/, "");
}

function firstParagraph(body: string, max: number): string {
	const paragraphs = body.split(/\n\s*\n/);
	for (const p of paragraphs) {
		const cleaned = p
			.split("\n")
			.filter((l) => !l.startsWith("#") && !l.startsWith("<!--") && l.trim() !== "")
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		if (cleaned.length === 0) continue;
		return cleaned.length <= max ? cleaned : cleaned.slice(0, max - 1).trimEnd() + "…";
	}
	return "";
}

function paragraphAroundOffset(text: string, offset: number, max: number): string {
	// Walk back to the previous blank line, forward to the next. Take that as
	// the surrounding paragraph and clean it up like firstParagraph does.
	let start = offset;
	while (start > 0 && !isParagraphBreak(text, start - 1)) start -= 1;
	let end = offset;
	while (end < text.length && !isParagraphBreak(text, end)) end += 1;
	const slice = text.slice(start, end).trim();
	const cleaned = slice
		.split("\n")
		.filter((l) => !l.startsWith("#") && !l.startsWith("<!--") && l.trim() !== "")
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length === 0) return "";
	return cleaned.length <= max ? cleaned : cleaned.slice(0, max - 1).trimEnd() + "…";
}

function isParagraphBreak(text: string, i: number): boolean {
	// True if position `i` starts a blank line (preceded by newline, current
	// char is newline) — i.e. the empty-line separator between paragraphs.
	if (text[i] !== "\n") return false;
	if (i + 1 >= text.length) return true;
	return text[i + 1] === "\n";
}
