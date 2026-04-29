import type { ProjectMeta } from "../types";

// Centralised display helpers for project labels. Two views: full (title +
// subtitle when present, e.g. "Babylon: Rise of a Shotta") and primary
// (just the title, used in breadcrumbs and other tight surfaces where a
// long full title would crowd).
//
// For series and features: title is the primary name. For tv-episode
// projects: the "primary" still surfaces the parent series/episode-code
// pattern that other code already builds — those callers keep their own
// formatting.
//
// Falls back to the project folder name when title is missing — same
// fallback used by deriveNoteTag in note-tag.ts.

export function displayProjectFullTitle(p: ProjectMeta): string {
	const primary = displayProjectPrimaryTitle(p);
	const subtitle = p.subtitle?.trim();
	if (subtitle && subtitle !== "") return `${primary}: ${subtitle}`;
	return primary;
}

export function displayProjectPrimaryTitle(p: ProjectMeta): string {
	const t = p.title?.trim();
	if (t && t !== "") return t;
	return lastSegment(p.projectRootPath);
}

function lastSegment(path: string): string {
	return path.split("/").pop() ?? path;
}
