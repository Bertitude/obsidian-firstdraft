import { MarkdownRenderer, Notice, TFile, TFolder, setIcon, normalizePath } from "obsidian";
import type { Component } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { GlobalConfig, ProjectMeta } from "../types";
import {
	type CharacterEntry,
	type DevNoteRef,
	findCharacter,
	findLocation,
} from "./lookups";
import { readScenesArray, writeScenesArray } from "../longform/scenes-array";

// All DOM construction for the dev-notes panel. Pure helpers — they take a container
// and append; lifecycle (clearing) is the View's responsibility.

interface SectionOpts {
	container: HTMLElement;
	view: Component;
	plugin: FirstDraftPlugin;
}

// ── header ───────────────────────────────────────────────────────────────

export function renderHeader(
	container: HTMLElement,
	project: ProjectMeta,
	onSettings: () => void,
): void {
	const header = container.createDiv({ cls: "firstdraft-header" });
	const badge = header.createDiv({ cls: "firstdraft-badge" });
	badge.createSpan({ cls: "firstdraft-badge-dot" });
	const label = displayProject(project);
	badge.createSpan({ text: label, cls: "firstdraft-badge-label" });

	const cog = header.createEl("button", {
		cls: "firstdraft-cog clickable-icon",
		attr: { "aria-label": "Project settings" },
	});
	setIcon(cog, "settings");
	cog.addEventListener("click", (e) => {
		e.preventDefault();
		onSettings();
	});
}

function displayProject(p: ProjectMeta): string {
	if (p.projectType === "tv-episode") {
		const ep = p.episode ?? "";
		const t = p.title ?? p.indexFilePath;
		return ep ? `${p.series ?? ""} ${ep} — ${t}`.trim() : t;
	}
	return p.title ?? basenameOf(p.indexFilePath);
}

function basenameOf(path: string): string {
	const seg = path.split("/").pop() ?? path;
	return seg.replace(/\.md$/, "");
}

// ── empty state ──────────────────────────────────────────────────────────

export function renderEmptyState(
	container: HTMLElement,
	file: TFile | null,
	overrideMessage?: string,
): void {
	const wrap = container.createDiv({ cls: "firstdraft-empty" });
	const msg = overrideMessage
		? overrideMessage
		: !file
			? "Open a scene file to see its dev notes."
			: file.extension !== "fountain"
				? "FirstDraft only shows dev notes for .fountain scene files."
				: "No project detected for this file.";
	wrap.createEl("p", { text: msg });
}

// ── scene section ────────────────────────────────────────────────────────

interface SceneSectionOpts extends SectionOpts {
	scene: TFile;
	noteRef: DevNoteRef;
	template: string;
}

export async function renderSceneSection(opts: SceneSectionOpts): Promise<void> {
	const { container, view, plugin, scene, noteRef, template } = opts;

	container.createEl("h3", { text: scene.basename, cls: "firstdraft-scene-title" });
	container.createEl("hr", { cls: "firstdraft-divider" });

	const body = container.createDiv({ cls: "firstdraft-scene-body" });

	if (!noteRef.file) {
		const empty = body.createDiv({ cls: "firstdraft-create-prompt" });
		empty.createEl("p", { text: "No dev note for this scene yet." });
		const btn = empty.createEl("button", {
			text: "Create scene note",
			cls: "mod-cta",
		});
		btn.addEventListener("click", () => {
			if (btn.disabled) return;
			btn.disabled = true;
			btn.setText("Creating…");
			void createSceneNote(plugin, noteRef.path, template);
		});
		return;
	}

	const md = await plugin.app.vault.cachedRead(noteRef.file);
	await MarkdownRenderer.render(plugin.app, md, body, noteRef.file.path, view);
}

async function createSceneNote(
	plugin: FirstDraftPlugin,
	path: string,
	template: string,
): Promise<void> {
	try {
		await ensureFolderExists(plugin, parentPath(path));
		const created = await plugin.app.vault.create(path, template);
		await plugin.app.workspace.getLeaf(false).openFile(created);
		new Notice("Scene note created.");
	} catch (e) {
		new Notice(`Could not create scene note: ${(e as Error).message}`);
	}
}

// ── fountain section (rendered when a dev note is the active file) ───────

interface FountainSectionOpts extends SectionOpts {
	devNote: TFile;
	fountainPath: string;
	fountainFile: TFile | null;
	project: ProjectMeta;
}

export function renderFountainSection(opts: FountainSectionOpts): void {
	const { container, plugin, devNote, fountainFile, project } = opts;

	container.createEl("h3", { text: devNote.basename, cls: "firstdraft-scene-title" });
	container.createEl("hr", { cls: "firstdraft-divider" });

	const body = container.createDiv({ cls: "firstdraft-scene-body" });
	const wrap = body.createDiv({ cls: "firstdraft-create-prompt" });

	if (fountainFile) {
		wrap.createEl("p", { text: "Scene file ready." });
		const link = wrap.createEl("a", {
			text: "Open scene file →",
			cls: "firstdraft-card-open",
			attr: { href: "#" },
		});
		link.addEventListener("click", (e) => {
			e.preventDefault();
			void plugin.app.workspace.getLeaf(false).openFile(fountainFile);
		});
		return;
	}

	wrap.createEl("p", { text: "No scene file yet. Outline here, draft when ready." });
	const btn = wrap.createEl("button", {
		text: "Create scene file",
		cls: "mod-cta",
	});
	btn.addEventListener("click", () => {
		if (btn.disabled) return;
		btn.disabled = true;
		btn.setText("Creating…");
		void createSceneFile(plugin, project, devNote.basename);
	});
}

const DEFAULT_SCENE_FOLDER_NAME = "Screenplay";

// Creates the fountain file for a scene. If the project's Longform sceneFolder
// is empty or pointing at the project root, this also: (a) updates Index.md to
// set sceneFolder = "Screenplay", (b) creates the Screenplay/ folder. Always
// appends the new file to the longform.scenes array so it shows up in
// Longform's sidebar without manual drag-and-drop.
async function createSceneFile(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	sceneName: string,
): Promise<void> {
	try {
		const { fountainPath, configChanged } = await ensureSceneFolder(plugin, project);
		const finalPath = normalizePath(`${fountainPath}/${sceneName}.fountain`);

		if (plugin.app.vault.getAbstractFileByPath(finalPath)) {
			new Notice("Scene file already exists.");
			return;
		}

		const created = await plugin.app.vault.create(finalPath, "");

		// Append to Longform's scenes array if not already present.
		const scenes = readScenesArray(plugin.app, project.indexFilePath);
		if (!scenes.includes(sceneName)) {
			scenes.push(sceneName);
			await writeScenesArray(plugin.app, project.indexFilePath, scenes);
		}

		await plugin.app.workspace.getLeaf(false).openFile(created);

		new Notice(
			configChanged
				? `Created ${DEFAULT_SCENE_FOLDER_NAME}/ folder and added scene to project.`
				: "Scene file created and added to project.",
		);
	} catch (e) {
		new Notice(`Could not create scene file: ${(e as Error).message}`);
	}
}

interface SceneFolderEnsured {
	fountainPath: string;
	configChanged: boolean;
}

async function ensureSceneFolder(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
): Promise<SceneFolderEnsured> {
	const projectRoot = project.projectRootPath;
	const currentScenePath = project.sceneFolderPath;
	const sceneFolderIsRoot = currentScenePath === projectRoot;

	if (!sceneFolderIsRoot) {
		await ensureFolderExists(plugin, currentScenePath);
		return { fountainPath: currentScenePath, configChanged: false };
	}

	// sceneFolder is empty / pointing at the root — set it to "Screenplay" and
	// create that folder.
	const newPath = normalizePath(`${projectRoot}/${DEFAULT_SCENE_FOLDER_NAME}`);
	await ensureFolderExists(plugin, newPath);

	const indexFile = plugin.app.vault.getAbstractFileByPath(project.indexFilePath);
	if (indexFile instanceof TFile) {
		await plugin.app.fileManager.processFrontMatter(indexFile, (fm: Record<string, unknown>) => {
			const longform = (fm.longform as Record<string, unknown> | undefined) ?? {};
			longform.sceneFolder = DEFAULT_SCENE_FOLDER_NAME;
			fm.longform = longform;
		});
	}
	return { fountainPath: newPath, configChanged: true };
}

async function ensureFolderExists(plugin: FirstDraftPlugin, folderPath: string): Promise<void> {
	if (!folderPath) return;
	const existing = plugin.app.vault.getAbstractFileByPath(folderPath);
	if (existing instanceof TFolder) return;
	if (existing) throw new Error(`Path exists but is not a folder: ${folderPath}`);
	await plugin.app.vault.createFolder(folderPath);
}

function parentPath(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.substring(0, i);
}

// ── characters section ───────────────────────────────────────────────────

interface CharactersSectionOpts extends SectionOpts {
	characterNames: string[];
	roster: CharacterEntry[];
}

export function renderCharactersSection(opts: CharactersSectionOpts): void {
	const { container, plugin, characterNames, roster } = opts;
	if (characterNames.length === 0) return;

	container.createEl("h4", { text: "Characters", cls: "firstdraft-section-title" });
	const list = container.createDiv({ cls: "firstdraft-cards" });

	const fields = plugin.settings.global.characterCardFields;
	const byName = new Map(roster.map((e) => [e.name.toUpperCase(), e]));

	for (const name of characterNames) {
		const entry = byName.get(name.toUpperCase()) ?? null;
		renderCharacterCard(list, plugin, name, entry, fields);
	}
}

function renderCharacterCard(
	parent: HTMLElement,
	plugin: FirstDraftPlugin,
	name: string,
	entry: CharacterEntry | null,
	fields: string[],
): void {
	const card = parent.createEl("details", { cls: "firstdraft-card" });
	card.createEl("summary", { text: name.toUpperCase(), cls: "firstdraft-card-summary" });
	const body = card.createDiv({ cls: "firstdraft-card-body" });

	if (!entry || !entry.canonicalFile) {
		body.createEl("p", {
			text: "No character note found.",
			cls: "firstdraft-card-missing",
		});
		return;
	}

	const fm = plugin.app.metadataCache.getFileCache(entry.canonicalFile)?.frontmatter ?? {};
	renderFieldList(body, fm as Record<string, unknown>, fields);
	renderOpenLink(body, plugin, entry.canonicalFile);
}

// ── location section ─────────────────────────────────────────────────────

interface LocationSectionOpts extends SectionOpts {
	project: ProjectMeta;
	cfg: GlobalConfig;
	locationNames: string[];
}

export function renderLocationSection(opts: LocationSectionOpts): void {
	const { container, plugin, project, cfg, locationNames } = opts;
	if (locationNames.length === 0) return;

	const heading = locationNames.length === 1 ? "Location" : "Locations";
	container.createEl("h4", { text: heading, cls: "firstdraft-section-title" });
	const list = container.createDiv({ cls: "firstdraft-cards" });

	const seen = new Set<string>();
	for (const name of locationNames) {
		const key = name.toUpperCase();
		if (seen.has(key)) continue;
		seen.add(key);
		renderLocationCard(list, plugin, project, cfg, name);
	}
}

function renderLocationCard(
	parent: HTMLElement,
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	cfg: GlobalConfig,
	name: string,
): void {
	const entry = findLocation(plugin.app, project, cfg, name);
	const card = parent.createEl("details", { cls: "firstdraft-card" });
	card.createEl("summary", { text: name, cls: "firstdraft-card-summary" });
	const body = card.createDiv({ cls: "firstdraft-card-body" });

	if (!entry || !entry.canonicalFile) {
		body.createEl("p", {
			text: "No location note found.",
			cls: "firstdraft-card-missing",
		});
		return;
	}
	const fm = plugin.app.metadataCache.getFileCache(entry.canonicalFile)?.frontmatter ?? {};
	// Locations don't have a configured field allowlist yet — show the full frontmatter
	// minus internal keys. (Phase 5 could add a `locationCardFields` setting.)
	const fields = Object.keys(fm).filter((k) => k !== "position");
	renderFieldList(body, fm as Record<string, unknown>, fields);
	renderOpenLink(body, plugin, entry.canonicalFile);
}

// Suppress unused warning for findCharacter — exposed via lookups but used by Phase 3.
void findCharacter;
void normalizePath;

// ── shared card pieces ───────────────────────────────────────────────────

function renderFieldList(
	parent: HTMLElement,
	fm: Record<string, unknown>,
	fields: string[],
): void {
	const visible = fields.filter((f) => fm[f] !== undefined && fm[f] !== null && fm[f] !== "");
	if (visible.length === 0) {
		parent.createEl("p", {
			text: "No matching frontmatter fields.",
			cls: "firstdraft-card-missing",
		});
		return;
	}
	const dl = parent.createEl("dl", { cls: "firstdraft-card-fields" });
	for (const f of visible) {
		dl.createEl("dt", { text: f });
		dl.createEl("dd", { text: stringifyField(fm[f]) });
	}
}

function stringifyField(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (Array.isArray(v)) return v.map((item) => stringifyField(item)).join(", ");
	if (typeof v === "object") return JSON.stringify(v);
	return String(v as string | number | boolean);
}

function renderOpenLink(parent: HTMLElement, plugin: FirstDraftPlugin, file: TFile): void {
	const link = parent.createEl("a", {
		text: "Open full note →",
		cls: "firstdraft-card-open",
		attr: { href: "#" },
	});
	link.addEventListener("click", (e) => {
		e.preventDefault();
		void plugin.app.workspace.getLeaf(false).openFile(file);
	});
}
