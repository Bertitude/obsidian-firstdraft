// Stable ID utilities for scene files. The ID is a 4-char hex string appended
// to the scene's filename basename and stored in the dev note's `id:`
// frontmatter field. New scenes auto-generate one; existing scenes can be
// backfilled per-project via the "Migrate project to stable IDs" command.
//
// Format: 4 hex chars suffix preceded by hyphen, e.g. "Big Damn Heroes-a3b9".
// 65,536 combinations — collision risk astronomically low for project-scale
// counts. We don't enforce uniqueness on generation; on the rare collision
// the caller (migration / creation) can regenerate.

export const ID_LENGTH = 4;
export const ID_SUFFIX_RE = /-([0-9a-f]{4})$/;

export function generateId(): string {
	return Math.floor(Math.random() * 0x10000)
		.toString(16)
		.padStart(ID_LENGTH, "0");
}

// Returns the ID embedded in a scene name (basename without `.fountain` or
// `.md` extensions), or null if no ID present.
//   "Big Damn Heroes-a3b9" → "a3b9"
//   "Big Damn Heroes"      → null
export function extractId(sceneName: string): string | null {
	const m = ID_SUFFIX_RE.exec(sceneName);
	return m ? (m[1] ?? null) : null;
}

// Returns the scene name with the ID suffix removed (or unchanged if no ID).
//   "Big Damn Heroes-a3b9" → "Big Damn Heroes"
//   "Big Damn Heroes"      → "Big Damn Heroes"
export function stripId(sceneName: string): string {
	return sceneName.replace(ID_SUFFIX_RE, "");
}

// Append an ID suffix to a scene name. If the name already has one, replaces
// it. Used during migration and rename-preservation flows.
export function applyId(sceneName: string, id: string): string {
	return `${stripId(sceneName)}-${id}`;
}

// Generate an ID that doesn't collide with any of the provided existing IDs.
// Loops up to a small bound; on the off chance all 65k IDs are taken, returns
// the last attempt.
export function generateUniqueId(existing: ReadonlySet<string>): string {
	for (let i = 0; i < 16; i++) {
		const candidate = generateId();
		if (!existing.has(candidate)) return candidate;
	}
	return generateId();
}
