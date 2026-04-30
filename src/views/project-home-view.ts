import { ItemView, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { buildProjectHome, type EpisodeEntry, type ProjectHomeData } from "./project-home-data";
import { activateBeatSheetView } from "./beat-sheet-view";
import { activateOutlineView } from "./outline-view";
import { activateCharacterMatrixView } from "./character-matrix-view";
import { stripId } from "../utils/stable-id";
import { openProjectSettingsModal } from "../settings/project-settings-modal";
import { ensureSeasonProject } from "../projects/create-season";
import {
	displayProjectFullTitle,
	displayProjectPrimaryTitle,
} from "../projects/display";
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
		this.data = buildProjectHome(
			this.plugin.app,
			this.project,
			cfg,
			this.plugin.scanner,
		);

		this.renderHeader(this.data);

		if (this.data.isSeries) {
			// Series view: seasons-grouped episodes (collapsible per season)
			// + series-level recurring characters/locations.
			this.renderSeriesQuickActions(this.data);
			this.renderSeasonsSection(this.data);
			this.renderCharactersSection(this.data);
			this.renderLocationsSection(this.data);
			return;
		}

		if (this.data.isSeason) {
			// Season view: episodes in this season + season-arc
			// characters/locations + Outline access. Create Episode button
			// inherits the season number automatically.
			this.renderSeasonQuickActions(this.data);
			this.renderSeasonEpisodesSection(this.data);
			this.renderCharactersSection(this.data);
			this.renderLocationsSection(this.data);
			return;
		}

		this.renderQuickActions(this.data);
		this.renderScenesSection(this.data);
		this.renderCharactersSection(this.data);
		this.renderLocationsSection(this.data);
	}

	// ── header ──────────────────────────────────────────────────────────────

	private renderHeader(data: ProjectHomeData): void {
		const header = this.contentEl.createDiv({ cls: "firstdraft-home-header" });

		// Breadcrumb chain. Episodes show: ← Series · Season. Seasons show:
		// ← Series. Each segment is clickable, opening that ancestor's
		// Index.md. Primary title only so subtitled franchise names
		// ("Power: Book II") stay tight in the breadcrumb.
		const breadcrumbAncestors: ProjectMeta[] = [];
		if (data.parentSeries) breadcrumbAncestors.push(data.parentSeries);
		if (data.parentSeason) breadcrumbAncestors.push(data.parentSeason);
		if (breadcrumbAncestors.length > 0) {
			const crumb = header.createDiv({ cls: "firstdraft-home-breadcrumb-row" });
			breadcrumbAncestors.forEach((ancestor, i) => {
				const link = crumb.createEl("a", {
					cls: "firstdraft-home-breadcrumb",
					text: i === 0 ? `← ${displayProjectPrimaryTitle(ancestor)}` : displayProjectPrimaryTitle(ancestor),
					attr: { href: "#" },
				});
				link.addEventListener("click", (e) => {
					e.preventDefault();
					const indexFile = this.plugin.app.vault.getAbstractFileByPath(
						ancestor.indexFilePath,
					);
					if (indexFile && (indexFile as TFile).extension === "md") {
						void this.plugin.app.workspace
							.getLeaf(false)
							.openFile(indexFile as TFile);
					}
				});
				if (i < breadcrumbAncestors.length - 1) {
					crumb.createSpan({
						text: " · ",
						cls: "firstdraft-home-breadcrumb-sep",
					});
				}
			});
		}

		// Title row: title block (primary + optional subtitle) + cog icon
		// for Project Settings. Cog uses mousedown (with click stopPropagation)
		// for the same focus-eating reason as the dev-notes-panel cog and
		// other sidebar buttons — Obsidian's leaf focus model swallows the
		// first click.
		const titleRow = header.createDiv({ cls: "firstdraft-home-title-row" });
		const titleBlock = titleRow.createDiv({ cls: "firstdraft-home-title-block" });
		// For tv-episode projects we keep the existing season/episode
		// composition; for series and features we render two-tier when a
		// subtitle is set ("Power" big, "Book II" smaller below).
		if (data.project.projectType === "tv-episode") {
			titleBlock.createEl("h1", {
				text: displayProject(data.project),
				cls: "firstdraft-home-title",
			});
		} else {
			titleBlock.createEl("h1", {
				text: displayProjectPrimaryTitle(data.project),
				cls: "firstdraft-home-title",
			});
			const sub = data.project.subtitle?.trim();
			if (sub && sub !== "") {
				titleBlock.createEl("div", {
					text: sub,
					cls: "firstdraft-home-subtitle",
				});
			}
		}
		const cog = titleRow.createEl("button", {
			cls: "firstdraft-home-cog clickable-icon",
			attr: { "aria-label": "Project settings" },
		});
		setIcon(cog, "settings");
		const project = data.project;
		cog.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			e.stopPropagation();
			openProjectSettingsModal(this.plugin, project);
		});
		cog.addEventListener("click", (e) => e.stopPropagation());
		const meta: string[] = [];
		if (data.isSeries) {
			const seasonCount = data.seasons.length;
			const epCount = data.seasons.reduce((n, s) => n + s.episodes.length, 0);
			meta.push("Series");
			meta.push(`${seasonCount} season${seasonCount === 1 ? "" : "s"}`);
			meta.push(`${epCount} episode${epCount === 1 ? "" : "s"}`);
		} else if (data.isSeason) {
			meta.push("Season");
			meta.push(
				`${data.seasonEpisodes.length} episode${data.seasonEpisodes.length === 1 ? "" : "s"}`,
			);
		} else {
			meta.push(data.isTv ? "TV episode" : "Feature");
			meta.push(
				`${data.scenes.length} scene${data.scenes.length === 1 ? "" : "s"}`,
			);
		}
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

	private renderSeriesQuickActions(data: ProjectHomeData): void {
		void data;
		const wrap = this.contentEl.createDiv({ cls: "firstdraft-home-actions" });
		this.actionButton(wrap, "calendar-plus", "Create season", () => {
			void this.runCommand("create-season");
		});
	}

	private renderSeasonQuickActions(data: ProjectHomeData): void {
		const wrap = this.contentEl.createDiv({ cls: "firstdraft-home-actions" });
		this.actionButton(wrap, "plus-square", "Create episode", () => {
			void this.runCommand("create-episode");
		});
		if (data.seasonOutlineFile) {
			this.actionButton(wrap, "scroll-text", "Season Outline", () => {
				if (data.seasonOutlineFile)
					void this.plugin.app.workspace
						.getLeaf(false)
						.openFile(data.seasonOutlineFile);
			});
			this.actionButton(wrap, "list-tree", "Make episodes from outline", () => {
				void this.runCommand("make-episodes-from-season-outline");
			});
		}
	}

	// Series Project Home: collapsible Seasons sections, each containing
	// the episodes nested inside that season. Season headings are clickable
	// when an explicit Season project (kind: season) exists for that key —
	// click opens the Season Index. Otherwise the heading is a simple label.
	private renderSeasonsSection(data: ProjectHomeData): void {
		const section = this.contentEl.createDiv({ cls: "firstdraft-home-section" });
		section.createEl("h2", {
			text: "Seasons",
			cls: "firstdraft-home-section-title",
		});

		if (data.seasons.length === 0) {
			section.createEl("p", {
				text: 'No seasons yet. Run "Create season" above to add the first one.',
				cls: "firstdraft-home-empty",
			});
			return;
		}

		for (const season of data.seasons) {
			const details = section.createEl("details", {
				cls: "firstdraft-home-season",
			});
			details.setAttr("open", "");
			const summary = details.createEl("summary", {
				cls: "firstdraft-home-season-summary",
			});
			const title = summary.createSpan({ cls: "firstdraft-home-season-title" });
			title.setText(season.seasonKey);
			summary.createSpan({
				cls: "firstdraft-home-season-meta",
				text: ` · ${season.episodes.length} episode${season.episodes.length === 1 ? "" : "s"}`,
			});

			// "Open season" link — only when an explicit Season project exists
			// for this key. mousedown to bypass focus-eating on sidebar leaves.
			//
			// When the season folder DOESN'T have an Index yet (orphan from
			// before auto-create or a manually-created folder), surface a
			// "Create season" affordance instead so the user can backfill in
			// place rather than digging into the command palette.
			if (season.seasonProject) {
				const seasonProj = season.seasonProject;
				const openLink = summary.createEl("a", {
					cls: "firstdraft-home-season-open",
					text: "Open",
					attr: { href: "#" },
				});
				openLink.addEventListener("mousedown", (e) => {
					if (e.button !== 0) return;
					e.stopPropagation();
					e.preventDefault();
					const f = this.plugin.app.vault.getAbstractFileByPath(
						seasonProj.indexFilePath,
					);
					if (f && (f as TFile).extension === "md") {
						void this.plugin.app.workspace
							.getLeaf(false)
							.openFile(f as TFile);
					}
				});
				openLink.addEventListener("click", (e) => e.preventDefault());
			} else {
				const createLink = summary.createEl("a", {
					cls: "firstdraft-home-season-create",
					text: "Create season",
					attr: { href: "#" },
				});
				const seasonKey = season.seasonKey;
				createLink.addEventListener("mousedown", (e) => {
					if (e.button !== 0) return;
					e.stopPropagation();
					e.preventDefault();
					void this.backfillSeasonProject(data, seasonKey);
				});
				createLink.addEventListener("click", (e) => e.preventDefault());
			}

			const list = details.createDiv({ cls: "firstdraft-home-list" });
			if (season.episodes.length === 0) {
				list.createEl("p", {
					text: "No episodes in this season yet.",
					cls: "firstdraft-home-empty",
				});
				continue;
			}
			for (const ep of season.episodes) {
				this.renderEpisodeItem(list, ep);
			}
		}
	}

	// Season Project Home: episodes inside this season as a flat list
	// (already filtered to one season). Mirrors the per-season group used
	// at the series level but without the surrounding details collapse.
	private renderSeasonEpisodesSection(data: ProjectHomeData): void {
		const section = this.contentEl.createDiv({ cls: "firstdraft-home-section" });
		section.createEl("h2", {
			text: "Episodes",
			cls: "firstdraft-home-section-title",
		});
		if (data.seasonEpisodes.length === 0) {
			section.createEl("p", {
				text: 'No episodes yet. Use "Create episode" above to add the first one.',
				cls: "firstdraft-home-empty",
			});
			return;
		}
		const list = section.createDiv({ cls: "firstdraft-home-list" });
		for (const ep of data.seasonEpisodes) this.renderEpisodeItem(list, ep);
	}

	// Render a single episode as a clickable list item. Reused by both the
	// series-level (per-season group) and season-level rendering.
	private renderEpisodeItem(list: HTMLElement, ep: EpisodeEntry): void {
		const item = list.createDiv({ cls: "firstdraft-home-list-item is-clickable" });
		const numCell = item.createDiv({ cls: "firstdraft-home-list-num" });
		numCell.setText(ep.episodeCode || "—");
		const main = item.createDiv({ cls: "firstdraft-home-list-main" });
		main.createDiv({ cls: "firstdraft-home-list-title", text: ep.title });
		item.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			const f = this.plugin.app.vault.getAbstractFileByPath(ep.indexFilePath);
			if (f && (f as TFile).extension === "md") {
				void this.plugin.app.workspace.getLeaf(false).openFile(f as TFile);
			}
		});
	}

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

	// Backfill a Season project for an orphan season folder shown on the
	// Series Home (folder containing episodes, no Index.md). Re-renders the
	// home so the new "Open" link shows immediately. Series project is
	// always available here because backfill is only offered on the series
	// view's seasons section.
	private async backfillSeasonProject(
		data: ProjectHomeData,
		seasonKey: string,
	): Promise<void> {
		const seasonNum = /^S(\d+)$/i.exec(seasonKey)?.[1];
		if (!seasonNum) {
			new Notice(`Couldn't parse a season number from "${seasonKey}".`);
			return;
		}
		const padded = seasonNum.padStart(2, "0");
		try {
			const result = await ensureSeasonProject(
				this.plugin,
				data.project,
				padded,
			);
			if (result.created) {
				new Notice(`Created S${padded} as a season project.`);
			} else {
				new Notice(`S${padded} already has a season project.`);
			}
			await this.refresh();
		} catch (e) {
			new Notice(`Couldn't create season: ${(e as Error).message}`);
		}
	}

	// ── sections ────────────────────────────────────────────────────────────

	private renderScenesSection(data: ProjectHomeData): void {
		const section = this.contentEl.createDiv({ cls: "firstdraft-home-section" });
		section.createEl("h2", { text: "Sequences", cls: "firstdraft-home-section-title" });

		if (data.scenes.length === 0) {
			section.createEl("p", {
				text: "No sequences yet. Use the New sequence button or make sequences from a treatment.",
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
				text: "No characters yet. Use Create character or tag dialogue cues.",
				cls: "firstdraft-home-empty",
			});
			return;
		}

		// Role grouping. resolveRole has already folded legacy roleless entries
		// into "main"; entries whose roles don't match the current view scope
		// (e.g. a guest from S01 viewed at S02 or at the series root) come back
		// as null and are filtered out here.
		//   - Series view: only series-wide tiers (Main / Recurring).
		//   - Feature view: project-scoped tiers (Main / Supporting / Featured Extra).
		//   - Season / episode view: full TV ladder.
		// Empty groups are skipped so the section stays compact.
		const allGroups: { label: string; key: string; role: string }[] = [
			{ label: "Main", key: "main", role: "main" },
			{ label: "Recurring", key: "recurring", role: "recurring" },
			{ label: "Supporting", key: "supporting", role: "supporting" },
			{ label: "Guest", key: "guest", role: "guest" },
			{ label: "Featured Extra", key: "featured-extra", role: "featured-extra" },
		];
		const visibleKeys = (() => {
			if (data.isSeries) return new Set(["main", "recurring"]);
			if (data.project.projectType === "feature")
				return new Set(["main", "supporting", "featured-extra"]);
			return new Set(["main", "recurring", "guest", "featured-extra"]);
		})();
		const groups = allGroups
			.filter((g) => visibleKeys.has(g.key))
			.map((g) => ({
				label: g.label,
				key: g.key,
				members: data.characters.filter((c) => c.role === g.role),
			}));

		for (const group of groups) {
			if (group.members.length === 0) continue;
			const details = section.createEl("details", {
				cls: `firstdraft-home-rolegroup is-${group.key}`,
			});
			details.setAttr("open", "");
			const summary = details.createEl("summary", {
				cls: "firstdraft-home-rolegroup-summary",
			});
			summary.createSpan({
				cls: "firstdraft-home-rolegroup-label",
				text: group.label,
			});
			summary.createSpan({
				cls: "firstdraft-home-rolegroup-count",
				text: ` · ${group.members.length}`,
			});

			const list = details.createDiv({ cls: "firstdraft-home-list" });
			for (const c of group.members) {
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

		// Production-correct labels: Primary (= standing set, in many episodes),
		// Recurring (returns across episodes), One-off (single-episode scout).
		// resolveRole folds legacy roleless entries into Primary. Series-level
		// views suppress One-Off — single-episode locations are episode-scope.
		const allGroups: { label: string; key: string; role: string }[] = [
			{ label: "Primary", key: "primary", role: "primary" },
			{ label: "Recurring", key: "recurring", role: "recurring" },
			{ label: "One-Off", key: "one-off", role: "one-off" },
		];
		const visibleKeys = data.isSeries
			? new Set(["primary", "recurring"])
			: new Set(["primary", "recurring", "one-off"]);
		const groups = allGroups
			.filter((g) => visibleKeys.has(g.key))
			.map((g) => ({
				label: g.label,
				key: g.key,
				members: data.locations.filter((l) => l.role === g.role),
			}));

		for (const group of groups) {
			if (group.members.length === 0) continue;
			const details = section.createEl("details", {
				cls: `firstdraft-home-rolegroup is-${group.key}`,
			});
			details.setAttr("open", "");
			const summary = details.createEl("summary", {
				cls: "firstdraft-home-rolegroup-summary",
			});
			summary.createSpan({
				cls: "firstdraft-home-rolegroup-label",
				text: group.label,
			});
			summary.createSpan({
				cls: "firstdraft-home-rolegroup-count",
				text: ` · ${group.members.length}`,
			});

			const list = details.createDiv({ cls: "firstdraft-home-list" });
			for (const l of group.members) {
				const item = list.createDiv({ cls: "firstdraft-home-list-item" });
				const main = item.createDiv({ cls: "firstdraft-home-list-main" });
				main.createDiv({ text: l.folderName, cls: "firstdraft-home-list-title" });
				if (l.parentLocation) {
					main.createDiv({
						text: `inside ${l.parentLocation}`,
						cls: "firstdraft-home-list-meta",
					});
				}
				if (l.canonicalFile) {
					item.addClass("is-clickable");
					item.addEventListener("mousedown", (e) => {
						if (e.button !== 0) return;
						void this.openFile(l.canonicalFile);
					});
				}
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
	// Features and series: full label with subtitle when present
	// ("Babylon: Rise of a Shotta") via the shared display helper.
	return displayProjectFullTitle(p);
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
