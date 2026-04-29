// Phase 3c — Beat sheet templates. Each template is just an ordered list of
// beat names. Applied to a project's Index.md `beats:` frontmatter array.
// User can edit/extend after applying.

export interface BeatTemplate {
	id: string;
	label: string;
	description: string;
	beats: string[];
}

export const BEAT_TEMPLATES: BeatTemplate[] = [
	{
		id: "save-the-cat",
		label: "Save the Cat (15 beats)",
		description: "Blake Snyder's structural template for feature films.",
		beats: [
			"Opening Image",
			"Theme Stated",
			"Setup",
			"Catalyst",
			"Debate",
			"Break Into Two",
			"B Story",
			"Fun and Games",
			"Midpoint",
			"Bad Guys Close In",
			"All Is Lost",
			"Dark Night of the Soul",
			"Break Into Three",
			"Finale",
			"Final Image",
		],
	},
	{
		id: "hero-journey",
		label: "Hero's Journey (12 stages)",
		description: "Christopher Vogler's adaptation of Joseph Campbell's monomyth.",
		beats: [
			"Ordinary World",
			"Call to Adventure",
			"Refusal of the Call",
			"Meeting the Mentor",
			"Crossing the Threshold",
			"Tests, Allies, Enemies",
			"Approach to the Inmost Cave",
			"The Ordeal",
			"Reward",
			"The Road Back",
			"Resurrection",
			"Return with the Elixir",
		],
	},
	{
		id: "story-circle",
		label: "Dan Harmon's Story Circle (8 steps)",
		description: "Compact template that fits TV episodes well.",
		beats: [
			"You (comfort zone)",
			"Need (something they want)",
			"Go (cross the threshold)",
			"Search (adapt to the new situation)",
			"Find (get what they wanted)",
			"Take (pay the price)",
			"Return (back to the familiar)",
			"Change (transformed by the journey)",
		],
	},
];

export function findTemplate(id: string): BeatTemplate | null {
	return BEAT_TEMPLATES.find((t) => t.id === id) ?? null;
}
