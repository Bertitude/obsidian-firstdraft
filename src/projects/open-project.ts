import { Notice, SuggestModal, TFile } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { activateProjectHomeView } from "../views/project-home-view";

// "Open FirstDraft project" command. Lists all projects the scanner has
// detected — i.e. files with a `longform: { sequenceFolder: "..." }`
// frontmatter, which is FirstDraft's substrate. Picking one opens its
// index file in the main editor and activates Project Home in the left
// sidebar so navigation lands ready-to-go.

export function runOpenFirstDraftProjectCommand(plugin: FirstDraftPlugin): void {
	const projects = [...plugin.scanner.projects.values()];
	if (projects.length === 0) {
		new Notice("No FirstDraft projects detected. Add `longform:` frontmatter to a project's Index.md.");
		return;
	}
	new ProjectPickerModal(plugin, projects).open();
}

class ProjectPickerModal extends SuggestModal<ProjectMeta> {
	constructor(
		private readonly plugin: FirstDraftPlugin,
		private readonly projects: ProjectMeta[],
	) {
		super(plugin.app);
		this.setPlaceholder("Pick a FirstDraft project to open…");
	}

	getSuggestions(query: string): ProjectMeta[] {
		const sorted = this.sorted();
		const q = query.trim().toUpperCase();
		if (q === "") return sorted;
		return sorted.filter((p) =>
			[displayProject(p), p.projectRootPath]
				.join(" ")
				.toUpperCase()
				.includes(q),
		);
	}

	renderSuggestion(value: ProjectMeta, el: HTMLElement): void {
		el.createDiv({ text: displayProject(value) });
		const kind = value.projectType === "tv-episode" ? "TV episode" : "Feature";
		el.createEl("small", {
			text: `${kind} · ${value.projectRootPath}`,
			cls: "firstdraft-suggestion-meta",
		});
	}

	onChooseSuggestion(value: ProjectMeta): void {
		void this.openProject(value);
	}

	private async openProject(project: ProjectMeta): Promise<void> {
		const indexFile = this.plugin.app.vault.getAbstractFileByPath(
			project.indexFilePath,
		);
		if (!(indexFile instanceof TFile)) {
			new Notice("Project index file not found.");
			return;
		}
		// Open the index in the main editor so it becomes the active file —
		// Project Home resolves the project from the active file.
		await this.plugin.app.workspace.getLeaf(false).openFile(indexFile);
		void activateProjectHomeView(this.plugin);
	}

	private sorted(): ProjectMeta[] {
		return [...this.projects].sort((a, b) =>
			displayProject(a).localeCompare(displayProject(b)),
		);
	}
}

function displayProject(p: ProjectMeta): string {
	if (p.projectType === "tv-episode") {
		const ep = p.episode ?? "";
		const t = p.title ?? "";
		const series = p.series ?? "";
		return ep
			? `${series} ${ep}${t ? " — " + t : ""}`.trim()
			: t || lastSegment(p.projectRootPath);
	}
	// Feature: prefer frontmatter title, fall back to the project's folder name
	// (NOT the full path — that's where the picker was showing the entire
	// "Project Development/Film/Fraidy Fraidy" string for projects without a
	// title set in frontmatter).
	return p.title ?? lastSegment(p.projectRootPath);
}

function lastSegment(path: string): string {
	return path.split("/").pop() ?? path;
}
