---
paths:
  - "src/web/scripts/popup-manager.js"
  - "src/web/scripts/components/part-properties-dialog.js"
  - "src/web/scripts/components/palette-*.js"
  - "src/web/scripts/components/wire-color-dot.js"
  - "src/web/scripts/components/bus-width-badge.js"
  - "src/web/scripts/components/chip-pinout.js"
  - "src/web/scripts/components/keyboard-shortcuts.js"
  - "src/web/scripts/components/about-dialog.js"
  - "src/web/scripts/components/notification-stack.js"
  - "src/web/pinout.html"
  - "src/web/scripts/pinout.js"
  - "src/web/index.html"
  - "src/web/scripts/tests/popup-manager.test.js"
  - "src/web/scripts/tests/part-*.test.js"
  - "src/web/scripts/tests/palette-panel.test.js"
  - "src/web/scripts/tests/pinout-window.test.js"
  - "src/web/scripts/tests/chip-pinout.test.js"
---

## Header toolbar

**One shape.** A **pill** (`.toolbar-pill`) groups buttons that read as ONE control: it
carries the only border and the only background, its `.toolbar-pill-btn` segments are
separated by spacing rather than borders (there is no split-button seam anywhere), and an
armed segment FILLS instead of gaining an accent border. Every toolbar button is a pill
segment now — the standalone `.toolbar-btn` / `.toolbar-icon-btn` shapes had no users left
and their rules are gone. `.toolbar-btn--active` is the one class every armed state
toggles. The pill is the APP's grouping shape, not
the toolbar's alone — the desktop tab strip (`.project-tabs`) is the same thing floating
over the desk, its active tab filling exactly as an armed segment does.

Three pills:

- **Desk tools** — Wire · Bus · Fade · Probe · Analyzer · Fit · **BOM** · **Schematic** ·
  **3D** (hidden unless Settings ▸ Appearance ▸ 3D enabled is On) · **AI** · **Generate** (the Arduino headers — disabled with no Output/Input on the desk, and
  carrying a dot while one is out of date). BOM lives here rather than with the file actions because it toggles a desk panel
  exactly as Analyzer does, and like Analyzer its armed state comes from the panel's own
  `onVisibilityChange`, so the segment tracks the panel however it was closed. AI is the
  same shape and the one segment DISABLED when it has nothing to offer. **Schematic** is
  the odd one: it arms no tool and opens no panel, it SWAPS THE VIEWPORT, so its icon
  shows the view it would take you TO (diagram boxes on the desk, a tie-point board on the
  schematic), the way Fit previews zoom-out-full while Shift is held. It is `Tab`'s button
  — both call app.js's one `setMode`, which owns icon, tooltip and armed state.
- **File** — New · Open · Save · Save As, all aimed at the PROJECT. Every action is its
  OWN icon-only segment rather than a row behind a ▾: they are peers, and a toolbar's job
  is to show what is available; the name + accelerator live in each tooltip. An MRU list
  still can't be a BUTTON, but it is what **Open's SECONDARY click** offers (the same
  split the tab strip's `+` uses) and what **⇧⌘O** drops, anchored under that same
  segment. That chord is the ONE file accelerator `bindShortcuts` owns rather than the
  native menu (an Electron accelerator on a submenu PARENT swallows the key without
  opening anything), which is also why it sits ahead of the typing guard — a file action
  is aimed at the app, not at whatever has focus. `ProjectWorkspace.openRecentMenu(x, y)`
  builds it from main's ONE list (`project:recent:list`, also the allowlist the open is
  checked against), asked for as the card opens rather than remembered here — main
  rewrites it on every save and open, so a copy on this side could only fall behind. An
  EMPTY list still opens a card with the same disabled placeholder the native submenu
  shows (`menu.file.noRecent`): a menu saying "nothing yet" answers the click. Each row is
  the file NAME with the whole path as tooltip (the only thing telling two projects of the
  same name apart) and carries the × `PopupManager` renders for an `onRemove` — dropping
  an entry is not a selection, so the menu stays open.
- **Transport** (`.toolbar-pill--transport`) — the one pill whose SEGMENT COUNT changes:
  stopped it holds only **Run**; running it becomes **Stop** with Pause · Step · speed
  unhidden beside it (`.toolbar-pill-btn[hidden]` collapses the rest), so it never offers
  a control that doesn't apply. Run/Stop keeps its green/red signal as colour alone — the
  pill carries the only border, so no segment accents one of its own.

**A pill segment may carry a READOUT** — the Wire button's colour dot
(`components/wire-color-dot.js`) and the Bus button's width badge
(`components/bus-width-badge.js`, `2`–`8`/`16`). A readout SHOWS the active option, and
both of today's two are also the PICKER for what they show (a small `PopupManager.popover`
— the wire dot the SAME eight swatches the wire's Properties dialog offers, the bus badge
one circled number per `BUS_WIDTHS` preset in a row). ONE contract, written once and
applied twice, which is why each is a module rather than a few lines of app.js:

- **Picking does not arm the tool** — the segment already arms when its label is clicked,
  so the readout must be the one place that doesn't, or there would be no way to set the
  pending option without entering the tool (the keyboard paths are themselves gated on the
  tool being armed). Its listener `stopPropagation()`s.
- It stays a `<span>` inside the one `<button>` (a nested `<button>` is invalid HTML, and
  re-splitting the segment is exactly what the redesign removed) and stays `aria-hidden`:
  an interactive DESCENDANT of a button has no honest place in the accessibility tree, so
  a readout is a pointer shortcut to something already reachable another way, never the
  only way.
- While the circuit RUNS it must be taken out by hand — a DISABLED `<button>` suppresses
  its own activation but still delivers a click to a descendant (measured in the real app,
  not assumed), so the readout asks the button it is in and CSS drops it from the hit test.
- The popover **closes FIRST, then reports** (the order `menu()`/`confirm()` use, so a
  callback that opens something of its own is never queued behind it), and closes even
  when the option picked is the one already active — the click answered the question.

The keyboard path is the same choice without the pointer: 1–8 set the wire colour or the
bus width **while that tool is armed**; `2`–`8` name their own width and `1` is the 16-bit
bus, since no digit spells 16 and the widest bus is worth the first key (`busWidthForKey`
in `model/desk-doc.js` owns that mapping, which is why `BUS_WIDTHS` stays in natural
narrowest-first order — the picker and the badge both walk it in that order). Either
readout sets what the tool lays NEXT and nothing already on the desk — a placed wire's
colour changes through its Properties dialog, a placed bus through its context menu.

**The parts tray is deliberately NOT in the toolbar**: it carries its own chevron in the
palette header's top-right corner, and shuts down to a **rail** (`components/palette-rail.js`)
rather than to nothing — a layout column one icon wide whose head row IS the header's (same
padding, control height and rule, so the reopen chevron and the line under it do not move
and the control reads as one thing sliding into the wall), then one icon per TOP-LEVEL
section in tray order (`RAIL_SECTIONS`: Boards · Chips · Components · Memory · Annotations
· Signals — the test derives that list from what the tray mounts, so a new section without
an icon fails). **Each icon sits level with its header's label as a SHUT tray lists it**, so
closing the tray leaves every icon where its label was: the rail column copies the list's top
padding, each header's margins (in a BLOCK column so they collapse as the headers' do, not a
flex gap) and a row one line of that header's text plus its padding — `--font-size-xs` for
the Memory row (`palette-rail-btn--group`, the one top-level catalog GROUP), `-sm` for the
folders. Nothing in jsdom lays out, so `palette-panel.test.js` holds the rail's rules to the
header rules they copy. **The same glyphs head the OPEN tray's top-level sections**, between
the caret and the label: `components/palette-icons.js` is the one copy both views draw from,
and `--palette-icon` (1.3 × `--font-size`, declared on `.palette-panel, .palette-rail`) the
one size, so shutting the tray changes where an icon is, never what it is — and one colour,
`--color-brand` (theme.css: the app icon's 150° green, `#2f855a` on light, lifted to `#5eba8c`
on dark), which a hover never changes: it lifts the button or the label instead. In a header the
icon is a ZERO-HIGH flex item its glyph overflows evenly — it is taller than Memory's line of
`-xs` text, and a header that grew to fit it would no longer be the row the rail is measured
against. The match is VERTICAL only, on purpose: open, each icon sits a caret's width (8 px)
further right, and that small slide is what makes opening read as the drawer stretching out
— widening the rail to line them up horizontally was offered and declined. Clicking a rail
icon runs
`#openSection`: every other top-level entry shuts, the groups INSIDE the chosen one keep
their session state, a live filter is cleared (it hides three of the six sections), and
focus moves to that header, since the icon that had it has just been hidden. The rail is a
thin view with no tray state; the chevron is the panel's button, handed in. The chevrons,
the icons and ⌘P all route through app.js's one `togglePalette` (the only thing that
persists `paletteOpen`); `PalettePanel.setVisible` shows exactly one of tray and rail, and
since both are layout columns the tab strip needs no inset. Its WIDTH is the user's: `.palette-resize` is the analyzer's
resize seam stood on end (same grip, `ew-resize`, straddling the border so it never covers
the list's scrollbar), clamped to `[180, half the window]` and persisted as
`settings.paletteWidth` — reported by the panel, written by app.js. It survives a
close/reopen for free, since shutting the tray HIDES the panel rather than rebuilding it.
The drag runs on `pointer-gesture.js`.

## Popups & menus

`popup-manager.js` (ported from Port Hippo) is the only app-wide dialog/menu seam; build
DOM with `dom.js` `el()`. `PopupManager.close()` fires a one-way `chiphippo:popup-closed`
so stateful dialogs can reset their open-guard however they were dismissed. Every callback
goes through `fire()`, which reports a throw or rejection instead of dropping it.
`dialog`'s optional `headerActions` puts a card's own icon buttons (`.popup-header-btn`,
the ×'s box) in one `.popup-header-actions` group LEFT of the ×.

- Beyond `menu` / `confirm` / `prompt` / `notify` / `dialog` there is **`choose`** — the
  Cancel + N-choices shape a "save, discard, or cancel" question needs (the tab delete,
  the leave-a-project guard), where "no" splits into two different answers; its `onChoose`
  fires with `null` for every dismissal, so a caller can never miss one — and
  **`popover`**, `menu`'s positioned, non-dimming host with the caller's OWN DOM in the
  card instead of an items array. The popover card is a plain SURFACE and takes no role of
  its own (whatever goes in brings its own semantics — the colour picker is a
  `role="radiogroup"`), and never closes itself when its content is used: that is the
  content's call.
- Both POSITIONED shapes hand coordinates to `open()` as `place`, and `mount()` clamps the
  card into the viewport right after `showModal()`: a card has to be shown before it can be
  measured, and a popup QUEUED behind another mounts long after its coordinates were named,
  so placing it at request time would clamp a node that is still zero-size.
- **PopupManager QUEUES a second popup rather than stacking it** — which is why a card
  raised from inside another modal must close the first (Settings ▸ Download…), and why the
  Settings info notes are NOT popovers (see `info-button.js`).
- `menu`'s item vocabulary is `{ label, disabled, danger, swatch, icon, accelerator, title,
  checked, submenu + emptyLabel, onSelect, onRemove }`. A boolean `checked` makes the row a
  `menuitemcheckbox` with `aria-checked` and a tick in the icon slot (a custom chip's
  Break on Settled). A card where ANY item has an `icon` gives
  every item the 16 px slot (so labels line up); a `submenu` opens as a SIBLING card in the
  same dialog (hover or click; never nested, so it can't be clipped); `onRemove` renders a
  trailing × that drops its row IN PLACE and leaves the menu open. `emptyLabel` is a
  CARD-level option (passed alongside `items` for the root card, or on the owning item for
  a submenu) — both the placeholder for an empty list and what the last `onRemove` falls
  back to. Everything is opt-in: an item with none of them renders as it always did.

## Context menus & dialogs

- **Part context menu — ONE shape for every kind.** `DeskController.#onPartContextMenu`
  builds the same three items, always, in this order: **Pin Assignment**, **Properties…**,
  **Delete Component**. No per-kind branching and no extra items — an item that doesn't
  apply stays PRESENT but `disabled` (Pin Assignment with no pins/terminals; Properties…
  with no fields; Delete while `#editingLocked`), so the menu's shape never changes, only
  its enabled state. There is no Rotate (rotating a placed, selected part is `R` only, in
  `handleKeyDown`) and no "Replace chip" (**Stop** restores every damaged chip). There
  are two deliberate exceptions, each a part with something running INSIDE it. A CUSTOM
  chip (`#customChipMenuItems`) adds Open in Chip Designer and Break on Settled between
  Properties… and Delete (see "Custom chips"; a LINE breakpoint is set in the designer's
  gutter). Its Pin Assignment is the ordinary pinout window, handed the chip by the app
  window. A CPU (`#cpuMenuItems`, gated on `isCpu(def)`) adds **Open CPU Monitor** in the
  same place (see "Auxiliary windows").
- **Part Properties dialog** (`components/part-properties-dialog.js`) is the ONE shared
  modal every **Properties…** opens, enabled when
  `DeskController.#propertyFieldsFor(comp, def)` returns at least one field. **A catalog
  def declares its own editable fields as data** (`properties: [{ key, label, type,
  options }]`) and the dialog is a pure renderer over that list (one
  `buildControl`/`buildRow` dispatch per `type`) that knows nothing about any specific
  part. A future part's properties are purely a catalog change, plus one more `type` case
  only for a genuinely new control shape. Eight types:
  - `"color"` — every coloured discrete (LED, `seg8cc`/`seg8ca`, `bar8`/`bar8iso`) shares
    one `LED_COLOR_OPTIONS` list of 5 and a row of swatches reusing the
    `--color-wire-<name>` tokens. Any def with a `colors` list arms placement directly with
    the "Default LED color" setting instead of a placement-time popover (`app.js`'s
    `onPickChip`).
  - `"select"` — a `<select>` over `options: [{value, label}]` (PSU volts, clock Hz). A
    `<select>`'s value is always a STRING, so `buildSelect` looks the typed option value
    back up by its stringified match rather than handing the raw string to
    `normalizeParams`, which compares by `===`.
  - `"segmented"` — the SAME options list as one bordered track (the shared
    `components/segmented-picker.js` the Settings dialog uses), which is the point: a
    wire's **Layout Method** and the app-wide default for it are ONE choice met in two
    places, so they must not be a dropdown here and a segmented picker there. Pick it over
    `"select"` for a short, closed either/or whose choices should be readable without
    opening anything. It is also the one field whose value is DEFAULTED IN by its opener (a
    direct wire stores no `layout`, and a picker still has to show something).
  - `"action"` — a full-width command button, not a value (a memory chip's "Inspect
    memory…" / "Load image… (program)"), appended by `#propertyFieldsFor` itself rather
    than the catalog since a ROM's program action is additionally gated on
    `!#editingLocked`. Clicking one closes the dialog and calls `onAction(key)` instead of
    `onChange`.
  - `"readonly"` — a value SHOWN but not edited (the PROJECT's Location, which Save As is
    what changes; a memory chip's Image file, which the programmer is); both take the
    stacked full-width row a path needs and are DERIVED, so they are supplied through the
    dialog's `values` rather than read off `params`.
  - `"wire-gauge"` — a PICTURE, not an editor (below); the one type named after what it
    draws rather than after a kind of control.
  - `"range"` — a slider over `min`…`max` in `step`s (the potentiometer's Position). The
    ONE value control that applies on `input` rather than `change`: it stands for a knob,
    and turning it while the circuit runs and watching the result is the point. Each step
    is a coalesced undo entry. Read out as a locale-formatted percentage — unless the
    field carries `ends(values)`, two texts for either END of the track (the pot's
    `1.5k ━●━ 8.5k`: wiper↔pin 1 left, wiper↔pin 3 right, a dead side "0"). The DIALOG
    fills those (`refreshEnds`), re-asking with its current values after EVERY change, since
    they rest on another field (a new Resistance moves them); `aria-valuetext` is the pair.
  - `"combo"` — a value or part number picked from a list or typed (see "Values,
    capacitors & timed parts"); the one type that commits a PATCH of several keys.
  - Like Settings, value fields apply live (`onChange(key, value)` per control change, no
    Save/Cancel). `#setComponentProperty` applies the patch via
    `DeskDoc.setComponentParams` and **remounts** the part view (`#remountPart`, not
    `updateParams` alone — a rotatable/span part only redraws through its span geometry)
    before committing through `#emitDocChanged` (coalesced) so it rides undo/redo.

## Application menu

`main.js buildMenu()` installs the native menu: **File · Desktop · Edit · View · Window ·
Help**. Its items are one-way pushes (`menu:*` via `webContents.send`) the preload
re-dispatches as `chiphippo:*`; `app.js` hands the project/desktop ones straight to
`ProjectWorkspace` — the only side that knows what is open and what is unsaved.

- **FILE is the PROJECT's**: New Project ⌘N · Open… ⌘O · Open Recent ▸ · rule · Save ⌘S ·
  Save As… ⇧⌘S · rule · Project Properties… · rule · Bill Of Materials… ⌘B — each a
  `menu:project-*` (or `menu:build-guide`) becoming `chiphippo:project-*` /
  `chiphippo:build-guide`. **The toolbar's File pill dispatches the SAME events**, so the
  two can't drift.
- **DESKTOP** is the structure inside it — New Desktop · Duplicate · rule · Import… ·
  Export… · rule · Properties… · Delete (`menu:desktop-*` → `chiphippo:desktop-*`), every
  one aimed at the ACTIVE desktop. The tab strip mirrors it in two halves (the `+`'s two
  ARRIVALS; a tab's context menu for the rest), so the labels must stay in step — and so
  must their AVAILABILITY: **Duplicate** and **Delete** carry menu-item ids and take their
  enabled state from the renderer over **`menu:desktop-state`**
  (`{canDelete, canDuplicate}`), exactly as Edit ▸ Undo/Redo does over `menu:edit-state`.
  The workspace pushes on every change to the tab set or the run lock (`#pushMenuState`,
  from `#renderTabs` and `setEditingLocked`), and `refreshAppMenu` replays it. A menu that
  offers what the strip forbids is worse than a greyed item.
- Open Recent is the one push carrying a **payload**, so the preload passes `detail`
  through for every channel; and it is baked into the menu TEMPLATE, so main rebuilds the
  whole menu (`refreshAppMenu`) whenever the MRU changes — which is why `setEditMenuState`
  remembers the renderer's last Undo/Redo availability and replays it (a fresh template
  starts both disabled).
- **HELP** is User Guide ⌘/ · rule · Keyboard Shortcuts ⌘K · rule · Check for Updates…
  (with About and a second rule ahead of Shortcuts off macOS, where there is no app menu to
  hold it). Check for Updates is the ONE item that pushes nothing — it calls
  `updater.checkForUpdates({manual:true})` in main directly, because the result comes back
  on the `updater:*` channels regardless of who asked. It is also the one item that can be
  ABSENT rather than disabled (a store build has no updater at all), and its separator goes
  with it, since a menu must not end on a rule.
- **About** / **Settings…** push `menu:show-about` / `menu:open-settings`, re-dispatched as
  `chiphippo:show-about` / `chiphippo:open-settings`; `app.js` opens
  `components/about-dialog.js` (name/subtitle/desc + version info from `app:info:get`) and
  `components/settings-dialog.js`.

## Auxiliary windows

Each is its own sandboxed renderer using the ONE shared `preload.js` (Chip Hippo has one
bridge, not Rest Hippo's per-window narrow preloads), awaits `i18n.init()` and
`followFontSize(bridge)` before painting, and — except the docs window and the Chip
Designer (a singleton that prunes its tabs to the incoming project instead; see "Custom
chips") — is closed by `closeAuxWindows()` on New/Open.

**Pin-assignments window** — **Pin Assignment**, the item leading every part's context
menu (`#onOpenPinout(ref, rows, rot)` → `pinout:open`), opens `web/pinout.html` →
`scripts/pinout.js` rendering `components/chip-pinout.js`'s `buildPartPinout`. One builder
per catalog shape: DIP chips → the physical two-column diagram; discretes → a linear pin
list keyed to anchor-hole offsets; PSU/clock bricks → a terminal map. One window per ref
(re-open focuses); `alwaysOnTop` by default, with a native right-click menu toggling that
for every open pinout and persisting it as `settings.pinoutFloat` (a de-facto global). Pure
DOM, no modal chrome — the native frame owns the title bar and close. It is offered even
while the circuit runs (the pin map is read-only; the example button is not, but adding a
desktop stops the run exactly as switching tabs does).

- Every pinout is at least **`PINOUT_MIN_WIDTH`** (500 px) and the plain default sits ON
  that floor: a pin line is `badge · name · role` against a right-aligned detail, so a
  narrower window reads as two unrelated columns rather than one row. Main widens it (640)
  when a datasheet crop exists; the `<img>` loads lazily and its `<figure>` removes itself
  on error.
- The header's top-right carries line-drawn buttons, one box per glyph
  (`.pinout-header-btn`, one CSS rule) — and they are the only reasons this otherwise
  bridge-free window loads `preload.js`:
  - **datasheet PDF** (`datasheetButton`, shown when main flags `?pdf=1` because
    `settings.datasheetDir` holds a `<ref>.pdf`) → `datasheet:open` → `shell.openPath`.
    Independent of the committed PNG crop: either, both, or neither may exist.
  - **example circuit** (`exampleButton`, shown when main flags `?demo=1`).
  - **open in the Chip Designer** (`chipDesignerButton`) — a CUSTOM chip's (`?custom=1`),
    alone in place of the other two. That window draws the chip from data, not the
    catalog (`buildCustomPinout`), and is the one pinout that changes while open; see
    "Custom chips".

**Memory inspector** — see "Memory chips". **Docs window** — see "User guide & docs".

**CPU monitor** (2026-10-10, `features/done/cpu-monitor.md`; guide: chip-library.md ▸ "The
CPU monitor"). A live view of one W65C02/Z80A (read-only at first; memory edits and breakpoints added the same day, below), modelled on Jason's TTL-6502 CLI
debugger but limited to what these chips have. Its microcode areas (control lines,
internal buses, ALU) are left out on purpose — his rule: match where available, skip the
rest.
- **The window** is a singleton like the Chip Designer: `openCpuMonitorWindow`,
  `cpumonitor:open|to-window|to-host`, pushes `cpumonitor:inbound|host-inbound`.
  `ipc-guard.js` restricts `open` and `to-window` to the app window and lets only the
  monitor send `to-host`. It is NOT in `closeAuxWindows()`; it closes with the app's
  main window.
- **The chrome is the chip debugger's** (Jason, 2026-10-10: "look more like the Chip
  Designer"): a TAB per CPU (`cpumon-tabs`, the shown one badged Running/Paused — no
  ×, the tabs are the desktop's CPUs), then a bar (`cpumon-bar`) in the toolbar's pill
  shape — ▶ Continue · Step — with a one-line status (`#statusText`: `At $8021: BEQ
  $8039`, `At the breakpoint at …` when PC's line has one and the op is at its first
  step, an event's name, a "Running" hint), then the keep box and the count. The CSS
  is SHARED: the `cd-tabs`/`cd-tab*`/`cd-bar`/`cd-bar-status` rules list the
  `cpumon-` selectors beside their own, so the two windows cannot drift. Tabs and bar
  are built once and the tabs redrawn only when their CPUs, the shown one or the mode
  change (`#tabsKey`), so a click is not torn down mid-press. There is no `<select>`
  picker any more.
- **`components/cpu-monitor-bridge.js`** decides which CPU is shown: the first by id, or
  the one picked in the window's tabs, or the CPU selected on the desk while the window is
  open. It calls `SimHost.monitorCpu(id)` only while the window is open, and forwards
  each `sim-state`'s `cpuMonitor` as one `state` message, no oftener than `SEND_MS`
  (100 ms) with a trailing send. Stopped, it keeps the last summary, which the view
  dims.
- **The view** (`cpu-monitor-view.js`) works nothing out. The summary is built in the
  run (`sim/cpu-monitor.js`; see "Simulation").
- **No cycle table, no buses panel, no Step Out** (Jason, 2026-10-10). They were built —
  a per-T-state "This instruction" table with forecast rows, a Buses panel, a
  microstep Step and an F7 Step Out — and REMOVED: the cores emulate an instruction's
  RESULT, not the silicon's insides, so a cycle-by-cycle view showed the emulator's
  bookkeeping rather than the chip's. Don't bring them back. What stays: Step runs to
  the next operation, and the Registers panel lists ONE register a line (`cpumon-regs`,
  one grid column) in the body's `registers` area, which runs the WHOLE height of the
  right-hand column (beside State AND the pipeline — a Z80 has seventeen), so State is
  only as wide as the pipeline. A fourth column (`cpumon-side`) stacks Stack,
  Breakpoints and (Z80 only) I/O ports. The window opens at 1200×570
  (`openCpuMonitorWindow`) and **can't get any bigger** (Jason, 2026-10-10), so the
  side column is pinned to the rows the other columns make (`height: 0; min-height:
  100%`): the ports take their own height, Stack and Breakpoints split the rest
  evenly and SCROLL (`keepScroll` holds the position across redraws). The registers
  are spaced like the memory rows (no gap, 1.5 line) so a Z80's seventeen fit.
  Measured on the Z80A example with 8 breakpoints: nothing scrolls but those two.
- **Editing a byte** (Jason, 2026-10-10): click a byte, then type hex digits;
  type-through, Enter, Escape and the arrows work as in the inspector's grid. It works
  only while the run is live. The view keeps the pending digit itself, never in an
  `<input>`, because the body is rebuilt on every message. A written byte is shown
  optimistically for `OPTIMISTIC_MS` or until a board carries it.
  - The `poke` goes bridge → `SimHost.pokeCpuMemory` → `SimController.pokeCpuMemory`.
    That locates the chip through the address map (`locate`), sets the CPU's bits in
    its word (`pokeWord`), owes the change to inspectors and ticks the board.
  - It writes the RUN image only, a ROM's included: the document is locked while
    running, so nothing is written during the run.
  - **"Keep ROM edits after Stop"** (the bar's checkbox, built once like the tabs;
    `settings.cpuMonitorKeepEdits`, default off, written by the bridge's
    `onKeepEdits`). Ticked, the bridge saves at Stop every ROM edited during the run.
    - Which ROMs were edited is read off `chiphippo:mem-state`: a change reported for
      an `isRomChip` part can only be a poke, since the circuit's ROM writes are
      dropped. The set is cleared at `started`.
    - The bytes come from Stop's final `images`, saved through
      `MemoryBridge.keepRunEdits` (the inspector's `#save`: the file is written, the
      chip is flagged programmed and edited as one undo step, and an open inspector
      gets its context again so it re-reads the file). A toast names each chip saved.
    - The flag is read AT STOP, so ticking it mid-run counts. An SRAM is never kept.
    - **The box is HIDDEN until a ROM has been edited this run** (Jason,
      2026-10-10). The state message's `romEdited` (edited set non-empty) shows it
      from the first ROM change until Stop. An SRAM edit does not show it, since
      there is nothing to keep.
    - Unticked, a ROM edit lasts until Stop, and the inspector reloads from the file.
- **Breakpoints** (per placed CPU) are owned by the BRIDGE and KEPT IN THE PROJECT
  (Jason, 2026-10-10): the project's `cpuBreakpoints` — `{tabId: {compId: [addr…]}}`,
  per DESKTOP since `c3` is only unique within one — beside `codegen` and on the same
  terms. `model/project-doc.js` `cpuBreakpointsOf`/`setCpuBreakpoints` (cleaned: `c<n>`
  ids, whole 16-bit addresses, sorted, unique, ≤ 256; pruned to existing tabs; omitted
  from the file when empty), main's own `sanitizeCpuBreakpoints` in
  `project-store.js`, and `ProjectWorkspace.cpuBreakpoints()`/`setCpuBreakpoints(map)`
  for the ACTIVE desktop — an edit like a rename (the •, auto-save), never a
  DOCUMENT edit (no undo step, no doc-changed, so toggling one mid-run touches nothing).
  The bridge's `store` (app.js wires it to the workspace) is read at construction and
  on every `chiphippo:desk-loaded` (the sim told to drop the old and take the new), and
  written on every change with only the CPUs still on the desk. Duplicate Desktop
  copies them to the copy; Export/Import of a desktop does not carry them.
  - Set them three ways: F9 on the selected byte, the byte's right-click
    `PopupManager.menu` (checked Breakpoint · Clear All Breakpoints), or a click in an
    instruction line's margin. A set one is red (`cpumon-byte--break`,
    `--color-debug-break`) and its line carries a red dot.
  - Every change is told to `SimHost.setCpuBreakpoints` (both threads; the start
    message carries them), so they fire with the window closed.
  - A hit that PAUSES the run raises the window on that CPU (`chiphippo:cpu-break`
    with `paused`). A Step onto one only re-selects.
- **Pause/Continue (F8), Step (F6), Step Over (F7)** (Jason, 2026-10-10): the bar's
  three buttons, `MONITOR_KEYS` → each button's `data-key`. The first is ONE button
  whose `data-action` flips: `pause` while running, `continue` while paused (DevTools'
  F8 toggle) — the bridge calls the run's own `pause()`/`resume()`, so it is exactly the
  toolbar's. Step needs a summary too and sends `{kind: "step", compId}`; the bridge
  passes it on only while paused and only for the CPU shown (`SimHost.stepCpu` →
  `SimController.stepCpu`; see simulation.md). Step Over is enabled only while paused
  with `summary.pipeline.current.call` (a JSR, CALL or RST — Jason: "only when a jump
  is the current instruction") and sends `step-over` (`stepOverCpu`).
- **The memory block follows PC until the user looks elsewhere**: a click on a byte, the
  wheel, an arrow/Page key off its edge or the **Go to** field PINS it (`view` message
  → bridge `#memAt` → `SimHost.monitorCpu(id, {memAt})`; reset to following on another
  CPU, a reopened window, Stop does not), **Follow PC** lets go and drops the
  selection. The selected byte is therefore always in the block shown or the one asked
  for, and `#editable` refuses any other — never a byte out of sight. The Go-to field is
  an `<input>` inside a panel, which is why the PANELS are built once and only their
  `cpumon-panel-body` redrawn; field keys stay the field's (`#onKey` returns on an
  input target after the F-keys).
- **Breakpoints panel** lists every breakpoint of the CPU (from the state message's
  `breakpoints`, text from `summary.breakLines`), shown even before Run; a click on an
  address goes to it, × clears it. There is NO add-by-address field (Jason removed it,
  2026-10-10): set them from a byte or the margin.
- **Registers are editable** while paused at an instruction's start
  (`summary.regsEditable`): click (`data-reg`), type the register's hex digits (its last
  digit writes; Enter fewer; arrows up/down move), `set-register`; a flag click flips its
  bit unless the descriptor's `flags.fixed` keeps it (the 6502's B and unused bit). The
  hint is the registers list's TOOLTIP, not a line of text (no room under seventeen).
- **What changed is lit** (`#noteChanges`): only from PAUSED pictures — a new paused
  count is diffed against the last and becomes the baseline; the same count again (an
  edit) only updates the baseline; Stop drops it (a desktop switch can make `c1` another
  CPU). Registers `cpumon-reg--changed`, flag bits `cpumon-flag--changed`. A key is a PRESS of its button (no modifiers), so a greyed button's
  key does nothing — the chip debugger's `DEBUG_KEYS` rule. **Function keys belong to the focused window**: each
  window listens on its own `window`, so with both the monitor and the designer's
  debugger paused, F6/F7/F8 act in whichever has the focus. The main window binds no F-key, so
  there one does nothing — keep it so: an application-menu accelerator would fire
  whichever window had the focus.
