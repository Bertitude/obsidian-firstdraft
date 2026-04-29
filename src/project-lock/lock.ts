import { Notice } from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "../projects/resolver";

// Lock the file explorer to a single project. When active, only the locked
// project's folder tree (plus its ancestor folders, so the user can navigate
// to it) is visible in Obsidian's file explorer. Other surfaces (quick
// switcher, search, links) are unaffected — this is a navigation hint only.
//
// Implementation: dynamic <style> tag generated from the locked path, plus a
// body class. CSS uses :has() to hide whole .nav-folder and .nav-file
// containers whose titles don't match the project tree. Removed on toggle off.
//
// Session-only — never persisted. Toggling off clears state. Independent of
// First Draft Mode (separate command).

const STYLE_ID = "firstdraft-project-lock-style";
const BODY_CLASS = "firstdraft-project-locked";

let lockedRoot: string | null = null;

export function toggleProjectLock(plugin: FirstDraftPlugin): void {
	if (lockedRoot !== null) {
		clearLock();
		new Notice("Project lock off.");
		return;
	}

	const active = plugin.app.workspace.getActiveFile();
	if (!active) {
		new Notice("Open a file inside a project first.");
		return;
	}
	const project = resolveActiveProject(active, plugin.scanner);
	if (!project) {
		new Notice("Active file isn't inside a recognised project.");
		return;
	}

	applyLock(project.projectRootPath);
	new Notice(`Locked to "${project.title ?? project.projectRootPath}".`);
}

// For onunload — strip any injected style and class so they don't leak.
export function clearProjectLockOnUnload(): void {
	clearLock();
}

function applyLock(rootPath: string): void {
	lockedRoot = rootPath;
	document.body.classList.add(BODY_CLASS);

	const style = ensureStyleEl();
	style.textContent = generateCss(rootPath);
}

function clearLock(): void {
	lockedRoot = null;
	document.body.classList.remove(BODY_CLASS);
	const style = document.getElementById(STYLE_ID);
	if (style) style.remove();
}

function ensureStyleEl(): HTMLStyleElement {
	let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
	if (el) return el;
	el = document.createElement("style");
	el.id = STYLE_ID;
	document.head.appendChild(el);
	return el;
}

// Build CSS that hides every .nav-folder / .nav-file in the file explorer
// EXCEPT those that are:
//   - the locked project root folder
//   - inside the locked project root
//   - an ancestor folder of the locked root (so the path is navigable)
function generateCss(rootPath: string): string {
	const ancestors: string[] = [];
	let cur = rootPath;
	while (cur.includes("/")) {
		cur = cur.slice(0, cur.lastIndexOf("/"));
		ancestors.push(cur);
	}

	const escape = (s: string) => s.replace(/"/g, '\\"');

	const folderShowSelectors: string[] = [
		`.nav-folder:has(> .nav-folder-title[data-path="${escape(rootPath)}"])`,
		`.nav-folder:has(> .nav-folder-title[data-path^="${escape(rootPath)}/"])`,
		...ancestors.map(
			(a) => `.nav-folder:has(> .nav-folder-title[data-path="${escape(a)}"])`,
		),
	];

	const fileShowSelectors: string[] = [
		`.nav-file:has(> .nav-file-title[data-path^="${escape(rootPath)}/"])`,
	];

	const hideRule = `
body.${BODY_CLASS} .workspace-leaf-content[data-type="file-explorer"] .nav-folder,
body.${BODY_CLASS} .workspace-leaf-content[data-type="file-explorer"] .nav-file {
	display: none;
}
`;

	const showRule = `
body.${BODY_CLASS} .workspace-leaf-content[data-type="file-explorer"] :is(${folderShowSelectors.join(
		",\n",
	)}, ${fileShowSelectors.join(",\n")}) {
	display: revert;
}
`;

	// The root .nav-folder of the file explorer (vault root) needs to stay
	// visible since it contains everything. Targeting by checking that the
	// folder's first child title has empty data-path (vault root has data-path="").
	const vaultRootRule = `
body.${BODY_CLASS} .workspace-leaf-content[data-type="file-explorer"] > .nav-folder.mod-root {
	display: revert;
}
`;

	return hideRule + showRule + vaultRootRule;
}
