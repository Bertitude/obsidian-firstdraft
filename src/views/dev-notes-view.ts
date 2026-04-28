import { ItemView, TFile, WorkspaceLeaf } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { openProjectSettingsModal } from "../settings/project-settings-modal";
import { characterRoster, scenePairFromActive } from "./lookups";
import {
	renderHeader,
	renderEmptyState,
	renderSceneSection,
	renderFountainSection,
	renderCharactersSection,
	renderLocationSection,
} from "./render";
import { VIEW_TYPE_DEV_NOTES } from "./view-types";

// Right-sidebar panel that mirrors the active .fountain file with its scene dev note,
// character cards, and (optional) location card. Re-renders on active-leaf-change and
// metadata changes for the displayed dev note. All DOM is owned by `this.contentEl`
// so View's lifecycle handles teardown.

export class DevNotesView extends ItemView {
	private currentDevNotePath: string | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: FirstDraftPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_DEV_NOTES;
	}

	getDisplayText(): string {
		return "Dev notes";
	}

	getIcon(): string {
		return "notebook-pen";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("firstdraft-panel");
		await this.refresh();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	// Returns the dev-note path currently being displayed (used by event wiring to
	// decide whether a metadataCache 'changed' event should trigger a re-render).
	getCurrentDevNotePath(): string | null {
		return this.currentDevNotePath;
	}

	async refresh(): Promise<void> {
		this.contentEl.empty();
		this.currentDevNotePath = null;

		const file = this.app.workspace.getActiveFile();
		if (!file) {
			renderEmptyState(this.contentEl, file);
			return;
		}

		const project = resolveActiveProject(file, this.plugin.scanner);
		if (!project) {
			renderEmptyState(this.contentEl, file);
			return;
		}

		const cfg = resolveProjectSettings(project, this.plugin.settings);
		const pair = scenePairFromActive(this.app, file, project, cfg);
		if (!pair) {
			renderEmptyState(
				this.contentEl,
				file,
				"This file isn't a scene fountain or a scene dev note. Open one to see its development context.",
			);
			return;
		}

		renderHeader(this.contentEl, project, () => this.openSettings(project));
		this.currentDevNotePath = pair.devNotePath;

		// Middle section depends on which side is active. Either way, characters and
		// locations are sourced from the dev note's frontmatter (the single source of
		// truth for scene metadata) — independent of which file the user is editing.
		if (pair.activeMode === "fountain") {
			await renderSceneSection({
				container: this.contentEl,
				view: this,
				scene: file,
				noteRef: { path: pair.devNotePath, file: pair.devNoteFile },
				getTemplate: () =>
					resolveProjectSettings(project, this.plugin.settings).sceneNoteTemplate,
				plugin: this.plugin,
			});
		} else {
			renderFountainSection({
				container: this.contentEl,
				view: this,
				plugin: this.plugin,
				devNote: file,
				fountainPath: pair.fountainPath,
				fountainFile: pair.fountainFile,
				project,
			});
		}

		const fm = pair.devNoteFile
			? this.app.metadataCache.getFileCache(pair.devNoteFile)?.frontmatter
			: undefined;
		const characterNames = collectStringArray(fm?.characters);
		const locationNames = collectLocations(fm);

		const roster = characterRoster(this.app, project, cfg);
		renderCharactersSection({
			container: this.contentEl,
			view: this,
			plugin: this.plugin,
			characterNames,
			roster,
			cfg,
		});

		if (locationNames.length > 0) {
			renderLocationSection({
				container: this.contentEl,
				view: this,
				plugin: this.plugin,
				project,
				cfg,
				locationNames,
			});
		}
	}

	private openSettings(project: ProjectMeta): void {
		openProjectSettingsModal(this.plugin, project);
	}
}

function collectStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	for (const item of v) {
		if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
	}
	return out;
}

// Accept the new `locations: []` array shape and the legacy `location: "X"` string
// shape so dev notes created before this change still render.
function collectLocations(fm: Record<string, unknown> | undefined): string[] {
	if (!fm) return [];
	const fromArray = collectStringArray(fm.locations);
	const legacy = typeof fm.location === "string" && fm.location.trim() !== "" ? fm.location.trim() : null;
	const out = [...fromArray];
	if (legacy && !out.some((n) => n.toUpperCase() === legacy.toUpperCase())) out.push(legacy);
	return out;
}

// Helper used by the toggle command in main.ts.
export async function activateDevNotesView(plugin: FirstDraftPlugin): Promise<void> {
	const { workspace } = plugin.app;
	let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_DEV_NOTES)[0] ?? null;
	if (!leaf) {
		leaf = workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_DEV_NOTES, active: true });
	}
	void workspace.revealLeaf(leaf);
}

// Convenience: get the active DevNotesView instance, if mounted.
export function getDevNotesView(plugin: FirstDraftPlugin): DevNotesView | null {
	const leaves = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_DEV_NOTES);
	const view = leaves[0]?.view;
	return view instanceof DevNotesView ? view : null;
}

export { TFile };
