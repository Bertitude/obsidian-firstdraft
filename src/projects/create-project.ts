import { App, Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { GlobalConfig } from "../types";
import { sanitizeFilename } from "../utils/sanitize";
import { activateProjectHomeView } from "../views/project-home-view";

// "Create FirstDraft project" — scaffolds a fresh project from scratch.
// Builds the standard folder layout, writes Index.md with `firstdraft:`
// frontmatter, and creates a Treatment.md with a friendly welcome intro
// the user can delete when they're ready to start drafting.
//
// Folder layout produced (relative to the chosen parent folder):
//
//   <Title>/
//     Index.md
//     <sequencesSubfolder>/                 (top-level fountain folder)
//     <developmentFolder>/
//       Treatment.md                         (with welcome intro)
//       <sequencesSubfolder>/                (per-sequence dev notes)
//       <charactersSubfolder>/
//       <locationsSubfolder>/
//       <referencesSubfolder>/
//       <notesSubfolder>/
//
// All subfolder names come from the user's global config so a project
// scaffolded under custom folder names lands in the right places.

export function runCreateProjectCommand(plugin: FirstDraftPlugin): void {
	new CreateProjectModal(plugin).open();
}

class CreateProjectModal extends Modal {
	private title = "";
	private parentFolder = "";

	constructor(private readonly plugin: FirstDraftPlugin) {
		super(plugin.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("firstdraft-create-project");
		contentEl.createEl("h2", { text: "Create FirstDraft project" });

		new Setting(contentEl)
			.setName("Title")
			.setDesc("Display name for the project. Used as the folder name and in the index.")
			.addText((t) =>
				t
					.setPlaceholder("e.g. Fraidy Fraidy")
					.onChange((v) => {
						this.title = v;
					}),
			);

		new Setting(contentEl)
			.setName("Parent folder")
			.setDesc(
				'Where to create the project folder. Leave empty for vault root. e.g. "Project Development/Film".',
			)
			.addText((t) =>
				t
					.setPlaceholder("(vault root)")
					.onChange((v) => {
						this.parentFolder = v.trim();
					}),
			);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Create")
					.setCta()
					.onClick(() => {
						void this.create();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async create(): Promise<void> {
		const cfg = this.plugin.settings.global;
		const title = this.title.trim();
		if (!title) {
			new Notice("Title is required.");
			return;
		}
		const folderName = sanitizeFilename(title, cfg.filenameReplacementChar);
		if (!folderName) {
			new Notice("Title has no valid filename characters.");
			return;
		}

		const projectPath = this.parentFolder
			? normalizePath(`${this.parentFolder}/${folderName}`)
			: folderName;

		if (this.plugin.app.vault.getAbstractFileByPath(projectPath)) {
			new Notice(`A folder named "${projectPath}" already exists.`);
			return;
		}

		try {
			const treatmentFile = await scaffoldProject(
				this.plugin.app,
				projectPath,
				title,
				cfg,
			);
			this.close();
			// Open the welcome treatment so the user lands in something inviting,
			// then activate Project Home so navigation surfaces are ready.
			await this.plugin.app.workspace.getLeaf(false).openFile(treatmentFile);
			void activateProjectHomeView(this.plugin);
			new Notice(`Created project "${title}".`);
		} catch (e) {
			new Notice(`Create failed: ${(e as Error).message}`);
		}
	}
}

async function scaffoldProject(
	app: App,
	projectPath: string,
	title: string,
	cfg: GlobalConfig,
): Promise<TFile> {
	// Create the folder chain. ensureFolder walks segments so multi-level
	// parent paths (e.g. "Project Development/Film/My Project") are created
	// in one call without depending on Obsidian's recursive-create behavior.
	await ensureFolder(app, projectPath);
	await ensureFolder(app, `${projectPath}/${cfg.sequencesSubfolder}`);
	await ensureFolder(app, `${projectPath}/${cfg.developmentFolder}`);
	await ensureFolder(
		app,
		`${projectPath}/${cfg.developmentFolder}/${cfg.sequencesSubfolder}`,
	);
	await ensureFolder(
		app,
		`${projectPath}/${cfg.developmentFolder}/${cfg.charactersSubfolder}`,
	);
	await ensureFolder(
		app,
		`${projectPath}/${cfg.developmentFolder}/${cfg.locationsSubfolder}`,
	);
	await ensureFolder(
		app,
		`${projectPath}/${cfg.developmentFolder}/${cfg.referencesSubfolder}`,
	);
	await ensureFolder(
		app,
		`${projectPath}/${cfg.developmentFolder}/${cfg.notesSubfolder}`,
	);

	// Write Index.md with the firstdraft: frontmatter block. sequenceFolder
	// points at the top-level fountain folder; sequences: starts empty (gets
	// populated as the user creates/promotes scenes).
	const indexPath = normalizePath(`${projectPath}/Index.md`);
	await app.vault.create(indexPath, indexBody(title, cfg));

	// Write the welcome Treatment.md and return it so the caller can open it.
	const treatmentPath = normalizePath(
		`${projectPath}/${cfg.developmentFolder}/Treatment.md`,
	);
	const treatment = await app.vault.create(
		treatmentPath,
		treatmentBody(title),
	);
	return treatment;
}

function indexBody(title: string, cfg: GlobalConfig): string {
	return `---
title: ${title}
firstdraft:
  sequenceFolder: ${cfg.sequencesSubfolder}
  sequences: []
---

# ${title}

`;
}

function treatmentBody(title: string): string {
	return `---
type: treatment
status: draft
promoted_at:
---

# ${title} — Treatment

> **Welcome to your FirstDraft project.** This treatment is your starting point. Capture your story idea here — anything from a one-line logline to a full beat-by-beat breakdown.
>
> When you're ready to break this into a draftable structure, you have flexible paths:
>
> - **Promote treatment to sequences** — each H2 below becomes a paired fountain + dev note, ready to draft.
> - **Create new sequence** — add sequences individually outside the treatment flow.
> - **Create character / location from selection** — spin off entity notes as you write.
>
> Mix and match whichever workflow gets you to first draft fastest. Delete this welcome message when you're ready to start drafting — the H2 headings below become your sequence titles when you promote.

## First beat
What happens here. A few sentences.

## Second beat
What happens next.
`;
}

async function ensureFolder(app: App, path: string): Promise<void> {
	const at = app.vault.getAbstractFileByPath(path);
	if (at instanceof TFolder) return;
	if (at instanceof TFile) {
		throw new Error(`Path is a file, not a folder: ${path}`);
	}
	// Walk segments so multi-level paths get created end-to-end even on
	// Obsidian builds whose createFolder doesn't recurse.
	const segments = path.split("/");
	let cumulative = "";
	for (const seg of segments) {
		cumulative = cumulative ? `${cumulative}/${seg}` : seg;
		const existing = app.vault.getAbstractFileByPath(cumulative);
		if (existing) continue;
		await app.vault.createFolder(cumulative);
	}
}
