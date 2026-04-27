import type FirstDraftPlugin from "../main";

// Resolves which fountain plugin FirstDraft should integrate with. The resolved
// mode controls whether FirstDraft registers the .fountain extension to the
// markdown view (so EditorSuggest fires inline), and which behaviour the
// settings tab surfaces to the user.
//
// "bgrundmann" — bgrundmann's `obsidian-fountain` is the fountain editor.
//   Custom view; no inline EditorSuggest. Picker commands are the autocomplete
//   path. FirstDraft does NOT register the extension.
//
// "chuangcaleb" — chuangcaleb's `obsidian-fountain-editor` is the fountain
//   styler. Markdown view via FirstDraft's extension registration. EditorSuggest
//   fires inline alongside the picker commands.
//
// "other" — neither known plugin enabled. FirstDraft does no extension handling;
//   the picker is the autocomplete path.

export type FountainMode = "bgrundmann" | "chuangcaleb" | "other";

const BGRUNDMANN_PLUGIN_ID = "fountain";
// Confirmed via manifest.json — the plugin's id is "fountain-editor",
// not "obsidian-fountain-editor" as the GitHub repo name might suggest.
const CHUANGCALEB_PLUGIN_ID = "fountain-editor";

interface PluginsApi {
	plugins?: Record<string, unknown>;
}

export function isPluginEnabled(plugin: FirstDraftPlugin, id: string): boolean {
	const api = (plugin.app as unknown as { plugins?: PluginsApi }).plugins;
	const enabled = api?.plugins?.[id];
	return Boolean(enabled);
}

export function resolveFountainMode(plugin: FirstDraftPlugin): FountainMode {
	const setting = plugin.settings.global.fountainPlugin;
	if (setting === "bgrundmann" || setting === "chuangcaleb" || setting === "other") {
		return setting;
	}
	// "auto" — pick based on which plugin is enabled.
	if (isPluginEnabled(plugin, CHUANGCALEB_PLUGIN_ID)) return "chuangcaleb";
	if (isPluginEnabled(plugin, BGRUNDMANN_PLUGIN_ID)) return "bgrundmann";
	return "other";
}

export function describeMode(mode: FountainMode): string {
	switch (mode) {
		case "bgrundmann":
			return "bgrundmann's Fountain plugin (custom view)";
		case "chuangcaleb":
			return "chuangcaleb's Fountain Editor (Markdown view)";
		case "other":
			return "no known fountain plugin detected";
	}
}

export const KNOWN_PLUGIN_IDS = {
	bgrundmann: BGRUNDMANN_PLUGIN_ID,
	chuangcaleb: CHUANGCALEB_PLUGIN_ID,
};
