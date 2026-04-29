import { Editor, Notice, TFile, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { sequencePairFromActive } from "../views/lookups";
import { parseCharacterCues } from "../views/lookups";
import {
	fountainFilename,
	fountainScenesArrayEntry,
	isFountainFile,
} from "../fountain/file-detection";
import { readScenesArray, writeScenesArray } from "../longform/scenes-array";
import { sanitizeFilename } from "../utils/sanitize";
import { promptForLabel } from "../versioning/prompt";
import { snapshotFile, todayLabel } from "../versioning/snapshot";
import { applyId, generateId, stripId } from "../utils/stable-id";
import { findSluglineAtOrAbove, normalizeSlugline } from "../cursor-scroll/slugline";

// Phase: Split scene at cursor.
//
// In a fountain → split fountain at the slugline at/above cursor; create new
// fountain + paired dev note. New dev note's frontmatter is auto-populated
// from the new fountain content (cues → characters, slugline locations →
// locations).
//
// In a dev note → find H2 slugline at/above cursor, split dev note there. If
// a matching slugline exists in the paired fountain, split the fountain too
// at that slugline; otherwise the fountain is left untouched (with a notice).

const SLUGLINE_RE = /^(INT|EXT|INT\.\/EXT|I\/E)[.\s]/i;
const SLUGLINE_LOCATION_RE = /^(?:INT|EXT|INT\.\/EXT|I\/E)\.?\s+(.+?)(?:\s+-\s+.+)?$/i;

export async function runSplitSceneCommand(
	plugin: FirstDraftPlugin,
	editor: Editor,
): Promise<void> {
	const file = plugin.app.workspace.getActiveFile();
	if (!file) {
		new Notice("No active file.");
		return;
	}
	const project = resolveActiveProject(file, plugin.scanner);
	if (!project) {
		new Notice("Active file isn't inside a recognised project.");
		return;
	}
	const cfg = resolveProjectSettings(project, plugin.settings);
	const pair = sequencePairFromActive(plugin.app, file, project, cfg);
	if (!pair) {
		new Notice("Active file isn't a scene fountain or dev note.");
		return;
	}

	const cursorLine = editor.getCursor().line;

	if (isFountainFile(file)) {
		await splitFromFountain(plugin, project, cfg, file, cursorLine);
	} else {
		await splitFromDevNote(plugin, project, cfg, file, cursorLine);
	}
}

// ── fountain-side split ──────────────────────────────────────────────────

async function splitFromFountain(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	cfg: ReturnType<typeof resolveProjectSettings>,
	fountainFile: TFile,
	cursorLine: number,
): Promise<void> {
	const fountainText = await plugin.app.vault.read(fountainFile);
	const lines = fountainText.split(/\r?\n/);

	const slugline = findSluglineLineAtOrBelow(lines, cursorLine);
	if (slugline === null) {
		new Notice("No slugline at or below cursor — can't split here.");
		return;
	}

	const oldSceneName = stemOf(fountainFile);
	const userTypedName = await promptForNewSceneName(plugin, project, cfg, oldSceneName);
	if (!userTypedName) return;

	// Auto-attach a stable ID. The user types just a working title; we append
	// `-a3b9` so the new scene fits the same conventions as migrated projects.
	const id = generateId();
	const newSceneName = applyId(userTypedName, id);

	const beforeText = lines.slice(0, slugline.line).join("\n").replace(/\s+$/, "") + "\n";
	const afterText = lines.slice(slugline.line).join("\n");

	// Snapshot before destructive write so the user can revert via Browse
	// file versions if they realize they split in the wrong place.
	await snapshotFile(plugin.app, fountainFile, `pre-split ${todayLabel()}`);

	// Truncate the original fountain.
	await plugin.app.vault.modify(fountainFile, beforeText);

	// Create the new fountain.
	const newFountainPath = normalizePath(
		`${project.sequenceFolderPath}/${fountainFilename(newSceneName, cfg.fountainFileFormat)}`,
	);
	const newFountainFile = await plugin.app.vault.create(newFountainPath, afterText);

	// Create paired dev note with auto-detected frontmatter (and the ID).
	await createPairedDevNote(plugin, project, cfg, newSceneName, afterText, id);

	// Insert into Longform scenes: array right after the original.
	await insertSceneAfter(
		plugin,
		project,
		cfg,
		oldSceneName,
		newSceneName,
	);

	new Notice(`Split into "${oldSceneName}" + "${newSceneName}".`);
	await plugin.app.workspace.getLeaf(false).openFile(newFountainFile);
}

// ── dev-note-side split ──────────────────────────────────────────────────

async function splitFromDevNote(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	cfg: ReturnType<typeof resolveProjectSettings>,
	devNoteFile: TFile,
	cursorLine: number,
): Promise<void> {
	const devText = await plugin.app.vault.read(devNoteFile);
	const lines = devText.split(/\r?\n/);

	// Find slugline-style H2 at/below cursor — split begins there.
	const h2 = findSluglineH2AtOrBelow(lines, cursorLine);
	if (h2 === null) {
		new Notice("No slugline-style H2 at or below cursor — can't split here.");
		return;
	}

	const oldSceneName = devNoteFile.basename;
	const userTypedName = await promptForNewSceneName(plugin, project, cfg, oldSceneName);
	if (!userTypedName) return;

	// Auto-attach a stable ID for the new scene.
	const id = generateId();
	const newSceneName = applyId(userTypedName, id);

	// Look up the paired fountain — it may or may not exist.
	const pairedFountain = findPairedFountain(plugin, project, cfg, oldSceneName);

	// Decide if fountain side can also be split. Match H2 text → fountain slugline.
	let fountainSplit: { beforeText: string; afterText: string; file: TFile } | null = null;
	if (pairedFountain) {
		const fountainText = await plugin.app.vault.read(pairedFountain);
		const fLines = fountainText.split(/\r?\n/);
		const targetKey = normalizeSlugline(h2.text);
		const matchedLine = fLines.findIndex(
			(ln) => SLUGLINE_RE.test(ln.trim()) && normalizeSlugline(ln) === targetKey,
		);
		if (matchedLine !== -1) {
			fountainSplit = {
				beforeText: fLines.slice(0, matchedLine).join("\n").replace(/\s+$/, "") + "\n",
				afterText: fLines.slice(matchedLine).join("\n"),
				file: pairedFountain,
			};
		}
	}

	// Split dev note. New dev note inherits applicable frontmatter from
	// fountain content (if we have a fountain split); otherwise we leave
	// frontmatter empty (template-driven).
	const beforeDev = lines.slice(0, h2.line).join("\n").replace(/\s+$/, "") + "\n";
	const afterDevBody = lines.slice(h2.line).join("\n");

	// Snapshot before destructive writes — dev note always, paired fountain
	// only if we'll modify it (i.e. an actual fountain split, not just a stub
	// creation).
	const stamp = `pre-split ${todayLabel()}`;
	await snapshotFile(plugin.app, devNoteFile, stamp);
	if (fountainSplit) {
		await snapshotFile(plugin.app, fountainSplit.file, stamp);
	}

	await plugin.app.vault.modify(devNoteFile, beforeDev);

	// Always create a paired fountain for the new scene so it's a first-class
	// citizen (in scenes: array, mergeable, compileable). When we have a real
	// fountain split, the new fountain gets the split-off content. When we
	// don't (dev note had an H2 the fountain hadn't reached yet), the new
	// fountain starts as a stub with just the slugline so the user can flesh
	// it out — natural fit for the dev-note-first workflow.
	const stubFountainContent = `${h2.text}\n\n`;
	const newFountainContent = fountainSplit?.afterText ?? stubFountainContent;
	if (fountainSplit) {
		await plugin.app.vault.modify(fountainSplit.file, fountainSplit.beforeText);
	}
	const newFountainPath = normalizePath(
		`${project.sequenceFolderPath}/${fountainFilename(newSceneName, cfg.fountainFileFormat)}`,
	);
	await plugin.app.vault.create(newFountainPath, newFountainContent);
	await insertSceneAfter(plugin, project, cfg, oldSceneName, newSceneName);

	// Now create the new dev note. Frontmatter gets auto-detected from the
	// new fountain content (cues, slugline locations); body is the split-off
	// prose with the H2 preserved.
	const newDevContent = buildSplitDevNoteContent(
		cfg.sceneNoteTemplate,
		newFountainContent,
		afterDevBody,
	);
	const newDevPath = devNotePathFor(project, cfg, newSceneName);
	const newDevFile = await plugin.app.vault.create(newDevPath, newDevContent);
	await plugin.app.fileManager.processFrontMatter(
		newDevFile,
		(fm: Record<string, unknown>) => {
			fm.id = id;
		},
	);

	const tail = fountainSplit
		? `Split into "${oldSceneName}" + "${newSceneName}" (fountain followed).`
		: `Split dev note "${oldSceneName}" → "${newSceneName}". New fountain stubbed with the slugline.`;
	new Notice(tail);

	await plugin.app.workspace.getLeaf(false).openFile(newDevFile);
}

// ── shared helpers ───────────────────────────────────────────────────────

async function promptForNewSceneName(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	cfg: ReturnType<typeof resolveProjectSettings>,
	originalSceneName: string,
): Promise<string | null> {
	// Default to the original name's display form (without ID) plus " 2".
	// We'll attach a fresh ID to whatever the user enters.
	let candidate = `${stripId(originalSceneName)} 2`;
	let description: string | undefined;

	while (true) {
		const name = await promptForLabel(plugin.app, {
			title: "Split scene",
			description: description ?? "Name for the second scene:",
			defaultValue: candidate,
		});
		if (name === null) return null;
		const sanitized = sanitizeFilename(name, cfg.filenameReplacementChar);
		if (!sanitized) {
			candidate = `${originalSceneName} 2`;
			description = "Name has no valid filename characters. Try another.";
			continue;
		}
		if (!nameIsAvailable(plugin, project, cfg, sanitized)) {
			candidate = `${sanitized} 2`;
			description = `"${sanitized}" already exists. Try another name.`;
			continue;
		}
		return sanitized;
	}
}

function nameIsAvailable(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	cfg: ReturnType<typeof resolveProjectSettings>,
	sequenceName: string,
): boolean {
	const fountainMd = normalizePath(
		`${project.sequenceFolderPath}/${fountainFilename(sequenceName, "fountain-md")}`,
	);
	const fountainBare = normalizePath(
		`${project.sequenceFolderPath}/${fountainFilename(sequenceName, "fountain")}`,
	);
	const devNote = devNotePathFor(project, cfg, sequenceName);
	for (const p of [fountainMd, fountainBare, devNote]) {
		if (plugin.app.vault.getAbstractFileByPath(p)) return false;
	}
	return true;
}

function devNotePathFor(
	project: ProjectMeta,
	cfg: ReturnType<typeof resolveProjectSettings>,
	sequenceName: string,
): string {
	return normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.sequencesSubfolder}/${sequenceName}.md`,
	);
}

function findPairedFountain(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	cfg: ReturnType<typeof resolveProjectSettings>,
	sequenceName: string,
): TFile | null {
	for (const fmt of ["fountain-md", "fountain"] as const) {
		const path = normalizePath(
			`${project.sequenceFolderPath}/${fountainFilename(sequenceName, fmt)}`,
		);
		const f = plugin.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) return f;
	}
	void cfg; // unused but kept for future per-project format overrides
	return null;
}

// Walk down from the cursor line to the next slugline. Cursor on a slugline
// returns that line. Used by split: cursor at end of scene 1 → split begins
// at the next scene's slugline.
function findSluglineLineAtOrBelow(
	lines: string[],
	cursorLine: number,
): { line: number; text: string } | null {
	const start = Math.min(Math.max(cursorLine, 0), lines.length - 1);
	for (let i = start; i < lines.length; i++) {
		const raw = (lines[i] ?? "").trim();
		if (raw === "") continue;
		if (SLUGLINE_RE.test(raw)) return { line: i, text: raw };
	}
	return null;
}

// Walk down from the cursor line to the next slugline-style H2 in a dev note.
function findSluglineH2AtOrBelow(
	lines: string[],
	cursorLine: number,
): { line: number; text: string } | null {
	const start = Math.min(Math.max(cursorLine, 0), lines.length - 1);
	for (let i = start; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		const m = /^##\s+(.+?)\s*$/.exec(raw);
		if (!m || !m[1]) continue;
		const heading = m[1].trim();
		if (SLUGLINE_RE.test(heading)) return { line: i, text: heading };
	}
	return null;
}

async function createPairedDevNote(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	cfg: ReturnType<typeof resolveProjectSettings>,
	sequenceName: string,
	fountainContent: string,
	id: string,
): Promise<void> {
	const path = devNotePathFor(project, cfg, sequenceName);
	const content = buildSplitDevNoteContent(cfg.sceneNoteTemplate, fountainContent, "");
	await ensureFolderExists(plugin, parentPath(path));
	const created = await plugin.app.vault.create(path, content);
	await plugin.app.fileManager.processFrontMatter(
		created,
		(fm: Record<string, unknown>) => {
			fm.id = id;
		},
	);
}

async function ensureFolderExists(
	plugin: FirstDraftPlugin,
	folderPath: string,
): Promise<void> {
	const existing = plugin.app.vault.getAbstractFileByPath(folderPath);
	if (existing) return;
	await plugin.app.vault.createFolder(folderPath);
}

function parentPath(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i);
}

// Apply auto-detected frontmatter (characters, locations) to the dev note
// template's frontmatter block. If extraBody is provided, REPLACE the
// template's body with extraBody (so split-off prose stands alone, without
// empty Overview/Notes/Continuity scaffolding). When no extraBody, keep the
// template body as the starter scaffold (used by fountain → new dev note path).
function buildSplitDevNoteContent(
	template: string,
	fountainContent: string,
	extraBody: string,
): string {
	const detected = deriveFrontmatterFromFountain(fountainContent);
	const populated = applyDetectedFrontmatter(template, detected);
	if (extraBody.trim() === "") return populated;
	// Replace template body with the split-off prose.
	const fmEnd = findFrontmatterEnd(populated);
	const fmPart = fmEnd > 0 ? populated.slice(0, fmEnd).replace(/\s+$/, "") : "";
	return `${fmPart}\n\n${extraBody.replace(/^\s+/, "")}`;
}

// Returns the index just past the closing `---` of the YAML frontmatter, or 0
// if the text doesn't start with frontmatter.
function findFrontmatterEnd(text: string): number {
	if (!text.startsWith("---\n")) return 0;
	const idx = text.indexOf("\n---", 4);
	if (idx === -1) return 0;
	return idx + 4; // include "\n---"
}

interface DetectedFrontmatter {
	characters: string[];
	locations: string[];
}

function deriveFrontmatterFromFountain(text: string): DetectedFrontmatter {
	if (text.trim() === "") return { characters: [], locations: [] };
	const cues = parseCharacterCues(text);
	const characters = [...new Set(cues.map((c) => c.toUpperCase()))].sort();

	const locs = new Set<string>();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!SLUGLINE_RE.test(line)) continue;
		const m = SLUGLINE_LOCATION_RE.exec(line);
		if (m && m[1]) locs.add(m[1].trim().toUpperCase());
	}
	return { characters, locations: [...locs].sort() };
}

// Replace the template's `characters: []` and `locations: []` lines with the
// detected values (or leave them empty if no matches). Naive YAML editing —
// we expect the template to use these exact field names from defaults.ts.
function applyDetectedFrontmatter(
	template: string,
	detected: DetectedFrontmatter,
): string {
	const replaceArrayField = (text: string, field: string, values: string[]): string => {
		const inlineRe = new RegExp(`^${field}:\\s*\\[\\s*\\]\\s*$`, "m");
		if (values.length === 0) return text;
		const yamlList =
			values.length === 0
				? `${field}: []`
				: `${field}:\n${values.map((v) => `  - ${v}`).join("\n")}`;
		if (inlineRe.test(text)) return text.replace(inlineRe, yamlList);
		// Bare "characters:" line (no value)
		const bareRe = new RegExp(`^${field}:\\s*$`, "m");
		if (bareRe.test(text)) return text.replace(bareRe, yamlList);
		return text;
	};

	let next = template;
	next = replaceArrayField(next, "characters", detected.characters);
	next = replaceArrayField(next, "locations", detected.locations);
	return next;
}

async function insertSceneAfter(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	cfg: ReturnType<typeof resolveProjectSettings>,
	originalSceneName: string,
	newSceneName: string,
): Promise<void> {
	const originalEntry = fountainScenesArrayEntry(originalSceneName, cfg.fountainFileFormat);
	const newEntry = fountainScenesArrayEntry(newSceneName, cfg.fountainFileFormat);
	const altOldEntry = fountainScenesArrayEntry(
		originalSceneName,
		cfg.fountainFileFormat === "fountain" ? "fountain-md" : "fountain",
	);

	const existing = readScenesArray(plugin.app, project.indexFilePath);
	// Remove any pre-existing copy of newEntry (e.g. auto-injected by the
	// rename-sync create handler), so we land it at the desired position.
	const filtered = existing.filter((e) => e !== newEntry);
	const idx = filtered.findIndex((e) => e === originalEntry || e === altOldEntry);
	const next = [...filtered];
	if (idx === -1) {
		next.push(newEntry);
	} else {
		next.splice(idx + 1, 0, newEntry);
	}
	if (next.every((e, i) => e === existing[i]) && next.length === existing.length) return;
	await writeScenesArray(plugin.app, project.indexFilePath, next);
}

function stemOf(file: TFile): string {
	if (file.extension === "fountain") return file.basename;
	if (file.extension === "md" && file.basename.endsWith(".fountain")) {
		return file.basename.slice(0, -".fountain".length);
	}
	return file.basename;
}
