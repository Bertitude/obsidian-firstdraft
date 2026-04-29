import { App, Modal, Setting } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectConfig, ProjectMeta } from "../types";
import { pruneEmptyOverride } from "./resolve";

// Per-project settings overlay. Mirrors the overridable subset of the global
// settings tab (folder names, templates, character card fields). Each field
// can be cleared back to global via a "Reset to global" button. Storage key:
// `settings.projects[project.indexFilePath]`.

export function openProjectSettingsModal(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
): void {
	new ProjectSettingsModal(plugin.app, plugin, project).open();
}

class ProjectSettingsModal extends Modal {
	private readonly key: string;

	constructor(
		app: App,
		private readonly plugin: FirstDraftPlugin,
		private readonly project: ProjectMeta,
	) {
		super(app);
		this.key = project.indexFilePath;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("firstdraft-project-settings");

		const title = this.project.title ?? this.project.projectRootPath;
		contentEl.createEl("h2", { text: `Project settings — ${title}` });
		contentEl.createEl("p", {
			text: "Override global settings for this project. Empty fields fall back to global.",
			cls: "firstdraft-project-settings-help",
		});

		this.renderFolderNames();
		this.renderTemplates();
		this.renderCharacterCardFields();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private getOverride(): ProjectConfig {
		let entry = this.plugin.settings.projects[this.key];
		if (!entry) {
			entry = {};
			this.plugin.settings.projects[this.key] = entry;
		}
		return entry;
	}

	private async save(): Promise<void> {
		pruneEmptyOverride(this.project, this.plugin.settings);
		await this.plugin.saveSettings();
	}

	// ── Folder names ────────────────────────────────────────────────────

	private renderFolderNames(): void {
		const { contentEl } = this;
		const g = this.plugin.settings.global;

		new Setting(contentEl).setName("Folder names").setHeading();

		this.folderRow("Development folder", "developmentFolder", g.developmentFolder);
		this.folderRow("Characters subfolder", "charactersSubfolder", g.charactersSubfolder);
		this.folderRow("Sequences subfolder", "sequencesSubfolder", g.sequencesSubfolder);
		this.folderRow("Locations subfolder", "locationsSubfolder", g.locationsSubfolder);
		this.folderRow("References subfolder", "referencesSubfolder", g.referencesSubfolder);
	}

	private folderRow(
		label: string,
		field: "developmentFolder" | "charactersSubfolder" | "sequencesSubfolder" | "locationsSubfolder" | "referencesSubfolder",
		globalValue: string,
	): void {
		const setting = new Setting(this.contentEl).setName(label);
		setting.setDesc(`Global: ${globalValue}`);

		setting.addText((t) => {
			const override = this.getOverride();
			t.setPlaceholder(globalValue)
				.setValue(override[field] ?? "")
				.onChange(async (v) => {
					const trimmed = v.trim();
					const cur = this.getOverride();
					if (trimmed === "" || trimmed === globalValue) {
						delete cur[field];
					} else {
						cur[field] = trimmed;
					}
					await this.save();
				});
		});

		setting.addExtraButton((btn) =>
			btn
				.setIcon("rotate-ccw")
				.setTooltip("Reset to global")
				.onClick(async () => {
					const cur = this.getOverride();
					delete cur[field];
					await this.save();
					this.refresh();
				}),
		);
	}

	// ── Templates ───────────────────────────────────────────────────────

	private renderTemplates(): void {
		const { contentEl } = this;
		const g = this.plugin.settings.global;

		new Setting(contentEl).setName("Templates").setHeading();

		this.templateRow("Scene note", "sceneNoteTemplate", g.sceneNoteTemplate);
		this.templateRow("Character note", "characterNoteTemplate", g.characterNoteTemplate);
		this.templateRow("Location note", "locationNoteTemplate", g.locationNoteTemplate);
	}

	private templateRow(
		label: string,
		field: "sceneNoteTemplate" | "characterNoteTemplate" | "locationNoteTemplate",
		globalValue: string,
	): void {
		const setting = new Setting(this.contentEl).setName(label);
		const override = this.getOverride();
		const isOverridden = override[field] !== undefined;
		setting.setDesc(isOverridden ? "Project override active." : "Using global template.");

		setting.addExtraButton((btn) =>
			btn
				.setIcon("rotate-ccw")
				.setTooltip("Reset to global")
				.onClick(async () => {
					const cur = this.getOverride();
					delete cur[field];
					await this.save();
					this.refresh();
				}),
		);

		setting.addTextArea((ta) => {
			ta.setValue(override[field] ?? globalValue).onChange(async (v) => {
				const cur = this.getOverride();
				if (v === globalValue) {
					delete cur[field];
				} else {
					cur[field] = v;
				}
				await this.save();
			});
			ta.inputEl.rows = 10;
		});

		setting.settingEl.addClass("firstdraft-template-setting");
	}

	// ── Character card fields ──────────────────────────────────────────

	private renderCharacterCardFields(): void {
		const { contentEl } = this;
		const g = this.plugin.settings.global;
		const override = this.getOverride();
		const isOverridden = override.characterCardFields !== undefined;

		const heading = new Setting(contentEl)
			.setName("Character card fields")
			.setDesc(
				isOverridden
					? "Project override active. Edit the list below."
					: "Using global fields. Edit to start a project override.",
			)
			.setHeading();

		heading.addExtraButton((btn) =>
			btn
				.setIcon("rotate-ccw")
				.setTooltip("Reset to global")
				.onClick(async () => {
					const cur = this.getOverride();
					delete cur.characterCardFields;
					await this.save();
					this.refresh();
				}),
		);

		const list = contentEl.createDiv({ cls: "firstdraft-card-fields" });
		const renderList = () => {
			list.empty();
			const cur = this.getOverride();
			const fields = cur.characterCardFields ?? [...g.characterCardFields];
			fields.forEach((field, i) => {
				new Setting(list).setName(field).addExtraButton((btn) =>
					btn
						.setIcon("trash")
						.setTooltip("Remove field")
						.onClick(async () => {
							const next = [...fields];
							next.splice(i, 1);
							const cur2 = this.getOverride();
							cur2.characterCardFields = next;
							await this.save();
							renderList();
						}),
				);
			});
		};
		renderList();

		let pending = "";
		new Setting(contentEl)
			.setName("Add field")
			.addText((t) =>
				t.setPlaceholder("Field name").onChange((v) => {
					pending = v.trim();
				}),
			)
			.addButton((b) =>
				b
					.setButtonText("Add")
					.setCta()
					.onClick(async () => {
						if (!pending) return;
						const cur = this.getOverride();
						const fields = cur.characterCardFields ?? [...g.characterCardFields];
						if (fields.includes(pending)) return;
						cur.characterCardFields = [...fields, pending];
						pending = "";
						await this.save();
						this.refresh();
					}),
			);
	}

	// Re-render after a structural change (reset, add field, etc.). Cheap because
	// this is a small modal.
	private refresh(): void {
		this.contentEl.empty();
		this.onOpen();
	}
}
