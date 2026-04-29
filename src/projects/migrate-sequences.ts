import { Notice, TFile } from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "./resolver";
import { snapshotFile, todayLabel } from "../versioning/snapshot";

// Renames the legacy inner keys `sceneFolder` → `sequenceFolder` and
// `scenes` → `sequences` inside the project's frontmatter block (works for
// both `firstdraft:` and `longform:` blocks). Idempotent — projects already
// using the new names are skipped. Snapshots before rewriting.

export async function runMigrateSequencesNamingCommand(
	plugin: FirstDraftPlugin,
): Promise<void> {
	const active = plugin.app.workspace.getActiveFile();
	if (!active) {
		new Notice("Open a file inside a project first.");
		return;
	}
	const project = resolveActiveProject(active, plugin.scanner);
	if (!project) {
		new Notice("Active file isn't inside a recognised project.");
		return;
	}

	const indexFile = plugin.app.vault.getAbstractFileByPath(project.indexFilePath);
	if (!(indexFile instanceof TFile)) {
		new Notice("Index file not found.");
		return;
	}

	let renamedFolderKey = false;
	let renamedScenesKey = false;
	let foundBlockKey: string | null = null;

	await snapshotFile(plugin.app, indexFile, `pre-sequences-rename ${todayLabel()}`);

	await plugin.app.fileManager.processFrontMatter(
		indexFile,
		(fm: Record<string, unknown>) => {
			for (const key of ["firstdraft", "longform"]) {
				const v = fm[key];
				if (!v || typeof v !== "object" || Array.isArray(v)) continue;
				const block = v as Record<string, unknown>;
				foundBlockKey = key;
				if ("sceneFolder" in block && !("sequenceFolder" in block)) {
					block.sequenceFolder = block.sceneFolder;
					delete block.sceneFolder;
					renamedFolderKey = true;
				}
				if ("scenes" in block && !("sequences" in block)) {
					block.sequences = block.scenes;
					delete block.scenes;
					renamedScenesKey = true;
				}
				fm[key] = block;
				break;
			}
		},
	);

	if (!foundBlockKey) {
		new Notice("No firstdraft: or longform: block found.");
		return;
	}
	if (!renamedFolderKey && !renamedScenesKey) {
		new Notice("Already using sequence naming.");
		return;
	}

	const parts: string[] = [];
	if (renamedFolderKey) parts.push("sceneFolder → sequenceFolder");
	if (renamedScenesKey) parts.push("scenes → sequences");
	new Notice(`Renamed: ${parts.join(", ")}`, 6000);
}
