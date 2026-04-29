import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { GlobalConfig, ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import {
	devNotePathCandidates,
	fountainPathCandidates,
	fountainSceneName,
	isFountainFile,
} from "../fountain/file-detection";
import { snapshotFile, todayLabel } from "../versioning/snapshot";

// "Update sequence from scenes" — the reverse of atomize. Reads each scene
// fountain in the sequence's Scenes/ folder (in scene_order order, skipping
// orphans), concatenates, prepends the master's pre-first-slugline intro
// (title page / opening action), and overwrites the master fountain.
//
// Mirrors the dev note side: reassembles each scene dev note's "## Scene
// Overview" section as an H2 block in the master dev note, keyed by slugline
// (matches the H2 sections created by the inverse "atomize" flow).
//
// Snapshots master fountain + dev note before the rewrite (label
// "pre-update YYYY-MM-DD") so a restore is always available.

const SLUGLINE_RE = /^(INT|EXT|INT\.?\s*\/\s*EXT|I\s*\/\s*E)[.\s]/i;
const FORCED_SLUGLINE_RE = /^\.[^.]/;

interface SceneRecord {
	devFile: TFile;
	fountainFile: TFile | null;
	scene_order: number;
	slugline: string;
	slugline_key: string;
	orphan: boolean;
}

export async function runUpdateSequenceCommand(plugin: FirstDraftPlugin): Promise<void> {
	const active = plugin.app.workspace.getActiveFile();
	if (!active) {
		new Notice("Open a sequence's master file or one of its scenes first.");
		return;
	}
	const project = resolveActiveProject(active, plugin.scanner);
	if (!project) {
		new Notice("Active file isn't inside a recognised project.");
		return;
	}
	const cfg = resolveProjectSettings(project, plugin.settings);

	const resolved = resolveSequenceFromActive(plugin.app, active, project, cfg);
	if (!resolved) {
		new Notice("Couldn't resolve a sequence from the active file.");
		return;
	}
	const { masterFountain, masterDevNote, fountainScenesFolder, devScenesFolder } = resolved;

	const scenes = collectScenes(plugin.app, devScenesFolder, fountainScenesFolder);
	if (scenes.length === 0) {
		new Notice("No atomized scenes found for this sequence — nothing to update from.");
		return;
	}

	// Skip orphans. They live in the folder but don't belong to the master
	// anymore (slugline removed during a previous diff-aware atomize).
	const ordered = scenes
		.filter((s) => !s.orphan)
		.sort((a, b) => a.scene_order - b.scene_order);
	if (ordered.length === 0) {
		new Notice("All scenes are orphaned — nothing to reassemble.");
		return;
	}

	// Snapshot before rewrite.
	await snapshotFile(plugin.app, masterFountain, `pre-update ${todayLabel()}`);
	if (masterDevNote) {
		await snapshotFile(plugin.app, masterDevNote, `pre-update ${todayLabel()}`);
	}

	// Reassemble fountain: master intro (everything before the first slugline)
	// + each scene's content in order, separated by blank lines for readability.
	const masterContent = await plugin.app.vault.read(masterFountain);
	const intro = extractIntro(masterContent);
	const sceneContents: string[] = [];
	for (const scene of ordered) {
		if (!scene.fountainFile) continue;
		const text = await plugin.app.vault.read(scene.fountainFile);
		sceneContents.push(text.trim());
	}
	const reassembled = composeFountain(intro, sceneContents);
	await plugin.app.vault.modify(masterFountain, reassembled);

	// Reassemble dev note H2 sections from each scene's Scene Overview.
	if (masterDevNote) {
		const devText = await plugin.app.vault.read(masterDevNote);
		const sceneOverviews = new Map<string, string>();
		for (const scene of ordered) {
			const text = await plugin.app.vault.read(scene.devFile);
			const overview = extractSceneOverview(text);
			sceneOverviews.set(scene.slugline_key, overview);
		}
		const reassembledDev = mergeDevNoteH2Sections(devText, ordered, sceneOverviews);
		await plugin.app.vault.modify(masterDevNote, reassembledDev);
	}

	const orphanCount = scenes.length - ordered.length;
	const orphanNote = orphanCount > 0 ? ` (${orphanCount} orphan${orphanCount === 1 ? "" : "s"} skipped)` : "";
	new Notice(`Updated sequence from ${ordered.length} scene${ordered.length === 1 ? "" : "s"}${orphanNote}.`);

	void plugin.app.workspace.getLeaf(false).openFile(masterFountain);
}

// ── resolve master + scenes folder from the active file ─────────────────

interface Resolved {
	masterFountain: TFile;
	masterDevNote: TFile | null;
	fountainScenesFolder: string;
	devScenesFolder: string;
}

function resolveSequenceFromActive(
	app: App,
	active: TFile,
	project: ProjectMeta,
	cfg: GlobalConfig,
): Resolved | null {
	// Three possibilities for `active`:
	//   1. The master fountain (folder shape: <Sequences>/<stem>/<stem>.fountain.md)
	//   2. The master dev note (<Development/Sequences>/<stem>/<stem>.md)
	//   3. A scene fountain or scene dev note inside the Scenes/ subfolder
	//
	// In all cases we walk up to the sequence's stem folder, then resolve both
	// sides from there.
	const stem = inferStem(active, project, cfg);
	if (!stem) return null;

	const fountainCandidates = fountainPathCandidates(project.sequenceFolderPath, stem)
		.map((p) => normalizePath(p));
	const masterFountain = firstExistingFile(app, fountainCandidates);
	if (!masterFountain) return null;

	const devFolder = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.sequencesSubfolder}`,
	);
	const devCandidates = devNotePathCandidates(devFolder, stem).map((p) => normalizePath(p));
	const masterDevNote = firstExistingFile(app, devCandidates);

	const fountainScenesFolder = normalizePath(`${project.sequenceFolderPath}/${stem}/Scenes`);
	const devScenesFolder = normalizePath(`${devFolder}/${stem}/Scenes`);

	return { masterFountain, masterDevNote, fountainScenesFolder, devScenesFolder };
}

function inferStem(active: TFile, project: ProjectMeta, cfg: GlobalConfig): string | null {
	const fountainRoot = project.sequenceFolderPath;
	const devRoot = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.sequencesSubfolder}`,
	);

	// Active file under the fountain side
	if (active.path.startsWith(fountainRoot + "/")) {
		const tail = active.path.slice(fountainRoot.length + 1);
		const segments = tail.split("/");
		if (segments.length === 1 && isFountainFile(active)) {
			// Flat master: <fountainRoot>/<stem>.fountain[.md]
			return fountainSceneName(active);
		}
		// Folder shape: <fountainRoot>/<stem>/...
		// Could be the master itself (<stem>/<stem>.fountain.md) or a scene
		// (<stem>/Scenes/<scene>.fountain.md). The first segment is always the
		// sequence stem.
		return segments[0] ?? null;
	}

	// Active file under the dev side
	if (active.path.startsWith(devRoot + "/")) {
		const tail = active.path.slice(devRoot.length + 1);
		const segments = tail.split("/");
		if (segments.length === 1) {
			// Flat dev note: <devRoot>/<stem>.md
			return active.basename;
		}
		// Folder shape: <devRoot>/<stem>/...
		return segments[0] ?? null;
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

// ── scene collection ────────────────────────────────────────────────────

function collectScenes(
	app: App,
	devScenesFolder: string,
	fountainScenesFolder: string,
): SceneRecord[] {
	const out: SceneRecord[] = [];
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
		const slugline_key = typeof fm?.slugline_key === "string" ? fm.slugline_key.trim() : "";
		if (slugline_key === "") continue;
		out.push({
			devFile: child,
			fountainFile: fountainsByBase.get(child.basename) ?? null,
			scene_order: typeof fm?.scene_order === "number" ? fm.scene_order : 0,
			slugline: typeof fm?.slugline === "string" ? fm.slugline : "",
			slugline_key,
			orphan: fm?.orphan === true,
		});
	}
	return out;
}

// ── reassembly helpers ──────────────────────────────────────────────────

function extractIntro(masterContent: string): string {
	// Everything before the first slugline. Preserves title page, opening
	// action, etc. Trailing whitespace trimmed so the join produces clean
	// blank-line separation.
	const lines = masterContent.split(/\r?\n/);
	const introLines: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (
			trimmed !== "" &&
			(SLUGLINE_RE.test(trimmed) || FORCED_SLUGLINE_RE.test(trimmed))
		) {
			break;
		}
		introLines.push(line);
	}
	return introLines.join("\n").trimEnd();
}

function composeFountain(intro: string, sceneContents: string[]): string {
	const parts: string[] = [];
	if (intro.trim() !== "") parts.push(intro);
	for (const scene of sceneContents) {
		if (scene.trim() !== "") parts.push(scene);
	}
	return parts.join("\n\n") + "\n";
}

function extractSceneOverview(devText: string): string {
	// Pull the prose between "## Scene Overview" and the next H2. Returns
	// trimmed content; empty string if the section is missing.
	const m = /^##\s+Scene\s+Overview\s*$/im.exec(devText);
	if (!m) return "";
	const after = devText.slice(m.index + m[0].length);
	const nextH2 = /^##\s+/m.exec(after);
	const body = nextH2 ? after.slice(0, nextH2.index) : after;
	return body.trim();
}

function mergeDevNoteH2Sections(
	originalDevText: string,
	scenes: SceneRecord[],
	overviews: Map<string, string>,
): string {
	// Strategy: locate the existing slugline-shaped H2 sections in the
	// master dev note (created by atomize) and replace them with the
	// reassembled overviews. If a slugline section doesn't exist for a
	// scene, append it at the end.
	//
	// Non-slugline sections (## Notes, ## Continuity at the master level)
	// are preserved unchanged.
	const lines = originalDevText.split(/\r?\n/);
	const newLines: string[] = [];
	let skipUntilNextH2 = false;
	const handledKeys = new Set<string>();
	const occurrenceCount = new Map<string, number>();

	for (const line of lines) {
		const h2 = /^##\s+(.+?)\s*$/.exec(line);
		if (h2) {
			const heading = h2[1]!.trim();
			const isSlugline =
				SLUGLINE_RE.test(heading) || FORCED_SLUGLINE_RE.test(heading);
			if (isSlugline) {
				const slugline = heading.startsWith(".") ? heading.slice(1).trim() : heading;
				const seen = occurrenceCount.get(slugline) ?? 0;
				occurrenceCount.set(slugline, seen + 1);
				const key = `${slugline}:${seen}`;
				const overview = overviews.get(key);
				if (overview !== undefined) {
					handledKeys.add(key);
					newLines.push(`## ${heading}`);
					newLines.push("");
					if (overview.trim() !== "") {
						newLines.push(overview);
						newLines.push("");
					}
					skipUntilNextH2 = true;
					continue;
				}
				// Master has a slugline H2 that no scene maps to — preserve
				// it as-is. Useful when scenes were orphaned out and the
				// section still has historical notes.
				skipUntilNextH2 = false;
				newLines.push(line);
				continue;
			}
			// Non-slugline H2 — stop skipping.
			skipUntilNextH2 = false;
			newLines.push(line);
			continue;
		}
		if (!skipUntilNextH2) newLines.push(line);
	}

	// Append any new scenes whose slugline didn't have a matching H2 in the
	// master. These come from atomize-created sections that the user may
	// have deleted, or from scenes added via the user manually editing
	// (defensive — usually all scenes were created from H2 sections in
	// the first place).
	const missing = scenes.filter((s) => !handledKeys.has(s.slugline_key));
	if (missing.length > 0) {
		newLines.push("");
		for (const scene of missing) {
			newLines.push(`## ${scene.slugline}`);
			newLines.push("");
			const overview = overviews.get(scene.slugline_key) ?? "";
			if (overview.trim() !== "") {
				newLines.push(overview);
				newLines.push("");
			}
		}
	}

	return newLines.join("\n").trimEnd() + "\n";
}
