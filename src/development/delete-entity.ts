import { App, Modal, Notice, SuggestModal, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { characterRoster, locationRoster } from "../views/lookups";
import { snapshotFile, todayLabel } from "../versioning/snapshot";

// One-shot delete with full project cleanup. Picks an entity from the
// project's roster, shows a confirmation summarising what will happen, then:
//
//   1. Auto-snapshots the entity files first (browseable for rollback via
//      Browse file versions on the deleted file's path — though that path
//      no longer exists after delete; the snapshots in the parent's
//      _versions/ remain).
//   2. Strips the entity's name from every dev note's characters: /
//      locations: frontmatter array.
//   3. Walks all project markdown and replaces links to the entity's file
//      with the link's display text (so [Marcus](path) → Marcus).
//   4. Moves the entity's file(s) to Obsidian's vault trash (.trash/),
//      recoverable through Obsidian's normal restore flow.
//
// "Entity" granularity:
//   - Picking a parent (file matching folder name, e.g. Marcus.md inside
//     Marcus/) deletes the WHOLE folder including all version files,
//     References/, and Notes/.
//   - Picking a version or sub-area (e.g. Young Marcus.md or Kitchen.md)
//     deletes only that single file.

type EntityKind = "character" | "location";

const SKIP_FOLDERS_FOR_REWRITE = new Set(["_versions", "Drafts"]);

interface RosterChoice {
	displayName: string;       // for picker filter / render (e.g. "MARCUS" or "MARCUS' HOUSE - KITCHEN")
	folderName: string;        // parent folder (Marcus or Marcus' House)
	canonicalFile: TFile;      // the file picked
	kind: EntityKind;
	isParent: boolean;         // file matches folder name
}

export function runDeleteCharacterCommand(plugin: FirstDraftPlugin): void {
	void deleteEntity(plugin, "character");
}

export function runDeleteLocationCommand(plugin: FirstDraftPlugin): void {
	void deleteEntity(plugin, "location");
}

async function deleteEntity(plugin: FirstDraftPlugin, kind: EntityKind): Promise<void> {
	const file = plugin.app.workspace.getActiveFile();
	const project = file ? resolveActiveProject(file, plugin.scanner) : null;
	if (!project) {
		new Notice("Open a file inside a project first.");
		return;
	}

	const choices = collectChoices(plugin, project, kind);
	if (choices.length === 0) {
		new Notice(`No ${kind}s found in this project.`);
		return;
	}

	new EntityPickerModal(plugin, project, kind, choices).open();
}

function collectChoices(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	kind: EntityKind,
): RosterChoice[] {
	const cfg = resolveProjectSettings(project, plugin.settings);
	const entries =
		kind === "character"
			? characterRoster(plugin.app, project, cfg)
			: locationRoster(plugin.app, project, cfg);
	const out: RosterChoice[] = [];
	for (const entry of entries) {
		if (!entry.canonicalFile) continue;
		const isParent = entry.canonicalFile.name === `${entry.folder.name}.md`;
		out.push({
			displayName: entry.name,
			folderName: entry.folder.name,
			canonicalFile: entry.canonicalFile,
			kind,
			isParent,
		});
	}
	return out;
}

class EntityPickerModal extends SuggestModal<RosterChoice> {
	constructor(
		private readonly plugin: FirstDraftPlugin,
		private readonly project: ProjectMeta,
		private readonly kind: EntityKind,
		private readonly choices: RosterChoice[],
	) {
		super(plugin.app);
		this.setPlaceholder(`Pick a ${kind} to delete`);
	}

	getSuggestions(query: string): RosterChoice[] {
		const q = query.trim().toUpperCase();
		if (q === "") return this.choices;
		return this.choices.filter((c) => c.displayName.includes(q));
	}

	renderSuggestion(value: RosterChoice, el: HTMLElement): void {
		el.createEl("div", { text: value.displayName });
		const sub = el.createEl("div", { cls: "firstdraft-version-meta" });
		sub.setText(
			value.isParent
				? `Deletes whole ${value.kind} folder`
				: `Deletes only ${value.canonicalFile.basename}.md`,
		);
	}

	onChooseSuggestion(value: RosterChoice): void {
		new ConfirmDeleteModal(this.plugin, this.project, value).open();
	}
}

// ── confirmation ──────────────────────────────────────────────────────────

class ConfirmDeleteModal extends Modal {
	private finished = false;
	constructor(
		private readonly plugin: FirstDraftPlugin,
		private readonly project: ProjectMeta,
		private readonly choice: RosterChoice,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		const target = this.choice.displayName;
		contentEl.createEl("h3", { text: `Delete ${target}?` });

		const summary = this.computeSummary();
		const list = contentEl.createEl("ul");
		list.createEl("li", {
			text: this.choice.isParent
				? `The folder ${this.choice.folderName}/ and all ${summary.fileCount} file(s) inside`
				: `The file ${this.choice.canonicalFile.path}`,
		});
		list.createEl("li", { text: "Auto-snapshot before deletion (rollback safety)" });
		list.createEl("li", {
			text: "Strip the name from every dev note's frontmatter array",
		});
		list.createEl("li", {
			text: "Replace links pointing at the deleted file(s) with plain text",
		});
		list.createEl("li", {
			text: "Move the file(s) to Obsidian trash (recoverable)",
		});

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => {
			this.finished = true;
			this.close();
		});
		const ok = buttons.createEl("button", { text: "Delete", cls: "mod-warning" });
		ok.addEventListener("click", () => {
			this.finished = true;
			this.close();
			void runDeletion(this.plugin, this.project, this.choice);
		});
	}

	private computeSummary(): { fileCount: number } {
		if (!this.choice.isParent) return { fileCount: 1 };
		const folder = this.choice.canonicalFile.parent;
		if (!folder) return { fileCount: 1 };
		let count = 0;
		const walk = (f: TFolder) => {
			for (const child of f.children) {
				if (child instanceof TFile) count += 1;
				else if (child instanceof TFolder) walk(child);
			}
		};
		walk(folder);
		return { fileCount: count };
	}

	onClose(): void {
		this.contentEl.empty();
		void this.finished;
	}
}

// ── deletion logic ────────────────────────────────────────────────────────

async function runDeletion(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	choice: RosterChoice,
): Promise<void> {
	try {
		// Files to actually remove (parent → whole folder; otherwise just one file)
		const filesToDelete: TFile[] = [];
		const targetForDeletion = choice.isParent ? choice.canonicalFile.parent : choice.canonicalFile;
		if (choice.isParent) {
			const parentFolder = choice.canonicalFile.parent;
			if (parentFolder) collectAllFiles(parentFolder, filesToDelete);
		} else {
			filesToDelete.push(choice.canonicalFile);
		}

		// Names to strip from frontmatter arrays — for a parent delete, strip
		// every roster entry that lives in the folder (parent + all versions/
		// sub-areas). For a single-file delete, strip just that one entry's name.
		const namesToStrip = computeNamesToStrip(choice, filesToDelete);

		// Step 1: snapshot each file we're about to delete.
		const label = `pre-delete ${todayLabel()}`;
		for (const f of filesToDelete) {
			await snapshotFile(plugin.app, f, label);
		}

		// Step 2: strip frontmatter references and rewrite links across the project.
		const cleanup = await cleanupReferences(
			plugin,
			project,
			filesToDelete,
			namesToStrip,
			choice.kind,
		);

		// Step 3: trash the files / folder via fileManager so it respects the
		// user's configured deletion preference (system trash vs. vault trash).
		if (choice.isParent && targetForDeletion instanceof TFolder) {
			await plugin.app.fileManager.trashFile(targetForDeletion);
		} else if (targetForDeletion instanceof TFile) {
			await plugin.app.fileManager.trashFile(targetForDeletion);
		}

		new Notice(
			`Deleted ${choice.displayName}. ` +
				`Cleaned ${cleanup.frontmatterEdits} frontmatter array(s), ` +
				`replaced ${cleanup.linksReplaced} link(s) across ${cleanup.filesModified} file(s).`,
			8000,
		);
	} catch (e) {
		new Notice(`Delete failed: ${(e as Error).message}`);
	}
}

function collectAllFiles(folder: TFolder, out: TFile[]): void {
	for (const child of folder.children) {
		if (child instanceof TFile) out.push(child);
		else if (child instanceof TFolder) collectAllFiles(child, out);
	}
}

function computeNamesToStrip(choice: RosterChoice, files: TFile[]): string[] {
	const folderName = choice.folderName;
	const kind = choice.kind;
	const names = new Set<string>();
	for (const f of files) {
		if (f.extension !== "md") continue;
		const isPrimary = f.name === `${folderName}.md`;
		if (kind === "character") {
			names.add(f.basename.toUpperCase());
		} else {
			// locations: parent vs. sub naming
			names.add(
				isPrimary
					? folderName.toUpperCase()
					: `${folderName.toUpperCase()} - ${f.basename.toUpperCase()}`,
			);
		}
	}
	return [...names];
}

interface CleanupResult {
	frontmatterEdits: number;
	filesModified: number;
	linksReplaced: number;
}

async function cleanupReferences(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	filesToDelete: TFile[],
	namesToStrip: string[],
	kind: EntityKind,
): Promise<CleanupResult> {
	const result: CleanupResult = {
		frontmatterEdits: 0,
		filesModified: 0,
		linksReplaced: 0,
	};
	const fmField = kind === "character" ? "characters" : "locations";

	const root = plugin.app.vault.getAbstractFileByPath(project.projectRootPath);
	if (!(root instanceof TFolder)) return result;

	const candidates: TFile[] = [];
	walkForCleanup(root, candidates, new Set(filesToDelete.map((f) => f.path)));

	const namesUpperSet = new Set(namesToStrip);
	const filesToDeletePaths = new Set(filesToDelete.map((f) => f.path));

	for (const file of candidates) {
		let modified = false;

		// Strip frontmatter array references.
		await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			if (!Array.isArray(fm[fmField])) return;
			const arr = fm[fmField] as unknown[];
			const next: string[] = [];
			let changed = false;
			for (const item of arr) {
				if (typeof item !== "string") {
					next.push(String(item));
					continue;
				}
				if (namesUpperSet.has(item.trim().toUpperCase())) {
					changed = true;
					continue;
				}
				next.push(item);
			}
			if (changed) {
				fm[fmField] = next;
				result.frontmatterEdits += 1;
				modified = true;
			}
		});

		// Replace links pointing at any of the deleted files.
		const content = await plugin.app.vault.read(file);
		const { rewritten, count } = stripLinksToFiles(content, filesToDeletePaths, file.path);
		if (count > 0) {
			await plugin.app.vault.modify(file, rewritten);
			result.linksReplaced += count;
			modified = true;
		}

		if (modified) result.filesModified += 1;
	}

	return result;
}

function walkForCleanup(folder: TFolder, out: TFile[], skipPaths: Set<string>): void {
	for (const child of folder.children) {
		if (child instanceof TFolder) {
			if (SKIP_FOLDERS_FOR_REWRITE.has(child.name)) continue;
			walkForCleanup(child, out, skipPaths);
			continue;
		}
		if (!(child instanceof TFile)) continue;
		if (child.extension !== "md") continue;
		if (skipPaths.has(child.path)) continue;
		out.push(child);
	}
}

interface LinkStripResult {
	rewritten: string;
	count: number;
}

// Replace markdown links [DisplayText](target) where target points at any of
// the to-be-deleted file paths. Replacement is just the DisplayText (the link
// goes away, but the visible name stays in the prose). Also handles wikilinks
// of either [[path]] or [[path|alias]] form.
function stripLinksToFiles(
	content: string,
	deletedPaths: Set<string>,
	containingFilePath: string,
): LinkStripResult {
	let result = content;
	let count = 0;

	for (const path of deletedPaths) {
		const relativePath = relativeFromFile(containingFilePath, path);
		const variants = [path, relativePath];

		for (const target of variants) {
			const escaped = escapeRegExp(target);
			const mdRe = new RegExp(`\\[([^\\]]+)\\]\\(${escaped}\\)`, "g");
			result = result.replace(mdRe, (_match, displayText: string) => {
				count += 1;
				return displayText;
			});
			const wikiRe = new RegExp(
				`\\[\\[${escaped}(?:\\|([^\\]]+))?\\]\\]`,
				"g",
			);
			result = result.replace(wikiRe, (_match, alias?: string) => {
				count += 1;
				return alias ?? normalizePath(target).split("/").pop() ?? target;
			});
		}
	}

	return { rewritten: result, count };
}

function relativeFromFile(fromFile: string, toFile: string): string {
	const fromParts = fromFile.split("/").slice(0, -1);
	const toParts = toFile.split("/");
	let i = 0;
	while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
	const ups = fromParts.length - i;
	const downs = toParts.slice(i);
	const segments: string[] = [];
	for (let k = 0; k < ups; k++) segments.push("..");
	segments.push(...downs);
	if (segments.length === 0) return toParts[toParts.length - 1] ?? toFile;
	return segments.join("/");
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Suppress unused-app warning (App imported for potential extension).
void normalizePath;
export { App as _App };
