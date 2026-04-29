import { App, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveProjectSettings } from "../settings/resolve";

// Episode-specific character notes — the per-episode counterpart to the
// canonical character file at series level. Lives at:
//
//   <Episode>/<developmentFolder>/<charactersSubfolder>/<Name>.md
//
// Note the SHAPE: directly inside the Characters folder, NOT in a folder-
// per-entity sub-tree like the canonical (`<Series>/Development/Characters/
// Antonia/Antonia.md`). The episode note is a file, not an entity. The
// roster builder ignores it (it walks folder children, not direct files),
// so episode notes don't pollute character-roster, autolinkify candidates,
// or the picker — they're surfaced only via Obsidian's path-proximity
// wikilink resolution and any future episode-notes UI surface.
//
// Auto-created whenever a character is "added to an episode" — currently
// hooked from the dev-note characters: array writers in insert-cue.ts,
// character-suggest.ts, and the create-character modal. Idempotent: if the
// file already exists, returns it unchanged. No-op for non-episode projects.
//
// TODO(v2): same-filename gotcha with Quick Switcher — both the canonical
// and the episode note appear when typing the character name. Mitigation:
// set a frontmatter `aliases:` field on the canonical (e.g. "Antonia
// (canonical)") so QS can disambiguate. Defer until users report friction.

export async function ensureEpisodeCharacterNote(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	characterName: string,
): Promise<TFile | null> {
	if (project.projectType !== "tv-episode") return null;
	const cfg = resolveProjectSettings(project, plugin.settings);

	const folderPath = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.charactersSubfolder}`,
	);
	const filePath = normalizePath(`${folderPath}/${characterName}.md`);

	const existing = plugin.app.vault.getAbstractFileByPath(filePath);
	if (existing instanceof TFile) return existing;

	await ensureFolder(plugin.app, folderPath);
	const body = composeBody(characterName, project);
	try {
		return await plugin.app.vault.create(filePath, body);
	} catch (e) {
		// Race: another concurrent create finished first. Return the existing
		// file rather than failing the parent operation.
		const after = plugin.app.vault.getAbstractFileByPath(filePath);
		if (after instanceof TFile) return after;
		void e;
		return null;
	}
}

function composeBody(characterName: string, project: ProjectMeta): string {
	const episodeCode =
		project.episode && project.episode.trim() !== ""
			? project.episode.trim()
			: lastSegment(project.projectRootPath);
	return `---
type: episode-character-notes
character: ${characterName}
episode: ${episodeCode}
---

# ${characterName} — ${episodeCode}

## This episode
What's at stake for them in this episode. What changes.

## Beats

## Continuity flags

## Notes
`;
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

function lastSegment(path: string): string {
	return path.split("/").pop() ?? path;
}
