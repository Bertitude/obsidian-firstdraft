import { App, Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { ProjectMeta } from "../types";
import { resolveActiveProject } from "../projects/resolver";
import { resolveProjectSettings } from "../settings/resolve";
import { sanitizeFilename, toTitleCase } from "../utils/sanitize";
import { ensureEpisodeCharacterNote } from "./episode-character-notes";

// "Create character" — modal-based entity creation for the show-bible cast.
//
// Differs from the legacy selection-create flow (createEntityFromSelection)
// in three ways:
//   1. Always lands at the SERIES-level Characters folder when the active
//      project is a tv-episode that has a series root above it. The legacy
//      flow placed characters under the active project's own Development
//      tree, which for episodes meant they couldn't be reused across the
//      season. Series-level placement gives every episode access to the
//      same canonical character via Obsidian's link resolver.
//   2. Captures a "level" (main / recurring / guest) and writes a `roles:`
//      frontmatter map. Episode context exposes all three; series/feature
//      context only exposes main/recurring (guest is episode-scoped by
//      definition).
//   3. Skips the parent-folder / version-of-X conflict modals — those were
//      never wired into the modal flow this command provides. Existing-name
//      collision is a single notice + bail; users can pick a different name.
//
// TODO(v2): When we add per-episode character notes (`<Episode>/Development/
//   Characters/<Name>.md` alongside the canonical at series level), there's
//   a same-filename ambiguity in Obsidian's Quick Switcher (both files
//   appear when typing the name). Path-proximity wikilink resolution
//   handles in-fountain links correctly, but Quick Switcher needs the
//   canonical to be distinguishable. Mitigation: set a frontmatter
//   `aliases:` field on the canonical (e.g. "Antonia (canonical)") so
//   Quick Switcher can disambiguate. Defer until we ship the episode-notes
//   feature and confirm the friction is real.

export type CharacterLevel = "main" | "recurring" | "guest";

export interface CreateCharacterResult {
	file: TFile;
	displayName: string;
}

// Opens the modal, scaffolds the character file on submit. Returns the
// created file (and final display name) or null on cancel/error. Caller is
// responsible for any selection-replace / autolinkify follow-up.
export async function openCreateCharacterModal(
	plugin: FirstDraftPlugin,
	defaultName: string,
): Promise<CreateCharacterResult | null> {
	const active = plugin.app.workspace.getActiveFile();
	const project = active ? resolveActiveProject(active, plugin.scanner) : null;
	if (!project) {
		new Notice("Open a file inside a project first.");
		return null;
	}

	return new Promise((resolve) => {
		new CreateCharacterModal(plugin, project, defaultName, resolve).open();
	});
}

class CreateCharacterModal extends Modal {
	private nameValue: string;
	private level: CharacterLevel;
	private finished = false;

	constructor(
		private readonly plugin: FirstDraftPlugin,
		private readonly project: ProjectMeta,
		defaultName: string,
		private readonly resolve: (r: CreateCharacterResult | null) => void,
	) {
		super(plugin.app);
		this.nameValue = defaultName;
		// Default level: characters created at series/feature level are typically
		// "main" or "recurring"; from an episode we default to "guest" because
		// that's the most-likely intent (one-offs are common; series regulars
		// are usually established via the show bible upfront).
		this.level = project.projectType === "tv-episode" ? "guest" : "main";
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Create character" });

		new Setting(contentEl)
			.setName("Name")
			.setDesc("Character name. Used as the folder + canonical file name.")
			.addText((t) => {
				t.setPlaceholder("e.g. Antonia")
					.setValue(this.nameValue)
					.onChange((v) => {
						this.nameValue = v;
					});
				// Focus + select for quick edits when name is pre-filled.
				setTimeout(() => {
					t.inputEl.focus();
					t.inputEl.select();
				}, 0);
			});

		new Setting(contentEl)
			.setName("Level")
			.setDesc(this.levelDescription())
			.addDropdown((d) => {
				d.addOption("main", "Main");
				d.addOption("recurring", "Recurring");
				if (this.project.projectType === "tv-episode") {
					d.addOption("guest", "Guest");
				}
				d.setValue(this.level).onChange((value) => {
					this.level = value as CharacterLevel;
				});
			});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.cancel()))
			.addButton((b) =>
				b
					.setButtonText("Create")
					.setCta()
					.onClick(() => {
						void this.submit();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.finished) this.resolve(null);
	}

	private levelDescription(): string {
		if (this.project.projectType === "tv-episode") {
			return "Main: series regular across the show. Recurring: notable repeat appearances. Guest: one-time or single-arc, scoped to this season.";
		}
		return "Main: central character. Recurring: notable supporting role.";
	}

	private cancel(): void {
		this.finished = true;
		this.resolve(null);
		this.close();
	}

	private async submit(): Promise<void> {
		const cfg = resolveProjectSettings(this.project, this.plugin.settings);

		const trimmed = this.nameValue.trim();
		if (trimmed === "") {
			new Notice("Name is required.");
			return;
		}
		const sanitized = sanitizeFilename(trimmed, cfg.filenameReplacementChar);
		if (!sanitized) {
			new Notice("Name has no valid filename characters.");
			return;
		}
		const finalName = toTitleCase(sanitized);

		// Entity root: series-level if active is a tv-episode with a series
		// root above it; otherwise the active project's own Development tree.
		const entityRoot =
			this.project.projectType === "tv-episode" &&
			this.project.seriesDevelopmentPath
				? normalizePath(
						`${this.project.seriesDevelopmentPath}/${cfg.charactersSubfolder}`,
					)
				: normalizePath(
						`${this.project.projectRootPath}/${cfg.developmentFolder}/${cfg.charactersSubfolder}`,
					);

		const folderPath = normalizePath(`${entityRoot}/${finalName}`);
		const docPath = normalizePath(`${folderPath}/${finalName}.md`);

		// Existing-name collision: bail with a notice. The legacy flow had a
		// "open existing / add suffix" modal here; we punt on that for v1.
		if (this.plugin.app.vault.getAbstractFileByPath(docPath)) {
			new Notice(`A character named "${finalName}" already exists.`);
			return;
		}

		try {
			await ensureFolderExists(this.plugin.app, folderPath);
			const created = await this.plugin.app.vault.create(
				docPath,
				cfg.characterNoteTemplate,
			);

			// Inject roles: into frontmatter via processFrontMatter so YAML
			// serialization handles quoting / escaping for us.
			const seasonKey = parseSeasonKey(this.project);
			await this.plugin.app.fileManager.processFrontMatter(
				created,
				(fm: Record<string, unknown>) => {
					fm.roles = composeRoles(this.level, this.project, seasonKey);
				},
			);

			// If the user is creating from inside an episode, auto-create the
			// episode-specific character note alongside the canonical. The
			// helper is a no-op for non-episode projects, so this is safe to
			// always call.
			await ensureEpisodeCharacterNote(this.plugin, this.project, finalName);

			this.finished = true;
			this.resolve({ file: created, displayName: finalName });
			this.close();
		} catch (e) {
			new Notice(`Could not create character: ${(e as Error).message}`);
		}
	}
}

// Compose the `roles:` frontmatter value based on the picked level + project
// context. Series-wide levels (main / recurring) use `default:`; episode-
// scoped levels (guest) use a season key derived from the episode's metadata.
function composeRoles(
	level: CharacterLevel,
	project: ProjectMeta,
	seasonKey: string | null,
): Record<string, string> {
	if (level === "guest" && seasonKey) {
		// Guest is season-scoped — track it under the season they appear in.
		return { [seasonKey]: level };
	}
	return { default: level };
}

// Extract a season key like "S01" from an episode project's metadata.
// Prefers explicit `season:` frontmatter; falls back to parsing from the
// episode code (S01E01 → 01). Returns null if neither is set (used for
// series/feature projects where season scoping doesn't apply).
function parseSeasonKey(project: ProjectMeta): string | null {
	if (project.season && project.season.trim() !== "") {
		const n = parseInt(project.season, 10);
		if (!Number.isNaN(n)) return `S${String(n).padStart(2, "0")}`;
	}
	if (project.episode) {
		const m = /^s(\d+)e/i.exec(project.episode.trim());
		if (m) {
			const n = parseInt(m[1] ?? "", 10);
			if (!Number.isNaN(n)) return `S${String(n).padStart(2, "0")}`;
		}
	}
	return null;
}

async function ensureFolderExists(app: App, path: string): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFolder) return;
	if (existing) throw new Error(`Path exists but is not a folder: ${path}`);
	const segments = path.split("/");
	let cumulative = "";
	for (const seg of segments) {
		cumulative = cumulative ? `${cumulative}/${seg}` : seg;
		const at = app.vault.getAbstractFileByPath(cumulative);
		if (at) continue;
		await app.vault.createFolder(cumulative);
	}
}
