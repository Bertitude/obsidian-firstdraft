import type { ProjectMeta, FirstDraftSettings } from "../types";
import { projectSettingsKey } from "../settings/resolve";

// Derives a project's "note tag" — the tag users add to notes anywhere in
// the vault to surface them in the project notes panel. Default form is a
// kebab-case slug of the project's PRIMARY title (ignoring any subtitle so
// franchise variants like "Power: Book II" share `#power`), falling back
// to the project's folder name (NOT the index file's basename — that would
// resolve to "index" for any project whose frontmatter lacks a `title:`
// field). Per-project override lives in
// `settings.projects[indexFilePath].noteTag` for users who want something
// different (e.g. `#power-book-ii` to disambiguate within a franchise).
//
// Returned WITHOUT the leading `#` — callers add it where needed (UI display
// vs. metadataCache lookup may want different forms).

export function deriveNoteTag(project: ProjectMeta): string {
	const title = project.title?.trim();
	const source = title && title !== "" ? title : lastSegmentOf(project.projectRootPath);
	return slugify(source);
}

export function resolveNoteTag(
	project: ProjectMeta,
	settings: FirstDraftSettings,
): string {
	const override = settings.projects[projectSettingsKey(project)]?.noteTag;
	if (override && override.trim() !== "") return override.trim().replace(/^#/, "");
	return deriveNoteTag(project);
}

// True if `tag` (with or without leading `#`) is the project's note tag, or
// any sub-tag under it. Match is fuzzy: case-insensitive and ignores any
// non-alphanumeric separators on the head segment, so all of these match
// the canonical project tag `#fraidy-fraidy`:
//
//   #fraidy-fraidy        — canonical
//   #FraidyFraidy         — pascal-case, no separator
//   #fraidy_fraidy        — underscore separator
//   #FRAIDY-FRAIDY        — caps
//   #fraidy-fraidy/antonia — subtag (hierarchy-aware)
//   #fraidyFraidy/research — subtag with non-canonical head
//
// Subtags are detected by `/`; everything before the first slash is the
// head segment that must match the project tag. Anything after `/` is
// treated as user-defined organisation and accepted as long as the head
// matches.
export function tagMatchesProject(tag: string, projectTag: string): boolean {
	const t = tag.replace(/^#/, "");
	const p = projectTag.replace(/^#/, "");
	if (!p) return false;
	const head = t.split("/")[0] ?? "";
	return normalizeForMatch(head) === normalizeForMatch(p);
}

function normalizeForMatch(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Kebab-case slugifier. Lowercases, replaces non-alphanumerics with hyphens,
// collapses runs, trims edges. Matches the Obsidian-y feel for tag slugs.
function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function lastSegmentOf(path: string): string {
	return path.split("/").pop() ?? path;
}
