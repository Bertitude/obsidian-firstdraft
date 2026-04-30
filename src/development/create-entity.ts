import {
	App,
	Editor,
	EditorPosition,
	Modal,
	Notice,
	TFile,
	TFolder,
	normalizePath,
} from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import type { ProjectMeta } from "../types";
import { sanitizeFilename, toTitleCase } from "../utils/sanitize";
import { linkifyEntity, type DevEntity, type LinkifyResult } from "./linkify";
import { openCreateCharacterModal } from "./create-character-modal";
import { openCreateLocationModal } from "./create-location-modal";
import { isFountainFile } from "../fountain/file-detection";

// Selection-to-entity creation. Highlight a name in any markdown editor, run
// the command (or pick from the right-click menu), and FirstDraft scaffolds a
// character or location at Development/<Subfolder>/<Name>/<Name>.md, optionally
// replaces the selection with a link, and offers a project-wide backfill
// linkify pass.
//
// Conflict handling has three branches:
//   1. Exact match for an existing folder/file → "open existing / add suffix /
//      cancel" modal (Phase 4b legacy).
//   2. Selection contains a single existing folder name as a substring →
//      "version of X / create new with suffix / cancel" modal. Versions go
//      into the parent's folder (e.g. Marcus/Young Marcus.md). For locations,
//      sub-areas use the part after " - " as the filename (e.g.
//      Marcus' House/Kitchen.md from "Marcus' House - Kitchen").
//   3. Selection contains 2+ existing folder names as substrings → no
//      creation; replace the selection with linked references for each
//      detected entity. Notice reports the count.
//   4. No matches → standard create flow.

type EntityKind = "character" | "location";

export function runCreateCharacterFromSelection(
	plugin: FirstDraftPlugin,
	editor: Editor,
): void {
	void createCharacterFromSelection(plugin, editor);
}

export function runCreateLocationFromSelection(
	plugin: FirstDraftPlugin,
	editor: Editor,
): void {
	void createLocationFromSelection(plugin, editor);
}

// Palette command "Create character" — opens the modal with no pre-fill.
// Always lands at series level when active project is a tv-episode with a
// series root above; otherwise at the active project's own Characters/.
export async function runCreateCharacterCommand(
	plugin: FirstDraftPlugin,
): Promise<void> {
	const result = await openCreateCharacterModal(plugin, "");
	if (!result) return;
	await plugin.app.workspace.getLeaf(false).openFile(result.file);
	new Notice(`Created character: ${result.displayName}`);
}

// Palette command "Create location" — symmetric with Create character.
export async function runCreateLocationCommand(
	plugin: FirstDraftPlugin,
): Promise<void> {
	const result = await openCreateLocationModal(plugin, "");
	if (!result) return;
	await plugin.app.workspace.getLeaf(false).openFile(result.file);
	new Notice(`Created location: ${result.displayName}`);
}

// Selection-create for locations routes through the new Create Location
// modal (parallel to characters). Skips the legacy parent-detection flow
// — if you really want sub-areas inside a parent location, use the modal's
// `parent_location` field instead.
async function createLocationFromSelection(
	plugin: FirstDraftPlugin,
	editor: Editor,
): Promise<void> {
	const raw = editor.getSelection();
	if (!raw || raw.trim() === "") {
		new Notice("Select a location name first.");
		return;
	}
	const selFrom = editor.getCursor("from");
	const selTo = editor.getCursor("to");

	const file = plugin.app.workspace.getActiveFile();
	const project = file ? resolveActiveProject(file, plugin.scanner) : null;
	if (!project) {
		new Notice("Open a file inside a project first.");
		return;
	}

	const cfg = resolveProjectSettings(project, plugin.settings);
	const sanitized = sanitizeFilename(raw.trim(), cfg.filenameReplacementChar);
	if (!sanitized) {
		new Notice("Selection has no valid filename characters.");
		return;
	}
	const defaultName = toTitleCase(sanitized);

	const result = await openCreateLocationModal(plugin, defaultName);
	if (!result) return;

	// Replace selection with a link only when we're in a markdown context.
	// Fountain files (`.fountain` and `.fountain.md`) keep the selection as
	// plain text — slug lines / action prose that contain markdown link or
	// wikilink syntax break Fountain parsing and render funny in script
	// preview ("INT. [Location](path) - DAY" no longer reads as a slug).
	if (cfg.replaceSelectionWithLink && file && !isFountainFile(file)) {
		const linkTarget = relativePathFromEditor(file.path, result.file.path);
		editor.replaceRange(`[${result.displayName}](${linkTarget})`, selFrom, selTo);
	}

	await plugin.app.workspace.getLeaf(false).openFile(result.file);
	new Notice(`Created location: ${result.displayName}`);

	const entity: DevEntity = { name: result.displayName, canonicalFilePath: result.file.path };
	if (cfg.autoLinkifyOnCreate) {
		const linkifyResult = await linkifyEntity(plugin, project, entity);
		notifyLinkifyResult(linkifyResult);
	} else {
		offerLinkify(plugin, project, entity);
	}
}

// Selection-create for characters routes through the modal (with name
// pre-filled from the selection). Skips the legacy parent-detection /
// version-of-X flow — those branches were location-shaped patterns ("Marcus'
// House - Kitchen" → sub-area of Marcus' House) that aren't useful for
// characters. Existing-name conflict bails inside the modal with a notice.
async function createCharacterFromSelection(
	plugin: FirstDraftPlugin,
	editor: Editor,
): Promise<void> {
	const raw = editor.getSelection();
	if (!raw || raw.trim() === "") {
		new Notice("Select a character name first.");
		return;
	}
	// Capture selection range upfront — see Phase 4b note about awaits losing
	// the live selection.
	const selFrom = editor.getCursor("from");
	const selTo = editor.getCursor("to");

	const file = plugin.app.workspace.getActiveFile();
	const project = file ? resolveActiveProject(file, plugin.scanner) : null;
	if (!project) {
		new Notice("Open a file inside a project first.");
		return;
	}

	const cfg = resolveProjectSettings(project, plugin.settings);
	const sanitized = sanitizeFilename(raw.trim(), cfg.filenameReplacementChar);
	if (!sanitized) {
		new Notice("Selection has no valid filename characters.");
		return;
	}
	const defaultName = toTitleCase(sanitized);

	const result = await openCreateCharacterModal(plugin, defaultName);
	if (!result) return;

	// Replace the captured selection with a link to the canonical file —
	// but only in markdown context. In a fountain, the selection probably
	// IS a cue or part of action prose, and inserting markdown-link syntax
	// breaks Fountain parsing.
	if (cfg.replaceSelectionWithLink && file && !isFountainFile(file)) {
		const linkTarget = relativePathFromEditor(file.path, result.file.path);
		editor.replaceRange(`[${result.displayName}](${linkTarget})`, selFrom, selTo);
	}

	await plugin.app.workspace.getLeaf(false).openFile(result.file);
	new Notice(`Created character: ${result.displayName}`);

	const entity: DevEntity = { name: result.displayName, canonicalFilePath: result.file.path };
	if (cfg.autoLinkifyOnCreate) {
		const linkifyResult = await linkifyEntity(plugin, project, entity);
		notifyLinkifyResult(linkifyResult);
	} else {
		offerLinkify(plugin, project, entity);
	}
}

async function createEntityFromSelection(
	plugin: FirstDraftPlugin,
	editor: Editor,
	kind: EntityKind,
): Promise<void> {
	const raw = editor.getSelection();
	if (!raw || raw.trim() === "") {
		new Notice(`Select a ${kind} name first.`);
		return;
	}

	// Capture selection range upfront — see Phase 4b note about awaits losing
	// the live selection.
	const selFrom = editor.getCursor("from");
	const selTo = editor.getCursor("to");

	const file = plugin.app.workspace.getActiveFile();
	const project = file ? resolveActiveProject(file, plugin.scanner) : null;
	if (!project) {
		new Notice("Open a file inside a project first.");
		return;
	}

	const cfg = resolveProjectSettings(project, plugin.settings);
	const sanitized = sanitizeFilename(raw.trim(), cfg.filenameReplacementChar);
	if (!sanitized) {
		new Notice("Selection has no valid filename characters.");
		return;
	}

	const folderCasing = toTitleCase(sanitized);
	const subfolder = kind === "character" ? cfg.charactersSubfolder : cfg.locationsSubfolder;
	const entityRoot = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${subfolder}`,
	);

	// Branch 1: exact name match → existing-name conflict flow
	const existingExact = findExistingEntity(plugin.app, entityRoot, folderCasing);
	if (existingExact) {
		await handleExactConflict({
			plugin,
			project,
			kind,
			folderCasing,
			existing: existingExact,
			file,
			editor,
			selFrom,
			selTo,
			entityRoot,
			cfg,
		});
		return;
	}

	// Branch 2/3: substring/parent detection
	const parents = findParentFolders(plugin.app, entityRoot, folderCasing);

	if (parents.length >= 2) {
		// Multi-parent: just replace selection with linked refs, no creation
		const replaced = await replaceSelectionWithMultipleLinks(
			plugin,
			parents,
			raw,
			file,
			editor,
			selFrom,
			selTo,
		);
		new Notice(
			`Linked ${replaced} existing ${kind}${replaced === 1 ? "" : "s"}: ${parents.map((p) => p.name.toUpperCase()).join(", ")}`,
		);
		return;
	}

	if (parents.length === 1) {
		const parent = parents[0]!;
		const decision = await openParentModal(plugin.app, kind, folderCasing, parent.name);
		if (decision.action === "cancel") return;
		if (decision.action === "version") {
			await createAsVersion({
				plugin,
				project,
				kind,
				selectionName: folderCasing,
				parentFolder: parent,
				file,
				editor,
				selFrom,
				selTo,
				cfg,
			});
			return;
		}
		// "create-new" — suffix prompt
		const suffix = await openSuffixPrompt(plugin.app, kind, folderCasing, parent.name);
		if (!suffix) return;
		const suffixSan = sanitizeFilename(suffix, cfg.filenameReplacementChar);
		if (!suffixSan) {
			new Notice("Suffix was empty after sanitization.");
			return;
		}
		const combined = sanitizeFilename(
			`${folderCasing} ${suffixSan}`,
			cfg.filenameReplacementChar,
		);
		if (!combined) {
			new Notice("Combined name was invalid.");
			return;
		}
		const finalName = toTitleCase(combined);
		await createNewTopLevelEntity({
			plugin,
			project,
			kind,
			finalName,
			file,
			editor,
			selFrom,
			selTo,
			entityRoot,
			cfg,
		});
		return;
	}

	// Branch 4: no parent matches — standard top-level create
	await createNewTopLevelEntity({
		plugin,
		project,
		kind,
		finalName: folderCasing,
		file,
		editor,
		selFrom,
		selTo,
		entityRoot,
		cfg,
	});
}

// ── exact-conflict handler (Phase 4b legacy: open / add suffix / cancel) ─

interface ExactConflictArgs {
	plugin: FirstDraftPlugin;
	project: ProjectMeta;
	kind: EntityKind;
	folderCasing: string;
	existing: { folder: TFolder; canonical: TFile };
	file: TFile | null;
	editor: Editor;
	selFrom: EditorPosition;
	selTo: EditorPosition;
	entityRoot: string;
	cfg: FirstDraftPlugin["settings"]["global"];
}

async function handleExactConflict(args: ExactConflictArgs): Promise<void> {
	const { plugin, kind, folderCasing, existing, cfg } = args;
	const decision = await openExactConflictModal(plugin.app, kind, folderCasing);
	if (decision.action === "cancel") return;
	if (decision.action === "open") {
		await plugin.app.workspace.getLeaf(false).openFile(existing.canonical);
		return;
	}
	const suffixSan = decision.suffix
		? sanitizeFilename(decision.suffix, cfg.filenameReplacementChar)
		: null;
	if (!suffixSan) {
		new Notice("Suffix was empty after sanitization.");
		return;
	}
	const combined = sanitizeFilename(
		`${folderCasing} ${suffixSan}`,
		cfg.filenameReplacementChar,
	);
	if (!combined) {
		new Notice("Combined name was invalid.");
		return;
	}
	const finalName = toTitleCase(combined);
	const conflictAgain = findExistingEntity(plugin.app, args.entityRoot, finalName);
	if (conflictAgain) {
		new Notice(`A ${kind} named "${finalName}" already exists.`);
		return;
	}
	await createNewTopLevelEntity({ ...args, finalName });
}

// ── creation paths ────────────────────────────────────────────────────────

interface CreateTopLevelArgs {
	plugin: FirstDraftPlugin;
	project: ProjectMeta;
	kind: EntityKind;
	finalName: string;
	file: TFile | null;
	editor: Editor;
	selFrom: EditorPosition;
	selTo: EditorPosition;
	entityRoot: string;
	cfg: FirstDraftPlugin["settings"]["global"];
}

async function createNewTopLevelEntity(args: CreateTopLevelArgs): Promise<void> {
	const { plugin, project, kind, finalName, file, editor, selFrom, selTo, entityRoot, cfg } = args;
	const folderPath = normalizePath(`${entityRoot}/${finalName}`);
	const docPath = normalizePath(`${folderPath}/${finalName}.md`);

	try {
		await ensureFolderExists(plugin.app, folderPath);
		const template =
			kind === "character" ? cfg.characterNoteTemplate : cfg.locationNoteTemplate;
		const created = await plugin.app.vault.create(docPath, template);

		// Skip link replacement in fountain context — see note in
		// createCharacterFromSelection / createLocationFromSelection.
		if (cfg.replaceSelectionWithLink && file && !isFountainFile(file)) {
			const linkTarget = relativePathFromEditor(file.path, docPath);
			editor.replaceRange(`[${finalName}](${linkTarget})`, selFrom, selTo);
		}

		await plugin.app.workspace.getLeaf(false).openFile(created);
		new Notice(`Created ${kind}: ${finalName}`);

		const entity: DevEntity = { name: finalName, canonicalFilePath: docPath };
		if (cfg.autoLinkifyOnCreate) {
			const result = await linkifyEntity(plugin, project, entity);
			notifyLinkifyResult(result);
		} else {
			offerLinkify(plugin, project, entity);
		}
	} catch (e) {
		new Notice(`Could not create ${kind}: ${(e as Error).message}`);
	}
}

interface CreateVersionArgs {
	plugin: FirstDraftPlugin;
	project: ProjectMeta;
	kind: EntityKind;
	selectionName: string; // title-cased full selection (e.g. "Young Marcus")
	parentFolder: TFolder;
	file: TFile | null;
	editor: Editor;
	selFrom: EditorPosition;
	selTo: EditorPosition;
	cfg: FirstDraftPlugin["settings"]["global"];
}

async function createAsVersion(args: CreateVersionArgs): Promise<void> {
	const { plugin, kind, selectionName, parentFolder, file, editor, selFrom, selTo, cfg } = args;

	// Determine the file's basename based on entity kind:
	//   - Characters: full selection (e.g. "Young Marcus" → Young Marcus.md)
	//   - Locations: part after " - " from the selection
	//     (e.g. "Marcus' House - Kitchen" → Kitchen.md)
	let versionFileBase: string;
	if (kind === "location") {
		const dashIdx = selectionName.indexOf(" - ");
		versionFileBase =
			dashIdx >= 0 ? selectionName.slice(dashIdx + 3).trim() : selectionName;
		if (!versionFileBase) versionFileBase = selectionName;
	} else {
		versionFileBase = selectionName;
	}

	const sanitized = sanitizeFilename(versionFileBase, cfg.filenameReplacementChar);
	if (!sanitized) {
		new Notice("Version name was invalid.");
		return;
	}
	const fileBase = toTitleCase(sanitized);
	const docPath = normalizePath(`${parentFolder.path}/${fileBase}.md`);

	if (plugin.app.vault.getAbstractFileByPath(docPath)) {
		new Notice(`A ${kind} note already exists at ${docPath}.`);
		// Still open it
		const existing = plugin.app.vault.getAbstractFileByPath(docPath);
		if (existing instanceof TFile) {
			await plugin.app.workspace.getLeaf(false).openFile(existing);
		}
		return;
	}

	try {
		const template =
			kind === "character" ? cfg.characterNoteTemplate : cfg.locationNoteTemplate;
		const created = await plugin.app.vault.create(docPath, template);

		// Skip link replacement in fountain context — see note in
		// createCharacterFromSelection / createLocationFromSelection.
		if (cfg.replaceSelectionWithLink && file && !isFountainFile(file)) {
			const linkTarget = relativePathFromEditor(file.path, docPath);
			editor.replaceRange(`[${selectionName}](${linkTarget})`, selFrom, selTo);
		}

		await plugin.app.workspace.getLeaf(false).openFile(created);
		new Notice(
			`Created ${kind}: ${selectionName.toUpperCase()} in ${parentFolder.name}/`,
		);
	} catch (e) {
		new Notice(`Could not create ${kind} version: ${(e as Error).message}`);
	}
}

// ── multi-parent linkify ─────────────────────────────────────────────────

async function replaceSelectionWithMultipleLinks(
	plugin: FirstDraftPlugin,
	parents: TFolder[],
	originalSelection: string,
	file: TFile | null,
	editor: Editor,
	selFrom: EditorPosition,
	selTo: EditorPosition,
): Promise<number> {
	if (!file) {
		new Notice("Open a file inside a project first.");
		return 0;
	}
	// Don't insert markdown-link syntax in fountain context — would break
	// Fountain parsing. Caller still gets a count of zero so the notice
	// reports "Linked 0 existing locations" rather than misleading the
	// user about modifications that didn't happen.
	if (isFountainFile(file)) return 0;

	// Sort by length desc so longer parent names match first (prevents "Marcus"
	// from being matched inside "Young Marcus" before "Young Marcus" itself
	// gets a chance).
	const sorted = [...parents].sort((a, b) => b.name.length - a.name.length);

	let result = originalSelection;
	let count = 0;
	for (const parent of sorted) {
		const canonicalName = `${parent.name}.md`;
		const canonical = parent.children.find(
			(c) => c instanceof TFile && c.name === canonicalName,
		) as TFile | undefined;
		if (!canonical) continue;
		const target = relativePathFromEditor(file.path, canonical.path);
		const re = new RegExp(`\\b${escapeRegExp(parent.name)}\\b`, "gi");
		result = result.replace(re, (matched) => {
			count += 1;
			return `[${matched}](${target})`;
		});
	}

	editor.replaceRange(result, selFrom, selTo);
	return count;
}

// ── parent detection ──────────────────────────────────────────────────────

function findParentFolders(
	app: App,
	entityRoot: string,
	selectionTitleCase: string,
): TFolder[] {
	const root = app.vault.getAbstractFileByPath(entityRoot);
	if (!(root instanceof TFolder)) return [];
	const lowerSelection = selectionTitleCase.toLowerCase();
	const matches: TFolder[] = [];
	for (const child of root.children) {
		if (!(child instanceof TFolder)) continue;
		const folderLower = child.name.toLowerCase();
		if (folderLower === lowerSelection) continue; // exact match handled separately
		if (containsAsWord(lowerSelection, folderLower)) matches.push(child);
	}
	matches.sort((a, b) => b.name.length - a.name.length);
	return matches;
}

function containsAsWord(haystack: string, needle: string): boolean {
	if (needle.length === 0) return false;
	const idx = haystack.indexOf(needle);
	if (idx === -1) return false;
	const before = idx === 0 ? "" : haystack.charAt(idx - 1);
	const after = idx + needle.length === haystack.length ? "" : haystack.charAt(idx + needle.length);
	const isWordChar = (c: string) => /[a-z0-9]/i.test(c);
	return !isWordChar(before) && !isWordChar(after);
}

// ── modals ────────────────────────────────────────────────────────────────

interface ExactConflictDecision {
	action: "open" | "create" | "cancel";
	suffix?: string;
}

function openExactConflictModal(
	app: App,
	kind: EntityKind,
	name: string,
): Promise<ExactConflictDecision> {
	return new Promise((resolve) => {
		new ExactConflictModal(app, kind, name, resolve).open();
	});
}

class ExactConflictModal extends Modal {
	private finished = false;
	private suffixInput?: HTMLInputElement;

	constructor(
		app: App,
		private readonly kind: EntityKind,
		private readonly name: string,
		private readonly done: (d: ExactConflictDecision) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: `${this.name} already exists` });
		contentEl.createEl("p", {
			text: `A ${this.kind} named "${this.name}" already exists. Is this a different ${this.kind}?`,
		});

		const buttons = contentEl.createDiv({
			cls: "modal-button-container firstdraft-conflict-buttons",
		});
		const openBtn = buttons.createEl("button", { text: "Open existing" });
		openBtn.addEventListener("click", () => this.finish({ action: "open" }));

		const suffixBtn = buttons.createEl("button", {
			text: "Add suffix",
			cls: "mod-cta",
		});
		suffixBtn.addEventListener("click", () => this.showSuffixStage(contentEl));

		const cancelBtn = buttons.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.finish({ action: "cancel" }));
	}

	private showSuffixStage(container: HTMLElement): void {
		container.empty();
		container.createEl("h3", { text: "Differentiate the new entity" });
		container.createEl("p", {
			text: `Enter a suffix to distinguish this ${this.kind} from the existing one.`,
		});
		const inputWrap = container.createDiv({ cls: "firstdraft-conflict-input-wrap" });
		inputWrap.createEl("span", { text: `${this.name} `, cls: "firstdraft-conflict-prefix" });
		this.suffixInput = inputWrap.createEl("input", {
			type: "text",
			cls: "firstdraft-prompt-input",
			attr: { placeholder: "Suffix or last name" },
		});
		this.suffixInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.submitSuffix();
			}
		});
		setTimeout(() => this.suffixInput?.focus(), 0);

		const buttons = container.createDiv({ cls: "modal-button-container" });
		const back = buttons.createEl("button", { text: "Cancel" });
		back.addEventListener("click", () => this.finish({ action: "cancel" }));
		const ok = buttons.createEl("button", { text: "Create", cls: "mod-cta" });
		ok.addEventListener("click", () => this.submitSuffix());
	}

	private submitSuffix(): void {
		const suffix = this.suffixInput?.value?.trim() ?? "";
		if (suffix === "") return;
		this.finish({ action: "create", suffix });
	}

	private finish(d: ExactConflictDecision): void {
		this.finished = true;
		this.done(d);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.finished) this.done({ action: "cancel" });
	}
}

interface ParentDecision {
	action: "version" | "create-new" | "cancel";
}

function openParentModal(
	app: App,
	kind: EntityKind,
	selectionName: string,
	parentName: string,
): Promise<ParentDecision> {
	return new Promise((resolve) => {
		new ParentModal(app, kind, selectionName, parentName, resolve).open();
	});
}

class ParentModal extends Modal {
	private finished = false;

	constructor(
		app: App,
		private readonly kind: EntityKind,
		private readonly selectionName: string,
		private readonly parentName: string,
		private readonly done: (d: ParentDecision) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: `${this.selectionName.toUpperCase()}` });
		const subKind = this.kind === "location" ? "sub-area" : "version";
		contentEl.createEl("p", {
			text: `${this.parentName.toUpperCase()} already exists. Is this a ${subKind} of ${this.parentName.toUpperCase()}, or a separate ${this.kind}?`,
		});

		const buttons = contentEl.createDiv({
			cls: "modal-button-container firstdraft-conflict-buttons",
		});
		const verBtn = buttons.createEl("button", {
			text: this.kind === "location"
				? `Sub-area of ${this.parentName.toUpperCase()}`
				: `Version of ${this.parentName.toUpperCase()}`,
			cls: "mod-cta",
		});
		verBtn.addEventListener("click", () => this.finish({ action: "version" }));

		const newBtn = buttons.createEl("button", {
			text: `Create new ${this.kind}…`,
		});
		newBtn.addEventListener("click", () => this.finish({ action: "create-new" }));

		const cancelBtn = buttons.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.finish({ action: "cancel" }));
	}

	private finish(d: ParentDecision): void {
		this.finished = true;
		this.done(d);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.finished) this.done({ action: "cancel" });
	}
}

function openSuffixPrompt(
	app: App,
	kind: EntityKind,
	name: string,
	parentName: string,
): Promise<string | null> {
	return new Promise((resolve) => {
		new SuffixPromptModal(app, kind, name, parentName, resolve).open();
	});
}

class SuffixPromptModal extends Modal {
	private finished = false;
	private input?: HTMLInputElement;

	constructor(
		app: App,
		private readonly kind: EntityKind,
		private readonly name: string,
		private readonly parentName: string,
		private readonly done: (suffix: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: `Differentiate from ${this.parentName.toUpperCase()}` });
		contentEl.createEl("p", {
			text: `Enter a suffix to distinguish this new ${this.kind} from ${this.parentName.toUpperCase()}.`,
		});

		const inputWrap = contentEl.createDiv({ cls: "firstdraft-conflict-input-wrap" });
		inputWrap.createEl("span", {
			text: `${this.name} `,
			cls: "firstdraft-conflict-prefix",
		});
		this.input = inputWrap.createEl("input", {
			type: "text",
			cls: "firstdraft-prompt-input",
			attr: { placeholder: "Suffix" },
		});
		this.input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.submit();
			}
		});
		setTimeout(() => this.input?.focus(), 0);

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.cancel());
		const ok = buttons.createEl("button", { text: "Create", cls: "mod-cta" });
		ok.addEventListener("click", () => this.submit());
	}

	private submit(): void {
		const value = this.input?.value?.trim() ?? "";
		if (value === "") {
			this.cancel();
			return;
		}
		this.finished = true;
		this.done(value);
		this.close();
	}

	private cancel(): void {
		this.finished = true;
		this.done(null);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.finished) this.done(null);
	}
}

// ── helpers ───────────────────────────────────────────────────────────────

function findExistingEntity(
	app: App,
	entityRoot: string,
	name: string,
): { folder: TFolder; canonical: TFile } | null {
	const folder = app.vault.getAbstractFileByPath(entityRoot);
	if (!(folder instanceof TFolder)) return null;
	const target = name.toLowerCase();
	for (const child of folder.children) {
		if (!(child instanceof TFolder)) continue;
		if (child.name.toLowerCase() !== target) continue;
		const expected = `${child.name}.md`;
		const canonical = child.children.find(
			(c) => c instanceof TFile && c.name === expected,
		) as TFile | undefined;
		if (canonical) return { folder: child, canonical };
		return null;
	}
	return null;
}

async function ensureFolderExists(app: App, path: string): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFolder) return;
	if (existing) throw new Error(`Path exists but is not a folder: ${path}`);
	await app.vault.createFolder(path);
}

function relativePathFromEditor(fromFilePath: string, toPath: string): string {
	const fromParts = fromFilePath.split("/").slice(0, -1);
	const toParts = toPath.split("/");
	let i = 0;
	while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
	const ups = fromParts.length - i;
	const downs = toParts.slice(i);
	const segments: string[] = [];
	for (let k = 0; k < ups; k++) segments.push("..");
	segments.push(...downs);
	if (segments.length === 0) return toParts[toParts.length - 1] ?? toPath;
	return segments.join("/");
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function offerLinkify(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	entity: DevEntity,
): void {
	const notice = new Notice(
		`Linkify existing mentions of ${entity.name}? Click here to run.`,
		8000,
	);
	notice.messageEl.addEventListener("click", (e) => {
		e.preventDefault();
		notice.hide();
		void (async () => {
			const result = await linkifyEntity(plugin, project, entity);
			notifyLinkifyResult(result);
		})();
	});
}

function notifyLinkifyResult(result: LinkifyResult): void {
	if (result.totalReplacements === 0) {
		new Notice("No mentions to linkify.");
		return;
	}
	new Notice(
		`Linkified ${result.totalReplacements} mention(s) across ${result.filesModified} file(s).`,
	);
}

// ── linkify-all command ──────────────────────────────────────────────────

export async function runLinkifyAllCommand(plugin: FirstDraftPlugin): Promise<void> {
	const file = plugin.app.workspace.getActiveFile();
	const project = file ? resolveActiveProject(file, plugin.scanner) : null;
	if (!project) {
		new Notice("Open a file inside a project first.");
		return;
	}
	const { linkifyAllEntities } = await import("./linkify");
	const result = await linkifyAllEntities(plugin, project);
	notifyLinkifyResult(result);
}
