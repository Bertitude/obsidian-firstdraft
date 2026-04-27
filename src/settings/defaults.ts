import type { FirstDraftSettings } from "../types";

// prettier-ignore
export const SCENE_NOTE_TEMPLATE = `---
scene:
location:
time:
characters: []
tags: []
status: draft
---

## Intent

## Notes

## Continuity
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

export const DEFAULT_SETTINGS: FirstDraftSettings = {
	projects: {},
	global: {
		developmentFolder: "Development",
		charactersSubfolder: "Characters",
		scenesSubfolder: "Scenes",
		locationsSubfolder: "Locations",
		referencesSubfolder: "References",
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
		},
		debugLogging: true,
	},
};
