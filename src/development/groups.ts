import { App, Editor, Modal, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { characterRoster, sequencePairFromActive, type CharacterEntry } from "../views/lookups";
import { sanitizeFilename, toTitleCase } from "../utils/sanitize";
import { linkifyEntity, type DevEntity, type LinkifyResult } from "./linkify";

// Phase 4g — Tag a selection as a character group. Creates a new entity in the
// project's Characters folder with `type: group` and a `members:` array. Members
// are picked from the existing character roster via a multi-select modal.

export function runTagSelectionAsGroupCommand(
	plugin: FirstDraftPlugin,
	editor: Editor,
): void {
	const selection = editor.getSelection().trim();
	if (selection === "") {
		new Notice("Select the group name first.");
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
	const sanitized = sanitizeFilename(selection, cfg.filenameReplacementChar);
	if (!sanitized) {
		new Notice("Selection has no valid filename characters.");
		return;
	}
	const groupFolderName = toTitleCase(sanitized);

	const candidates = characterRoster(plugin.app, project, cfg).filter((e) => !e.isGroup);
	if (candidates.length === 0) {
		new Notice("No characters in this project to add as members.");
		return;
	}

	// If the user invoked this from a dev note, the group should also land in
	// that note's characters: array on creation. Resolve here so the modal can
	// pass it through to the create step.
	const pair = sequencePairFromActive(plugin.app, file, project, cfg);
	const targetDevNote =
		pair && pair.activeMode === "dev-note" ? pair.devNoteFile : null;

	new GroupMemberPickerModal(
		plugin,
		project,
		cfg,
		groupFolderName,
		candidates,
		targetDevNote,
	).open();
}

class GroupMemberPickerModal extends Modal {
	private readonly checked = new Set<string>(); // folder names of selected members

	constructor(
		private readonly plugin: FirstDraftPlugin,
		private readonly project: ProjectMeta,
		private readonly cfg: { developmentFolder: string; charactersSubfolder: string; autoLinkifyOnCreate: boolean },
		private readonly groupFolderName: string,
		private readonly candidates: CharacterEntry[],
		private readonly autoAddTo: TFile | null,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: `New group: ${this.groupFolderName}` });
		contentEl.createEl("p", {
			text: "Select members for this group. The group itself becomes a roster entry; members are recorded in the group's frontmatter.",
			cls: "firstdraft-prompt-help",
		});

		const list = contentEl.createDiv({ cls: "firstdraft-group-members" });
		for (const c of this.candidates) {
			const row = list.createDiv({ cls: "firstdraft-group-member-row" });
			const cb = row.createEl("input", { type: "checkbox" });
			cb.id = `firstdraft-member-${c.folderName}`;
			cb.addEventListener("change", () => {
				if (cb.checked) this.checked.add(c.folderName);
				else this.checked.delete(c.folderName);
			});
			const label = row.createEl("label", {
				text: c.folderName,
				attr: { for: cb.id },
			});
			void label;
		}

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		const ok = buttons.createEl("button", { text: "Create group", cls: "mod-cta" });
		ok.addEventListener("click", () => {
			void this.submit();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async submit(): Promise<void> {
		if (this.checked.size === 0) {
			new Notice("Pick at least one member.");
			return;
		}
		this.close();
		await createGroupFile(
			this.plugin,
			this.project,
			this.cfg,
			this.groupFolderName,
			[...this.checked],
			this.autoAddTo,
		);
	}
}

async function createGroupFile(
	plugin: FirstDraftPlugin,
	project: ProjectMeta,
	cfg: { developmentFolder: string; charactersSubfolder: string; autoLinkifyOnCreate: boolean },
	groupFolderName: string,
	members: string[],
	autoAddTo: TFile | null,
): Promise<void> {
	const folderPath = normalizePath(
		`${project.projectRootPath}/${cfg.developmentFolder}/${cfg.charactersSubfolder}/${groupFolderName}`,
	);
	const filePath = normalizePath(`${folderPath}/${groupFolderName}.md`);

	if (plugin.app.vault.getAbstractFileByPath(filePath)) {
		new Notice(`A character or group named "${groupFolderName}" already exists.`);
		return;
	}

	try {
		await ensureFolderExists(plugin.app, folderPath);
		const body = renderGroupTemplate(members);
		await plugin.app.vault.create(filePath, body);

		let tail = "";
		if (autoAddTo) {
			const added = await addToCharactersArray(plugin, autoAddTo, groupFolderName);
			if (added) tail = " (also added to this scene's characters)";
		}
		new Notice(`Created group: ${groupFolderName} (${members.length} members).${tail}`);

		// Linkify mentions of the group name → group file. Honor the same
		// autoLinkifyOnCreate setting used by Create entity flows.
		const entity: DevEntity = { name: groupFolderName, canonicalFilePath: filePath };
		if (cfg.autoLinkifyOnCreate) {
			const result = await linkifyEntity(plugin, project, entity);
			notifyLinkifyResult(result);
		} else {
			offerLinkify(plugin, project, entity, groupFolderName);
		}
	} catch (e) {
		new Notice(`Could not create group: ${(e as Error).message}`);
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

function renderGroupTemplate(members: string[]): string {
	const yaml = members.map((m) => `  - ${m}`).join("\n");
	return `---\ntype: group\nmembers:\n${yaml}\n---\n\n## About\n\nWhat does this group represent? Why are they grouped?\n\n## Notes\n`;
}

async function ensureFolderExists(app: App, path: string): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFolder) return;
	if (existing instanceof TFile) {
		throw new Error(`Path is a file, not a folder: ${path}`);
	}
	await app.vault.createFolder(path);
}
