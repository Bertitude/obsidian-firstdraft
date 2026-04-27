import {
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	TFile,
} from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "../projects/resolver";
import { characterRoster, sceneDevNotePath } from "../views/lookups";

// Suggests character names when the cursor is on a character-cue line in a
// fountain file. A character cue is recognised when:
//   1. The line above is blank (or this is the very first line)
//   2. The line so far is uppercase letters / spaces only (an optional
//      parenthetical like (V.O.) is allowed AFTER the name, not within it)
//   3. The line doesn't start with a scene-heading prefix (INT., EXT., etc.)
//
// On selection: insert the chosen name, drop a newline so the cursor lands
// where dialogue starts, and append the name to the matching scene dev note's
// `characters:` frontmatter array (so the dev notes panel and treatment view
// stay in sync without manual edits).

const SCENE_HEADING_RE = /^(INT|EXT|INT\.\/EXT|I\/E)[.\s]/i;
const CUE_RE = /^[A-Z][A-Z\s]*$/;

export class CharacterCueSuggest extends EditorSuggest<string> {
	constructor(private readonly plugin: FirstDraftPlugin) {
		super(plugin.app);
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor,
		file: TFile | null,
	): EditorSuggestTriggerInfo | null {
		if (!file || file.extension !== "fountain") return null;

		const line = editor.getLine(cursor.line);
		const upToCursor = line.substring(0, cursor.ch);

		// Don't suggest after a parenthetical extension — the cue text proper
		// is everything before the first "(".
		const cueText = upToCursor.split("(")[0]?.trimEnd() ?? "";
		if (cueText.length === 0) return null;
		if (!CUE_RE.test(cueText)) return null;
		if (SCENE_HEADING_RE.test(cueText)) return null;

		// Previous non-empty character must be the start of the line OR a blank
		// line above. Treat first line of file as if it had a blank above.
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

	getSuggestions(context: EditorSuggestContext): string[] {
		const project = resolveActiveProject(context.file, this.plugin.scanner);
		if (!project) return [];
		const cfg = this.plugin.settings.global;
		const roster = characterRoster(this.app, project, cfg);
		const q = context.query.toUpperCase();
		return roster.map((c) => c.name).filter((name) => name.startsWith(q));
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.addClass("firstdraft-character-suggestion");
		el.setText(value);
	}

	selectSuggestion(value: string, _evt: MouseEvent | KeyboardEvent): void {
		const ctx = this.context;
		if (!ctx) return;
		const editor = ctx.editor;

		// Replace the partial cue with the full uppercase name + a trailing
		// newline so the cursor lands on the dialogue line.
		editor.replaceRange(`${value}\n`, ctx.start, ctx.end);
		editor.setCursor({ line: ctx.start.line + 1, ch: 0 });

		// Best-effort sync to the dev note frontmatter; failures are silent so a
		// missing dev note doesn't interrupt drafting.
		void this.appendCharacterToDevNote(ctx.file, value);
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
