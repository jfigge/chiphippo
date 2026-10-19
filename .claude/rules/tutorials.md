---
paths:
  - "src/web/scripts/tutorials/**"
  - "src/web/scripts/components/tutorial-*.js"
  - "src/web/scripts/tests/tutorial-*.test.js"
---

## Guided tutorials

Automated overlay tours played over the live app (2026-10-10, spec
`features/done/chiphippo-tutorials-spec.md`). Pure half `scripts/tutorials/` —
`definitions.js` (the DATA), `targets.js` (the registry), `player.js` (the sequencer),
`geometry.js` (callout placement, brace/arrow/ring/spotlight paths, cursor easing) — and
two views, `components/tutorial-controller.js` (menu, welcome, the tutorial desktop, the
actuator) and `components/tutorial-overlay.js` (the layer).

- **Entry points.** The header's **book** (`tutorialsBtn`, left of the gear in
  `.header-icon-panel`; the ONE open-book glyph, `protocol-doc-button.js`'s `bookSvg`)
  raises `chiphippo:open-tutorials` → `TutorialController.openMenu` (a `PopupManager.dialog`
  listing `TUTORIALS` in order). Always offered. The **first-run welcome** is
  `offerWelcome()`, the LAST thing `init()` does (so it queues behind a recovery notice):
  shown unless `settings.tutorials.autoShowDismissed`. Yes → Tutorial 1; Not now / Escape /
  mask → nothing (asked next launch); the checkbox sets the flag whichever way out. Only the
  one `autoShow` tutorial (`AUTO_SHOW_TUTORIAL`) is ever offered unasked; COMPLETING it (not
  exiting it) sets the flag. The flag is written through `chiphippo:settings-changed` like
  every other renderer setting; main's DEFAULTS carry `tutorials: {autoShowDismissed:false}`.
- **A tutorial is data** (`definitions.js` header documents the step shape): catalog KEYS
  for all text (`tutorials.<id>.*`, `{mod}` interpolated), `target` a TutorialId or null
  (centred), `callout {text, placement, decoration}` (placement adds `inside-top` to the
  spec's five — for the desk, which has no room on any side), `action` moveTo/click/drag
  with `onlyIf: collapsed|expanded` read off `aria-expanded` (so "open Boards" never shuts
  an open section), `advance` timed/afterAction, `optional` (skip silently when absent).
  A non-optional step whose target is absent is LOGGED and shown centred; its action is
  skipped. `tutorial-definitions.test.js` holds the shape and every key to en.json;
  `app-boot.test.js` holds every id `tutorialTargets()` names to `registeredTargets()`.
- **The registry** is module-level (`registerTarget(id, elementOrGetter)` → deregister fn).
  A GETTER answers whatever stands for the thing now, or null: the palette registers
  `componentTray` (tray or its rail), `palette.open` (the rail chevron, only while shut),
  `palette.boards` / `palette.chips` (header in the tray, icon on the rail),
  `palette.board.full`; the tab strip `desktop.tabs`; app.js the toolbar (`toolbar.*`),
  `desk` and `desk.boards` (every board as ONE union rect — a getter may answer an array — clipped to the desk viewport through `registerTarget`'s `{clip}`, since a board runs on under the tray on a narrow window). `resolveTarget` treats a detached or
  `hidden`-ancestored element as absent; `targetRect` a zero-size one.
- **The overlay re-lays out EVERY FRAME** (rAF) from the registry — rect, measured card,
  `placeCallout` — and touches the DOM only when the layout key changes; that is the whole
  resize story. It is also the INPUT BLOCK: fixed, z-index 60 (over toasts at 40; popups
  are top-layer and never opened mid-tour), takes every pointer event, and a CAPTURE
  keydown on `window` swallows every key but Escape (exit) and Tab/Enter/Space on its own
  controls (Previous · Pause/Resume · Next · Exit — Previous disabled on the first shown
  step, and Tab skips a disabled one). Native-menu accelerators can't be blocked,
  hence the abort rule below.
- **The fake cursor drives the app's own handlers** (`#actuator`): a click is the target
  element's own `.click()`; a drag from the tray is this app's click-to-arm then
  `DeskController.trackPlacementAt(x, y)` per frame and `dropPlacementAt(x, y)` — the
  bodies of the desk's own pointermove and click (`#commitPlacement`, shared with
  `#onViewportClick`), so the result is identical (`desk-gestures.test.js` compares the two
  desks). The controller cancels any armed placement when a tour ends.
- **Every tutorial runs on its own desktop** (`ProjectWorkspace.addTutorialTab(name)`, named
  `tutorials.desktopName`). While it plays the tab is held OUT OF THE AUTO-SAVE
  (`#tutorial`; `autoSaveNow` returns false). At the end the keep/close card: Keep →
  `keepTutorialTab()` (an ordinary desktop now); Close → `closeTutorialTab(previousId)`,
  no confirm, back to the desktop the user was on, `nextIndex` un-minted, so a project
  clean before is clean after. Dismissing the card KEEPS. If the active desktop changes
  under a tour (`onActiveChange` → `activeChanged`; ⌘N/Open from the native menu) the tour
  stops with no question; `#adopt` drops the hold.
- **The player** is DOM-free over injected `rect`/`element`/`view`/`actuator`/`clock`
  (`{now, frame}` — rAF in the app, so a hidden window pauses the tour; a 16 ms fake in
  tests). Waits count only while not paused; Next/Previous cut the current wait and
  NEVER resume a pause (Jason, 2026-10-10: only Resume resumes). Previous walks back past
  skipped steps; a REVISITED step (`#visited`) does not redo a click or drag (no second
  board) — a moveTo replays. The fake cursor is shown ONLY while a step's action runs
  (Jason: no mock mouse without a reason) — a step without one hides it, which is why
  Tutorial 1's pointing steps carry no moveTo. Exit throws through every await. Moves are
  eased, 0.5–1 s by distance (`travelMs`).
- **Settings ▸ About ▸ Reset tutorials** (`buildTutorialsRow` in settings-dialog.js, row
  tagged `data-row="tutorials"`) emits `{tutorials: {autoShowDismissed: false}}` — the
  welcome is offered at the NEXT launch, not now. Disabled (with a "will be offered" line)
  when the flag is already clear. On About, not Appearance: it is no look-and-feel
  preference, and Appearance's height is the card's measured height. It survives a store
  build, which hides only the update rows.
- **Tutorial 2's step list is a first cut** — the spec defers its detailed script to a
  session with Jason. Still open from the spec: auto-closing Tutorial 1's still-empty tab
  instead of asking.
