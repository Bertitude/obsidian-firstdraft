import { Notice } from "obsidian";
import type FirstDraftPlugin from "../main";
import type { FirstDraftModeConfig } from "../types";
import { isPluginEnabled } from "../fountain/plugin-mode";

const TYPEWRITER_PLUGIN_ID = "obsidian-typewriter-mode";
const TYPEWRITER_TOGGLE_COMMAND = "obsidian-typewriter-mode:toggle-typewriter-scroll";

const CLASS_ACTIVE = "firstdraft-active";
const CLASS_HIDE_RIBBON = "firstdraft-hide-ribbon";
const CLASS_HIDE_STATUSBAR = "firstdraft-hide-statusbar";
const CLASS_HIDE_LEFT_SIDEBAR = "firstdraft-hide-left-sidebar";

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
	body.toggle(CLASS_HIDE_LEFT_SIDEBAR, active && settings.hideLeftSidebar);
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

	if (cfg.hideLeftSidebar) {
		plugin.app.workspace.leftSplit.collapse();
	}

	cfg.active = true;
	applyBodyClasses(true, cfg);

	fireTypewriterToggle(plugin);

	await plugin.saveSettings();
	new Notice("First Draft Mode on");
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
	new Notice("First Draft Mode off");
}

export function exitFirstDraftModeSync(plugin: FirstDraftPlugin): void {
	const cfg = plugin.settings.global.firstDraftMode;
	cfg.active = false;
	cfg.savedLayout = null;
	applyBodyClasses(false, cfg);
}

function fireTypewriterToggle(plugin: FirstDraftPlugin): void {
	if (!isPluginEnabled(plugin, TYPEWRITER_PLUGIN_ID)) {
		new Notice("Typewriter Scroll plugin not installed — skipping", 3000);
		return;
	}
	const commands = (plugin.app as unknown as { commands?: CommandsApi }).commands;
	const ok = commands?.executeCommandById?.(TYPEWRITER_TOGGLE_COMMAND) ?? false;
	if (!ok) {
		new Notice("Typewriter Scroll command not found — skipping", 3000);
	}
}
