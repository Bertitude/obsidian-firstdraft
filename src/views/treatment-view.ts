import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { writeScenesArray } from "../longform/scenes-array";
import { buildTreatmentData, enrichRowAsync, type TreatmentRow } from "./treatment-data";
import { VIEW_TYPE_TREATMENT } from "./view-types";

// Treatment list view: one row per scene in the active project, ordered by
// Longform's scenes array. Rows are draggable; dropping persists the new
// order back to Index.md. Refreshes on metadata/file/active-leaf changes.

export class TreatmentView extends ItemView {
	private project: ProjectMeta | null = null;
	private rows: TreatmentRow[] = [];

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: FirstDraftPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_TREATMENT;
	}

	getDisplayText(): string {
		return this.project ? `Treatment — ${displayProject(this.project)}` : "Treatment";
	}

	getIcon(): string {
		return "list-ordered";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("firstdraft-treatment");
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

		const data = buildTreatmentData(
			this.plugin.app,
			this.project,
			this.plugin.settings.global,
		);
		this.rows = data.rows;

		this.renderHeader(this.project);

		if (this.rows.length === 0) {
			this.renderEmptyNoScenes();
			return;
		}

		const list = this.contentEl.createDiv({ cls: "firstdraft-treatment-list" });
		this.rows.forEach((row, index) => this.renderRow(list, row, index));

		// Async enrichment: fetch intent excerpts and sluglines from disk and
		// patch the existing row DOM in place once they arrive.
		void this.enrichVisibleRows(list);
	}

	// Enrichment runs after the initial sync render so the UI shows immediately;
	// excerpts and sluglines pop in shortly after.
	private async enrichVisibleRows(list: HTMLElement): Promise<void> {
		for (let i = 0; i < this.rows.length; i++) {
			const row = this.rows[i];
			if (!row) continue;
			const enriched = await enrichRowAsync(this.plugin.app, row);
			this.rows[i] = enriched;
			const rowEl = list.children[i] as HTMLElement | undefined;
			if (rowEl) updateRowExtras(rowEl, enriched);
		}
	}

	private renderHeader(project: ProjectMeta): void {
		const header = this.contentEl.createDiv({ cls: "firstdraft-treatment-header" });
		header.createEl("h2", { text: displayProject(project) });
		const sub = header.createDiv({ cls: "firstdraft-treatment-subtitle" });
		sub.setText(`${this.rows.length} scene${this.rows.length === 1 ? "" : "s"}`);
	}

	private renderEmptyNoProject(): void {
		const wrap = this.contentEl.createDiv({ cls: "firstdraft-treatment-empty" });
		wrap.createEl("p", {
			text: "Open a file inside a project to see its treatment.",
		});
	}

	private renderEmptyNoScenes(): void {
		const wrap = this.contentEl.createDiv({ cls: "firstdraft-treatment-empty" });
		wrap.createEl("p", {
			text: "No scenes yet. Start with an outline and promote it to scenes.",
		});
		const btn = wrap.createEl("button", {
			text: "Create outline",
			cls: "mod-cta",
		});
		btn.addEventListener("click", () => {
			void runCreateOutlineFromButton(this.plugin);
		});
	}

	private renderRow(parent: HTMLElement, row: TreatmentRow, index: number): void {
		const el = parent.createDiv({
			cls: "firstdraft-treatment-row" + (row.orphan ? " is-orphan" : "") + (row.missing ? " is-missing" : ""),
			attr: { draggable: "true", "data-index": String(index) },
		});

		const handle = el.createDiv({ cls: "firstdraft-treatment-handle", attr: { "aria-label": "Drag to reorder" } });
		setIcon(handle, "grip-vertical");

		const main = el.createDiv({ cls: "firstdraft-treatment-main" });

		const title = main.createDiv({ cls: "firstdraft-treatment-title" });
		title.setText(row.sceneName);

		if (row.orphan) {
			const tag = title.createSpan({ cls: "firstdraft-treatment-tag", text: "not in script order" });
			void tag;
		} else if (row.missing) {
			const tag = title.createSpan({ cls: "firstdraft-treatment-tag is-warning", text: "no files" });
			void tag;
		}

		const meta = main.createDiv({ cls: "firstdraft-treatment-meta" });
		this.renderChips(meta, row.characters, "char");
		this.renderChips(meta, row.locations, "loc");
		if (row.versionCount > 0) {
			meta.createSpan({
				cls: "firstdraft-treatment-version",
				text: `v${row.versionCount + 1}`,
				attr: { "aria-label": `${row.versionCount} prior version${row.versionCount === 1 ? "" : "s"}` },
			});
		}

		const excerpt = main.createDiv({ cls: "firstdraft-treatment-excerpt" });
		excerpt.setText(row.intentExcerpt);

		const sluglines = main.createDiv({ cls: "firstdraft-treatment-sluglines" });
		sluglines.setText(row.sluglines.join(" · "));

		const actions = el.createDiv({ cls: "firstdraft-treatment-actions" });
		this.renderRowActions(actions, row);

		// Click on the body opens the dev note (or fountain if no dev note exists).
		main.addEventListener("click", () => this.openPrimary(row));

		this.attachDragHandlers(el, index);
	}

	private renderChips(parent: HTMLElement, names: string[], kind: "char" | "loc"): void {
		for (const name of names) {
			parent.createSpan({
				cls: `firstdraft-treatment-chip is-${kind}`,
				text: name,
			});
		}
	}

	private renderRowActions(parent: HTMLElement, row: TreatmentRow): void {
		const fountain = row.fountainFile;
		if (fountain) {
			const btn = parent.createEl("button", {
				cls: "clickable-icon firstdraft-treatment-action",
				attr: { "aria-label": "Open scene file" },
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
				cls: "clickable-icon firstdraft-treatment-action",
				attr: { "aria-label": "Open dev note" },
			});
			setIcon(btn, "notebook-pen");
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.plugin.app.workspace.getLeaf(false).openFile(devNote);
			});
		}
	}

	private openPrimary(row: TreatmentRow): void {
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
		if (!this.project) return;

		const orderableRows = this.rows.filter((r) => !r.orphan);
		const orphans = this.rows.filter((r) => r.orphan);

		// Reordering only applies to non-orphan rows (orphans aren't in Longform's
		// scenes array). Map view indices to orderable indices.
		const sourceRow = this.rows[sourceIdx];
		const targetRow = this.rows[targetIdx];
		if (!sourceRow || !targetRow || sourceRow.orphan || targetRow.orphan) {
			new Notice("Orphan rows can't be reordered until they're added to the project.");
			return;
		}

		const sourceOrder = orderableRows.indexOf(sourceRow);
		const targetOrder = orderableRows.indexOf(targetRow);
		if (sourceOrder === -1 || targetOrder === -1) return;

		const [moved] = orderableRows.splice(sourceOrder, 1);
		if (!moved) return;
		orderableRows.splice(targetOrder, 0, moved);

		const newScenes = orderableRows.map((r) => r.sceneName);
		try {
			await writeScenesArray(this.plugin.app, this.project.indexFilePath, newScenes);
			this.rows = [...orderableRows, ...orphans];
			await this.refresh();
		} catch (e) {
			new Notice(`Reorder failed: ${(e as Error).message}`);
		}
	}
}

function updateRowExtras(rowEl: HTMLElement, row: TreatmentRow): void {
	const excerpt = rowEl.querySelector(".firstdraft-treatment-excerpt");
	if (excerpt) excerpt.textContent = row.intentExcerpt;
	const sluglines = rowEl.querySelector(".firstdraft-treatment-sluglines");
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
async function runCreateOutlineFromButton(plugin: FirstDraftPlugin): Promise<void> {
	const { runCreateOutlineCommand } = await import("../outline/promote");
	await runCreateOutlineCommand(plugin);
}

export async function activateTreatmentView(plugin: FirstDraftPlugin): Promise<void> {
	const { workspace } = plugin.app;
	let leaf = workspace.getLeavesOfType(VIEW_TYPE_TREATMENT)[0] ?? null;
	if (!leaf) {
		leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: VIEW_TYPE_TREATMENT, active: true });
	}
	void workspace.revealLeaf(leaf);
}

export function getTreatmentView(plugin: FirstDraftPlugin): TreatmentView | null {
	const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_TREATMENT);
	const view = leaves[0]?.view;
	return view instanceof TreatmentView ? view : null;
}
