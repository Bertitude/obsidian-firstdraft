import {
	App,
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	Notice,
	TFile,
	TFolder,
	normalizePath,
} from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "../projects/resolver";
import { buildExpandedRoster, sceneDevNotePath } from "../views/lookups";
import { sanitizeFilename, toTitleCase } from "../utils/sanitize";

// Suggests character names when the cursor is on a character-cue line in a
// fountain file. Roster combines three sources: folders in
// Development/Characters/, names already in the active scene dev note's
// characters: array, and cues parsed from every fountain in the project.
//
// When the typed cue doesn't match any roster entry, a "Create character"
// option appears at the bottom of the list. Selecting it scaffolds the
// folder + canonical doc, then proceeds as if the entry existed.
//
// On selection: insert the uppercase cue + newline (cursor lands on the
// dialogue line below), and silent-sync the name to the dev note's
// characters: array. Folder casing is preferred so frontmatter reads as
// `[Marcus, Diana]` rather than `[MARCUS, DIANA]`.

const SCENE_HEADING_RE = /^(INT|EXT|INT\.\/EXT|I\/E)[.\s]/i;
const CUE_RE = /^[A-Z][A-Z\s]*$/;
const CREATE_ENTRY_MIN_QUERY_LENGTH = 2;

type SuggestEntry =
	| { kind: "existing"; name: string; folderCasing: string | null }
	| { kind: "create"; name: string };

export class CharacterCueSuggest extends EditorSuggest<SuggestEntry> {
	private readonly fountainCueCache = new Map<string, string[]>();

	constructor(private readonly plugin: FirstDraftPlugin) {
		super(plugin.app);

		// Invalidate the cue cache when fountain files change/rename/delete so
		// suggestions always reflect what's actually written.
		plugin.registerEvent(
			plugin.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension === "fountain") {
					this.fountainCueCache.delete(file.path);
				}
			}),
		);
		plugin.registerEvent(
			plugin.app.vault.on("delete", (file) => {
				if (file instanceof TFile && file.extension === "fountain") {
					this.fountainCueCache.delete(file.path);
				}
			}),
		);
		plugin.registerEvent(
			plugin.app.vault.on("rename", (_file, oldPath) => {
				this.fountainCueCache.delete(oldPath);
			}),
		);
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor,
		file: TFile | null,
	): EditorSuggestTriggerInfo | null {
		if (!file || file.extension !== "fountain") return null;

		const line = editor.getLine(cursor.line);
		const upToCursor = line.substring(0, cursor.ch);

		// Cue text proper is everything before the first `(` (parenthetical extension).
		const cueText = upToCursor.split("(")[0]?.trimEnd() ?? "";
		if (cueText.length === 0) return null;
		if (!CUE_RE.test(cueText)) return null;
		if (SCENE_HEADING_RE.test(cueText)) return null;

		// Previous line must be blank — except when we're on line 0.
		if (cursor.line > 0) {
			const prev = editor.getLine(cursor.line - 1);
			if (prev.trim() !== "") return null;
		}

		return {
			start: { line: cursor.line, ch: 0 },
			end: cursor,
			query: cueText,
		};
	}

	async getSuggestions(context: EditorSuggestContext): Promise<SuggestEntry[]> {
		const project = resolveActiveProject(context.file, this.plugin.scanner);
		if (!project) return [];

		const cfg = this.plugin.settings.global;
		const devNoteRef = sceneDevNotePath(context.file, project, cfg);

		const roster = await buildExpandedRoster(
			this.plugin.app,
			project,
			cfg,
			devNoteRef.file,
			this.fountainCueCache,
			context.file?.path,
		);

		const q = context.query.toUpperCase();
		const matches = roster.filter((r) => r.name.startsWith(q));

		const result: SuggestEntry[] = matches.map((r) => ({
			kind: "existing" as const,
			name: r.name,
			folderCasing: r.folderCasing,
		}));

		const hasExactMatch = matches.some((r) => r.name === q);
		if (!hasExactMatch && q.length >= CREATE_ENTRY_MIN_QUERY_LENGTH) {
			result.push({ kind: "create", name: q });
		}

		return result;
	}

	renderSuggestion(value: SuggestEntry, el: HTMLElement): void {
		el.addClass("firstdraft-character-suggestion");
		if (value.kind === "create") {
			el.addClass("firstdraft-character-suggestion-create");
			el.createSpan({
				cls: "firstdraft-character-suggestion-prefix",
				text: "Create character: ",
			});
			el.createSpan({ text: value.name });
		} else {
			el.setText(value.name);
		}
	}

	selectSuggestion(value: SuggestEntry, _evt: MouseEvent | KeyboardEvent): void {
		const ctx = this.context;
		if (!ctx) return;

		if (value.kind === "create") {
			void this.handleCreate(value.name, ctx);
			return;
		}
		this.handleSelectExisting(value, ctx);
	}

	private handleSelectExisting(
		value: { kind: "existing"; name: string; folderCasing: string | null },
		ctx: EditorSuggestContext,
	): void {
		ctx.editor.replaceRange(`${value.name}\n`, ctx.start, ctx.end);
		ctx.editor.setCursor({ line: ctx.start.line + 1, ch: 0 });
		const stored = value.folderCasing ?? value.name;
		void this.appendCharacterToDevNote(ctx.file, stored);
	}

	private async handleCreate(name: string, ctx: EditorSuggestContext): Promise<void> {
		const project = resolveActiveProject(ctx.file, this.plugin.scanner);
		if (!project) {
			new Notice("No project for this file — can't create a character.");
			return;
		}

		const cfg = this.plugin.settings.global;
		const sanitized = sanitizeFilename(name, cfg.filenameReplacementChar);
		if (!sanitized) {
			new Notice("Cue has no valid filename characters.");
			return;
		}
		const folderCasing = toTitleCase(sanitized);
		const charactersFolder = normalizePath(
			`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.charactersSubfolder}/${folderCasing}`,
		);
		const docPath = normalizePath(`${charactersFolder}/${folderCasing}.md`);

		try {
			await ensureFolderExists(this.plugin.app, charactersFolder);
			if (!this.plugin.app.vault.getAbstractFileByPath(docPath)) {
				await this.plugin.app.vault.create(docPath, cfg.characterNoteTemplate);
			}

			ctx.editor.replaceRange(`${name}\n`, ctx.start, ctx.end);
			ctx.editor.setCursor({ line: ctx.start.line + 1, ch: 0 });

			await this.appendCharacterToDevNote(ctx.file, folderCasing);
			new Notice(`Created character: ${folderCasing}`);
		} catch (e) {
			new Notice(`Could not create character: ${(e as Error).message}`);
		}
	}

	private async appendCharacterToDevNote(fountain: TFile, name: string): Promise<void> {
		const project = resolveActiveProject(fountain, this.plugin.scanner);
		if (!project) return;
		const cfg = this.plugin.settings.global;
		const ref = sceneDevNotePath(fountain, project, cfg);
		if (!ref.file) return;

		await this.plugin.app.fileManager.processFrontMatter(
			ref.file,
			(fm: Record<string, unknown>) => {
				const existing = Array.isArray(fm.characters)
					? (fm.characters as unknown[]).filter((v): v is string => typeof v === "string")
					: [];
				if (existing.some((n) => n.toUpperCase() === name.toUpperCase())) return;
				existing.push(name);
				fm.characters = existing;
			},
		);
	}
}

async function ensureFolderExists(app: App, path: string): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFolder) return;
	if (existing) throw new Error(`Path exists but is not a folder: ${path}`);
	await app.vault.createFolder(path);
}
