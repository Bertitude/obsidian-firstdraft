import { App, TFile } from "obsidian";
import { projectBlockKey, readProjectBlock } from "../projects/scanner";

// Read and write the project's `scenes` array. Stored under either
// `firstdraft:` (new) or `longform:` (legacy). Both shapes have the same
// `scenes: string[]` key. Reads prefer `firstdraft:`; writes update whichever
// block is currently present (preserving legacy projects intact). Newly-
// created projects should put their block under `firstdraft:`.

export function readScenesArray(app: App, indexPath: string): string[] {
	const file = app.vault.getAbstractFileByPath(indexPath);
	if (!(file instanceof TFile)) return [];

	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	if (!fm) return [];
	const block = readProjectBlock(fm);
	// Prefer the new `sequences` key; fall back to `scenes` for legacy projects.
	const list = block?.sequences ?? block?.scenes;
	if (!Array.isArray(list)) return [];

	return list.filter((s): s is string => typeof s === "string");
}

export async function writeScenesArray(
	app: App,
	indexPath: string,
	scenes: string[],
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(indexPath);
	if (!(file instanceof TFile)) {
		throw new Error(`Index file not found: ${indexPath}`);
	}
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		// Update whichever block is already present; default to `firstdraft:`
		// for projects that have neither yet. Within the block, write to
		// whichever key is currently in use — `sequences` (new) or `scenes`
		// (legacy). New projects (no existing key) get `sequences`.
		const key = projectBlockKey(fm) ?? "firstdraft";
		const block = (fm[key] as Record<string, unknown> | undefined) ?? {};
		const innerKey = "sequences" in block ? "sequences" : "scenes" in block ? "scenes" : "sequences";
		block[innerKey] = scenes;
		fm[key] = block;
	});
}

// Append an entry to the project's sequences array if it isn't already
// present. Idempotent — safe to call from creation paths that may overlap
// with the rename-sync auto-inject (e.g. dev-note-first creation followed
// later by fountain creation).
export async function appendSceneToArray(
	app: App,
	indexPath: string,
	entry: string,
): Promise<void> {
	const existing = readScenesArray(app, indexPath);
	if (existing.includes(entry)) return;
	await writeScenesArray(app, indexPath, [...existing, entry]);
}

// Remove an entry from the project's sequences array. Tolerates entries
// stored under either fountain-format shape (plain basename or basename
// with `.fountain` suffix) so the caller doesn't have to guess which
// format the project is using. No-op if no match is found.
export async function removeSceneFromArray(
	app: App,
	indexPath: string,
	entry: string,
): Promise<void> {
	const existing = readScenesArray(app, indexPath);
	const stripped = entry.endsWith(".fountain") ? entry.slice(0, -".fountain".length) : entry;
	const next = existing.filter((e) => {
		const eStripped = e.endsWith(".fountain") ? e.slice(0, -".fountain".length) : e;
		return eStripped !== stripped;
	});
	if (next.length === existing.length) return;
	await writeScenesArray(app, indexPath, next);
}
