import type { ProjectMeta, FirstDraftSettings } from "../types";

// Derives a project's "note tag" — the tag users add to notes anywhere in
// the vault to surface them in the project notes panel. Default form is a
// kebab-case slug of the project title; per-project override lives in
// `settings.projects[indexFilePath].noteTag`.
//
// Returned WITHOUT the leading `#` — callers add it where needed (UI display
// vs. metadataCache lookup may want different forms).

export function deriveNoteTag(project: ProjectMeta): string {
	const source = project.title ?? basenameOf(project.indexFilePath);
	return slugify(source);
}

export function resolveNoteTag(
	project: ProjectMeta,
	settings: FirstDraftSettings,
): string {
	const override = settings.projects[project.indexFilePath]?.noteTag;
	if (override && override.trim() !== "") return override.trim().replace(/^#/, "");
	return deriveNoteTag(project);
}

// True if `tag` (with or without leading `#`) is the project's note tag, or
// any sub-tag under it (e.g. `fraidy-fraidy/antonia` matches `fraidy-fraidy`).
// Hierarchy-aware match keeps the user-facing UX flat while letting users
// adopt subtag organisation freely without code changes.
export function tagMatchesProject(tag: string, projectTag: string): boolean {
	const t = tag.replace(/^#/, "");
	const p = projectTag.replace(/^#/, "");
	if (!p) return false;
	return t === p || t.startsWith(`${p}/`);
}

// Kebab-case slugifier. Lowercases, replaces non-alphanumerics with hyphens,
// collapses runs, trims edges. Matches the Obsidian-y feel for tag slugs.
function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function basenameOf(path: string): string {
	const seg = path.split("/").pop() ?? path;
	return seg.replace(/\.md$/, "");
}
