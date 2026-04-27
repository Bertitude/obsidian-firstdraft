import { App, TFile } from "obsidian";

// Read and write the `longform.scenes` array in a project's Index.md frontmatter.
// Longform stores it as an array of strings (basenames in script order). The
// scanner already validates that `longform` is a non-array object before adding
// projects to the map, so the index file is guaranteed to have it.

export function readScenesArray(app: App, indexPath: string): string[] {
	const file = app.vault.getAbstractFileByPath(indexPath);
	if (!(file instanceof TFile)) return [];

	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	const longform = fm?.longform as { scenes?: unknown } | undefined;
	const scenes = longform?.scenes;
	if (!Array.isArray(scenes)) return [];

	return scenes.filter((s): s is string => typeof s === "string");
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
		const longform = (fm.longform as Record<string, unknown> | undefined) ?? {};
		longform.scenes = scenes;
		fm.longform = longform;
	});
}
