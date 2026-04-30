import { App, Editor, Modal, Notice, Setting, SuggestModal, TFile } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { characterRoster, sequencePairFromActive, type CharacterEntry } from "../views/lookups";
import { linkifyEntity, type DevEntity, type LinkifyResult } from "./linkify";
import { predictAliasCollision, type AliasCollision } from "./alias-collisions";

// Phase 4g — Tag a selection as an alias of an existing character. Appends the
// selected text to that character's `aliases:` frontmatter array. Future cue
// occurrences of the alias resolve back to the canonical character via the
// roster builder; linkify also picks up alias mentions.

export function runTagSelectionAsAliasCommand(
	plugin: FirstDraftPlugin,
	editor: Editor,
): void {
	const selection = editor.getSelection().trim();
	if (selection === "") {
		new Notice("Select the alias text first.");
		return;
	}

	const file = plugin.app.workspace.getActiveFile();
	if (!file) {
		new Notice("Open a file inside a project first.");
		return;
	}
	const project = resolveActiveProject(file, plugin.scanner);
	if (!project) {
		new Notice("Open a file inside a project first.");
		return;
	}

	const cfg = resolveProjectSettings(project, plugin.settings);
	const candidates = characterRoster(plugin.app, project, cfg).filter((e) => !e.isGroup);
	if (candidates.length === 0) {
		new Notice("No characters in this project to attach an alias to.");
		return;
	}

	// If the user invoked this from a dev note, auto-add the alias to its
	// characters: on save (preserves the "name-as-used" semantic). Carry the
	// dev-note file along to the modal so it's available at choose time.
	const pair = sequencePairFromActive(plugin.app, file, project, cfg);
	const targetDevNote =
		pair && pair.activeMode === "dev-note" ? pair.devNoteFile : null;

	new AliasTargetPickerModal(plugin, project, selection, candidates, targetDevNote).open();
}

class AliasTargetPickerModal extends SuggestModal<CharacterEntry> {
	constructor(
		private readonly plugin: FirstDraftPlugin,
		private readonly project: ProjectMeta,
		private readonly aliasText: string,
		private readonly candidates: CharacterEntry[],
		private readonly autoAddTo: TFile | null,
	) {
		super(plugin.app);
		this.setPlaceholder(`Tag "${aliasText}" as alias of…`);
	}

	getSuggestions(query: string): CharacterEntry[] {
		const q = query.trim().toUpperCase();
		if (q === "") return this.candidates;
		return this.candidates.filter((c) => c.name.includes(q));
	}

	renderSuggestion(value: CharacterEntry, el: HTMLElement): void {
		el.createEl("div", { text: value.folderName });
		if (value.aliases.length > 0) {
			el.createEl("small", {
				text: `Aliases: ${value.aliases.join(", ")}`,
				cls: "firstdraft-suggestion-meta",
			});
		}
	}

	onChooseSuggestion(value: CharacterEntry): void {
		const collision = predictAliasCollision(
			this.candidates,
			value,
			this.aliasText,
		);
		if (collision) {
			new AliasCollisionConfirmModal(
				this.plugin.app,
				this.aliasText,
				value,
				collision,
				() => {
					void appendAlias(
						this.plugin,
						this.project,
						value,
						this.aliasText,
						this.autoAddTo,
					);
				},
			).open();
			return;
		}
		void appendAlias(this.plugin, this.project, value, this.aliasText, this.autoAddTo);
	}
}

// Shown when the user picks a target whose new alias would clash with
// another character's canonical name or alias. Cancel is the default;
// "Add anyway" lets the user proceed knowingly (e.g. mid-rename).
class AliasCollisionConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly aliasText: string,
		private readonly target: CharacterEntry,
		private readonly collision: AliasCollision,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Alias collision" });

		const others = this.collision.claimants.filter(
			(c) => c.entry.folder.path !== this.target.folder.path,
		);

		const intro = contentEl.createEl("p");
		intro.appendText(`Adding `);
		intro.createEl("strong", { text: `"${this.aliasText}"` });
		intro.appendText(` as an alias of `);
		intro.createEl("strong", { text: this.target.folderName });
		intro.appendText(` would conflict with the following:`);

		const list = contentEl.createEl("ul", {
			cls: "firstdraft-alias-collision-list",
		});
		for (const c of others) {
			const item = list.createEl("li");
			item.createEl("strong", { text: c.entry.folderName });
			item.appendText(
				c.source === "canonical"
					? " (canonical name)"
					: ` (alias "${c.asWritten}")`,
			);
		}

		contentEl.createEl("p", {
			text: "Cue resolution and linkify will not know which character to attach this name to. Rename the alias to disambiguate, or proceed if you have a follow-up rename planned.",
			cls: "firstdraft-alias-collision-help",
		});

		new Setting(contentEl)
			.addButton((b) => {
				b.setButtonText("Cancel")
					.setCta()
					.onClick(() => this.close());
				setTimeout(() => b.buttonEl.focus(), 0);
			})
			.addButton((b) =>
				b
					.setButtonText("Add anyway")
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

async function appendAlias(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	target: CharacterEntry,
	alias: string,
	autoAddTo: TFile | null,
): Promise<void> {
	if (!(target.canonicalFile instanceof TFile)) {
		new Notice("Target character file not found.");
		return;
	}
	try {
		await plugin.app.fileManager.processFrontMatter(
			target.canonicalFile,
			(fm: Record<string, unknown>) => {
				const existing = Array.isArray(fm.aliases)
					? (fm.aliases as unknown[]).filter((v): v is string => typeof v === "string")
					: [];
				const alreadyPresent = existing.some(
					(a) => a.trim().toUpperCase() === alias.trim().toUpperCase(),
				);
				if (alreadyPresent) return;
				existing.push(alias.trim());
				fm.aliases = existing;
			},
		);

		let tail = "";
		if (autoAddTo) {
			const added = await addToCharactersArray(plugin, autoAddTo, alias.trim());
			if (added) tail = " (also added to this scene's characters)";
		}
		new Notice(`Added "${alias}" as alias of ${target.folderName}.${tail}`);

		// Linkify mentions of the alias text → canonical character file. Honor
		// the same autoLinkifyOnCreate setting used by Create entity flows.
		const cfg = resolveProjectSettings(project, plugin.settings);
		const entity: DevEntity = {
			name: alias.trim(),
			canonicalFilePath: target.canonicalFile.path,
		};
		if (cfg.autoLinkifyOnCreate) {
			const result = await linkifyEntity(plugin, project, entity);
			notifyLinkifyResult(result);
		} else {
			offerLinkify(plugin, project, entity, alias.trim());
		}
	} catch (e) {
		new Notice(`Could not save alias: ${(e as Error).message}`);
	}
}

function offerLinkify(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	entity: DevEntity,
	displayName: string,
): void {
	const notice = new Notice(
		`Linkify mentions of "${displayName}"? Click here to run.`,
		8000,
	);
	notice.messageEl.addEventListener("click", (e) => {
		e.preventDefault();
		notice.hide();
		void (async () => {
			const result = await linkifyEntity(plugin, project, entity);
			notifyLinkifyResult(result);
		})();
	});
}

function notifyLinkifyResult(result: LinkifyResult): void {
	if (result.totalReplacements === 0) {
		new Notice("No mentions to linkify.");
		return;
	}
	new Notice(
		`Linkified ${result.totalReplacements} mention(s) across ${result.filesModified} file(s).`,
	);
}

// Append a name to a dev note's characters: array. Returns true if added,
// false if it was already present (case-insensitive).
async function addToCharactersArray(
	plugin: FirstDraftPlugin,
	devNote: TFile,
	name: string,
): Promise<boolean> {
	let added = false;
	await plugin.app.fileManager.processFrontMatter(
		devNote,
		(fm: Record<string, unknown>) => {
			const existing = Array.isArray(fm.characters)
				? (fm.characters as unknown[]).filter((v): v is string => typeof v === "string")
				: [];
			const present = existing.some(
				(n) => n.trim().toUpperCase() === name.trim().toUpperCase(),
			);
			if (present) return;
			existing.push(name);
			fm.characters = existing;
			added = true;
		},
	);
	return added;
}
