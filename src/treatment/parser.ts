// Parses an outline markdown document into discrete beats. Each H2 heading is
// treated as a beat; the prose between it and the next H2 (or end-of-file) is
// the beat body. H1 is treated as the document title and ignored. H3+ stays
// inside its parent H2's body — sub-beats aren't promoted to their own scenes.

export interface Beat {
	title: string; // H2 heading text, stripped of markdown formatting
	body: string; // markdown content between this H2 and the next, trimmed
}

export function parseTreatmentBeats(markdown: string): Beat[] {
	const stripped = stripFrontmatter(markdown);
	const lines = stripped.split(/\r?\n/);
	const beats: Beat[] = [];

	let current: { title: string; lines: string[] } | null = null;
	let inFence = false;

	for (const line of lines) {
		// Track fenced code blocks so we don't mistake `## comment` inside one
		// for a beat heading.
		if (/^```/.test(line)) {
			inFence = !inFence;
			if (current) current.lines.push(line);
			continue;
		}
		if (inFence) {
			if (current) current.lines.push(line);
			continue;
		}

		const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line);
		if (h2 && h2[1] !== undefined) {
			if (current) beats.push(finalizeBeat(current));
			current = { title: cleanHeadingText(h2[1]), lines: [] };
			continue;
		}

		if (current) current.lines.push(line);
	}

	if (current) beats.push(finalizeBeat(current));
	return beats.filter((b) => b.title !== "");
}

function finalizeBeat(c: { title: string; lines: string[] }): Beat {
	return { title: c.title, body: c.lines.join("\n").trim() };
}

// Strip basic inline markdown so the heading text becomes a clean filename.
function cleanHeadingText(s: string): string {
	return s
		.replace(/`([^`]*)`/g, "$1") // inline code
		.replace(/\*\*([^*]+)\*\*/g, "$1") // bold
		.replace(/\*([^*]+)\*/g, "$1") // italics
		.replace(/__([^_]+)__/g, "$1")
		.replace(/_([^_]+)_/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → label only
		.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => alias ?? target)
		.trim();
}

function stripFrontmatter(md: string): string {
	if (!md.startsWith("---")) return md;
	const end = md.indexOf("\n---", 3);
	if (end === -1) return md;
	return md.slice(end + 4).replace(/^\r?\n/, "");
}

// Sanitize a heading title for use as a filename. Removes/replaces characters
// that are invalid in Obsidian/OS filenames. Returns null if nothing usable
// remains after sanitization.
export function titleToFilename(title: string): string | null {
	const cleaned = title
		.replace(/[\\/:*?"<>|]/g, "-") // forbidden filename chars
		.replace(/\s+/g, " ")
		.replace(/^[.\s]+|[.\s]+$/g, "")
		.trim();
	return cleaned === "" ? null : cleaned;
}
