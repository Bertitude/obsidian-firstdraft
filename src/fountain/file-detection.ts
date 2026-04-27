import type { TFile } from "obsidian";

// Fountain files exist in two formats across the FirstDraft ecosystem:
//
//   "fountain"     — files with extension `.fountain` (Cold Open.fountain).
//                    Default for projects on bgrundmann's plugin or any setup
//                    where the .fountain extension is registered to a custom
//                    view.
//
//   "fountain-md"  — files with chained extension `.fountain.md` (Cold Open
//                    .fountain.md). Required for projects on chuangcaleb's
//                    plugin where Obsidian must see the file as Markdown for
//                    Longform compile to include it. Obsidian reports
//                    `extension === "md"` and `basename === "Cold Open.fountain"`
//                    for these files.
//
// FirstDraft accepts both formats during read so projects with mixed history
// keep working. New file creation uses whichever format the user has
// configured globally (fountainFileFormat setting).

export type FountainFileFormat = "fountain" | "fountain-md";

const FOUNTAIN_MD_SUFFIX = ".fountain";

export function isFountainFile(file: TFile): boolean {
	if (file.extension === "fountain") return true;
	if (file.extension === "md" && file.basename.endsWith(FOUNTAIN_MD_SUFFIX)) return true;
	return false;
}

// Returns the human-friendly scene name without any fountain-related extension
// parts. Used for display, dev-note pairing, treatment view rows, etc.
//
//   Cold Open.fountain        → "Cold Open"
//   Cold Open.fountain.md     → "Cold Open"
//   Cold Open.md              → "Cold Open" (non-fountain, but defensive)
export function fountainSceneName(file: TFile): string {
	if (file.extension === "fountain") return file.basename;
	if (file.extension === "md" && file.basename.endsWith(FOUNTAIN_MD_SUFFIX)) {
		return file.basename.slice(0, -FOUNTAIN_MD_SUFFIX.length);
	}
	return file.basename;
}

// Same logic but operating on a raw path string (no TFile available). Used by
// path-comparison code in the resolver and treatment data.
export function fountainSceneNameFromPath(path: string): string {
	const filename = path.split("/").pop() ?? path;
	if (filename.endsWith(".fountain.md")) {
		return filename.slice(0, -".fountain.md".length);
	}
	if (filename.endsWith(".fountain")) {
		return filename.slice(0, -".fountain".length);
	}
	if (filename.endsWith(".md")) {
		return filename.slice(0, -".md".length);
	}
	return filename;
}

// Build the filename for a NEW scene file based on the configured format.
// `sceneName` is the user-facing name (e.g. "Cold Open"); the suffix is added.
export function fountainFilename(sceneName: string, format: FountainFileFormat): string {
	return format === "fountain-md" ? `${sceneName}.fountain.md` : `${sceneName}.fountain`;
}

// Returns what Longform's scenes: array entry should be for a fountain file.
// This is the file's basename — Longform looks up files by basename inside
// sceneFolder, so `Cold Open.fountain.md` (basename = "Cold Open.fountain")
// stores as "Cold Open.fountain" in the array.
export function fountainScenesArrayEntry(sceneName: string, format: FountainFileFormat): string {
	return format === "fountain-md" ? `${sceneName}.fountain` : sceneName;
}

// Inverse: given a Longform scenes-array entry, return the human-friendly
// scene name (without any .fountain suffix). Used for dev-note lookup and
// display in treatment view rows.
export function sceneNameFromArrayEntry(entry: string): string {
	if (entry.endsWith(".fountain")) return entry.slice(0, -FOUNTAIN_MD_SUFFIX.length);
	return entry;
}

// Build candidate full file paths for a scenes-array entry inside a fountain
// folder. Returns paths to try in order — caller looks up each via vault and
// uses the first match. Defaults to the most likely path if none exist.
export function fountainPathCandidates(folder: string, entry: string): string[] {
	if (entry.endsWith(".fountain")) {
		// New format: entry already includes .fountain, so file is .fountain.md
		return [`${folder}/${entry}.md`, `${folder}/${entry}`];
	}
	// Legacy: entry is plain basename, file is .fountain
	return [`${folder}/${entry}.fountain`, `${folder}/${entry}.fountain.md`];
}
