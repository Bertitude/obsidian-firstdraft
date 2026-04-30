import {
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	Notice,
	TFile,
	normalizePath,
} from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { isFountainFile } from "../fountain/file-detection";
import { locationRoster } from "../views/lookups";
import { openCreateLocationModal } from "../development/create-location-modal";

// Slugline autocomplete. Fires on:
//
//   - Fountain files (`.fountain` and `.fountain.md`) when the cursor sits on
//     a slug-shaped line: starts with INT./EXT./INT./EXT./I/E. prefix.
//   - Sequence dev notes — markdown files inside <project>/<dev>/<sequencesSubfolder>/
//     — on H2 lines where the heading text is shaped like a slug. The H2 form
//     is what users author in the dev note before syncing to the paired
//     fountain (or before atomize promotes them).
//
// Three sub-stages within a single composing slugline, dispatched by what's
// already typed on the line:
//
//   Stage 1 — Location: cursor is positioned after the INT./EXT. prefix and
//             the slug doesn't yet contain " - ". Suggest the project's
//             location roster + a "Create new <typed>" entry that opens the
//             standard Create Location modal.
//
//   Stage 2 — Time of day: cursor is positioned after a " - " separator
//             (the LAST one if the location itself contains " - ", per the
//             SMITH HOUSE - KITCHEN convention). Suggest the standard time-
//             of-day vocabulary plus whatever the user has typed (so custom
//             times still work).
//
// Industry-standard time vocabulary, sourced from the screenplay-format
// references at the top of the slugline branch:
//
//   Canonical:     DAY, NIGHT
//   Time passage:  CONTINUOUS, LATER, MOMENTS LATER, SAME TIME
//   Specific:      MORNING, DAWN, DUSK, SUNSET, EVENING, LATE AFTERNOON,
//                  GOLDEN HOUR, MAGIC HOUR

const INTEXT_PREFIX_RE = /^(INT\.?\s*\/\s*EXT\.?|I\s*\/\s*E\.?|INT\.?|EXT\.?)\s+/i;
const H2_PREFIX_RE = /^##\s+/;

const TIME_OF_DAY_PRESETS: string[] = [
	"DAY",
	"NIGHT",
	"CONTINUOUS",
	"LATER",
	"MOMENTS LATER",
	"SAME TIME",
	"MORNING",
	"DAWN",
	"DUSK",
	"SUNSET",
	"EVENING",
	"LATE AFTERNOON",
	"GOLDEN HOUR",
	"MAGIC HOUR",
];

type Stage = "location" | "time";

interface SuggestEntry {
	stage: Stage;
	kind: "existing" | "create" | "time";
	text: string;        // what gets inserted at the cursor
	display: string;     // what shows in the dropdown row
	subtext?: string;    // optional secondary line (e.g. parent location)
}

export class SluglineSuggest extends EditorSuggest<SuggestEntry> {
	constructor(private readonly plugin: FirstDraftPlugin) {
		super(plugin.app);
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor,
		file: TFile | null,
	): EditorSuggestTriggerInfo | null {
		if (!file) return null;
		const ctxKind = this.contextKind(file);
		if (!ctxKind) return null;

		const line = editor.getLine(cursor.line);
		const upToCursor = line.substring(0, cursor.ch);

		// In dev-note context, a slugline lives on an H2 line. Strip the
		// leading `## ` so the rest of the parsing matches the fountain case.
		let body = upToCursor;
		let lineOffset = 0;
		if (ctxKind === "dev-note") {
			const m = H2_PREFIX_RE.exec(body);
			if (!m) return null;
			lineOffset = m[0].length;
			body = body.slice(m[0].length);
		}

		const prefixMatch = INTEXT_PREFIX_RE.exec(body);
		if (!prefixMatch) return null;
		const afterPrefix = body.slice(prefixMatch[0].length);

		// Split on the LAST " - " — anything before it is location (which can
		// itself contain " - " for parent/sub patterns like SMITH HOUSE -
		// KITCHEN), anything after is the time-of-day query.
		const dashIdx = afterPrefix.lastIndexOf(" - ");
		if (dashIdx === -1) {
			// Stage 1 — location. Trigger range = the location query (text
			// after the INT./EXT. prefix up to cursor).
			return {
				start: { line: cursor.line, ch: lineOffset + prefixMatch[0].length },
				end: cursor,
				query: afterPrefix,
			};
		}

		// Stage 2 — time of day. Trigger range = the text after the last " - ".
		const timeQuery = afterPrefix.slice(dashIdx + 3);
		return {
			start: {
				line: cursor.line,
				ch: lineOffset + prefixMatch[0].length + dashIdx + 3,
			},
			end: cursor,
			query: timeQuery,
		};
	}

	getSuggestions(context: EditorSuggestContext): SuggestEntry[] {
		const stage: Stage = this.detectStage(context);
		const q = context.query.trim().toUpperCase();

		if (stage === "location") {
			return this.locationSuggestions(context, q);
		}
		return this.timeSuggestions(q);
	}

	renderSuggestion(value: SuggestEntry, el: HTMLElement): void {
		el.addClass("firstdraft-slugline-suggestion");
		if (value.kind === "create") {
			el.addClass("firstdraft-slugline-suggestion-create");
		}
		el.createDiv({ text: value.display });
		if (value.subtext) {
			el.createDiv({
				text: value.subtext,
				cls: "firstdraft-slugline-suggestion-meta",
			});
		}
	}

	selectSuggestion(value: SuggestEntry, _evt: MouseEvent | KeyboardEvent): void {
		const ctx = this.context;
		if (!ctx) return;

		if (value.kind === "create") {
			void this.handleCreateLocation(value.text, ctx);
			return;
		}

		// Replace the trigger range with the picked text. For locations we
		// append a " - " so the user moves directly into the time-of-day
		// stage (the next character types triggers the time suggester). For
		// time-of-day, just insert the picked value (no trailing space — the
		// slug ends here).
		const insert =
			value.stage === "location" ? `${value.text} - ` : value.text;
		ctx.editor.replaceRange(insert, ctx.start, ctx.end);
		// Keep the cursor at the end of the inserted text so subsequent
		// typing flows naturally into the next stage.
		const newCh = ctx.start.ch + insert.length;
		ctx.editor.setCursor({ line: ctx.start.line, ch: newCh });
	}

	// ── helpers ─────────────────────────────────────────────────────────

	// Detect which stage the trigger belongs to by inspecting the line at
	// the trigger's start position. If the trigger range starts AFTER a
	// " - " separator, we're at the time stage; otherwise the location
	// stage.
	private detectStage(ctx: EditorSuggestContext): Stage {
		const line = ctx.editor.getLine(ctx.start.line);
		const before = line.substring(0, ctx.start.ch);
		// If the text immediately preceding the trigger is " - ", we're at
		// the time stage. Otherwise location.
		if (before.endsWith(" - ")) return "time";
		return "location";
	}

	private locationSuggestions(
		ctx: EditorSuggestContext,
		query: string,
	): SuggestEntry[] {
		const file = ctx.file;
		const project = resolveActiveProject(file, this.plugin.scanner);
		if (!project) return [];
		const cfg = resolveProjectSettings(project, this.plugin.settings);
		const roster = locationRoster(this.plugin.app, project, cfg);

		const entries: SuggestEntry[] = [];
		for (const loc of roster) {
			if (query !== "" && !loc.name.includes(query)) continue;
			entries.push({
				stage: "location",
				kind: "existing",
				text: loc.name,
				display: loc.name,
				subtext: loc.parentLocation ? `inside ${loc.parentLocation}` : undefined,
			});
		}

		// Always offer "Create new" if the user has typed something AND it
		// doesn't already match an existing entry exactly. The created
		// location lands at series-level via the standard Create Location
		// modal flow.
		const trimmed = query.trim();
		if (trimmed.length >= 2 && !entries.some((e) => e.text === trimmed)) {
			entries.push({
				stage: "location",
				kind: "create",
				text: trimmed,
				display: `Create new location: ${trimmed}`,
			});
		}

		return entries;
	}

	private timeSuggestions(query: string): SuggestEntry[] {
		const filtered = query === ""
			? TIME_OF_DAY_PRESETS
			: TIME_OF_DAY_PRESETS.filter((t) => t.includes(query));

		const entries: SuggestEntry[] = filtered.map((t) => ({
			stage: "time",
			kind: "time",
			text: t,
			display: t,
		}));

		// Honour custom typed values that aren't presets — let the user's
		// query be a one-off (e.g. "PRE-DAWN").
		const trimmed = query.trim();
		if (trimmed.length > 0 && !TIME_OF_DAY_PRESETS.includes(trimmed)) {
			entries.unshift({
				stage: "time",
				kind: "time",
				text: trimmed,
				display: `${trimmed} (custom)`,
			});
		}

		return entries;
	}

	// Create a new location via the standard Create Location modal. On
	// success, replace the trigger range with the created location's name +
	// " - " so the user flows into the time-of-day stage.
	private async handleCreateLocation(
		typed: string,
		ctx: EditorSuggestContext,
	): Promise<void> {
		const result = await openCreateLocationModal(this.plugin, typed);
		if (!result) return;
		const insert = `${result.displayName.toUpperCase()} - `;
		ctx.editor.replaceRange(insert, ctx.start, ctx.end);
		const newCh = ctx.start.ch + insert.length;
		ctx.editor.setCursor({ line: ctx.start.line, ch: newCh });
	}

	// Determine whether the active file is a context where slugline
	// autocomplete should fire. Returns the context kind, or null when no
	// trigger should occur.
	private contextKind(file: TFile): "fountain" | "dev-note" | null {
		if (isFountainFile(file)) return "fountain";
		if (file.extension !== "md") return null;
		const project = resolveActiveProject(file, this.plugin.scanner);
		if (!project) return null;
		const cfg = resolveProjectSettings(project, this.plugin.settings);
		const devSequencesPath = normalizePath(
			`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.sequencesSubfolder}`,
		);
		// Sequence dev note: lives at <devSeq>/<name>.md (flat) or
		// <devSeq>/<stem>/<stem>.md (atomized folder shape). Either way the
		// path starts with <devSeq>/.
		if (file.path === devSequencesPath || file.path.startsWith(devSequencesPath + "/")) {
			return "dev-note";
		}
		return null;
	}
}

// Placeholder so the import surface stays explicit if a future caller wants
// to inject custom contexts. Currently unused.
void Notice;
