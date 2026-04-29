import { Notice, TFile } from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { characterRoster, scenePairFromActive } from "../views/lookups";

// Phase 4g — Sync characters/groups from dev note prose. Scans the active dev
// note's prose (excluding frontmatter) for word-boundary mentions of any name
// in the project roster — canonical character names, aliases, and group names —
// and appends matches to the dev note's characters: frontmatter array.
//
// Mirrors the inverse direction of sync-sluglines (dev note → fountain) and
// the sibling fountain-cue sync. Manual on-demand command — does NOT scan
// continuously.

export async function runSyncCharactersFromProseCommand(
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
	const pair = scenePairFromActive(plugin.app, active, project, cfg);
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

	const devNoteText = await plugin.app.vault.read(pair.devNoteFile);
	const prose = stripFrontmatter(devNoteText);

	// Collect candidate names with the casing to store on match. Canonical
	// entries store folder name; aliases store their declared casing; groups
	// store the folder name. Sort longest-first so multi-word matches win
	// over single-word substrings ("Big G" before "G").
	const roster = characterRoster(plugin.app, project, cfg);
	type Candidate = { name: string; casing: string };
	const candidates: Candidate[] = [];
	for (const entry of roster) {
		candidates.push({ name: entry.folderName, casing: entry.folderName });
		for (const alias of entry.aliases) {
			const trimmed = alias.trim();
			if (trimmed === "") continue;
			candidates.push({ name: trimmed, casing: trimmed });
		}
	}
	candidates.sort((a, b) => b.name.length - a.name.length);

	const matched = new Map<string, string>(); // upper(casing) → casing
	for (const c of candidates) {
		const re = new RegExp(`\\b${escapeRegex(c.name)}\\b`, "i");
		if (re.test(prose)) {
			matched.set(c.casing.toUpperCase(), c.casing);
		}
	}

	if (matched.size === 0) {
		new Notice("No roster names mentioned in this dev note's prose.");
		return;
	}

	const result = await appendMissing(plugin, pair.devNoteFile, [...matched.values()]);
	new Notice(
		`Added ${result.added} character${result.added === 1 ? "" : "s"} to dev note.`,
	);
}

function stripFrontmatter(text: string): string {
	if (!text.startsWith("---\n")) return text;
	const end = text.indexOf("\n---", 4);
	if (end === -1) return text;
	return text.slice(end + 4);
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function appendMissing(
	plugin: FirstDraftPlugin,
	devNote: TFile,
	candidates: string[],
): Promise<{ added: number }> {
	let added = 0;
	await plugin.app.fileManager.processFrontMatter(
		devNote,
		(fm: Record<string, unknown>) => {
			const existing = Array.isArray(fm.characters)
				? (fm.characters as unknown[]).filter((v): v is string => typeof v === "string")
				: [];
			const existingUpper = new Set(existing.map((s) => s.toUpperCase()));
			for (const name of candidates) {
				if (existingUpper.has(name.toUpperCase())) continue;
				existing.push(name);
				existingUpper.add(name.toUpperCase());
				added += 1;
			}
			if (added > 0) fm.characters = existing;
		},
	);
	return { added };
}
