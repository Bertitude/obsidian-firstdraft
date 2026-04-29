import { App, Modal, Notice, Setting, TFile, TFolder, normalizePath, TextComponent } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { GlobalConfig } from "../types";
import { sanitizeFilename } from "../utils/sanitize";
import { FolderSuggest } from "../utils/folder-suggest";
import { yamlString } from "../utils/yaml";
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
//
// Project type: feature or series. Series scaffolding is deferred until
// the series-as-project refactor lands — until then, picking Series in
// the modal is a no-op (the option exists in the UI for discoverability
// but routes back to Feature with an explanatory notice).

type ProjectKind = "feature" | "series";

export function runCreateProjectCommand(plugin: FirstDraftPlugin): void {
	new CreateProjectModal(plugin).open();
}

class CreateProjectModal extends Modal {
	private title = "";
	private subtitle = "";
	private parentFolder = "";
	private kind: ProjectKind = "feature";
	private parentInput?: TextComponent;
	// True when the user has manually edited the parent folder field; we
	// stop auto-syncing it to the project-type default once they have so
	// their custom path doesn't get clobbered if they also change type.
	private parentEditedManually = false;

	constructor(private readonly plugin: FirstDraftPlugin) {
		super(plugin.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		const cfg = this.plugin.settings.global;

		contentEl.addClass("firstdraft-create-project");
		contentEl.createEl("h2", { text: "Create FirstDraft project" });

		// Initialise the parent folder from settings + default kind.
		this.parentFolder = computeDefaultParent(cfg, this.kind);

		new Setting(contentEl)
			.setName("Title")
			.setDesc("Primary name for the project. Used as the folder name and in the index.")
			.addText((t) =>
				t
					.setPlaceholder("e.g. Babylon")
					.onChange((v) => {
						this.title = v;
					}),
			);

		new Setting(contentEl)
			.setName("Subtitle")
			.setDesc('Optional. Shown alongside the title as "Title: Subtitle" (e.g. Power: Book II).')
			.addText((t) =>
				t.setPlaceholder("(none)").onChange((v) => {
					this.subtitle = v.trim();
				}),
			);

		new Setting(contentEl)
			.setName("Project type")
			.setDesc(
				"Feature for a single screenplay; Series for a TV/episodic project. Series produces a show-level shell — add episodes via 'Create episode' once it's open.",
			)
			.addDropdown((d) => {
				d.addOption("feature", "Feature");
				d.addOption("series", "Series");
				d.setValue(this.kind);
				d.onChange((value) => {
					this.kind = value as ProjectKind;
					// Keep the parent folder in sync with the type's default
					// unless the user has typed their own value.
					if (!this.parentEditedManually) {
						this.parentFolder = computeDefaultParent(cfg, this.kind);
						this.parentInput?.setValue(this.parentFolder);
					}
				});
			});

		new Setting(contentEl)
			.setName("Parent folder")
			.setDesc(
				'Where to create the project folder. Type to search existing folders or enter a new path (created on submit). Defaults from your settings.',
			)
			.addText((t) => {
				this.parentInput = t;
				t.setPlaceholder("(vault root)")
					.setValue(this.parentFolder)
					.onChange((v) => {
						this.parentFolder = v.trim();
						this.parentEditedManually = true;
					});
				// Folder picker dropdown — populates from existing vault folders,
				// matching by substring. User can also type a new path that
				// doesn't exist yet; ensureFolder() walks the segments at submit.
				new FolderSuggest(this.plugin.app, t.inputEl);
			});

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

		const subtitle = this.subtitle.trim();
		try {
			let openTarget: TFile;
			if (this.kind === "series") {
				openTarget = await scaffoldSeriesProject(
					this.plugin.app,
					projectPath,
					title,
					subtitle,
					cfg,
				);
			} else {
				openTarget = await scaffoldProject(
					this.plugin.app,
					projectPath,
					title,
					subtitle,
					cfg,
				);
			}
			this.close();
			// Open the welcome target so the user lands in something inviting,
			// then activate Project Home so navigation surfaces are ready.
			await this.plugin.app.workspace.getLeaf(false).openFile(openTarget);
			void activateProjectHomeView(this.plugin);
			const fullName = subtitle ? `${title}: ${subtitle}` : title;
			new Notice(
				this.kind === "series"
					? `Created series "${fullName}". Add your first episode with "Create episode".`
					: `Created project "${fullName}".`,
			);
		} catch (e) {
			new Notice(`Create failed: ${(e as Error).message}`);
		}
	}
}

// Compose the default parent folder from settings + project kind.
// `defaultProjectParent` is the top-level container; the per-kind
// subfolder (`defaultFeatureSubfolder` / `defaultSeriesSubfolder`)
// nests projects of that kind underneath. Either may be empty.
function computeDefaultParent(cfg: GlobalConfig, kind: ProjectKind): string {
	const segments: string[] = [];
	if (cfg.defaultProjectParent.trim() !== "") segments.push(cfg.defaultProjectParent.trim());
	const sub =
		kind === "feature" ? cfg.defaultFeatureSubfolder : cfg.defaultSeriesSubfolder;
	if (sub.trim() !== "") segments.push(sub.trim());
	return segments.join("/");
}

// Scaffolds a series-level project. Lighter than a feature/episode scaffold:
// no Sequences/ folder (sequences live in episodes), no Treatment.md (the
// series-level "show bible" treatment is a separate future feature). Just
// the Index.md with `kind: series` + a series-level Development tree for
// recurring characters/locations/references and a Notes folder.
async function scaffoldSeriesProject(
	app: App,
	projectPath: string,
	title: string,
	subtitle: string,
	cfg: GlobalConfig,
): Promise<TFile> {
	await ensureFolder(app, projectPath);
	await ensureFolder(app, `${projectPath}/${cfg.developmentFolder}`);
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
	// Pre-create the seasons folder so the user sees the structure even before
	// they add their first episode.
	await ensureFolder(app, `${projectPath}/${cfg.seasonsFolder}`);

	const indexPath = normalizePath(`${projectPath}/Index.md`);
	const index = await app.vault.create(indexPath, seriesIndexBody(title, subtitle, cfg));
	return index;
}

async function scaffoldProject(
	app: App,
	projectPath: string,
	title: string,
	subtitle: string,
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
	await app.vault.create(indexPath, indexBody(title, subtitle, cfg));

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

function indexBody(title: string, subtitle: string, cfg: GlobalConfig): string {
	const subtitleLine = subtitle ? `\nsubtitle: ${yamlString(subtitle)}` : "";
	return `---
title: ${yamlString(title)}${subtitleLine}
firstdraft:
  sequenceFolder: ${yamlString(cfg.sequencesSubfolder)}
  sequences: []
---

# ${title}

`;
}

function seriesIndexBody(title: string, subtitle: string, cfg: GlobalConfig): string {
	const subtitleLine = subtitle ? `\nsubtitle: ${yamlString(subtitle)}` : "";
	return `---
title: ${yamlString(title)}${subtitleLine}
firstdraft:
  kind: series
---

# ${title}

> **Welcome to your FirstDraft series.** This Index is the show-level
> root for "${title}". Episodes live as sub-projects under
> \`${cfg.seasonsFolder}/\` — open this series in Project Home and use
> **Create episode** to scaffold each one.
>
> Use the series-level \`${cfg.developmentFolder}/\` tree for recurring
> material that spans the show: regular characters, recurring locations,
> world-building references, and series-wide notes. Each episode keeps
> its own development tree for episode-specific work.
>
> Delete this welcome when you're ready.
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
