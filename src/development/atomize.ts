import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { GlobalConfig, ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import {
	devNotePathCandidates,
	fountainFilename,
	fountainPathCandidates,
	fountainSceneName,
	isFountainFile,
} from "../fountain/file-detection";
import { snapshotFile, todayLabel } from "../versioning/snapshot";
import { sanitizeFilename } from "../utils/sanitize";
import { applyId, generateUniqueId } from "../utils/stable-id";
import { parseSlugline } from "./slugline-parse";
import { yamlString } from "../utils/yaml";

// "Atomize sequence into scenes" — splits a sequence's master fountain into
// per-slugline scene fountains, each paired with its own dev note. The master
// stays untouched (preserved for review/compile); scenes become focused
// working surfaces.
//
// Folder shape produced (per the design doc):
//
//   Sequences/<sequence-stem>/
//     <sequence-stem>.fountain.md             (master, moved here from flat)
//     Scenes/
//       INT. CAR - DAY-c7d2.fountain.md
//       EXT. CABIN - NIGHT-d8e3.fountain.md
//
//   Development/Sequences/<sequence-stem>/
//     <sequence-stem>.md                       (master dev note, moved)
//     Scenes/
//       INT. CAR - DAY-c7d2.md
//       EXT. CABIN - NIGHT-d8e3.md
//
// Diff-aware on re-run: existing scene files matched by `slugline_key`
// frontmatter are left untouched (preserves user edits). New sluglines in the
// master become new scene files. Sluglines that disappeared from the master
// get flagged orphan (file kept, frontmatter `orphan: true`, prose marker
// added).

interface ParsedScene {
	slugline: string;          // verbatim, including INT/EXT/etc.
	occurrence: number;        // 0-based occurrence index for this slugline within the master
	startLine: number;         // line index in master fountain
	content: string;           // full text of this scene (slugline line + everything until next slugline)
}

interface ExistingSceneRecord {
	devFile: TFile;
	fountainFile: TFile | null;
	slugline_key: string;
	id: string | null;
}

export async function runAtomizeSequenceCommand(plugin: FirstDraftPlugin): Promise<void> {
	const active = plugin.app.workspace.getActiveFile();
	if (!active) {
		new Notice("Open a sequence's fountain or dev note first.");
		return;
	}
	const project = resolveActiveProject(active, plugin.scanner);
	if (!project) {
		new Notice("Active file isn't inside a recognised project.");
		return;
	}
	const cfg = resolveProjectSettings(project, plugin.settings);

	// Resolve master fountain + dev note from whichever side the active file
	// is on. Tolerates flat or folder shape on either side.
	const resolved = resolveMasterPair(plugin.app, active, project, cfg);
	if (!resolved) {
		new Notice("Couldn't resolve a sequence master from the active file.");
		return;
	}
	const { masterFountain, masterDevNote, sequenceStem } = resolved;

	// Snapshot before any moves or writes.
	await snapshotFile(plugin.app, masterFountain, `pre-atomize ${todayLabel()}`);
	if (masterDevNote) {
		await snapshotFile(plugin.app, masterDevNote, `pre-atomize ${todayLabel()}`);
	}

	const fountainContent = await plugin.app.vault.read(masterFountain);
	const scenes = parseScenes(fountainContent);
	if (scenes.length === 0) {
		new Notice("No sluglines found in the sequence — nothing to atomize.");
		return;
	}

	// Parse master dev note's H2 sections keyed by slugline so we can carry
	// them into matching scene dev notes on FIRST creation.
	const devNoteSections = masterDevNote
		? parseDevNoteH2Sections(await plugin.app.vault.read(masterDevNote))
		: new Map<string, string>();

	// Promote both sides to folder shape if currently flat. After this,
	// masterFountain.path / masterDevNote.path point to the new locations.
	const promoted = await promoteToFolderShape(
		plugin.app,
		masterFountain,
		masterDevNote,
		project,
		cfg,
		sequenceStem,
	);
	const finalMasterFountain = promoted.fountain;
	const finalMasterDevNote = promoted.devNote;

	const fountainScenesFolder = normalizePath(
		`${project.sequenceFolderPath}/${sequenceStem}/Scenes`,
	);
	const devScenesFolder = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.sequencesSubfolder}/${sequenceStem}/Scenes`,
	);
	await ensureFolder(plugin.app, fountainScenesFolder);
	await ensureFolder(plugin.app, devScenesFolder);

	// Read existing scenes from the dev side (the dev note carries the
	// canonical slugline_key — fountain files don't, since we don't put
	// frontmatter in fountains).
	const existing = collectExistingScenes(plugin.app, devScenesFolder, fountainScenesFolder);

	// Diff: matched (preserved), new (created), orphan (master no longer has).
	const masterKeys = new Set(scenes.map((s) => sluglineKey(s.slugline, s.occurrence)));
	const usedIds = new Set<string>();
	for (const e of existing.values()) {
		if (e.id) usedIds.add(e.id);
	}

	let created = 0;
	let preserved = 0;

	for (const [order, scene] of scenes.entries()) {
		const key = sluglineKey(scene.slugline, scene.occurrence);
		const match = existing.get(key);
		if (match) {
			preserved += 1;
			// Update scene_order in the dev note frontmatter if it shifted —
			// the master may have been reordered without losing sluglines.
			await plugin.app.fileManager.processFrontMatter(
				match.devFile,
				(fm: Record<string, unknown>) => {
					fm.scene_order = order + 1;
				},
			);
			continue;
		}
		// New scene — generate a stable ID, sanitize the filename, write both
		// the fountain and the dev note.
		const id = generateUniqueId(usedIds);
		usedIds.add(id);
		const sluglineFilename = sanitizeFilename(scene.slugline, cfg.filenameReplacementChar)
			?? `Scene ${order + 1}`;
		const stem = applyId(sluglineFilename, id);

		const fountainPath = normalizePath(
			`${fountainScenesFolder}/${fountainFilename(stem, cfg.fountainFileFormat)}`,
		);
		const devNotePath = normalizePath(`${devScenesFolder}/${stem}.md`);

		await plugin.app.vault.create(fountainPath, scene.content);
		const devBody = composeSceneDevNote(
			scene,
			order + 1,
			id,
			finalMasterDevNote,
			devNoteSections.get(key) ?? "",
		);
		await plugin.app.vault.create(devNotePath, devBody);
		created += 1;
	}

	// Orphan handling: scenes whose slugline_key isn't in the master anymore.
	let orphaned = 0;
	for (const [key, record] of existing.entries()) {
		if (masterKeys.has(key)) continue;
		await markOrphan(plugin.app, record);
		orphaned += 1;
	}

	const summary = summarise({ created, preserved, orphaned });
	new Notice(`Atomized — ${summary}`, 6000);

	// Open the first new scene if there was one — gives the user immediate
	// feedback that the operation produced visible output.
	if (created > 0) {
		const firstNewKey = scenes
			.map((s) => sluglineKey(s.slugline, s.occurrence))
			.find((k) => !existing.has(k));
		if (firstNewKey) {
			const newRecord = collectExistingScenes(plugin.app, devScenesFolder, fountainScenesFolder).get(firstNewKey);
			if (newRecord) {
				void plugin.app.workspace.getLeaf(false).openFile(newRecord.devFile);
			}
		}
	}

	void finalMasterFountain; // currently unused; reserved for future open-master affordance
}

// ── master resolution ───────────────────────────────────────────────────

interface MasterPair {
	masterFountain: TFile;
	masterDevNote: TFile | null;
	sequenceStem: string;       // basename without extension parts, e.g. "Big Damn Heroes-a3b9"
}

function resolveMasterPair(
	app: App,
	active: TFile,
	project: ProjectMeta,
	cfg: GlobalConfig,
): MasterPair | null {
	// Active file is either the fountain side or the dev note side. Both lead
	// to the same logical sequence — we just need to identify the stem and
	// then look up both sides.
	const stem = inferSequenceStem(active, project, cfg);
	if (!stem) return null;

	const fountainCandidates = fountainPathCandidates(project.sequenceFolderPath, stem)
		.map((p) => normalizePath(p));
	const fountain = firstExistingFile(app, fountainCandidates);
	if (!fountain) return null;

	const devFolder = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.sequencesSubfolder}`,
	);
	const devCandidates = devNotePathCandidates(devFolder, stem).map((p) => normalizePath(p));
	const devNote = firstExistingFile(app, devCandidates);

	return { masterFountain: fountain, masterDevNote: devNote, sequenceStem: stem };
}

function inferSequenceStem(
	active: TFile,
	project: ProjectMeta,
	cfg: GlobalConfig,
): string | null {
	// Fountain side → strip fountain extension parts.
	if (isFountainFile(active)) return fountainSceneName(active);

	// Dev note side → must live under <dev>/<sequencesSubfolder>/. Stem is
	// basename for flat shape; for folder shape (the file sits at
	// <dev>/<sequencesSubfolder>/<stem>/<stem>.md), take the parent folder
	// name.
	const devFolder = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.sequencesSubfolder}`,
	);
	if (!active.path.startsWith(devFolder + "/")) return null;
	const tail = active.path.slice(devFolder.length + 1);
	const segments = tail.split("/");
	if (segments.length === 1) {
		// Flat: <name>.md
		return active.basename;
	}
	if (segments.length === 2 && segments[1] === `${segments[0]}.md`) {
		// Folder shape: <stem>/<stem>.md
		return segments[0]!;
	}
	return null;
}

function firstExistingFile(app: App, paths: string[]): TFile | null {
	for (const p of paths) {
		const f = app.vault.getAbstractFileByPath(p);
		if (f instanceof TFile) return f;
	}
	return null;
}

// ── promotion: flat → folder shape ──────────────────────────────────────

async function promoteToFolderShape(
	app: App,
	masterFountain: TFile,
	masterDevNote: TFile | null,
	project: ProjectMeta,
	cfg: GlobalConfig,
	sequenceStem: string,
): Promise<{ fountain: TFile; devNote: TFile | null }> {
	// Fountain side
	const fountainTargetFolder = normalizePath(
		`${project.sequenceFolderPath}/${sequenceStem}`,
	);
	const fountainTargetPath = normalizePath(
		`${fountainTargetFolder}/${masterFountain.name}`,
	);
	let nextFountain = masterFountain;
	if (masterFountain.path !== fountainTargetPath) {
		await ensureFolder(app, fountainTargetFolder);
		await app.fileManager.renameFile(masterFountain, fountainTargetPath);
		const after = app.vault.getAbstractFileByPath(fountainTargetPath);
		if (after instanceof TFile) nextFountain = after;
	}

	// Dev note side
	let nextDevNote = masterDevNote;
	if (masterDevNote) {
		const devTargetFolder = normalizePath(
			`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.sequencesSubfolder}/${sequenceStem}`,
		);
		const devTargetPath = normalizePath(`${devTargetFolder}/${masterDevNote.name}`);
		if (masterDevNote.path !== devTargetPath) {
			await ensureFolder(app, devTargetFolder);
			await app.fileManager.renameFile(masterDevNote, devTargetPath);
			const after = app.vault.getAbstractFileByPath(devTargetPath);
			if (after instanceof TFile) nextDevNote = after;
		}
	}

	return { fountain: nextFountain, devNote: nextDevNote };
}

// ── scene parsing (master fountain → scenes) ────────────────────────────

const SLUGLINE_RE = /^(INT|EXT|INT\.?\s*\/\s*EXT|I\s*\/\s*E)[.\s]/i;
const FORCED_SLUGLINE_RE = /^\.[^.]/;

function parseScenes(content: string): ParsedScene[] {
	const lines = content.split(/\r?\n/);
	const occurrenceCount = new Map<string, number>();
	const scenes: ParsedScene[] = [];
	let currentBuffer: string[] = [];
	let currentSlugline: string | null = null;
	let currentStartLine = -1;
	let currentOccurrence = 0;

	const flush = () => {
		if (currentSlugline === null) return;
		scenes.push({
			slugline: currentSlugline,
			occurrence: currentOccurrence,
			startLine: currentStartLine,
			content: currentBuffer.join("\n").trimEnd() + "\n",
		});
	};

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		const trimmed = raw.trim();
		const isSlugline = trimmed !== "" && (
			SLUGLINE_RE.test(trimmed) || FORCED_SLUGLINE_RE.test(trimmed)
		);

		if (isSlugline) {
			// Close out any in-progress scene first.
			flush();
			const slugline = trimmed.startsWith(".") ? trimmed.slice(1).trim() : trimmed;
			const seen = occurrenceCount.get(slugline) ?? 0;
			occurrenceCount.set(slugline, seen + 1);
			currentSlugline = slugline;
			currentOccurrence = seen;
			currentStartLine = i;
			currentBuffer = [raw];
			continue;
		}

		if (currentSlugline !== null) {
			currentBuffer.push(raw);
		}
		// Otherwise pre-first-slugline content (title page, opening action) —
		// stays in the master only.
	}

	flush();
	return scenes;
}

function sluglineKey(slugline: string, occurrence: number): string {
	return `${slugline}:${occurrence}`;
}

// ── master dev note H2 carry-over ───────────────────────────────────────

function parseDevNoteH2Sections(markdown: string): Map<string, string> {
	// Body-level H2 headings whose text matches a slugline shape are paired
	// up by occurrence index. Returns a map of `slugline_key` → section body
	// (excluding the heading line). Used to seed the new scene dev note's
	// "Scene Overview" section on first creation.
	const lines = markdown.split(/\r?\n/);
	const out = new Map<string, string>();
	const occurrenceCount = new Map<string, number>();
	let activeKey: string | null = null;
	let activeBuffer: string[] = [];

	const flush = () => {
		if (activeKey !== null) {
			out.set(activeKey, activeBuffer.join("\n").trim());
		}
		activeKey = null;
		activeBuffer = [];
	};

	for (const line of lines) {
		const h2Match = /^##\s+(.+?)\s*$/.exec(line);
		if (h2Match) {
			const heading = h2Match[1]!.trim();
			const isSlugline = SLUGLINE_RE.test(heading) || FORCED_SLUGLINE_RE.test(heading);
			if (isSlugline) {
				flush();
				const slugline = heading.startsWith(".") ? heading.slice(1).trim() : heading;
				const seen = occurrenceCount.get(slugline) ?? 0;
				occurrenceCount.set(slugline, seen + 1);
				activeKey = sluglineKey(slugline, seen);
				continue;
			}
			// Non-slugline H2 ends the active capture without recording.
			flush();
			continue;
		}
		if (activeKey !== null) activeBuffer.push(line);
	}
	flush();
	return out;
}

// ── existing scenes (for diff-aware) ────────────────────────────────────

function collectExistingScenes(
	app: App,
	devScenesFolder: string,
	fountainScenesFolder: string,
): Map<string, ExistingSceneRecord> {
	const out = new Map<string, ExistingSceneRecord>();
	const devFolder = app.vault.getAbstractFileByPath(devScenesFolder);
	if (!(devFolder instanceof TFolder)) return out;

	const fountainFolder = app.vault.getAbstractFileByPath(fountainScenesFolder);
	const fountainsByBase = new Map<string, TFile>();
	if (fountainFolder instanceof TFolder) {
		for (const child of fountainFolder.children) {
			if (!(child instanceof TFile)) continue;
			if (!isFountainFile(child)) continue;
			fountainsByBase.set(fountainSceneName(child), child);
		}
	}

	for (const child of devFolder.children) {
		if (!(child instanceof TFile)) continue;
		if (child.extension !== "md") continue;
		const fm = app.metadataCache.getFileCache(child)?.frontmatter as
			| Record<string, unknown>
			| undefined;
		const key = typeof fm?.slugline_key === "string" ? fm.slugline_key.trim() : "";
		if (key === "") continue;
		const id = typeof fm?.id === "string" ? fm.id.trim() : null;
		out.set(key, {
			devFile: child,
			fountainFile: fountainsByBase.get(child.basename) ?? null,
			slugline_key: key,
			id,
		});
	}
	return out;
}

async function markOrphan(app: App, record: ExistingSceneRecord): Promise<void> {
	await app.fileManager.processFrontMatter(record.devFile, (fm: Record<string, unknown>) => {
		fm.orphan = true;
	});
	const text = await app.vault.read(record.devFile);
	const banner =
		"\n> ⚠️ **Orphan scene** — this slugline no longer appears in the master sequence. The file is preserved for reference; reassemble (Update sequence from scenes) won't include it.\n";
	if (!text.includes("Orphan scene")) {
		// Insert the banner just after the closing `---` of frontmatter.
		const fmEnd = text.indexOf("\n---", text.startsWith("---") ? 3 : 0);
		if (fmEnd === -1) {
			await app.vault.modify(record.devFile, banner + text);
		} else {
			const insertAt = fmEnd + 4; // after "\n---"
			const next = text.slice(0, insertAt) + "\n" + banner + text.slice(insertAt);
			await app.vault.modify(record.devFile, next);
		}
	}
}

// ── scene dev note composition ──────────────────────────────────────────

function composeSceneDevNote(
	scene: ParsedScene,
	order: number,
	id: string,
	masterDevNote: TFile | null,
	carriedOverview: string,
): string {
	const parsed = parseSlugline(scene.slugline);
	const parentLink = masterDevNote
		? `"[[${fountainSceneName(masterDevNote)}]]"`
		: '""';
	const overview = carriedOverview.trim() === ""
		? "What this scene does for the sequence and the story."
		: carriedOverview.trim();

	return `---
type: scene
id: ${id}
parent_sequence: ${parentLink}
slugline_key: ${yamlString(sluglineKey(scene.slugline, scene.occurrence))}
slugline: ${yamlString(scene.slugline)}
scene_order: ${order}
intext: ${yamlString(parsed.intext)}
location: ${yamlString(parsed.location)}
time: ${yamlString(parsed.time)}
forced: ${parsed.forced}
characters: []
locations: ${parsed.location !== "" ? `[${yamlString(parsed.location)}]` : "[]"}
---

## Scene Overview

${overview}

## Notes

## Continuity
`;
}

// ── helpers ─────────────────────────────────────────────────────────────

interface DiffSummary {
	created: number;
	preserved: number;
	orphaned: number;
}

function summarise(s: DiffSummary): string {
	const parts: string[] = [];
	parts.push(`${s.created} new`);
	if (s.preserved > 0) parts.push(`${s.preserved} preserved`);
	if (s.orphaned > 0) parts.push(`${s.orphaned} orphaned`);
	return parts.join(", ");
}

async function ensureFolder(app: App, path: string): Promise<void> {
	const at = app.vault.getAbstractFileByPath(path);
	if (at instanceof TFolder) return;
	if (at) throw new Error(`Path is a file, not a folder: ${path}`);
	const segments = path.split("/");
	let cumulative = "";
	for (const seg of segments) {
		cumulative = cumulative ? `${cumulative}/${seg}` : seg;
		const existing = app.vault.getAbstractFileByPath(cumulative);
		if (existing) continue;
		await app.vault.createFolder(cumulative);
	}
}
