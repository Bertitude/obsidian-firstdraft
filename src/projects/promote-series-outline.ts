import { Notice, TFile, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "./resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { snapshotFile, todayLabel } from "../versioning/snapshot";
import { ensureSeasonProject } from "./create-season";

// "Make seasons from series outline" — the series-level analogue of
// "Make episodes from season outline". Reads the active series's Series
// Outline (Development/Series Outline.md), parses the H2 beats, and
// scaffolds a Season project for each beat.
//
// Season numbers are auto-assigned starting from the highest existing
// season number + 1 — keeps things sequential when re-running after a
// new H2 is added. The H2 title becomes the season's display title; the
// folder is always S<NN>. Re-runs without status reset will keep adding
// (matches the season → episodes flow); the outline gets `status:
// promoted` after a successful run as a soft signal.
//
// Snapshot before promoting so any future edits are recoverable.

interface OutlineBeat {
	title: string;
	body: string;
}

export async function runMakeSeasonsFromSeriesOutlineCommand(
	plugin: FirstDraftPlugin,
): Promise<void> {
	const active = plugin.app.workspace.getActiveFile();
	if (!active) {
		new Notice("Open a series Index or Series Outline first.");
		return;
	}
	const activeProject = resolveActiveProject(active, plugin.scanner);
	const series = resolveSeriesFromContext(plugin, active, activeProject);
	if (!series) {
		new Notice("Active file isn't inside a series project.");
		return;
	}
	const cfg = resolveProjectSettings(series, plugin.settings);

	const outlinePath = normalizePath(
		`${series.projectRootPath}/${cfg.developmentFolder}/Series Outline.md`,
	);
	const outlineFile = plugin.app.vault.getAbstractFileByPath(outlinePath);
	if (!(outlineFile instanceof TFile)) {
		new Notice(`No Series Outline found at ${outlinePath}.`);
		return;
	}

	const markdown = await plugin.app.vault.read(outlineFile);
	const beats = parseBeats(markdown);
	if (beats.length === 0) {
		new Notice("No H2 beats found in the Series Outline.");
		return;
	}

	await snapshotFile(plugin.app, outlineFile, `pre-promote ${todayLabel()}`);

	let nextSeasonNum = highestExistingSeasonNumber(plugin, series) + 1;
	let created = 0;
	let skipped = 0;
	for (const beat of beats) {
		const padded = String(nextSeasonNum).padStart(2, "0");
		try {
			const result = await ensureSeasonProject(
				plugin,
				series,
				padded,
				beat.title,
			);
			if (result.created) {
				created += 1;
			} else {
				skipped += 1;
			}
			nextSeasonNum += 1;
		} catch (e) {
			void e;
			skipped += 1;
		}
	}

	await plugin.app.fileManager.processFrontMatter(
		outlineFile,
		(fm: Record<string, unknown>) => {
			fm.status = "promoted";
			fm.promoted_at = todayLabel();
		},
	);

	new Notice(
		created > 0
			? `Made ${created} season${created === 1 ? "" : "s"} from outline${skipped > 0 ? ` (${skipped} skipped)` : ""}.`
			: skipped > 0
				? `Nothing new — ${skipped} beat${skipped === 1 ? "" : "s"} matched existing seasons.`
				: "Nothing to promote.",
		6000,
	);
}

// ── helpers ─────────────────────────────────────────────────────────────

function resolveSeriesFromContext(
	plugin: FirstDraftPlugin,
	active: TFile,
	activeProject: ProjectMeta | null,
): ProjectMeta | null {
	if (activeProject?.projectType === "series") return activeProject;
	// Active file might be the Series Outline itself (inside the series
	// Development folder) rather than the series Index. Walk every series
	// project and pick the one whose root contains this file.
	let best: ProjectMeta | null = null;
	for (const meta of plugin.scanner.projects.values()) {
		if (meta.projectType !== "series") continue;
		const prefix = meta.projectRootPath + "/";
		if (active.path === meta.indexFilePath || active.path.startsWith(prefix)) {
			if (!best || meta.projectRootPath.length > best.projectRootPath.length) {
				best = meta;
			}
		}
	}
	return best;
}

function highestExistingSeasonNumber(
	plugin: FirstDraftPlugin,
	series: ProjectMeta,
): number {
	let max = 0;
	const prefix = series.projectRootPath + "/";
	for (const meta of plugin.scanner.projects.values()) {
		if (meta.projectType !== "season") continue;
		if (!meta.indexFilePath.startsWith(prefix)) continue;
		const num = parseSeasonNumberFromMeta(meta);
		if (num !== null && num > max) max = num;
	}
	return max;
}

function parseSeasonNumberFromMeta(meta: ProjectMeta): number | null {
	if (meta.season && meta.season.trim() !== "") {
		const n = parseInt(meta.season, 10);
		if (!Number.isNaN(n)) return n;
	}
	const seg = meta.projectRootPath.split("/").pop() ?? "";
	const m = /^S(\d+)$/i.exec(seg);
	if (m) {
		const n = parseInt(m[1] ?? "", 10);
		if (!Number.isNaN(n)) return n;
	}
	return null;
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
