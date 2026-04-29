import { type App, type TFile, normalizePath } from "obsidian";
import type { GlobalConfig, ProjectMeta } from "../types";
import type { ProjectScanner } from "../projects/scanner";
import {
	characterRoster,
	locationRoster,
	type CharacterEntry,
	type LocationEntry,
} from "./lookups";
import { buildOutlineData, type OutlineRow } from "./outline-data";

// Project home data builder. Aggregates the project's scenes, characters,
// locations, and a few quick-action signals (does the outline exist?
// are beats declared?) so the home view can render without doing its own
// data crawling. Reuses existing builders.
//
// For series projects, scenes are always empty (sequences live in episodes,
// not at series level) but `episodes` is populated by walking the scanner
// for tv-episode projects whose path falls under this series root.

export interface HomeSceneEntry {
	index: number; // 1-based script order from sequences:
	row: OutlineRow;
}

export interface SeasonGroup {
	seasonKey: string; // e.g. "S01" — used as the section header label
	episodes: EpisodeEntry[];
}

export interface EpisodeEntry {
	project: ProjectMeta;
	episodeCode: string; // "S01E01"
	title: string;
	indexFilePath: string;
}

export interface ProjectHomeData {
	project: ProjectMeta;
	isTv: boolean;
	isSeries: boolean;
	scenes: HomeSceneEntry[];
	characters: CharacterEntry[];
	locations: LocationEntry[];
	declaredBeats: string[]; // from Index.md beats:
	treatmentFile: TFile | null;
	// Series-only: episodes nested under this series, grouped by season.
	// Empty for non-series projects.
	seasons: SeasonGroup[];
	// For tv-episode projects: the containing series project (for the
	// "Back to series" link). Null if no series root has been initialized.
	parentSeries: ProjectMeta | null;
}

export function buildProjectHome(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
	scanner: ProjectScanner,
): ProjectHomeData {
	const isSeries = project.projectType === "series";

	// For series projects, we skip the outline-data crawl (no sequences) but
	// still pull characters/locations from the series-level Development tree
	// so recurring entities surface in the home view.
	const treatment = isSeries ? null : buildOutlineData(app, project, cfg);
	const scenes: HomeSceneEntry[] = treatment
		? treatment.rows.map((row, i) => ({ index: i + 1, row }))
		: [];

	const seasons = isSeries ? collectSeasons(project, scanner) : [];
	const parentSeries =
		project.projectType === "tv-episode"
			? findParentSeries(project, scanner)
			: null;

	return {
		project,
		isTv: project.projectType === "tv-episode",
		isSeries,
		scenes,
		characters: characterRoster(app, project, cfg),
		locations: locationRoster(app, project, cfg),
		declaredBeats: readDeclaredBeats(app, project),
		treatmentFile: findTreatment(app, project, cfg),
		seasons,
		parentSeries,
	};
}

// Walk every tv-episode project the scanner knows about; keep those whose
// path falls under this series's root. Group by season (parsed from the
// episode code, or the `season:` frontmatter field if present), sort
// episodes inside each season by episode code, sort seasons numerically.
function collectSeasons(
	series: ProjectMeta,
	scanner: ProjectScanner,
): SeasonGroup[] {
	const prefix = series.projectRootPath + "/";
	const buckets = new Map<string, EpisodeEntry[]>();
	for (const meta of scanner.projects.values()) {
		if (meta.projectType !== "tv-episode") continue;
		if (!meta.indexFilePath.startsWith(prefix)) continue;
		const seasonKey = deriveSeasonKey(meta);
		const entry: EpisodeEntry = {
			project: meta,
			episodeCode: meta.episode ?? "",
			title: meta.title ?? lastSegment(meta.projectRootPath),
			indexFilePath: meta.indexFilePath,
		};
		const bucket = buckets.get(seasonKey);
		if (bucket) bucket.push(entry);
		else buckets.set(seasonKey, [entry]);
	}
	return [...buckets.entries()]
		.map(([seasonKey, episodes]) => ({
			seasonKey,
			episodes: episodes.sort((a, b) =>
				a.episodeCode.localeCompare(b.episodeCode),
			),
		}))
		.sort((a, b) => a.seasonKey.localeCompare(b.seasonKey));
}

function deriveSeasonKey(meta: ProjectMeta): string {
	// Prefer the explicit `season:` field. Otherwise parse the season number
	// out of the episode code. Fall back to "Unsorted" so unparseable rows
	// still group together rather than each becoming its own bucket.
	if (meta.season && meta.season.trim() !== "") {
		const n = parseInt(meta.season, 10);
		if (!Number.isNaN(n)) return `S${String(n).padStart(2, "0")}`;
	}
	if (meta.episode) {
		const m = /^s(\d+)e/i.exec(meta.episode.trim());
		if (m) {
			const n = parseInt(m[1] ?? "", 10);
			if (!Number.isNaN(n)) return `S${String(n).padStart(2, "0")}`;
		}
	}
	return "Unsorted";
}

// Find the series project whose root contains this episode. If multiple
// series roots could claim it (nested folders), prefer the deepest match.
function findParentSeries(
	episode: ProjectMeta,
	scanner: ProjectScanner,
): ProjectMeta | null {
	let best: ProjectMeta | null = null;
	for (const meta of scanner.projects.values()) {
		if (meta.projectType !== "series") continue;
		const prefix = meta.projectRootPath + "/";
		if (!episode.indexFilePath.startsWith(prefix)) continue;
		if (!best || meta.projectRootPath.length > best.projectRootPath.length) {
			best = meta;
		}
	}
	return best;
}

function lastSegment(path: string): string {
	return path.split("/").pop() ?? path;
}

function readDeclaredBeats(app: App, project: ProjectMeta): string[] {
	const file = app.vault.getAbstractFileByPath(project.indexFilePath);
	const cache =
		file && (file as TFile).extension === "md"
			? app.metadataCache.getFileCache(file as TFile)
			: null;
	const fm = cache?.frontmatter as Record<string, unknown> | undefined;
	const raw = fm?.beats;
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
	}
	return out;
}

// Look up the project's treatment doc. New convention is `Treatment.md`;
// older projects authored before the rename had `Outline.md`. Both are
// detected so existing files keep working — the user can rename manually
// at their leisure.
function findTreatment(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
): TFile | null {
	for (const filename of ["Treatment.md", "Outline.md"]) {
		const path = normalizePath(
			`${project.projectRootPath}/${cfg.developmentFolder}/${filename}`,
		);
		const f = app.vault.getAbstractFileByPath(path);
		if (f && (f as TFile).extension === "md") return f as TFile;
	}
	return null;
}
