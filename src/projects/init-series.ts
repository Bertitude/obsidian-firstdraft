import { App, Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { GlobalConfig } from "../types";
import { resolveProjectSettings } from "../settings/resolve";
import { activateProjectHomeView } from "../views/project-home-view";
import { FolderSuggest } from "../utils/folder-suggest";
import { yamlString } from "../utils/yaml";

// "Initialize series root" — creates a series-kind Index.md at a folder that
// already contains episode projects (the migration path for setups like
// Babylon that pre-date the series-as-project model). Doesn't move or
// modify any existing episodes; just adds the series root so they hang off
// it in the picker / Project Home.
//
// Defaults the target folder to the active file's grandparent (the typical
// shape: <Series>/Seasons/S01/Episode/Index.md → grandparent of grandparent
// is the series root). User can pick a different folder.

export function runInitializeSeriesRootCommand(plugin: FirstDraftPlugin): void {
	const active = plugin.app.workspace.getActiveFile();
	const guess = active ? guessSeriesRoot(plugin, active) : "";
	new InitializeSeriesRootModal(plugin, guess).open();
}

function guessSeriesRoot(plugin: FirstDraftPlugin, file: TFile): string {
	// If the active file is inside an episode project, walk up past the
	// episode → seasons folder → season folder, landing on the likely
	// series root. If the active file is somewhere else, return its parent
	// as a reasonable starting point.
	for (const meta of plugin.scanner.projects.values()) {
		if (meta.projectType !== "tv-episode") continue;
		const prefix = meta.projectRootPath + "/";
		if (file.path === meta.indexFilePath || file.path.startsWith(prefix)) {
			// Walk up two levels: <series>/Seasons/SXX/<episode>
			const segs = meta.projectRootPath.split("/");
			if (segs.length >= 3) return segs.slice(0, -2).join("/");
			return file.parent?.path ?? "";
		}
	}
	return file.parent?.path ?? "";
}

class InitializeSeriesRootModal extends Modal {
	private title = "";
	private subtitle = "";
	private folderPath: string;

	constructor(
		private readonly plugin: FirstDraftPlugin,
		guessFolder: string,
	) {
		super(plugin.app);
		this.folderPath = guessFolder;
		// Pre-fill title from the folder's last segment so the common case is
		// a single Enter press to confirm.
		this.title = lastSegment(guessFolder);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Initialize series root" });
		contentEl.createEl("p", {
			text: "Adds a series-kind Index.md at the chosen folder so existing episodes inside it hang off a series root. Doesn't touch existing episodes.",
			cls: "firstdraft-modal-help",
		});

		new Setting(contentEl)
			.setName("Series folder")
			.setDesc("The folder that contains the series. Episodes should already live inside.")
			.addText((t) => {
				t.setPlaceholder("(vault root)")
					.setValue(this.folderPath)
					.onChange((v) => {
						this.folderPath = v.trim();
						// Auto-update title to match the new folder's last segment
						// (cheap heuristic; user can override).
						this.title = lastSegment(this.folderPath);
					});
				new FolderSuggest(this.plugin.app, t.inputEl);
			});

		new Setting(contentEl)
			.setName("Series title")
			.setDesc("Primary name for the series. Defaults to the folder name.")
			.addText((t) =>
				t.setPlaceholder(lastSegment(this.folderPath))
					.setValue(this.title)
					.onChange((v) => {
						this.title = v.trim();
					}),
			);

		new Setting(contentEl)
			.setName("Subtitle")
			.setDesc('Optional. Shown alongside the title as "Title: Subtitle" (e.g. Power: Book II).')
			.addText((t) =>
				t.setPlaceholder("(none)").onChange((v) => {
					this.subtitle = v.trim();
				}),
			);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Initialize")
					.setCta()
					.onClick(() => {
						void this.run();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async run(): Promise<void> {
		const folderPath = this.folderPath.trim();
		if (!folderPath) {
			new Notice("Folder is required.");
			return;
		}
		const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) {
			new Notice(`Folder not found: ${folderPath}`);
			return;
		}

		const indexPath = normalizePath(`${folderPath}/Index.md`);
		const existing = this.plugin.app.vault.getAbstractFileByPath(indexPath);
		if (existing) {
			new Notice(`An Index.md already exists at "${folderPath}". Aborting to avoid overwriting.`);
			return;
		}

		const cfg = resolveProjectSettings(null, this.plugin.settings);
		const title = this.title.trim() || lastSegment(folderPath);

		try {
			const created = await this.plugin.app.vault.create(
				indexPath,
				seriesIndexBody(title, this.subtitle, cfg),
			);
			this.close();
			await this.plugin.app.workspace.getLeaf(false).openFile(created);
			void activateProjectHomeView(this.plugin);
			const fullName = this.subtitle ? `${title}: ${this.subtitle}` : title;
			new Notice(`Initialized series "${fullName}".`);
		} catch (e) {
			new Notice(`Initialize failed: ${(e as Error).message}`);
		}
	}
}

function seriesIndexBody(title: string, subtitle: string, cfg: GlobalConfig): string {
	const subtitleLine = subtitle ? `\nsubtitle: ${yamlString(subtitle)}` : "";
	return `---
title: ${yamlString(title)}${subtitleLine}
firstdraft:
  kind: series
---

# ${title}

> Series root initialized. Episodes inside \`${cfg.seasonsFolder}/\` will
> appear in Project Home automatically. Use **Create episode** to add new
> ones.
`;
}

function lastSegment(path: string): string {
	return path.split("/").pop() ?? path;
}
