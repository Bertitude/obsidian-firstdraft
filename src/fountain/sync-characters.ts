import { Notice, TFile } from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { characterRoster, parseCharacterCues, scenePairFromActive } from "../views/lookups";

// Phase 4g — Sync characters from fountain to dev note. Scans the active scene's
// fountain file for character cues, filters by the project roster (so typos and
// stray caps lines don't land in characters:), and appends any missing canonical
// names or alias casings to the dev note's characters: frontmatter array.
//
// Mirrors the inverse direction provided by sync-sluglines.ts. Manual on-demand
// command — does NOT scan continuously or fire on save.

export async function runSyncCharactersCommand(plugin: FirstDraftPlugin): Promise<void> {
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
	if (!pair.fountainFile) {
		new Notice("No paired fountain file. Create one first.");
		return;
	}
	if (!pair.devNoteFile) {
		new Notice("No paired dev note. Create one first.");
		return;
	}

	const fountainText = await plugin.app.vault.read(pair.fountainFile);
	const cuesRaw = parseCharacterCues(fountainText);
	if (cuesRaw.length === 0) {
		new Notice("No character cues found in the fountain.");
		return;
	}

	// Build cue → casing-to-store lookup. Canonical entries store the folder
	// name; aliases store the alias text preserving its declared casing —
	// matches what the autocomplete picker writes today.
	const roster = characterRoster(plugin.app, project, cfg);
	const cueLookup = new Map<string, string>();
	for (const entry of roster) {
		cueLookup.set(entry.name, entry.folderName);
		for (const alias of entry.aliases) {
			const key = alias.trim().toUpperCase();
			if (key === "") continue;
			if (!cueLookup.has(key)) cueLookup.set(key, alias.trim());
		}
	}

	// Dedupe input cues by uppercase, then map each to its stored casing.
	const seenUpper = new Set<string>();
	const toAdd: string[] = [];
	const unresolved: string[] = [];
	for (const cue of cuesRaw) {
		const upper = cue.toUpperCase();
		if (seenUpper.has(upper)) continue;
		seenUpper.add(upper);
		const stored = cueLookup.get(upper);
		if (stored) toAdd.push(stored);
		else unresolved.push(cue);
	}

	if (toAdd.length === 0) {
		const tail =
			unresolved.length > 0
				? ` ${unresolved.length} cue(s) not matched to roster — add them via Create character or Tag selection as alias.`
				: "";
		new Notice(`No new characters to sync.${tail}`);
		return;
	}

	const result = await appendMissing(plugin, pair.devNoteFile, toAdd);
	const tail =
		unresolved.length > 0
			? ` ${unresolved.length} unresolved cue(s) skipped.`
			: "";
	new Notice(
		`Added ${result.added} character${result.added === 1 ? "" : "s"} to dev note.${tail}`,
	);
}

interface SyncResult {
	added: number;
}

async function appendMissing(
	plugin: FirstDraftPlugin,
	devNote: TFile,
	candidates: string[],
): Promise<SyncResult> {
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
