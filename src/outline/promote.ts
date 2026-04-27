import { App, Modal, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "../projects/resolver";
import { snapshotFile, todayLabel } from "../versioning/snapshot";
import { parseOutlineBeats, titleToFilename } from "./parser";

// "Promote outline to scenes": parses the active outline's H2 beats and creates
// matching dev notes in Development/Scenes/. Auto-snapshots the outline before
// any changes; never overwrites existing dev notes; updates the outline's
// frontmatter (`status`, `promoted_at`) afterwards.

interface PromoteSummary {
	created: number;
	skipped: number;
	createdPaths: string[];
}

export async function runPromoteOutlineCommand(plugin: FirstDraftPlugin): Promise<void> {
	const file = plugin.app.workspace.getActiveFile();
	if (!file || file.extension !== "md") {
		new Notice("Open a Markdown outline first.");
		return;
	}

	const project = resolveActiveProject(file, plugin.scanner);
	if (!project) {
		new Notice("This outline isn't inside a known project.");
		return;
	}

	const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
	const previouslyPromoted =
		typeof fm.status === "string" && fm.status.toLowerCase() === "promoted";

	if (previouslyPromoted) {
		const proceed = await confirmRepromote(plugin.app, fm.promoted_at);
		if (!proceed) return;
	}

	try {
		const summary = await promoteOutline(plugin, file, project.projectRootPath);
		const msg = summaryMessage(summary);
		new Notice(msg);
	} catch (e) {
		new Notice(`Promote failed: ${(e as Error).message}`);
	}
}

async function promoteOutline(
	plugin: FirstDraftPlugin,
	outline: TFile,
	projectRootPath: string,
): Promise<PromoteSummary> {
	const cfg = plugin.settings.global;
	const scenesFolder = normalizePath(
		`${projectRootPath}/${cfg.developmentFolder}/${cfg.scenesSubfolder}`,
	);

	const markdown = await plugin.app.vault.read(outline);
	const beats = parseOutlineBeats(markdown);
	if (beats.length === 0) {
		throw new Error("No H2 beats found in this outline");
	}

	// Snapshot first — if this fails we abort before touching anything.
	await snapshotFile(plugin.app, outline, `promoted ${todayLabel()}`);

	await ensureFolderExists(plugin.app, scenesFolder);

	const summary: PromoteSummary = { created: 0, skipped: 0, createdPaths: [] };

	for (const beat of beats) {
		const filename = titleToFilename(beat.title);
		if (!filename) {
			summary.skipped += 1;
			continue;
		}
		const path = normalizePath(`${scenesFolder}/${filename}.md`);
		if (plugin.app.vault.getAbstractFileByPath(path)) {
			summary.skipped += 1;
			continue;
		}
		const body = injectIntent(cfg.sceneNoteTemplate, beat.body);
		await plugin.app.vault.create(path, body);
		summary.created += 1;
		summary.createdPaths.push(path);
	}

	await plugin.app.fileManager.processFrontMatter(outline, (fm: Record<string, unknown>) => {
		fm.type = "outline";
		fm.status = "promoted";
		fm.promoted_at = todayLabel();
	});

	return summary;
}

// Replaces the empty "## Sequence intent\n\n## Notes" block in the scene template
// with the outline beat's prose, leaving the rest of the template intact. Falls
// back to appending the prose if the expected section header isn't present.
function injectIntent(template: string, prose: string): string {
	if (prose.trim() === "") return template;
	const re = /(## Sequence intent\n)\n(## )/;
	if (re.test(template)) {
		return template.replace(re, `$1\n${prose.trim()}\n\n$2`);
	}
	return template + `\n## Sequence intent\n\n${prose.trim()}\n`;
}

async function ensureFolderExists(app: App, path: string): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFolder) return;
	if (existing) throw new Error(`Path exists but is not a folder: ${path}`);
	await app.vault.createFolder(path);
}

function summaryMessage(s: PromoteSummary): string {
	if (s.created === 0 && s.skipped === 0) return "Nothing to promote.";
	if (s.created === 0) return `Nothing new — ${s.skipped} beat(s) already had scenes.`;
	const skippedSuffix = s.skipped > 0 ? `, skipped ${s.skipped} existing` : "";
	return `Promoted ${s.created} scene(s)${skippedSuffix}.`;
}

// ── Re-promote confirmation modal ────────────────────────────────────────

function confirmRepromote(app: App, promotedAt: unknown): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new RepromoteConfirmModal(app, promotedAt, resolve);
		modal.open();
	});
}

class RepromoteConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly promotedAt: unknown,
		private readonly done: (proceed: boolean) => void,
	) {
		super(app);
	}

	private finished = false;

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Re-promote outline?" });

		const dateText =
			typeof this.promotedAt === "string" && this.promotedAt.trim() !== ""
				? `This outline was promoted on ${this.promotedAt}.`
				: "This outline has already been promoted.";
		contentEl.createEl("p", { text: dateText });
		contentEl.createEl("p", {
			text: "Re-running will only create scenes for beats that don't already have a dev note. Existing scenes won't be touched.",
		});

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.finish(false));
		const ok = buttons.createEl("button", { text: "Promote", cls: "mod-cta" });
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

// ── Create outline command ───────────────────────────────────────────────

export async function runCreateOutlineCommand(plugin: FirstDraftPlugin): Promise<void> {
	const active = plugin.app.workspace.getActiveFile();
	const project = active ? resolveActiveProject(active, plugin.scanner) : null;
	if (!project) {
		new Notice("Open a file inside a project first, then run create outline.");
		return;
	}

	const cfg = plugin.settings.global;
	const folder = normalizePath(`${project.projectRootPath}/${cfg.developmentFolder}`);
	await ensureFolderExists(plugin.app, folder);

	const desiredPath = normalizePath(`${folder}/Outline.md`);
	const path = await uniqueOutlinePath(plugin.app, desiredPath);

	const { OUTLINE_TEMPLATE } = await import("../settings/defaults");
	const created = await plugin.app.vault.create(path, OUTLINE_TEMPLATE);
	await plugin.app.workspace.getLeaf(false).openFile(created);
	new Notice("Outline created.");
}

async function uniqueOutlinePath(app: App, desired: string): Promise<string> {
	if (!app.vault.getAbstractFileByPath(desired)) return desired;

	const dot = desired.lastIndexOf(".");
	const stem = dot === -1 ? desired : desired.slice(0, dot);
	const ext = dot === -1 ? "" : desired.slice(dot);
	for (let i = 2; i < 100; i++) {
		const candidate = `${stem} ${i}${ext}`;
		if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
	}
	throw new Error("Too many existing outlines");
}
