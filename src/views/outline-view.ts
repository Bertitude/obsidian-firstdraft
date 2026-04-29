import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { findSiblingEpisodes } from "../projects/episodes";
import { resolveProjectSettings } from "../settings/resolve";
import {
	appendSceneToArray,
	removeSceneFromArray,
	writeScenesArray,
} from "../longform/scenes-array";
import { fountainScenesArrayEntry } from "../fountain/file-detection";
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

// Drop modes when dragging one row onto another:
//  - "before": drop into the gap above the target row
//  - "after":  drop into the gap below the target row
//  - "swap":   exchange positions with the target row
// Determined from the cursor's vertical position within the target's
// bounding rect: top quarter → before, bottom quarter → after, middle
// half → swap.
type DropMode = "before" | "after" | "swap";

const DROP_GAP_RATIO = 0.25;

function computeDropMode(e: DragEvent, rowEl: HTMLElement): DropMode {
	const rect = rowEl.getBoundingClientRect();
	const ratio = (e.clientY - rect.top) / rect.height;
	if (ratio < DROP_GAP_RATIO) return "before";
	if (ratio > 1 - DROP_GAP_RATIO) return "after";
	return "swap";
}

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
		const active = this.plugin.app.workspace.getActiveFile();
		const candidate = active ? resolveActiveProject(active, this.plugin.scanner) : null;
		this.project = candidate ?? this.project;

		if (!this.project) {
			this.contentEl.empty();
			this.renderEmptyNoProject();
			return;
		}

		if (this.project.projectType !== "tv-episode") this.mode = "episode";

		// Rebuild groups from disk. After write operations (e.g. handleReorder)
		// the metadata cache may not have caught up yet — callers that have
		// just-written in-memory state should call renderFromGroups() directly
		// instead of refresh() to avoid clobbering it with stale cache reads.
		this.groups = this.buildGroups(this.project, this.mode);
		this.rows = this.groups.flatMap((g) => g.rows);
		this.renderFromGroups();
	}

	// Pure render — uses whatever this.groups currently holds. Separated from
	// refresh() so that handlers which mutate this.groups directly (drag-
	// reorder, add/remove project membership) can render the result without a
	// disk round-trip that may race with the metadata cache update.
	private renderFromGroups(): void {
		this.contentEl.empty();
		if (!this.project) {
			this.renderEmptyNoProject();
			return;
		}
		const isTV = this.project.projectType === "tv-episode";
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
			text: "No sequences yet. Start with a treatment and make sequences from it.",
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
			// Orphans aren't in the project's sequence order, so dragging them
			// is meaningless until they're added. Only orderable rows are
			// draggable — the "Add to project" pill is the path in.
			attr: { draggable: row.orphan ? "false" : "true", "data-index": String(index) },
		});

		const handle = el.createDiv({ cls: "firstdraft-outline-handle", attr: { "aria-label": "Drag to reorder" } });
		setIcon(handle, "grip-vertical");

		const main = el.createDiv({ cls: "firstdraft-outline-main" });

		const title = main.createDiv({ cls: "firstdraft-outline-title" });
		title.setText(stripId(row.sequenceName));

		if (row.orphan) {
			// Clickable "Add to project" affordance — the static label was
			// previously the source of confusion ("orphan rows can't be
			// reordered"). Now the same pill IS the path to make it orderable.
			//
			// Uses mousedown rather than click because Obsidian's leaf focus
			// model swallows the first click event before listeners see it
			// (same issue we hit on the Project Home cog button). The paired
			// click listener just stops propagation so the row's main click
			// handler (which opens the dev note) doesn't fire on the same
			// gesture.
			const addBtn = title.createEl("button", {
				cls: "firstdraft-outline-tag is-action",
				text: "Not in project · Add",
				attr: { "aria-label": "Add this sequence to the project" },
			});
			addBtn.addEventListener("mousedown", (e) => {
				if (e.button !== 0) return;
				e.stopPropagation();
				void this.handleAddToProject(row);
			});
			addBtn.addEventListener("click", (e) => {
				e.stopPropagation();
			});
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
		// "Remove from project" — the symmetric opt-out for non-orphan rows.
		// Files stay on disk; the sequence drops out of script order and
		// won't compile. Reversible via the row's "Add to project" pill once
		// it falls into orphan land. Skipped for orphans (already out).
		// mousedown for the same reason as the Add pill (focus-eating).
		if (!row.orphan) {
			const btn = parent.createEl("button", {
				cls: "clickable-icon firstdraft-outline-action",
				attr: { "aria-label": "Remove from project (keeps files on disk)" },
			});
			setIcon(btn, "eye-off");
			btn.addEventListener("mousedown", (e) => {
				if (e.button !== 0) return;
				e.stopPropagation();
				void this.handleRemoveFromProject(row);
			});
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
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
			if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
			const mode = computeDropMode(e, rowEl);
			rowEl.classList.remove("is-drop-before", "is-drop-after", "is-drop-swap");
			rowEl.classList.add(`is-drop-${mode}`);
		});
		rowEl.addEventListener("dragleave", () => {
			rowEl.classList.remove("is-drop-before", "is-drop-after", "is-drop-swap");
		});
		rowEl.addEventListener("drop", (e) => {
			e.preventDefault();
			const mode = computeDropMode(e, rowEl);
			rowEl.classList.remove("is-drop-before", "is-drop-after", "is-drop-swap");
			const sourceIdx = Number(e.dataTransfer?.getData("text/plain") ?? "-1");
			const targetIdx = Number(rowEl.getAttribute("data-index") ?? "-1");
			if (Number.isNaN(sourceIdx) || Number.isNaN(targetIdx)) return;
			if (sourceIdx === targetIdx || sourceIdx < 0 || targetIdx < 0) return;
			void this.handleReorder(sourceIdx, targetIdx, mode);
		});
	}

	private async handleReorder(
		sourceIdx: number,
		targetIdx: number,
		mode: DropMode,
	): Promise<void> {
		const sourceRow = this.rows[sourceIdx];
		const targetRow = this.rows[targetIdx];
		if (!sourceRow || !targetRow) return;
		// Defensive: orphan rows are draggable=false now, so dragstart can't
		// fire on them. If a stale event somehow arrives (e.g. mid-refresh),
		// just bail instead of writing nonsense to scenes:.
		if (sourceRow.orphan || targetRow.orphan) return;
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
		if (sourceOrder === targetOrder) return;

		// Operate on rows + the original scenesArray entries in parallel so
		// we preserve each entry's original shape (e.g. the `.fountain`
		// suffix in fountain-md projects). orderable[i] corresponds to
		// scenesArray[i] because outline-data builds rows in array order
		// before appending orphans.
		const entries = group.scenesArray.slice();

		if (mode === "swap") {
			[orderable[sourceOrder], orderable[targetOrder]] = [
				orderable[targetOrder]!,
				orderable[sourceOrder]!,
			];
			[entries[sourceOrder], entries[targetOrder]] = [
				entries[targetOrder]!,
				entries[sourceOrder]!,
			];
		} else {
			// Gap insert (before/after target). Splice source out first, then
			// adjust the target index for the removal shift, then insert.
			const [movedRow] = orderable.splice(sourceOrder, 1);
			const [movedEntry] = entries.splice(sourceOrder, 1);
			if (!movedRow || movedEntry === undefined) return;
			let insertAt = targetOrder;
			if (sourceOrder < targetOrder) insertAt -= 1;
			if (mode === "after") insertAt += 1;
			orderable.splice(insertAt, 0, movedRow);
			entries.splice(insertAt, 0, movedEntry);
		}

		try {
			await writeScenesArray(this.plugin.app, group.project.indexFilePath, entries);
			group.rows = [...orderable, ...orphans];
			group.scenesArray = entries;
			this.rows = this.groups.flatMap((g) => g.rows);
			this.renderFromGroups();
		} catch (e) {
			new Notice(`Reorder failed: ${(e as Error).message}`);
		}
	}

	// Add an orphan row to the project's sequences: array. Uses the project's
	// configured fountain format so the entry shape matches what the auto-inject
	// handler would produce on fountain creation. The new entry lands at the
	// bottom of the orderable list; the user can drag-reorder from there.
	private async handleAddToProject(row: OutlineRow): Promise<void> {
		const group = this.groups.find(
			(g) => g.project.indexFilePath === row.indexFilePath,
		);
		if (!group) return;
		const cfg = resolveProjectSettings(group.project, this.plugin.settings);
		const entry = fountainScenesArrayEntry(row.sequenceName, cfg.fountainFileFormat);
		try {
			await appendSceneToArray(
				this.plugin.app,
				group.project.indexFilePath,
				entry,
			);
			new Notice(`Added "${stripId(row.sequenceName)}" to the project.`);
			await this.refresh();
		} catch (e) {
			new Notice(`Add failed: ${(e as Error).message}`);
		}
	}

	// Symmetric opt-out: drop the sequence from the project's array without
	// touching files on disk. The row falls into orphan-land at the bottom of
	// the view; reversible via the "Add to project" pill that appears there.
	// No confirm modal — the action is non-destructive and reversible in two
	// clicks.
	private async handleRemoveFromProject(row: OutlineRow): Promise<void> {
		const group = this.groups.find(
			(g) => g.project.indexFilePath === row.indexFilePath,
		);
		if (!group) return;
		const cfg = resolveProjectSettings(group.project, this.plugin.settings);
		const entry = fountainScenesArrayEntry(row.sequenceName, cfg.fountainFileFormat);
		try {
			await removeSceneFromArray(
				this.plugin.app,
				group.project.indexFilePath,
				entry,
			);
			new Notice(`Removed "${stripId(row.sequenceName)}" from the project.`);
			await this.refresh();
		} catch (e) {
			new Notice(`Remove failed: ${(e as Error).message}`);
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
