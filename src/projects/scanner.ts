import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { ProjectMeta, ProjectType } from "../types";

// Detects FirstDraft projects by scanning vault markdown files for either
// `firstdraft:` (new schema) or `longform:` (legacy / Longform-compatible
// schema). The two have the same shape — sequenceFolder + scenes — so detection
// just picks the first present block. New writes prefer `firstdraft:`.
// Owns an in-memory map keyed by index file path. Updated incrementally on
// metadata changes and file deletions; full scan runs once after the metadata
// cache resolves.
//
// Files inside snapshot/draft folders (`_versions`, `Drafts`) are skipped —
// snapshots of an Index.md retain its frontmatter and would otherwise be
// detected as duplicate projects. Same skip-set used by linkify, migrate,
// and delete-entity for the same reason.

const SKIP_FOLDER_NAMES = new Set(["_versions", "Drafts"]);

export class ProjectScanner {
	readonly projects = new Map<string, ProjectMeta>();
	isReady = false;

	constructor(
		private readonly app: App,
		private readonly developmentFolderName: () => string,
		private readonly debug: () => boolean,
	) {}

	scanAll(): void {
		const start = performance.now();
		this.projects.clear();
		for (const file of this.app.vault.getMarkdownFiles()) {
			this.evaluate(file);
		}
		this.isReady = true;
		if (this.debug()) {
			const ms = (performance.now() - start).toFixed(1);
			console.debug(`[FirstDraft] Scanned ${this.projects.size} project(s) in ${ms}ms`);
		}
	}

	updateFile(file: TFile): void {
		this.evaluate(file);
	}

	removeFile(path: string): void {
		if (this.projects.delete(path) && this.debug()) {
			console.debug(`[FirstDraft] Project removed: ${path}`);
		}
	}

	handleRename(file: TFile, oldPath: string): void {
		if (this.projects.delete(oldPath) && this.debug()) {
			console.debug(`[FirstDraft] Index renamed away from: ${oldPath}`);
		}
		this.evaluate(file);
	}

	private evaluate(file: TFile): void {
		if (file.extension !== "md") return;
		// Skip files inside snapshot/draft folders — they're copies of project
		// indexes and shouldn't be detected as separate projects.
		if (file.path.split("/").some((seg) => SKIP_FOLDER_NAMES.has(seg))) {
			this.projects.delete(file.path);
			return;
		}
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		const meta = this.deriveMeta(file, fm);
		if (meta) {
			this.projects.set(file.path, meta);
		} else {
			this.projects.delete(file.path);
		}
	}

	private deriveMeta(file: TFile, fm: Record<string, unknown> | undefined): ProjectMeta | null {
		if (!fm) return null;
		const block = readProjectBlock(fm);
		if (!block) return null;

		const parent = file.parent;
		if (!parent) return null;

		const projectRootPath = parent.path;

		// Project kind: explicit `firstdraft.kind` field wins. For backward
		// compat, if kind isn't set: presence of `series:` => tv-episode,
		// absence => feature. Series and season projects are NEW and only
		// detected via the explicit `kind:` marker.
		const kindRaw = typeof block.kind === "string" ? block.kind.trim().toLowerCase() : "";
		const seriesField =
			typeof fm.series === "string" && fm.series.trim() !== "" ? fm.series : undefined;

		let projectType: ProjectType;
		if (kindRaw === "series") projectType = "series";
		else if (kindRaw === "season") projectType = "season";
		else if (kindRaw === "episode" || seriesField) projectType = "tv-episode";
		else projectType = "feature";

		// Series and season projects don't require sequenceFolder — they have
		// no sequences directly (those live in episodes). Feature/episode
		// projects still require it.
		let sequenceFolderPath = "";
		if (projectType !== "series" && projectType !== "season") {
			const folderRaw = block.sequenceFolder ?? block.sceneFolder;
			if (typeof folderRaw !== "string" || folderRaw.trim() === "") return null;
			sequenceFolderPath = normalizePath(`${projectRootPath}/${folderRaw}`);
		}

		const seriesDevelopmentPath =
			projectType === "tv-episode" ? this.findSeriesDevelopment(parent) : null;

		return {
			projectType,
			series: seriesField,
			season: stringField(fm.season),
			episode: stringField(fm.episode),
			title: stringField(fm.title),
			subtitle: stringField(fm.subtitle),
			logline: stringField(fm.logline),
			status: stringField(fm.status),
			indexFilePath: file.path,
			projectRootPath,
			sequenceFolderPath,
			seriesDevelopmentPath,
		};
	}

	// Walk upward from the project root, looking for an ancestor whose children include
	// a folder matching the configured Development folder name. Skips the project root
	// itself because that is the episode root and has its own Development subfolder.
	private findSeriesDevelopment(projectRoot: TFolder): string | null {
		const target = this.developmentFolderName();
		let current: TFolder | null = projectRoot.parent;
		while (current) {
			for (const child of current.children) {
				if (child instanceof TFolder && child.name === target) {
					return child.path;
				}
			}
			if (current.path === "" || current.path === "/") break;
			current = current.parent;
		}
		return null;
	}
}

function stringField(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

// Read the project block from frontmatter. Prefers `firstdraft:` (new schema)
// but falls back to `longform:` (legacy / Longform-compatible) so unmigrated
// projects keep working. Both shapes carry the same keys (sequenceFolder, scenes).
export function readProjectBlock(
	fm: Record<string, unknown>,
): Record<string, unknown> | null {
	for (const key of ["firstdraft", "longform"]) {
		const v = fm[key];
		if (v && typeof v === "object" && !Array.isArray(v)) {
			return v as Record<string, unknown>;
		}
	}
	return null;
}

// Returns which key (`firstdraft` or `longform`) currently holds the project
// block. Used by writers that need to update the right block in-place. New
// projects should always use `firstdraft`.
export function projectBlockKey(
	fm: Record<string, unknown>,
): "firstdraft" | "longform" | null {
	if (fm.firstdraft && typeof fm.firstdraft === "object" && !Array.isArray(fm.firstdraft)) {
		return "firstdraft";
	}
	if (fm.longform && typeof fm.longform === "object" && !Array.isArray(fm.longform)) {
		return "longform";
	}
	return null;
}
