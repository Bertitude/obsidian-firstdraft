import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";

// Find all episodes in the same series + same season as the given project.
// Returned in episode-code order (S01E01, S01E02, …) for stable rendering.
// Used by treatment view and character matrix in their season modes.
export function findSiblingEpisodes(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
): ProjectMeta[] {
	if (project.projectType !== "tv-episode" || !project.series || !project.season) {
		return [project];
	}
	const matches: ProjectMeta[] = [];
	for (const meta of plugin.scanner.projects.values()) {
		if (
			meta.projectType === "tv-episode" &&
			meta.series === project.series &&
			meta.season === project.season
		) {
			matches.push(meta);
		}
	}
	matches.sort((a, b) => (a.episode ?? "").localeCompare(b.episode ?? ""));
	return matches.length > 0 ? matches : [project];
}
