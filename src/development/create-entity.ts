import {
	App,
	Editor,
	Modal,
	Notice,
	TFile,
	TFolder,
	normalizePath,
} from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "../projects/resolver";
import type { ProjectMeta } from "../types";
import { sanitizeFilename, toTitleCase } from "../utils/sanitize";
import { linkifyEntity, type DevEntity, type LinkifyResult } from "./linkify";

// Selection-to-entity creation. Highlight a name in any markdown editor, run
// the command (or pick from the right-click menu), and FirstDraft scaffolds a
// character or location at Development/Characters/<Name>/<Name>.md (or
// Locations/), optionally replaces the selection with a link, and offers a
// project-wide backfill linkify pass.

type EntityKind = "character" | "location";

export function runCreateCharacterFromSelection(
	plugin: FirstDraftPlugin,
	editor: Editor,
): void {
	void createEntityFromSelection(plugin, editor, "character");
}

export function runCreateLocationFromSelection(
	plugin: FirstDraftPlugin,
	editor: Editor,
): void {
	void createEntityFromSelection(plugin, editor, "location");
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

	const file = plugin.app.workspace.getActiveFile();
	const project = file ? resolveActiveProject(file, plugin.scanner) : null;
	if (!project) {
		new Notice("Open a file inside a project first.");
		return;
	}

	const cfg = plugin.settings.global;
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

	// Conflict check (case-insensitive, since Windows is case-insensitive).
	const existing = findExistingEntity(plugin.app, entityRoot, folderCasing);
	let finalName = folderCasing;
	if (existing) {
		const decision = await openConflictModal(plugin.app, kind, folderCasing);
		if (decision.action === "cancel") return;
		if (decision.action === "open") {
			await plugin.app.workspace.getLeaf(false).openFile(existing.canonical);
			return;
		}
		// "create" with suffix
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
		finalName = toTitleCase(combined);

		// Re-check conflict for the new name.
		const conflict = findExistingEntity(plugin.app, entityRoot, finalName);
		if (conflict) {
			new Notice(`A ${kind} named "${finalName}" already exists.`);
			return;
		}
	}

	// Scaffold folder + canonical doc.
	const folderPath = normalizePath(`${entityRoot}/${finalName}`);
	const docPath = normalizePath(`${folderPath}/${finalName}.md`);
	try {
		await ensureFolderExists(plugin.app, folderPath);
		const template =
			kind === "character" ? cfg.characterNoteTemplate : cfg.locationNoteTemplate;
		const created = await plugin.app.vault.create(docPath, template);

		// Replace selection with link if enabled and we have an editor file context.
		if (cfg.replaceSelectionWithLink && file) {
			const linkTarget = relativePathFromEditor(file.path, docPath);
			editor.replaceSelection(`[${finalName}](${linkTarget})`);
		}

		// Open the new note.
		await plugin.app.workspace.getLeaf(false).openFile(created);

		new Notice(`Created ${kind}: ${finalName}`);

		// Backfill linkify (silent if auto, otherwise offer via Notice).
		const entity: DevEntity = { name: finalName, canonicalFilePath: docPath };
		if (cfg.autoLinkifyOnCreate) {
			const result = await linkifyEntity(plugin, project, entity);
			notifyLinkifyResult(result, "auto");
		} else {
			offerLinkify(plugin, project, entity);
		}
	} catch (e) {
		new Notice(`Could not create ${kind}: ${(e as Error).message}`);
	}
}

// ── conflict modal ───────────────────────────────────────────────────────

interface ConflictDecision {
	action: "open" | "create" | "cancel";
	suffix?: string;
}

function openConflictModal(
	app: App,
	kind: EntityKind,
	name: string,
): Promise<ConflictDecision> {
	return new Promise((resolve) => {
		new ConflictSuffixModal(app, kind, name, resolve).open();
	});
}

class ConflictSuffixModal extends Modal {
	private finished = false;
	private suffixInput?: HTMLInputElement;

	constructor(
		app: App,
		private readonly kind: EntityKind,
		private readonly name: string,
		private readonly done: (d: ConflictDecision) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: `${this.name} already exists` });
		contentEl.createEl("p", {
			text: `A ${this.kind} named "${this.name}" already exists. Is this a different ${this.kind}?`,
		});

		// Stage 1: choose between Open existing and Add suffix.
		const buttons = contentEl.createDiv({ cls: "modal-button-container firstdraft-conflict-buttons" });

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

	private finish(d: ConflictDecision): void {
		this.finished = true;
		this.done(d);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.finished) this.done({ action: "cancel" });
	}
}

// ── helpers ──────────────────────────────────────────────────────────────

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
		// Folder exists but no canonical — treat as conflict so user knows.
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

function offerLinkify(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	entity: DevEntity,
): void {
	// We can't preview the count without scanning, so offer an action and run on click.
	const notice = new Notice(`Linkify existing mentions of ${entity.name}? Click here to run.`, 8000);
	notice.messageEl.addEventListener("click", (e) => {
		e.preventDefault();
		notice.hide();
		void (async () => {
			const result = await linkifyEntity(plugin, project, entity);
			notifyLinkifyResult(result, "manual");
		})();
	});
}

function notifyLinkifyResult(result: LinkifyResult, _mode: "auto" | "manual"): void {
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
	notifyLinkifyResult(result, "manual");
}
