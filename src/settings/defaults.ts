import type { FirstDraftSettings } from "../types";

// prettier-ignore
export const SCENE_NOTE_TEMPLATE = `---
scene:
locations: []
time:
characters: []
tags: []
status: draft
---

## Sequence Overview

## Notes

## Continuity

<!-- For sequences with multiple sluglines, add one H2 per slugline below
     (e.g. "## INT. CAR - DAY") and put per-scene notes underneath.
     Phase 3 will scroll to the matching section as your cursor moves. -->
`;

// prettier-ignore
export const CHARACTER_NOTE_TEMPLATE = `---
role:
motivation:
first_appearance:
relationships: []
---

## Background

## Psychology

## Arc

### Series Arc
Overall trajectory across the full series.

### S01
What happens to this character this season.

### S01E01
What changes for this character in this episode.

## Notes
`;

// prettier-ignore
export const LOCATION_NOTE_TEMPLATE = `---
type:
first_appearance:
episodes: []
---

## Description

Physical description. What does it look, feel, smell like?
What does it say about the characters who inhabit it?

## History

Backstory of the location relevant to the story.

## Notes
`;

// prettier-ignore
export const TREATMENT_TEMPLATE = `---
type: treatment
status: draft
promoted_at:
---

# Treatment

<!-- Add one H2 per beat. The H2 title becomes the sequence's filename when
     you run "FirstDraft: Make sequences from treatment". The prose under
     each H2 becomes the dev note's "Sequence Overview" section. -->

## First beat
What happens here. A few sentences.

## Second beat
What happens next.
`;

export const DEFAULT_SETTINGS: FirstDraftSettings = {
	projects: {},
	global: {
		developmentFolder: "Development",
		charactersSubfolder: "Characters",
		sequencesSubfolder: "Sequences",
		locationsSubfolder: "Locations",
		referencesSubfolder: "References",
		notesSubfolder: "Notes",
		seasonsFolder: "Seasons",
		// Episode naming template — used by the "Create episode" command to
		// compose episode folder names from user-supplied tokens. Available
		// tokens: {episode} (full code, e.g. S01E01), {title}, {season}
		// (parsed from {episode}, e.g. 01), {productionCode}, {date}.
		// Default produces "S01E01 - Pilot".
		episodeNameTemplate: "{episode} - {title}",
		// Delimiter inserted between PRIMARY and SUB-LOCATION in slug-line
		// autocomplete output. The standard screenplay convention is a
		// comma + space ("INT. SMITH HOUSE, BEDROOM - DAY") which leaves
		// " - " free for the time-of-day delimiter. Per-project overridable.
		sluglineSubLocationDelimiter: ", ",
		defaultProjectParent: "",
		defaultFeatureSubfolder: "",
		defaultSeriesSubfolder: "",
		characterCardFields: ["arc", "motivation", "first_appearance"],
		sceneNoteTemplate: SCENE_NOTE_TEMPLATE,
		characterNoteTemplate: CHARACTER_NOTE_TEMPLATE,
		locationNoteTemplate: LOCATION_NOTE_TEMPLATE,
		firstDraftMode: {
			active: false,
			savedLayout: null,
			hideRibbon: true,
			hideStatusBar: true,
			hideLeftSidebar: true,
			openProjectNotes: false,
		},
		debugLogging: false,
		replaceSelectionWithLink: true,
		autoLinkifyOnCreate: false,
		filenameReplacementChar: "_",
		fountainPlugin: "auto",
		fountainFileFormat: "fountain",
	},
};
