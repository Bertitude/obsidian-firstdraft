import type { FirstDraftSettings, GlobalConfig, FirstDraftModeConfig } from "../types";

// Deep enough merge to handle the two nested objects (`global`, `global.firstDraftMode`)
// that the spec defines. Arrays (e.g. characterCardFields) are replaced wholesale —
// not concatenated — so user customisations override defaults instead of accumulating.

interface PartialLoaded {
	projects?: FirstDraftSettings["projects"];
	global?: Partial<GlobalConfig> & { firstDraftMode?: Partial<FirstDraftModeConfig> };
}

export function mergeSettings(
	loaded: PartialLoaded | null | undefined,
	defaults: FirstDraftSettings,
): FirstDraftSettings {
	const safe = loaded ?? {};
	const loadedGlobal = safe.global ?? {};
	const loadedMode = loadedGlobal.firstDraftMode ?? {};

	// Backward compat: legacy installs stored `scenesSubfolder`. Copy its value
	// into `sequencesSubfolder` if the new key isn't already present so the
	// user's customisation (e.g. "Scenes" folder name) survives the rename.
	const legacy = loadedGlobal as unknown as { scenesSubfolder?: string };
	if (
		legacy.scenesSubfolder &&
		typeof legacy.scenesSubfolder === "string" &&
		!loadedGlobal.sequencesSubfolder
	) {
		loadedGlobal.sequencesSubfolder = legacy.scenesSubfolder;
	}

	return {
		projects: safe.projects ?? {},
		global: {
			...defaults.global,
			...loadedGlobal,
			firstDraftMode: {
				...defaults.global.firstDraftMode,
				...loadedMode,
			},
		},
	};
}
