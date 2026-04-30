import { Notice } from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { sequencePairFromActive } from "../views/lookups";
import { normalizeSlugline } from "../cursor-scroll/slugline";

// Sync sluglines from fountain to dev note — the reverse of
// sync-sluglines.ts. Reads sluglines from the active sequence's fountain
// file (in document order), compares against `## SLUGLINE` H2 headings
// already present in the paired dev note (normalized), and appends any
// missing ones as H2 sections at the end of the dev note.
//
// Symmetric in spirit with the dev-note → fountain command:
//   - Manual / on-demand (not auto on save).
//   - Strictly additive: never reorders, never removes, never modifies an
//     existing slugline H2's prose.
//   - Normalizes for comparison so case differences (`int. car - day` vs
//     `INT. CAR - DAY`) don't produce duplicates.
//
// Each appended slugline gets an empty paragraph below the H2 so the user
// can immediately start writing per-slugline notes.

const H2_RE = /^##\s+(.+?)\s*$/;
const SLUGLINE_RE = /^(INT|EXT|INT\.\/EXT|I\/E)[.\s]/i;

export async function runSyncSluglinesToDevNoteCommand(
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

	const pair = sequencePairFromActive(
		plugin.app,
		active,
		project,
		resolveProjectSettings(project, plugin.settings),
	);
	if (!pair) {
		new Notice("Active file isn't a sequence fountain or dev note.");
		return;
	}
	if (!pair.fountainFile) {
		new Notice("No paired fountain file.");
		return;
	}
	if (!pair.devNoteFile) {
		new Notice("No paired dev note. Create one first.");
		return;
	}

	const fountainText = await plugin.app.vault.read(pair.fountainFile);
	const fountainSluglines = extractFountainSluglines(fountainText);
	if (fountainSluglines.length === 0) {
		new Notice("No sluglines found in the fountain.");
		return;
	}

	const devNoteText = await plugin.app.vault.read(pair.devNoteFile);
	const existingKeys = collectDevNoteSluglineKeys(devNoteText);

	const missing = fountainSluglines.filter(
		(s) => !existingKeys.has(normalizeSlugline(s)),
	);
	if (missing.length === 0) {
		new Notice("Dev note already has all sluglines from the fountain.");
		return;
	}

	const appended = appendH2Sluglines(devNoteText, missing);
	await plugin.app.vault.modify(pair.devNoteFile, appended);
	new Notice(
		`Added ${missing.length} slugline${missing.length === 1 ? "" : "s"} to dev note.`,
	);
}

function extractFountainSluglines(fountainText: string): string[] {
	// Mirrors the slugline detection used elsewhere — accepts the four
	// standard prefixes and forced sluglines (".LIMBO" → "LIMBO"). Returned
	// strings are the verbatim slugline (forced ones with the leading dot
	// stripped, since that's the H2 form they should land as).
	const out: string[] = [];
	for (const raw of fountainText.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "") continue;
		if (line.startsWith(".") && !line.startsWith("..")) {
			out.push(line.slice(1).trim());
			continue;
		}
		if (SLUGLINE_RE.test(line)) out.push(line);
	}
	return out;
}

function collectDevNoteSluglineKeys(noteText: string): Set<string> {
	const keys = new Set<string>();
	for (const raw of noteText.split(/\r?\n/)) {
		const m = H2_RE.exec(raw);
		if (!m || !m[1]) continue;
		const heading = m[1].trim();
		if (!SLUGLINE_RE.test(heading) && !heading.startsWith(".")) continue;
		const normalised = heading.startsWith(".") ? heading.slice(1).trim() : heading;
		keys.add(normalizeSlugline(normalised));
	}
	return keys;
}

function appendH2Sluglines(noteText: string, sluglines: string[]): string {
	// Each new slugline gets its own H2 with a trailing blank line so the
	// user can immediately write under it. Inserted at the END of the dev
	// note — preserves any existing structure (Sequence Overview, Notes,
	// Continuity sections) above.
	const trimmed = noteText.replace(/\s+$/, "");
	const block = sluglines.map((s) => `## ${s}\n\n`).join("");
	const separator = trimmed === "" ? "" : "\n\n";
	return `${trimmed}${separator}${block}`;
}
