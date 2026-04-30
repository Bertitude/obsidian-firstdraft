import { Notice, TFile, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta, GlobalConfig } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { sequencePairFromActive } from "../views/lookups";
import { locationRoster } from "../views/lookups";
import { snapshotFile, todayLabel } from "../versioning/snapshot";
import { isFountainFile } from "./file-detection";

// "Clean up sluglines" — normalize slug-line formatting across a sequence or
// the whole project to the project's configured conventions:
//
//   - Prefix: `INT.`, `EXT.`, `INT./EXT.`, `I/E.` (always with the trailing
//     period; uppercase).
//   - Location and time-of-day: ALL CAPS.
//   - Sub-location delimiter: rewrite any of the common legacy variants
//     (" - ", " — ", ", ", or a no-space hyphen between roster-known parts)
//     to whatever `sluglineSubLocationDelimiter` is configured for the project.
//   - Whitespace: collapse runs of spaces and tabs in the slug to single
//     spaces. Time separator is normalised to a single ` - ` no matter how
//     it was authored.
//
// Applies to fountain sluglines and slug-shaped H2 headings in paired dev
// notes. Auto-snapshots every file it actually changes (label
// `pre-slugline-cleanup <date>`) so the user can recover via Browse file
// versions.

const PREFIX_RE = /^(INT\.\/EXT|I\/E|INT|EXT)\.?(\s+|$)/i;
const SLUG_DETECT_RE = /^(INT|EXT|INT\.\/EXT|I\/E)[.\s]/i;
const TIME_SEP_RE = /\s+[-—–]\s+(.+)$/;
const H2_RE = /^(##\s+)(.+?)\s*$/;

interface SluglineChange {
	beforeLine: string;
	afterLine: string;
	lineNumber: number;
}

interface FileChange {
	file: TFile;
	originalText: string;
	newText: string;
	changes: SluglineChange[];
}

export interface CleanupScan {
	files: FileChange[];
	totalSluglines: number;
}

export type CleanupScope = "active" | "project";

export async function runCleanupSluglinesCommand(
	plugin: FirstDraftPlugin,
): Promise<void> {
	const active = plugin.app.workspace.getActiveFile();
	if (!active) {
		new Notice("No active file.");
		return;
	}
	const project = resolveActiveProject(active, plugin.scanner);
	if (!project) {
		new Notice("Active file isn't inside a recognised project.");
		return;
	}
	const cfg = resolveProjectSettings(project, plugin.settings);

	// Lazy-import the modal to keep the entrypoint cheap; the modal does
	// the scoped scan and commits the writes.
	const { openCleanupSluglinesModal } = await import("./cleanup-sluglines-modal");
	openCleanupSluglinesModal(plugin, active, project, cfg);
}

// Scan the chosen scope, returning every line that would be rewritten so the
// modal can show a count and the commit step can snapshot+write only the
// files that actually changed.
export async function scanForCleanup(
	plugin: FirstDraftPlugin,
	active: TFile,
	project: ProjectMeta,
	cfg: GlobalConfig,
	scope: CleanupScope,
): Promise<CleanupScan> {
	const files = await collectFilesInScope(plugin, active, project, cfg, scope);
	const knownLocations = buildKnownLocationsSet(plugin, project, cfg);
	const delimiter = cfg.sluglineSubLocationDelimiter;

	const out: FileChange[] = [];
	let totalSluglines = 0;
	for (const file of files) {
		const text = await plugin.app.vault.read(file);
		const isDevNote = !isFountainFile(file);
		const result = rewriteFile(text, delimiter, knownLocations, isDevNote);
		if (result.changes.length > 0) {
			out.push({
				file,
				originalText: text,
				newText: result.newText,
				changes: result.changes,
			});
		}
		totalSluglines += result.changes.length;
	}
	return { files: out, totalSluglines };
}

export async function applyCleanup(
	plugin: FirstDraftPlugin,
	scan: CleanupScan,
): Promise<void> {
	const stamp = `pre-slugline-cleanup ${todayLabel()}`;
	for (const fc of scan.files) {
		await snapshotFile(plugin.app, fc.file, stamp);
		await plugin.app.vault.modify(fc.file, fc.newText);
	}
}

// ── scope collection ────────────────────────────────────────────────────────

async function collectFilesInScope(
	plugin: FirstDraftPlugin,
	active: TFile,
	project: ProjectMeta,
	cfg: GlobalConfig,
	scope: CleanupScope,
): Promise<TFile[]> {
	if (scope === "active") {
		const pair = sequencePairFromActive(plugin.app, active, project, cfg);
		const out: TFile[] = [];
		if (pair?.fountainFile) out.push(pair.fountainFile);
		if (pair?.devNoteFile) out.push(pair.devNoteFile);
		return out;
	}

	// Project scope: every fountain in the project's screenplay folder, plus
	// every paired dev note that exists. We rely on the same pair resolver to
	// find matching dev notes — keeps behaviour consistent with the active
	// scope and tolerates atomized (folder-shape) sequences.
	const fountainFolderPath = project.sequenceFolderPath;
	const out: TFile[] = [];
	const seen = new Set<string>();
	const all = plugin.app.vault.getFiles();
	for (const f of all) {
		if (!f.path.startsWith(fountainFolderPath + "/")) continue;
		if (!isFountainFile(f)) continue;
		const pair = sequencePairFromActive(plugin.app, f, project, cfg);
		if (pair?.fountainFile && !seen.has(pair.fountainFile.path)) {
			seen.add(pair.fountainFile.path);
			out.push(pair.fountainFile);
		}
		if (pair?.devNoteFile && !seen.has(pair.devNoteFile.path)) {
			seen.add(pair.devNoteFile.path);
			out.push(pair.devNoteFile);
		}
	}
	void normalizePath;
	return out;
}

// Lowercase set of every location's display name + parent name. Used by the
// no-space-hyphen split heuristic so we only break "HOUSE-KITCHEN" when
// "HOUSE" is actually a location in the project, never "FORTY-NINE PALMS".
function buildKnownLocationsSet(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	cfg: GlobalConfig,
): Set<string> {
	const set = new Set<string>();
	for (const loc of locationRoster(plugin.app, project, cfg)) {
		set.add(loc.folderName.toUpperCase());
		// The roster name may be "PARENT - SUB"; index both halves separately
		// so either side counts as known when matching a no-space hyphen.
		const sep = " - ";
		const idx = loc.name.indexOf(sep);
		if (idx > 0) {
			set.add(loc.name.slice(0, idx).toUpperCase());
			set.add(loc.name.slice(idx + sep.length).toUpperCase());
		} else {
			set.add(loc.name.toUpperCase());
		}
		if (loc.parentLocation) set.add(loc.parentLocation.toUpperCase());
	}
	return set;
}

// ── per-file rewrite ────────────────────────────────────────────────────────

interface RewriteResult {
	newText: string;
	changes: SluglineChange[];
}

function rewriteFile(
	text: string,
	delimiter: string,
	knownLocations: Set<string>,
	isDevNote: boolean,
): RewriteResult {
	const lines = text.split(/\r?\n/);
	const changes: SluglineChange[] = [];
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		const rewritten = rewriteLine(raw, delimiter, knownLocations, isDevNote);
		if (rewritten !== null && rewritten !== raw) {
			changes.push({ beforeLine: raw, afterLine: rewritten, lineNumber: i });
			lines[i] = rewritten;
		}
	}
	return { newText: lines.join("\n"), changes };
}

function rewriteLine(
	raw: string,
	delimiter: string,
	knownLocations: Set<string>,
	isDevNote: boolean,
): string | null {
	if (isDevNote) {
		const m = H2_RE.exec(raw);
		if (!m) return null;
		const heading = m[2]!;
		// Forced sluglines round-trip through the dev note as plain H2s with
		// a leading dot (".LIMBO"); allow that here too.
		if (!isSluglineLine(heading)) return null;
		const cleaned = cleanupSlugline(heading, delimiter, knownLocations);
		if (cleaned === null) return null;
		return `${m[1]}${cleaned}`;
	}
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	if (!isSluglineLine(trimmed)) return null;
	const cleaned = cleanupSlugline(trimmed, delimiter, knownLocations);
	if (cleaned === null) return null;
	return cleaned;
}

function isSluglineLine(line: string): boolean {
	if (line.startsWith(".") && !line.startsWith("..")) {
		return line.length > 1;
	}
	return SLUG_DETECT_RE.test(line);
}

// ── slugline normalization ──────────────────────────────────────────────────

export function cleanupSlugline(
	raw: string,
	delimiter: string,
	knownLocations: Set<string>,
): string | null {
	let body = raw.trim();
	if (body === "") return null;

	let forced = false;
	if (body.startsWith(".") && !body.startsWith("..")) {
		forced = true;
		body = body.slice(1).trim();
	}

	let prefix = "";
	const prefixMatch = PREFIX_RE.exec(body);
	if (prefixMatch) {
		prefix = canonicalisePrefix(prefixMatch[1]!);
		body = body.slice(prefixMatch[0].length);
	} else if (!forced) {
		// Not a slug line we recognise — bail rather than guess.
		return null;
	}

	body = body.replace(/\s+/g, " ").trim();

	// Time-of-day = the segment after the LAST " - " / em-dash / en-dash
	// surrounded by whitespace. Anything before is the location.
	let location = body;
	let time: string | null = null;
	const timeMatch = TIME_SEP_RE.exec(body);
	if (timeMatch) {
		time = timeMatch[1]!.trim().toUpperCase();
		location = body.slice(0, timeMatch.index).trim();
	}

	location = normalizeLocation(location.toUpperCase(), delimiter, knownLocations);

	let result = "";
	if (forced) result += ".";
	if (prefix !== "") result += `${prefix} `;
	result += location;
	if (time !== null) result += ` - ${time}`;
	return result;
}

function canonicalisePrefix(raw: string): string {
	const u = raw.toUpperCase();
	if (u === "INT./EXT") return "INT./EXT.";
	if (u === "I/E") return "I/E.";
	if (u === "INT") return "INT.";
	if (u === "EXT") return "EXT.";
	return `${u}.`;
}

function normalizeLocation(
	loc: string,
	delimiter: string,
	knownLocations: Set<string>,
): string {
	const trimmed = loc.replace(/\s+/g, " ").trim();
	if (trimmed === "") return trimmed;

	// If already in the configured delimiter form, leave the split alone but
	// keep whitespace clean.
	if (delimiter !== "" && trimmed.includes(delimiter)) {
		return trimmed;
	}

	// Try common legacy delimiter variants in priority order.
	const candidates = [", ", " — ", " – ", " - "];
	for (const d of candidates) {
		if (d === delimiter) continue; // already handled above
		const idx = trimmed.indexOf(d);
		if (idx > 0 && idx + d.length < trimmed.length) {
			const primary = trimmed.slice(0, idx).trim();
			const sub = trimmed.slice(idx + d.length).trim();
			return `${primary}${delimiter}${sub}`;
		}
	}

	// No-space hyphen between two parts. Only split when the primary side is
	// a known location in the project — protects "FORTY-NINE PALMS" and
	// "TEN-YEAR-OLD'S BEDROOM" from being broken apart at random hyphens.
	const matches = [...trimmed.matchAll(/([A-Z0-9'][A-Z0-9' ]*?)-([A-Z0-9'][A-Z0-9'\s]*)/g)];
	for (const m of matches) {
		const primary = m[1]!.trim();
		const sub = m[2]!.trim();
		if (knownLocations.has(primary)) {
			return `${primary}${delimiter}${sub}`;
		}
	}

	return trimmed;
}
