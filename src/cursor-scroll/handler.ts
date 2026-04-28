import { MarkdownView } from "obsidian";
import type FirstDraftPlugin from "../main";
import { isFountainFile } from "../fountain/file-detection";
import { findSluglineAtOrAbove, normalizeSlugline } from "./slugline";
import { scrollDevNotesToSlugline } from "./scroll";

const DEBOUNCE_MS = 150;

// Hooks selectionchange (covers both clicks and arrow keys in CM6's
// contenteditable editor) plus active-leaf-change. Debounces so rapid typing
// doesn't thrash. Caches the last resolved slugline so we don't re-scroll when
// the cursor moves within the same scene.
//
// Realistically only fires in chuangcaleb mode where fountain files open in a
// MarkdownView. In bgrundmann mode `getActiveViewOfType(MarkdownView)` returns
// null and we silently no-op.
export function installCursorScrollHandler(plugin: FirstDraftPlugin): void {
	let timer: number | null = null;
	let lastSluglineKey: string | null = null;

	const trigger = () => {
		if (timer !== null) window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			timer = null;
			runOnce(plugin, (key) => {
				if (key === lastSluglineKey) return false;
				lastSluglineKey = key;
				return true;
			});
		}, DEBOUNCE_MS);
	};

	plugin.registerDomEvent(document, "selectionchange", trigger);
	plugin.registerEvent(
		plugin.app.workspace.on("active-leaf-change", () => {
			lastSluglineKey = null;
			trigger();
		}),
	);
}

function runOnce(
	plugin: FirstDraftPlugin,
	shouldScroll: (sluglineKey: string) => boolean,
): void {
	const active = plugin.app.workspace.getActiveFile();
	if (!active || !isFountainFile(active)) return;

	const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
	if (!view || view.file?.path !== active.path) return;

	const cursor = view.editor.getCursor();
	const text = view.editor.getValue();
	const slugline = findSluglineAtOrAbove(text, cursor.line);
	if (!slugline) return;

	const key = normalizeSlugline(slugline);
	if (!shouldScroll(key)) return;
	scrollDevNotesToSlugline(plugin, slugline);
}
