import type { TFile } from "obsidian";
import type { ProjectMeta } from "../types";
import type { ProjectScanner } from "./scanner";

// Resolves which project an arbitrary file belongs to. Compares against the resolved
// scene-folder absolute path (not the folder name) so multiple projects can share the
// same sceneFolder string. The most specific match wins, supporting nested projects.

export function resolveActiveProject(
	file: TFile | null,
	scanner: ProjectScanner,
): ProjectMeta | null {
	if (!file) return null;

	let best: ProjectMeta | null = null;
	for (const meta of scanner.projects.values()) {
		if (file.path === meta.indexFilePath) return meta;
		const prefix = meta.sceneFolderPath + "/";
		if (file.path.startsWith(prefix)) {
			if (!best || meta.sceneFolderPath.length > best.sceneFolderPath.length) {
				best = meta;
			}
		}
	}
	return best;
}
