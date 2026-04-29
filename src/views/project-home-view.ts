import { ItemView, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { buildProjectHome, type ProjectHomeData } from "./project-home-data";
import { activateBeatSheetView } from "./beat-sheet-view";
import { activateOutlineView } from "./outline-view";
import { activateCharacterMatrixView } from "./character-matrix-view";
import { stripId } from "../utils/stable-id";
import { VIEW_TYPE_PROJECT_HOME } from "./view-types";

// Project Home — full-pane dashboard for a project. Single landing page that
// surfaces scenes, characters, locations, and quick actions. Replaces the
// "navigate via file tree" pattern; the lock-to-project file-tree command
// remains available for raw file access.

export class ProjectHomeView extends ItemView {
	private project: ProjectMeta | null = null;
	private data: ProjectHomeData | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: FirstDraftPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_PROJECT_HOME;
	}

	getDisplayText(): string {
		return this.project ? `Home — ${displayProject(this.project)}` : "Project home";
	}

	getIcon(): string {
		return "home";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("firstdraft-home");
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
		this.data = buildProjectHome(this.plugin.app, this.project, cfg);

		this.renderHeader(this.data);
		this.renderQuickActions(this.data);
		this.renderScenesSection(this.data);
		this.renderCharactersSection(this.data);
		this.renderLocationsSection(this.data);
	}

	// ── header ──────────────────────────────────────────────────────────────

	private renderHeader(data: ProjectHomeData): void {
		const header = this.contentEl.createDiv({ cls: "firstdraft-home-header" });
		const title = header.createEl("h1", {
			text: displayProject(data.project),
			cls: "firstdraft-home-title",
		});
		void title;
		const meta: string[] = [];
		meta.push(data.isTv ? "TV episode" : "Feature");
		meta.push(`${data.scenes.length} scene${data.scenes.length === 1 ? "" : "s"}`);
		meta.push(
			`${data.characters.length} character${data.characters.length === 1 ? "" : "s"}`,
		);
		meta.push(
			`${data.locations.length} location${data.locations.length === 1 ? "" : "s"}`,
		);
		header.createDiv({
			text: meta.join(" · "),
			cls: "firstdraft-home-meta",
		});
	}

	// ── quick actions ───────────────────────────────────────────────────────

	private renderQuickActions(data: ProjectHomeData): void {
		const wrap = this.contentEl.createDiv({ cls: "firstdraft-home-actions" });

		this.actionButton(wrap, "list-ordered", "Outline", () => {
			void activateOutlineView(this.plugin);
		});
		this.actionButton(wrap, "grid", "Character matrix", () => {
			void activateCharacterMatrixView(this.plugin);
		});
		this.actionButton(wrap, "list-checks", "Beat sheet", () => {
			void activateBeatSheetView(this.plugin);
		});
		if (data.treatmentFile) {
			this.actionButton(wrap, "scroll-text", "Treatment", () => {
				if (data.treatmentFile)
					void this.plugin.app.workspace.getLeaf(false).openFile(data.treatmentFile);
			});
		}
		this.actionButton(wrap, "plus-square", "New sequence", () => {
			void this.runCommand("create-new-scene");
		});
	}

	private actionButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void,
	): void {
		const btn = parent.createEl("button", { cls: "firstdraft-home-action" });
		const iconWrap = btn.createSpan({ cls: "firstdraft-home-action-icon" });
		setIcon(iconWrap, icon);
		btn.createSpan({ text: label, cls: "firstdraft-home-action-label" });
		// mousedown (not click) — left sidebar focus model swallows first click
		// when the panel isn't already focused.
		btn.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			onClick();
		});
	}

	private async runCommand(commandId: string): Promise<void> {
		const fullId = `${this.plugin.manifest.id}:${commandId}`;
		const commands = (this.plugin.app as unknown as {
			commands?: { executeCommandById?: (id: string) => boolean };
		}).commands;
		commands?.executeCommandById?.(fullId);
	}

	// ── sections ────────────────────────────────────────────────────────────

	private renderScenesSection(data: ProjectHomeData): void {
		const section = this.contentEl.createDiv({ cls: "firstdraft-home-section" });
		section.createEl("h2", { text: "Sequences", cls: "firstdraft-home-section-title" });

		if (data.scenes.length === 0) {
			section.createEl("p", {
				text: "No sequences yet. Use the New sequence button or promote a treatment.",
				cls: "firstdraft-home-empty",
			});
			return;
		}

		const list = section.createDiv({ cls: "firstdraft-home-list" });
		for (const entry of data.scenes) {
			const item = list.createDiv({ cls: "firstdraft-home-list-item" });
			const numberCell = item.createDiv({ cls: "firstdraft-home-list-num" });
			numberCell.setText(String(entry.index));

			const main = item.createDiv({ cls: "firstdraft-home-list-main" });
			const title = main.createDiv({ cls: "firstdraft-home-list-title" });
			title.setText(stripId(entry.row.sequenceName));

			const meta: string[] = [];
			if (entry.row.orphan) meta.push("not in project");
			if (entry.row.missing) meta.push("no files");
			if (entry.row.characters.length > 0)
				meta.push(`${entry.row.characters.length} char`);
			if (entry.row.locations.length > 0)
				meta.push(`${entry.row.locations.length} loc`);
			if (meta.length > 0) {
				main.createDiv({
					text: meta.join(" · "),
					cls: "firstdraft-home-list-meta",
				});
			}

			const target = entry.row.devNoteFile ?? entry.row.fountainFile;
			if (target) {
				item.addClass("is-clickable");
				item.addEventListener("mousedown", (e) => {
					if (e.button !== 0) return;
					void this.openFile(target);
				});
			}
		}
	}

	private renderCharactersSection(data: ProjectHomeData): void {
		const section = this.contentEl.createDiv({ cls: "firstdraft-home-section" });
		section.createEl("h2", { text: "Characters", cls: "firstdraft-home-section-title" });

		if (data.characters.length === 0) {
			section.createEl("p", {
				text: "No characters yet. Tag dialogue cues or use Create character from selection.",
				cls: "firstdraft-home-empty",
			});
			return;
		}

		const list = section.createDiv({ cls: "firstdraft-home-list" });
		for (const c of data.characters) {
			const item = list.createDiv({ cls: "firstdraft-home-list-item" });
			const main = item.createDiv({ cls: "firstdraft-home-list-main" });
			const title = main.createDiv({ cls: "firstdraft-home-list-title" });
			title.setText(c.folderName);
			if (c.isGroup) title.addClass("is-group");

			const subParts: string[] = [];
			if (c.isGroup) {
				subParts.push(
					c.groupMembers.length > 0
						? `Members: ${c.groupMembers.join(", ")}`
						: "group",
				);
			} else if (c.aliases.length > 0) {
				subParts.push(`Also: ${c.aliases.join(", ")}`);
			}
			if (subParts.length > 0) {
				main.createDiv({
					text: subParts.join(" · "),
					cls: "firstdraft-home-list-meta",
				});
			}

			if (c.canonicalFile) {
				item.addClass("is-clickable");
				item.addEventListener("mousedown", (e) => {
					if (e.button !== 0) return;
					void this.openFile(c.canonicalFile);
				});
			}
		}
	}

	private renderLocationsSection(data: ProjectHomeData): void {
		const section = this.contentEl.createDiv({ cls: "firstdraft-home-section" });
		section.createEl("h2", { text: "Locations", cls: "firstdraft-home-section-title" });

		if (data.locations.length === 0) {
			section.createEl("p", {
				text: "No locations yet.",
				cls: "firstdraft-home-empty",
			});
			return;
		}

		const list = section.createDiv({ cls: "firstdraft-home-list" });
		for (const l of data.locations) {
			const item = list.createDiv({ cls: "firstdraft-home-list-item" });
			const main = item.createDiv({ cls: "firstdraft-home-list-main" });
			main.createDiv({
				text: l.folderName,
				cls: "firstdraft-home-list-title",
			});
			if (l.canonicalFile) {
				item.addClass("is-clickable");
				item.addEventListener("mousedown", (e) => {
					if (e.button !== 0) return;
					void this.openFile(l.canonicalFile);
				});
			}
		}
	}

	// ── helpers ─────────────────────────────────────────────────────────────

	private async openFile(file: TFile | null): Promise<void> {
		if (!file) return;
		await this.plugin.app.workspace.getLeaf(false).openFile(file);
	}

	private renderEmptyNoProject(): void {
		const wrap = this.contentEl.createDiv({ cls: "firstdraft-home-empty-wrap" });
		wrap.createEl("p", {
			text: "Open a file inside a project to see its home.",
		});
	}
}

function displayProject(p: ProjectMeta): string {
	if (p.projectType === "tv-episode") {
		const ep = p.episode ?? "";
		const t = p.title ?? "";
		const series = p.series ?? "";
		const fallback = lastSegment(p.projectRootPath);
		return ep ? `${series} ${ep}${t ? " — " + t : ""}`.trim() : t || fallback;
	}
	// For features, prefer frontmatter title; fall back to the project folder
	// name (much friendlier than the full index path).
	return p.title ?? lastSegment(p.projectRootPath);
}

function lastSegment(path: string): string {
	const seg = path.split("/").pop() ?? path;
	return seg;
}

export async function activateProjectHomeView(
	plugin: FirstDraftPlugin,
): Promise<void> {
	const { workspace } = plugin.app;

	// Find an existing leaf already mounted in the LEFT sidebar; reuse if so.
	const existing = workspace.getLeavesOfType(VIEW_TYPE_PROJECT_HOME);
	const leftSidebar = workspace.leftSplit;
	const inSidebar = existing.find((leaf) => isInSplit(leaf, leftSidebar));

	// Detach any project-home leaves that ended up elsewhere (e.g. main area
	// from an earlier test), so we don't end up with two homes.
	for (const leaf of existing) {
		if (leaf !== inSidebar) leaf.detach();
	}

	let leaf = inSidebar ?? null;
	if (!leaf) {
		leaf = workspace.getLeftLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_PROJECT_HOME, active: true });
	}
	void workspace.revealLeaf(leaf);
}

// Walk up a leaf's parent chain to see if it lives inside the given split.
function isInSplit(leaf: WorkspaceLeaf, split: unknown): boolean {
	let cur: { parent?: unknown } | null = leaf as unknown as { parent?: unknown };
	while (cur && cur.parent) {
		if (cur.parent === split) return true;
		cur = cur.parent as { parent?: unknown };
	}
	return false;
}

export function getProjectHomeView(
	plugin: FirstDraftPlugin,
): ProjectHomeView | null {
	const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECT_HOME);
	const view = leaves[0]?.view;
	return view instanceof ProjectHomeView ? view : null;
}
