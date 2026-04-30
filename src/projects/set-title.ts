import { Modal, Notice, Setting, TFile } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "./resolver";

// "Set project title" command. Opens a modal to set/change the active
// project's `title` and `subtitle` frontmatter fields. Used to clean up
// projects whose frontmatter doesn't have a title yet (these fall back to
// the project's folder name everywhere, including the auto-derived note
// tag — `#fraidy-fraidy` is fine, `#project-development-film-fraidy-fraidy`
// is not), and to retrofit subtitles onto existing projects that were
// created before the subtitle field landed.
//
// processFrontMatter handles YAML serialization, so colons and other
// special characters in values are quoted automatically (no manual escape).

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

	new SetTitleModal(plugin, project, indexFile).open();
}

class SetTitleModal extends Modal {
	private titleValue: string;
	private subtitleValue: string;

	constructor(
		private readonly plugin: FirstDraftPlugin,
		private readonly project: ProjectMeta,
		private readonly indexFile: TFile,
	) {
		super(plugin.app);
		this.titleValue = project.title ?? "";
		this.subtitleValue = project.subtitle ?? "";
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Set project title" });

		new Setting(contentEl)
			.setName("Title")
			.setDesc("Primary name for this project. Used in the picker, panel headers, and the default note tag.")
			.addText((t) =>
				t
					.setPlaceholder("Project title")
					.setValue(this.titleValue)
					.onChange((v) => {
						this.titleValue = v;
					}),
			);

		new Setting(contentEl)
			.setName("Subtitle")
			.setDesc('Optional. Shown alongside the title as "title: subtitle". Leave blank to clear.')
			.addText((t) =>
				t
					.setPlaceholder("(none)")
					.setValue(this.subtitleValue)
					.onChange((v) => {
						this.subtitleValue = v;
					}),
			);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Save")
					.setCta()
					.onClick(() => {
						void this.save();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async save(): Promise<void> {
		const newTitle = this.titleValue.trim();
		const newSubtitle = this.subtitleValue.trim();
		const oldTitle = this.project.title ?? "";
		const oldSubtitle = this.project.subtitle ?? "";

		if (newTitle === "") {
			new Notice("Title is required.");
			return;
		}

		if (newTitle === oldTitle && newSubtitle === oldSubtitle) {
			new Notice("Nothing changed.");
			this.close();
			return;
		}

		await this.plugin.app.fileManager.processFrontMatter(
			this.indexFile,
			(fm: Record<string, unknown>) => {
				fm.title = newTitle;
				if (newSubtitle === "") {
					delete fm.subtitle;
				} else {
					fm.subtitle = newSubtitle;
				}
			},
		);
		this.close();
		const fullName = newSubtitle ? `${newTitle}: ${newSubtitle}` : newTitle;
		new Notice(`Project title set to "${fullName}".`);
	}
}

