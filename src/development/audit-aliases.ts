import { App, Modal, Notice, TFile } from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { characterRoster } from "../views/lookups";
import {
	auditAliases,
	type AliasAuditResult,
	type AliasCollision,
	type AliasRedundancy,
} from "./alias-collisions";

// "Audit alias collisions" command — scans the active project's combined
// character roster (episode + series for TV; just the project for
// features) and surfaces any aliases that clash with another character.
//
// Two-tier output:
//   - Notice with a count (so the user knows what happened immediately).
//   - Modal listing every collision + every same-character redundancy,
//     with per-character "Open" links so the user can jump to the
//     offending file and fix in place.

export function runAuditAliasesCommand(plugin: FirstDraftPlugin): void {
	const active = plugin.app.workspace.getActiveFile();
	if (!active) {
		new Notice("Open a file inside a project first.");
		return;
	}
	const project = resolveActiveProject(active, plugin.scanner);
	if (!project) {
		new Notice("Active file isn't inside a recognised project.");
		return;
	}
	const cfg = resolveProjectSettings(project, plugin.settings);
	const roster = characterRoster(plugin.app, project, cfg);
	const result = auditAliases(roster);

	const total = result.collisions.length + result.redundancies.length;
	if (total === 0) {
		new Notice("No alias collisions or redundancies found.");
		return;
	}

	new Notice(
		`Found ${result.collisions.length} collision${result.collisions.length === 1 ? "" : "s"}` +
			(result.redundancies.length > 0
				? ` and ${result.redundancies.length} redundant alias${result.redundancies.length === 1 ? "" : "es"}.`
				: "."),
		6000,
	);
	new AliasAuditModal(plugin.app, plugin, result).open();
}

class AliasAuditModal extends Modal {
	constructor(
		app: App,
		private readonly plugin: FirstDraftPlugin,
		private readonly result: AliasAuditResult,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("firstdraft-alias-audit");
		contentEl.createEl("h2", { text: "Alias audit" });

		if (this.result.collisions.length > 0) {
			contentEl.createEl("h3", {
				text: `Cross-character collisions (${this.result.collisions.length})`,
			});
			contentEl.createEl("p", {
				text: "Two or more characters claim the same name (whether as canonical or alias). Cue resolution can't disambiguate — rename one side.",
				cls: "firstdraft-alias-audit-help",
			});
			const list = contentEl.createEl("ul", {
				cls: "firstdraft-alias-audit-list",
			});
			for (const c of this.result.collisions) {
				this.renderCollision(list, c);
			}
		}

		if (this.result.redundancies.length > 0) {
			contentEl.createEl("h3", {
				text: `Redundant aliases (${this.result.redundancies.length})`,
			});
			contentEl.createEl("p", {
				text: "Aliases that match the character's own canonical name. Harmless but redundant — safe to remove.",
				cls: "firstdraft-alias-audit-help",
			});
			const list = contentEl.createEl("ul", {
				cls: "firstdraft-alias-audit-list",
			});
			for (const r of this.result.redundancies) {
				this.renderRedundancy(list, r);
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderCollision(parent: HTMLElement, collision: AliasCollision): void {
		const item = parent.createEl("li", {
			cls: "firstdraft-alias-audit-item",
		});
		const head = item.createDiv({ cls: "firstdraft-alias-audit-key" });
		head.createEl("code", { text: collision.key });
		const sub = item.createEl("ul", {
			cls: "firstdraft-alias-audit-claimants",
		});
		for (const claimant of collision.claimants) {
			const claimantItem = sub.createEl("li");
			this.renderOpenLink(claimantItem, claimant.entry.folderName, claimant.entry.canonicalFile);
			claimantItem.appendText(
				claimant.source === "canonical"
					? " — canonical"
					: ` — alias "${claimant.asWritten}"`,
			);
		}
	}

	private renderRedundancy(parent: HTMLElement, r: AliasRedundancy): void {
		const item = parent.createEl("li", {
			cls: "firstdraft-alias-audit-item",
		});
		this.renderOpenLink(item, r.entry.folderName, r.entry.canonicalFile);
		item.appendText(` — alias "${r.alias}" matches the canonical name.`);
	}

	private renderOpenLink(
		parent: HTMLElement,
		text: string,
		file: TFile | null,
	): void {
		if (!file) {
			parent.createEl("strong", { text });
			return;
		}
		const link = parent.createEl("a", {
			text,
			cls: "firstdraft-alias-audit-link",
			attr: { href: "#" },
		});
		link.addEventListener("click", (e) => {
			e.preventDefault();
			void this.plugin.app.workspace.getLeaf(false).openFile(file);
			this.close();
		});
	}
}
