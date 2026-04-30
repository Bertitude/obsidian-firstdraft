// FirstDraft type definitions.
// Settings types follow the spec in the project README/spec doc.
// Runtime-only types (ProjectMeta) are derived from frontmatter, never persisted.

// ─── Settings ──────────────────────────────────────────────────────────────

export interface FirstDraftSettings {
	projects: Record<string, ProjectConfig>;
	global: GlobalConfig;
}

export interface GlobalConfig {
	developmentFolder: string;
	charactersSubfolder: string;
	sequencesSubfolder: string;
	locationsSubfolder: string;
	referencesSubfolder: string;
	notesSubfolder: string;
	seasonsFolder: string;
	episodeNameTemplate: string;
	sluglineSubLocationDelimiter: string;
	defaultProjectParent: string;
	defaultFeatureSubfolder: string;
	defaultSeriesSubfolder: string;
	characterCardFields: string[];
	sceneNoteTemplate: string;
	characterNoteTemplate: string;
	locationNoteTemplate: string;
	firstDraftMode: FirstDraftModeConfig;
	debugLogging: boolean;
	replaceSelectionWithLink: boolean;
	autoLinkifyOnCreate: boolean;
	filenameReplacementChar: string;
	fountainPlugin: FountainPluginMode;
	fountainFileFormat: FountainFileFormat;
}

export type FountainPluginMode = "auto" | "bgrundmann" | "chuangcaleb" | "other";
export type FountainFileFormat = "fountain" | "fountain-md";

export interface ProjectConfig {
	developmentFolder?: string;
	charactersSubfolder?: string;
	sequencesSubfolder?: string;
	locationsSubfolder?: string;
	referencesSubfolder?: string;
	notesSubfolder?: string;
	seasonsFolder?: string;
	episodeNameTemplate?: string;
	sluglineSubLocationDelimiter?: string;
	noteTag?: string;
	characterCardFields?: string[];
	sceneNoteTemplate?: string;
	characterNoteTemplate?: string;
	locationNoteTemplate?: string;
}

export interface FirstDraftModeConfig {
	active: boolean;
	savedLayout: unknown;
	hideRibbon: boolean;
	hideStatusBar: boolean;
	hideLeftSidebar: boolean;
	openProjectNotes: boolean;
}

// ─── Runtime project metadata ──────────────────────────────────────────────

// Four project kinds:
//   - "feature":    standalone screenplay; has its own Sequences/ folder.
//   - "tv-episode": single episode; has its own Sequences/ folder; nests
//                   under a season project (and transitively a series).
//   - "season":     a single season of a series; has no Sequences/ of its
//                   own; episodes are auto-discovered as sub-projects under
//                   the season root. Identified by `firstdraft.kind: season`.
//                   Carries its own Development/ tree for season-arc
//                   characters, locations, references, and a Season
//                   Outline (the "season treatment" — H2 per episode).
//   - "series":     show-level container; has no Sequences/ folder of its
//                   own; seasons are auto-discovered as sub-projects under
//                   the series root. Identified by `firstdraft.kind: series`
//                   in frontmatter.
export type ProjectType = "feature" | "tv-episode" | "series" | "season";

export interface ProjectMeta {
	projectType: ProjectType;
	series?: string;
	season?: string;
	episode?: string;
	title?: string;
	// Optional secondary/subtitle. Pattern: "Power: Book II", "Star Wars:
	// A New Hope", "Babylon: Rise of a Shotta". Title stays the primary
	// name; subtitle is the secondary segment when present. Display
	// helpers compose them as "Title: Subtitle". Episodes don't use this
	// field (their title structure is already S01E01 — Pilot).
	subtitle?: string;
	logline?: string;
	status?: string;
	indexFilePath: string;
	projectRootPath: string;
	// Empty string for series projects (they have no sequences directly —
	// sequences live in episodes).
	sequenceFolderPath: string;
	seriesDevelopmentPath: string | null;
}
