import type { FirstDraftSettings, GlobalConfig, ProjectConfig, ProjectMeta } from "../types";

// Returns the effective config for a project: project overrides layered on top
// of global. Only the ProjectConfig subset is overridable; non-overridable
// fields (firstDraftMode, debugLogging, fountainPlugin, etc.) always come from
// global. Returns a NEW object — callers can pass it down without worrying about
// mutating settings.
//
// Settings key resolution:
//   - tv-episode and season projects key by their parent series's
//     `indexFilePath` (`project.seriesIndexPath`). For TV, settings live at
//     the series level and are shared across every episode and season.
//   - feature, series, and orphan tv-episode (no parent series) projects
//     key by their own `indexFilePath`.
//
// When an Index file is renamed, scanner.handleRename migrates the entry's
// position in `scanner.projects`, but external rename-sync logic mirrors
// the change into `settings.projects` keys so overrides keep applying.

export function projectSettingsKey(project: ProjectMeta): string {
	return project.seriesIndexPath ?? project.indexFilePath;
}

export function resolveProjectSettings(
	project: ProjectMeta | null,
	settings: FirstDraftSettings,
): GlobalConfig {
	if (!project) return settings.global;

	const override = settings.projects[projectSettingsKey(project)];
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
	return settings.projects[projectSettingsKey(project)] ?? {};
}

// Drops the project's override entry entirely if it has no defined fields left.
// Called after a "Reset to global" leaves the override empty.
export function pruneEmptyOverride(
	project: ProjectMeta,
	settings: FirstDraftSettings,
): void {
	const key = projectSettingsKey(project);
	const entry = settings.projects[key];
	if (entry && isEmpty(entry)) {
		delete settings.projects[key];
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
