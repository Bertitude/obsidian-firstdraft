import { Notice, TFile } from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "./resolver";
import { snapshotFile, todayLabel } from "../versioning/snapshot";

// Migrate the active project's Index.md from `longform:` to `firstdraft:`
// frontmatter shape. Same keys (sequenceFolder, scenes), just renamed.
// Idempotent — projects already on the new schema are skipped. Snapshots the
// index file before rewriting so a restore is always available.

export async function runMigrateSchemaFromLongformCommand(
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

	type Outcome = "migrated" | "already-firstdraft" | "no-longform";
	let outcome: Outcome = "no-longform" as Outcome;

	// Snapshot before mutating frontmatter.
	await snapshotFile(plugin.app, indexFile, `pre-schema-migrate ${todayLabel()}`);

	await plugin.app.fileManager.processFrontMatter(
		indexFile,
		(fm: Record<string, unknown>) => {
			const hasFirstdraft =
				fm.firstdraft &&
				typeof fm.firstdraft === "object" &&
				!Array.isArray(fm.firstdraft);
			const hasLongform =
				fm.longform &&
				typeof fm.longform === "object" &&
				!Array.isArray(fm.longform);

			if (hasFirstdraft) {
				outcome = "already-firstdraft";
				return;
			}
			if (!hasLongform) {
				outcome = "no-longform";
				return;
			}

			fm.firstdraft = { ...(fm.longform as Record<string, unknown>) };
			delete fm.longform;
			outcome = "migrated";
		},
	);

	switch (outcome) {
		case "migrated":
			new Notice(
				`Migrated "${project.title ?? project.projectRootPath}" to FirstDraft schema. You can uninstall Longform if you'd like.`,
				6000,
			);
			break;
		case "already-firstdraft":
			new Notice("Already on FirstDraft schema.");
			break;
		case "no-longform":
			new Notice("No `longform:` block found to migrate.");
			break;
	}
}
