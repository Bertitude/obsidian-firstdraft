import type FirstDraftPlugin from "../main";
import { getDevNotesView } from "../views/dev-notes-view";
import { normalizeSlugline } from "./slugline";

// Find the matching H2 in the rendered dev note and scroll it into view. Returns
// true if a match was scrolled to. No-op if the panel isn't open or no H2 matches.
export function scrollDevNotesToSlugline(
	plugin: FirstDraftPlugin,
	slugline: string,
): boolean {
	const view = getDevNotesView(plugin);
	if (!view) return false;

	const target = normalizeSlugline(slugline);
	if (target === "") return false;

	// Limit search to the rendered scene body. Other sections (characters,
	// locations) sit outside `.firstdraft-scene-body` and shouldn't be matched.
	const body = view.contentEl.querySelector(".firstdraft-scene-body");
	if (!body) return false;

	const headings = body.querySelectorAll<HTMLElement>("h2");
	for (const h of Array.from(headings)) {
		if (normalizeSlugline(h.textContent ?? "") === target) {
			h.scrollIntoView({ behavior: "smooth", block: "start" });
			return true;
		}
	}
	return false;
}
