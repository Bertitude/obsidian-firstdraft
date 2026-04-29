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
// `sequenceName` is the user-facing name (e.g. "Cold Open"); the suffix is added.
export function fountainFilename(sequenceName: string, format: FountainFileFormat): string {
	return format === "fountain-md" ? `${sequenceName}.fountain.md` : `${sequenceName}.fountain`;
}

// Returns what Longform's scenes: array entry should be for a fountain file.
// This is the file's basename — Longform looks up files by basename inside
// sequenceFolder, so `Cold Open.fountain.md` (basename = "Cold Open.fountain")
// stores as "Cold Open.fountain" in the array.
export function fountainScenesArrayEntry(sequenceName: string, format: FountainFileFormat): string {
	return format === "fountain-md" ? `${sequenceName}.fountain` : sequenceName;
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
//
// Tolerates two structural shapes:
//   - flat:   <folder>/<entry>[.fountain[.md]]
//   - folder: <folder>/<stem>/<entry>[.fountain[.md]]
//
// The folder shape is created by atomization (sequence becomes its own folder
// containing a Scenes/ subfolder). Both shapes are checked so existing flat
// sequences keep working alongside atomized folder-shaped ones.
export function fountainPathCandidates(folder: string, entry: string): string[] {
	if (entry.endsWith(".fountain")) {
		const stem = entry.slice(0, -FOUNTAIN_MD_SUFFIX.length);
		return [
			`${folder}/${entry}.md`,                  // flat .fountain.md
			`${folder}/${entry}`,                     // flat .fountain
			`${folder}/${stem}/${entry}.md`,          // folder shape .fountain.md
			`${folder}/${stem}/${entry}`,             // folder shape .fountain
		];
	}
	return [
		`${folder}/${entry}.fountain`,                // flat .fountain
		`${folder}/${entry}.fountain.md`,             // flat .fountain.md
		`${folder}/${entry}/${entry}.fountain`,       // folder shape .fountain
		`${folder}/${entry}/${entry}.fountain.md`,    // folder shape .fountain.md
	];
}

// Build candidate paths for a sequence DEV NOTE. Mirrors the fountain side:
// flat dev note vs folder-shaped (atomized) dev note.
//
//   flat:   <devSequencesFolder>/<name>.md
//   folder: <devSequencesFolder>/<name>/<name>.md
//
// `name` is the human-friendly sequence name (no extension parts). Caller
// uses the first existing match.
export function devNotePathCandidates(devSequencesFolder: string, name: string): string[] {
	return [
		`${devSequencesFolder}/${name}.md`,           // flat
		`${devSequencesFolder}/${name}/${name}.md`,   // folder shape
	];
}
