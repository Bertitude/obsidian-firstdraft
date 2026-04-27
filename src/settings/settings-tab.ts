import { App, PluginSettingTab, Setting } from "obsidian";
import type FirstDraftPlugin from "../main";
import {
	DEFAULT_SETTINGS,
	SCENE_NOTE_TEMPLATE,
	CHARACTER_NOTE_TEMPLATE,
	LOCATION_NOTE_TEMPLATE,
} from "./defaults";
import { describeMode, resolveFountainMode } from "../fountain/plugin-mode";

export class FirstDraftSettingTab extends PluginSettingTab {
	plugin: FirstDraftPlugin;

	constructor(app: App, plugin: FirstDraftPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderFolderNames();
		this.renderTemplates();
		this.renderCharacterCardFields();
		this.renderFirstDraftMode();
		this.renderDevelopmentEntities();
		this.renderFountainPlugin();
		this.renderDebug();
	}

	private renderFountainPlugin(): void {
		const { containerEl } = this;
		const g = this.plugin.settings.global;

		new Setting(containerEl).setName("Fountain plugin integration").setHeading();

		new Setting(containerEl)
			.setName("Fountain plugin")
			.setDesc(
				"Which fountain plugin you're using. Auto-detect picks based on which plugin is enabled.",
			)
			.addDropdown((dd) =>
				dd
					.addOption("auto", "Auto-detect")
					.addOption("bgrundmann", "Bgrundmann fountain")
					.addOption("chuangcaleb", "Chuangcaleb fountain editor")
					.addOption("other", "Other or none")
					.setValue(g.fountainPlugin)
					.onChange(async (value) => {
						g.fountainPlugin = value as typeof g.fountainPlugin;
						await this.save();
						this.display();
					}),
			);

		const resolved = resolveFountainMode(this.plugin);
		new Setting(containerEl)
			.setName("Resolved mode")
			.setDesc(
				`Currently using ${describeMode(resolved)}. Changes take full effect after reloading Obsidian.`,
			);
	}

	private renderDevelopmentEntities(): void {
		const { containerEl } = this;
		const g = this.plugin.settings.global;

		new Setting(containerEl).setName("Development entities").setHeading();

		new Setting(containerEl)
			.setName("Replace selection with link")
			.setDesc("After creating a character or location from selection, replace the highlighted text with a Markdown link to the new note.")
			.addToggle((t) =>
				t.setValue(g.replaceSelectionWithLink).onChange(async (v) => {
					g.replaceSelectionWithLink = v;
					await this.save();
				}),
			);

		new Setting(containerEl)
			.setName("Auto-linkify on create")
			.setDesc("After creating a character or location, automatically replace existing mentions across the project. When off, a notice with an action button appears instead.")
			.addToggle((t) =>
				t.setValue(g.autoLinkifyOnCreate).onChange(async (v) => {
					g.autoLinkifyOnCreate = v;
					await this.save();
				}),
			);

		new Setting(containerEl)
			.setName("Filename replacement character")
			.setDesc("Replaces forbidden filename characters and trailing periods with this symbol. Single character only; defaults to underscore.")
			.addText((t) =>
				t
					.setPlaceholder("_")
					.setValue(g.filenameReplacementChar)
					.onChange(async (v) => {
						const trimmed = v.trim();
						g.filenameReplacementChar = trimmed.length === 0 ? "_" : trimmed.charAt(0);
						await this.save();
					}),
			);
	}

	private async save(): Promise<void> {
		await this.plugin.saveSettings();
	}

	private renderFolderNames(): void {
		const { containerEl } = this;
		const g = this.plugin.settings.global;

		new Setting(containerEl).setName("Folder names").setHeading();

		new Setting(containerEl)
			.setName("Development folder")
			.setDesc("Top-level folder under each project for development notes.")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.global.developmentFolder)
					.setValue(g.developmentFolder)
					.onChange(async (v) => {
						g.developmentFolder = v.trim() || DEFAULT_SETTINGS.global.developmentFolder;
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName("Characters subfolder")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.global.charactersSubfolder)
					.setValue(g.charactersSubfolder)
					.onChange(async (v) => {
						g.charactersSubfolder = v.trim() || DEFAULT_SETTINGS.global.charactersSubfolder;
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName("Scenes subfolder")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.global.scenesSubfolder)
					.setValue(g.scenesSubfolder)
					.onChange(async (v) => {
						g.scenesSubfolder = v.trim() || DEFAULT_SETTINGS.global.scenesSubfolder;
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName("Locations subfolder")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.global.locationsSubfolder)
					.setValue(g.locationsSubfolder)
					.onChange(async (v) => {
						g.locationsSubfolder = v.trim() || DEFAULT_SETTINGS.global.locationsSubfolder;
						await this.save();
					}),
			);

		new Setting(containerEl)
			.setName("References subfolder")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.global.referencesSubfolder)
					.setValue(g.referencesSubfolder)
					.onChange(async (v) => {
						g.referencesSubfolder = v.trim() || DEFAULT_SETTINGS.global.referencesSubfolder;
						await this.save();
					}),
			);
	}

	private renderTemplates(): void {
		const { containerEl } = this;
		const g = this.plugin.settings.global;

		new Setting(containerEl).setName("Default templates").setHeading();

		const templateRow = (
			name: string,
			desc: string,
			get: () => string,
			set: (v: string) => void,
			fallback: string,
		) => {
			const setting = new Setting(containerEl).setName(name).setDesc(desc);
			setting.addExtraButton((btn) =>
				btn
					.setIcon("rotate-ccw")
					.setTooltip("Reset to default")
					.onClick(async () => {
						set(fallback);
						await this.save();
						this.display();
					}),
			);
			setting.addTextArea((ta) => {
				ta.setValue(get()).onChange(async (v) => {
					set(v);
					await this.save();
				});
				ta.inputEl.rows = 12;
			});
			setting.settingEl.addClass("firstdraft-template-setting");
		};

		templateRow(
			"Scene note",
			"Used when creating a new scene development note.",
			() => g.sceneNoteTemplate,
			(v) => (g.sceneNoteTemplate = v),
			SCENE_NOTE_TEMPLATE,
		);

		templateRow(
			"Character note",
			"Used when creating a new character document.",
			() => g.characterNoteTemplate,
			(v) => (g.characterNoteTemplate = v),
			CHARACTER_NOTE_TEMPLATE,
		);

		templateRow(
			"Location note",
			"Used when creating a new location document.",
			() => g.locationNoteTemplate,
			(v) => (g.locationNoteTemplate = v),
			LOCATION_NOTE_TEMPLATE,
		);
	}

	private renderCharacterCardFields(): void {
		const { containerEl } = this;
		const g = this.plugin.settings.global;

		new Setting(containerEl)
			.setName("Character card fields")
			.setDesc("Frontmatter keys to display on each character card in the dev notes panel.")
			.setHeading();

		const list = containerEl.createDiv({ cls: "firstdraft-card-fields" });

		const renderList = () => {
			list.empty();
			g.characterCardFields.forEach((field, i) => {
				new Setting(list).setName(field).addExtraButton((btn) =>
					btn
						.setIcon("trash")
						.setTooltip("Remove field")
						.onClick(async () => {
							g.characterCardFields.splice(i, 1);
							await this.save();
							renderList();
						}),
				);
			});
		};
		renderList();

		let pending = "";
		new Setting(containerEl)
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
						if (!pending || g.characterCardFields.includes(pending)) return;
						g.characterCardFields.push(pending);
						pending = "";
						await this.save();
						this.display();
					}),
			);
	}

	private renderFirstDraftMode(): void {
		const { containerEl } = this;
		const m = this.plugin.settings.global.firstDraftMode;

		new Setting(containerEl).setName("First draft mode").setHeading();

		new Setting(containerEl)
			.setName("Hide ribbon")
			.setDesc("Hide the left ribbon when first draft mode is active.")
			.addToggle((t) =>
				t.setValue(m.hideRibbon).onChange(async (v) => {
					m.hideRibbon = v;
					await this.save();
				}),
			);

		new Setting(containerEl)
			.setName("Hide status bar")
			.setDesc("Hide the bottom status bar when first draft mode is active.")
			.addToggle((t) =>
				t.setValue(m.hideStatusBar).onChange(async (v) => {
					m.hideStatusBar = v;
					await this.save();
				}),
			);

		new Setting(containerEl)
			.setName("Collapse left sidebar")
			.setDesc("Collapse the left sidebar when first draft mode is active.")
			.addToggle((t) =>
				t.setValue(m.hideLeftSidebar).onChange(async (v) => {
					m.hideLeftSidebar = v;
					await this.save();
				}),
			);
	}

	private renderDebug(): void {
		const { containerEl } = this;
		const g = this.plugin.settings.global;

		new Setting(containerEl).setName("Debug").setHeading();

		new Setting(containerEl)
			.setName("Verbose logging")
			.setDesc("Log project scanner activity to the developer console.")
			.addToggle((t) =>
				t.setValue(g.debugLogging).onChange(async (v) => {
					g.debugLogging = v;
					await this.save();
				}),
			);
	}
}
