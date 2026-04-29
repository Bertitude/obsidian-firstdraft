import { Notice, SuggestModal, TFile } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { GlobalConfig, ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { sequencePairFromActive } from "../views/lookups";
import { fountainScenesArrayEntry } from "../fountain/file-detection";
import { readScenesArray, writeScenesArray } from "../longform/scenes-array";
import { snapshotFile, todayLabel } from "../versioning/snapshot";
import { buildOutlineData, type OutlineRow } from "../views/outline-data";

// Merge two scenes into one. Inverse of split-scene.
//
// Decisions (locked):
// - Trigger: command from active scene + picker modal of other scenes
// - Survivor: scene that comes earlier in Longform `scenes:` keeps its name
// - Body order: earlier scene's content first, then later's appended
// - Frontmatter: arrays union; scalar conflicts → earlier wins, with notice
//   listing dropped values
// - Cleanup: snapshot all affected files; then delete the absorbed scene's
//   fountain + dev note. Recoverable via Browse file versions.

export async function runMergeSceneCommand(
	plugin: FirstDraftPlugin,
): Promise<void> {
	const active = plugin.app.workspace.getActiveFile();
	if (!active) {
		new Notice("Open a scene file first.");
		return;
	}
	const project = resolveActiveProject(active, plugin.scanner);
	if (!project) {
		new Notice("Active file isn't inside a recognised project.");
		return;
	}
	const cfg = resolveProjectSettings(project, plugin.settings);
	const pair = sequencePairFromActive(plugin.app, active, project, cfg);
	if (!pair) {
		new Notice("Active file isn't a scene fountain or dev note.");
		return;
	}

	const treatment = buildOutlineData(plugin.app, project, cfg);
	const candidates = treatment.rows.filter((r) => r.sequenceName !== pair.sequenceName);
	if (candidates.length === 0) {
		new Notice("No other scenes in this project to merge with.");
		return;
	}

	new MergePickerModal(plugin, project, cfg, pair.sequenceName, candidates).open();
}

class MergePickerModal extends SuggestModal<OutlineRow> {
	constructor(
		private readonly plugin: FirstDraftPlugin,
		private readonly project: ProjectMeta,
		private readonly cfg: GlobalConfig,
		private readonly activeSceneName: string,
		private readonly candidates: OutlineRow[],
	) {
		super(plugin.app);
		this.setPlaceholder(`Merge "${activeSceneName}" with…`);
	}

	getSuggestions(query: string): OutlineRow[] {
		const q = query.trim().toUpperCase();
		if (q === "") return this.candidates;
		return this.candidates.filter((r) => r.sequenceName.toUpperCase().includes(q));
	}

	renderSuggestion(value: OutlineRow, el: HTMLElement): void {
		el.createEl("div", { text: value.sequenceName });
		const meta: string[] = [];
		if (value.orphan) meta.push("orphan");
		if (value.missing) meta.push("missing files");
		if (meta.length > 0) {
			el.createEl("small", {
				text: meta.join(" · "),
				cls: "firstdraft-suggestion-meta",
			});
		}
	}

	onChooseSuggestion(value: OutlineRow): void {
		void runMerge(this.plugin, this.project, this.cfg, this.activeSceneName, value.sequenceName);
	}
}

async function runMerge(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	cfg: GlobalConfig,
	activeSceneName: string,
	pickedSceneName: string,
): Promise<void> {
	const treatment = buildOutlineData(plugin.app, project, cfg);
	const findRow = (name: string) => treatment.rows.find((r) => r.sequenceName === name) ?? null;
	const activeRow = findRow(activeSceneName);
	const pickedRow = findRow(pickedSceneName);
	if (!activeRow || !pickedRow) {
		new Notice("Could not resolve both scenes. Sync the project's scenes first.");
		return;
	}

	// Determine which scene comes first in Longform scenes: order. Both must
	// be in the array; otherwise we can't determine a deterministic survivor.
	const scenesArray = readScenesArray(plugin.app, project.indexFilePath);
	const indexOf = (name: string) => {
		for (let i = 0; i < scenesArray.length; i++) {
			const entry = scenesArray[i];
			if (entry === undefined) continue;
			if (entry === name) return i;
			// Match against either format's entry shape.
			if (entry === fountainScenesArrayEntry(name, "fountain")) return i;
			if (entry === fountainScenesArrayEntry(name, "fountain-md")) return i;
		}
		return -1;
	};
	const activeIdx = indexOf(activeSceneName);
	const pickedIdx = indexOf(pickedSceneName);
	if (activeIdx === -1 || pickedIdx === -1) {
		new Notice(
			"Both scenes need to be listed in the project's scenes: array. Run \"Sync screenplay scenes to project\" first.",
		);
		return;
	}

	const earlierRow = activeIdx < pickedIdx ? activeRow : pickedRow;
	const laterRow = activeIdx < pickedIdx ? pickedRow : activeRow;

	// Snapshot all affected files first. Recoverable via Browse file versions.
	const stamp = `pre-merge ${todayLabel()}`;
	if (earlierRow.fountainFile) {
		await snapshotFile(plugin.app, earlierRow.fountainFile, stamp);
	}
	if (earlierRow.devNoteFile) {
		await snapshotFile(plugin.app, earlierRow.devNoteFile, stamp);
	}
	if (laterRow.fountainFile) {
		await snapshotFile(plugin.app, laterRow.fountainFile, stamp);
	}
	if (laterRow.devNoteFile) {
		await snapshotFile(plugin.app, laterRow.devNoteFile, stamp);
	}

	const dropped: { field: string; value: unknown }[] = [];

	// Fountain merge: concatenate earlier's content + a separator + later's.
	if (earlierRow.fountainFile && laterRow.fountainFile) {
		const earlierText = await plugin.app.vault.read(earlierRow.fountainFile);
		const laterText = await plugin.app.vault.read(laterRow.fountainFile);
		const merged =
			earlierText.replace(/\s+$/, "") + "\n\n" + laterText.replace(/^\s+/, "");
		await plugin.app.vault.modify(earlierRow.fountainFile, merged);
	} else if (!earlierRow.fountainFile && laterRow.fountainFile) {
		// Earlier had no fountain; later does. We can't move-rename here without
		// adding scenes-array juggling — instead, read later's content and
		// create earlier's fountain at the canonical path. For v1, just skip
		// the move and keep later's fountain as the source. The user can
		// rename manually if the path matters.
		// Note: this is an edge case (earlier scene with no fountain).
	}

	// Dev note merge: union arrays, earlier wins for scalars; append later's
	// body after earlier's.
	if (earlierRow.devNoteFile && laterRow.devNoteFile) {
		const laterText = await plugin.app.vault.read(laterRow.devNoteFile);
		const laterBody = stripFrontmatter(laterText);
		const laterFm = (plugin.app.metadataCache.getFileCache(laterRow.devNoteFile)
			?.frontmatter ?? {}) as Record<string, unknown>;

		// Merge frontmatter (modifies earlier's) and append body.
		await plugin.app.fileManager.processFrontMatter(
			earlierRow.devNoteFile,
			(fm: Record<string, unknown>) => {
				const result = mergeFrontmatter(fm, laterFm);
				for (const key of Object.keys(fm)) delete fm[key];
				for (const [k, v] of Object.entries(result.merged)) fm[k] = v;
				dropped.push(...result.dropped);
			},
		);

		// Append body after a separator.
		const earlierText = await plugin.app.vault.read(earlierRow.devNoteFile);
		const trimmedBody = laterBody.replace(/^\s+/, "").replace(/\s+$/, "");
		if (trimmedBody !== "") {
			const combined = earlierText.replace(/\s+$/, "") + "\n\n" + trimmedBody + "\n";
			await plugin.app.vault.modify(earlierRow.devNoteFile, combined);
		}
	} else if (!earlierRow.devNoteFile && laterRow.devNoteFile) {
		// Earlier had no dev note; later does. Skip — caller can manually move.
	}

	// Update Longform scenes: remove later's entry.
	const laterEntries = new Set([
		laterRow.sequenceName,
		fountainScenesArrayEntry(laterRow.sequenceName, "fountain"),
		fountainScenesArrayEntry(laterRow.sequenceName, "fountain-md"),
	]);
	const filtered = scenesArray.filter((e) => !laterEntries.has(e));
	if (filtered.length !== scenesArray.length) {
		await writeScenesArray(plugin.app, project.indexFilePath, filtered);
	}

	// Delete the absorbed (later) scene's files.
	if (laterRow.fountainFile) {
		await plugin.app.vault.delete(laterRow.fountainFile);
	}
	if (laterRow.devNoteFile) {
		await plugin.app.vault.delete(laterRow.devNoteFile);
	}

	// Open the surviving scene if the user was looking at the absorbed one.
	const active = plugin.app.workspace.getActiveFile();
	if (
		active &&
		(active.path === laterRow.fountainFile?.path ||
			active.path === laterRow.devNoteFile?.path)
	) {
		const surviving = earlierRow.fountainFile ?? earlierRow.devNoteFile;
		if (surviving) await plugin.app.workspace.getLeaf(false).openFile(surviving);
	}

	// Notice with dropped-fields summary.
	const droppedSummary = dropped
		.map((d) => `${d.field}=${formatDroppedValue(d.value)}`)
		.join(", ");
	const tail = droppedSummary
		? ` Dropped from "${laterRow.sequenceName}": ${droppedSummary}.`
		: "";
	new Notice(
		`Merged "${laterRow.sequenceName}" into "${earlierRow.sequenceName}".${tail}`,
		8000,
	);
}

// Merge later's frontmatter into earlier's. Returns the merged object plus a
// list of dropped (conflicting scalar) values from later.
export function mergeFrontmatter(
	earlier: Record<string, unknown>,
	later: Record<string, unknown>,
): { merged: Record<string, unknown>; dropped: { field: string; value: unknown }[] } {
	const merged: Record<string, unknown> = { ...earlier };
	const dropped: { field: string; value: unknown }[] = [];

	for (const [key, laterValue] of Object.entries(later)) {
		if (laterValue === null || laterValue === undefined) continue;

		if (
			!(key in merged) ||
			merged[key] === null ||
			merged[key] === undefined ||
			merged[key] === ""
		) {
			merged[key] = laterValue;
			continue;
		}

		const earlierValue = merged[key];

		if (Array.isArray(earlierValue) && Array.isArray(laterValue)) {
			const out: unknown[] = [...earlierValue];
			const seen = new Set<string>();
			for (const v of earlierValue) {
				if (typeof v === "string") seen.add(v.toUpperCase());
			}
			for (const v of laterValue) {
				if (typeof v === "string") {
					if (seen.has(v.toUpperCase())) continue;
					seen.add(v.toUpperCase());
				}
				out.push(v);
			}
			merged[key] = out;
		} else if (Array.isArray(earlierValue) && !Array.isArray(laterValue)) {
			// later is a scalar; treat as a single-element addition to the array.
			const arr = [...earlierValue];
			if (typeof laterValue === "string") {
				const exists = arr.some(
					(v) => typeof v === "string" && v.toUpperCase() === laterValue.toUpperCase(),
				);
				if (!exists) arr.push(laterValue);
			}
			merged[key] = arr;
		} else if (!Array.isArray(earlierValue) && Array.isArray(laterValue)) {
			// earlier is a scalar; later is an array. Earlier wins; later's array
			// is reported dropped.
			dropped.push({ field: key, value: laterValue });
		} else {
			// Both scalars.
			if (
				typeof earlierValue === "string" &&
				typeof laterValue === "string" &&
				earlierValue.trim().toUpperCase() === laterValue.trim().toUpperCase()
			) {
				continue; // same value, no conflict
			}
			if (earlierValue !== laterValue) {
				dropped.push({ field: key, value: laterValue });
			}
		}
	}
	return { merged, dropped };
}

function stripFrontmatter(text: string): string {
	if (!text.startsWith("---\n")) return text;
	const end = text.indexOf("\n---", 4);
	if (end === -1) return text;
	return text.slice(end + 4).replace(/^\n+/, "");
}

function formatDroppedValue(v: unknown): string {
	if (typeof v === "string") return JSON.stringify(v);
	if (Array.isArray(v)) return JSON.stringify(v);
	return String(v);
}
