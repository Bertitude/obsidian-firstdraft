import { Notice, TFile } from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "./resolver";
import { promptForLabel } from "../versioning/prompt";

// "Set project title" command. Prompts for a new title and writes it to the
// active project's Index.md frontmatter as `title:`. Used to clean up
// projects whose frontmatter doesn't have a title set yet — these otherwise
// fall back to the project's folder name in the picker, the project notes
// panel header, and the auto-derived note tag (which is annoying because
// the auto-derived tag bakes the folder name in: `#fraidy-fraidy` is fine,
// `#project-development-film-fraidy-fraidy` is not).

export async function runSetProjectTitleCommand(
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

	const current = project.title ?? "";
	const next = await promptForLabel(plugin.app, {
		title: "Set project title",
		description: "Display name for this project. Used in the picker, panel headers, and the default note tag.",
		defaultValue: current,
	});
	if (next === null) return;
	if (next === current) {
		new Notice("Title unchanged.");
		return;
	}

	await plugin.app.fileManager.processFrontMatter(
		indexFile,
		(fm: Record<string, unknown>) => {
			fm.title = next;
		},
	);
	new Notice(`Project title set to "${next}".`);
}
