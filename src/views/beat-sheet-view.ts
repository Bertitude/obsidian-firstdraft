import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import {
	buildBeatSheet,
	UNASSIGNED_BEAT,
	type BeatSheetData,
} from "./beat-sheet-data";
import { VIEW_TYPE_BEAT_SHEET } from "./view-types";
import { stripId } from "../utils/stable-id";

// Phase 3c — Beat sheet view. Two-column rows: beat name on the left, vertical
// list of scenes assigned to that beat on the right. Drag a scene from one
// beat row to another to reassign (writes the new beat: value into the scene's
// dev note frontmatter). Drop into "Unassigned" to clear the beat: field.
//
// Beats source: project's Index.md `beats: []` array. Scenes assigned via
// each dev note's `beat:` frontmatter field.

const DRAG_MIME = "application/firstdraft-beat-scene";

export class BeatSheetView extends ItemView {
	private project: ProjectMeta | null = null;
	private data: BeatSheetData | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: FirstDraftPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_BEAT_SHEET;
	}

	getDisplayText(): string {
		return this.project ? `Beats — ${displayProject(this.project)}` : "Beat sheet";
	}

	getIcon(): string {
		return "list-checks";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("firstdraft-beats");
		await this.refresh();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	async refresh(): Promise<void> {
		this.contentEl.empty();

		const active = this.plugin.app.workspace.getActiveFile();
		const candidate = active ? resolveActiveProject(active, this.plugin.scanner) : null;
		this.project = candidate ?? this.project;
		if (!this.project) {
			this.renderEmptyNoProject();
			return;
		}

		const cfg = resolveProjectSettings(this.project, this.plugin.settings);
		this.data = buildBeatSheet(this.plugin.app, this.project, cfg);
		this.renderHeader(this.project);

		if (this.data.declaredBeats.length === 0 && this.data.groups.length === 0) {
			this.renderEmptyNoBeats();
			return;
		}

		this.renderList(this.data);
	}

	private renderHeader(project: ProjectMeta): void {
		const header = this.contentEl.createDiv({ cls: "firstdraft-beats-header" });
		const top = header.createDiv({ cls: "firstdraft-beats-header-top" });
		top.createEl("h2", { text: displayProject(project) });

		const sub = header.createDiv({ cls: "firstdraft-beats-subtitle" });
		const totalScenes = (this.data?.groups ?? []).reduce(
			(n, g) => n + g.scenes.length,
			0,
		);
		const declaredCount = this.data?.declaredBeats.length ?? 0;
		sub.setText(
			`${declaredCount} beat${declaredCount === 1 ? "" : "s"} declared · ${totalScenes} scene${totalScenes === 1 ? "" : "s"}`,
		);

		if (declaredCount === 0) {
			const hint = header.createDiv({ cls: "firstdraft-beats-hint" });
			hint.setText(
				"No beats declared yet. Run the “Apply beat template” command to scaffold one.",
			);
		}
	}

	private renderList(data: BeatSheetData): void {
		const wrap = this.contentEl.createDiv({ cls: "firstdraft-beats-list-wrap" });

		// Column header row (matches matrix style).
		const headerRow = wrap.createDiv({
			cls: "firstdraft-beats-row firstdraft-beats-header-row",
		});
		headerRow.createDiv({ text: "Beat", cls: "firstdraft-beats-col-header" });
		headerRow.createDiv({ text: "Sequences", cls: "firstdraft-beats-col-header" });

		for (const group of data.groups) {
			const rowEl = wrap.createDiv({ cls: "firstdraft-beats-row" });
			rowEl.dataset.beat = group.beat;
			rowEl.dataset.unassigned = group.isUnassigned ? "true" : "false";

			// Left: beat name + meta
			const nameCell = rowEl.createDiv({
				cls:
					"firstdraft-beats-row-name" +
					(group.isUnassigned ? " is-unassigned" : "") +
					(!group.isDeclared && !group.isUnassigned ? " is-adhoc" : ""),
			});
			nameCell.createDiv({
				text: group.beat,
				cls: "firstdraft-beats-row-title",
			});
			if (!group.isDeclared && !group.isUnassigned) {
				nameCell.createEl("small", {
					text: "ad-hoc",
					cls: "firstdraft-beats-row-meta",
				});
			}
			nameCell.createEl("small", {
				text: `${group.scenes.length} scene${group.scenes.length === 1 ? "" : "s"}`,
				cls: "firstdraft-beats-row-count",
			});

			// Right: scenes
			const scenesCell = rowEl.createDiv({ cls: "firstdraft-beats-row-scenes" });
			this.attachDropTarget(scenesCell, group.beat, group.isUnassigned);

			if (group.scenes.length === 0) {
				const empty = scenesCell.createDiv({
					cls: "firstdraft-beats-row-empty",
				});
				empty.setText("— no scenes —");
				continue;
			}

			for (const scene of group.scenes) {
				const item = scenesCell.createEl("div", {
					cls: "firstdraft-beats-row-scene",
				});
				item.setText(stripId(scene.sequenceName));
				if (scene.devNoteFile) {
					item.dataset.devNotePath = scene.devNoteFile.path;
					item.draggable = true;
					item.addEventListener("dragstart", (e) => this.onDragStart(e, item));
					item.addEventListener("dragend", () => item.removeClass("is-dragging"));
					// `click` (not `mousedown`) so a drag-start doesn't also open
					// the file. Browsers suppress click when a drag occurred.
					item.addEventListener("click", (e) => {
						if (e.button !== 0) return;
						void this.openFile(scene.devNoteFile);
					});
					item.addClass("is-clickable");
				}
			}
		}
	}

	private attachDropTarget(
		el: HTMLElement,
		beat: string,
		isUnassigned: boolean,
	): void {
		el.addEventListener("dragover", (e) => {
			if (!e.dataTransfer) return;
			if (![...e.dataTransfer.types].includes(DRAG_MIME)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "move";
			el.addClass("is-drop-target");
		});
		el.addEventListener("dragleave", () => el.removeClass("is-drop-target"));
		el.addEventListener("drop", (e) => {
			el.removeClass("is-drop-target");
			if (!e.dataTransfer) return;
			const path = e.dataTransfer.getData(DRAG_MIME);
			if (!path) return;
			e.preventDefault();
			void this.assignSceneToBeat(path, isUnassigned ? null : beat);
		});
	}

	private onDragStart(e: DragEvent, item: HTMLElement): void {
		const path = item.dataset.devNotePath;
		if (!path || !e.dataTransfer) return;
		e.dataTransfer.setData(DRAG_MIME, path);
		e.dataTransfer.effectAllowed = "move";
		item.addClass("is-dragging");
	}

	private async assignSceneToBeat(
		devNotePath: string,
		beat: string | null,
	): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(devNotePath);
		if (!(file instanceof TFile)) return;
		try {
			await this.plugin.app.fileManager.processFrontMatter(
				file,
				(fm: Record<string, unknown>) => {
					if (beat === null) {
						delete fm.beat;
					} else {
						fm.beat = beat;
					}
				},
			);
			new Notice(
				beat === null
					? `Cleared beat on “${file.basename}”.`
					: `Assigned “${file.basename}” to “${beat}”.`,
			);
			// Metadata 'changed' event will trigger refresh, but force one in case
			// the change was a no-op (frontmatter already matched).
			void this.refresh();
		} catch (e) {
			new Notice(`Could not update beat: ${(e as Error).message}`);
		}
	}

	private async openFile(file: TFile | null): Promise<void> {
		if (!file) return;
		await this.plugin.app.workspace.getLeaf(false).openFile(file);
	}

	private renderEmptyNoProject(): void {
		const wrap = this.contentEl.createDiv({ cls: "firstdraft-beats-empty" });
		wrap.createEl("p", {
			text: "Open a file inside a project to see its beat sheet.",
		});
	}

	private renderEmptyNoBeats(): void {
		const wrap = this.contentEl.createDiv({ cls: "firstdraft-beats-empty" });
		wrap.createEl("p", {
			text: "No beats declared yet. Run the “Apply beat template” command to scaffold one, or add a `beats: []` array to this project's Index.md.",
		});
	}
}

function displayProject(p: ProjectMeta): string {
	if (p.projectType === "tv-episode") {
		const ep = p.episode ?? "";
		const t = p.title ?? "";
		return ep ? `${p.series ?? ""} ${ep}${t ? " — " + t : ""}`.trim() : t;
	}
	return p.title ?? p.indexFilePath;
}

export async function activateBeatSheetView(
	plugin: FirstDraftPlugin,
): Promise<void> {
	const { workspace } = plugin.app;
	let leaf = workspace.getLeavesOfType(VIEW_TYPE_BEAT_SHEET)[0] ?? null;
	if (!leaf) {
		leaf = workspace.getLeaf(false);
		await leaf.setViewState({ type: VIEW_TYPE_BEAT_SHEET, active: true });
	}
	void workspace.revealLeaf(leaf);
}

export function getBeatSheetView(plugin: FirstDraftPlugin): BeatSheetView | null {
	const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_BEAT_SHEET);
	const view = leaves[0]?.view;
	return view instanceof BeatSheetView ? view : null;
}
