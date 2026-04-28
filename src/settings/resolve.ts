import type { FirstDraftSettings, GlobalConfig, ProjectConfig, ProjectMeta } from "../types";

// Returns the effective config for a project: project overrides layered on top
// of global. Only the 9 ProjectConfig fields are overridable; non-overridable
// fields (firstDraftMode, debugLogging, fountainPlugin, etc.) always come from
// global. Returns a NEW object — callers can pass it down without worrying about
// mutating settings.
//
// Project key is `indexFilePath` (matches ProjectScanner). When the index file
// is renamed, scanner.handleRename also migrates this key (see scanner.ts).

export function resolveProjectSettings(
	project: ProjectMeta | null,
	settings: FirstDraftSettings,
): GlobalConfig {
	if (!project) return settings.global;

	const override = settings.projects[project.indexFilePath];
	if (!override || isEmpty(override)) return settings.global;

	return {
		...settings.global,
		...definedOnly(override),
	};
}

// True if the project has any saved overrides at all. Used by the modal to
// decide whether to render the "Reset to global" affordance per field.
export function getProjectOverride(
	project: ProjectMeta,
	settings: FirstDraftSettings,
): ProjectConfig {
	return settings.projects[project.indexFilePath] ?? {};
}

// Drops the project's override entry entirely if it has no defined fields left.
// Called after a "Reset to global" leaves the override empty.
export function pruneEmptyOverride(
	project: ProjectMeta,
	settings: FirstDraftSettings,
): void {
	const entry = settings.projects[project.indexFilePath];
	if (entry && isEmpty(entry)) {
		delete settings.projects[project.indexFilePath];
	}
}

function isEmpty(cfg: ProjectConfig): boolean {
	for (const v of Object.values(cfg)) {
		if (v !== undefined) return false;
	}
	return true;
}

// Strip undefined fields so spreading the override doesn't overwrite global
// fields with undefined (which would set them to undefined, not fall through).
function definedOnly(cfg: ProjectConfig): Partial<GlobalConfig> {
	const out: Partial<GlobalConfig> = {};
	for (const [k, v] of Object.entries(cfg)) {
		if (v !== undefined) {
			(out as Record<string, unknown>)[k] = v;
		}
	}
	return out;
}
