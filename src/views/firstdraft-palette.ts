import { SuggestModal } from "obsidian";
import type FirstDraftPlugin from "../main";

// "FirstDraft palette" — a SuggestModal mirroring Obsidian's command palette
// but scoped to FirstDraft commands only. Opened via its own command (and,
// when First Draft Mode is active, by intercepting Cmd/Ctrl+P so muscle
// memory keeps working without the noise of every other plugin's commands).
//
// Source of truth for the command list is `app.commands` (the runtime
// registry Obsidian builds from every plugin's addCommand calls). We filter
// on the registered prefix `<plugin id>:` so the list stays in sync as we
// add/remove commands without any explicit registration here.

const PLUGIN_PREFIX = "obsidian-firstdraft:";

interface ObsidianCommand {
	id: string;
	name: string;
	icon?: string;
	hotkeys?: unknown;
	checkCallback?: (checking: boolean) => boolean | void;
	callback?: () => unknown;
}

interface CommandsApi {
	commands: Record<string, ObsidianCommand>;
	executeCommandById: (id: string) => boolean;
	listCommands?: () => ObsidianCommand[];
}

export function openFirstDraftPalette(plugin: FirstDraftPlugin): void {
	new FirstDraftPalette(plugin).open();
}

class FirstDraftPalette extends SuggestModal<ObsidianCommand> {
	constructor(private readonly plugin: FirstDraftPlugin) {
		super(plugin.app);
		this.setPlaceholder("FirstDraft command…");
	}

	getSuggestions(query: string): ObsidianCommand[] {
		const all = listFirstDraftCommands(this.plugin);
		const q = query.trim().toLowerCase();
		if (q === "") return all;
		return all.filter((cmd) => cmd.name.toLowerCase().includes(q));
	}

	renderSuggestion(value: ObsidianCommand, el: HTMLElement): void {
		// Strip the auto-prepended "FirstDraft: " prefix Obsidian adds when it
		// concatenates the plugin's manifest name. Cleaner read in a list that's
		// already implicitly all-FirstDraft.
		const name = value.name.replace(/^FirstDraft:\s*/, "");
		el.createDiv({ text: name });
		el.createEl("small", {
			text: value.id.slice(PLUGIN_PREFIX.length),
			cls: "firstdraft-suggestion-meta",
		});
	}

	onChooseSuggestion(value: ObsidianCommand): void {
		const commands = (this.plugin.app as unknown as { commands?: CommandsApi })
			.commands;
		commands?.executeCommandById?.(value.id);
	}
}

function listFirstDraftCommands(plugin: FirstDraftPlugin): ObsidianCommand[] {
	const commands = (plugin.app as unknown as { commands?: CommandsApi }).commands;
	if (!commands) return [];

	// Prefer listCommands() when available — it returns the array form Obsidian
	// uses internally for the default palette (already filtered by checkCallback).
	// Fall back to walking the dict for older builds.
	const arr =
		typeof commands.listCommands === "function"
			? commands.listCommands()
			: Object.values(commands.commands);

	return arr
		.filter((cmd) => cmd.id.startsWith(PLUGIN_PREFIX))
		.sort((a, b) => a.name.localeCompare(b.name));
}
