import { App, Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { GlobalConfig, ProjectMeta } from "../types";
import { resolveActiveProject } from "./resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { sanitizeFilename } from "../utils/sanitize";
import { activateProjectHomeView } from "../views/project-home-view";

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
		new Notice("Open a series file first (the series Index, or any file inside the series).");
		return;
	}
	const project = resolveActiveProject(active, plugin.scanner);
	if (!project || project.projectType !== "series") {
		// If the user is inside an episode, walk up to its series. Otherwise bail.
		const series = findContainingSeries(plugin, active);
		if (!series) {
			new Notice("Active file isn't inside a series project. Run from a series Index or one of its episodes.");
			return;
		}
		new CreateEpisodeModal(plugin, series).open();
		return;
	}
	new CreateEpisodeModal(plugin, project).open();
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

class CreateEpisodeModal extends Modal {
	private episode = "";
	private title = "";
	private productionCode = "";

	constructor(
		private readonly plugin: FirstDraftPlugin,
		private readonly series: ProjectMeta,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		const cfg = resolveProjectSettings(this.series, this.plugin.settings);

		contentEl.createEl("h2", { text: `New episode in "${this.series.title ?? lastSegment(this.series.projectRootPath)}"` });

		new Setting(contentEl)
			.setName("Episode code")
			.setDesc("Used to derive the season folder. Format: S<season>E<episode>, e.g. S01E01.")
			.addText((t) =>
				t.setPlaceholder("S01E01").onChange((v) => {
					this.episode = v.trim();
				}),
			);

		new Setting(contentEl)
			.setName("Title")
			.setDesc("Episode title.")
			.addText((t) =>
				t.setPlaceholder("e.g. Pilot").onChange((v) => {
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
					t.setPlaceholder("e.g. 101").onChange((v) => {
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
		const cfg = resolveProjectSettings(this.series, this.plugin.settings);
		const ep = this.episode.trim();
		const title = this.title.trim();
		if (!ep) {
			new Notice("Episode code is required.");
			return;
		}
		if (!title) {
			new Notice("Title is required.");
			return;
		}

		const seasonNum = parseSeasonNumber(ep);
		if (!seasonNum) {
			new Notice(
				"Episode code must be in S<season>E<episode> format, e.g. S01E01. Without a parseable season I can't pick a season folder.",
			);
			return;
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

		const seasonFolderName = `S${seasonNum}`;
		const episodePath = normalizePath(
			`${this.series.projectRootPath}/${cfg.seasonsFolder}/${seasonFolderName}/${folderName}`,
		);

		if (this.plugin.app.vault.getAbstractFileByPath(episodePath)) {
			new Notice(`A folder named "${episodePath}" already exists.`);
			return;
		}

		try {
			const treatmentFile = await scaffoldEpisode(
				this.plugin.app,
				episodePath,
				this.series,
				ep,
				seasonNum,
				title,
				cfg,
			);
			this.close();
			await this.plugin.app.workspace.getLeaf(false).openFile(treatmentFile);
			void activateProjectHomeView(this.plugin);
			new Notice(`Created episode "${ep} — ${title}".`);
		} catch (e) {
			new Notice(`Create failed: ${(e as Error).message}`);
		}
	}
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
	series: ProjectMeta,
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

	const seriesTitle = series.title ?? lastSegment(series.projectRootPath);
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
title: ${title}
series: ${seriesTitle}
season: "${seasonNum}"
episode: ${episodeCode}
firstdraft:
  kind: episode
  sequenceFolder: ${cfg.sequencesSubfolder}
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

> **Welcome to your episode treatment.** Capture this episode's beats here. Each H2 below becomes a sequence when you run "Promote treatment to sequences".
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
