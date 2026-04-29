import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { findSiblingEpisodes } from "../projects/episodes";
import { resolveProjectSettings } from "../settings/resolve";
import {
	buildCharacterMatrix,
	buildSeasonMatrix,
	countPresence,
	type MatrixData,
} from "./character-matrix-data";
import { VIEW_TYPE_CHARACTER_MATRIX } from "./view-types";

// Phase 3b — Character matrix. Full-pane view; rows = characters in project
// roster, columns = scenes in script order. Each cell shows a presence dot
// if the character (or one of their aliases) is in that scene's
// characters: array.
//
// Refresh triggers: active-leaf-change and metadataCache 'changed' (the latter
// wired in events/register.ts).

type SortMode = "alpha" | "frequency";
type Mode = "episode" | "season";

export class CharacterMatrixView extends ItemView {
	private project: ProjectMeta | null = null;
	private mode: Mode = "episode";
	private sortMode: SortMode = "alpha";
	private data: MatrixData | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: FirstDraftPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_CHARACTER_MATRIX;
	}

	getDisplayText(): string {
		return this.project ? `Matrix — ${displayProject(this.project)}` : "Character matrix";
	}

	getIcon(): string {
		return "grid";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("firstdraft-matrix");
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
		if (!isTV) this.mode = "episode";

		this.data = await this.buildData(this.project, this.mode);
		const sorted = this.sortRowsByMode(this.data, this.sortMode);

		this.renderHeader(this.project, isTV);

		if (sorted.rows.length === 0 || sorted.scenes.length === 0) {
			this.renderEmptyNoData();
			return;
		}

		this.renderTable(sorted);
	}

	private async buildData(project: ProjectMeta, mode: Mode): Promise<MatrixData> {
		if (mode === "episode" || project.projectType !== "tv-episode") {
			const cfg = resolveProjectSettings(project, this.plugin.settings);
			return buildCharacterMatrix(this.plugin.app, project, cfg);
		}
		const siblings = findSiblingEpisodes(this.plugin, project);
		const inputs = siblings.map((p) => ({
			project: p,
			cfg: resolveProjectSettings(p, this.plugin.settings),
		}));
		return buildSeasonMatrix(this.plugin.app, inputs);
	}

	// Returns a new MatrixData with rows reordered. Presence and cueCounts
	// rows are kept aligned with the new row order.
	private sortRowsByMode(data: MatrixData, sortMode: SortMode): MatrixData {
		if (sortMode === "alpha") return data; // already alphabetical from roster
		const order = data.rows
			.map((entry, idx) => ({
				entry,
				idx,
				count: countPresence(data.presence[idx]),
			}))
			.sort((a, b) => {
				if (b.count !== a.count) return b.count - a.count;
				return a.entry.name.localeCompare(b.entry.name);
			});
		return {
			rows: order.map((o) => o.entry),
			scenes: data.scenes,
			presence: order.map((o) => data.presence[o.idx] ?? []),
			cueCounts: order.map((o) => data.cueCounts[o.idx] ?? []),
		};
	}

	private renderHeader(project: ProjectMeta, isTV: boolean): void {
		const header = this.contentEl.createDiv({ cls: "firstdraft-matrix-header" });
		const top = header.createDiv({ cls: "firstdraft-matrix-header-top" });
		top.createEl("h2", { text: displayProject(project) });

		const controls = top.createDiv({ cls: "firstdraft-matrix-controls" });
		this.renderSortToggle(controls);
		if (isTV) this.renderModeToggle(controls);

		if (this.data) {
			const sub = header.createDiv({ cls: "firstdraft-matrix-subtitle" });
			sub.setText(
				`${this.data.rows.length} character${this.data.rows.length === 1 ? "" : "s"} × ${this.data.scenes.length} scene${this.data.scenes.length === 1 ? "" : "s"}`,
			);
		}
	}

	private renderSortToggle(parent: HTMLElement): void {
		const wrap = parent.createDiv({ cls: "firstdraft-matrix-toggle" });
		const make = (label: string, value: SortMode) => {
			const btn = wrap.createEl("button", {
				text: label,
				cls:
					"firstdraft-matrix-toggle-btn" +
					(this.sortMode === value ? " is-active" : ""),
			});
			btn.addEventListener("mousedown", (e) => {
				if (e.button !== 0) return;
				if (this.sortMode === value) return;
				this.sortMode = value;
				void this.refresh();
			});
		};
		make("A–Z", "alpha");
		make("Frequency", "frequency");
	}

	private renderModeToggle(parent: HTMLElement): void {
		const wrap = parent.createDiv({ cls: "firstdraft-matrix-toggle" });
		const make = (label: string, value: Mode) => {
			const btn = wrap.createEl("button", {
				text: label,
				cls:
					"firstdraft-matrix-toggle-btn" +
					(this.mode === value ? " is-active" : ""),
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

	private renderTable(data: MatrixData): void {
		const wrap = this.contentEl.createDiv({ cls: "firstdraft-matrix-list-wrap" });

		// Column header row
		const headerRow = wrap.createDiv({
			cls: "firstdraft-matrix-row firstdraft-matrix-header-row",
		});
		headerRow.createDiv({
			text: "Character",
			cls: "firstdraft-matrix-col-header",
		});
		headerRow.createDiv({
			text: "Scenes",
			cls: "firstdraft-matrix-col-header",
		});

		data.rows.forEach((row, r) => {
			const presenceRow = data.presence[r] ?? [];
			const cueRow = data.cueCounts[r] ?? [];
			const sceneIndices: number[] = [];
			for (let c = 0; c < data.scenes.length; c++) {
				if (presenceRow[c]) sceneIndices.push(c);
			}

			const rowEl = wrap.createDiv({ cls: "firstdraft-matrix-row" });

			// Left column: character name + meta
			const nameCell = rowEl.createDiv({
				cls:
					"firstdraft-matrix-row-name" + (row.isGroup ? " is-group" : ""),
			});
			const nameLine = nameCell.createDiv({ cls: "firstdraft-matrix-row-title" });
			nameLine.setText(row.folderName);
			if (row.isGroup) {
				nameCell.createEl("small", {
					text:
						row.groupMembers.length > 0
							? `Members: ${row.groupMembers.join(", ")}`
							: "group",
					cls: "firstdraft-matrix-row-meta",
				});
			} else if (row.aliases.length > 0) {
				nameCell.createEl("small", {
					text: `Also: ${row.aliases.join(", ")}`,
					cls: "firstdraft-matrix-row-meta",
				});
			}
			nameCell.createEl("small", {
				text: `${sceneIndices.length} scene${sceneIndices.length === 1 ? "" : "s"}`,
				cls: "firstdraft-matrix-row-count",
			});
			if (row.canonicalFile) {
				nameCell.addEventListener("mousedown", (e) => {
					if (e.button !== 0) return;
					void this.openFile(row.canonicalFile);
				});
				nameCell.addClass("is-clickable");
			}

			// Right column: scenes list
			const scenesCell = rowEl.createDiv({ cls: "firstdraft-matrix-row-scenes" });
			if (sceneIndices.length === 0) {
				scenesCell.createEl("span", {
					text: "No scenes yet.",
					cls: "firstdraft-matrix-row-empty",
				});
				return;
			}

			let lastEpisode: string | undefined = undefined;
			for (const idx of sceneIndices) {
				const scene = data.scenes[idx];
				if (!scene) continue;

				// Season-mode episode header: emit when the episode label changes
				// across consecutive scenes.
				if (scene.episodeLabel && scene.episodeLabel !== lastEpisode) {
					scenesCell.createEl("div", {
						text: scene.episodeLabel,
						cls: "firstdraft-matrix-row-episode",
					});
					lastEpisode = scene.episodeLabel;
				}

				const item = scenesCell.createEl("div", {
					cls: "firstdraft-matrix-row-scene",
				});
				item.createSpan({
					text: scene.sceneName,
					cls: "firstdraft-matrix-row-scene-name",
				});
				const count = cueRow[idx] ?? 0;
				item.createSpan({
					text: count > 0 ? String(count) : "—",
					cls:
						"firstdraft-matrix-row-scene-count" +
						(count === 0 ? " is-empty" : ""),
				});
				if (scene.devNoteFile) {
					item.addEventListener("mousedown", (e) => {
						if (e.button !== 0) return;
						void this.openFile(scene.devNoteFile);
					});
					item.addClass("is-clickable");
				}
			}
		});
	}

	private async openFile(file: TFile | null): Promise<void> {
		if (!file) return;
		await this.plugin.app.workspace.getLeaf(false).openFile(file);
	}

	private renderEmptyNoProject(): void {
		const wrap = this.contentEl.createDiv({ cls: "firstdraft-matrix-empty" });
		wrap.createEl("p", {
			text: "Open a file inside a project to see its character matrix.",
		});
	}

	private renderEmptyNoData(): void {
		const wrap = this.contentEl.createDiv({ cls: "firstdraft-matrix-empty" });
		wrap.createEl("p", {
			text: "No characters or scenes yet for this project.",
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

// Convenience: open and reveal the matrix view.
export async function activateCharacterMatrixView(
	plugin: FirstDraftPlugin,
): Promise<void> {
	const { workspace } = plugin.app;
	let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHARACTER_MATRIX)[0] ?? null;
	if (!leaf) {
		leaf = workspace.getLeaf(false);
		await leaf.setViewState({ type: VIEW_TYPE_CHARACTER_MATRIX, active: true });
	}
	void workspace.revealLeaf(leaf);
}

export function getCharacterMatrixView(
	plugin: FirstDraftPlugin,
): CharacterMatrixView | null {
	const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_CHARACTER_MATRIX);
	const view = leaves[0]?.view;
	return view instanceof CharacterMatrixView ? view : null;
}
