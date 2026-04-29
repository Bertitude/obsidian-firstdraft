// YAML scalar escaper for project-creation paths that build frontmatter via
// string interpolation. Wraps the value in double quotes and escapes any
// internal `"` or `\` so titles like "Babylon: Rise of a Shotta" — which
// contain colons that would otherwise be parsed as map separators —
// produce valid YAML.
//
// We always quote (vs. only-when-needed) for predictability: every line we
// write looks the same shape regardless of content. Slightly noisier but
// eliminates a whole class of bugs.
//
// For the `firstdraft:` block keys (kind: series, etc.) we still emit
// unquoted literals — those are values we control, never user input.

export function yamlString(value: string): string {
	const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `"${escaped}"`;
}
