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

export type ProjectType = "feature" | "tv-episode";

export interface ProjectMeta {
	projectType: ProjectType;
	series?: string;
	season?: string;
	episode?: string;
	title?: string;
	logline?: string;
	status?: string;
	indexFilePath: string;
	projectRootPath: string;
	sequenceFolderPath: string;
	seriesDevelopmentPath: string | null;
}
