# Changelog

All notable changes to FirstDraft are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file mirrors the in-plugin release notes shown by the **Show what's new** modal — entries here and in [`src/onboarding/release-notes.ts`](src/onboarding/release-notes.ts) should stay in sync when cutting a release.

## [Unreleased]

<!-- Add release-bound entries here as you work toward the next version.
     Move them under a new `## [x.y.z] - yyyy-mm-dd` heading when cutting
     the release. -->

## [0.1.0] - 2026-04-30

Initial public release.

### Added

- **Project Home** — single landing page per project (feature, series, season, episode) with quick actions, scenes / seasons / episodes lists, and Characters / Locations groupings.
- **Outline → Break ladder** end to end:
  - **Series Outline → Make seasons from outline** scaffolds Season projects.
  - **Season Outline → Make episodes from outline** scaffolds Episode projects, carrying H2 prose into each episode's Treatment.
  - **Treatment → Make sequences from treatment** scaffolds fountain files + paired dev notes.
  - Every "make" command auto-snapshots its outline before writing.
- **Auto-create Season Index on first episode** — running Create Episode in series context against a season folder that doesn't have an Index scaffolds the Season project alongside the new episode. Inline "Create season" affordance on Series Home for orphan season folders.
- **Slug-line autocomplete** — three-stage flow (INT/EXT → location → time-of-day) with sub-location support and a configurable delimiter (Comma / Hyphen / Em-dash / Slash).
- **Clean Up Sluglines** command — bulk-normalizes prefix punctuation, casing, sub-location delimiter, and time-separator spacing across the active sequence or the whole project. Auto-snapshots every changed file.
- **Character cue autocomplete + classification** — Main / Recurring / Guest / Featured Extra for TV, Main / Supporting / Featured Extra for features. Aliases and groups supported. Project Home filters tier visibility by view scope (series view shows only series-wide tiers).
- **Alias collision detection** — inline confirm at tag time + on-demand "Audit alias collisions" command with grouped results and clickable links to each conflicting character file.
- **Dev Notes side panel** — pairs each fountain with its development note. Cursor-aware scroll keeps the dev note's slug-line H2s in sync as you draft. Per-card "Open Character Profile" / "Open Location Profile" links jump to entity files.
- **Sync commands** — slug-lines both directions (dev note ↔ fountain), characters from fountain cues into the dev note's `characters:` array, characters from dev note prose.
- **Structural editing** — Split scene at cursor, Merge scene with…, Atomize sequence into scenes. All snapshot before writing.
- **First Draft Mode** — distraction-free writing layout (hide ribbon, status bar, sidebars, optional Project Notes pane) with one toggle. Session-only.
- **Series-scoped TV settings** — episode and season project settings are unified at the series level. The cog button on any episode, season, or series home opens the same series-scoped modal.
- **Welcome + What's New onboarding modals** — Welcome appears on first install, What's New on update. Both can be re-opened any time via "Show welcome" / "Show what's new" commands.
- **Longform-compatible compile** — sequences are written into a Longform-readable frontmatter block, so the existing Longform plugin's compile picks up everything automatically.

[Unreleased]: https://github.com/Bertitude/obsidian-firstdraft/compare/0.1.0...HEAD
[0.1.0]: https://github.com/Bertitude/obsidian-firstdraft/releases/tag/0.1.0
