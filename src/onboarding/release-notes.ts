// Release entries shown in the "What's new" modal. Newest first.
//
// Each release bumped in manifest.json should add an entry here in the
// same PR. Entries without a corresponding manifest version stay silent
// (the comparator skips them); manifest versions without an entry also
// stay silent (patches that don't warrant a popup). Both are intentional
// — the popup only fires when there's something to say.
//
// `version` MUST match the manifest.json version exactly. `date` is
// authored as ISO yyyy-mm-dd. `title` is a one-line theme; `highlights`
// is a list of short user-visible bullets (not a changelog of every
// commit — focus on what changes for the writer).

export interface ReleaseEntry {
	version: string;
	date: string;
	title: string;
	highlights: string[];
}

export const RELEASE_NOTES: ReleaseEntry[] = [
	{
		version: "0.1.0",
		date: "2026-04-30",
		title: "Initial release",
		highlights: [
			"Project Home for features, series, seasons, and episodes — single landing page per project.",
			"Outline → Break ladder: Series Outline → Make seasons → Season Outline → Make episodes → Treatment → Make sequences. Auto-snapshots before every break.",
			"Slug-line autocomplete (INT/EXT → location → time-of-day) with sub-location support, plus a Clean Up Sluglines command for bulk normalization.",
			"Character cue autocomplete with role classification — Main / Recurring / Guest / Featured Extra for TV, Main / Supporting / Featured Extra for features. Aliases and groups supported.",
			"Alias collision detection: inline check at tag time + Audit alias collisions command.",
			"Dev-notes side panel pairs each fountain with its development note. Cursor-aware scroll keeps the dev note's slug-line H2s in sync as you draft.",
			"First Draft Mode — distraction-free writing layout with one toggle.",
			"Longform-compatible compile via the existing Longform plugin.",
		],
	},
];

// Filter releases newer than `lastSeenVersion`. Inclusive of the current
// version; exclusive of the last seen one. Returns newest first. When
// `lastSeenVersion` is null, returns the entire list (treated as a
// first-install case by callers that look at the welcome path instead).
export function releasesSince(
	lastSeenVersion: string | null,
): ReleaseEntry[] {
	if (lastSeenVersion === null) return [...RELEASE_NOTES];
	return RELEASE_NOTES.filter(
		(r) => compareVersions(r.version, lastSeenVersion) > 0,
	);
}

// Compare two semver-shaped version strings. Returns +1 if a > b,
// -1 if a < b, 0 if equal. Tolerant of missing components (treated as
// 0). Doesn't handle prerelease tags — bump cleanly through `npm version`
// and you'll never need it.
export function compareVersions(a: string, b: string): number {
	const partsA = a.split(".").map((n) => parseInt(n, 10) || 0);
	const partsB = b.split(".").map((n) => parseInt(n, 10) || 0);
	const len = Math.max(partsA.length, partsB.length);
	for (let i = 0; i < len; i++) {
		const x = partsA[i] ?? 0;
		const y = partsB[i] ?? 0;
		if (x > y) return 1;
		if (x < y) return -1;
	}
	return 0;
}
