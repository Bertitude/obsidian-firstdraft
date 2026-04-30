import type { CharacterEntry } from "../views/lookups";

// Phase 4g follow-up — Alias collision detection. Two characters claiming
// the same name (whether as a canonical or as an alias) breaks cue
// resolution, since the autocomplete + linkify scanner have no way to
// disambiguate. Detection runs against the project's combined roster
// (the same universe used by characterRoster() — for TV that's episode +
// series; for features it's just the feature).
//
// Pure logic — no app/vault access. Both the inline tag-time check and
// the on-demand audit command call into this module.

export type ClaimSource = "canonical" | "alias";

export interface Claimant {
	entry: CharacterEntry;
	source: ClaimSource;
	// The verbatim string as authored — preserved for display so the
	// audit modal can show the user's casing rather than the normalized
	// uppercase key.
	asWritten: string;
}

export interface AliasCollision {
	// Normalized (uppercased, trimmed) form of the colliding name.
	key: string;
	// Two or more distinct character entries claiming this name. Same-
	// entry duplicates (e.g. an alias literally equal to the entry's own
	// canonical name) are treated separately as `redundancies`.
	claimants: Claimant[];
}

export interface AliasRedundancy {
	entry: CharacterEntry;
	// The alias text as authored.
	alias: string;
}

export interface AliasAuditResult {
	collisions: AliasCollision[];
	redundancies: AliasRedundancy[];
}

// Walk the roster, build a normalized claim map, and partition multi-
// claimants into cross-character collisions vs same-entry redundancies.
// Groups are skipped — `members:` is its own resolution channel and
// "alias" doesn't apply.
export function auditAliases(roster: CharacterEntry[]): AliasAuditResult {
	const claimsByKey = new Map<string, Claimant[]>();
	for (const entry of roster) {
		if (entry.isGroup) continue;
		pushClaim(claimsByKey, entry.name, {
			entry,
			source: "canonical",
			asWritten: entry.folderName,
		});
		for (const alias of entry.aliases) {
			pushClaim(claimsByKey, alias.toUpperCase().trim(), {
				entry,
				source: "alias",
				asWritten: alias,
			});
		}
	}

	const collisions: AliasCollision[] = [];
	const redundancies: AliasRedundancy[] = [];
	for (const [key, claimants] of claimsByKey) {
		if (claimants.length < 2) continue;
		// Group by the entry's identity (folder path is canonical because
		// each character lives in its own folder).
		const distinctEntries = new Map<string, Claimant[]>();
		for (const c of claimants) {
			const id = c.entry.folder.path;
			const bucket = distinctEntries.get(id) ?? [];
			bucket.push(c);
			distinctEntries.set(id, bucket);
		}
		if (distinctEntries.size === 1) {
			// All claims belong to one entry — self-redundancy. Surface
			// each alias claim (the canonical claim is implicit).
			for (const c of claimants) {
				if (c.source === "alias") {
					redundancies.push({ entry: c.entry, alias: c.asWritten });
				}
			}
			continue;
		}
		collisions.push({ key, claimants });
	}

	collisions.sort((a, b) => a.key.localeCompare(b.key));
	redundancies.sort((a, b) =>
		a.entry.folderName.localeCompare(b.entry.folderName),
	);
	return { collisions, redundancies };
}

// Predict whether adding `proposedAlias` to `target` would produce a NEW
// cross-character collision relative to the current roster state.
// Returns the new collision (or null if none) so the caller can show the
// user exactly what it would conflict with — distinct from the existing
// audit result, which surfaces ALL collisions in the project.
export function predictAliasCollision(
	roster: CharacterEntry[],
	target: CharacterEntry,
	proposedAlias: string,
): AliasCollision | null {
	const key = proposedAlias.trim().toUpperCase();
	if (key === "") return null;

	const claimants: Claimant[] = [];
	for (const entry of roster) {
		if (entry.isGroup) continue;
		if (entry.name === key) {
			claimants.push({
				entry,
				source: "canonical",
				asWritten: entry.folderName,
			});
		}
		for (const alias of entry.aliases) {
			if (alias.toUpperCase().trim() === key) {
				claimants.push({ entry, source: "alias", asWritten: alias });
			}
		}
	}
	// Add the proposed claim.
	claimants.push({ entry: target, source: "alias", asWritten: proposedAlias });

	const distinctIds = new Set(claimants.map((c) => c.entry.folder.path));
	if (distinctIds.size < 2) return null;
	return { key, claimants };
}

function pushClaim(
	map: Map<string, Claimant[]>,
	key: string,
	claim: Claimant,
): void {
	const trimmed = key.trim();
	if (trimmed === "") return;
	const bucket = map.get(trimmed) ?? [];
	bucket.push(claim);
	map.set(trimmed, bucket);
}
