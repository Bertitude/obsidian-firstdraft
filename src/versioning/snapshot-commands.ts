import { App, Notice, SuggestModal, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import type { ProjectMeta } from "../types";
import { snapshotFile, todayLabel } from "./snapshot";
import { promptForLabel } from "./prompt";

const VERSIONS_FOLDER = "_versions";
const SEPARATOR = " — ";

// ── Snapshot active file ─────────────────────────────────────────────────

export async function runSnapshotFileCommand(plugin: FirstDraftPlugin): Promise<void> {
	const file = plugin.app.workspace.getActiveFile();
	if (!file) {
		new Notice("No active file to snapshot.");
		return;
	}
	const label = await promptForLabel(plugin.app, {
		title: `Snapshot ${file.basename}`,
		placeholder: "Label for this snapshot",
		defaultValue: todayLabel(),
	});
	if (!label) return;

	try {
		const result = await snapshotFile(plugin.app, file, label);
		new Notice(`Snapshot saved: ${basename(result.snapshotPath)}`);
	} catch (e) {
		new Notice(`Snapshot failed: ${(e as Error).message}`);
	}
}

// ── Snapshot project ─────────────────────────────────────────────────────

export async function runSnapshotProjectCommand(plugin: FirstDraftPlugin): Promise<void> {
	const active = plugin.app.workspace.getActiveFile();
	const project = active ? resolveActiveProject(active, plugin.scanner) : null;
	if (!project) {
		new Notice("Open a file inside a project before snapshotting.");
		return;
	}
	const label = await promptForLabel(plugin.app, {
		title: "Snapshot project draft",
		placeholder: "e.g. pre-rewrite, second draft",
		defaultValue: todayLabel(),
	});
	if (!label) return;

	try {
		const count = await snapshotProject(plugin, project, label);
		new Notice(`Project snapshot saved (${count} files).`);
	} catch (e) {
		new Notice(`Project snapshot failed: ${(e as Error).message}`);
	}
}

async function snapshotProject(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	label: string,
): Promise<number> {
	const cfg = resolveProjectSettings(project, plugin.settings);
	const safeLabel = sanitizeLabel(label);
	const draftsRoot = normalizePath(`${project.projectRootPath}/Drafts/${safeLabel}`);

	const finalRoot = await ensureUniqueFolder(plugin.app, draftsRoot);

	const sources = [
		project.sequenceFolderPath, // configured fountain folder
		normalizePath(`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.sequencesSubfolder}`),
	];

	let copied = 0;
	for (const src of sources) {
		const folder = plugin.app.vault.getAbstractFileByPath(src);
		if (!(folder instanceof TFolder)) continue;
		const relTarget = src.startsWith(project.projectRootPath + "/")
			? src.slice(project.projectRootPath.length + 1)
			: src;
		const targetRoot = normalizePath(`${finalRoot}/${relTarget}`);
		copied += await copyFolderContents(plugin.app, folder, targetRoot);
	}

	return copied;
}

async function copyFolderContents(
	app: App,
	source: TFolder,
	targetPath: string,
): Promise<number> {
	let copied = 0;
	for (const child of source.children) {
		if (child instanceof TFolder) {
			// Skip _versions/ subfolders inside the snapshot — we don't want a snapshot
			// of a snapshot.
			if (child.name === VERSIONS_FOLDER) continue;
			const sub = normalizePath(`${targetPath}/${child.name}`);
			copied += await copyFolderContents(app, child, sub);
		} else if (child instanceof TFile) {
			await ensureFolder(app, targetPath);
			const dest = normalizePath(`${targetPath}/${child.name}`);
			if (app.vault.getAbstractFileByPath(dest)) continue;
			await app.vault.copy(child, dest);
			copied += 1;
		}
	}
	return copied;
}

// ── Browse versions of active file ───────────────────────────────────────

export async function runBrowseVersionsCommand(plugin: FirstDraftPlugin): Promise<void> {
	const file = plugin.app.workspace.getActiveFile();
	if (!file) {
		new Notice("Open a file to browse its versions.");
		return;
	}
	const versions = listVersions(plugin.app, file);
	if (versions.length === 0) {
		new Notice("No snapshots yet for this file.");
		return;
	}
	new VersionPickerModal(plugin, file, versions, "open").open();
}

// ── Restore active file from a snapshot ──────────────────────────────────

export async function runRestoreFromSnapshotCommand(plugin: FirstDraftPlugin): Promise<void> {
	const file = plugin.app.workspace.getActiveFile();
	if (!file) {
		new Notice("Open a file to restore.");
		return;
	}
	const versions = listVersions(plugin.app, file);
	if (versions.length === 0) {
		new Notice("No snapshots to restore from.");
		return;
	}
	new VersionPickerModal(plugin, file, versions, "restore").open();
}

interface VersionEntry {
	file: TFile;
	label: string;
	mtime: number;
}

function listVersions(app: App, source: TFile): VersionEntry[] {
	const parent = source.parent;
	if (!parent) return [];
	const versionsFolder = app.vault.getAbstractFileByPath(
		normalizePath(`${parent.path}/${VERSIONS_FOLDER}`),
	);
	if (!(versionsFolder instanceof TFolder)) return [];

	const prefix = `${source.basename}${SEPARATOR}`;
	const out: VersionEntry[] = [];
	for (const child of versionsFolder.children) {
		if (!(child instanceof TFile)) continue;
		if (child.extension !== source.extension) continue;
		if (!child.basename.startsWith(prefix)) continue;
		const label = child.basename.slice(prefix.length);
		out.push({ file: child, label, mtime: child.stat.mtime });
	}
	out.sort((a, b) => b.mtime - a.mtime);
	return out;
}

class VersionPickerModal extends SuggestModal<VersionEntry> {
	constructor(
		private readonly plugin: FirstDraftPlugin,
		private readonly source: TFile,
		private readonly versions: VersionEntry[],
		private readonly mode: "open" | "restore",
	) {
		super(plugin.app);
		this.setPlaceholder(
			mode === "open" ? "Pick a version to open" : "Pick a version to restore",
		);
	}

	getSuggestions(query: string): VersionEntry[] {
		const q = query.toLowerCase().trim();
		if (q === "") return this.versions;
		return this.versions.filter((v) => v.label.toLowerCase().includes(q));
	}

	renderSuggestion(value: VersionEntry, el: HTMLElement): void {
		el.createEl("div", { text: value.label, cls: "firstdraft-version-label" });
		const sub = el.createEl("div", { cls: "firstdraft-version-meta" });
		sub.setText(new Date(value.mtime).toLocaleString());
	}

	onChooseSuggestion(value: VersionEntry): void {
		if (this.mode === "open") {
			void this.plugin.app.workspace.getLeaf(false).openFile(value.file);
			return;
		}
		void this.restoreFromSnapshot(value);
	}

	private async restoreFromSnapshot(version: VersionEntry): Promise<void> {
		try {
			// Auto-snapshot current state first so the user can never lose
			// in-progress work to a restore.
			await snapshotFile(this.plugin.app, this.source, `pre-restore ${todayLabel()}`);
			const contents = await this.plugin.app.vault.read(version.file);
			await this.plugin.app.vault.modify(this.source, contents);
			new Notice(`Restored from "${version.label}". Previous state saved as a snapshot.`);
		} catch (e) {
			new Notice(`Restore failed: ${(e as Error).message}`);
		}
	}
}

// ── helpers ──────────────────────────────────────────────────────────────

function sanitizeLabel(raw: string): string {
	const cleaned = raw
		.replace(/[\\/:*?"<>|]/g, "-")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned === "" ? "snapshot" : cleaned;
}

function basename(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? path : path.slice(i + 1);
}

async function ensureFolder(app: App, path: string): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFolder) return;
	if (existing) throw new Error(`Path exists but is not a folder: ${path}`);
	await app.vault.createFolder(path);
}

async function ensureUniqueFolder(app: App, desired: string): Promise<string> {
	if (!app.vault.getAbstractFileByPath(desired)) {
		await app.vault.createFolder(desired);
		return desired;
	}
	for (let i = 2; i < 100; i++) {
		const candidate = `${desired} (${i})`;
		if (!app.vault.getAbstractFileByPath(candidate)) {
			await app.vault.createFolder(candidate);
			return candidate;
		}
	}
	throw new Error("Too many existing snapshots with the same label");
}
