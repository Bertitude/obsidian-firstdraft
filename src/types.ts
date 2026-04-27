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
	scenesSubfolder: string;
	locationsSubfolder: string;
	referencesSubfolder: string;
	characterCardFields: string[];
	sceneNoteTemplate: string;
	characterNoteTemplate: string;
	locationNoteTemplate: string;
	firstDraftMode: FirstDraftModeConfig;
	debugLogging: boolean;
}

export interface ProjectConfig {
	developmentFolder?: string;
	charactersSubfolder?: string;
	scenesSubfolder?: string;
	locationsSubfolder?: string;
	referencesSubfolder?: string;
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
	sceneFolderPath: string;
	seriesDevelopmentPath: string | null;
}
