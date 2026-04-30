import { ItemView, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import {
	buildProjectNotesData,
	enrichEntryAsync,
	type NoteEntry,
	type ProjectNotesData,
} from "./project-notes-data";
import { runCreateProjectNoteCommand } from "../development/create-project-note";
import { VIEW_TYPE_PROJECT_NOTES } from "./view-types";

// Right-sidebar panel surfacing project-relevant notes from anywhere in the
// vault. Two sections:
//
//   - References — files in <Project>/Development/References/ (recursively)
//   - Notes — union of files in any "Notes" subfolder under the project root,
//     plus files anywhere in the vault tagged with the project's note tag.
//
// Read-only navigation aid; click an entry to open the source file. The
// "+ Add note" header button creates a new note in a contextually appropriate
// Notes folder (see create-project-note.ts).

export class ProjectNotesView extends ItemView {
	private project: ProjectMeta | null = null;
	private data: ProjectNotesData | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: FirstDraftPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_PROJECT_NOTES;
	}

	getDisplayText(): string {
		return this.project
			? `Project notes — ${displayProject(this.project)}`
			: "Project notes";
	}

	getIcon(): string {
		return "sticky-note";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("firstdraft-pnotes");
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

		const cfg = resolveProjectSettings(this.project, this.plugin.settings);
		this.data = buildProjectNotesData(
			this.plugin.app,
			this.project,
			cfg,
			this.plugin.settings,
		);

		this.render();

		// Async excerpt enrichment — patches the existing entry rows in place
		// once file reads complete. Mutates entries directly so the data
		// reference stays stable for any future re-render from cache.
		void this.enrichVisibleEntries();
	}

	private render(): void {
		if (!this.data || !this.project) return;
		this.contentEl.empty();

		this.renderHeader(this.data);
		this.renderReferencesSection(this.data);
		this.renderNotesSection(this.data);
	}

	// ── header ──────────────────────────────────────────────────────────────

	private renderHeader(data: ProjectNotesData): void {
		const header = this.contentEl.createDiv({ cls: "firstdraft-pnotes-header" });
		const title = header.createEl("h2", {
			text: displayProject(data.project),
			cls: "firstdraft-pnotes-title",
		});
		void title;

		const total = data.references.length + data.notes.length;
		header.createDiv({
			text: `${total} ${total === 1 ? "entry" : "entries"} · #${data.noteTag}`,
			cls: "firstdraft-pnotes-subtitle",
		});

		const actions = header.createDiv({ cls: "firstdraft-pnotes-actions" });
		const addBtn = actions.createEl("button", {
			cls: "mod-cta firstdraft-pnotes-add",
			text: "+ Add note",
			attr: { "aria-label": "Create a new note in the contextual Notes folder" },
		});
		// mousedown for the same focus-eating reason as other right-sidebar
		// buttons; click stopPropagation guards against any parent handler.
		addBtn.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			e.stopPropagation();
			void runCreateProjectNoteCommand(this.plugin);
		});

		// Manual refresh — auto-refresh runs on vault create/delete/rename and
		// metadataCache.changed, but tag adds via direct file edits in another
		// app or filesystem-level changes Obsidian missed can leave the panel
		// stale. The button is the explicit "I just changed something, look
		// again" path.
		const refreshBtn = actions.createEl("button", {
			cls: "clickable-icon firstdraft-pnotes-refresh",
			attr: { "aria-label": "Refresh project notes" },
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			e.stopPropagation();
			void this.refresh();
		});
		refreshBtn.addEventListener("click", (e) => e.stopPropagation());
	}

	// ── References section ──────────────────────────────────────────────────

	private renderReferencesSection(data: ProjectNotesData): void {
		const section = this.contentEl.createDiv({ cls: "firstdraft-pnotes-section" });
		section.createEl("h3", {
			text: `References (${data.references.length})`,
			cls: "firstdraft-pnotes-section-title",
		});
		if (data.references.length === 0) {
			section.createEl("p", {
				text: "No references yet.",
				cls: "firstdraft-pnotes-empty",
			});
			return;
		}
		const list = section.createDiv({ cls: "firstdraft-pnotes-list" });
		for (const entry of data.references) this.renderEntry(list, entry);
	}

	// ── Notes section ───────────────────────────────────────────────────────

	private renderNotesSection(data: ProjectNotesData): void {
		const section = this.contentEl.createDiv({ cls: "firstdraft-pnotes-section" });
		section.createEl("h3", {
			text: `Notes (${data.notes.length})`,
			cls: "firstdraft-pnotes-section-title",
		});
		if (data.notes.length === 0) {
			const tip = section.createEl("p", {
				cls: "firstdraft-pnotes-empty",
			});
			tip.setText(
				`Drop notes into any "${this.plugin.settings.global.notesSubfolder}" subfolder under your project, or tag a note anywhere with `,
			);
			tip.createSpan({
				text: `#${data.noteTag}`,
				cls: "firstdraft-pnotes-tag",
			});
			tip.appendText(" to surface it here.");
			return;
		}
		const list = section.createDiv({ cls: "firstdraft-pnotes-list" });
		for (const entry of data.notes) this.renderEntry(list, entry);
	}

	// ── entry row ───────────────────────────────────────────────────────────

	private renderEntry(parent: HTMLElement, entry: NoteEntry): void {
		const el = parent.createDiv({ cls: "firstdraft-pnotes-entry" });
		const top = el.createDiv({ cls: "firstdraft-pnotes-entry-top" });
		const title = top.createDiv({ cls: "firstdraft-pnotes-entry-title" });
		title.setText(entry.file.basename);

		const badge = top.createSpan({
			cls: `firstdraft-pnotes-badge is-${entry.source}`,
			text: badgeLabel(entry.source),
		});
		void badge;

		const sub = el.createDiv({ cls: "firstdraft-pnotes-entry-sub" });
		sub.setText(`${pathHint(entry)} · ${relativeDate(entry.mtime)}`);

		const excerptEl = el.createDiv({ cls: "firstdraft-pnotes-entry-excerpt" });
		excerptEl.setText(entry.excerpt);

		// mousedown (not click) — right sidebar swallows the first click as
		// a focus-shift when the panel isn't already focused.
		el.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			void this.openEntry(entry);
		});
	}

	private async openEntry(entry: NoteEntry): Promise<void> {
		const leaf = this.plugin.app.workspace.getLeaf(false);
		await leaf.openFile(entry.file);
		// If we have a tag-match offset, scroll the editor to that line.
		if (entry.matchOffset !== null) {
			const view = leaf.view as unknown as {
				editor?: { offsetToPos: (n: number) => unknown; setCursor: (p: unknown) => void; scrollIntoView: (r: { from: unknown; to: unknown }, c?: boolean) => void };
			};
			const editor = view.editor;
			if (editor) {
				const pos = editor.offsetToPos(entry.matchOffset);
				editor.setCursor(pos);
				editor.scrollIntoView({ from: pos, to: pos }, true);
			}
		}
	}

	// ── empty / async ───────────────────────────────────────────────────────

	private renderEmptyNoProject(): void {
		this.contentEl.createEl("p", {
			text: "Open a file inside a project to see its notes.",
			cls: "firstdraft-pnotes-empty",
		});
	}

	private async enrichVisibleEntries(): Promise<void> {
		if (!this.data) return;
		const all = [...this.data.references, ...this.data.notes];
		const els = Array.from(
			this.contentEl.querySelectorAll<HTMLElement>(".firstdraft-pnotes-entry-excerpt"),
		);
		for (let i = 0; i < all.length; i++) {
			const entry = all[i];
			if (!entry) continue;
			await enrichEntryAsync(this.plugin.app, entry);
			const el = els[i];
			if (el) el.setText(entry.excerpt);
		}
	}
}

// ── helpers ──────────────────────────────────────────────────────────────

function badgeLabel(source: NoteEntry["source"]): string {
	switch (source) {
		case "folder":
			return "folder";
		case "tag":
			return "tag";
		case "reference":
			return "ref";
	}
}

function pathHint(entry: NoteEntry): string {
	const parent = entry.file.parent?.path;
	return parent ?? "";
}

function relativeDate(mtime: number): string {
	const now = Date.now();
	const diffMs = now - mtime;
	const day = 24 * 60 * 60 * 1000;
	if (diffMs < day) return "today";
	if (diffMs < 2 * day) return "yesterday";
	const days = Math.floor(diffMs / day);
	if (days < 14) return `${days}d ago`;
	const weeks = Math.floor(days / 7);
	if (weeks < 8) return `${weeks}w ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	const years = Math.floor(days / 365);
	return `${years}y ago`;
}

function displayProject(p: ProjectMeta): string {
	if (p.projectType === "tv-episode") {
		const ep = p.episode ?? "";
		const t = p.title ?? lastSegment(p.projectRootPath);
		return ep ? `${p.series ?? ""} ${ep} — ${t}`.trim() : t;
	}
	return p.title ?? lastSegment(p.projectRootPath);
}

function lastSegment(path: string): string {
	return path.split("/").pop() ?? path;
}

// ── activation ───────────────────────────────────────────────────────────

// Opens the project notes panel as a tab in the right sidebar. Reuses an
// existing leaf if one is already mounted there.
export async function activateProjectNotesView(
	plugin: FirstDraftPlugin,
): Promise<void> {
	const { workspace } = plugin.app;
	const existing = workspace.getLeavesOfType(VIEW_TYPE_PROJECT_NOTES);
	const rightSidebar = workspace.rightSplit;
	const inSidebar = existing.find((leaf) => isInSplit(leaf, rightSidebar));

	for (const leaf of existing) {
		if (leaf !== inSidebar) leaf.detach();
	}

	let leaf = inSidebar ?? null;
	if (!leaf) {
		leaf = workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_PROJECT_NOTES, active: true });
	}
	void workspace.revealLeaf(leaf);
}

// Opens the project notes panel split below the dev notes panel (or whatever
// the active right-sidebar leaf is). Programmatic equivalent of right-click
// → "Split right" so the user can have both panels visible at once.
export async function activateProjectNotesViewSplit(
	plugin: FirstDraftPlugin,
): Promise<void> {
	const { workspace } = plugin.app;

	const existing = workspace.getLeavesOfType(VIEW_TYPE_PROJECT_NOTES);
	const rightSidebar = workspace.rightSplit;
	const inSidebar = existing.find((leaf) => isInSplit(leaf, rightSidebar));
	if (inSidebar) {
		void workspace.revealLeaf(inSidebar);
		return;
	}

	// Detach stragglers in the main pane first.
	for (const leaf of existing) leaf.detach();

	// Try to split below the current right-sidebar leaf. Fall back to a fresh
	// right leaf if the workspace API doesn't support split here.
	const leaf = workspace.getRightLeaf(true);
	if (!leaf) {
		new Notice("Couldn't open a split right-sidebar pane.");
		return;
	}
	await leaf.setViewState({ type: VIEW_TYPE_PROJECT_NOTES, active: true });
	void workspace.revealLeaf(leaf);
}

function isInSplit(leaf: WorkspaceLeaf, split: unknown): boolean {
	let cur: { parent?: unknown } | null = leaf as unknown as { parent?: unknown };
	while (cur && cur.parent) {
		if (cur.parent === split) return true;
		cur = cur.parent as { parent?: unknown };
	}
	return false;
}

export function getProjectNotesView(
	plugin: FirstDraftPlugin,
): ProjectNotesView | null {
	const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECT_NOTES);
	const view = leaves[0]?.view;
	return view instanceof ProjectNotesView ? view : null;
}
