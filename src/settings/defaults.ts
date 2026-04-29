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

<!-- Add one H2 per beat. The H2 title becomes the scene's filename when
     you run "FirstDraft: Promote treatment to scenes". The prose under each
     H2 becomes the dev note's "Sequence Overview" section. -->

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
