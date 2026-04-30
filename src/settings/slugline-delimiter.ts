// Sub-location delimiter presets for slug-line composition. The four cases
// below cover every screenplay convention we've seen — comma without a
// leading space (the SMPTE-style "PRIMARY, SUB"), hyphen / em-dash padded
// with spaces, or a forward slash with no spacing. Storing the literal
// inserted string (rather than just the delimiter character) keeps the
// composition logic simple — `${primary}${delimiter}${sub}` Just Works.

export interface DelimiterPreset {
	value: string;
	label: string;
}

export const SLUGLINE_DELIMITER_PRESETS: DelimiterPreset[] = [
	{ value: ", ", label: 'Comma  ("PRIMARY, SUB")' },
	{ value: " - ", label: 'Hyphen  ("PRIMARY - SUB")' },
	{ value: " — ", label: 'Em-dash  ("PRIMARY — SUB")' },
	{ value: "/", label: 'Slash  ("PRIMARY/SUB")' },
];

export const DEFAULT_SLUGLINE_DELIMITER = ", ";

// Coerce any saved delimiter value to one of the presets. Handles legacy
// data where the trim bug stored bare punctuation (`-`, `,`, `—`) and any
// mismatched whitespace variants. Falls back to the default when the input
// can't be confidently mapped to a preset.
export function normaliseDelimiterValue(raw: unknown): string {
	if (typeof raw !== "string") return DEFAULT_SLUGLINE_DELIMITER;
	if (raw === "") return DEFAULT_SLUGLINE_DELIMITER;
	for (const preset of SLUGLINE_DELIMITER_PRESETS) {
		if (raw === preset.value) return preset.value;
	}
	const stripped = raw.trim();
	if (stripped === ",") return ", ";
	if (stripped === "-") return " - ";
	if (stripped === "—") return " — ";
	if (stripped === "/") return "/";
	return DEFAULT_SLUGLINE_DELIMITER;
}
