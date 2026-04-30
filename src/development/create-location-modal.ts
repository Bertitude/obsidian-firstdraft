import { App, Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { sanitizeFilename, toTitleCase } from "../utils/sanitize";
import { locationRoster } from "../views/lookups";
import { yamlString } from "../utils/yaml";

// "Create location" — modal-based location entity creation, mirroring the
// Create Character flow. Captures a level (primary / recurring / one-off)
// and an optional parent_location (the master scene heading this location
// nests inside, e.g. BEDROOM inside SMITH HOUSE).
//
// Production-correct labels:
//   - primary    = standing set / built set (in many episodes)
//   - recurring  = returns across episodes
//   - one-off    = single-episode scout
//
// Episode-context locations DEFAULT to one-off; series/feature context to
// primary. All locations land at the SERIES-level Locations folder when
// project is a tv-episode with a series root above (parity with characters);
// otherwise at the active project's own Development tree.

export type LocationLevel = "primary" | "recurring" | "one-off";

export interface CreateLocationResult {
	file: TFile;
	displayName: string;
	// Parent location as set in the modal (or pre-existing on the file).
	// null when the location is standalone. Slugline autocomplete uses this
	// to render the canonical "PARENT, SUB" form on insertion.
	parentLocation: string | null;
}

export async function openCreateLocationModal(
	plugin: FirstDraftPlugin,
	defaultName: string,
): Promise<CreateLocationResult | null> {
	const active = plugin.app.workspace.getActiveFile();
	const project = active ? resolveActiveProject(active, plugin.scanner) : null;
	if (!project) {
		new Notice("Open a file inside a project first.");
		return null;
	}
	return new Promise((resolve) => {
		new CreateLocationModal(plugin, project, defaultName, resolve).open();
	});
}

class CreateLocationModal extends Modal {
	private nameValue: string;
	private level: LocationLevel;
	private parentLocation = "";
	private finished = false;

	constructor(
		private readonly plugin: FirstDraftPlugin,
		private readonly project: ProjectMeta,
		defaultName: string,
		private readonly resolve: (r: CreateLocationResult | null) => void,
	) {
		super(plugin.app);
		this.nameValue = defaultName;
		// Episode context: default to one-off (most common — guest scout).
		// Otherwise: default to primary (the canonical recurring set).
		this.level = project.projectType === "tv-episode" ? "one-off" : "primary";
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Create location" });

		new Setting(contentEl)
			.setName("Name")
			.setDesc("Location name. Used as the folder + canonical file name.")
			.addText((t) => {
				t.setPlaceholder("e.g. Smith House")
					.setValue(this.nameValue)
					.onChange((v) => {
						this.nameValue = v;
					});
				setTimeout(() => {
					t.inputEl.focus();
					t.inputEl.select();
				}, 0);
			});

		new Setting(contentEl)
			.setName("Level")
			.setDesc(this.levelDescription())
			.addDropdown((d) => {
				d.addOption("primary", "Primary");
				d.addOption("recurring", "Recurring");
				if (this.project.projectType === "tv-episode") {
					d.addOption("one-off", "One-off");
				}
				d.setValue(this.level).onChange((value) => {
					this.level = value as LocationLevel;
				});
			});

		// Optional parent_location field. Useful when this location is a
		// secondary heading inside a master location (e.g. BEDROOM inside
		// SMITH HOUSE). Suggest the existing roster by name so users can
		// type a couple letters and pick.
		const parentSetting = new Setting(contentEl)
			.setName("Parent location")
			.setDesc(
				'Optional. If this is a sub-area of an existing location (e.g. BEDROOM inside SMITH HOUSE), pick its parent. Leave empty for standalone locations.',
			);
		parentSetting.addText((t) => {
			const roster = locationRoster(
				this.plugin.app,
				this.project,
				resolveProjectSettings(this.project, this.plugin.settings),
			);
			const datalistId = "firstdraft-parent-locations";
			t.inputEl.setAttribute("list", datalistId);
			let datalist = document.getElementById(datalistId) as HTMLDataListElement | null;
			if (!datalist) {
				datalist = document.createElement("datalist");
				datalist.id = datalistId;
				document.body.appendChild(datalist);
			}
			datalist.empty();
			for (const entry of roster) {
				const opt = document.createElement("option");
				opt.value = entry.folderName;
				datalist.appendChild(opt);
			}
			t.setPlaceholder("(none)").onChange((v) => {
				this.parentLocation = v.trim();
			});
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.cancel()))
			.addButton((b) =>
				b
					.setButtonText("Create")
					.setCta()
					.onClick(() => {
						void this.submit();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.finished) this.resolve(null);
	}

	private levelDescription(): string {
		if (this.project.projectType === "tv-episode") {
			return "Primary: standing set / built set in many episodes. Recurring: returns across episodes. One-off: single-episode scout.";
		}
		return "Primary: central recurring location. Recurring: notable return setting.";
	}

	private cancel(): void {
		this.finished = true;
		this.resolve(null);
		this.close();
	}

	private async submit(): Promise<void> {
		const cfg = resolveProjectSettings(this.project, this.plugin.settings);
		const trimmed = this.nameValue.trim();
		if (trimmed === "") {
			new Notice("Name is required.");
			return;
		}
		const sanitized = sanitizeFilename(trimmed, cfg.filenameReplacementChar);
		if (!sanitized) {
			new Notice("Name has no valid filename characters.");
			return;
		}
		const finalName = toTitleCase(sanitized);

		// Series-aware placement (parity with characters).
		const entityRoot =
			this.project.projectType === "tv-episode" &&
			this.project.seriesDevelopmentPath
				? normalizePath(
						`${this.project.seriesDevelopmentPath}/${cfg.locationsSubfolder}`,
					)
				: normalizePath(
						`${this.project.projectRootPath}/${cfg.developmentFolder}/${cfg.locationsSubfolder}`,
					);

		const folderPath = normalizePath(`${entityRoot}/${finalName}`);
		const docPath = normalizePath(`${folderPath}/${finalName}.md`);

		if (this.plugin.app.vault.getAbstractFileByPath(docPath)) {
			new Notice(`A location named "${finalName}" already exists.`);
			return;
		}

		try {
			await ensureFolderExists(this.plugin.app, folderPath);
			const created = await this.plugin.app.vault.create(
				docPath,
				cfg.locationNoteTemplate,
			);
			const seasonKey = parseSeasonKey(this.project);
			const parent = this.parentLocation.trim();
			await this.plugin.app.fileManager.processFrontMatter(
				created,
				(fm: Record<string, unknown>) => {
					fm.roles = composeRoles(this.level, seasonKey);
					if (parent !== "") fm.parent_location = parent;
				},
			);

			this.finished = true;
			this.resolve({
				file: created,
				displayName: finalName,
				parentLocation: parent !== "" ? parent : null,
			});
			this.close();
		} catch (e) {
			new Notice(`Could not create location: ${(e as Error).message}`);
		}
	}
}

function composeRoles(
	level: LocationLevel,
	seasonKey: string | null,
): Record<string, string> {
	if (level === "one-off" && seasonKey) {
		return { [seasonKey]: level };
	}
	return { default: level };
}

function parseSeasonKey(project: ProjectMeta): string | null {
	if (project.season && project.season.trim() !== "") {
		const n = parseInt(project.season, 10);
		if (!Number.isNaN(n)) return `S${String(n).padStart(2, "0")}`;
	}
	if (project.episode) {
		const m = /^s(\d+)e/i.exec(project.episode.trim());
		if (m) {
			const n = parseInt(m[1] ?? "", 10);
			if (!Number.isNaN(n)) return `S${String(n).padStart(2, "0")}`;
		}
	}
	return null;
}

async function ensureFolderExists(app: App, path: string): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFolder) return;
	if (existing) throw new Error(`Path exists but is not a folder: ${path}`);
	const segments = path.split("/");
	let cumulative = "";
	for (const seg of segments) {
		cumulative = cumulative ? `${cumulative}/${seg}` : seg;
		const at = app.vault.getAbstractFileByPath(cumulative);
		if (at) continue;
		await app.vault.createFolder(cumulative);
	}
}
