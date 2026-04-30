import { Notice } from "obsidian";
import type FirstDraftPlugin from "../main";
import { resolveActiveProject } from "../projects/resolver";

// Lock the file explorer to a single project. When active, only the locked
// project's folder tree (plus its ancestor folders, so the user can navigate
// to it) is visible in Obsidian's file explorer. Other surfaces (quick
// switcher, search, links) are unaffected — this is a navigation hint only.
//
// Implementation: a constructable CSSStyleSheet adopted on the document
// generates path-specific show selectors, plus a body class. Static
// hide/vault-root rules live in styles.css. CSS uses :has() to hide whole
// .nav-folder and .nav-file containers whose titles don't match the project
// tree. Removed on toggle off.
//
// Session-only — never persisted. Toggling off clears state. Independent of
// First Draft Mode (separate command).

const BODY_CLASS = "firstdraft-project-locked";

let lockedRoot: string | null = null;
let lockSheet: CSSStyleSheet | null = null;

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
	adoptLockSheet(generateCss(rootPath));
}

function clearLock(): void {
	lockedRoot = null;
	document.body.classList.remove(BODY_CLASS);
	releaseLockSheet();
}

// Adopt a constructable CSSStyleSheet on the document so the dynamic
// per-path selectors take effect without creating a <style> element.
function adoptLockSheet(css: string): void {
	if (!lockSheet) {
		lockSheet = new CSSStyleSheet();
		document.adoptedStyleSheets = [...document.adoptedStyleSheets, lockSheet];
	}
	lockSheet.replaceSync(css);
}

function releaseLockSheet(): void {
	if (!lockSheet) return;
	document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
		(s) => s !== lockSheet,
	);
	lockSheet = null;
}

// Build CSS that shows the locked project root folder, anything inside it,
// and the ancestor folders that lead to it. The static hide rule plus
// vault-root rule live in styles.css.
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

	return `
body.${BODY_CLASS} .workspace-leaf-content[data-type="file-explorer"] :is(${folderShowSelectors.join(
		",\n",
	)}, ${fileShowSelectors.join(",\n")}) {
	display: revert;
}
`;
}
