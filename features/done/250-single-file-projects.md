# Feature 250 — The project IS the document (single-file projects)

## Context

Feature 240 made a project a workspace of desktops; the persistence redesign that followed
made a project a file and **every desktop a file of its own**, at any path the user picks.
That is the decision this stage reverses.

A project file stores absolute paths to desktop files that are created, moved, renamed and
deleted independently of it. Two file lifetimes that must stay referentially consistent is
the root of every awkward mechanism now in the tree:

- `project-store.js` `_normalize` derives a `defaultFile` flag from the path, then rebases
  app-kept desktops onto *this* machine's saves directory so a travelling project still
  finds them.
- `discardChanges(meta, filePath)` diffs the live meta against the project **on disk** to
  garbage-collect the desktop files of tabs added since the last save;
  `discardDefaultProject()` sweeps the working slot's files on New/Open.
- Two things must be written the moment they happen — a desktop's file *moving* (Save As /
  Open) or being *deleted* — "because the project must not go on pointing at a file that is
  gone". So a delete commits a rename the user had not saved yet.
- "Save and delete" on an app-kept desktop has to run Save **As**, because saving into the
  file the delete is about to remove would keep nothing.
- `project:drop-temp` refuses anything but a GUID file inside saves; `knownPath` gates every
  tab path in a saved meta, since a path stored today is a writable path tomorrow.
- Two dirty flags, two Save commands, two Save As commands, and two menus (**Project** and
  **File**) running the same four verbs at two levels.

None of that is wrong. It is all correct code solving a problem created by splitting one
document across many files — and the split **fails at the thing it exists for**. `_normalize`
stores `path.resolve(file)` for any desktop with a real home, so a project file sent to
another person has a dead path per tab. Worse, `mem-store` keeps ROM bytes in
`userData/memory/<guid>.bin`, entirely outside the project, so a shared design silently
loses its programmed ROMs too. Sharing is the stated purpose of "a real file", and the
current shape is the one shape that cannot do it.

Prerequisites: Features 180 (the `mem:*` byte store), 200 (undo/redo + `loadDocument`),
240 (tabs, the workspace, the design clip).

## Goal

**One file is the whole design.** A project — its desktops, their documents, and the ROM
images they were programmed with — is a single `.chiphippo` file. One dirty marker, one
Save, one Save As, one recent list, one menu. Sharing a design is sending that file.

The always-there default survives untouched: the app still boots onto a project you never
had to name, still remembers it across a quit, and still asks nothing until you want the
work somewhere of your own.

A desktop stops being a file and becomes structure *inside* the document — added, renamed,
duplicated and deleted like anything else on the desk — with **Export Desktop…** /
**Import Desktop…** as the interchange route that Save As / Open used to be.

## Design decisions (settled)

### The file

```jsonc
// <name>.chiphippo — the document, wherever the user put it
{
  "version": 4,
  "name": "6502 SBC",
  "description": "…",            // omitted when empty, as everywhere
  "activeTab": "t2",
  "nextIndex": 3,
  "tabs": [
    { "id": "t1", "name": "Clock module", "description": "…", "doc": { /* desk document */ } },
    { "id": "t2", "name": "Desktop 2", "doc": { /* … */ } }
  ],
  "images": { "9f1c…-…": "<base64>" }   // programmed ROMs only
}
```

`location` is still never stored — it **is** the path, so it cannot disagree with reality.
`tabs[].file`, `defaultFile`, and the whole saves-folder rebase are gone with the paths they
described.

**Extension**: the project takes the plain **`.chiphippo`** suffix — it is now *the* document
type, and the existing dialog filter already accepts it. `.project.chiphippo` stays readable
so a v3 file opens; `.desktop.chiphippo` survives as the interchange fragment only.

### There is still exactly one always-there working file

Unchanged in spirit, simpler in fact: an unsaved project (blank name, blank location) lives
in the one fixed `saves/default.chiphippo`, and `bootProject` still reads *that, else the
head of the MRU that is still on disk, else a brand-new project*. What goes away is
everything that used to travel with it — no GUID desktop files to mint, no app-kept flag to
derive, and no orphans to collect, because a project with no companion files cannot leave
any.

### Nothing is written until you save

Every eager write in the current design exists so the filesystem would not lie about where a
desktop is. With no companion files there is nothing for it to lie about, so the write-through
exceptions are deleted outright: adding, renaming, duplicating, reordering and deleting a
desktop are all plain unsaved changes. **"Close without saving" becomes a complete, honest
revert of the session** — which it is not today.

The one write that stays immediate is the unsaved project's own working file, for the reason
it always had: that file is not a copy of the project, it *is* the project, and it is what
the next launch opens.

### ROM images travel in the file; `userData/memory/` becomes a cache

The whole memory stack keeps working on real files — `SimController` loads on Run, the
inspector edits, the programmer copies an image in, `#provisionMemory` / `#releaseMemory`
still own a chip's file lifecycle. Only two operations are added, and both live in **main**,
which is already holding every document at save/open time:

- **collect** — on save, walk each tab's `doc.components` for a chip with
  `params.storage.guid` **and** `params.programmed`, read its `.bin`, and base64 it into
  `images`. An un-programmed ROM is noise, and noise does not need to travel.
- **hydrate** — on open, write every entry of `images` back into `userData/memory/` before
  the renderer is handed the project. A guid with no stored image is simply provisioned as
  noise by the existing path.

This is the second place in main with document knowledge, after `migrations.js`, and like it
the knowledge is narrow: it reads `components[].params.storage` and nothing else.

### The camera is not in the file

A desktop's camera stays per-tab in memory (plus the existing `settings.viewport` for the
active one). Panning must never mark a design dirty — a document records the circuit, not
where you were last looking at it.

### Export / Import replaces the desktop's Save As / Open

A desktop's **Save As** becomes **Export Desktop…**, writing a standalone
`.desktop.chiphippo` **snapshot** — self-contained, ROM images included, with **no retained
link**. **Import Desktop…** reads one back as a new tab. A copy cannot dangle, which is
exactly why this is stronger than the two-way binding it replaces; and it is the design clip
one level up again — the clip carries a sub-assembly between desktops, export/import carries
a whole desktop between projects and machines.

**Import re-mints ROM guids** (carrying each image across to the new guid), so importing the
same desktop twice into one project can never leave two chips sharing one backing file. Tab
ids are minted from `nextIndex`; component/board/wire ids come across untouched, since a
desktop is its own id space.

There is no "open a design into the active desktop" any more — Import always adds a tab,
so no file operation can destroy the desk you are looking at.

### File is the project's menu; Desktop is the desktops'

The **Project** menu is deleted and the menu bar becomes **File · Desktop · Edit · View ·
Window · Help**:

- **File** — New · Open… · Open Recent ▸ · rule · Save · Save As… · rule · Bill Of
  Materials…, all aimed at the project. It is the same four verbs at one level now, so the
  toolbar's File pill needs no change at all beyond what it points at.
- **Desktop** — Add Desktop · Rename… · Duplicate · Delete Desktop · rule · Export
  Desktop… · Import Desktop… · rule · Desktop Properties…, mirrored by the tab strip's
  context menu.

`chiphippo:schematic-*` and `chiphippo:project-*` collapse into the single
`chiphippo:project-*` family; the desktop verbs get `chiphippo:desktop-*`.

### One dirty marker, so no per-tab dot

The `•` on a tab goes. A desktop is not independently saveable any more, so a marker with no
action that clears it would be a lie. The document's dirty state shows where it always did —
the title bar, and the File pill's Save.

### Structure changes are confirmed, not undoable (this cut)

Per-tab `HistoryStore` is unchanged: ⌘Z after switching back still undoes *that* desk's last
edit. Adding, deleting, renaming, duplicating and importing a desktop are **not** on any undo
stack in this stage — Delete Desktop keeps a confirm, now worded for what it does (the
desktop and its contents go, and the change is undone only by closing without saving).
A project-level history over the meta is the natural follow-on and is deliberately out of
scope here.

### Migration: v3 → v4, and loose desktop files

`project-migrate.js` reads a v3 project, inlines each tab's document through the existing
`deskStore.readFile` (migrations included), and collects the programmed ROM images. It is
**non-destructive**: a desktop file the user saved somewhere of their own is left exactly
where it is, orphaned but harmless. A tab whose file is missing — the dangling absolute path
this stage exists to abolish — becomes an empty desktop and a warning naming the file.

The old working slot migrates on boot and is rewritten in place as v4, and only then are its
app-kept GUID desktop files removed, since those were the app's own litter and nothing else
ever pointed at them.

Opening a bare `.desktop.chiphippo` wraps it in a new single-desktop project — the same
answer Import gives, and the compatibility story for anyone holding loose desktop files.

## Implementation steps

1. **`app/store/project-store.js`** — rewrite to the single-file shape: `newProject()`,
   `read(path)`, `write(path, meta)`, `defaultProjectPath`, `removeDefaultProject()`,
   `isInsideSaves()`, `suggestFileName()`. **Delete** `_appendTab`'s file minting,
   `isTempDesktop`, `TEMP_DESKTOP_RE`, `removeDesktopFile`, `discardChanges`,
   `discardDefaultProject`, the `defaultFile` flag, and the saves-directory rebase.
   `_normalize` stays as the file-shape guard — main must not trust a renderer meta — and
   now validates `tabs[].doc` through `migrations.js` instead of a path.
2. **`app/store/project-images.js`** (new, main) — `collectImages(meta, memDir)` /
   `hydrateImages(meta, memDir)` over `mem-store.js`, walking `components[].params.storage`
   and nothing else. Sibling test.
3. **`app/store/project-migrate.js`** (new, main) — v3 → v4 (above), returning
   `{ meta, warnings }`; a missing tab file yields an empty desktop and a warning.
4. **`app/main.js` + `preload.js`** — the IPC diff, in lockstep (extend
   `tests/ipc-parity.test.js`):
   - **gone**: `desk:open`, `project:add-tab`, `project:read-tab`, `project:write-tab`,
     `project:discard`, `project:drop-temp`
   - **new**: `desktop:export` (choose path + write a snapshot), `desktop:import` (open
     dialog + read one)
   - **kept**: `project:boot` / `new` / `open` / `open-recent` / `save` / `choose-path` /
     `recent:*` / `closed-aux`
   `knownPath` shrinks to project files plus what an export/import dialog established.
   Rebuild `buildMenu()` as File · Desktop (above).
5. **`web/scripts/model/project-doc.js`** (new, pure) — the project meta in memory, the
   `desk-doc.js`/`desk-store.js` relationship repeated one level up: `normalize`, `addTab`,
   `removeTab`, `renameTab`, `duplicateTab`, `importDesktop(snapshot)` (re-minting ROM guids
   and remapping `images`), `exportDesktop(id)`, and `signature()` — the one dirty test.
   Sibling test file.
6. **`web/scripts/components/project-workspace.js`** — the large simplification. One
   `#saved` signature, one `save()` / `saveAs()`, one leave/quit guard. **Delete**
   `saveActiveTab`, `saveTab`, `saveActiveTabAs`, `saveTabAs`, `newActiveTab`,
   `loadIntoActiveTab`, `#dropTempFile`, `#markAppKept`, `#persistProject`'s write-through,
   `#discardProjectChanges`, `#saveDirtyInPlace`, `#dirtyTabs`. **Add** `exportTab(id)` /
   `importTab()`. Tab switching, per-tab camera/history, and the aux-window close are
   unchanged.
7. **`web/scripts/components/project-tabs.js`** — drop the dirty dot; the context menu keeps
   the board's shape and grows Duplicate / Export Desktop… above the rule.
8. **`web/scripts/app.js`** — the File pill retargeted at the project; the
   `chiphippo:schematic-*` family folded into `chiphippo:project-*`; the new
   `chiphippo:desktop-*` handlers.
9. **`styles/app.css`** — remove `.project-tab--dirty`.
10. **Tests** — `project-store.test.js` (round-trip; a renderer meta is normalized, not
    trusted), `project-images.test.js` (only `programmed` chips collect; hydrate writes the
    cache; a missing image provisions noise), `project-migrate.test.js` (a v3 project with a
    real-path desktop, an app-kept desktop, and a missing one), `project-doc.test.js`
    (`nextIndex` only counts up; import re-mints guids and remaps images; signature ignores
    `activeTab`), `project-workspace.test.js` rewritten to the one-save model, plus the
    ipc-parity extension.
11. **Docs** — rewrite `src/web/docs/projects-and-desktops.md` and `files-and-undo.md`; no
    new page, so both `PAGES` indexes are untouched.
12. **`CLAUDE.md`** — replace the "Projects & tabbed desktops" section wholesale; it is the
    longest section in the file and most of it describes machinery this stage deletes.

## Acceptance criteria

- A fresh launch opens an unnamed project with one desktop, exactly as today. Build
  something, quit without saving, relaunch: it is there.
- **Save As** writes one `.chiphippo` file. Move that file to another machine (or another
  `--user-data-dir`) and open it: every desktop, and every programmed ROM's contents, are
  intact. This is the criterion the current design cannot meet.
- There is one dirty marker (the title bar), one Save, and one Save As. No tab shows a `•`,
  and no desktop has a Save of its own.
- Adding, renaming, duplicating, reordering and deleting a desktop touch no file. Close
  without saving and every one of those changes is gone — the project reads back exactly as
  it was last saved.
- **Export Desktop…** writes a self-contained `.desktop.chiphippo`; **Import Desktop…**
  brings it back as a new tab. Import it twice into the same project and the two copies'
  ROMs are independent (distinct guids, distinct backing files).
- Opening a v3 `.project.chiphippo` produces the same tabs with the same contents; a tab
  whose desktop file is missing opens empty with a warning naming it; no file of the user's
  is deleted by the migration.
- Opening a bare `.desktop.chiphippo` gives a new one-desktop project.
- ⌘Z after switching away and back still undoes that desktop's last edit.
- `make test` passes with `project:add-tab` / `read-tab` / `write-tab` / `discard` /
  `drop-temp` and `desk:open` absent from both `main.js` and `preload.js`.

## Constraints

- **One file, no companions.** Nothing outside the project file may be required to open a
  design; `userData/memory/` is a working cache that a project open can rebuild in full.
- The renderer never sees a writable path a dialog or the MRU did not establish;
  `knownPath` stays the gate.
- Project meta arithmetic is pure and tested (`model/project-doc.js`, DOM-free); main's
  `_normalize` remains an independent file-shape guard, not a shared module — the same
  deliberate duplication `migrations.js` already carries for the same reason.
- No new dependency: images are base64 in JSON. A zip container is the answer *if* image
  sizes ever justify it, and is not this stage.
- The tab context menu keeps the board menu's two-item shape plus the new items; a desktop
  still has no pins, so Pin Assignment stays absent.
- Per-tab `HistoryStore`, the design clip's survival across a switch, and the stop-sim +
  close-aux-windows rule on a switch are all unchanged.

## Verify

```bash
make fmt && make lint && make test && make debug
```

In the app: build a circuit with a programmed ROM on **Desktop 1**, add **Desktop 2** and
build another, ⌘S to a real path. Confirm one file was written and nothing else. Quit,
relaunch, reopen it — both desktops and the ROM contents are back. Copy the file to a fresh
`--user-data-dir` and open it there: same result. Then rename a desktop, add a third, close
without saving, reopen — none of it happened. Finally, Export Desktop 2, Import it twice, and
confirm the two imports' ROMs are independent.
