import { MarkdownRenderer, Notice, TFile, TFolder, setIcon, normalizePath } from "obsidian";
import type { Component } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { GlobalConfig, ProjectMeta } from "../types";
import {
	type CharacterEntry,
	type DevNoteRef,
	findCharacter,
	findLocation,
	resolveCharacterByNameOrAlias,
} from "./lookups";
import { readScenesArray, writeScenesArray } from "../longform/scenes-array";
import { fountainFilename, fountainScenesArrayEntry } from "../fountain/file-detection";
import { extractId, stripId } from "../utils/stable-id";
import { projectBlockKey } from "../projects/scanner";

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
	// mousedown instead of click — Obsidian's sidebar focus model swallows the
	// first click on inactive panels. mousedown fires before focus shifts.
	cog.addEventListener("mousedown", (e) => {
		if (e.button !== 0) return;
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
	// Thunk so the template is read fresh at click time. If we captured the
	// string at render, edits made via the project settings modal between
	// render and click would be missed (the panel doesn't re-render on settings
	// save).
	getTemplate: () => string;
}

export async function renderSceneSection(opts: SceneSectionOpts): Promise<void> {
	const { container, view, plugin, scene, noteRef, getTemplate } = opts;

	container.createEl("h3", { text: stripId(scene.basename), cls: "firstdraft-sequence-title" });
	container.createEl("hr", { cls: "firstdraft-divider" });

	const body = container.createDiv({ cls: "firstdraft-sequence-body" });

	if (!noteRef.file) {
		const empty = body.createDiv({ cls: "firstdraft-create-prompt" });
		empty.createEl("p", { text: "No dev note for this sequence yet." });
		const btn = empty.createEl("button", {
			text: "Create sequence note",
			cls: "mod-cta",
		});
		// mousedown instead of click — Obsidian's sidebar focus model swallows
		// the first click on inactive panels. mousedown fires before focus shifts.
		btn.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			if (btn.disabled) return;
			btn.disabled = true;
			btn.setText("Creating…");
			void createSequenceNote(plugin, noteRef.path, getTemplate());
		});
		return;
	}

	const md = await plugin.app.vault.cachedRead(noteRef.file);
	await MarkdownRenderer.render(plugin.app, md, body, noteRef.file.path, view);
}

async function createSequenceNote(
	plugin: FirstDraftPlugin,
	path: string,
	template: string,
): Promise<void> {
	try {
		await ensureFolderExists(plugin, parentPath(path));
		const created = await plugin.app.vault.create(path, template);
		// If the path inherits a stable ID from the paired fountain (e.g.
		// "Big Damn Heroes-a3b9.md"), mirror it into the dev note's
		// frontmatter so both sides agree.
		const stem = created.basename;
		const id = extractId(stem);
		if (id) {
			await plugin.app.fileManager.processFrontMatter(
				created,
				(fm: Record<string, unknown>) => {
					fm.id = id;
				},
			);
		}
		await plugin.app.workspace.getLeaf(false).openFile(created);
		new Notice("Sequence note created.");
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

	container.createEl("h3", { text: stripId(devNote.basename), cls: "firstdraft-sequence-title" });
	container.createEl("hr", { cls: "firstdraft-divider" });

	const body = container.createDiv({ cls: "firstdraft-sequence-body" });
	const wrap = body.createDiv({ cls: "firstdraft-create-prompt" });

	if (fountainFile) {
		wrap.createEl("p", { text: "Sequence file ready." });
		const link = wrap.createEl("a", {
			text: "Open sequence file →",
			cls: "firstdraft-card-open",
			attr: { href: "#" },
		});
		link.addEventListener("click", (e) => {
			e.preventDefault();
			void plugin.app.workspace.getLeaf(false).openFile(fountainFile);
		});
		return;
	}

	wrap.createEl("p", { text: "No sequence file yet. Plan here, draft when ready." });
	const btn = wrap.createEl("button", {
		text: "Create sequence file",
		cls: "mod-cta",
	});
	btn.addEventListener("mousedown", (e) => {
		if (e.button !== 0) return;
		if (btn.disabled) return;
		btn.disabled = true;
		btn.setText("Creating…");
		void createSequenceFile(plugin, project, devNote.basename);
	});
}

const DEFAULT_SCENE_FOLDER_NAME = "Screenplay";

// Minimal fountain scaffold so obsidian-fountain mounts its editor. Empty
// .fountain files don't initialise an editable view — the user gets a
// non-editable preview surface. A slugline placeholder gives them somewhere
// to start typing immediately.
// prettier-ignore
const FOUNTAIN_STARTER = `INT. LOCATION - DAY

`;

// Creates the fountain file for a scene. If the project's Longform sequenceFolder
// is empty or pointing at the project root, this also: (a) updates Index.md to
// set sequenceFolder = "Screenplay", (b) creates the Screenplay/ folder. Always
// appends the new file to the longform.scenes array so it shows up in
// Longform's sidebar without manual drag-and-drop.
async function createSequenceFile(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	sequenceName: string,
): Promise<void> {
	try {
		const { fountainPath, configChanged } = await ensureSequenceFolder(plugin, project);
		const cfg = plugin.settings.global;
		const filename = fountainFilename(sequenceName, cfg.fountainFileFormat);
		const finalPath = normalizePath(`${fountainPath}/${filename}`);

		if (plugin.app.vault.getAbstractFileByPath(finalPath)) {
			new Notice("Sequence file already exists.");
			return;
		}

		const created = await plugin.app.vault.create(finalPath, FOUNTAIN_STARTER);

		// Append to Longform's scenes array if not already present. The entry
		// format depends on the fountain file format setting — .fountain files
		// store as plain basename, .fountain.md files store as basename ending
		// in .fountain.
		const arrayEntry = fountainScenesArrayEntry(sequenceName, cfg.fountainFileFormat);
		const scenes = readScenesArray(plugin.app, project.indexFilePath);
		if (!scenes.includes(arrayEntry)) {
			scenes.push(arrayEntry);
			await writeScenesArray(plugin.app, project.indexFilePath, scenes);
		}

		await plugin.app.workspace.getLeaf(false).openFile(created);

		new Notice(
			configChanged
				? `Created ${DEFAULT_SCENE_FOLDER_NAME}/ folder and added scene to project.`
				: "Sequence file created and added to project.",
		);
	} catch (e) {
		new Notice(`Could not create scene file: ${(e as Error).message}`);
	}
}

interface SceneFolderEnsured {
	fountainPath: string;
	configChanged: boolean;
}

async function ensureSequenceFolder(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
): Promise<SceneFolderEnsured> {
	const projectRoot = project.projectRootPath;
	const currentScenePath = project.sequenceFolderPath;
	const sceneFolderIsRoot = currentScenePath === projectRoot;

	if (!sceneFolderIsRoot) {
		await ensureFolderExists(plugin, currentScenePath);
		return { fountainPath: currentScenePath, configChanged: false };
	}

	// sequenceFolder is empty / pointing at the root — set it to "Screenplay" and
	// create that folder.
	const newPath = normalizePath(`${projectRoot}/${DEFAULT_SCENE_FOLDER_NAME}`);
	await ensureFolderExists(plugin, newPath);

	const indexFile = plugin.app.vault.getAbstractFileByPath(project.indexFilePath);
	if (indexFile instanceof TFile) {
		await plugin.app.fileManager.processFrontMatter(indexFile, (fm: Record<string, unknown>) => {
			// Update whichever project block already exists; default to
			// `firstdraft:` for new projects. Within the block, write to
			// whichever folder key is in use (sequenceFolder new; sceneFolder
			// legacy). New projects get sequenceFolder.
			const key = projectBlockKey(fm) ?? "firstdraft";
			const block = (fm[key] as Record<string, unknown> | undefined) ?? {};
			const folderKey =
				"sequenceFolder" in block
					? "sequenceFolder"
					: "sceneFolder" in block
						? "sceneFolder"
						: "sequenceFolder";
			block[folderKey] = DEFAULT_SCENE_FOLDER_NAME;
			fm[key] = block;
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
	cfg: GlobalConfig;
}

export function renderCharactersSection(opts: CharactersSectionOpts): void {
	const { container, plugin, characterNames, roster, cfg } = opts;
	if (characterNames.length === 0) return;

	container.createEl("h4", { text: "Characters", cls: "firstdraft-section-title" });
	const list = container.createDiv({ cls: "firstdraft-cards" });

	const fields = cfg.characterCardFields;

	// Resolve each dev-note name to a canonical roster entry (folding aliases).
	// Multiple dev-note entries pointing at the same canonical character produce
	// one card; we render an "unresolved" card if no roster match exists so the
	// user still sees the name was recorded.
	const seen = new Map<string, CharacterEntry | null>(); // canonical name → entry
	const orderedKeys: string[] = [];
	const unresolvedNames: string[] = [];

	for (const name of characterNames) {
		const canonical = resolveCharacterByNameOrAlias(roster, name);
		if (!canonical) {
			unresolvedNames.push(name);
			continue;
		}
		if (!seen.has(canonical.name)) {
			seen.set(canonical.name, canonical);
			orderedKeys.push(canonical.name);
		}
	}

	for (const key of orderedKeys) {
		const entry = seen.get(key) ?? null;
		if (!entry) continue;
		renderCharacterCard(list, plugin, entry.name, entry, fields);
	}
	for (const name of unresolvedNames) {
		renderCharacterCard(list, plugin, name, null, fields);
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

	// Phase 4g — group/alias subtitles before the field list.
	if (entry.isGroup && entry.groupMembers.length > 0) {
		body.createEl("p", {
			text: `Members: ${entry.groupMembers.join(", ")}`,
			cls: "firstdraft-card-subtitle",
		});
	}
	if (!entry.isGroup && entry.aliases.length > 0) {
		body.createEl("p", {
			text: `Also: ${entry.aliases.join(", ")}`,
			cls: "firstdraft-card-subtitle",
		});
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
	// Case-insensitive lookup so `Vibe` in settings matches `vibe` in frontmatter
	// (and vice versa). Display label uses the configured field casing.
	const fmByLower = new Map<string, unknown>();
	for (const [k, v] of Object.entries(fm)) {
		fmByLower.set(k.toLowerCase(), v);
	}
	const lookup = (f: string): unknown => fmByLower.get(f.toLowerCase());

	const visible = fields.filter((f) => {
		const v = lookup(f);
		return v !== undefined && v !== null && v !== "";
	});
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
		dl.createEl("dd", { text: stringifyField(lookup(f)) });
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
