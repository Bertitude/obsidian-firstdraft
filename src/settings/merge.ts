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
