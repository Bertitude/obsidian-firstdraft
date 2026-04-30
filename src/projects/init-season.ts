import { Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveProjectSettings } from "../settings/resolve";
import { activateProjectHomeView } from "../views/project-home-view";
import { FolderSuggest } from "../utils/folder-suggest";
import { yamlString } from "../utils/yaml";

// "Initialize season root" — creates a season-kind Index.md at a folder
// that already contains episode projects (the migration path for
// pre-season-as-project setups: `<Series>/Seasons/S01/<Episode>/...` with
// no S01-level Index.md). Doesn't move or modify any existing episodes;
// just adds the season root so they hang off it in Project Home.
//
// Defaults the target folder to the active file's parent-of-parent
// (typical episode-inside-season shape: <Series>/Seasons/S01/<Episode>/
// → guessed root is S01). User can pick any folder.

export function runInitializeSeasonRootCommand(plugin: FirstDraftPlugin): void {
	const active = plugin.app.workspace.getActiveFile();
	const guess = active ? guessSeasonRoot(plugin, active) : "";
	new InitializeSeasonRootModal(plugin, guess).open();
}

function guessSeasonRoot(plugin: FirstDraftPlugin, file: TFile): string {
	// If active file is inside an episode project, walk up one level past
	// the episode folder to land on the likely season folder.
	for (const meta of plugin.scanner.projects.values()) {
		if (meta.projectType !== "tv-episode") continue;
		const prefix = meta.projectRootPath + "/";
		if (file.path === meta.indexFilePath || file.path.startsWith(prefix)) {
			const parent = file.parent;
			if (!parent) return file.parent?.path ?? "";
			// meta.projectRootPath is the episode folder; its parent is the
			// season folder.
			const segs = meta.projectRootPath.split("/");
			if (segs.length >= 1) return segs.slice(0, -1).join("/");
		}
	}
	return file.parent?.path ?? "";
}

class InitializeSeasonRootModal extends Modal {
	private folderPath: string;
	private title = "";
	private seasonNumber = "";

	constructor(
		private readonly plugin: FirstDraftPlugin,
		guessFolder: string,
	) {
		super(plugin.app);
		this.folderPath = guessFolder;
		this.seasonNumber = inferSeasonFromFolderName(guessFolder);
		this.title =
			this.seasonNumber !== ""
				? `Season ${parseInt(this.seasonNumber, 10)}`
				: lastSegment(guessFolder);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Initialize season root" });
		contentEl.createEl("p", {
			text: "Adds a season-kind Index.md at the chosen folder so existing episodes inside it hang off a season root. Doesn't touch existing episodes.",
			cls: "firstdraft-modal-help",
		});

		new Setting(contentEl)
			.setName("Season folder")
			.setDesc("The folder that contains the episodes (e.g. S01).")
			.addText((t) => {
				t.setPlaceholder("(vault root)")
					.setValue(this.folderPath)
					.onChange((v) => {
						this.folderPath = v.trim();
						this.seasonNumber = inferSeasonFromFolderName(this.folderPath);
						if (this.seasonNumber !== "")
							this.title = `Season ${parseInt(this.seasonNumber, 10)}`;
					});
				new FolderSuggest(this.plugin.app, t.inputEl);
			});

		new Setting(contentEl)
			.setName("Season number")
			.setDesc("Two-digit. Auto-detected from the folder name when it matches S<NN>.")
			.addText((t) =>
				t
					.setPlaceholder("01")
					.setValue(this.seasonNumber)
					.onChange((v) => {
						this.seasonNumber = v.trim();
					}),
			);

		new Setting(contentEl)
			.setName("Title")
			.setDesc('Display name. Defaults to "Season N".')
			.addText((t) =>
				t
					.setPlaceholder('e.g. "Season 1" or "Book II"')
					.setValue(this.title)
					.onChange((v) => {
						this.title = v.trim();
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
		if (this.plugin.app.vault.getAbstractFileByPath(indexPath)) {
			new Notice(`An Index.md already exists at "${folderPath}". Aborting.`);
			return;
		}

		const seasonNum = normalizeSeasonNumber(this.seasonNumber);
		if (!seasonNum) {
			new Notice("Season number must be numeric.");
			return;
		}

		const cfg = resolveProjectSettings(null, this.plugin.settings);
		void cfg;
		const title = this.title.trim() || `Season ${parseInt(seasonNum, 10)}`;

		// Try to find the parent series for the series field. If the chosen
		// folder is inside a series project, use that series's title.
		const parentSeriesTitle = this.findParentSeriesTitle(folderPath);

		try {
			const created = await this.plugin.app.vault.create(
				indexPath,
				seasonIndexBody(title, parentSeriesTitle, seasonNum),
			);
			this.close();
			await this.plugin.app.workspace.getLeaf(false).openFile(created);
			void activateProjectHomeView(this.plugin);
			new Notice(`Initialized ${title}.`);
		} catch (e) {
			new Notice(`Initialize failed: ${(e as Error).message}`);
		}
	}

	private findParentSeriesTitle(folderPath: string): string {
		for (const meta of this.plugin.scanner.projects.values()) {
			if (meta.projectType !== "series") continue;
			const prefix = meta.projectRootPath + "/";
			if (folderPath === meta.projectRootPath || folderPath.startsWith(prefix)) {
				return meta.title ?? lastSegment(meta.projectRootPath);
			}
		}
		return lastSegment(folderPath);
	}
}

function seasonIndexBody(title: string, seriesTitle: string, seasonNum: string): string {
	return `---
title: ${yamlString(title)}
series: ${yamlString(seriesTitle)}
season: ${yamlString(seasonNum)}
firstdraft:
  kind: season
---

# ${title}

> Season root initialized. Episodes inside this folder appear in Project
> Home automatically. Use **Create episode** to add new ones.
`;
}

function inferSeasonFromFolderName(path: string): string {
	const seg = lastSegment(path);
	const m = /^S(\d+)$/i.exec(seg);
	if (!m) return "";
	const n = parseInt(m[1] ?? "", 10);
	if (Number.isNaN(n)) return "";
	return String(n).padStart(2, "0");
}

function normalizeSeasonNumber(input: string): string | null {
	const trimmed = input.trim();
	if (trimmed === "") return null;
	const n = parseInt(trimmed, 10);
	if (Number.isNaN(n) || n < 0) return null;
	return String(n).padStart(2, "0");
}

function lastSegment(path: string): string {
	return path.split("/").pop() ?? path;
}
