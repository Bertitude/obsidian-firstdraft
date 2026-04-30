import { App, Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { GlobalConfig, ProjectMeta } from "../types";
import { resolveActiveProject } from "./resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { activateProjectHomeView } from "../views/project-home-view";
import { yamlString } from "../utils/yaml";

// "Create Season" — adds a new season under the active series project.
// Prompts for season number (auto-suggests next available) and an optional
// title. Scaffolds the standard season folder layout:
//
//   <Series>/<seasonsFolder>/S0X/
//     Index.md                          (firstdraft: kind: season + season: "0X")
//     Development/
//       Season Outline.md               (the "season treatment" — H2 per episode)
//       Characters/                     (season-arc characters)
//       Locations/
//       References/
//       Notes/
//
// After creation, opens the Season Outline so the user lands in something
// inviting, and activates Project Home (which renders the new season's
// dashboard).

export function runCreateSeasonCommand(plugin: FirstDraftPlugin): void {
	const active = plugin.app.workspace.getActiveFile();
	if (!active) {
		new Notice("Open a series file first (the series index, or any file inside the series).");
		return;
	}
	const project = resolveActiveProject(active, plugin.scanner);
	const series = resolveSeriesFromContext(plugin, project);
	if (!series) {
		new Notice("Active file isn't inside a series project. Run from a series index or any file inside it.");
		return;
	}
	new CreateSeasonModal(plugin, series).open();
}

// Walk projects to find the containing series. Active project might be the
// series itself, a season under it, or an episode under a season.
function resolveSeriesFromContext(
	plugin: FirstDraftPlugin,
	active: ProjectMeta | null,
): ProjectMeta | null {
	if (active?.projectType === "series") return active;
	const file = plugin.app.workspace.getActiveFile();
	if (!file) return null;
	let best: ProjectMeta | null = null;
	for (const meta of plugin.scanner.projects.values()) {
		if (meta.projectType !== "series") continue;
		const prefix = meta.projectRootPath + "/";
		if (file.path === meta.indexFilePath || file.path.startsWith(prefix)) {
			if (!best || meta.projectRootPath.length > best.projectRootPath.length) {
				best = meta;
			}
		}
	}
	return best;
}

class CreateSeasonModal extends Modal {
	private seasonNumber = "";
	private title = "";

	constructor(
		private readonly plugin: FirstDraftPlugin,
		private readonly series: ProjectMeta,
	) {
		super(plugin.app);
		this.seasonNumber = guessNextSeason(plugin, series);
	}

	onOpen(): void {
		const { contentEl } = this;
		const seriesTitle =
			this.series.title ?? lastSegment(this.series.projectRootPath);
		contentEl.createEl("h2", { text: `New season in "${seriesTitle}"` });

		new Setting(contentEl)
			.setName("Season number")
			.setDesc("Two-digit format (e.g. 01, 02, 03). Folder will be named S<number>.")
			.addText((t) => {
				t.setPlaceholder("01")
					.setValue(this.seasonNumber)
					.onChange((v) => {
						this.seasonNumber = v.trim();
					});
				setTimeout(() => {
					t.inputEl.focus();
					t.inputEl.select();
				}, 0);
			});

		new Setting(contentEl)
			.setName("Title")
			.setDesc("Optional — useful for franchise seasons (e.g. `book ii`). Defaults to `season N`.")
			.addText((t) =>
				t.setPlaceholder("(optional)").onChange((v) => {
					this.title = v;
				}),
			);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Create")
					.setCta()
					.onClick(() => {
						void this.create();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async create(): Promise<void> {
		const cfg = resolveProjectSettings(this.series, this.plugin.settings);
		const num = normalizeSeasonNumber(this.seasonNumber);
		if (!num) {
			new Notice("Season number must be numeric (e.g. 1, 01, 02).");
			return;
		}
		const folderName = `S${num}`;
		const seasonPath = normalizePath(
			`${this.series.projectRootPath}/${cfg.seasonsFolder}/${folderName}`,
		);

		if (this.plugin.app.vault.getAbstractFileByPath(seasonPath)) {
			new Notice(`A folder for ${folderName} already exists at ${seasonPath}.`);
			return;
		}

		const title = this.title.trim() === "" ? `Season ${parseInt(num, 10)}` : this.title.trim();

		try {
			const outlineFile = await scaffoldSeason(
				this.plugin.app,
				seasonPath,
				num,
				title,
				this.series,
				cfg,
			);
			this.close();
			await this.plugin.app.workspace.getLeaf(false).openFile(outlineFile);
			void activateProjectHomeView(this.plugin);
			new Notice(`Created ${folderName} — ${title}.`);
		} catch (e) {
			new Notice(`Create failed: ${(e as Error).message}`);
		}
	}
}

// Scan the series for existing season folders and suggest the next number
// in sequence. Falls back to "01" if no seasons exist yet.
function guessNextSeason(plugin: FirstDraftPlugin, series: ProjectMeta): string {
	const cfg = resolveProjectSettings(series, plugin.settings);
	const seasonsPath = normalizePath(`${series.projectRootPath}/${cfg.seasonsFolder}`);
	const folder = plugin.app.vault.getAbstractFileByPath(seasonsPath);
	if (!(folder instanceof TFolder)) return "01";
	let max = 0;
	for (const child of folder.children) {
		if (!(child instanceof TFolder)) continue;
		const m = /^S(\d+)$/i.exec(child.name);
		if (!m) continue;
		const n = parseInt(m[1] ?? "", 10);
		if (!Number.isNaN(n) && n > max) max = n;
	}
	return String(max + 1).padStart(2, "0");
}

function normalizeSeasonNumber(input: string): string | null {
	const trimmed = input.trim();
	if (trimmed === "") return null;
	const n = parseInt(trimmed, 10);
	if (Number.isNaN(n) || n < 0) return null;
	return String(n).padStart(2, "0");
}

// Idempotent helper: scaffold a Season project under the series for the
// given season number if one doesn't already exist. Used by Create season
// (interactive), Create episode (auto-fill on first episode in a new
// season folder), and the Series Home inline "Create" affordance.
//
// Returns the existing OR newly-created Season Outline TFile so callers
// can decide whether to open it. Title defaults to "Season N" when not
// supplied. Safe to call when the season folder already has an Index.md
// — it'll detect that and short-circuit.
export async function ensureSeasonProject(
	plugin: FirstDraftPlugin,
	series: ProjectMeta,
	seasonNum: string,
	title?: string,
): Promise<{ created: boolean; outlineFile: TFile | null; indexPath: string }> {
	const cfg = resolveProjectSettings(series, plugin.settings);
	const folderName = `S${seasonNum}`;
	const seasonPath = normalizePath(
		`${series.projectRootPath}/${cfg.seasonsFolder}/${folderName}`,
	);
	const indexPath = normalizePath(`${seasonPath}/Index.md`);
	const existingIndex = plugin.app.vault.getAbstractFileByPath(indexPath);
	if (existingIndex instanceof TFile) {
		const outlinePath = normalizePath(
			`${seasonPath}/${cfg.developmentFolder}/Season Outline.md`,
		);
		const outline = plugin.app.vault.getAbstractFileByPath(outlinePath);
		return {
			created: false,
			outlineFile: outline instanceof TFile ? outline : null,
			indexPath,
		};
	}
	const finalTitle = title?.trim() || `Season ${parseInt(seasonNum, 10)}`;
	const outlineFile = await scaffoldSeason(
		plugin.app,
		seasonPath,
		seasonNum,
		finalTitle,
		series,
		cfg,
	);
	// Nudge the scanner so the new project appears in scanner.projects right
	// away — the metadata-cache event would catch it eventually, but callers
	// often want to operate on the season meta in the same tick.
	const indexFile = plugin.app.vault.getAbstractFileByPath(indexPath);
	if (indexFile instanceof TFile) plugin.scanner.updateFile(indexFile);
	return { created: true, outlineFile, indexPath };
}

export async function scaffoldSeason(
	app: App,
	seasonPath: string,
	seasonNum: string,
	title: string,
	series: ProjectMeta,
	cfg: GlobalConfig,
): Promise<TFile> {
	await ensureFolder(app, seasonPath);
	await ensureFolder(app, `${seasonPath}/${cfg.developmentFolder}`);
	await ensureFolder(
		app,
		`${seasonPath}/${cfg.developmentFolder}/${cfg.charactersSubfolder}`,
	);
	await ensureFolder(
		app,
		`${seasonPath}/${cfg.developmentFolder}/${cfg.locationsSubfolder}`,
	);
	await ensureFolder(
		app,
		`${seasonPath}/${cfg.developmentFolder}/${cfg.referencesSubfolder}`,
	);
	await ensureFolder(
		app,
		`${seasonPath}/${cfg.developmentFolder}/${cfg.notesSubfolder}`,
	);

	// Index.md (the season project file)
	const seriesTitle = series.title ?? lastSegment(series.projectRootPath);
	const indexPath = normalizePath(`${seasonPath}/Index.md`);
	await app.vault.create(indexPath, seasonIndexBody(title, seriesTitle, seasonNum));

	// Season Outline (the "season treatment" — H2 per episode)
	const outlinePath = normalizePath(
		`${seasonPath}/${cfg.developmentFolder}/Season Outline.md`,
	);
	const outline = await app.vault.create(outlinePath, seasonOutlineBody(title));
	return outline;
}

function seasonIndexBody(title: string, seriesTitle: string, seasonNum: string): string {
	return `---
title: ${yamlString(title)}
series: ${yamlString(seriesTitle)}
season: ${yamlString(seasonNum)}
firstdraft:
  kind: season
---

# ${title}

> **Welcome to your season root.** This is the season-level dashboard for "${title}". Use the **Season Outline** in this season's Development tree to plan episodes (one H2 per episode). When ready, run **Make episodes from season outline** to scaffold each episode as its own sub-project.
>
> Use the season-level Development/ tree for season-arc material — recurring characters specific to this season, season-only locations, world-building notes, and references.
>
> Delete this welcome when you're ready.
`;
}

function seasonOutlineBody(title: string): string {
	return `---
type: season-outline
status: draft
promoted_at:
---

# ${title} — Season Outline

> **Welcome to your season outline.** This is your season's planning document — the equivalent of a treatment, but at the season scope. Each H2 below becomes an episode when you run **Make episodes from season outline**.
>
> Capture each episode's premise here. The H2 title becomes the episode title; the prose under each H2 becomes the episode's overview. You can add as many H2s as you have episodes; the command creates them in order.
>
> Delete this welcome when you're ready.

## Episode 1
What this episode covers. Major beats. Character arcs.

## Episode 2
What happens next.
`;
}

async function ensureFolder(app: App, path: string): Promise<void> {
	const at = app.vault.getAbstractFileByPath(path);
	if (at instanceof TFolder) return;
	if (at instanceof TFile) {
		throw new Error(`Path is a file, not a folder: ${path}`);
	}
	const segments = path.split("/");
	let cumulative = "";
	for (const seg of segments) {
		cumulative = cumulative ? `${cumulative}/${seg}` : seg;
		const existing = app.vault.getAbstractFileByPath(cumulative);
		if (existing) continue;
		await app.vault.createFolder(cumulative);
	}
}

function lastSegment(path: string): string {
	return path.split("/").pop() ?? path;
}
