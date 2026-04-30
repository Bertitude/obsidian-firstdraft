import { Notice } from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { sequencePairFromActive } from "../views/lookups";
import { normalizeSlugline } from "../cursor-scroll/slugline";

// Sync sluglines from fountain to dev note — the reverse of
// sync-sluglines.ts. Reads sluglines from the active sequence's fountain in
// document order and slots any missing ones into the dev note's slugline
// region so the dev-note ordering tracks the fountain.
//
//   - Manual / on-demand (not auto on save).
//   - Strictly additive: never reorders existing slug H2s, never modifies
//     their prose, never touches structural H2s (Sequence Overview / Notes
//     / Continuity / etc.).
//   - Each missing slug is inserted at a clean H2 boundary — immediately
//     BEFORE the H2 line of its fountain successor (the next slug in
//     fountain order that already exists in the dev note). Trailing missing
//     slugs (that come after every existing one) land at the end of the
//     slug region — i.e. before the first structural H2, or EOF if there
//     is none. This guarantees we never land between an existing slug and
//     the prose written under it.

const H2_RE = /^##\s+(.+?)\s*$/;
const SLUGLINE_RE = /^(INT|EXT|INT\.\/EXT|I\/E)[.\s]/i;

export async function runSyncSluglinesToDevNoteCommand(
	plugin: FirstDraftPlugin,
): Promise<void> {
	const active = plugin.app.workspace.getActiveFile();
	if (!active) {
		new Notice("No active file.");
		return;
	}

	const project = resolveActiveProject(active, plugin.scanner);
	if (!project) {
		new Notice("Active file isn't inside a recognised project.");
		return;
	}

	const pair = sequencePairFromActive(
		plugin.app,
		active,
		project,
		resolveProjectSettings(project, plugin.settings),
	);
	if (!pair) {
		new Notice("Active file isn't a sequence fountain or dev note.");
		return;
	}
	if (!pair.fountainFile) {
		new Notice("No paired fountain file.");
		return;
	}
	if (!pair.devNoteFile) {
		new Notice("No paired dev note. Create one first.");
		return;
	}

	const fountainText = await plugin.app.vault.read(pair.fountainFile);
	const fountainSluglines = extractFountainSluglines(fountainText);
	if (fountainSluglines.length === 0) {
		new Notice("No sluglines found in the fountain.");
		return;
	}

	const devNoteText = await plugin.app.vault.read(pair.devNoteFile);
	const result = mergeSluglines(devNoteText, fountainSluglines);

	if (result.added === 0) {
		new Notice("Dev note already has all sluglines from the fountain.");
		return;
	}

	await plugin.app.vault.modify(pair.devNoteFile, result.text);
	new Notice(
		`Added ${result.added} slugline${result.added === 1 ? "" : "s"} to dev note.`,
	);
}

function extractFountainSluglines(fountainText: string): string[] {
	// Mirrors slugline detection elsewhere — accepts the four standard
	// prefixes and forced sluglines (".LIMBO" → "LIMBO"). Forced sluglines
	// shed the leading dot so they round-trip as plain H2s in the dev note.
	const out: string[] = [];
	for (const raw of fountainText.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "") continue;
		if (line.startsWith(".") && !line.startsWith("..")) {
			out.push(line.slice(1).trim());
			continue;
		}
		if (SLUGLINE_RE.test(line)) out.push(line);
	}
	return out;
}

function isSluglineHeading(heading: string): boolean {
	const h = heading.startsWith(".") ? heading.slice(1).trim() : heading;
	return SLUGLINE_RE.test(h);
}

interface MergeResult {
	text: string;
	added: number;
}

export function mergeSluglines(
	devNoteText: string,
	fountainSluglines: string[],
): MergeResult {
	// Trim trailing whitespace so a sole-EOF append doesn't produce a
	// double blank line. We re-add a single trailing newline at the end.
	const trimmed = devNoteText.replace(/\s+$/, "");
	const lines = trimmed === "" ? [] : trimmed.split(/\r?\n/);

	// Map every H2 line to its kind. We consider an H2 "structural" when
	// it doesn't look like a slug — i.e. headings like "Sequence Overview",
	// "Notes", "Continuity". Existing slug H2s are anchors that fountain-
	// missing slugs may cluster against.
	const slugIndexByKey = new Map<string, number>(); // normalized → line index of H2
	const structuralH2Lines: number[] = [];
	const slugH2Lines: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = H2_RE.exec(lines[i] ?? "");
		if (!m || !m[1]) continue;
		const heading = m[1].trim();
		if (isSluglineHeading(heading)) {
			const key = normalizeSlugline(heading);
			if (!slugIndexByKey.has(key)) slugIndexByKey.set(key, i);
			slugH2Lines.push(i);
		} else {
			structuralH2Lines.push(i);
		}
	}

	// Where do trailing missing slugs go? Right before the first structural
	// H2 that comes AFTER the last existing slug, OR before the first
	// structural H2 if there are no existing slugs, OR EOF.
	const lastSlugLine = slugH2Lines.length > 0
		? slugH2Lines[slugH2Lines.length - 1]!
		: -1;
	const trailingAnchor = (() => {
		const after = structuralH2Lines.find((i) => i > lastSlugLine);
		if (after !== undefined) return after;
		return lines.length; // EOF
	})();

	// Walk fountain order. For each missing slug, find its successor that
	// exists in the dev note. The insertion line for that slug is the
	// successor's H2 line (insert BEFORE), or the trailing anchor if no
	// existing successor. Missing slugs grouped by insertion line keep
	// fountain order within the group.
	const insertionsByLine = new Map<number, string[]>();
	let added = 0;

	for (let i = 0; i < fountainSluglines.length; i++) {
		const slug = fountainSluglines[i]!;
		if (slugIndexByKey.has(normalizeSlugline(slug))) continue;

		let successorLine: number | null = null;
		for (let j = i + 1; j < fountainSluglines.length; j++) {
			const candidate = slugIndexByKey.get(
				normalizeSlugline(fountainSluglines[j]!),
			);
			if (candidate !== undefined) {
				successorLine = candidate;
				break;
			}
		}

		const insertAt = successorLine ?? trailingAnchor;
		const bucket = insertionsByLine.get(insertAt) ?? [];
		bucket.push(slug);
		insertionsByLine.set(insertAt, bucket);
		added++;
	}

	if (added === 0) return { text: devNoteText, added: 0 };

	// Materialise. Walk the original lines, emitting any insertion block
	// before the matching line index. A block is `## SLUG` followed by a
	// blank line; multiple blocks at the same anchor stack in fountain order.
	// At EOF we emit any remaining block. We also ensure there's a clean
	// blank-line separator between the trailing block and whatever preceded
	// it, since the original document might end without one.
	const out: string[] = [];
	for (let i = 0; i <= lines.length; i++) {
		const block = insertionsByLine.get(i);
		if (block) {
			if (i === lines.length) {
				// Trailing append at EOF — make sure we don't glue onto
				// content. The original document ends with `lines[length-1]`;
				// if that line is non-empty, separate with a blank line.
				const last = out[out.length - 1] ?? "";
				if (out.length > 0 && last !== "") out.push("");
			}
			for (const slug of block) {
				out.push(`## ${slug}`);
				out.push("");
			}
		}
		if (i < lines.length) out.push(lines[i]!);
	}

	return { text: out.join("\n"), added };
}
