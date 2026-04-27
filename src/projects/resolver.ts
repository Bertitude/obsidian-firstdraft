import type { TFile } from "obsidian";
import type { ProjectMeta } from "../types";
import type { ProjectScanner } from "./scanner";

// Resolves which project an arbitrary file belongs to. We match by project root
// (the folder containing Index.md), not by the Longform sceneFolder. Many vaults
// have Longform projects where sceneFolder is "." or pointed at a different folder
// than where fountain files actually live; matching by root makes the panel work
// regardless of how the user's Longform projects are configured. Most-specific
// (longest) project root wins, supporting nested projects.

export function resolveActiveProject(
	file: TFile | null,
	scanner: ProjectScanner,
): ProjectMeta | null {
	if (!file) return null;

	let best: ProjectMeta | null = null;
	for (const meta of scanner.projects.values()) {
		if (file.path === meta.indexFilePath) return meta;
		const prefix = meta.projectRootPath + "/";
		if (file.path.startsWith(prefix)) {
			if (!best || meta.projectRootPath.length > best.projectRootPath.length) {
				best = meta;
			}
		}
	}
	return best;
}
