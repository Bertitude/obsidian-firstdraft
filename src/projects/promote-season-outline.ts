import { Notice, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "./resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { snapshotFile, todayLabel } from "../versioning/snapshot";
import { sanitizeFilename } from "../utils/sanitize";
import { renderTemplate, parseSeasonNumber } from "./create-episode";
import { yamlString } from "../utils/yaml";

// "Make episodes from season outline" — the season-level analogue of
// "Make sequences from treatment". Reads the active season's Season Outline
// (Development/Season Outline.md), parses the H2 beats, and creates an
// episode sub-project for each beat: Index.md + standard episode tree
// (Sequences/, Development/, Treatment.md).
//
// The H2 title becomes the episode title. Episode numbers are auto-assigned
// based on existing episodes in the season — first H2 maps to the next
// available episode slot, then incrementing. Skips H2s whose generated
// folder name would collide with an existing episode (idempotent — re-run
// after editing the outline only adds new entries).
//
// Snapshot the outline before promoting so the status update + any future
// changes are recoverable.

interface OutlineBeat {
	title: string;
	body: string;
}

export async function runMakeEpisodesFromSeasonOutlineCommand(
	plugin: FirstDraftPlugin,
): Promise<void> {
	const active = plugin.app.workspace.getActiveFile();
	if (!active) {
		new Notice("Open a season's Season Outline (or Index) first.");
		return;
	}
	const project = resolveActiveProject(active, plugin.scanner);
	if (!project || project.projectType !== "season") {
		new Notice("Active file isn't inside a season project. Run from a season Index or its Season Outline.");
		return;
	}
	const cfg = resolveProjectSettings(project, plugin.settings);

	const outlinePath = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/Season Outline.md`,
	);
	const outlineFile = plugin.app.vault.getAbstractFileByPath(outlinePath);
	if (!(outlineFile instanceof TFile)) {
		new Notice(`No Season Outline found at ${outlinePath}.`);
		return;
	}

	const seasonNum = parseSeasonNum(project);
	if (!seasonNum) {
		new Notice("Season project is missing a season number in frontmatter.");
		return;
	}

	const markdown = await plugin.app.vault.read(outlineFile);
	const beats = parseBeats(markdown);
	if (beats.length === 0) {
		new Notice("No H2 beats found in the Season Outline.");
		return;
	}

	await snapshotFile(plugin.app, outlineFile, `pre-promote ${todayLabel()}`);

	let created = 0;
	let skipped = 0;
	const seriesTitle = inferSeriesTitle(plugin, project);
	let nextEpisodeNum = highestExistingEpisodeNumber(plugin, project, seasonNum) + 1;

	for (const beat of beats) {
		const episodeCode = `S${seasonNum}E${String(nextEpisodeNum).padStart(2, "0")}`;
		const folderName = sanitizeFilename(
			renderTemplate(cfg.episodeNameTemplate, {
				episode: episodeCode,
				title: beat.title,
				season: seasonNum,
				productionCode: "",
				date: todayISO(),
			}),
			cfg.filenameReplacementChar,
		);
		if (!folderName) {
			skipped += 1;
			continue;
		}
		const episodePath = normalizePath(`${project.projectRootPath}/${folderName}`);
		if (plugin.app.vault.getAbstractFileByPath(episodePath)) {
			// Already exists — skip and move on. Don't bump the episode
			// number; we'll try the same number again on the NEXT beat in
			// case it's just this folder name that's taken.
			skipped += 1;
			continue;
		}

		try {
			await scaffoldEpisodeFromOutline(
				plugin,
				episodePath,
				project,
				seriesTitle,
				episodeCode,
				seasonNum,
				beat.title,
				beat.body,
				cfg,
			);
			created += 1;
			nextEpisodeNum += 1;
		} catch (e) {
			void e;
			skipped += 1;
		}
	}

	// Mark outline as promoted (similar to Treatment status flow).
	await plugin.app.fileManager.processFrontMatter(
		outlineFile,
		(fm: Record<string, unknown>) => {
			fm.status = "promoted";
			fm.promoted_at = todayLabel();
		},
	);

	new Notice(
		created > 0
			? `Made ${created} episode${created === 1 ? "" : "s"} from outline${skipped > 0 ? ` (${skipped} skipped)` : ""}.`
			: skipped > 0
				? `Nothing new — ${skipped} beat${skipped === 1 ? "" : "s"} already had episodes.`
				: "Nothing to promote.",
		6000,
	);
}

// ── helpers ─────────────────────────────────────────────────────────────

function parseSeasonNum(project: ProjectMeta): string | null {
	if (project.season && project.season.trim() !== "") {
		const n = parseInt(project.season, 10);
		if (!Number.isNaN(n)) return String(n).padStart(2, "0");
	}
	// Fall back to parsing from the season folder name (e.g. "S01")
	const seg = project.projectRootPath.split("/").pop() ?? "";
	const m = /^S(\d+)$/i.exec(seg);
	if (m) {
		const n = parseInt(m[1] ?? "", 10);
		if (!Number.isNaN(n)) return String(n).padStart(2, "0");
	}
	return null;
}

function inferSeriesTitle(plugin: FirstDraftPlugin, season: ProjectMeta): string {
	for (const meta of plugin.scanner.projects.values()) {
		if (meta.projectType !== "series") continue;
		const prefix = meta.projectRootPath + "/";
		if (season.projectRootPath.startsWith(prefix)) {
			return meta.title ?? lastSegment(meta.projectRootPath);
		}
	}
	return season.series ?? "";
}

function highestExistingEpisodeNumber(
	plugin: FirstDraftPlugin,
	season: ProjectMeta,
	seasonNum: string,
): number {
	let max = 0;
	for (const meta of plugin.scanner.projects.values()) {
		if (meta.projectType !== "tv-episode") continue;
		const prefix = season.projectRootPath + "/";
		if (!meta.indexFilePath.startsWith(prefix)) continue;
		if (!meta.episode) continue;
		const m = /^s(\d+)e(\d+)/i.exec(meta.episode.trim());
		if (!m) continue;
		const sNum = String(parseInt(m[1] ?? "", 10)).padStart(2, "0");
		if (sNum !== seasonNum) continue;
		const eNum = parseInt(m[2] ?? "", 10);
		if (!Number.isNaN(eNum) && eNum > max) max = eNum;
	}
	return max;
}

function parseBeats(markdown: string): OutlineBeat[] {
	const lines = markdown.split(/\r?\n/);
	const out: OutlineBeat[] = [];
	let activeTitle: string | null = null;
	let buffer: string[] = [];
	const flush = () => {
		if (activeTitle === null) return;
		out.push({ title: activeTitle, body: buffer.join("\n").trim() });
	};
	for (const line of lines) {
		const m = /^##\s+(.+?)\s*$/.exec(line);
		if (m) {
			flush();
			activeTitle = m[1]!.trim();
			buffer = [];
			continue;
		}
		if (activeTitle !== null) buffer.push(line);
	}
	flush();
	return out;
}

async function scaffoldEpisodeFromOutline(
	plugin: FirstDraftPlugin,
	episodePath: string,
	season: ProjectMeta,
	seriesTitle: string,
	episodeCode: string,
	seasonNum: string,
	title: string,
	beatBody: string,
	cfg: ReturnType<typeof resolveProjectSettings>,
): Promise<void> {
	await ensureFolder(plugin.app, episodePath);
	await ensureFolder(plugin.app, `${episodePath}/${cfg.sequencesSubfolder}`);
	await ensureFolder(plugin.app, `${episodePath}/${cfg.developmentFolder}`);
	await ensureFolder(
		plugin.app,
		`${episodePath}/${cfg.developmentFolder}/${cfg.sequencesSubfolder}`,
	);
	await ensureFolder(
		plugin.app,
		`${episodePath}/${cfg.developmentFolder}/${cfg.charactersSubfolder}`,
	);
	await ensureFolder(
		plugin.app,
		`${episodePath}/${cfg.developmentFolder}/${cfg.locationsSubfolder}`,
	);
	await ensureFolder(
		plugin.app,
		`${episodePath}/${cfg.developmentFolder}/${cfg.referencesSubfolder}`,
	);
	await ensureFolder(
		plugin.app,
		`${episodePath}/${cfg.developmentFolder}/${cfg.notesSubfolder}`,
	);
	void season;

	const indexPath = normalizePath(`${episodePath}/Index.md`);
	await plugin.app.vault.create(
		indexPath,
		episodeIndexBody(title, episodeCode, seasonNum, seriesTitle, cfg),
	);

	const treatmentPath = normalizePath(
		`${episodePath}/${cfg.developmentFolder}/Treatment.md`,
	);
	await plugin.app.vault.create(
		treatmentPath,
		episodeTreatmentBody(title, episodeCode, beatBody),
	);
}

function episodeIndexBody(
	title: string,
	episodeCode: string,
	seasonNum: string,
	seriesTitle: string,
	cfg: ReturnType<typeof resolveProjectSettings>,
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

function episodeTreatmentBody(
	title: string,
	episodeCode: string,
	carriedBody: string,
): string {
	const intent = carriedBody.trim() === "" ? "" : `\n${carriedBody.trim()}\n`;
	return `---
type: treatment
status: draft
promoted_at:
---

# ${episodeCode} — ${title} — Treatment
${intent}
> Capture this episode's beats below. Each H2 becomes a sequence when you run **Make sequences from treatment**.

## First beat
What happens here.

## Second beat
What happens next.
`;
}

function todayISO(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

async function ensureFolder(app: import("obsidian").App, path: string): Promise<void> {
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

void parseSeasonNumber; // re-exported for parity with create-episode helpers
