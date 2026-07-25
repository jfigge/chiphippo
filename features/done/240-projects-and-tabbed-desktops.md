# Feature 240 — Projects & tabbed sub-desktops

## Context

The desk is a single, unbounded document. A large design (a full 6502 system, say) grows
into one sprawling desk, and there is no way to work out a sub-assembly — a clock module,
a decoder, a memory map — *beside* the main build and drop it in when it works. Today
that means either building it in-place amid everything else, or opening a second
schematic file and losing the main one from view.

Everything needed for the answer already exists in the tree:

- `DeskDoc.restore(snapshot)` + `DeskController.#rebuildScene()` — the full document swap
  Feature 200's undo/redo already performs dozens of times per session. Swapping *which*
  document is on the desk is the same operation.
- `model/paste-cluster.js` (`captureCluster` / `resolveCluster`) — a rigid, integer-pitch
  arrangement of parts, ghosted under the cursor, green/red per member, click to drop.
  It already does the "waiting to be placed" paste for components; it just doesn't carry
  boards or wires.
- `model/mating.js` (`snapCorrection`) and `DeskDoc.snapKitAt` — the magnetic pull that
  lands a placement ghost flush against an existing board.
- `app/store/desk-store.js` `readFile`/`writeFile` + the `desk:open`/`save-as`/`write`
  handlers — named-file I/O in main.

Prerequisites: Features 20 (desk document + store), 30 (placement ghosts), 110 (strips,
groups, mating), 200 (snapshot restore + the rebuild path).

## Goal

A **project** — a named workspace of several **desktops**, shown as tabs. `Main` holds the
build; each `Sub-Desktop #N` is a scratch bench for a reference design. A design worked
out on a sub-desktop is **copied and pasted into another tab**, arriving as a floating
ghost that follows the cursor with no button held: click to drop it (mating with the
boards already there), `Esc` to throw it away.

## Design decisions (settled)

### A project is an app-managed folder, not a loose set of paths

`userData/projects/<slug>/` holds `project.json` (the tab list) plus one `.chiphippo` per
tab. The project **name is the identity** — "must not match an existing saved project"
is a folder-exists check, which only means something against a directory the app owns.
Main alone maps a name → path (the `mem:*` GUID discipline), so a hostile or traversing
name can never escape the projects root.

```jsonc
// userData/projects/<slug>/project.json
{
  "version": 1,
  "name": "6502 SBC",
  "activeTab": "t1",
  "nextSubIndex": 2,
  "tabs": [
    { "id": "t1", "name": "Main", "kind": "main", "file": "main.chiphippo" },
    { "id": "t2", "name": "Sub-Desktop #1", "kind": "sub", "file": "sub-1.chiphippo" }
  ]
}
```

Tab files are named by the store, never by the user; the document format is the existing
`.chiphippo` JSON, so a tab file opens as a normal schematic and a normal schematic loads
into a tab.

### A tab is a document, not a second viewport

There is exactly one `DeskView` / `DeskController` / `SimController` / palette / guide /
analyzer, as today. Switching tabs **swaps the document in place** — `DeskDoc.restore()`
then the controller's existing full-rebuild path — the same teardown undo/redo uses. No
`window.location.reload()` (that path exists because *reload* is the only guaranteed
teardown; `#rebuildScene` is the sanctioned in-process one) and no second desk in the DOM.

Per tab the workspace keeps: the live document, the camera, the saved baseline (dirty),
and **its own `HistoryStore`** — switching to a tab and pressing ⌘Z undoes that tab's last
edit, not the other tab's.

### Switching tabs stops the sim and closes the aux windows

`c3` on Main and `c3` on a sub-desktop are different chips. A tab switch is a document
change of exactly the kind New/Open makes, so it does what they do: stop the simulation
(run state is run-volatile and never crosses documents) and `closeAuxWindows()` — an open
pinout or memory inspector would otherwise point at a chip that is no longer on the desk.

### No project is still the default state

With no project active nothing changes: no tab strip, the working `desk.json`, the
optional named `currentFile`, today's New/Load/Save. Creating a project **adopts the
current desk as its Main tab** — the work in front of you becomes the work in the project,
never discarded.

### The toolbar acts on the active tab

In project mode the file buttons target the active tab's document: **New** empties it
(after the discard prompt), **Load** replaces it from a picked `.chiphippo`, **Save**
writes the tab's own file inside the project folder — no dialog, because the tab already
owns a path. The window title reads `<project> — <tab>`.

`project.json` is rewritten whenever the tab *set* changes (add, delete, rename, reorder,
active tab); tab documents are written by Save and by the existing debounced autosave.

### Copy carries the whole design: boards, parts, and wires

The clipboard becomes a **design clip** — the selected boards, every component *seated on*
them, and every wire whose **both** endpoints are inside the set, captured as world-space
offsets from the arrangement's reference corner. Copying stays ⌘C over a marquee; the
marquee is extended to also pick up boards fully inside the rubber band (it selects only
components and wires today).

The clip lives on the **workspace**, above the document, so it survives a tab swap — that
is what makes cross-tab paste work at all. Every pasted item gets **fresh ids** (`bb`,
`c`, `w`, `g` sequences from the destination document) and a pasted ROM gets its own new
backing file, exactly as `#commitClusterPaste` already does.

### Paste is an armed placement, never an instant insert

`⌘V` arms a `place-design` placement — the existing `#enterPlacement` machinery, so the
ghost follows the cursor with **no button held**, click drops, `Esc` cancels, and the
armed state locks out the usual conflicts. The ghost is drawn as one board SVG per strip
plus one part ghost per component (both already exist: the kit ghost and the cluster
member ghost), translated rigidly on the integer pitch lattice.

Legality is per-strip: a pasted board is green when its rect clears every *existing* board
(the pasted strips can never collide with each other — a rigid integer translation
preserves a valid arrangement). **The whole clip is all-or-nothing**: unlike a part
cluster, dropping half a design would silently cut its wires, so the drop is refused
outright while any strip is red. Mating snap comes from `snapCorrection`, fed the pasted
rects as *moving* and the document's as *stationary* — the design pulls flush onto the
boards already on the desk before the click, never after it.

### The tab context menu is the ONE part-menu shape

Per the house rule, a right-click on a tab builds the same three items in the same order —
**Pin Assignment** (always `disabled`; a tab has no pins), **Properties…** (rename), and
**Delete Component** ("Delete Desktop"), `disabled` on Main and while the sim runs. The
shape never changes, only the enabled state.

Deleting a tab with unsaved changes prompts three ways — **Cancel / Save / Discard** —
which needs one new `PopupManager.confirm3` shape (the existing `confirm` is two-button).

## Implementation steps

1. **`app/store/project-store.js`** (new, main) — the projects root under `userData`, over
   `io.js`: `list()`, `create(name, mainDoc)`, `load(slug)`, `saveMeta(slug, meta)`,
   `readTab(slug, file)`, `writeTab(slug, file, doc)`, `addTab(slug, name)`,
   `removeTab(slug, tabId)`, `remove(slug)`. Name → slug is sanitised and resolved-path
   checked inside the root; `create` rejects an existing name (the uniqueness rule).
2. **`app/main.js` + `preload.js`** — `project:list` / `create` / `load` / `save-meta` /
   `read-tab` / `write-tab` / `add-tab` / `remove-tab`, in lockstep (extend
   `tests/ipc-parity.test.js`). Reuse `closeAuxWindows()` on a tab switch via a small
   `project:tab-changed` (or fold it into the existing switch path).
3. **`model/design-clip.js`** (new, pure) — `captureDesign(doc, {boardIds, componentIds,
   wireIds})` → `{boards, components, wires, origin}` with run-volatile state stripped;
   `resolveDesign(doc, clip, shift)` → per-board rects + legality + the remapped seats;
   `snapDesign(doc, clip, shift)` → the mating correction. Sibling test file.
4. **`model/desk-doc.js`** — `pasteDesign(clip, shift)`: mint fresh board ids (one group
   per pasted run), re-seat every component onto its new board, re-address every wire,
   and return the new ids — one mutation, one commit, so it is one undo step.
5. **`components/desk-controller.js`** — extend the marquee to select boards; extend
   `copySelectedComponent()` (→ `copySelection()`) to build a design clip when boards are
   in the selection; add the `place-design` ghost (`#trackDesignGhost` /
   `#commitDesignPaste`) beside the existing cluster one; expose `loadDocument(json,
   history)` wrapping `restore` + `#rebuildScene` + history swap; expose the clip so the
   workspace can hold it across a tab switch.
6. **`components/project-tabs.js`** (new, view) — the tab strip: click to switch, a `+`
   affordance, the per-tab dirty marker, and the context menu (the three-item shape).
   Reports to its creator by constructor callback.
7. **`components/project-workspace.js`** (new) — the coordinator: the tab list, the
   per-tab camera / baseline / `HistoryStore`, the document swap (stop sim → close aux
   windows → `controller.loadDocument` → re-point guide/analyzer/schematic), project
   create/load, and the autosave of `project.json`. `app.js` stays a wiring file.
8. **`app.js`** — the **Projects** toolbar icon button and its menu (*New Project…*,
   *Load Project…* | *Add tab*), the tab strip mount, and the New/Load/Save actions
   re-pointed at the active tab when a project is active.
9. **`popup-manager.js`** — the three-way `confirm3` (Cancel / Save / Discard) used by the
   tab delete and by any future save-or-lose prompt.
10. **`styles/app.css`** — `.project-tabs` / `.project-tab` / `.project-tab--active` /
    `.project-tab--dirty`, from the existing tokens.
11. **Tests** — `project-store.test.js` (uniqueness, path containment, tab lifecycle),
    `design-clip.test.js` (capture is relative and complete; a wire with one endpoint
    outside is dropped; a rigid shift preserves the arrangement; an overlapping board is
    illegal), `desk-doc.test.js` (paste remaps ids/addresses; one undo step),
    `project-workspace.test.js` (switch swaps documents and histories; delete prompts when
    dirty; Main cannot be deleted), plus the ipc-parity extension.
12. **Docs** — a *Projects & sub-desktops* page in `src/web/docs/`, added to the `PAGES`
    index in **both** `components/docs-viewer.js` and `scripts/build-docs.mjs`.

## Acceptance criteria

- The **Projects** toolbar button opens *New Project… / Load Project… | Add tab*. With no
  project, *Add tab* asks for a project name first, refuses a name already saved (offering
  to load it instead), then creates the project with **Main** + **Sub-Desktop #1**. With a
  project active it adds one **Sub-Desktop #(N+1)**.
- Clicking a tab swaps the desk to that document; the toolbar's New / Load / Save and the
  palette, guide, analyzer, and simulation all act on the active tab.
- ⌘Z undoes the *active tab's* last edit after switching away and back.
- A marquee over a sub-desktop design + ⌘C, then switching to Main and ⌘V, shows the whole
  design — boards, chips, wires — ghosted under the cursor with no button held. It mates
  flush with a board already on the desk as the cursor nears it; a click drops it; `Esc`
  removes it with the document untouched.
- A pasted design is one undo step, and its parts, boards, and wires all carry fresh ids —
  the source tab is unaffected.
- Right-clicking a tab opens the standard three-item menu (Pin Assignment disabled);
  *Delete Desktop* is disabled on Main, and on a dirty tab prompts Cancel / Save / Discard.
- The project file records the tabs and their files and is rewritten as soon as the tab set
  changes; reopening the app (or *Load Project…*) restores the tabs and the active one.

## Constraints

- No second desk, no second controller, no reload-per-switch — the document swap rides the
  existing `restore` + rebuild path.
- All project file I/O lives in main behind `project:*`; the renderer never sees a path it
  can write to directly, and main alone resolves a name into the projects root.
- The design clip is pure data (`model/design-clip.js`, DOM-free, tested); the controller
  renders it, the document stamps it.
- The tab context menu keeps the app-wide three-item shape — disabled, never absent.
- Run-volatile state (sim, clock phase, memory images) never crosses a tab switch.

## Verify

```bash
make fmt && make lint && make test && make debug
```

In the app: Projects ▸ *Add tab* → name the project → build a small design (board, chip,
a few wires) on **Sub-Desktop #1** → marquee it, ⌘C → click **Main** → ⌘V → move the ghost
next to an existing board (it snaps flush) → click. Confirm the drop is one ⌘Z, that Esc
on a fresh ⌘V leaves the document untouched, that right-clicking Main offers a disabled
*Delete Desktop*, and that quitting and relaunching restores both tabs.
