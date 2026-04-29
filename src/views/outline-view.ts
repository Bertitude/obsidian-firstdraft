import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { findSiblingEpisodes } from "../projects/episodes";
import { resolveProjectSettings } from "../settings/resolve";
import { writeScenesArray } from "../longform/scenes-array";
import { stripId } from "../utils/stable-id";
import { buildOutlineData, enrichRowAsync, type OutlineRow } from "./outline-data";
import { VIEW_TYPE_OUTLINE } from "./view-types";

// Treatment list view: one row per scene in the active project, ordered by
// Longform's scenes array. Rows are draggable; dropping persists the new
// order back to Index.md. Refreshes on metadata/file/active-leaf changes.
//
// For TV projects, a Season mode shows scenes from all sibling episodes
// grouped under episode headers. Drag-reorder is constrained to within an
// episode (cross-episode drag would require file moves and is deferred).

type Mode = "episode" | "season";

interface SeasonGroup {
	project: ProjectMeta;
	rows: OutlineRow[];
	scenesArray: string[];
}

export class OutlineView extends ItemView {
	private project: ProjectMeta | null = null;
	private mode: Mode = "episode";
	private rows: OutlineRow[] = [];
	private groups: SeasonGroup[] = [];

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: FirstDraftPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_OUTLINE;
	}

	getDisplayText(): string {
		return this.project ? `Outline — ${displayProject(this.project)}` : "Outline";
	}

	getIcon(): string {
		return "list-ordered";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("firstdraft-outline");
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

		const isTV = this.project.projectType === "tv-episode";
		if (!isTV) this.mode = "episode"; // mode toggle only meaningful for TV

		this.groups = this.buildGroups(this.project, this.mode);
		this.rows = this.groups.flatMap((g) => g.rows);

		this.renderHeader(this.project, isTV);

		if (this.rows.length === 0) {
			this.renderEmptyNoScenes();
			return;
		}

		const list = this.contentEl.createDiv({ cls: "firstdraft-outline-list" });
		this.renderGroups(list);

		// Async enrichment: fetch intent excerpts and sluglines from disk and
		// patch the existing row DOM in place once they arrive.
		void this.enrichVisibleRows(list);
	}

	private buildGroups(project: ProjectMeta, mode: Mode): SeasonGroup[] {
		if (mode === "episode" || project.projectType !== "tv-episode") {
			const cfg = resolveProjectSettings(project, this.plugin.settings);
			const data = buildOutlineData(this.plugin.app, project, cfg);
			return [{ project, rows: data.rows, scenesArray: data.scenesArray }];
		}

		// Season mode: gather all sibling episodes (same series + season) and
		// build a group per episode in episode-code order. Each episode resolves
		// its own per-project overrides.
		const siblings = findSiblingEpisodes(this.plugin, project);
		return siblings.map((p) => {
			const cfg = resolveProjectSettings(p, this.plugin.settings);
			const data = buildOutlineData(this.plugin.app, p, cfg);
			return { project: p, rows: data.rows, scenesArray: data.scenesArray };
		});
	}

	private renderGroups(list: HTMLElement): void {
		if (this.mode === "episode" || this.groups.length === 1) {
			this.rows.forEach((row, index) => this.renderRow(list, row, index));
			return;
		}

		// Season mode — emit an episode header before each group's rows.
		let cursor = 0;
		for (const group of this.groups) {
			const header = list.createDiv({ cls: "firstdraft-outline-group-header" });
			header.createEl("h3", { text: displayProject(group.project) });
			const sub = header.createSpan({ cls: "firstdraft-outline-group-meta" });
			sub.setText(`${group.rows.length} scene${group.rows.length === 1 ? "" : "s"}`);
			for (const row of group.rows) {
				this.renderRow(list, row, cursor);
				cursor += 1;
			}
		}
	}

	private async enrichVisibleRows(list: HTMLElement): Promise<void> {
		// Walk the row elements (skipping group headers) in DOM order and patch
		// each with async-loaded intent + sluglines.
		const rowEls = Array.from(list.querySelectorAll<HTMLElement>(".firstdraft-outline-row"));
		for (let i = 0; i < this.rows.length; i++) {
			const row = this.rows[i];
			if (!row) continue;
			const enriched = await enrichRowAsync(this.plugin.app, row);
			this.rows[i] = enriched;
			const rowEl = rowEls[i];
			if (rowEl) updateRowExtras(rowEl, enriched);
		}
	}

	private renderHeader(project: ProjectMeta, isTV: boolean): void {
		const header = this.contentEl.createDiv({ cls: "firstdraft-outline-header" });
		const top = header.createDiv({ cls: "firstdraft-outline-header-top" });
		top.createEl("h2", { text: displayProject(project) });
		if (isTV) this.renderModeToggle(top);
		const sub = header.createDiv({ cls: "firstdraft-outline-subtitle" });
		sub.setText(`${this.rows.length} scene${this.rows.length === 1 ? "" : "s"}`);
	}

	private renderModeToggle(parent: HTMLElement): void {
		const wrap = parent.createDiv({ cls: "firstdraft-outline-mode" });
		const make = (label: string, value: Mode) => {
			const btn = wrap.createEl("button", {
				text: label,
				cls: "firstdraft-outline-mode-btn" + (this.mode === value ? " is-active" : ""),
			});
			btn.addEventListener("mousedown", (e) => {
				if (e.button !== 0) return;
				if (this.mode === value) return;
				this.mode = value;
				void this.refresh();
			});
		};
		make("Episode", "episode");
		make("Season", "season");
	}

	private renderEmptyNoProject(): void {
		const wrap = this.contentEl.createDiv({ cls: "firstdraft-outline-empty" });
		wrap.createEl("p", {
			text: "Open a file inside a project to see its outline.",
		});
	}

	private renderEmptyNoScenes(): void {
		const wrap = this.contentEl.createDiv({ cls: "firstdraft-outline-empty" });
		wrap.createEl("p", {
			text: "No sequences yet. Start with a treatment and promote it to sequences.",
		});
		const btn = wrap.createEl("button", {
			text: "Create treatment",
			cls: "mod-cta",
		});
		btn.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			void runCreateTreatmentFromButton(this.plugin);
		});
	}

	private renderRow(parent: HTMLElement, row: OutlineRow, index: number): void {
		const el = parent.createDiv({
			cls: "firstdraft-outline-row" + (row.orphan ? " is-orphan" : "") + (row.missing ? " is-missing" : ""),
			attr: { draggable: "true", "data-index": String(index) },
		});

		const handle = el.createDiv({ cls: "firstdraft-outline-handle", attr: { "aria-label": "Drag to reorder" } });
		setIcon(handle, "grip-vertical");

		const main = el.createDiv({ cls: "firstdraft-outline-main" });

		const title = main.createDiv({ cls: "firstdraft-outline-title" });
		title.setText(stripId(row.sequenceName));

		if (row.orphan) {
			const tag = title.createSpan({ cls: "firstdraft-outline-tag", text: "not in script order" });
			void tag;
		} else if (row.missing) {
			const tag = title.createSpan({ cls: "firstdraft-outline-tag is-warning", text: "no files" });
			void tag;
		}

		const meta = main.createDiv({ cls: "firstdraft-outline-meta" });
		this.renderChips(meta, row.characters, "char");
		this.renderChips(meta, row.locations, "loc");
		if (row.versionCount > 0) {
			meta.createSpan({
				cls: "firstdraft-outline-version",
				text: `v${row.versionCount + 1}`,
				attr: { "aria-label": `${row.versionCount} prior version${row.versionCount === 1 ? "" : "s"}` },
			});
		}

		const excerpt = main.createDiv({ cls: "firstdraft-outline-excerpt" });
		excerpt.setText(row.intentExcerpt);

		const sluglines = main.createDiv({ cls: "firstdraft-outline-sluglines" });
		sluglines.setText(row.sluglines.join(" · "));

		const actions = el.createDiv({ cls: "firstdraft-outline-actions" });
		this.renderRowActions(actions, row);

		// Click on the body opens the dev note (or fountain if no dev note exists).
		main.addEventListener("click", () => this.openPrimary(row));

		this.attachDragHandlers(el, index);
	}

	private renderChips(parent: HTMLElement, names: string[], kind: "char" | "loc"): void {
		for (const name of names) {
			parent.createSpan({
				cls: `firstdraft-outline-chip is-${kind}`,
				text: name,
			});
		}
	}

	private renderRowActions(parent: HTMLElement, row: OutlineRow): void {
		const fountain = row.fountainFile;
		if (fountain) {
			const btn = parent.createEl("button", {
				cls: "clickable-icon firstdraft-outline-action",
				attr: { "aria-label": "Open sequence file" },
			});
			setIcon(btn, "file-text");
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.plugin.app.workspace.getLeaf(false).openFile(fountain);
			});
		}
		const devNote = row.devNoteFile;
		if (devNote) {
			const btn = parent.createEl("button", {
				cls: "clickable-icon firstdraft-outline-action",
				attr: { "aria-label": "Open dev note" },
			});
			setIcon(btn, "notebook-pen");
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.plugin.app.workspace.getLeaf(false).openFile(devNote);
			});
		}
	}

	private openPrimary(row: OutlineRow): void {
		const target = row.devNoteFile ?? row.fountainFile;
		if (!target) {
			new Notice("No file to open for this row.");
			return;
		}
		void this.plugin.app.workspace.getLeaf(false).openFile(target);
	}

	private attachDragHandlers(rowEl: HTMLElement, index: number): void {
		rowEl.addEventListener("dragstart", (e) => {
			rowEl.classList.add("is-dragging");
			e.dataTransfer?.setData("text/plain", String(index));
			if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
		});
		rowEl.addEventListener("dragend", () => {
			rowEl.classList.remove("is-dragging");
		});
		rowEl.addEventListener("dragover", (e) => {
			e.preventDefault();
			rowEl.classList.add("is-drop-target");
			if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
		});
		rowEl.addEventListener("dragleave", () => {
			rowEl.classList.remove("is-drop-target");
		});
		rowEl.addEventListener("drop", (e) => {
			e.preventDefault();
			rowEl.classList.remove("is-drop-target");
			const sourceIdx = Number(e.dataTransfer?.getData("text/plain") ?? "-1");
			const targetIdx = Number(rowEl.getAttribute("data-index") ?? "-1");
			if (Number.isNaN(sourceIdx) || Number.isNaN(targetIdx)) return;
			if (sourceIdx === targetIdx || sourceIdx < 0 || targetIdx < 0) return;
			void this.handleReorder(sourceIdx, targetIdx);
		});
	}

	private async handleReorder(sourceIdx: number, targetIdx: number): Promise<void> {
		const sourceRow = this.rows[sourceIdx];
		const targetRow = this.rows[targetIdx];
		if (!sourceRow || !targetRow) return;
		if (sourceRow.orphan || targetRow.orphan) {
			new Notice("Orphan rows can't be reordered until they're added to the project.");
			return;
		}
		if (sourceRow.indexFilePath !== targetRow.indexFilePath) {
			new Notice("Cross-episode reordering isn't supported yet.");
			return;
		}

		// Find the group these rows belong to and reorder within it.
		const group = this.groups.find((g) => g.project.indexFilePath === sourceRow.indexFilePath);
		if (!group) return;

		const orderable = group.rows.filter((r) => !r.orphan);
		const orphans = group.rows.filter((r) => r.orphan);
		const sourceOrder = orderable.indexOf(sourceRow);
		const targetOrder = orderable.indexOf(targetRow);
		if (sourceOrder === -1 || targetOrder === -1) return;

		const [moved] = orderable.splice(sourceOrder, 1);
		if (!moved) return;
		orderable.splice(targetOrder, 0, moved);

		const newScenes = orderable.map((r) => r.sequenceName);
		try {
			await writeScenesArray(this.plugin.app, group.project.indexFilePath, newScenes);
			group.rows = [...orderable, ...orphans];
			await this.refresh();
		} catch (e) {
			new Notice(`Reorder failed: ${(e as Error).message}`);
		}
	}
}

function updateRowExtras(rowEl: HTMLElement, row: OutlineRow): void {
	const excerpt = rowEl.querySelector(".firstdraft-outline-excerpt");
	if (excerpt) excerpt.textContent = row.intentExcerpt;
	const sluglines = rowEl.querySelector(".firstdraft-outline-sluglines");
	if (sluglines) sluglines.textContent = row.sluglines.join(" · ");
}

function displayProject(p: ProjectMeta): string {
	if (p.projectType === "tv-episode") {
		const ep = p.episode ?? "";
		const t = p.title ?? basenameOf(p.indexFilePath);
		return ep ? `${p.series ?? ""} ${ep} — ${t}`.trim() : t;
	}
	return p.title ?? basenameOf(p.indexFilePath);
}

function basenameOf(path: string): string {
	const seg = path.split("/").pop() ?? path;
	return seg.replace(/\.md$/, "");
}

// Imports the create-outline command lazily to keep the view module's import
// surface small. Used by the empty-state button.
async function runCreateTreatmentFromButton(plugin: FirstDraftPlugin): Promise<void> {
	const { runCreateTreatmentCommand } = await import("../treatment/promote");
	await runCreateTreatmentCommand(plugin);
}

export async function activateOutlineView(plugin: FirstDraftPlugin): Promise<void> {
	const { workspace } = plugin.app;
	let leaf = workspace.getLeavesOfType(VIEW_TYPE_OUTLINE)[0] ?? null;
	if (!leaf) {
		leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_OUTLINE, active: true });
	}
	void workspace.revealLeaf(leaf);
}

export function getOutlineView(plugin: FirstDraftPlugin): OutlineView | null {
	const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_OUTLINE);
	const view = leaves[0]?.view;
	return view instanceof OutlineView ? view : null;
}
