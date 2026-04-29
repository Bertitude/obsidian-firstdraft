import { Notice, TFile, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { promptForLabel } from "../versioning/prompt";
import {
	isFountainFile,
	fountainSceneName,
	fountainSceneNameFromPath,
	fountainFilename,
	fountainScenesArrayEntry,
} from "../fountain/file-detection";
import { readScenesArray, writeScenesArray } from "../longform/scenes-array";
import { resolveProjectSettings } from "../settings/resolve";
import { applyId, extractId } from "../utils/stable-id";

// Paths that we ourselves just initiated a rename to. Events for these are
// skipped to prevent ping-pong loops (we rename dev note → that fires another
// 'rename' event → we'd otherwise try to sync it back).
const inFlight = new Set<string>();

export function installRenameSync(plugin: FirstDraftPlugin): void {
	plugin.registerEvent(
		plugin.app.vault.on("rename", (file, oldPath) => {
			if (!(file instanceof TFile)) return;
			if (inFlight.has(file.path)) return;
			void routeRename(plugin, file, oldPath);
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on("create", (file) => {
			if (!(file instanceof TFile)) return;
			if (!isFountainFile(file)) return;
			void handleFountainCreate(plugin, file);
		}),
	);
}

// ── routing ──────────────────────────────────────────────────────────────

async function routeRename(
	plugin: FirstDraftPlugin,
	file: TFile,
	oldPath: string,
): Promise<void> {
	const oldProject = projectFromPath(plugin, oldPath);
	const newProject = projectFromPath(plugin, file.path);

	if (isFountainFile(file)) {
		const wasInScreen =
			oldProject !== null && oldPath.startsWith(oldProject.sceneFolderPath + "/");
		const isInScreen =
			newProject !== null && file.path.startsWith(newProject.sceneFolderPath + "/");

		if (wasInScreen && isInScreen && oldProject === newProject && oldProject !== null) {
			await syncFountainRename(plugin, oldProject, oldPath, file);
		} else if (!wasInScreen && isInScreen && newProject !== null) {
			await injectFountainIntoScenes(plugin, newProject, file);
		}
		// Cross-project moves and moves-out: no-op for v1.
		return;
	}

	if (
		file.extension === "md" &&
		oldProject !== null &&
		newProject !== null &&
		oldProject === newProject
	) {
		const devFolder = devScenesFolderFor(plugin, oldProject);
		const wasInDev = oldPath.startsWith(devFolder + "/");
		const isInDev = file.path.startsWith(devFolder + "/");
		if (wasInDev && isInDev) {
			await syncDevNoteRename(plugin, oldProject, oldPath, file);
		}
	}
}

// ── fountain rename → sync dev note ──────────────────────────────────────

async function syncFountainRename(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	oldPath: string,
	newFile: TFile,
): Promise<void> {
	const oldSceneName = fountainSceneNameFromPath(oldPath);
	let newSceneName = fountainSceneName(newFile);
	if (oldSceneName === newSceneName) return;

	// Stable ID preservation: if the old name had a `-a3b9` suffix and the
	// user-typed new name doesn't, silently re-rename to keep the ID. This
	// makes IDs invisible to the user during normal renames.
	const oldId = extractId(oldSceneName);
	const newId = extractId(newSceneName);
	if (oldId && !newId) {
		const restoredName = applyId(newSceneName, oldId);
		const ext = newFile.extension === "fountain" ? "fountain" : "fountain.md";
		const folder = newFile.parent?.path ?? "";
		const restoredPath = normalizePath(`${folder}/${restoredName}.${ext}`);
		await safeRename(plugin, newFile, restoredPath);
		newSceneName = restoredName;
	}

	const devFolder = devScenesFolderFor(plugin, project);
	const oldDevPath = normalizePath(`${devFolder}/${oldSceneName}.md`);
	const newDevPath = normalizePath(`${devFolder}/${newSceneName}.md`);

	const oldDev = plugin.app.vault.getAbstractFileByPath(oldDevPath);
	if (!(oldDev instanceof TFile)) {
		// No paired dev note. Just refresh the scenes array entry.
		await updateScenesEntry(plugin, project, oldSceneName, newSceneName);
		return;
	}

	const conflict = plugin.app.vault.getAbstractFileByPath(newDevPath);
	if (conflict) {
		const resolved = await resolveConflict(
			plugin,
			project,
			`A dev note "${newSceneName}.md" already exists. Pick a new name (this will rename both the fountain and dev note):`,
			`${newSceneName}-${randomSuffix()}`,
			new Set([newFile.path, oldDevPath]),
		);
		if (resolved === null) {
			new Notice(
				`Pairing broken — "${newSceneName}.md" already existed. Dev note kept old name. Resolve manually.`,
			);
			return;
		}
		await renameToResolved(plugin, project, newFile, oldDev, oldSceneName, resolved);
		return;
	}

	await safeRename(plugin, oldDev, newDevPath);
	await updateScenesEntry(plugin, project, oldSceneName, newSceneName);
}

// ── dev note rename → sync fountain ──────────────────────────────────────

async function syncDevNoteRename(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	oldPath: string,
	newFile: TFile,
): Promise<void> {
	const oldSceneName = baseFromMd(oldPath);
	let newSceneName = newFile.basename;
	if (oldSceneName === newSceneName) return;

	// Stable ID preservation (mirrors the fountain side): re-attach the old
	// ID if the user dropped it on rename.
	const oldId = extractId(oldSceneName);
	const newId = extractId(newSceneName);
	if (oldId && !newId) {
		const restoredName = applyId(newSceneName, oldId);
		const folder = newFile.parent?.path ?? "";
		const restoredPath = normalizePath(`${folder}/${restoredName}.md`);
		await safeRename(plugin, newFile, restoredPath);
		newSceneName = restoredName;
	}

	// Look for the paired fountain in either format.
	const oldFountain = findFountain(plugin, project, oldSceneName);
	if (!oldFountain) {
		await updateScenesEntry(plugin, project, oldSceneName, newSceneName);
		return;
	}

	// Preserve the file's existing format on rename rather than forcing global default.
	const formatOfExisting =
		oldFountain.extension === "fountain" ? "fountain" : "fountain-md";
	const newFountainPath = normalizePath(
		`${project.sceneFolderPath}/${fountainFilename(newSceneName, formatOfExisting)}`,
	);

	const conflict = plugin.app.vault.getAbstractFileByPath(newFountainPath);
	if (conflict) {
		const resolved = await resolveConflict(
			plugin,
			project,
			`A fountain "${fountainFilename(newSceneName, formatOfExisting)}" already exists. Pick a new name (this will rename both the dev note and fountain):`,
			`${newSceneName}-${randomSuffix()}`,
			new Set([newFile.path, oldFountain.path]),
		);
		if (resolved === null) {
			new Notice(
				`Pairing broken — fountain "${fountainFilename(newSceneName, formatOfExisting)}" already existed. Fountain kept old name. Resolve manually.`,
			);
			return;
		}
		await renameToResolved(plugin, project, newFile, oldFountain, oldSceneName, resolved);
		return;
	}

	await safeRename(plugin, oldFountain, newFountainPath);
	await updateScenesEntry(plugin, project, oldSceneName, newSceneName);
}

// ── conflict resolution ──────────────────────────────────────────────────

async function resolveConflict(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	initialDescription: string,
	initialDefault: string,
	excludePaths: Set<string>,
): Promise<string | null> {
	let description = initialDescription;
	let candidate = initialDefault;

	while (true) {
		const name = await promptForLabel(plugin.app, {
			title: "Resolve naming conflict",
			description,
			defaultValue: candidate,
		});
		if (name === null) return null;

		if (nameAvailable(plugin, project, name, excludePaths)) return name;

		candidate = `${name}-${randomSuffix()}`;
		description = `"${name}" is also taken. Try another name.`;
	}
}

function nameAvailable(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	name: string,
	excludePaths: Set<string>,
): boolean {
	const devFolder = devScenesFolderFor(plugin, project);
	const fountainMd = normalizePath(
		`${project.sceneFolderPath}/${fountainFilename(name, "fountain-md")}`,
	);
	const fountainBare = normalizePath(
		`${project.sceneFolderPath}/${fountainFilename(name, "fountain")}`,
	);
	const dev = normalizePath(`${devFolder}/${name}.md`);

	for (const p of [fountainMd, fountainBare, dev]) {
		const hit = plugin.app.vault.getAbstractFileByPath(p);
		if (hit && !excludePaths.has(hit.path)) return false;
	}
	return true;
}

async function renameToResolved(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	justRenamedFile: TFile,
	pairedFile: TFile,
	originalSceneName: string,
	resolvedName: string,
): Promise<void> {
	const devFolder = devScenesFolderFor(plugin, project);

	const justRenamedIsFountain = isFountainFile(justRenamedFile);
	const fountainFile = justRenamedIsFountain ? justRenamedFile : pairedFile;
	const devFile = justRenamedIsFountain ? pairedFile : justRenamedFile;

	const formatOfFountain = fountainFile.extension === "fountain" ? "fountain" : "fountain-md";
	const targetFountainPath = normalizePath(
		`${project.sceneFolderPath}/${fountainFilename(resolvedName, formatOfFountain)}`,
	);
	const targetDevPath = normalizePath(`${devFolder}/${resolvedName}.md`);

	await safeRename(plugin, fountainFile, targetFountainPath);
	await safeRename(plugin, devFile, targetDevPath);
	await updateScenesEntry(plugin, project, originalSceneName, resolvedName);
	new Notice(`Renamed both files to "${resolvedName}".`);
}

// ── auto-inject into Longform scenes: ───────────────────────────────────

async function handleFountainCreate(plugin: FirstDraftPlugin, file: TFile): Promise<void> {
	const project = projectFromPath(plugin, file.path);
	if (!project) return;
	if (!file.path.startsWith(project.sceneFolderPath + "/")) return;
	await injectFountainIntoScenes(plugin, project, file);
}

async function injectFountainIntoScenes(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	file: TFile,
): Promise<void> {
	const entry = file.basename;
	const existing = readScenesArray(plugin.app, project.indexFilePath);
	if (existing.includes(entry)) return;
	try {
		await writeScenesArray(plugin.app, project.indexFilePath, [...existing, entry]);
	} catch (e) {
		new Notice(`Could not auto-add to project: ${(e as Error).message}`);
	}
}

async function updateScenesEntry(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	oldSceneName: string,
	newSceneName: string,
): Promise<void> {
	const cfg = plugin.settings.global;
	const oldEntry = fountainScenesArrayEntry(oldSceneName, cfg.fountainFileFormat);
	const newEntry = fountainScenesArrayEntry(newSceneName, cfg.fountainFileFormat);
	const altOldEntry = fountainScenesArrayEntry(
		oldSceneName,
		cfg.fountainFileFormat === "fountain" ? "fountain-md" : "fountain",
	);

	const existing = readScenesArray(plugin.app, project.indexFilePath);
	const next = existing.map((e) => (e === oldEntry || e === altOldEntry ? newEntry : e));
	if (next.every((e, i) => e === existing[i])) return;
	try {
		await writeScenesArray(plugin.app, project.indexFilePath, next);
	} catch (e) {
		new Notice(`Could not update project scenes: ${(e as Error).message}`);
	}
}

// ── helpers ──────────────────────────────────────────────────────────────

function projectFromPath(plugin: FirstDraftPlugin, path: string): ProjectMeta | null {
	let best: ProjectMeta | null = null;
	for (const meta of plugin.scanner.projects.values()) {
		if (path === meta.indexFilePath) return meta;
		const prefix = meta.projectRootPath + "/";
		if (path.startsWith(prefix)) {
			if (!best || meta.projectRootPath.length > best.projectRootPath.length) {
				best = meta;
			}
		}
	}
	return best;
}

function devScenesFolderFor(plugin: FirstDraftPlugin, project: ProjectMeta): string {
	const cfg = resolveProjectSettings(project, plugin.settings);
	return normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.scenesSubfolder}`,
	);
}

function findFountain(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	sceneName: string,
): TFile | null {
	for (const fmt of ["fountain-md", "fountain"] as const) {
		const path = normalizePath(`${project.sceneFolderPath}/${fountainFilename(sceneName, fmt)}`);
		const hit = plugin.app.vault.getAbstractFileByPath(path);
		if (hit instanceof TFile) return hit;
	}
	return null;
}

function baseFromMd(path: string): string {
	const filename = path.split("/").pop() ?? path;
	return filename.endsWith(".md") ? filename.slice(0, -".md".length) : filename;
}

function randomSuffix(): string {
	return Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
}

async function safeRename(
	plugin: FirstDraftPlugin,
	file: TFile,
	newPath: string,
): Promise<void> {
	inFlight.add(newPath);
	try {
		await plugin.app.fileManager.renameFile(file, newPath);
	} finally {
		queueMicrotask(() => inFlight.delete(newPath));
	}
}
