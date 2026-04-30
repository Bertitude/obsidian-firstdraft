import { App, Modal, Setting } from "obsidian";

// First-install welcome modal. Mirrors the README's Quick Start in a
// compact form so a new user can get from "plugin enabled" to "first
// scene" without leaving Obsidian. Manual re-open is wired to the
// "Show welcome" command for users who want to revisit it.

const README_URL =
	"https://github.com/Bertitude/obsidian-firstdraft#readme";

export function openWelcomeModal(app: App, currentVersion: string): void {
	new WelcomeModal(app, currentVersion).open();
}

class WelcomeModal extends Modal {
	constructor(
		app: App,
		private readonly currentVersion: string,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("firstdraft-welcome");

		contentEl.createEl("h2", { text: "Welcome to FirstDraft" });
		contentEl.createEl("p", {
			text: "A screenwriting companion for Obsidian. Pairs each fountain script file with a development note, autocompletes character cues and slug-lines, and gives you an outlining ladder from Series Outline down to scene fountain files.",
			cls: "firstdraft-welcome-tagline",
		});

		this.section("Companion plugins (recommended)");
		const compList = contentEl.createEl("ul", {
			cls: "firstdraft-welcome-list",
		});
		const fountainItem = compList.createEl("li");
		fountainItem.createEl("strong", { text: "Fountain Editor" });
		fountainItem.appendText(" (chuangcaleb) — renders ");
		fountainItem.createEl("code", { text: ".fountain.md" });
		fountainItem.appendText(
			" files and powers FirstDraft's autocomplete inside the editor.",
		);
		const longformItem = compList.createEl("li");
		longformItem.createEl("strong", { text: "Longform" });
		longformItem.appendText(
			" — compiles the project's sequence files into one manuscript. FirstDraft writes Longform-compatible frontmatter automatically.",
		);

		this.section("Feature flow (3 steps)");
		const featList = contentEl.createEl("ol", {
			cls: "firstdraft-welcome-list",
		});
		featList.createEl("li", {
			text: "Run \"Create FirstDraft project\" → pick Feature → enter title.",
		});
		featList.createEl("li", {
			text: "Open Treatment.md — write one H2 per sequence (with as much prose under each as you want).",
		});
		featList.createEl("li", {
			text: "Run \"Make sequences from treatment\" — fountain files + paired dev notes are scaffolded for each H2. Open one and start drafting.",
		});

		this.section("Series flow (3 steps)");
		const seriesList = contentEl.createEl("ol", {
			cls: "firstdraft-welcome-list",
		});
		seriesList.createEl("li", {
			text: "Run \"Create FirstDraft project\" → pick Series → enter title.",
		});
		seriesList.createEl("li", {
			text: "Open Series Outline.md → write H2 per season → run \"Make seasons from outline\". Each season gets its own Index + Season Outline.",
		});
		seriesList.createEl("li", {
			text: "Inside a season, open Season Outline.md → H2 per episode → \"Make episodes from outline\". Episodes use the same Treatment → Make sequences flow as features.",
		});

		this.section("Find more");
		const more = contentEl.createEl("p", { cls: "firstdraft-welcome-more" });
		more.appendText("The full README covers commands, settings, and edge cases: ");
		const link = more.createEl("a", {
			text: "FirstDraft on GitHub",
			attr: { href: README_URL, target: "_blank", rel: "noopener" },
		});
		link.addClass("firstdraft-welcome-link");
		more.appendText(".");
		contentEl.createEl("p", {
			text: 'You can re-open this guide any time via the command palette: "Show welcome".',
			cls: "firstdraft-welcome-help",
		});

		new Setting(contentEl).addButton((b) => {
			b.setButtonText("Got it")
				.setCta()
				.onClick(() => this.close());
			setTimeout(() => b.buttonEl.focus(), 0);
		});

		// Footer with the version so users know which build they're on.
		contentEl.createEl("div", {
			text: `FirstDraft v${this.currentVersion}`,
			cls: "firstdraft-welcome-version",
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private section(title: string): void {
		this.contentEl.createEl("h3", {
			text: title,
			cls: "firstdraft-welcome-section",
		});
	}
}
