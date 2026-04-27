import { TFile, TFolder, normalizePath } from "obsidian";
import type { App } from "obsidian";

// Per-file snapshot primitive. Used by Promote in Phase 3a.1 to auto-snapshot
// outlines before promoting; surfaced as a user-facing command in Phase 3a.2.
//
// Layout: snapshots live in a `_versions/` folder next to the original file.
// Filename convention: `<original basename> — <label>.<ext>` with a literal
// em-dash separator (visually distinct from regular dashes in titles).

const VERSIONS_FOLDER = "_versions";
const SEPARATOR = " — ";

export interface SnapshotResult {
	snapshotPath: string;
	createdAt: Date;
}

export async function snapshotFile(
	app: App,
	source: TFile,
	label: string,
): Promise<SnapshotResult> {
	const parent = source.parent;
	if (!parent) throw new Error("Cannot snapshot a file with no parent folder");

	const versionsPath = normalizePath(`${parent.path}/${VERSIONS_FOLDER}`);
	await ensureFolder(app, versionsPath);

	const safeLabel = sanitizeLabel(label);
	const snapshotName = `${source.basename}${SEPARATOR}${safeLabel}.${source.extension}`;
	const snapshotPath = normalizePath(`${versionsPath}/${snapshotName}`);

	// Avoid clobbering an existing snapshot with the same label by suffixing
	// `(2)`, `(3)` etc. — rare but possible when promoting twice on the same day.
	const finalPath = await ensureUnique(app, snapshotPath);

	const contents = await app.vault.read(source);
	await app.vault.create(finalPath, contents);

	return { snapshotPath: finalPath, createdAt: new Date() };
}

function sanitizeLabel(raw: string): string {
	const cleaned = raw
		.replace(/[\\/:*?"<>|]/g, "-")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned === "" ? "snapshot" : cleaned;
}

async function ensureFolder(app: App, path: string): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFolder) return;
	if (existing) throw new Error(`Cannot create snapshot folder, path is taken: ${path}`);
	await app.vault.createFolder(path);
}

async function ensureUnique(app: App, desired: string): Promise<string> {
	if (!app.vault.getAbstractFileByPath(desired)) return desired;

	const dot = desired.lastIndexOf(".");
	const stem = dot === -1 ? desired : desired.slice(0, dot);
	const ext = dot === -1 ? "" : desired.slice(dot);

	for (let i = 2; i < 100; i++) {
		const candidate = `${stem} (${i})${ext}`;
		if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
	}
	throw new Error("Too many existing snapshots with the same label");
}

export function todayLabel(d: Date = new Date()): string {
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}
