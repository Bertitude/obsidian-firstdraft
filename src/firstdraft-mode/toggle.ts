import { Notice } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { FirstDraftModeConfig } from "../types";
import { isPluginEnabled } from "../fountain/plugin-mode";
import { activateProjectHomeView } from "../views/project-home-view";
import { activateProjectNotesView } from "../views/project-notes-view";

const TYPEWRITER_PLUGIN_ID = "obsidian-typewriter-mode";
const TYPEWRITER_TOGGLE_COMMAND = "obsidian-typewriter-mode:toggle-typewriter-scroll";

const CLASS_ACTIVE = "firstdraft-active";
const CLASS_HIDE_RIBBON = "firstdraft-hide-ribbon";
const CLASS_HIDE_STATUSBAR = "firstdraft-hide-statusbar";

interface CommandsApi {
	executeCommandById?: (id: string) => boolean;
}

interface WorkspaceWithLayout {
	getLayout?: () => unknown;
	changeLayout?: (layout: unknown) => Promise<void>;
}

export function applyBodyClasses(active: boolean, settings: FirstDraftModeConfig): void {
	const body = document.body.classList;
	body.toggle(CLASS_ACTIVE, active);
	body.toggle(CLASS_HIDE_RIBBON, active && settings.hideRibbon);
	body.toggle(CLASS_HIDE_STATUSBAR, active && settings.hideStatusBar);
	// Left sidebar is no longer hidden in FDM — it hosts Project Home as the
	// sole navigation surface (tab strip hidden via CSS). The legacy
	// `hideLeftSidebar` setting is ignored.
}

export async function toggleFirstDraftMode(plugin: FirstDraftPlugin): Promise<void> {
	const cfg = plugin.settings.global.firstDraftMode;
	if (cfg.active) {
		await exitFirstDraftMode(plugin);
	} else {
		await enterFirstDraftMode(plugin);
	}
}

async function enterFirstDraftMode(plugin: FirstDraftPlugin): Promise<void> {
	const cfg = plugin.settings.global.firstDraftMode;
	const workspace = plugin.app.workspace as unknown as WorkspaceWithLayout;

	cfg.savedLayout = workspace.getLayout?.() ?? null;

	// Open Project Home in the left sidebar so it's the active tab. The CSS
	// rule on `body.firstdraft-active` hides the sidebar tab strip, so Project
	// Home is the only visible navigation surface while FDM is on.
	await activateProjectHomeView(plugin);

	// Make sure the sidebar is expanded — FDM is now sidebar-with-Project-Home
	// by design. The legacy hideLeftSidebar setting is ignored.
	plugin.app.workspace.leftSplit.expand();

	// Optional: open the project notes panel in the right sidebar too. Off by
	// default to keep FDM minimal; opt-in via the FDM settings toggle.
	if (cfg.openProjectNotes) {
		await activateProjectNotesView(plugin);
		plugin.app.workspace.rightSplit.expand();
	}

	cfg.active = true;
	applyBodyClasses(true, cfg);

	fireTypewriterToggle(plugin);

	await plugin.saveSettings();
	new Notice("First draft mode on");
}

async function exitFirstDraftMode(plugin: FirstDraftPlugin): Promise<void> {
	const cfg = plugin.settings.global.firstDraftMode;
	const workspace = plugin.app.workspace as unknown as WorkspaceWithLayout;

	cfg.active = false;
	applyBodyClasses(false, cfg);

	const saved = cfg.savedLayout;
	cfg.savedLayout = null;

	if (saved && workspace.changeLayout) {
		try {
			await workspace.changeLayout(saved);
		} catch {
			plugin.app.workspace.leftSplit.expand();
		}
	} else {
		plugin.app.workspace.leftSplit.expand();
	}

	fireTypewriterToggle(plugin);

	await plugin.saveSettings();
	new Notice("First draft mode off");
}

export function exitFirstDraftModeSync(plugin: FirstDraftPlugin): void {
	const cfg = plugin.settings.global.firstDraftMode;
	cfg.active = false;
	cfg.savedLayout = null;
	applyBodyClasses(false, cfg);
}

function fireTypewriterToggle(plugin: FirstDraftPlugin): void {
	if (!isPluginEnabled(plugin, TYPEWRITER_PLUGIN_ID)) {
		new Notice("Typewriter scroll plugin not installed — skipping", 3000);
		return;
	}
	const commands = (plugin.app as unknown as { commands?: CommandsApi }).commands;
	const ok = commands?.executeCommandById?.(TYPEWRITER_TOGGLE_COMMAND) ?? false;
	if (!ok) {
		new Notice("Typewriter scroll command not found — skipping", 3000);
	}
}
