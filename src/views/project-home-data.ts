import { type App, type TFile, normalizePath } from "obsidian";
import type { GlobalConfig, ProjectMeta } from "../types";
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

export interface HomeSceneEntry {
	index: number; // 1-based script order from Longform scenes:
	row: OutlineRow;
}

export interface ProjectHomeData {
	project: ProjectMeta;
	isTv: boolean;
	scenes: HomeSceneEntry[];
	characters: CharacterEntry[];
	locations: LocationEntry[];
	declaredBeats: string[]; // from Index.md beats:
	treatmentFile: TFile | null;
}

export function buildProjectHome(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
): ProjectHomeData {
	const treatment = buildOutlineData(app, project, cfg);
	const scenes: HomeSceneEntry[] = treatment.rows.map((row, i) => ({
		index: i + 1,
		row,
	}));

	return {
		project,
		isTv: project.projectType === "tv-episode",
		scenes,
		characters: characterRoster(app, project, cfg),
		locations: locationRoster(app, project, cfg),
		declaredBeats: readDeclaredBeats(app, project),
		treatmentFile: findTreatment(app, project, cfg),
	};
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
