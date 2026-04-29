import { App, MarkdownView, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveProjectSettings } from "../settings/resolve";
import { snapshotFile, todayLabel } from "../versioning/snapshot";
import { isFountainFile } from "../fountain/file-detection";

// Project-wide backfill linkify pass. For a given development entity (character
// or location), finds standalone prose mentions of its name across markdown
// files in the project and replaces them with markdown links to the canonical
// doc. Snapshot-aware: every modified file is auto-snapshotted with a
// "pre-linkify" label before rewrite, so a restore is always available.
//
// Skipped wholesale:
//   - .fountain files (script format, links don't fit) — this stays true even
//     when chuangcaleb mode treats .fountain as Markdown internally; screenplay
//     action prose should remain plain text. Don't relax this without explicit
//     user opt-in.
//   - non-markdown files
//   - the entity's own canonical doc
//   - anything inside _versions/ or Drafts/ folders (snapshot territory)
//   - YAML frontmatter at top of file
//   - fenced code blocks
//   - inline code spans
//   - text already inside [name](...) or [[name]] links

const SKIP_FOLDER_NAMES = new Set(["_versions", "Drafts"]);

export interface DevEntity {
	name: string;
	canonicalFilePath: string;
}

export interface LinkifyResult {
	filesScanned: number;
	filesModified: number;
	totalReplacements: number;
}

export async function linkifyEntity(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	entity: DevEntity,
): Promise<LinkifyResult> {
	const candidates = collectCandidateFiles(plugin.app, project, entity.canonicalFilePath);

	// Push any unsaved editor content to disk before scanning. If the user just
	// typed a mention into an open dev note and then triggered a create flow,
	// vault.read would otherwise return stale disk content and miss the match.
	await flushOpenEditors(plugin, candidates);

	const result: LinkifyResult = { filesScanned: 0, filesModified: 0, totalReplacements: 0 };

	for (const file of candidates) {
		result.filesScanned += 1;
		const content = await plugin.app.vault.read(file);
		const linkTarget = relativePath(file.path, entity.canonicalFilePath);
		const { rewritten, replacements } = applyLinkifyPass(content, entity.name, linkTarget);
		if (replacements === 0) continue;

		// Snapshot before write so the user can roll back any single file.
		await snapshotFile(plugin.app, file, `pre-linkify ${todayLabel()}`);
		await plugin.app.vault.modify(file, rewritten);
		result.filesModified += 1;
		result.totalReplacements += replacements;
	}

	return result;
}

// Save any open MarkdownView whose file is in the candidate set. Without this,
// vault.read sees the on-disk version (stale) when the user has unsaved edits.
async function flushOpenEditors(
	plugin: FirstDraftPlugin,
	candidates: TFile[],
): Promise<void> {
	const paths = new Set(candidates.map((f) => f.path));
	const leaves = plugin.app.workspace.getLeavesOfType("markdown");
	for (const leaf of leaves) {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) continue;
		if (!view.file || !paths.has(view.file.path)) continue;
		await view.save();
	}
}

export async function linkifyAllEntities(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
): Promise<LinkifyResult> {
	const cfg = resolveProjectSettings(project, plugin.settings);
	const entities = collectAllEntities(plugin.app, project, cfg.developmentFolder, cfg.charactersSubfolder, cfg.locationsSubfolder);
	const total: LinkifyResult = { filesScanned: 0, filesModified: 0, totalReplacements: 0 };
	if (entities.length === 0) {
		new Notice("No characters or locations found to linkify.");
		return total;
	}

	for (const entity of entities) {
		const result = await linkifyEntity(plugin, project, entity);
		total.filesScanned += result.filesScanned;
		total.filesModified += result.filesModified;
		total.totalReplacements += result.totalReplacements;
	}
	return total;
}

// ── candidate file collection ────────────────────────────────────────────

function collectCandidateFiles(
	app: App,
	project: ProjectMeta,
	excludeCanonicalPath: string,
): TFile[] {
	const root = app.vault.getAbstractFileByPath(project.projectRootPath);
	if (!(root instanceof TFolder)) return [];
	const out: TFile[] = [];
	walk(root, out, excludeCanonicalPath);
	return out;
}

function walk(folder: TFolder, out: TFile[], excludeCanonicalPath: string): void {
	for (const child of folder.children) {
		if (child instanceof TFolder) {
			if (SKIP_FOLDER_NAMES.has(child.name)) continue;
			walk(child, out, excludeCanonicalPath);
			continue;
		}
		if (!(child instanceof TFile)) continue;
		if (child.extension !== "md") continue;
		// Skip .fountain.md files — those are scene scripts, even though
		// Obsidian sees them as Markdown. Linkify shouldn't touch script
		// content (see top-of-file comment about action prose).
		if (isFountainFile(child)) continue;
		if (child.path === excludeCanonicalPath) continue;
		out.push(child);
	}
}

// ── entity collection (for linkify-all) ──────────────────────────────────

function collectAllEntities(
	app: App,
	project: ProjectMeta,
	developmentFolder: string,
	charactersSubfolder: string,
	locationsSubfolder: string,
): DevEntity[] {
	const entities: DevEntity[] = [];
	const charsPath = normalizePath(`${project.projectRootPath}/${developmentFolder}/${charactersSubfolder}`);
	const locsPath = normalizePath(`${project.projectRootPath}/${developmentFolder}/${locationsSubfolder}`);
	collectFromEntityFolder(app, charsPath, entities);
	collectFromEntityFolder(app, locsPath, entities);

	// For TV: include series-level characters too if available.
	if (project.seriesDevelopmentPath) {
		const seriesCharsPath = normalizePath(`${project.seriesDevelopmentPath}/${charactersSubfolder}`);
		collectFromEntityFolder(app, seriesCharsPath, entities);
	}

	return entities;
}

function collectFromEntityFolder(app: App, path: string, out: DevEntity[]): void {
	const folder = app.vault.getAbstractFileByPath(path);
	if (!(folder instanceof TFolder)) return;
	for (const child of folder.children) {
		if (!(child instanceof TFolder)) continue;
		const expectedName = `${child.name}.md`;
		const canonical = child.children.find(
			(c) => c instanceof TFile && c.name === expectedName,
		) as TFile | undefined;
		if (!canonical) continue;
		out.push({ name: child.name, canonicalFilePath: canonical.path });

		// Phase 4g — emit a virtual entity per alias declared in frontmatter,
		// all pointing to the same canonical file. Mentions of the alias text
		// linkify to the canonical character's note.
		const fm = app.metadataCache.getFileCache(canonical)?.frontmatter as
			| Record<string, unknown>
			| undefined;
		const aliases = Array.isArray(fm?.aliases) ? (fm?.aliases as unknown[]) : [];
		for (const alias of aliases) {
			if (typeof alias !== "string") continue;
			const trimmed = alias.trim();
			if (trimmed === "") continue;
			out.push({ name: trimmed, canonicalFilePath: canonical.path });
		}
	}
}

// ── replacement pass ─────────────────────────────────────────────────────

interface LinkifyPassResult {
	rewritten: string;
	replacements: number;
}

// Walks the markdown body line-by-line, tracking frontmatter and fenced code
// regions. For each non-skipped line, applies the regex replacement that
// targets standalone mentions of the name not already inside a link or inline
// code span.
export function applyLinkifyPass(
	content: string,
	name: string,
	linkTarget: string,
): LinkifyPassResult {
	const lines = content.split(/\r?\n/);
	const out: string[] = [];
	let replacements = 0;

	let inFrontmatter = false;
	let seenFrontmatterStart = false;
	let inFence = false;
	let fenceMarker = "";

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";

		// Frontmatter: --- on the very first line opens it; subsequent --- closes.
		if (i === 0 && line.trim() === "---") {
			inFrontmatter = true;
			seenFrontmatterStart = true;
			out.push(line);
			continue;
		}
		if (inFrontmatter) {
			out.push(line);
			if (line.trim() === "---") inFrontmatter = false;
			continue;
		}
		void seenFrontmatterStart;

		// Fenced code blocks: ``` or ~~~ at column 0 (allowing leading whitespace).
		const fenceMatch = /^(\s*)(```|~~~)/.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[2] ?? "";
			if (!inFence) {
				inFence = true;
				fenceMarker = marker;
			} else if (marker === fenceMarker) {
				inFence = false;
				fenceMarker = "";
			}
			out.push(line);
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}

		const { rewritten, count } = linkifyLine(line, name, linkTarget);
		out.push(rewritten);
		replacements += count;
	}

	return { rewritten: out.join("\n"), replacements };
}

interface LineRewrite {
	rewritten: string;
	count: number;
}

// Linkifies matches of `name` in a single line. Skips:
//   - inline code spans (between backticks)
//   - text already inside [text](url) markdown links
//   - text already inside [[wikilinks]]
function linkifyLine(line: string, name: string, linkTarget: string): LineRewrite {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`\\b${escaped}\\b`, "gi");

	const skipRanges = collectSkipRanges(line);
	let result = "";
	let lastIndex = 0;
	let count = 0;

	let m: RegExpExecArray | null;
	while ((m = re.exec(line))) {
		const start = m.index;
		const end = start + m[0].length;
		if (rangeOverlapsAny(start, end, skipRanges)) continue;
		result += line.slice(lastIndex, start);
		result += `[${m[0]}](${linkTarget})`;
		lastIndex = end;
		count += 1;
	}
	result += line.slice(lastIndex);
	return { rewritten: result, count };
}

interface SkipRange {
	start: number;
	end: number;
}

function collectSkipRanges(line: string): SkipRange[] {
	const ranges: SkipRange[] = [];

	// Inline code spans: simple `…` matching (not handling escaped backticks
	// or multi-backtick delimiters — acceptable for prose markdown).
	const codeRe = /`[^`]*`/g;
	let m: RegExpExecArray | null;
	while ((m = codeRe.exec(line))) {
		ranges.push({ start: m.index, end: m.index + m[0].length });
	}

	// Markdown links: [text](url) — skip the entire match including brackets/url.
	const mdLinkRe = /\[[^\]]*\]\([^)]*\)/g;
	while ((m = mdLinkRe.exec(line))) {
		ranges.push({ start: m.index, end: m.index + m[0].length });
	}

	// Wikilinks: [[anything]] or [[link|alias]] — skip the entire match.
	const wikiRe = /\[\[[^\]]+\]\]/g;
	while ((m = wikiRe.exec(line))) {
		ranges.push({ start: m.index, end: m.index + m[0].length });
	}

	return ranges;
}

function rangeOverlapsAny(start: number, end: number, ranges: SkipRange[]): boolean {
	for (const r of ranges) {
		if (start < r.end && end > r.start) return true;
	}
	return false;
}

// ── path helpers ─────────────────────────────────────────────────────────

// Builds a relative path from `fromFile` (the file where the link will live)
// to `toFile` (the canonical doc being linked to). Both paths are vault-rooted.
function relativePath(fromFile: string, toFile: string): string {
	const fromParts = fromFile.split("/").slice(0, -1);
	const toParts = toFile.split("/");
	// Find common prefix length.
	let i = 0;
	while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
	const ups = fromParts.length - i;
	const downs = toParts.slice(i);
	const segments: string[] = [];
	for (let k = 0; k < ups; k++) segments.push("..");
	segments.push(...downs);
	if (segments.length === 0) return toParts[toParts.length - 1] ?? toFile;
	return segments.join("/");
}
