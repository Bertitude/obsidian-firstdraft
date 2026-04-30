# FirstDraft

A screenwriting companion for Obsidian. Pairs each fountain script file with a development note, autocompletes character cues and slug-lines, and gives you a paper-thin outlining ladder from Series Outline all the way down to scene fountain files.

<!-- ================================================================== -->
<!-- PREAMBLE — replace this comment with your own intro / motivation / -->
<!-- credits / "what this is for" framing.                              -->
<!-- ================================================================== -->

## Ramblings of a Madman

Hi Everyone, Kaiel aka Bertitude here. 

I started using Obsidian about 5 or so years ago because I found myself jumping from notes app to notes app and really was struggling to find one place where I could jot down the craziness that pops into my brain at 1am. I just wanted a clean place without too much fluff and most importantly I wanted something that could work offline and without some kind of subscription. Obsidian proved to be that for me. 

The next struggle I had was really gathering those notes and making them useful while I was engaged in the writing process. Being... well me. I would write a note and entirely forget about it for years at a time in some cases. I would be trying to roundtrip between my notes, Word and FadeIn (my script writing software of choice) and would end up somewhere between confused and annoyed. Imagine this was just in development and writing. What would happen if I went to production on a large project and needed to gather all this.

I decided to start trying to narrow that gap last year. My goal was to see how I could cobble together plugins to emulate what was missing from FadeIn and my workflow. To make my notes more useful and structure them in a way that suited both how I like to work and keep everything together enough to share with the rest of my creative and production teams when the time came.

I came close-ish. However the gap remained. The notes remained locked in Obsidian and I would be bounding between two windows trying to keep track of where I was in the script and what notes are relevant. It still SUCKED.

**Enter "The Robot"**

Now people keep asking me. "How is AI going to change <insert whatever topic is related to Film/TV>?". It's a grating question but one I try to answer honestly. "It's not going to do whatever magic they are promising but it does have uses." This is one of those uses. As a lapsed computer science major I try to keep up and when smarter skeptics than me were confirming that the systems could produce solid code I got curious. I don't really want to write code but there are a lot of little gaps where a quick script or app could just solve my problem.

My first test was a little plugin to allow me to post to my Github hosted blog directly from Obsidian... Success. A couple hours and braps. I can write to my heart's content. So the next logical thing was to solve this problem. I already had my projects scaffolded to some extent in my vault so it was a ripe test bed for this. I opened the robot's app and here we are. A whole plugin and I didn't need to lose sleep hunting through StackOverflow. 

The goal of FirstDraft isn't really to replace other screenwriting software. You technically can so maybe one day. The goal is really just to help scatterbrained writers like me wrangle their ideas into something usable. To get us unstuck and to that "First Draft"(get it? That's why I earn the big bucks). Every idea, note reference at your finger tips without having to have 3 monitors and 7 notepads sprawled across your desk. 

**What's Next?**

Testing. Refining. Collaboration. 

What better way is there for something to get better than putting it in front of an audience? I'm hoping more people use it and tell me how it can get better. Every writer has a different flow and we want this plugin to be as adaptable as obsidian itself.

I'm also contemplating doing an inhouse fountain editor (did I mention I wanted this to be open standards) for the screenplay part of it. Once I put it through it's paces on my next 2 projects I'll make that call.

The big target though is collaboration. I have planned out a collaboration feature that will meet writing teams where they are rather than forcing yet another subscription upon people. On Google Drive/OneDrive/Dropbox? It will just work. If you have any suggestions about this just let me know. 

Before I wrap up I want you to know that I won't ever charge for this. It's a tool for me first and foremost but I don't think stuff like this needs some whole business model behind it. Maybe I'll put a donation link so you can contribute to my caffeine habit that lets me scheme up this stuff. 

Much Love.
Kaiel


<!-- ================================================================== -->

## Installation

FirstDraft isn't on the Obsidian Community Plugins list yet. Two ways to install:

### Option A — BRAT (recommended)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs and auto-updates plugins straight from GitHub.

1. Install BRAT from Community Plugins and enable it.
2. Open Settings → BRAT → "Add Beta Plugin".
3. Paste `https://github.com/Bertitude/obsidian-firstdraft` and submit.
4. Settings → Community Plugins → enable **FirstDraft**.

### Option B — Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Bertitude/obsidian-firstdraft/releases).
2. Copy them into `<your vault>/.obsidian/plugins/obsidian-firstdraft/` (create the folder if it doesn't exist).
3. Restart Obsidian.
4. Settings → Community Plugins → enable **FirstDraft**.

### Companion plugins

FirstDraft works best alongside two community plugins. Both are optional but most workflows assume them.

| Plugin | What it does | Why it matters |
| --- | --- | --- |
| [**Fountain Editor**](https://github.com/chuangcaleb/obsidian-fountain-editor) (chuangcaleb) | Renders `.fountain.md` files with a proper screenplay editor. | FirstDraft's autocomplete (character cues, slug-lines) fires inside this editor. The default file format expects `.fountain.md`. |
| [**Longform**](https://github.com/kevboh/longform) | Compiles a project's scene files into a single manuscript. | FirstDraft writes its sequence list into the Longform-compatible `firstdraft:` / `longform:` frontmatter block, so Longform's compile picks up everything automatically. |

> **Note on file format.** FirstDraft uses `.fountain.md` (the chuangcaleb convention) by default. Plain `.fountain` works too but Longform's compile only sees `.md` files, so you lose compile if you go that route. If you have an existing project on `.fountain`, run **"Migrate project to .fountain.md"** from the command palette to convert in place.

---

## Quick start

1. Run **"Create FirstDraft project"** from the command palette.
2. Pick **Feature** or **Series**, give it a title, choose a parent folder.
3. Open the **Treatment** (for features / episodes) or **Series Outline** (for series) that gets scaffolded for you.
4. Write H2 headings — one per beat / season / episode.
5. Run the corresponding **"Make … from outline"** command to scaffold the next level down.
6. Repeat until you're at the fountain level. Start drafting.

The detailed flows below walk through each project type from scratch.

---

## Feature flow

Linear path from blank vault to finished script.

### 1. Create the project

Command palette → **Create FirstDraft project** → pick **Feature** → enter a title and (optional) subtitle.

This scaffolds:

```
<Parent folder>/<Title>/
├── Index.md                            ← project root, opens Project Home
├── Screenplay/                         ← fountain files live here
└── Development/
    ├── Treatment.md                    ← H2 per sequence; the outline doc
    ├── Sequences/                      ← per-sequence dev notes
    ├── Characters/                     ← character entities
    ├── Locations/                      ← location entities
    ├── References/                     ← any research / lookups
    └── Notes/                          ← project notes
```

Project Home opens automatically.

### 2. Outline the treatment

Open `Development/Treatment.md`. It comes with a welcome blurb and a couple of placeholder H2s. Each H2 is a **sequence** — a working-titled chunk of the script that may contain one or many slug-lines. Write as much or as little prose as you want under each heading.

> **Sequence vs. scene.** FirstDraft stores fountain files at sequence granularity, not scene granularity. One sequence file can contain multiple `INT.` / `EXT.` slug-lines. Filenames are working titles ("Marcus on phone.fountain.md"), not numbered scene IDs. If you want one slug per file later, you can split or atomize.

### 3. Promote outline → sequences

Command palette → **Make sequences from treatment** (a.k.a. "Promote").

For each H2 in your treatment, FirstDraft creates:
- A fountain file at `Screenplay/<sequence name>-<id>.fountain.md`
- A paired dev note at `Development/Sequences/<sequence name>-<id>.md`

The dev note inherits any prose you wrote under the H2 as starting context. The fountain file gets a stub slug-line so the editor renders.

### 4. Draft

Open any sequence's fountain file and start writing. As you type:

- **Character cues** autocomplete from the project roster. Tag a name as a new character with **"Create character from selection"** or via the right-click menu.
- **Slug-lines** autocomplete in three stages: type `INT. ` and pick from your locations; pick a sub-location if applicable; pick a time-of-day. Existing locations come from the roster; "Create new location" is always offered.
- **Cursor-aware scroll**: as your cursor moves between slug-lines in the fountain, the paired dev note panel auto-scrolls to the matching `## INT. …` H2 section. Use the dev note for per-slug planning notes.

### 5. Develop entities as you go

The right sidebar **Dev Notes panel** surfaces the active sequence's dev note + cards for every character and location it touches. Use the cards' **"Open Character Profile"** / **"Open Location Profile"** links to jump to the entity's full file.

When a name comes up that's not in the roster yet:
- Select it → right-click → **"Create character from selection"** (or location)
- Or run the same as a command from the palette

The new entity gets its own folder with a note file, gets auto-linkified across the project, and immediately appears in the autocomplete roster.

### 6. Sync, split, merge

A few maintenance commands keep things tidy:

| Command | When to use |
| --- | --- |
| **Sync sluglines from dev note to fountain** | You sketched slug-line H2s in the dev note; push them into the fountain. |
| **Sync sluglines from fountain to dev note** | You added new slug-lines while drafting; pull them back as H2 anchors in the dev note. |
| **Clean up sluglines** | Standardize prefix punctuation, casing, and sub-location delimiter across the active sequence or the whole project. Auto-snapshots before writing. |
| **Split scene at cursor** | Cuts the sequence into two at the slug-line under your cursor. |
| **Merge scene with…** | Combines two sequences (frontmatter unioned, bodies concatenated). |
| **Sync characters from sequence to dev note** | Walks the fountain's cues and drops the cast list into the dev note's `characters:` array. |

### 7. Compile

When you're ready to read the whole script as one document, run Longform's compile. It picks up every `.fountain.md` in the configured sequence folder, in `sequences:` order from the project's `Index.md`, and produces a single `Manuscript.md` at the project root.

---

## Series flow

Series adds two outline layers above the feature flow. Each layer mirrors the same outline → break pattern.

### The full ladder

```
Series Outline       →  Make seasons     →  Season projects
   Season Outline    →  Make episodes    →  Episode projects
      Treatment      →  Make sequences   →  Fountain + dev note
```

Every break command snapshots its outline before writing, so any rewrite is recoverable via Browse File Versions.

### 1. Create the series

Command palette → **Create FirstDraft project** → pick **Series** → title + (optional) subtitle.

Scaffolds:

```
<Parent folder>/<Series Title>/
├── Index.md                            ← series Project Home
├── Seasons/                            ← season projects live here
└── Development/
    ├── Series Outline.md               ← H2 per season; the show-level outline
    ├── Characters/                     ← series-wide characters (the show bible)
    ├── Locations/
    ├── References/
    └── Notes/
```

> **Migrating an existing series folder?** Run **"Initialize series root"** instead of Create — it adds the Index.md without touching anything else, and the Series Home will offer a one-click **"Create Series Outline"** affordance for the show-bible doc.

### 2. Outline the seasons

Open `Development/Series Outline.md`. One H2 per season, with as much premise prose as you want underneath each.

### 3. Series Outline → Seasons

From the series's Project Home, click **"Make seasons from outline"** (or run the matching command). For each H2:

- Creates `Seasons/S0n/Index.md` (the season project)
- Creates `Seasons/S0n/Development/Season Outline.md`
- Title comes from the H2; season number is auto-assigned starting at the next available `S0n`.

Existing orphan season folders (e.g. `S01/` you created manually before this step) get backfilled in place — the command detects the folder and adds the missing Index without duplicating.

### 4. Outline the episodes

Open a season's `Development/Season Outline.md`. One H2 per episode.

### 5. Season Outline → Episodes

From the season's Project Home, click **"Make episodes from outline"**. For each H2:

- Creates `Seasons/S0n/S0nE0m - <Title>/Index.md` (the episode project)
- Creates `Seasons/S0n/S0nE0m - <Title>/Development/Treatment.md`
- Episode code is auto-assigned (next available within the season).
- Any prose under the H2 is carried into the episode's Treatment as starting context.

### 6. Episode flow = Feature flow

From here, an episode behaves identically to a feature: open its Treatment, run Make sequences from treatment, draft in the fountain files. Compile produces the episode's Manuscript.

### Where things live across the hierarchy

| Entity | Lives at | Visible from |
| --- | --- | --- |
| Series-regular characters | `<series>/Development/Characters/` | Every episode + season + the series itself |
| Recurring characters scoped to a season | `<season>/Development/Characters/` | That season's episodes |
| Episode-only guests / featured extras | `<episode>/Development/Characters/` | That episode only |
| Settings (folder names, templates, delimiters) | Series-level only — series, season, episode all share | All TV scopes |

### Character classification

When you create a character, the modal asks for a **level**. Options vary by where you're creating from:

| Project type | Available levels |
| --- | --- |
| Feature | Main · Supporting · Featured Extra |
| Series (show bible context) | Main · Recurring |
| Season / Episode | Main · Recurring · Guest · Featured Extra |

Project Home filters character groups to match the scope: a series-level home only shows Main + Recurring (the show bible), while a season or episode home adds Guest + Featured Extra for that scope.

If you're tagging from prose without thinking about levels, leave the modal at its default — every flow has a sensible pick.

### Auto-create season on first episode

If you run **Create episode** with a code like `S03E01` and the `S03` folder doesn't exist yet, FirstDraft scaffolds the season alongside the episode automatically. You'll see a notice: *"Created episode 'S03E01 — Pilot'. Also scaffolded S03 as a season project."*

This means you can jump straight from "I want to write an episode" to "I have a fountain file" without ever touching the season layer manually if you don't want to.

---

## Key commands

The full list is in the command palette under "FirstDraft:". A handful you'll reach for most:

**Project creation / structure**
- Create FirstDraft project
- Initialize series root *(migrate an existing folder)*
- Create season · Create episode · Create new scene

**Outline → Break ladder**
- Make seasons from series outline
- Make episodes from season outline
- Make sequences from treatment *(a.k.a. "Promote")*

**Drafting**
- Insert character cue · Insert location reference
- Tag selection as character · Tag selection as location · Tag selection as alias of… · Tag selection as group…
- Create character · Create location

**Sync / cleanup**
- Sync sluglines from dev note to fountain
- Sync sluglines from fountain to dev note
- Sync characters from sequence to dev note
- Clean up sluglines
- Audit alias collisions

**Structural editing**
- Split scene at cursor · Merge scene with…
- Atomize sequence into scenes

**Modes**
- Toggle First Draft Mode *(distraction-free writing layout)*

---

## Configuration

**Settings → FirstDraft** holds global defaults: folder names, sub-location delimiter, character card fields, fountain plugin choice, and the default templates for new entities.

**Project Settings** is per-project and accessed via the cog button on Project Home. For features and standalone projects, settings live at the project's own `Index.md`. For TV series, settings are series-wide — the cog on any episode, season, or series home opens the same series-scoped modal, and every level inherits.

Field-level reset arrows on the project modal clear individual overrides back to global defaults.

---

## License

[0BSD](https://opensource.org/licenses/0BSD) — do whatever you want, no attribution needed.
