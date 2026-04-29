import { App, Modal, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { snapshotFile, todayLabel } from "../versioning/snapshot";
import { parseTreatmentBeats, titleToFilename } from "./parser";
import { applyId, generateUniqueId } from "../utils/stable-id";
import { appendSceneToArray } from "../longform/scenes-array";
import { fountainScenesArrayEntry } from "../fountain/file-detection";

// "Make sequences from treatment": parses the active treatment's H2 beats and
// creates matching dev notes in Development/Sequences/. Auto-snapshots the
// treatment before any changes; never overwrites existing dev notes; updates
// the treatment's frontmatter (`status`, `promoted_at`) afterwards.

interface PromoteSummary {
	created: number;
	skipped: number;
	createdPaths: string[];
}

export async function runPromoteTreatmentCommand(plugin: FirstDraftPlugin): Promise<void> {
	const file = plugin.app.workspace.getActiveFile();
	if (!file || file.extension !== "md") {
		new Notice("Open a Markdown treatment first.");
		return;
	}

	const project = resolveActiveProject(file, plugin.scanner);
	if (!project) {
		new Notice("This treatment isn't inside a known project.");
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
		const summary = await promoteTreatment(plugin, file, project);
		const msg = summaryMessage(summary);
		new Notice(msg);
	} catch (e) {
		new Notice(`Promote failed: ${(e as Error).message}`);
	}
}

async function promoteTreatment(
	plugin: FirstDraftPlugin,
	treatment: TFile,
	project: ProjectMeta,
): Promise<PromoteSummary> {
	const cfg = resolveProjectSettings(project, plugin.settings);
	const scenesFolder = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.sequencesSubfolder}`,
	);

	const markdown = await plugin.app.vault.read(treatment);
	const beats = parseTreatmentBeats(markdown);
	if (beats.length === 0) {
		throw new Error("No H2 beats found in this treatment");
	}

	// Snapshot first — if this fails we abort before touching anything.
	await snapshotFile(plugin.app, treatment, `promoted ${todayLabel()}`);

	await ensureFolderExists(plugin.app, scenesFolder);

	const summary: PromoteSummary = { created: 0, skipped: 0, createdPaths: [] };

	// Auto-generate stable IDs for each new scene. Existing scenes (already in
	// the folder) keep their existing IDs / lack thereof; we only assign IDs to
	// freshly-created files.
	const usedIds = new Set<string>();

	for (const beat of beats) {
		const filename = titleToFilename(beat.title);
		if (!filename) {
			summary.skipped += 1;
			continue;
		}
		const id = generateUniqueId(usedIds);
		usedIds.add(id);
		const finalName = applyId(filename, id);
		const path = normalizePath(`${scenesFolder}/${finalName}.md`);
		if (plugin.app.vault.getAbstractFileByPath(path)) {
			summary.skipped += 1;
			continue;
		}
		const body = injectIntent(cfg.sceneNoteTemplate, beat.body);
		const created = await plugin.app.vault.create(path, body);
		await plugin.app.fileManager.processFrontMatter(created, (fm: Record<string, unknown>) => {
			fm.id = id;
		});
		// Add to sequences: immediately so the scene is in the project as soon
		// as it's promoted — even before the user creates the paired fountain.
		// Idempotent; rename-sync's auto-inject on fountain create is a no-op
		// if the entry already exists.
		const arrayEntry = fountainScenesArrayEntry(finalName, cfg.fountainFileFormat);
		await appendSceneToArray(plugin.app, project.indexFilePath, arrayEntry);
		summary.created += 1;
		summary.createdPaths.push(path);
	}

	await plugin.app.fileManager.processFrontMatter(treatment, (fm: Record<string, unknown>) => {
		fm.type = "treatment";
		fm.status = "promoted";
		fm.promoted_at = todayLabel();
	});

	return summary;
}

// Replaces the empty "## Sequence Overview\n\n## Notes" block in the scene template
// with the treatment beat's prose, leaving the rest of the template intact. Falls
// back to appending the prose if the expected section header isn't present.
// Tolerates the legacy "Sequence intent" label for projects whose templates
// were authored before the rename.
function injectIntent(template: string, prose: string): string {
	if (prose.trim() === "") return template;
	const re = /(## Sequence (?:Overview|intent)\n)\n(## )/;
	if (re.test(template)) {
		return template.replace(re, `$1\n${prose.trim()}\n\n$2`);
	}
	return template + `\n## Sequence Overview\n\n${prose.trim()}\n`;
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
		contentEl.createEl("h3", { text: "Re-make sequences?" });

		const dateText =
			typeof this.promotedAt === "string" && this.promotedAt.trim() !== ""
				? `Sequences were last made from this treatment on ${this.promotedAt}.`
				: "Sequences have already been made from this treatment.";
		contentEl.createEl("p", { text: dateText });
		contentEl.createEl("p", {
			text: "Re-running will only create sequences for beats that don't already have a dev note. Existing sequences won't be touched.",
		});

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.finish(false));
		const ok = buttons.createEl("button", { text: "Make", cls: "mod-cta" });
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

// ── Create treatment command ───────────────────────────────────────────────

export async function runCreateTreatmentCommand(plugin: FirstDraftPlugin): Promise<void> {
	const active = plugin.app.workspace.getActiveFile();
	const project = active ? resolveActiveProject(active, plugin.scanner) : null;
	if (!project) {
		new Notice("Open a file inside a project first, then run create treatment.");
		return;
	}

	const cfg = resolveProjectSettings(project, plugin.settings);
	const folder = normalizePath(`${project.projectRootPath}/${cfg.developmentFolder}`);
	await ensureFolderExists(plugin.app, folder);

	const desiredPath = normalizePath(`${folder}/Treatment.md`);
	const path = await uniqueTreatmentPath(plugin.app, desiredPath);

	const { TREATMENT_TEMPLATE } = await import("../settings/defaults");
	const created = await plugin.app.vault.create(path, TREATMENT_TEMPLATE);
	await plugin.app.workspace.getLeaf(false).openFile(created);
	new Notice("Treatment created.");
}

async function uniqueTreatmentPath(app: App, desired: string): Promise<string> {
	if (!app.vault.getAbstractFileByPath(desired)) return desired;

	const dot = desired.lastIndexOf(".");
	const stem = dot === -1 ? desired : desired.slice(0, dot);
	const ext = dot === -1 ? "" : desired.slice(dot);
	for (let i = 2; i < 100; i++) {
		const candidate = `${stem} ${i}${ext}`;
		if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
	}
	throw new Error("Too many existing treatments");
}
