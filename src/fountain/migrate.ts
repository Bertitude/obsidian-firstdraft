import { App, Modal, Notice, TFile, TFolder } from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "../projects/resolver";
import type { ProjectMeta } from "../types";
import { readScenesArray, writeScenesArray } from "../longform/scenes-array";
import { snapshotFile, todayLabel } from "../versioning/snapshot";

// Migrates a project from .fountain to .fountain.md format. This makes scene
// files visible to Longform (which only includes .md files in its compile)
// while keeping chuangcaleb's plugin styling intact via the .fountain. infix.
//
// Steps:
//   1. Auto-snapshot every .fountain file in the project's screenplay folder
//      so the migration is reversible (browse _versions/ to undo).
//   2. Rename each .fountain file → <basename>.fountain.md.
//   3. Update Longform's scenes: array entries: "Cold Open" → "Cold Open.fountain"
//      so Longform can find the renamed file via its basename lookup.
//   4. Update markdown link references across the project to point at the new
//      filenames. e.g. [Cold Open](Screenplay/Cold Open.fountain) →
//      [Cold Open](Screenplay/Cold Open.fountain.md).

interface MigrationResult {
	renamedCount: number;
	scenesArrayUpdated: number;
	linksUpdatedFiles: number;
	linksUpdatedTotal: number;
	skippedConflicts: string[];
}

const SKIP_FOLDERS_FOR_LINKS = new Set(["_versions", "Drafts"]);

export async function runMigrateProjectCommand(plugin: FirstDraftPlugin): Promise<void> {
	const file = plugin.app.workspace.getActiveFile();
	const project = file ? resolveActiveProject(file, plugin.scanner) : null;
	if (!project) {
		new Notice("Open a file inside a project first.");
		return;
	}

	const fountainFiles = collectFountainFiles(plugin.app, project.sceneFolderPath);
	if (fountainFiles.length === 0) {
		new Notice("No .fountain files found in this project's screenplay folder.");
		return;
	}

	const proceed = await confirmMigration(plugin.app, fountainFiles.length);
	if (!proceed) return;

	try {
		const result = await migrateProject(plugin, project, fountainFiles);
		const summary =
			`Migrated ${result.renamedCount} scene(s); updated ${result.linksUpdatedTotal} link(s) across ${result.linksUpdatedFiles} file(s).` +
			(result.skippedConflicts.length > 0
				? ` Skipped ${result.skippedConflicts.length} due to conflicts (see console).`
				: "");
		new Notice(summary, 8000);
		if (result.skippedConflicts.length > 0) {
			console.warn("[FirstDraft] Migration conflicts:", result.skippedConflicts);
		}
	} catch (e) {
		new Notice(`Migration failed: ${(e as Error).message}`);
	}
}

async function migrateProject(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	fountainFiles: TFile[],
): Promise<MigrationResult> {
	const result: MigrationResult = {
		renamedCount: 0,
		scenesArrayUpdated: 0,
		linksUpdatedFiles: 0,
		linksUpdatedTotal: 0,
		skippedConflicts: [],
	};

	// Step 1: snapshot each fountain file before any rename.
	const label = `pre-migrate ${todayLabel()}`;
	for (const f of fountainFiles) {
		await snapshotFile(plugin.app, f, label);
	}

	// Step 2: rename .fountain → .fountain.md, building a path mapping for
	// link rewrite. Capture the old basename BEFORE renameFile — Obsidian
	// mutates the TFile in place, so f.basename after rename is the NEW
	// basename, not the old one.
	const pathMap = new Map<string, string>(); // old path → new path
	const basenameMap = new Map<string, string>(); // old basename → new basename
	for (const f of fountainFiles) {
		const oldPath = f.path;
		const oldBasename = f.basename;
		const newPath = `${oldPath}.md`;
		if (plugin.app.vault.getAbstractFileByPath(newPath)) {
			result.skippedConflicts.push(oldPath);
			continue;
		}
		await plugin.app.fileManager.renameFile(f, newPath);
		pathMap.set(oldPath, newPath);
		basenameMap.set(oldBasename, `${oldBasename}.fountain`);
		result.renamedCount += 1;
	}

	// Step 3: update Longform's scenes: array entries.
	const scenes = readScenesArray(plugin.app, project.indexFilePath);
	const newScenes = scenes.map((entry) => basenameMap.get(entry) ?? entry);
	const arrayChanged = scenes.some((s, i) => s !== newScenes[i]);
	if (arrayChanged) {
		await writeScenesArray(plugin.app, project.indexFilePath, newScenes);
		result.scenesArrayUpdated = newScenes.filter((s, i) => s !== scenes[i]).length;
	}

	// Step 4: update intra-project markdown links to renamed files.
	const linkResult = await rewriteLinksAcrossProject(plugin.app, project, pathMap);
	result.linksUpdatedFiles = linkResult.filesModified;
	result.linksUpdatedTotal = linkResult.totalReplacements;

	return result;
}

function collectFountainFiles(app: App, fountainFolderPath: string): TFile[] {
	const folder = app.vault.getAbstractFileByPath(fountainFolderPath);
	if (!(folder instanceof TFolder)) return [];
	const out: TFile[] = [];
	for (const child of folder.children) {
		if (child instanceof TFile && child.extension === "fountain") {
			out.push(child);
		}
	}
	return out;
}

// ── link rewrite pass ────────────────────────────────────────────────────

interface LinkRewriteResult {
	filesModified: number;
	totalReplacements: number;
}

async function rewriteLinksAcrossProject(
	app: App,
	project: ProjectMeta,
	pathMap: Map<string, string>,
): Promise<LinkRewriteResult> {
	const out: LinkRewriteResult = { filesModified: 0, totalReplacements: 0 };
	if (pathMap.size === 0) return out;

	const root = app.vault.getAbstractFileByPath(project.projectRootPath);
	if (!(root instanceof TFolder)) return out;

	const candidates: TFile[] = [];
	walkForLinks(root, candidates);

	for (const file of candidates) {
		const content = await app.vault.read(file);
		const { rewritten, count } = applyLinkRewrites(content, pathMap, file.path);
		if (count === 0) continue;
		await app.vault.modify(file, rewritten);
		out.filesModified += 1;
		out.totalReplacements += count;
	}
	return out;
}

function walkForLinks(folder: TFolder, out: TFile[]): void {
	for (const child of folder.children) {
		if (child instanceof TFolder) {
			if (SKIP_FOLDERS_FOR_LINKS.has(child.name)) continue;
			walkForLinks(child, out);
			continue;
		}
		if (child instanceof TFile && child.extension === "md") {
			out.push(child);
		}
	}
}

interface LinkRewriteContent {
	rewritten: string;
	count: number;
}

// Replace markdown-link targets (the URL inside parens) that point at any of
// the renamed files. Match on the relative-path SUFFIX rather than the full
// vault path, since intra-project links use relative paths. For each renamed
// file, we add `.md` to any link whose target ends with `<basename>.fountain`.
function applyLinkRewrites(
	content: string,
	pathMap: Map<string, string>,
	containingFilePath: string,
): LinkRewriteContent {
	let out = content;
	let count = 0;

	for (const [oldPath, newPath] of pathMap) {
		const oldRelative = relativeFromFile(containingFilePath, oldPath);
		const newRelative = relativeFromFile(containingFilePath, newPath);

		// Match the link target inside markdown-link parens: [text](target)
		// Also match wikilinks: [[target]] and [[target|alias]]
		// We're targeting both the absolute-vault and relative forms.
		const escapedOld = escapeRegExp(oldPath);
		const escapedRel = escapeRegExp(oldRelative);

		const mdLink = new RegExp(`\\]\\(((?:${escapedOld})|(?:${escapedRel}))\\)`, "g");
		const wiki = new RegExp(`\\[\\[((?:${escapedOld})|(?:${escapedRel}))(\\|[^\\]]+)?\\]\\]`, "g");

		out = out.replace(mdLink, (_match, target: string) => {
			count += 1;
			const replacement = target === oldPath ? newPath : newRelative;
			return `](${replacement})`;
		});
		out = out.replace(wiki, (_match, target: string, alias?: string) => {
			count += 1;
			const replacement = target === oldPath ? newPath : newRelative;
			return `[[${replacement}${alias ?? ""}]]`;
		});
	}
	return { rewritten: out, count };
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

// ── confirmation modal ───────────────────────────────────────────────────

function confirmMigration(app: App, count: number): Promise<boolean> {
	return new Promise((resolve) => {
		new MigrationConfirmModal(app, count, resolve).open();
	});
}

class MigrationConfirmModal extends Modal {
	private finished = false;
	constructor(
		app: App,
		private readonly count: number,
		private readonly done: (proceed: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Migrate scene files?" });
		contentEl.createEl("p", {
			text: `${this.count} .fountain file(s) will be renamed to .fountain.md. Each file is auto-snapshotted before rename, so the migration is reversible via Browse file versions.`,
		});
		contentEl.createEl("p", {
			text: "The project index and Markdown links inside the project will be updated to match.",
		});

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.finish(false));
		const ok = buttons.createEl("button", { text: "Migrate", cls: "mod-cta" });
		ok.addEventListener("click", () => this.finish(true));
	}

	private finish(proceed: boolean): void {
		this.finished = true;
		this.done(proceed);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.finished) this.done(false);
	}
}
