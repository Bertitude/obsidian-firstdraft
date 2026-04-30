import { App, Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { GlobalConfig, ProjectMeta } from "../types";
import { resolveActiveProject } from "./resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { sanitizeFilename } from "../utils/sanitize";
import { yamlString } from "../utils/yaml";
import { activateProjectHomeView } from "../views/project-home-view";
import { ensureSeasonProject } from "./create-season";

// "Create episode" — adds a new episode to the active series project.
// Prompts for episode code (e.g. S01E01), title, and any other tokens
// referenced by the project's episodeNameTemplate (productionCode, date).
// Composes the folder name from the template, derives the season subfolder
// by parsing the season number out of the episode code, and scaffolds the
// standard episode structure underneath:
//
//   <Series>/
//     <seasonsFolder>/
//       <S0X>/
//         <Episode folder name>/
//           Index.md                            (firstdraft: block, episode kind, series: link)
//           <sequencesSubfolder>/               (top-level fountain folder)
//           <developmentFolder>/
//             Treatment.md                      (welcome intro)
//             <sequencesSubfolder>/             (per-sequence dev notes)
//             <charactersSubfolder>/
//             <locationsSubfolder>/
//             <referencesSubfolder>/
//             <notesSubfolder>/

export function runCreateEpisodeCommand(plugin: FirstDraftPlugin): void {
	const active = plugin.app.workspace.getActiveFile();
	if (!active) {
		new Notice("Open a series or season file first.");
		return;
	}
	const project = resolveActiveProject(active, plugin.scanner);

	// If we're inside a SEASON project (or one of its episodes), prefer the
	// season as context — that lets us inherit the season number and prompt
	// only for the episode number. Otherwise fall back to the series-level
	// flow which prompts for the full S<NN>E<NN> code.
	const season = findContainingSeason(plugin, active, project);
	if (season) {
		new CreateEpisodeModal(plugin, null, season).open();
		return;
	}

	if (project?.projectType === "series") {
		new CreateEpisodeModal(plugin, project, null).open();
		return;
	}

	const series = findContainingSeries(plugin, active);
	if (!series) {
		new Notice("Active file isn't inside a series or season. Run from a series index, season index, or any file inside one.");
		return;
	}
	new CreateEpisodeModal(plugin, series, null).open();
}

// Walk every series project and check if the file path is contained under
// it. Used so the command works from inside an episode (the active project
// will be the episode, but its containing series is what we want).
function findContainingSeries(
	plugin: FirstDraftPlugin,
	file: TFile,
): ProjectMeta | null {
	let best: ProjectMeta | null = null;
	for (const meta of plugin.scanner.projects.values()) {
		if (meta.projectType !== "series") continue;
		const prefix = meta.projectRootPath + "/";
		if (file.path === meta.indexFilePath || file.path.startsWith(prefix)) {
			if (
				!best ||
				meta.projectRootPath.length > best.projectRootPath.length
			) {
				best = meta;
			}
		}
	}
	return best;
}

// Walk every season project; pick the deepest one that contains the active
// file. Returns null if no season project encloses the file.
function findContainingSeason(
	plugin: FirstDraftPlugin,
	file: TFile,
	active: ProjectMeta | null,
): ProjectMeta | null {
	if (active?.projectType === "season") return active;
	let best: ProjectMeta | null = null;
	for (const meta of plugin.scanner.projects.values()) {
		if (meta.projectType !== "season") continue;
		const prefix = meta.projectRootPath + "/";
		if (file.path === meta.indexFilePath || file.path.startsWith(prefix)) {
			if (!best || meta.projectRootPath.length > best.projectRootPath.length) {
				best = meta;
			}
		}
	}
	return best;
}

class CreateEpisodeModal extends Modal {
	private episode = "";
	private episodeNumber = "";
	private title = "";
	private productionCode = "";

	constructor(
		private readonly plugin: FirstDraftPlugin,
		private readonly series: ProjectMeta | null,
		private readonly season: ProjectMeta | null,
	) {
		super(plugin.app);
	}

	private get hasSeasonContext(): boolean {
		return this.season !== null;
	}

	private get scopeProject(): ProjectMeta {
		// Use season for settings/scaffolding when available; fall back to series.
		return this.season ?? this.series!;
	}

	onOpen(): void {
		const { contentEl } = this;
		const cfg = resolveProjectSettings(this.scopeProject, this.plugin.settings);

		const scopeTitle = this.scopeProject.title ?? lastSegment(this.scopeProject.projectRootPath);
		contentEl.createEl("h2", { text: `New episode in "${scopeTitle}"` });

		if (this.hasSeasonContext) {
			// Season-aware flow: season is inherited, only ask for episode number.
			const seasonNum = this.seasonNumberFromContext();
			const nextNum = String(this.suggestNextEpisodeNumber()).padStart(2, "0");
			this.episodeNumber = nextNum;
			new Setting(contentEl)
				.setName("Episode number")
				.setDesc(`Two-digit. Episode code will be S${seasonNum}E<number>.`)
				.addText((t) => {
					t.setPlaceholder("01")
						.setValue(nextNum)
						.onChange((v) => {
							this.episodeNumber = v.trim();
						});
					setTimeout(() => {
						t.inputEl.focus();
						t.inputEl.select();
					}, 0);
				});
		} else {
			new Setting(contentEl)
				.setName("Episode code")
				.setDesc("Used to derive the season folder. Format: S<season>E<episode>, e.g. S01E01.")
				.addText((t) =>
					t.setPlaceholder("S01E01").onChange((v) => {
						this.episode = v.trim();
					}),
				);
		}

		new Setting(contentEl)
			.setName("Title")
			.setDesc("Episode title.")
			.addText((t) =>
				t.setPlaceholder("Episode title").onChange((v) => {
					this.title = v;
				}),
			);

		// Only show production-code field if the template uses it. Cuts noise
		// in the modal for users who don't care about that token.
		if (cfg.episodeNameTemplate.includes("{productionCode}")) {
			new Setting(contentEl)
				.setName("Production code")
				.setDesc("Optional. Inserted into the folder name via the {productionCode} token.")
				.addText((t) =>
					t.setPlaceholder("Production code").onChange((v) => {
						this.productionCode = v.trim();
					}),
				);
		}

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
		const cfg = resolveProjectSettings(this.scopeProject, this.plugin.settings);
		const title = this.title.trim();
		if (!title) {
			new Notice("Title is required.");
			return;
		}

		// Resolve the season number + episode code in two ways depending on
		// context. With season inherited, we built S<seasonNum>E<episodeNum>;
		// without, we parse the user-supplied code.
		let seasonNum: string;
		let ep: string;
		if (this.hasSeasonContext) {
			const seasonFromCtx = this.seasonNumberFromContext();
			if (!seasonFromCtx) {
				new Notice("Couldn't infer season number from context. Try the series-level create episode flow.");
				return;
			}
			const epNum = normalizeNumeric(this.episodeNumber);
			if (!epNum) {
				new Notice("Episode number must be numeric (e.g. 1, 01, 02).");
				return;
			}
			seasonNum = seasonFromCtx;
			ep = `S${seasonNum}E${epNum}`;
		} else {
			const userCode = this.episode.trim();
			if (!userCode) {
				new Notice("Episode code is required.");
				return;
			}
			const parsed = parseSeasonNumber(userCode);
			if (!parsed) {
				new Notice(
					"Episode code must be in S<season>E<episode> format, e.g. S01E01. Without a parseable season I can't pick a season folder.",
				);
				return;
			}
			seasonNum = parsed;
			ep = userCode;
		}

		const folderName = sanitizeFilename(
			renderTemplate(cfg.episodeNameTemplate, {
				episode: ep,
				title,
				season: seasonNum,
				productionCode: this.productionCode,
				date: todayISO(),
			}),
			cfg.filenameReplacementChar,
		);
		if (!folderName) {
			new Notice("Generated folder name has no valid filename characters.");
			return;
		}

		// Episode path differs by context:
		//   - season context: <seasonRoot>/<folderName>
		//   - series context: <seriesRoot>/<seasonsFolder>/S<NN>/<folderName>
		const episodePath = this.hasSeasonContext
			? normalizePath(`${this.season!.projectRootPath}/${folderName}`)
			: normalizePath(
					`${this.series!.projectRootPath}/${cfg.seasonsFolder}/S${seasonNum}/${folderName}`,
				);

		if (this.plugin.app.vault.getAbstractFileByPath(episodePath)) {
			new Notice(
				this.hasSeasonContext
					? `Episode S${seasonNum}E${this.episodeNumber.padStart(2, "0")} already exists. Pick a different episode number.`
					: `A folder named "${episodePath}" already exists.`,
			);
			return;
		}

		// Series-context flow: if the season folder doesn't have an Index
		// (orphan or first-time), scaffold the Season project so the new
		// episode lives inside a proper season — breadcrumbs, "Open" links,
		// and Make episodes from season outline all light up automatically.
		// No-op if the season already exists; never fires in season context
		// since the season is, by definition, already a project.
		let seasonAutoCreated = false;
		if (!this.hasSeasonContext && this.series) {
			const result = await ensureSeasonProject(
				this.plugin,
				this.series,
				seasonNum,
			);
			seasonAutoCreated = result.created;
		}

		const seriesTitle = this.inferSeriesTitle();
		try {
			const treatmentFile = await scaffoldEpisode(
				this.plugin.app,
				episodePath,
				seriesTitle,
				ep,
				seasonNum,
				title,
				cfg,
			);
			this.close();
			await this.plugin.app.workspace.getLeaf(false).openFile(treatmentFile);
			void activateProjectHomeView(this.plugin);
			new Notice(
				seasonAutoCreated
					? `Created episode "${ep} — ${title}". Also scaffolded S${seasonNum} as a season project.`
					: `Created episode "${ep} — ${title}".`,
			);
		} catch (e) {
			new Notice(`Create failed: ${(e as Error).message}`);
		}
	}

	// ── season-context helpers ──────────────────────────────────────────

	private seasonNumberFromContext(): string | null {
		if (!this.season) return null;
		if (this.season.season && this.season.season.trim() !== "") {
			const n = parseInt(this.season.season, 10);
			if (!Number.isNaN(n)) return String(n).padStart(2, "0");
		}
		// Fall back to parsing from the season folder name.
		const seg = this.season.projectRootPath.split("/").pop() ?? "";
		const m = /^S(\d+)$/i.exec(seg);
		if (m) {
			const n = parseInt(m[1] ?? "", 10);
			if (!Number.isNaN(n)) return String(n).padStart(2, "0");
		}
		return null;
	}

	private suggestNextEpisodeNumber(): number {
		if (!this.season) return 1;
		const seasonNum = this.seasonNumberFromContext();
		if (!seasonNum) return 1;
		let max = 0;
		for (const meta of this.plugin.scanner.projects.values()) {
			if (meta.projectType !== "tv-episode") continue;
			const prefix = this.season.projectRootPath + "/";
			if (!meta.indexFilePath.startsWith(prefix)) continue;
			if (!meta.episode) continue;
			const m = /^s(\d+)e(\d+)/i.exec(meta.episode.trim());
			if (!m) continue;
			const eNum = parseInt(m[2] ?? "", 10);
			if (!Number.isNaN(eNum) && eNum > max) max = eNum;
		}
		return max + 1;
	}

	private inferSeriesTitle(): string {
		// Walk up to find the parent series, regardless of whether we're
		// invoked from season or series context.
		const root = this.scopeProject.projectRootPath;
		for (const meta of this.plugin.scanner.projects.values()) {
			if (meta.projectType !== "series") continue;
			const prefix = meta.projectRootPath + "/";
			if (root === meta.projectRootPath || root.startsWith(prefix)) {
				return meta.title ?? lastSegment(meta.projectRootPath);
			}
		}
		// Series project itself
		if (this.scopeProject.projectType === "series") {
			return this.scopeProject.title ?? lastSegment(this.scopeProject.projectRootPath);
		}
		return this.scopeProject.series ?? "";
	}
}

function normalizeNumeric(input: string): string | null {
	const trimmed = input.trim();
	if (trimmed === "") return null;
	const n = parseInt(trimmed, 10);
	if (Number.isNaN(n) || n < 0) return null;
	return String(n).padStart(2, "0");
}

// ── helpers ──────────────────────────────────────────────────────────────

// Parse "S01E01" → "01". Tolerates lowercase, missing leading zeros, and
// extra suffix characters. Returns the season string padded to 2 digits,
// or null if the pattern doesn't match.
export function parseSeasonNumber(episodeCode: string): string | null {
	const m = /^s(\d+)e/i.exec(episodeCode.trim());
	if (!m) return null;
	const n = parseInt(m[1] ?? "", 10);
	if (Number.isNaN(n)) return null;
	return String(n).padStart(2, "0");
}

// Render the episodeNameTemplate by substituting tokens. Unknown tokens are
// stripped (left as empty) rather than left in the literal output.
export function renderTemplate(
	template: string,
	tokens: {
		episode: string;
		title: string;
		season: string;
		productionCode: string;
		date: string;
	},
): string {
	return template
		.replace(/\{episode\}/g, tokens.episode)
		.replace(/\{title\}/g, tokens.title)
		.replace(/\{season\}/g, tokens.season)
		.replace(/\{productionCode\}/g, tokens.productionCode)
		.replace(/\{date\}/g, tokens.date)
		// Strip unknown tokens to avoid leaking literal "{xyz}" into folder
		// names. Strict whitelist above keeps things predictable.
		.replace(/\{[a-zA-Z]+\}/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function todayISO(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

async function scaffoldEpisode(
	app: App,
	episodePath: string,
	seriesTitle: string,
	episodeCode: string,
	seasonNum: string,
	title: string,
	cfg: GlobalConfig,
): Promise<TFile> {
	await ensureFolder(app, episodePath);
	await ensureFolder(app, `${episodePath}/${cfg.sequencesSubfolder}`);
	await ensureFolder(app, `${episodePath}/${cfg.developmentFolder}`);
	await ensureFolder(
		app,
		`${episodePath}/${cfg.developmentFolder}/${cfg.sequencesSubfolder}`,
	);
	await ensureFolder(
		app,
		`${episodePath}/${cfg.developmentFolder}/${cfg.charactersSubfolder}`,
	);
	await ensureFolder(
		app,
		`${episodePath}/${cfg.developmentFolder}/${cfg.locationsSubfolder}`,
	);
	await ensureFolder(
		app,
		`${episodePath}/${cfg.developmentFolder}/${cfg.referencesSubfolder}`,
	);
	await ensureFolder(
		app,
		`${episodePath}/${cfg.developmentFolder}/${cfg.notesSubfolder}`,
	);

	const indexPath = normalizePath(`${episodePath}/Index.md`);
	await app.vault.create(
		indexPath,
		episodeIndexBody(title, episodeCode, seasonNum, seriesTitle, cfg),
	);

	const treatmentPath = normalizePath(
		`${episodePath}/${cfg.developmentFolder}/Treatment.md`,
	);
	const treatment = await app.vault.create(
		treatmentPath,
		episodeTreatmentBody(title, episodeCode),
	);
	return treatment;
}

function episodeIndexBody(
	title: string,
	episodeCode: string,
	seasonNum: string,
	seriesTitle: string,
	cfg: GlobalConfig,
): string {
	return `---
title: ${yamlString(title)}
series: ${yamlString(seriesTitle)}
season: ${yamlString(seasonNum)}
episode: ${yamlString(episodeCode)}
firstdraft:
  kind: episode
  sequenceFolder: ${yamlString(cfg.sequencesSubfolder)}
  sequences: []
---

# ${episodeCode} — ${title}

`;
}

function episodeTreatmentBody(title: string, episodeCode: string): string {
	return `---
type: treatment
status: draft
promoted_at:
---

# ${episodeCode} — ${title} — Treatment

> **Welcome to your episode treatment.** Capture this episode's beats here. Each H2 below becomes a sequence when you run "Make sequences from treatment".
>
> Delete this welcome when you're ready.

## First beat
What happens here.

## Second beat
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
