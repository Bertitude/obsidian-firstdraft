import { Notice } from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { sequencePairFromActive } from "../views/lookups";
import { normalizeSlugline } from "../cursor-scroll/slugline";

// Sync sluglines from dev note to fountain. Reads `## SLUGLINE` H2 headings from
// the active dev note (in document order), compares against sluglines already
// present in the paired fountain file (normalized), and appends any missing ones
// at the end of the fountain with a blank scene block.
//
// Manual on-demand command — does NOT reorder or modify existing fountain content.

const H2_RE = /^##\s+(.+?)\s*$/;
const SLUGLINE_RE = /^(INT|EXT|INT\.\/EXT|I\/E)[.\s]/i;

export async function runSyncSluglinesCommand(plugin: FirstDraftPlugin): Promise<void> {
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

	const pair = sequencePairFromActive(plugin.app, active, project, resolveProjectSettings(project, plugin.settings));
	if (!pair) {
		new Notice("Active file isn't a scene fountain or dev note.");
		return;
	}
	if (pair.activeMode !== "dev-note") {
		new Notice("Run this from the dev note, not the fountain.");
		return;
	}
	if (!pair.devNoteFile) {
		new Notice("Dev note file not found.");
		return;
	}
	if (!pair.fountainFile) {
		new Notice("No paired fountain file. Create one first.");
		return;
	}

	const devNoteText = await plugin.app.vault.read(pair.devNoteFile);
	const noteSluglines = extractSluglineH2s(devNoteText);
	if (noteSluglines.length === 0) {
		new Notice("No slugline headings found in dev note (e.g. `## INT. CAR - DAY`).");
		return;
	}

	const fountainText = await plugin.app.vault.read(pair.fountainFile);
	const existingKeys = collectFountainSluglineKeys(fountainText);

	const missing = noteSluglines.filter(
		(s) => !existingKeys.has(normalizeSlugline(s)),
	);
	if (missing.length === 0) {
		new Notice("Fountain already has all sluglines from the dev note.");
		return;
	}

	const appended = appendSluglines(fountainText, missing);
	await plugin.app.vault.modify(pair.fountainFile, appended);
	new Notice(`Added ${missing.length} slugline${missing.length === 1 ? "" : "s"} to fountain.`);
}

function extractSluglineH2s(noteText: string): string[] {
	const out: string[] = [];
	for (const raw of noteText.split(/\r?\n/)) {
		const m = H2_RE.exec(raw);
		if (!m || !m[1]) continue;
		const heading = m[1].trim();
		if (SLUGLINE_RE.test(heading)) out.push(heading);
	}
	return out;
}

function collectFountainSluglineKeys(fountainText: string): Set<string> {
	const keys = new Set<string>();
	for (const raw of fountainText.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "") continue;
		if (SLUGLINE_RE.test(line)) keys.add(normalizeSlugline(line));
	}
	return keys;
}

function appendSluglines(fountainText: string, sluglines: string[]): string {
	const trimmed = fountainText.replace(/\s+$/, "");
	const block = sluglines.map((s) => `${s}\n\n`).join("\n");
	const separator = trimmed === "" ? "" : "\n\n";
	return `${trimmed}${separator}${block}`;
}

