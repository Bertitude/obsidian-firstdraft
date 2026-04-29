import { App, Editor, Notice, SuggestModal, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { buildExpandedRoster, characterRoster, locationRoster, sequenceDevNotePath } from "../views/lookups";
import { sanitizeFilename, toTitleCase } from "../utils/sanitize";
import { linkifyEntity, type DevEntity } from "./linkify";
import { openCreateCharacterModal } from "./create-character-modal";
import { ensureEpisodeCharacterNote } from "./episode-character-notes";

// Plugin-mode-independent picker commands. These work in any editor regardless
// of which fountain plugin is active — they don't rely on EditorSuggest. The
// user binds a hotkey via Obsidian's Hotkeys settings; on invocation a
// SuggestModal opens with the roster + an inline "Create new" entry at the
// bottom (when query >= 2 chars and no exact match).
//
// Character cue insertion: NAME + newline (cursor on dialogue line below).
// Location reference insertion: NAME at cursor (no newline; locations get
// woven inline into action prose like "Marcus walks into THE OFFICE").

const CREATE_ENTRY_MIN_QUERY_LENGTH = 2;

type EntryKind = "character" | "location";

interface PickerEntry {
	kind: "existing" | "create";
	name: string;
	folderCasing: string | null;
}

export function runInsertCharacterCueCommand(plugin: FirstDraftPlugin): void {
	void openPicker(plugin, "character");
}

export function runInsertLocationReferenceCommand(plugin: FirstDraftPlugin): void {
	void openPicker(plugin, "location");
}

async function openPicker(plugin: FirstDraftPlugin, kind: EntryKind): Promise<void> {
	const editor = plugin.app.workspace.activeEditor?.editor;
	if (!editor) {
		// Most common cause: bgrundmann's fountain plugin uses a custom view
		// that doesn't expose a standard Editor. The picker only works in
		// editors that Obsidian recognises (markdown, or .fountain when
		// chuangcaleb mode is active and FirstDraft has registered the
		// extension to markdown view).
		new Notice(
			"This editor doesn't support insertion. Use a Markdown file, or switch to chuangcaleb mode.",
		);
		return;
	}

	const file = plugin.app.workspace.getActiveFile();
	const project = file ? resolveActiveProject(file, plugin.scanner) : null;
	if (!project) {
		new Notice("Open a file inside a project first.");
		return;
	}

	const cfg = resolveProjectSettings(project, plugin.settings);
	const devNoteRef = file ? sequenceDevNotePath(file, project, cfg) : null;
	const entries = await buildPickerRoster(plugin, project, kind, devNoteRef?.file ?? null);

	new InsertPickerModal(plugin, kind, entries, project, file, editor).open();
}

async function buildPickerRoster(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	kind: EntryKind,
	devNoteFile: TFile | null,
): Promise<PickerEntry[]> {
	const cfg = resolveProjectSettings(project, plugin.settings);
	if (kind === "character") {
		// Use the same expanded roster as Phase 4a (folders + dev note + cues).
		// Exclude the active fountain so the user's in-progress cue doesn't
		// suggest itself.
		const cache = new Map<string, string[]>();
		const activeFile = plugin.app.workspace.getActiveFile();
		const excludePath =
			activeFile && activeFile.extension === "fountain" ? activeFile.path : undefined;
		const roster = await buildExpandedRoster(
			plugin.app,
			project,
			cfg,
			devNoteFile,
			cache,
			excludePath,
		);
		return roster.map((r) => ({
			kind: "existing" as const,
			name: r.name,
			folderCasing: r.folderCasing,
		}));
	}

	// Locations: pulls from locationRoster (parent folders + sub-area files,
	// each scoped as PARENT or "PARENT - SUB"), plus any names already in the
	// active dev note's locations: array as a fallback.
	const map = new Map<string, PickerEntry>();

	for (const entry of locationRoster(plugin.app, project, cfg)) {
		map.set(entry.name, {
			kind: "existing",
			name: entry.name,
			folderCasing: entry.folderName,
		});
	}

	if (devNoteFile) {
		const fm = plugin.app.metadataCache.getFileCache(devNoteFile)?.frontmatter as
			| Record<string, unknown>
			| undefined;
		const locsArray = Array.isArray(fm?.locations) ? (fm?.locations as unknown[]) : [];
		const legacy = typeof fm?.location === "string" ? [fm.location] : [];
		for (const raw of [...locsArray, ...legacy]) {
			if (typeof raw !== "string") continue;
			const key = raw.trim().toUpperCase();
			if (key === "" || map.has(key)) continue;
			map.set(key, { kind: "existing", name: key, folderCasing: null });
		}
	}

	return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

class InsertPickerModal extends SuggestModal<PickerEntry> {
	constructor(
		private readonly plugin: FirstDraftPlugin,
		private readonly kind: EntryKind,
		private readonly roster: PickerEntry[],
		private readonly project: ProjectMeta,
		private readonly file: TFile | null,
		private readonly editor: Editor,
	) {
		super(plugin.app);
		this.setPlaceholder(
			kind === "character"
				? "Insert character cue — type to filter"
				: "Insert location — type to filter",
		);
	}

	getSuggestions(query: string): PickerEntry[] {
		const q = query.trim().toUpperCase();
		const matches = q === ""
			? this.roster
			: this.roster.filter((e) => e.name.startsWith(q));

		const result: PickerEntry[] = [...matches];
		const hasExact = matches.some((e) => e.name === q);
		if (!hasExact && q.length >= CREATE_ENTRY_MIN_QUERY_LENGTH) {
			result.push({ kind: "create", name: q, folderCasing: null });
		}
		return result;
	}

	renderSuggestion(value: PickerEntry, el: HTMLElement): void {
		el.addClass("firstdraft-picker-suggestion");
		if (value.kind === "create") {
			el.addClass("firstdraft-picker-suggestion-create");
			el.createSpan({
				cls: "firstdraft-picker-suggestion-prefix",
				text: this.kind === "character" ? "Create character: " : "Create location: ",
			});
			el.createSpan({ text: value.name });
		} else {
			el.setText(value.name);
		}
	}

	onChooseSuggestion(value: PickerEntry, _evt: MouseEvent | KeyboardEvent): void {
		if (value.kind === "create") {
			void this.handleCreate(value.name);
			return;
		}
		this.handleInsertExisting(value);
	}

	private handleInsertExisting(value: PickerEntry): void {
		this.insertAtCursor(value.name);
		const stored = value.folderCasing ?? value.name;
		void this.syncToDevNote(stored);
	}

	private async handleCreate(name: string): Promise<void> {
		const cfg = resolveProjectSettings(this.project, this.plugin.settings);
		const sanitized = sanitizeFilename(name, cfg.filenameReplacementChar);
		if (!sanitized) {
			new Notice(`No valid characters in name.`);
			return;
		}
		const folderCasing = toTitleCase(sanitized);

		// Characters route through the unified Create Character modal so the
		// file lands at series-level (when the active project is an episode
		// with a series root) and gets the roles: frontmatter populated. Same
		// flow as the palette + selection-create + autocomplete-create paths.
		if (this.kind === "character") {
			const result = await openCreateCharacterModal(this.plugin, folderCasing);
			if (!result) {
				// User cancelled the modal — still insert the cue so they don't
				// lose their typed text, but skip the entity-creation side
				// effects.
				this.insertAtCursor(name);
				return;
			}
			this.insertAtCursor(name);
			await this.syncToDevNote(result.displayName);
			new Notice(`Created character: ${result.displayName}`);

			const entity: DevEntity = {
				name: result.displayName,
				canonicalFilePath: result.file.path,
			};
			if (cfg.autoLinkifyOnCreate) {
				const linkifyResult = await linkifyEntity(this.plugin, this.project, entity);
				if (linkifyResult.totalReplacements > 0) {
					new Notice(
						`Linkified ${linkifyResult.totalReplacements} mention(s) across ${linkifyResult.filesModified} file(s).`,
					);
				} else {
					new Notice("No mentions to linkify.");
				}
			}
			return;
		}

		// Locations: keep the episode-scoped flow. Locations don't have a
		// series-level promotion model yet (recurring locations could land
		// there but the workflow isn't built out — defer).
		const folderPath = normalizePath(
			`${this.project.projectRootPath}/${cfg.developmentFolder}/${cfg.locationsSubfolder}/${folderCasing}`,
		);
		const docPath = normalizePath(`${folderPath}/${folderCasing}.md`);

		try {
			await ensureFolderExists(this.plugin.app, folderPath);
			const isNewFile = !this.plugin.app.vault.getAbstractFileByPath(docPath);
			if (isNewFile) {
				await this.plugin.app.vault.create(docPath, cfg.locationNoteTemplate);
			}
			this.insertAtCursor(name);
			await this.syncToDevNote(folderCasing);
			new Notice(`Created location: ${folderCasing}`);

			if (isNewFile) {
				const entity: DevEntity = { name: folderCasing, canonicalFilePath: docPath };
				if (cfg.autoLinkifyOnCreate) {
					const result = await linkifyEntity(this.plugin, this.project, entity);
					if (result.totalReplacements > 0) {
						new Notice(
							`Linkified ${result.totalReplacements} mention(s) across ${result.filesModified} file(s).`,
						);
					} else {
						new Notice("No mentions to linkify.");
					}
				}
			}
		} catch (e) {
			new Notice(`Could not create location: ${(e as Error).message}`);
		}
	}

	private insertAtCursor(name: string): void {
		// Characters: name + newline so cursor lands on dialogue line.
		// Locations: just the name; cursor stays in flow of action prose.
		const text = this.kind === "character" ? `${name}\n` : name;
		this.editor.replaceSelection(text);
	}

	private async syncToDevNote(name: string): Promise<void> {
		if (!this.file) return;
		const cfg = resolveProjectSettings(this.project, this.plugin.settings);
		const ref = sequenceDevNotePath(this.file, this.project, cfg);
		if (!ref.file) return;

		const field = this.kind === "character" ? "characters" : "locations";

		await this.plugin.app.fileManager.processFrontMatter(
			ref.file,
			(fm: Record<string, unknown>) => {
				const existing = Array.isArray(fm[field])
					? (fm[field] as unknown[]).filter((v): v is string => typeof v === "string")
					: [];
				if (existing.some((n) => n.toUpperCase() === name.toUpperCase())) return;
				existing.push(name);
				fm[field] = existing;
			},
		);

		// Auto-create the episode-specific character note when a character is
		// added to an episode's dev note. No-op for non-episode projects and
		// for locations.
		if (this.kind === "character") {
			await ensureEpisodeCharacterNote(this.plugin, this.project, name);
		}
	}
}

async function ensureFolderExists(app: App, path: string): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFolder) return;
	if (existing) throw new Error(`Path exists but is not a folder: ${path}`);
	await app.vault.createFolder(path);
}

// Suppress unused warning for characterRoster — exposed via lookups but not
// directly used here (we go through buildExpandedRoster instead).
void characterRoster;
