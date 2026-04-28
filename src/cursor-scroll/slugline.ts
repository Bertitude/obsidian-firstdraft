// Slugline detection and normalization for cursor-aware section scroll.
// A slugline is a fountain scene heading: INT./EXT./INT./EXT./I/E. line in ALL CAPS.

const SLUGLINE_RE = /^(INT|EXT|INT\.\/EXT|I\/E)[.\s]/i;

// Walks upward from `cursorLine` looking for the nearest slugline. Returns the
// raw line text (trimmed) or null if no slugline is found above the cursor.
export function findSluglineAtOrAbove(text: string, cursorLine: number): string | null {
	const lines = text.split(/\r?\n/);
	const start = Math.min(Math.max(cursorLine, 0), lines.length - 1);
	for (let i = start; i >= 0; i--) {
		const raw = (lines[i] ?? "").trim();
		if (raw === "") continue;
		if (SLUGLINE_RE.test(raw)) return raw;
	}
	return null;
}

// Normalize a slugline (or H2 text) for comparison: strip leading hashes,
// strip trailing parenthetical extensions like "(CONTINUOUS)", uppercase,
// collapse whitespace. Forgiving so a slugline `INT. CAR - DAY (CONTINUOUS)`
// matches an H2 `## INT. CAR - DAY`.
export function normalizeSlugline(s: string): string {
	return s
		.replace(/^#+\s*/, "")
		.replace(/\s*\([^)]*\)\s*$/, "")
		.trim()
		.toUpperCase()
		.replace(/\s+/g, " ");
}
