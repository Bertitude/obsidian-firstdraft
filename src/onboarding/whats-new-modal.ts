import { App, Modal, Setting } from "obsidian";
import { type ReleaseEntry } from "./release-notes";

// What's-new modal. Renders one section per release between the user's
// last-seen version and the current manifest version (newest first).
// Bullet form, short user-visible highlights only.

export function openWhatsNewModal(
	app: App,
	releases: ReleaseEntry[],
	currentVersion: string,
): void {
	new WhatsNewModal(app, releases, currentVersion).open();
}

class WhatsNewModal extends Modal {
	constructor(
		app: App,
		private readonly releases: ReleaseEntry[],
		private readonly currentVersion: string,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("firstdraft-whatsnew");

		contentEl.createEl("h2", { text: "What's new" });

		if (this.releases.length === 0) {
			contentEl.createEl("p", {
				text: "You're up to date. No release notes to show.",
				cls: "firstdraft-whatsnew-empty",
			});
		} else {
			for (const release of this.releases) {
				this.renderRelease(release);
			}
		}

		new Setting(contentEl).addButton((b) => {
			b.setButtonText("Got it")
				.setCta()
				.onClick(() => this.close());
			setTimeout(() => b.buttonEl.focus(), 0);
		});

		contentEl.createEl("div", {
			text: `FirstDraft v${this.currentVersion}`,
			cls: "firstdraft-whatsnew-version",
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderRelease(release: ReleaseEntry): void {
		const block = this.contentEl.createDiv({
			cls: "firstdraft-whatsnew-release",
		});
		const head = block.createEl("h3", {
			cls: "firstdraft-whatsnew-release-head",
		});
		head.createSpan({
			text: `v${release.version}`,
			cls: "firstdraft-whatsnew-version-tag",
		});
		head.createSpan({
			text: ` — ${release.title}`,
			cls: "firstdraft-whatsnew-release-title",
		});
		head.createSpan({
			text: ` · ${release.date}`,
			cls: "firstdraft-whatsnew-release-date",
		});
		const list = block.createEl("ul", {
			cls: "firstdraft-whatsnew-list",
		});
		for (const highlight of release.highlights) {
			list.createEl("li", { text: highlight });
		}
	}
}
