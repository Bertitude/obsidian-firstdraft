// Filename sanitization shared by every code path that derives a folder/file
// name from user-provided text (selection-create, autocomplete create entry,
// conflict suffix flow). Replaces characters that would break filesystem rules
// or produce ugly artifacts like "Marcus Sr..md" with the configured symbol.

const FORBIDDEN_CHARS = /[\\/:*?"<>|]/g;

export function sanitizeFilename(input: string, replacement: string): string | null {
	const safeReplacement = replacement.length === 0 ? "_" : replacement.charAt(0);
	let cleaned = input.replace(FORBIDDEN_CHARS, safeReplacement);

	// Collapse runs of whitespace to a single space.
	cleaned = cleaned.replace(/\s+/g, " ").trim();

	// Strip trailing periods (avoids "Marcus Sr..md" double-dot at extension boundary).
	while (cleaned.endsWith(".")) {
		cleaned = cleaned.slice(0, -1) + safeReplacement;
		// Re-trim in case the replacement is whitespace-like (shouldn't be by guard above).
		cleaned = cleaned.trimEnd();
	}

	if (cleaned === "" || cleaned === safeReplacement) return null;
	return cleaned;
}

export function toTitleCase(name: string): string {
	return name
		.toLowerCase()
		.split(/\s+/)
		.map((w) => (w.length === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
		.join(" ");
}
