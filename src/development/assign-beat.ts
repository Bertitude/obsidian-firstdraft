import { App, Modal, Notice, SuggestModal, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { sequencePairFromActive } from "../views/lookups";
import { isFountainFile } from "../fountain/file-detection";
import { BEAT_TEMPLATES, type BeatTemplate } from "./beat-templates";

// Phase 3c — Beat assignment + template application commands.

// "Assign scene to beat…" — pick a beat from the project's declared list (with
// "(clear beat)" option) and write it to the active scene's dev note `beat:`
// frontmatter field. Active file may be a fountain or a dev note.
export async function runAssignSceneToBeatCommand(
	plugin: FirstDraftPlugin,
): Promise<void> {
	const active = plugin.app.workspace.getActiveFile();
	if (!active) {
		new Notice("Open a scene file first.");
		return;
	}
	const project = resolveActiveProject(active, plugin.scanner);
	if (!project) {
		new Notice("Active file isn't inside a recognised project.");
		return;
	}
	const cfg = resolveProjectSettings(project, plugin.settings);
	const pair = sequencePairFromActive(plugin.app, active, project, cfg);
	if (!pair || !pair.devNoteFile) {
		new Notice("This file isn't paired with a dev note.");
		return;
	}

	const beats = readDeclaredBeats(plugin, project);
	if (beats.length === 0) {
		new Notice(
			"No beats declared — run apply beat template first, or add a beats: array to the project index.",
		);
		return;
	}

	new BeatPickerModal(plugin, beats, pair.devNoteFile).open();
}

class BeatPickerModal extends SuggestModal<{ label: string; value: string | null }> {
	private readonly choices: { label: string; value: string | null }[];

	constructor(
		private readonly plugin: FirstDraftPlugin,
		beats: string[],
		private readonly devNote: TFile,
	) {
		super(plugin.app);
		this.setPlaceholder("Pick a beat for this scene…");
		this.choices = [
			{ label: "(clear beat)", value: null },
			...beats.map((b) => ({ label: b, value: b })),
		];
	}

	getSuggestions(query: string): { label: string; value: string | null }[] {
		const q = query.trim().toUpperCase();
		if (q === "") return this.choices;
		return this.choices.filter((c) => c.label.toUpperCase().includes(q));
	}

	renderSuggestion(value: { label: string; value: string | null }, el: HTMLElement): void {
		el.createEl("div", { text: value.label });
	}

	onChooseSuggestion(value: { label: string; value: string | null }): void {
		void this.assign(value.value);
	}

	private async assign(beat: string | null): Promise<void> {
		try {
			await this.plugin.app.fileManager.processFrontMatter(
				this.devNote,
				(fm: Record<string, unknown>) => {
					if (beat === null) delete fm.beat;
					else fm.beat = beat;
				},
			);
			new Notice(
				beat === null
					? `Cleared beat on “${this.devNote.basename}”.`
					: `Assigned “${this.devNote.basename}” to “${beat}”.`,
			);
		} catch (e) {
			new Notice(`Could not update beat: ${(e as Error).message}`);
		}
	}
}

// "Apply beat template…" — replaces the project's beats: frontmatter array
// with the chosen template, AND clears every scene dev note's beat: field
// (returning all scenes to Unassigned). If beats: already has content, a
// confirm modal warns first.
export async function runApplyBeatTemplateCommand(
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
	new TemplatePickerModal(plugin, project).open();
}

class TemplatePickerModal extends SuggestModal<BeatTemplate> {
	constructor(
		private readonly plugin: FirstDraftPlugin,
		private readonly project: ProjectMeta,
	) {
		super(plugin.app);
		this.setPlaceholder("Pick a beat template…");
	}

	getSuggestions(query: string): BeatTemplate[] {
		const q = query.trim().toUpperCase();
		if (q === "") return BEAT_TEMPLATES;
		return BEAT_TEMPLATES.filter((t) =>
			t.label.toUpperCase().includes(q) || t.description.toUpperCase().includes(q),
		);
	}

	renderSuggestion(value: BeatTemplate, el: HTMLElement): void {
		el.createEl("div", { text: value.label });
		el.createEl("small", {
			text: value.description,
			cls: "firstdraft-suggestion-meta",
		});
	}

	onChooseSuggestion(value: BeatTemplate): void {
		void this.apply(value);
	}

	private async apply(template: BeatTemplate): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(this.project.indexFilePath);
		if (!(file instanceof TFile)) {
			new Notice("Index file not found.");
			return;
		}

		// Confirm before destructive replace if there's existing state to lose.
		const existingBeats = readDeclaredBeats(this.plugin, this.project);
		const cfg = resolveProjectSettings(this.project, this.plugin.settings);
		const sceneAssignments = await countSceneBeatAssignments(
			this.plugin,
			this.project,
			cfg,
		);
		if (existingBeats.length > 0 || sceneAssignments > 0) {
			const proceed = await confirmModal(
				this.plugin.app,
				`Apply “${template.label}”?`,
				`This will replace ${existingBeats.length} declared beat${existingBeats.length === 1 ? "" : "s"} and clear ${sceneAssignments} scene assignment${sceneAssignments === 1 ? "" : "s"}.`,
				"Apply template",
			);
			if (!proceed) return;
		}

		try {
			await this.plugin.app.fileManager.processFrontMatter(
				file,
				(fm: Record<string, unknown>) => {
					fm.beats = [...template.beats];
				},
			);
			const cleared = await clearAllSceneBeatAssignments(
				this.plugin,
				this.project,
				cfg,
			);
			new Notice(
				`Applied “${template.label}”. ${cleared > 0 ? `Cleared ${cleared} prior assignment${cleared === 1 ? "" : "s"}.` : ""}`.trim(),
			);
		} catch (e) {
			new Notice(`Could not apply template: ${(e as Error).message}`);
		}
	}
}

// "Clear beat sheet" — empty the project's beats: array AND clear every
// scene dev note's beat: field. Confirms before running.
export async function runClearBeatSheetCommand(
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
	const cfg = resolveProjectSettings(project, plugin.settings);

	const existingBeats = readDeclaredBeats(plugin, project);
	const sceneAssignments = await countSceneBeatAssignments(plugin, project, cfg);
	if (existingBeats.length === 0 && sceneAssignments === 0) {
		new Notice("Beat sheet is already empty.");
		return;
	}

	const proceed = await confirmModal(
		plugin.app,
		"Clear beat sheet?",
		`This will remove ${existingBeats.length} declared beat${existingBeats.length === 1 ? "" : "s"} and clear ${sceneAssignments} scene assignment${sceneAssignments === 1 ? "" : "s"}.`,
		"Clear",
	);
	if (!proceed) return;

	const indexFile = plugin.app.vault.getAbstractFileByPath(project.indexFilePath);
	if (indexFile instanceof TFile) {
		try {
			await plugin.app.fileManager.processFrontMatter(
				indexFile,
				(fm: Record<string, unknown>) => {
					delete fm.beats;
				},
			);
		} catch (e) {
			new Notice(`Could not clear beats: ${(e as Error).message}`);
			return;
		}
	}
	const cleared = await clearAllSceneBeatAssignments(plugin, project, cfg);
	new Notice(
		`Cleared beat sheet. ${cleared > 0 ? `Reset ${cleared} scene assignment${cleared === 1 ? "" : "s"}.` : ""}`.trim(),
	);
}

// Walk the project's dev scenes folder and count how many notes have a
// non-empty `beat:` frontmatter field.
async function countSceneBeatAssignments(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	cfg: { developmentFolder: string; sequencesSubfolder: string },
): Promise<number> {
	const folder = devScenesFolder(plugin, project, cfg);
	if (!folder) return 0;
	let n = 0;
	for (const child of folder.children) {
		if (!(child instanceof TFile) || child.extension !== "md") continue;
		if (isFountainFile(child)) continue;
		const fm = plugin.app.metadataCache.getFileCache(child)?.frontmatter as
			| Record<string, unknown>
			| undefined;
		const beat = fm?.beat;
		if (typeof beat === "string" && beat.trim() !== "") n += 1;
	}
	return n;
}

// Walk the project's dev scenes folder and remove the `beat:` field from
// every dev note's frontmatter. Returns the number of files modified.
async function clearAllSceneBeatAssignments(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	cfg: { developmentFolder: string; sequencesSubfolder: string },
): Promise<number> {
	const folder = devScenesFolder(plugin, project, cfg);
	if (!folder) return 0;
	let cleared = 0;
	for (const child of folder.children) {
		if (!(child instanceof TFile) || child.extension !== "md") continue;
		if (isFountainFile(child)) continue;
		const fm = plugin.app.metadataCache.getFileCache(child)?.frontmatter as
			| Record<string, unknown>
			| undefined;
		const beat = fm?.beat;
		if (typeof beat !== "string" || beat.trim() === "") continue;
		try {
			await plugin.app.fileManager.processFrontMatter(child, (next: Record<string, unknown>) => {
				delete next.beat;
			});
			cleared += 1;
		} catch {
			// ignore; continue with other files
		}
	}
	return cleared;
}

function devScenesFolder(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	cfg: { developmentFolder: string; sequencesSubfolder: string },
): TFolder | null {
	const path = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.sequencesSubfolder}`,
	);
	const f = plugin.app.vault.getAbstractFileByPath(path);
	return f instanceof TFolder ? f : null;
}

function confirmModal(
	app: App,
	title: string,
	body: string,
	confirmLabel: string,
): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new ConfirmModal(app, title, body, confirmLabel, resolve);
		modal.open();
	});
}

class ConfirmModal extends Modal {
	private finished = false;

	constructor(
		app: App,
		private readonly title: string,
		private readonly body: string,
		private readonly confirmLabel: string,
		private readonly done: (ok: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.title });
		contentEl.createEl("p", { text: this.body });
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
			this.finished = true;
			this.done(false);
			this.close();
		});
		const ok = buttons.createEl("button", {
			text: this.confirmLabel,
			cls: "mod-warning",
		});
		ok.addEventListener("click", () => {
			this.finished = true;
			this.done(true);
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.finished) this.done(false);
	}
}

function readDeclaredBeats(plugin: FirstDraftPlugin, project: ProjectMeta): string[] {
	const file = plugin.app.vault.getAbstractFileByPath(project.indexFilePath);
	if (!(file instanceof TFile)) return [];
	const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter as
		| Record<string, unknown>
		| undefined;
	const raw = fm?.beats;
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
	}
	return out;
}
