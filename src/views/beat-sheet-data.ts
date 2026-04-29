import type { App, TFile } from "obsidian";
import type { GlobalConfig, ProjectMeta } from "../types";
import { buildTreatmentData, type TreatmentRow } from "./treatment-data";

// Phase 3c — Beat sheet data builder.
//
// Storage model:
//   - Project's Index.md frontmatter has `beats: ["Opening Image", "Catalyst", ...]`
//     defining the canonical ordered list of beats for this project. Empty
//     beats (no scenes yet) still appear so structural gaps are visible.
//   - Each scene's dev note frontmatter has `beat: "Catalyst"` (single-string).
//     Scenes with a beat: not in the declared list are surfaced as ad-hoc
//     groups after the declared list.
//   - Scenes with no beat: at all land in an "Unassigned" pseudo-group.

export interface BeatSceneRef {
	sceneName: string;
	devNoteFile: TFile | null;
	fountainFile: TFile | null;
}

export interface BeatGroup {
	beat: string;          // beat name (or "Unassigned" for the pseudo-group)
	isDeclared: boolean;   // present in Index.md beats: array
	isUnassigned: boolean; // true only for the catch-all pseudo-group
	scenes: BeatSceneRef[];
}

export interface BeatSheetData {
	project: ProjectMeta;
	declaredBeats: string[];
	groups: BeatGroup[];
}

export const UNASSIGNED_BEAT = "Unassigned";

export function buildBeatSheet(
	app: App,
	project: ProjectMeta,
	cfg: GlobalConfig,
): BeatSheetData {
	const declaredBeats = readDeclaredBeats(app, project);

	// Group scenes by beat name (case-insensitive comparison preserves declared
	// casing for display).
	const declaredByUpper = new Map<string, string>();
	for (const beat of declaredBeats) {
		declaredByUpper.set(beat.trim().toUpperCase(), beat.trim());
	}

	const declaredScenes = new Map<string, BeatSceneRef[]>();
	for (const beat of declaredBeats) declaredScenes.set(beat, []);

	const adhocScenes = new Map<string, BeatSceneRef[]>(); // ad-hoc beat → scenes
	const unassigned: BeatSceneRef[] = [];

	const treatment = buildTreatmentData(app, project, cfg);
	for (const row of treatment.rows) {
		const ref = toRef(row);
		const beat = readSceneBeat(app, row);
		if (!beat) {
			unassigned.push(ref);
			continue;
		}
		const declaredMatch = declaredByUpper.get(beat.trim().toUpperCase());
		if (declaredMatch) {
			declaredScenes.get(declaredMatch)?.push(ref);
			continue;
		}
		const list = adhocScenes.get(beat) ?? [];
		list.push(ref);
		adhocScenes.set(beat, list);
	}

	const groups: BeatGroup[] = [];
	for (const beat of declaredBeats) {
		groups.push({
			beat,
			isDeclared: true,
			isUnassigned: false,
			scenes: declaredScenes.get(beat) ?? [],
		});
	}
	const adhocBeats = [...adhocScenes.keys()].sort((a, b) => a.localeCompare(b));
	for (const beat of adhocBeats) {
		groups.push({
			beat,
			isDeclared: false,
			isUnassigned: false,
			scenes: adhocScenes.get(beat) ?? [],
		});
	}
	if (unassigned.length > 0) {
		groups.push({
			beat: UNASSIGNED_BEAT,
			isDeclared: false,
			isUnassigned: true,
			scenes: unassigned,
		});
	}

	return { project, declaredBeats, groups };
}

function toRef(row: TreatmentRow): BeatSceneRef {
	return {
		sceneName: row.sceneName,
		devNoteFile: row.devNoteFile,
		fountainFile: row.fountainFile,
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

function readSceneBeat(app: App, row: TreatmentRow): string | null {
	if (!row.devNoteFile) return null;
	const fm = app.metadataCache.getFileCache(row.devNoteFile)?.frontmatter as
		| Record<string, unknown>
		| undefined;
	const raw = fm?.beat;
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	return trimmed === "" ? null : trimmed;
}
