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
