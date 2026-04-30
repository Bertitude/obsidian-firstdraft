import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { GlobalConfig, ProjectMeta } from "../types";
import {
	applyCleanup,
	scanForCleanup,
	type CleanupScan,
	type CleanupScope,
} from "./cleanup-sluglines";

// Confirmation modal for the "Clean up sluglines" command. Lets the user pick
// scope (active sequence vs whole project), shows a live count of sluglines
// that would be rewritten, and commits + auto-snapshots on Confirm.

export function openCleanupSluglinesModal(
	plugin: FirstDraftPlugin,
	active: TFile,
	project: ProjectMeta,
	cfg: GlobalConfig,
): void {
	new CleanupSluglinesModal(plugin.app, plugin, active, project, cfg).open();
}

class CleanupSluglinesModal extends Modal {
	// Renamed from `scope` to avoid colliding with Modal's keymap-scope field.
	private cleanupScope: CleanupScope = "active";
	private scan: CleanupScan | null = null;
	private summaryEl: HTMLElement | null = null;
	private confirmBtn: HTMLButtonElement | null = null;
	private scanInProgress = false;

	constructor(
		app: App,
		private readonly plugin: FirstDraftPlugin,
		private readonly active: TFile,
		private readonly project: ProjectMeta,
		private readonly cfg: GlobalConfig,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Clean up sluglines" });
		contentEl.createEl("p", {
			text: "Normalize prefix, casing, sub-location delimiter, and time-separator spacing. Auto-snapshots every changed file before rewriting.",
			cls: "firstdraft-cleanup-help",
		});

		new Setting(contentEl)
			.setName("Scope")
			.setDesc("Active sequence: just this fountain + its dev note. Whole project: every fountain in the project + paired dev notes.")
			.addDropdown((d) => {
				d.addOption("active", "Active sequence");
				d.addOption("project", "Whole project");
				d.setValue(this.cleanupScope).onChange((v) => {
					this.cleanupScope = v as CleanupScope;
					void this.refreshScan();
				});
			});

		const summary = contentEl.createDiv({ cls: "firstdraft-cleanup-summary" });
		this.summaryEl = summary;
		summary.setText("Scanning…");

		const buttons = new Setting(contentEl);
		buttons.addButton((b) =>
			b.setButtonText("Cancel").onClick(() => this.close()),
		);
		buttons.addButton((b) => {
			b.setButtonText("Confirm")
				.setCta()
				.onClick(() => {
					void this.commit();
				});
			this.confirmBtn = b.buttonEl;
			b.buttonEl.disabled = true;
		});

		void this.refreshScan();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async refreshScan(): Promise<void> {
		if (this.scanInProgress) return;
		this.scanInProgress = true;
		if (this.summaryEl) this.summaryEl.setText("Scanning…");
		if (this.confirmBtn) this.confirmBtn.disabled = true;
		try {
			this.scan = await scanForCleanup(
				this.plugin,
				this.active,
				this.project,
				this.cfg,
				this.cleanupScope,
			);
			this.renderSummary();
		} catch (e) {
			if (this.summaryEl) {
				this.summaryEl.setText(`Scan failed: ${(e as Error).message}`);
			}
		} finally {
			this.scanInProgress = false;
		}
	}

	private renderSummary(): void {
		const summary = this.summaryEl;
		const scan = this.scan;
		if (!summary || !scan) return;
		summary.empty();

		if (scan.totalSluglines === 0) {
			summary.setText("No sluglines need normalizing.");
			if (this.confirmBtn) this.confirmBtn.disabled = true;
			return;
		}

		const fileCount = scan.files.length;
		summary.createEl("p", {
			text: `${scan.totalSluglines} slugline${scan.totalSluglines === 1 ? "" : "s"} in ${fileCount} file${fileCount === 1 ? "" : "s"} will be rewritten.`,
		});

		// Show first few sample diffs so the user can sanity-check before
		// confirming. Capped to keep the modal compact even on big rewrites.
		const sampleWrap = summary.createDiv({ cls: "firstdraft-cleanup-samples" });
		sampleWrap.createEl("div", {
			text: "Sample changes:",
			cls: "firstdraft-cleanup-samples-label",
		});
		const list = sampleWrap.createEl("ul", { cls: "firstdraft-cleanup-samples-list" });
		const SAMPLE_LIMIT = 6;
		let shown = 0;
		outer: for (const fc of scan.files) {
			for (const change of fc.changes) {
				if (shown >= SAMPLE_LIMIT) break outer;
				const li = list.createEl("li");
				li.createEl("code", { text: change.beforeLine });
				li.appendText("  →  ");
				li.createEl("code", { text: change.afterLine });
				shown++;
			}
		}
		if (scan.totalSluglines > SAMPLE_LIMIT) {
			sampleWrap.createEl("div", {
				text: `… and ${scan.totalSluglines - SAMPLE_LIMIT} more`,
				cls: "firstdraft-cleanup-samples-more",
			});
		}

		if (this.confirmBtn) this.confirmBtn.disabled = false;
	}

	private async commit(): Promise<void> {
		const scan = this.scan;
		if (!scan || scan.totalSluglines === 0) return;
		if (this.confirmBtn) this.confirmBtn.disabled = true;
		try {
			await applyCleanup(this.plugin, scan);
			new Notice(
				`Cleaned ${scan.totalSluglines} slugline${scan.totalSluglines === 1 ? "" : "s"} across ${scan.files.length} file${scan.files.length === 1 ? "" : "s"}.`,
			);
			this.close();
		} catch (e) {
			new Notice(`Cleanup failed: ${(e as Error).message}`);
			if (this.confirmBtn) this.confirmBtn.disabled = false;
		}
	}
}
