import type { App, TFile } from "obsidian";
import type { GlobalConfig, ProjectMeta } from "../types";
import {
	characterRoster,
	parseCharacterCues,
	resolveCharacterByNameOrAlias,
	type CharacterEntry,
} from "./lookups";
import { buildTreatmentData, type TreatmentRow } from "./treatment-data";

// Phase 3b — Character matrix data builder. Computes the rows × scenes
// presence grid for one or more projects (single project in episode mode,
// multiple sibling episodes in season mode).
//
// Rows are CharacterEntry from the project's roster — versions and groups
// appear as separate rows; aliases fold to canonical via
// resolveCharacterByNameOrAlias when matching against scene characters: arrays.

export interface MatrixSceneCol {
	sceneName: string;
	devNoteFile: TFile | null;
	fountainFile: TFile | null;
	indexFilePath: string;
	episodeLabel?: string; // populated only when grouping by episode in season mode
	missing: boolean;
}

export interface MatrixData {
	rows: CharacterEntry[];
	scenes: MatrixSceneCol[];
	// presence[rowIdx][sceneIdx] — true if the row's character is in the scene
	presence: boolean[][];
	// cueCounts[rowIdx][sceneIdx] — number of times the character speaks in
	// the scene's fountain. 0 when the fountain has no cues for that character
	// or when the fountain file doesn't exist.
	cueCounts: number[][];
}

// Build a matrix for a single project. Each scene becomes a column; characters
// from this project's roster become rows. Async because cue counts require
// reading each scene's fountain file.
export async function buildCharacterMatrix(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
): Promise<MatrixData> {
	const rows = characterRoster(app, project, cfg);
	const treatment = buildTreatmentData(app, project, cfg);
	const scenes: MatrixSceneCol[] = treatment.rows.map((row) =>
		toSceneCol(row, project),
	);
	const presence = computePresence(rows, treatment.rows);
	const cueCounts = await computeCueCounts(app, rows, treatment.rows);
	return { rows, scenes, presence, cueCounts };
}

// Build a combined matrix for multiple projects (season mode). Rows are the
// union of all rosters (deduped by uppercase name); scenes are concatenated in
// project order with episode labels for header rendering.
export async function buildSeasonMatrix(
	app: App,
	projects: { project: ProjectMeta; cfg: GlobalConfig }[],
): Promise<MatrixData> {
	const dedupedRows = new Map<string, CharacterEntry>();
	const allScenes: MatrixSceneCol[] = [];
	const sceneRowsList: TreatmentRow[][] = [];

	for (const { project, cfg } of projects) {
		const roster = characterRoster(app, project, cfg);
		for (const entry of roster) {
			if (!dedupedRows.has(entry.name)) dedupedRows.set(entry.name, entry);
		}
		const treatment = buildTreatmentData(app, project, cfg);
		const episodeLabel = displayEpisode(project);
		for (const row of treatment.rows) {
			allScenes.push(toSceneCol(row, project, episodeLabel));
		}
		sceneRowsList.push(treatment.rows);
	}

	const rows = [...dedupedRows.values()].sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	const flatTreatmentRows = sceneRowsList.flat();
	const presence = computePresence(rows, flatTreatmentRows);
	const cueCounts = await computeCueCounts(app, rows, flatTreatmentRows);
	return { rows, scenes: allScenes, presence, cueCounts };
}

function toSceneCol(
	row: TreatmentRow,
	project: ProjectMeta,
	episodeLabel?: string,
): MatrixSceneCol {
	return {
		sceneName: row.sceneName,
		devNoteFile: row.devNoteFile,
		fountainFile: row.fountainFile,
		indexFilePath: project.indexFilePath,
		episodeLabel,
		missing: row.missing,
	};
}

function computePresence(
	rows: CharacterEntry[],
	treatmentRows: TreatmentRow[],
): boolean[][] {
	const out: boolean[][] = rows.map(() => new Array(treatmentRows.length).fill(false));
	for (let s = 0; s < treatmentRows.length; s++) {
		const scene = treatmentRows[s];
		if (!scene) continue;
		for (const name of scene.characters) {
			const canonical = resolveCharacterByNameOrAlias(rows, name);
			if (!canonical) continue;
			const r = rows.indexOf(canonical);
			if (r === -1) continue;
			const col = out[r];
			if (col) col[s] = true;
		}
	}
	return out;
}

// For each (row, scene) pair, count how many character cues for that row's
// canonical character appear in the scene's fountain. Aliases resolve to
// canonical via resolveCharacterByNameOrAlias. Scenes without a fountain
// contribute zeros.
async function computeCueCounts(
	app: App,
	rows: CharacterEntry[],
	treatmentRows: TreatmentRow[],
): Promise<number[][]> {
	const out: number[][] = rows.map(() => new Array(treatmentRows.length).fill(0));
	for (let s = 0; s < treatmentRows.length; s++) {
		const scene = treatmentRows[s];
		if (!scene || !scene.fountainFile) continue;
		const text = await app.vault.cachedRead(scene.fountainFile);
		const cues = parseCharacterCues(text);
		for (const cue of cues) {
			const canonical = resolveCharacterByNameOrAlias(rows, cue);
			if (!canonical) continue;
			const r = rows.indexOf(canonical);
			if (r === -1) continue;
			const col = out[r];
			if (col) col[s] = (col[s] ?? 0) + 1;
		}
	}
	return out;
}

// Per-row presence count. Used by the frequency sort.
export function countPresence(presenceRow: boolean[] | undefined): number {
	if (!presenceRow) return 0;
	let n = 0;
	for (const v of presenceRow) if (v) n += 1;
	return n;
}

function displayEpisode(p: ProjectMeta): string {
	if (p.projectType !== "tv-episode") return p.title ?? "";
	const ep = p.episode ?? "";
	const t = p.title ?? "";
	return ep ? `${ep}${t ? " — " + t : ""}` : t;
}
