import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { ProjectMeta, ProjectType } from "../types";

// Detects Longform projects by scanning vault markdown files for `longform:` frontmatter.
// Owns an in-memory map keyed by index file path. Updated incrementally on metadata
// changes and file deletions; full scan runs once after the metadata cache resolves.

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
		const longform = fm.longform;
		if (!longform || typeof longform !== "object" || Array.isArray(longform)) return null;

		const sceneFolder = (longform as Record<string, unknown>).sceneFolder;
		if (typeof sceneFolder !== "string" || sceneFolder.trim() === "") return null;

		const parent = file.parent;
		if (!parent) return null;

		const projectRootPath = parent.path;
		const sceneFolderPath = normalizePath(`${projectRootPath}/${sceneFolder}`);

		const series = typeof fm.series === "string" && fm.series.trim() !== "" ? fm.series : undefined;
		const projectType: ProjectType = series ? "tv-episode" : "feature";

		const seriesDevelopmentPath =
			projectType === "tv-episode" ? this.findSeriesDevelopment(parent) : null;

		return {
			projectType,
			series,
			season: stringField(fm.season),
			episode: stringField(fm.episode),
			title: stringField(fm.title),
			logline: stringField(fm.logline),
			status: stringField(fm.status),
			indexFilePath: file.path,
			projectRootPath,
			sceneFolderPath,
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
