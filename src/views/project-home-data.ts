import { type App, TFile, normalizePath } from "obsidian";
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
// not at series level) — instead the seasons array is populated.
// For season projects, scenes are also empty, episodes are populated
// directly (a single season group's worth, flattened into seasonEpisodes).

export interface HomeSceneEntry {
	index: number; // 1-based script order from sequences:
	row: OutlineRow;
}

export interface SeasonGroup {
	seasonKey: string; // e.g. "S01" — used as the section header label
	episodes: EpisodeEntry[];
	seasonProject: ProjectMeta | null; // present when an explicit Season Index.md exists
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
	isSeason: boolean;
	scenes: HomeSceneEntry[];
	characters: CharacterEntry[];
	locations: LocationEntry[];
	declaredBeats: string[]; // from Index.md beats:
	treatmentFile: TFile | null;
	// Season-outline file for season projects (the "season treatment"). Null
	// for non-season projects.
	seasonOutlineFile: TFile | null;
	// Series-outline file for series projects (the "show bible" outline —
	// H2 per season; feeds Make seasons from series outline). Null for
	// non-series projects.
	seriesOutlineFile: TFile | null;
	// Series-only: seasons (each containing episodes). Empty for non-series.
	seasons: SeasonGroup[];
	// Season-only: episodes inside this season. Empty for non-season.
	seasonEpisodes: EpisodeEntry[];
	// For tv-episode projects: the containing series project (for the
	// "Back to series" breadcrumb). Null if no series root has been initialized.
	parentSeries: ProjectMeta | null;
	// For tv-episode projects: the containing season project (for the
	// "Back to season" breadcrumb). Null if not nested in a season project.
	parentSeason: ProjectMeta | null;
}

export function buildProjectHome(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
	scanner: ProjectScanner,
): ProjectHomeData {
	const isSeries = project.projectType === "series";
	const isSeason = project.projectType === "season";

	// For series + season projects we skip the outline-data crawl (no
	// sequences) but still pull characters/locations from the local
	// Development tree so recurring entities surface in the home view.
	const treatment = isSeries || isSeason ? null : buildOutlineData(app, project, cfg);
	const scenes: HomeSceneEntry[] = treatment
		? treatment.rows.map((row, i) => ({ index: i + 1, row }))
		: [];

	const seasons = isSeries ? collectSeasons(project, scanner) : [];
	const seasonEpisodes = isSeason ? collectSeasonEpisodes(project, scanner) : [];
	const parentSeries =
		project.projectType === "tv-episode" || project.projectType === "season"
			? findParentSeries(project, scanner)
			: null;
	const parentSeason =
		project.projectType === "tv-episode"
			? findParentSeason(project, scanner)
			: null;

	return {
		project,
		isTv: project.projectType === "tv-episode",
		isSeries,
		isSeason,
		scenes,
		characters: characterRoster(app, project, cfg),
		locations: locationRoster(app, project, cfg),
		declaredBeats: readDeclaredBeats(app, project),
		treatmentFile: findTreatment(app, project, cfg),
		seasonOutlineFile: isSeason ? findSeasonOutline(app, project, cfg) : null,
		seriesOutlineFile: isSeries ? findSeriesOutline(app, project, cfg) : null,
		seasons,
		seasonEpisodes,
		parentSeries,
		parentSeason,
	};
}

// Walk every tv-episode project the scanner knows about; keep those whose
// path falls under this series's root. Group by season (parsed from the
// episode code, or the `season:` frontmatter field if present), sort
// episodes inside each season by episode code, sort seasons numerically.
//
// When an explicit season project (kind: season) exists for a key, attach
// it to the group so the view can link to its Index.md.
function collectSeasons(
	series: ProjectMeta,
	scanner: ProjectScanner,
): SeasonGroup[] {
	const prefix = series.projectRootPath + "/";
	const buckets = new Map<string, EpisodeEntry[]>();
	const seasonProjects = new Map<string, ProjectMeta>();

	// First pass: collect explicit season projects under this series.
	for (const meta of scanner.projects.values()) {
		if (meta.projectType !== "season") continue;
		if (!meta.projectRootPath.startsWith(prefix)) continue;
		const key = deriveSeasonKey(meta);
		seasonProjects.set(key, meta);
		buckets.set(key, []); // ensure key exists even with zero episodes yet
	}

	// Second pass: bucket episodes by season key.
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
			seasonProject: seasonProjects.get(seasonKey) ?? null,
		}))
		.sort((a, b) => a.seasonKey.localeCompare(b.seasonKey));
}

// Episodes nested inside a single season project. Sorted by episode code.
function collectSeasonEpisodes(
	season: ProjectMeta,
	scanner: ProjectScanner,
): EpisodeEntry[] {
	const prefix = season.projectRootPath + "/";
	const out: EpisodeEntry[] = [];
	for (const meta of scanner.projects.values()) {
		if (meta.projectType !== "tv-episode") continue;
		if (!meta.indexFilePath.startsWith(prefix)) continue;
		out.push({
			project: meta,
			episodeCode: meta.episode ?? "",
			title: meta.title ?? lastSegment(meta.projectRootPath),
			indexFilePath: meta.indexFilePath,
		});
	}
	return out.sort((a, b) => a.episodeCode.localeCompare(b.episodeCode));
}

// Find the season project containing this episode. Deepest match wins
// (matters when nested season-style folders coexist).
function findParentSeason(
	episode: ProjectMeta,
	scanner: ProjectScanner,
): ProjectMeta | null {
	let best: ProjectMeta | null = null;
	for (const meta of scanner.projects.values()) {
		if (meta.projectType !== "season") continue;
		const prefix = meta.projectRootPath + "/";
		if (!episode.indexFilePath.startsWith(prefix)) continue;
		if (!best || meta.projectRootPath.length > best.projectRootPath.length) {
			best = meta;
		}
	}
	return best;
}

// Look up the season's outline doc — `<season>/<dev>/Season Outline.md`.
function findSeasonOutline(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
): TFile | null {
	const path = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/Season Outline.md`,
	);
	const f = app.vault.getAbstractFileByPath(path);
	return f instanceof TFile && f.extension === "md" ? f : null;
}

// Look up the series's outline doc — `<series>/<dev>/Series Outline.md`.
function findSeriesOutline(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
): TFile | null {
	const path = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/Series Outline.md`,
	);
	const f = app.vault.getAbstractFileByPath(path);
	return f instanceof TFile && f.extension === "md" ? f : null;
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

// Find the series project whose root contains this project (episode or
// season). Deepest match wins (nested folders).
function findParentSeries(
	child: ProjectMeta,
	scanner: ProjectScanner,
): ProjectMeta | null {
	let best: ProjectMeta | null = null;
	for (const meta of scanner.projects.values()) {
		if (meta.projectType !== "series") continue;
		const prefix = meta.projectRootPath + "/";
		if (!child.indexFilePath.startsWith(prefix)) continue;
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
		file instanceof TFile && file.extension === "md"
			? app.metadataCache.getFileCache(file)
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
		if (f instanceof TFile && f.extension === "md") return f;
	}
	return null;
}
