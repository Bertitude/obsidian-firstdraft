// Fountain slugline parser — extracts production-shaped fields from a
// slugline string for downstream use in scene dev note frontmatter,
// stripboard color coding, location grouping, etc.
//
// Recognised slugline shapes:
//
//   INT. KITCHEN - DAY                  → INT      / KITCHEN     / DAY
//   EXT. PARK - NIGHT                   → EXT      / PARK        / NIGHT
//   INT./EXT. CAR - CONTINUOUS          → INT./EXT./ CAR         / CONTINUOUS
//   I/E. ALLEY - LATER                  → I/E      / ALLEY       / LATER
//   INT. KITCHEN - DAY - LATER          → INT      / KITCHEN     / LATER (last segment wins)
//   INT. KITCHEN                        → INT      / KITCHEN     / ""
//   .LIMBO (forced)                     → ""       / LIMBO       / ""    (forced flag set)
//
// `intext` is normalized to one of: "INT", "EXT", "INT./EXT.", "I/E", "" (forced/unparsed)
// `location` is uppercase, trimmed
// `time` is uppercase, trimmed; empty when no " - " separator present
// `forced` is true for sluglines starting with "." (Fountain forced scene heading)

export interface ParsedSlugline {
	raw: string;            // verbatim input (after dot prefix removed if forced)
	intext: string;         // INT | EXT | INT./EXT. | I/E | ""
	location: string;
	time: string;
	forced: boolean;
}

// Normalised forms we recognise. Order matters — longer matches first so
// "INT./EXT." doesn't get truncated to "INT."
const INTEXT_PATTERNS: Array<[RegExp, string]> = [
	[/^INT\.?\s*\/\s*EXT\.?/i, "INT./EXT."],
	[/^I\s*\/\s*E\.?/i, "I/E"],
	[/^INT\.?/i, "INT"],
	[/^EXT\.?/i, "EXT"],
];

export function parseSlugline(input: string): ParsedSlugline {
	const trimmed = input.trim();
	if (trimmed === "") {
		return { raw: "", intext: "", location: "", time: "", forced: false };
	}

	// Forced slugline (Fountain "." prefix). Strip the dot, keep everything
	// else as the location; intext/time are blank because forced sluglines
	// don't follow the conventional grammar.
	if (trimmed.startsWith(".") && !trimmed.startsWith("..")) {
		const rest = trimmed.slice(1).trim();
		return {
			raw: rest,
			intext: "",
			location: rest.toUpperCase(),
			time: "",
			forced: true,
		};
	}

	// Match the intext prefix (if any) and capture the remainder.
	let intext = "";
	let remainder = trimmed;
	for (const [pattern, normalized] of INTEXT_PATTERNS) {
		const m = pattern.exec(trimmed);
		if (m) {
			intext = normalized;
			remainder = trimmed.slice(m[0].length).trim();
			break;
		}
	}

	// Split remainder on " - " (the standard Fountain separator). If multiple
	// " - " separators exist (e.g. "KITCHEN - DAY - LATER"), the LAST segment
	// is treated as the time-of-day; everything before it is the location.
	// Most scripts only have one " - " so the common case is unambiguous.
	const parts = remainder.split(/\s+-\s+/);
	let location: string;
	let time: string;
	if (parts.length === 1) {
		location = parts[0]!.trim().toUpperCase();
		time = "";
	} else {
		time = parts[parts.length - 1]!.trim().toUpperCase();
		location = parts.slice(0, -1).join(" - ").trim().toUpperCase();
	}

	return {
		raw: trimmed,
		intext,
		location,
		time,
		forced: false,
	};
}
