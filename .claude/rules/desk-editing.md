---
paths:
  - "src/web/scripts/desk/**"
  - "src/web/scripts/components/desk-view.js"
  - "src/web/scripts/components/desk-lock.js"
  - "src/web/scripts/components/desk-placement.js"
  - "src/web/scripts/components/desk-selection.js"
  - "src/web/scripts/components/wire-*.js"
  - "src/web/scripts/components/bus-*.js"
  - "src/web/scripts/components/hole-rings.js"
  - "src/web/scripts/components/pointer-gesture.js"
  - "src/web/scripts/components/schematic-view.js"
  - "src/web/scripts/components/build-guide.js"
  - "src/web/scripts/components/breadboard-view.js"
  - "src/web/scripts/components/board-outline.js"
  - "src/web/scripts/components/annotation-layer.js"
  - "src/web/scripts/components/chip-view.js"
  - "src/web/scripts/components/zoom-control.js"
  - "src/web/scripts/model/part-move.js"
  - "src/web/scripts/model/cluster-move.js"
  - "src/web/scripts/model/paste-cluster.js"
  - "src/web/scripts/model/selection-toggle.js"
  - "src/web/scripts/model/wire-length.js"
  - "src/web/scripts/model/schematic-layout.js"
  - "src/web/scripts/model/build-plan.js"
  - "src/web/scripts/model/bus-layout.js"
  - "src/web/scripts/tests/desk-*.test.js"
  - "src/web/scripts/tests/wire-*.test.js"
  - "src/web/scripts/tests/bus-*.test.js"
  - "src/web/scripts/tests/part-move.test.js"
  - "src/web/scripts/tests/cluster-move.test.js"
  - "src/web/scripts/tests/selection-toggle.test.js"
  - "src/web/scripts/tests/schematic-*.test.js"
  - "src/web/scripts/tests/build-*.test.js"
---

## Desk surface & rendering

- **Layers** inside `.desk-surface`: `.layer-boards` → `.layer-parts` → `.layer-wires`
  (one shared SVG) → `.layer-annotations` → `.layer-signals` (planted signal flags — above
  the wires, because a flag is hardware plugged into the board and is drawn over the jumper
  running past it; a multimeter's `.layer-meters` sits just under it — the meter floats
  over the whole circuit, its probes on top: `.claude/rules/meter.md`) → `.layer-overlay`
  (ghosts, hover rings, tooltips — pointer-inert).
- Boards and chips are ONE static inline SVG each; the tie-point/pin `<rect>`s carry **no
  id, no `data-*`, no listener** — all hole/pin interaction is `holeAt()` / derived-pin
  math from pointer coordinates. The sanctioned per-item event exceptions are all widened
  invisible hit targets where idiomatic SVG beats hand-rolled distance math: each wire's
  hit stroke (`pointer-events: stroke`, `wire-layer.js`, listeners on the `g.wire`
  group), each rotatable discrete's `.part-span-hit`, each push button's
  `.part-button-cap`, and each signal flag's `<polygon>` (eight arbitrary rotated
  pentagons is exactly the case that argument was written for). A discrete whose
  drawing carries a `.part-display-hit` gives the rest of its box back to the holes
  under it: `DiscreteView` sets **`part-discrete--body-hit`** on every SVG it builds that
  has one, and app.css turns that (and `part-discrete--span`) to `pointer-events: none` —
  no hand-kept list of refs (one fell behind the 7-segments, the regulators and the
  relay, 2026-10-14).
- **A momentary cap's press runs on `beginPointerGesture`** like every desk drag
  (`DiscreteView#bindCap`, review 2026-10-26): the release is heard wherever it lands, the
  press leaves no listener behind (a cap-bound `{once}` pair left a stale `pointercancel`
  per press), and a view removed mid-press releases first. `NetlistCache` forgets a held
  button on its release (absent IS released), on `chiphippo:desk-loaded` (another
  desktop's `c1` is not this one's) and when its part is gone.
- **Wires draw above parts, so while RUNNING a press goes THROUGH them**: a plain press
  on a wire or bus band with a click-toggling part beneath it flips that part
  (`DeskController#togglePartUnder`, `document.elementsFromPoint`) and the click that
  follows selects nothing (`#pressWentThrough`). A generated layout readily lays a
  lead across a slide switch's knob, and the switch could then not be flipped at all.
  Editing is untouched — there the wire is what a press may want.
- **A span part (every rotatable two-lead part) frames ITSELF when selected**
  (`discrete-view.js` `spanFrame`, `.part-discrete--span`): its element box is padded for
  the body at any angle, so the `.part--selected` / `--illegal` OUTLINE every other part
  takes framed a small part in a lot of empty board. The frame is a rect in the leads' own
  rotated group, round the leads and the body's `size` (`{along, across}` per
  `SPAN_BODIES` entry) at the outline's gap and stroke, shown by CSS only while selected
  (red while refused) — the element outline is switched off for those parts.
- **Pan is Space-drag or the middle button — never a plain drag** on the breadboard
  (`DeskView`'s `panOnEmptyDrag: false`; the schematic keeps its plain-drag pan, where that
  drag means nothing else). There a plain drag on the background is the rubber band. Space
  is ALSO Run/Stop, so app.js tells the two apart by the hold: Space down →
  `DeskView.setSpaceHeld(true)` (the viewport shows `--pan-ready`'s open hand, and a left
  press ANYWHERE on the desk is claimed in the CAPTURE phase as a pan, so nothing under
  it hears it); Space up → `takeSpacePanned()`, and only a hold that did NOT pan toggles
  the run. So Run/Stop by key now fires on the RELEASE. Both 2D views take the hold
  (`spacePan` in `bindShortcuts`); the viewport's own chrome (zoom cluster, rails) keeps
  its clicks. Wheel and two-finger scroll still pan; the padlock still locks the wheel.
  The pan runs on `beginPointerGesture` like every desk drag, so a release off the
  viewport or a window that loses focus mid-pan still ends it. An Option/Alt drag that
  picks no lead pans too (`DeskView.beginPan`, see "Selection" → Option/Alt), with the
  grabbing cursor over pin mode's default one.
- Pan/zoom must **never** rebuild or re-lay-out surface children (transform only); wires
  re-render only on doc changes or live drags (positions passed as overrides).
- **A render touches only the wires that changed** (review 2026-10-26, `wire-layer.js`).
  A wire drawn before is REDRAWN in its own group (`redrawWireGroup`: paths and caps given
  new geometry; colour and the state classes written only when they change), never
  replaced by a new one; `#sync` moves as few nodes as the new order allows (a dry-run of
  the front-to-back walk, else the longest run already in order stays put —
  `stayInOrder`), so lifting the first of 1752 wires moves one node, not 1751. During a
  live drag a wire with no end on anything moving keeps its group unexamined; one whose
  ends both ride one shift (a strip drag, a rider between two members) is its resting
  drawing translated — and when those are the MAJORITY (a kit drag, Select All), the svg
  itself takes the one CSS transform, with `will-change` while it slides, and every node
  that does NOT ride (a wire stretched to a brick or a still strip, a still wire, a bus
  band or handle) is held in place by the inverse `transform` (2026-10-27). Paint order
  and every group are untouched, so the drop is one render with nothing to move back. A
  transform per riding group, rewritten a frame, restyled and repainted the whole svg —
  busy64's kit drag (3493 riding, 5 stretched): pointermove p50 28–31 → 17–22 ms, p95
  122–137 → 71–77 ms; Select All 26 → 18 / 120 → 71–76 ms; solo chip and wire drags
  unchanged. A minority still takes a transform per group. Strips come from a per-render
  index (`#frameBoards`), not `getBoard`'s linear search. **Both shortcuts rely on a
  gesture's sets staying FROZEN**: the moving strips/bricks (`overrides`), the riders
  (`setPartDrag`'s `shifts`) and the carried bends (`pointRide`, a rider the plan takes
  whole trading into the riders, never lost) are read at the press and lose no wire until
  the drag ends in a rest render — a wire dropped mid-drag would be kept as last frame drew
  it. `wire-layer.test.js` spies a real part, brick and kit drag to hold the controller to
  that (2026-10-27).
- **A group drag carrying strips moves them by ONE transform per layer** (`#beginCarry` /
  `#endCarry` in the controller, review 2026-10-26). At the drag's first move the strips
  and the passengers that simply translate go into a `desk-drag-carry` wrapper in their
  layer — or, when most of the layer rides, everything ELSE goes into a still sibling
  (`desk-drag-still`) and the layer itself is transformed; every element's place is
  recorded and given back at the drop (and on any cancel). A passenger whose drawing
  depends on what is not moving (a lead reaching a still strip) and every member are still
  placed per frame. The signal flags and Output/Input/Data tags PLANTED on a moving strip
  are previewed by the same delta (`stripFlags`, read at the press; 2026-10-27) — their
  addresses ride for free, but they used to stand still mid-drag and jump at the drop.
- **The drag cursor is ONE overlay** (2026-10-27): `.desk-viewport--dragging::after` /
  `--wire-dragging::after`, a pseudo-element over the whole viewport with `cursor:
  grabbing`. Never `cursor` on the viewport and `*` again: `cursor` inherits, so that
  restyled every desk element on the press and on the drop (busy64 61 → 0.1 ms per toggle;
  a board press 120 → 40 ms, a refused board drop 160 → 70 ms in the app). The overlay
  costs a drag nothing — every desk drag holds the capture, hears its release on `window`
  and resolves by coordinates (`tests/drag-cursor-css.test.js`). A drop handler reads the
  release point (`releaseWorld`) BEFORE its teardown writes to the DOM, or the viewport's
  rect forces a whole-desk layout. **So are Space's open hand, a pan's closed hand and the
  band's crosshair** (`--pan-ready` / `--panning` / `--selecting` `::after`, 2026-10-27);
  under `--pan-ready` the chrome (zoom cluster, padlock, signal rail, lamps) is lifted
  above the overlay so it keeps its clicks — and now shows its own cursor, where `*` forced
  the hand on it. **Pin mode** names only the desk elements with a cursor of their own
  (flags, tags, wire/bus hits, annotations, meter probes and panel, the rails' chips) —
  the viewport's arrow is already pin mode's. **The TOOL modes** (`--placing`, `--wiring`,
  `--cutting`, `--bus`, `--probing`, and `--running`'s arrow) cannot be overlays — their
  presses and hovers need their real targets — so the bare desk is a `::before` UNDER every
  layer and the item the pointer is over (board, part, wire, bus band/handle, the flags',
  tags' and probes' svgs, an annotation, each piece of chrome) takes the cursor by
  `:where(.x:is(.desk-viewport--tool .x):hover)`, zero specificity (2026-10-27; busy64 an
  arm + disarm 119–131 → 17–23 ms; the cost, accepted by Jason: ~0.6 ms a board crossing
  while a tool is armed). A new kind of layer item or chrome joins those lists
  (`drag-cursor-css.test.js` derives both — the chrome from a real boot of app.js, the
  item roots from a desk holding one of everything — and fails until every tool names
  exactly them: 9 item roots, 6 chrome children). An undo/redo that only MOVED strips keeps their views and their parts'
  (`#rebuildScene`: a strip's look is everything but its x/y) and re-places them.
- **A zoom RE-RASTERS once it settles** (`DeskView#scheduleReraster`, 2026-10-23).
  `.desk-surface`'s `will-change: transform` is what makes a pan or pinch cheap, but
  Chromium keeps a will-change layer's bitmap resolution through a scale change, so
  zoomed in the desk was the old pixels stretched — the pot's value, a TO-220's part
  number and pin letters read as a blurred image (the chips, in layers of their own,
  stayed sharp). `RERASTER_SETTLE_MS` (200) after the last scale change the inline
  `will-change` goes `auto` for ONE painted frame (a double animation frame — a single
  one runs before the frame that would paint it) and back; pans and a same-zoom
  `setCamera` never trigger it (`tests/desk-view-raster.test.js`). Never remove the
  toggle, and never drop the hint itself — without it every pan frame repaints the desk.
  Verified by eye in the app at 228/400 % on both views; the cause by toggling the hint
  from DevTools.
- **Below `SMALL_PRINT_ZOOM` (0.5) the small print goes** (runtime review R7, 2026-10-26):
  `DeskView#apply` sets `desk-viewport--far` on its viewport when the zoom crosses it (both
  views — the schematic's DeskView too), and app.css hides `.layer-boards text`,
  `.layer-parts text` and `.schematic-svg text` under it. Every label there is ≤ 1.3 pitch,
  3–6 screen px at half scale; each zoom step re-laid-out all of them (busy32 ~1.8k); the
  rule reaches a group drag's `.desk-drag-still` box too, which holds a layer's still
  strips and parts outside it for the drag. A
  ctrl-wheel zoom from Fit: busy32 wheel→paint p50 36 → 11 ms, busy64 60 → 15 ms (layout
  ~120/220 → ~6 ms/s); the schematic busy32 97 → 9 ms. The meters' layer, annotations,
  flags, tags and bus labels are not small print. At 100 % nothing changes.
- An `<svg>` with width/height 0 renders NOTHING per spec — zero-size anchors need a
  token 1×1 box + `overflow: visible`.
- **The desk padlock locks an INPUT, not the camera** (`components/desk-lock.js` →
  `DeskView.setWheelLocked`, **⌘L**). Top-right of the viewport, transparent background
  (it sits on the desk, not in a card). Shut, the wheel stops reaching the camera;
  Space-drag and middle-drag pan, the zoom cluster, the keyboard and Fit all still work — it exists for a
  **Magic Mouse**, whose surface reports a scroll from a resting finger. `#onWheel` calls
  `preventDefault` BEFORE the lock check (a locked desk must not fall through to page
  zoom). The icon changes SHAPE (open vs shut shackle), its label says what a CLICK
  would do (with its accelerator), `aria-pressed` says what it IS, and ⌘L goes through
  the padlock's own `toggle()` so key and button can never disagree.
- **The padlock is saved in the PROJECT file** (`wheelLocked`, project-level, written only
  while shut, so a file that never shut it keeps its old bytes). One flag per project, not
  per desktop — a tab switch never moves it. A toggle goes padlock `onChange` →
  `ProjectWorkspace.setWheelLocked` and is an ordinary unsaved change (•, auto-save
  stash, leave guard); a load goes the other way, `#adopt` → `onWheelLock` → app.js's
  `applyWheelLock` → `DeskLock.setLocked` (the silent mirror, so a load is never read
  as a click). The ONE place it does not count is `#isPristine`: a blank untitled project
  whose only change is the padlock is still let go without a question.
- **Fit (⌘F) is the one camera action that EDITS the document**, deliberately.
  `#recentreDesk` slides the whole desk onto the origin (`DeskDoc.translateAll`: every
  board, brick and label by one delta — a whole pitch across, the 0.01 grid down, all of
  it quantized so a brick keeps its place through a reload; seated parts and wires are
  addresses, so they ride their board) before framing, so a long session cannot creep out
  into the coordinate space. The move is RIGID (it can neither be refused nor break a mating),
  rides `#emitDocChanged` as one undo step, marks the project dirty, and is skipped while
  the sim runs. Fit follows the ACTIVE view (`fitActiveView`); the schematic's own `fit()`
  is camera-only.
- **The same move happens on every LOAD, and there it is nobody's edit**
  (`DeskController.fitLoadedDesk` ← `frameLoadedView` ← `ProjectWorkspace#frameLoaded`).
  A project that opens (boot, Open…, Open Recent, New) and a new example desktop are
  centred and framed before they are looked at, but the move is NOT recorded
  (`#restoring`), the history's present entry is re-baselined to the centred document,
  and `#markClean` follows — putting a design where it can be seen must never earn a •,
  or a save-or-discard question about a project nobody has touched. A tab SWITCH
  deliberately does neither: that desk's camera and state are the user's.

## Schematic view

The derived logical schematic (`components/schematic-view.js` +
`model/schematic-layout.js` + `catalog/symbols.js`) flips in via **Tab** alongside the
breadboard, drawing chip symbols + routed named nets + bus lines from the same `DeskDoc`.
It keeps its own `DeskView` and its own wheel (there is no padlock over there, and so no
invisible lock either), shares the desk's camera / probe / live sim tint, and persists
only a per-symbol **`schematicPos`** layout nudge — **never a second source of truth**.
Its own `fit()` is camera-only, since its symbol positions are derived and there is
nothing to move. **Hidden, it does not paint the live tint**: every tick publishes, and
tinting the whole diagram cost a tenth of a busy desk's main thread while nobody could
see it — `#applySim` only remembers the levels, and `setVisible(true)` paints them.
**Shown and running it writes only what changed** (runtime review R5, 2026-10-26):
`applyLevels`/`applyStatus`/`applyHighlight` read the diagram ONCE per built svg into an
index (`overlayIndex`, a WeakMap — a render builds a new svg) and touch an element only
when its level, lit or status changes. And `.schematic-svg` sets `text-rendering:
geometricPrecision`: with the default (hinted, size-snapped) text every repaint of a running
diagram RE-LAYERIZED the whole picture (busy16 ×4: layerize 300 → 28 ms/s, main thread
42 → 13 % busy, frames > 16.7 ms 5–10 → 0 in 3 s; screenshots at 100 % and 231 % identical).
Never put `will-change` on its groups — measured, it doubles the layerize.

## Selection

**One press rule for every object** (the selection & drag model, Jason's brief of
2026-10-13, landed 2026-10-14; `DeskController#press`, the selection in
`components/desk-selection.js`, the pure chord in `model/selection-toggle.js`). The whole
model is one idea: **a click is a drag that didn't travel**. Press an object and you have
picked it up; let go where you pressed and it is set back down on its own hole — a no-op
move whose one lasting effect is that the object is now the selection. There is no
"select click" to tell apart from a "drag click", only whether the pointer travelled past
the ~4 px threshold. Every press on the desk while editing goes through `#press`: boards
and parts call it from their own pointerdown (and stop the event when it claims), and the
viewport calls it for the wires, buses and the bare desk (`#hitFromTarget`; `undefined`
for the viewport's own chrome, which is left alone).

- **Four jobs, one combination** (Shift is no chord of its own — it only makes a part drag
  BARE; see "Moving parts and clusters"):
  - **Plain, on the BACKGROUND** — the bare desk, or the bare holes of a strip that is
    NOT selected — starts the rubber band (`#beginMarquee`; the band only appears after the
    threshold). A click on bare desk clears the selection; **a click on a strip's holes
    selects the WHOLE BOARD** — `selectBoard`, the single board pick that stands for the
    strip's whole snapped group, its parts riding as passengers (Jason, 2026-10-14). Only
    the DRAG from an unselected strip is a band; the click is the board.
  - **Plain, on an object** selects just it and the press is its drag. A wire's END CAP and
    a routed wire's bend knob sit on holes and are no pointer target, so a press there lands
    on the board beneath — `#press` asks `wireIdNear` / `wirePointNear` first: **the body on
    top wins** over the board under it. A two-terminal part pressed anywhere — on a leg too —
    is its BODY. A ROUTED wire pressed anywhere — run or knob — is a one-wire GROUP drag
    (`#isRoutedWire` → `#beginGroupDrag`; Jason, 2026-10-20): ends and bends move by the
    one delta, the ends seating as a selected wire's do, and a plain press never lays or
    moves a bend (that is Option/Alt's, below). A bus member's lead only selects.
  - **⌘/Ctrl-click** toggles the object pressed (body-wins priority, so it is not a way to
    pick one leg). On bare desk it changes nothing — a miss is not a request to clear. A
    board toggles its WHOLE snapped group; a bus its member wires.
  - **Option/Alt is PIN-TARGETING mode**, never additive. app.js pushes the key in
    (`setPinMode`, keydown/keyup/blur — and the pointermove's own `altKey` mends a missed
    key): `desk-viewport--pin-mode` makes every body inert (default cursor), and the one
    hole under the pointer holding an **independently movable lead** — a wire end, a leg
    of a `rotatable` two-terminal part, or a leg of a TO-92 (`#leadEnds`; parts.md → free
    legs) — gets the shared ring in RED (`hole-ring--pin`; the
    selection colour is the picked state). A fixed pin of a rigid package is never a target
    (it cannot move apart from its chip), nor is a bus member's cap on its own bus's handle
    (`WireTools.endGrabbable`). `#pinTargetAt` picks the nearest within
    `WIRE_END_GRAB_RADIUS`. A press on a target REPLACES the selection with that lead alone
    (`{kind: "lead", id, end: "a"|"b"}` / `{kind: "wire-end", id, end}`, ringed in the
    selection colour by DeskSelection's `hole-ring--selected` HoleRings, re-aimed after every
    edit) and is that lead's drag — the existing resistor-end / wire-end gestures. A press on
    nothing lightable — and no ROUTED wire's bend: short of a lead, a press on a
    routed wire's waypoint moves it and one along its run (within 0.6, a shade
    past the `.wire-hit` half-width) inserts one there, the wire replacing the selection
    (`WireTools.bendTargetAt`/`beginBend`, ringed red on hover like a lead;
    Jason, 2026-10-20 — the ONLY way to bend a routed wire) — PANS the desk (Jason, 2026-10-14: `#altPan` hands the press to
    `DeskView.beginPan` — a drag past the threshold pans, a click does nothing, the
    selection is untouched; running too, where the parts and the viewport hand it over
    before refusing the selection; not with ⌘/Ctrl, whose miss stays a no-op); labels,
    flags and tags let an Alt press through (to that pan).
    Delete on a picked lead removes what it belongs to.
  - **Option/Alt + ⌘/Ctrl-click ADDS a lead to the set** (Jason, 2026-10-14) — the one
    combination, `isLeadToggleEvent`; a solo Option/Alt press still REPLACES the set. The
    target is `#pinTargetAt`'s; the press toggles it in or out (`#toggleLeadAt`), moves
    nothing, and on nothing lightable changes nothing. The selection's FOURTH set,
    `leads`, holds `leadKey` strings (`wire-end:w3:to`, `lead:c2:a` — `selection-toggle.js`
    owns the key and the toggle; one lead left collapses to the single lead pick,
    `singlePick`). A lead is COVERED by its owner — its wire or part selected in its own
    right, or a passenger of a selected board — and is never in the set too: the chord on
    one is a no-op, and `setMulti` drops a lead whose owner joins. It mixes freely with
    parts, wires and boards. A band REPLACES it (a band never takes a lead).
    - **Its rings are members.** With more than one thing selected, a PLAIN press within
      `WIRE_END_GRAB_RADIUS` of a picked lead's ring (`#selectedLeadNear`) drags the whole
      selection by that lead — it is checked BEFORE the body-on-top rule, since the ring is
      what the user is aiming at — and a click there collapses to that lead.
    - **In a group drag a picked lead is a RIDER of the delta itself**
      (`cluster-move.js` `mergeLeadRiders` + `leadShift`, the pseudo-members
      `LEAD_WIRE_END`/`LEAD_LEG` handed to `planClusterRiders` as `presetShifts`). So the
      riders' machinery does the rest: a wire with one end picked STRETCHES, one whose other
      end rides a member (or is picked too) travels whole; a part with one leg picked BENDS
      and with both translates (`planRidingLead`); a routed wire's bends move only when both
      ends agree; and the one batch check sees every hole. A picked end that would also
      ride a member follows the PICK. One plugged into something moving by itself (a moving
      strip, a moving brick) keeps its address; one landing ON something moving is refused.
      A Shift (bare) drag still carries the picked leads — they were selected.
    - Delete takes a picked lead's owner, as for the single pick. The rings stand down
      while a drag carries them and come back where they landed.
- **A press on a member of a MULTI-object selection drags the whole selection** (`#inGroup`
  — more than one thing selected, or any board, and the pressed thing selected in its own
  right; a selected strip is grabbed by its bare holes); a click there COLLAPSES the
  selection to what was pressed (`#collapseTo`; a switch under the finger still flips, a
  strip keeps its group's selected strips and becomes the single board pick when that is
  the whole group). A PASSENGER is not a member: pressing one is a plain press on that
  object, which then becomes the selection alone.
- **Enclosure decides membership.** The band takes only what it WHOLLY encloses
  (`part-geometry.js`): a part when every pin AND its drawn body are inside
  (`componentsInRect(…, partBodyBox)` — a brick by its own box), a wire when both ends and
  every bend are, a strip when its whole rect is. Graze selects nothing. A strip partly in
  the band is not taken, and the parts wholly inside it are taken individually (and lit).
- **THE PASSENGER INVARIANT.** A selected board carries everything seated on it: a part on
  it, and a wire whose ends are ALL in its holes, are passengers — they move and delete
  with it but are not selected in their own right, so they are NOT LIT. A lit part always
  means "selected in its own right". `setMulti` drops passengers from the part and wire
  sets the moment their board is in, by band or by chord; a chord on a passenger changes
  nothing (it is carried already); Select All selects the boards, the bricks and the wires
  between them, the rest riding. **No selection memory**: taking the board back out does
  not restore the parts it absorbed.
- **Undo steps through selection changes** — "I didn't mean that" is ⌘Z, not hidden
  state. `HistoryStore` entries carry the selection (`serialize()`/`restore()`), and a
  change of selection ALONE is an entry of its own (`recordSelection`) sharing the
  present's snapshot and its **version**; `#step` restores the document only when the
  version moved, so a selection step touches nothing else (no rebuild, no doc-changed, no
  dirty marker — dirty is signature-based anyway). `#recordSelection` is called at the
  USER's selection gestures only — a click, a band, a chord, an Alt pick, a collapse,
  Escape, Select All — and skips a no-change; selections made on the way to an edit ride
  that edit's own entry (`#emitDocChanged` passes `selection`). `sync`/`syncForward`
  reach every entry sharing the present's version. A selection step drops the redo future
  like any step (accepted).
- **Delete takes the whole selection at once, no questions** (`removeSelectedComponents`
  over `movingSets()`): parts, wires and boards together, a board taking its passengers,
  and a wire left with an end on nothing (a deleted board's hole, a deleted brick's
  terminal) going too — the model's cascades. A wire whose ends are still in holes stays.
  The context menus' own Delete items keep their confirmations.
- **⌘ on macOS, Ctrl everywhere else.** **Ctrl cannot be it on a Mac** — there Ctrl-click
  IS the system's secondary click, so admitting it means the press arriving as button 2
  and raising a `contextmenu` the desk then has to SWALLOW. Only the PRIMARY button counts.
  Option/Alt is excluded from the chord (pin mode owns the press); Shift neither makes nor
  unmakes it (it only makes a drag bare). The predicate is pure because the app only ever runs one side of its
  platform branch.
- **One part or wire collapses to the ordinary single pick** (`singlePick`) — a one-item
  multi-selection would quietly do none of what a single pick does (R, Properties…). A
  lone BOARD stays in the set: a single board pick stands for its whole snapped group, and
  a strip a band picked out alone must not grow back into its kit.
- **A toggle is all-or-nothing over the ids it is given**, which lets a BOARD toggle its
  whole snapped group and a BUS toggle its member WIRES (the selection holds no bus of
  its own). Annotations, signals and tags are none of the sets, so the chord leaves the
  selection as it was over one.
- **While RUNNING** the selection is refused (band, chord, Alt) — but a click on a wire
  still highlights it (WireLayer's click callback, running only), and a press on a wire or
  bus band over a click-toggling part goes THROUGH to it (`#togglePartUnder`,
  `#pressWentThrough`).

## Moving parts and clusters

**A part drag takes its wiring with it** (`model/part-move.js`, Feature 290 — behind
Option until the selection & drag model of 2026-10-14 made it the DEFAULT, and gave Option
to pin-targeting). Re-seating the part alone would be a **silent rewiring** on a WIRED
part: rows e/f are free in the new columns so `canPlacePart` has no reason to refuse,
every wire stays in the hole it was laid in, and the wire that fed pin 1 now feeds pin 3.
So a wire whose ends are both on what moves moves rigidly, and one with an end left behind
STRETCHES — the moving end follows to its new hole, the other stays, and connectivity is
never silently broken. One lead alone is an Option/Alt press (see "Selection").

- **SHIFT-drag moves BARE** (Jason, 2026-10-14) — the deliberate rewiring the rule above
  exists to prevent by default. Held at the PRESS (read there and frozen, like every
  riding set), it empties the riders of all three part drags — solo footprint, a
  two-terminal part's body, the whole selection (`#ridersOf`, the one place they are
  read) — so the selected parts move and every wire end and leg in their nodes STAYS in its
  hole. Nothing new is needed for legality: with no riders a solo drag is the plain
  re-seat of a part with nothing attached, and the cluster's `prepareClusterMove` lifts out
  only the members, so the stationary wiring is ordinary occupancy and a pin landing on one
  of its holes is refused like any taken hole. What is INTRINSIC still travels, because it
  is not riding: a selected wire (selected in its own right), a selected board's
  passengers, a wire on a moving brick's terminal (its address names the brick), the
  anchored labels. A Shift CLICK is a plain click; a Shift press on the background still
  bands; Shift+⌘ is still the toggle. No live preview of the connections being broken —
  the wires simply don't follow.

- **Riding is a NODE rule**: a wire end rides when its hole is in a node (one 5-hole
  column-half, `nodeOf`) that one of the part's pins occupies, keyed per BOARD. For a DIP
  that equals "any column it spans", but not for a footprint that SKIPS columns — a push
  button at `a5` owns `c5L` and `c7L` and has nothing to do with `c6L`. GRID nodes only:
  a rail is one node for its whole length, so counting it would pick up the board's
  entire power distribution.
- **The set is read at pointerdown and FROZEN**, as the group drag freezes the bends over
  its boards. Recomputed per sample it would grow and shrink as the part slid
  over other wires' holes, so the drop would depend on the path taken to it.
- **Pin holes and riding holes are disjoint by construction**, which is why the two
  legality checks compose instead of interfering: a riding end is in a NON-pin row at its
  column offset (the pin's own hole is taken — one hole, one lead), and a rigid column
  shift preserves each hole's row while the footprint's pin rows at a given offset are
  fixed. So no rider can land on a hole this part's pins want, at any offset, including a
  move onto overlapping columns. `canPlacePart(…, {ignoreId})` stays as it is and
  `prepareWireBatchMove` needs no notion of the moving part; `part-move.test.js` sweeps
  the invariant rather than a comment asserting it.
- **`DeskDoc.prepareWireBatchMove` is the whole legality story**, hoisted ONCE per
  gesture: it lifts every mover out, so riders may shuffle among the holes they
  collectively vacate (a two-column shift), where a per-wire `isFreeHole` would have been
  wrong. `#resolvePartSeat` folds its verdict into the SAME `d.legal` the part's own tint
  reads — one refusal, one visual language, preview and drop derived by one function.
- **`resolved:false` refuses rather than inventing a hole**, stated generally (every
  landing address must be in a node the part occupies AFTER the move) rather than as a
  list of ways to fail, so anything the footprint vocabulary grows is caught by
  construction. **`holeAlongTo(fromType, toType, …)`** names the destination separately,
  because a part carried onto a NARROWER strip has riders whose ORIGIN column may not
  exist there (`a52` full → `a5` half); all column arithmetic stays in `breadboard.js`.
- **Bus members ride and the ribbon follows for nothing** — `WireLayer#wireEnds` is
  shared by the wire loop AND `#busGeometry`, so body moves with leads. `setPartDrag` is
  the layer's one MANY-wire preview channel, and its ends are ADDRESSES rather than
  cursor points, so the preview resolves through the path the committed wire will.
- **A routed rider translates its waypoints only when BOTH ends ride** (with one end
  pinned the user's bend still belongs where they put it). The same holds for a group
  drag's strips and bricks (review 2026-10-26): a wire whose two ends are both plugged
  into what moves carries EVERY bend, the ones in the gaps between boards included
  (`wirePointsOverBoards`' `owners`); only a wire stretched off the moving set is judged
  per point. A selected wire moves all its bends with it, and the carried set — frozen at
  the press, less the selected wires and the riders' planned ones — is the one the drop
  hands `moveBoardsBy` (`carried`), so no bend is shifted twice and the drop is the
  preview. An end plugged into a moving strip counts as riding by the strip's shift
  (`ridePointShift`'s `boardShift`, 2026-10-27), so a wire from a moving strip into a
  selected chip's node is carried whole when the two go the same way. **Net names stay put** — the
  name follows the HOLE, not the signal; no other move gesture re-binds one, and a
  re-seat is not a rename.
- **ONE mutation, ONE undo step, and ONE rule for both gestures**: a solo wired drag IS
  a one-member cluster, so `moveComponentWithWires` is `moveClusterWithWires` with the
  dragged part at the head of the placements, checked by the same `prepareClusterMove`
  predicate (which is what lets a riding LEAD, whose params change, be checked and
  committed at all).
- **A two-terminal part's LEAD rides too** (`leadsRiding` / `planRidingLead`). A resistor
  with one leg in a moving pin's column-half is connected to it exactly as a jumper in
  the next hole along is. Riding by ONE leg is a **BEND** — the other leg stays, and the
  part is rewritten into the two-free-ends form, because only that form can express one
  (a rot-0 LED therefore stands up, exactly as dragging one of its legs by hand makes
  it); riding by BOTH is a rigid translation keeping whichever form it is stored in. Only
  a `rotatable` part qualifies — it is the only kind whose leads move independently.
  **The rule closes at ONE hop**, which is why nothing recurses: a riding lead lands in
  the node its pin lands in and every other rider there travels with it, while a lead
  that stays put leaves its own node untouched. A transitive closure would pick up the
  whole circuit from one nudge. A bend the body cannot physically make is the BATCH's
  refusal (`canPlacePart`'s `minSpan`), not the plan's. A lead that ALREADY floats (its
  rail moved or deleted from under it) is no refusal: `prepareClusterMove` hands
  `canPlacePart` the pins floating now (`floating`), and such a lead stays where it is,
  still in mid-air — a state the part was in, not one the move puts it into (2026-10-14;
  before, a resistor with one floating lead pinned every chip it touched in place).
- **A leg plugged into a strip moving in the same drag keeps its address** (review
  2026-10-26): `planRidingLead`'s `boardShift` measures the bend against where that strip
  WILL be (a picked leg, or the far leg of a part riding a member by one), and
  `prepareClusterMove`'s checker judges every placement among the moved strips
  (`boardsAfterShift`); `canMoveBoardsBy`'s `movers` leaves the batch's own parts — their
  leads AND their claims — to that check. Measured against the strip's old position, the
  leg floated after the drop. The checker also re-lands a STAYING part's bent lead in a
  moving strip (`relandedIndex`, 2026-10-27): its index held that lead at the hole it was
  leaving, so a mover landing where it was GOING previewed green and the commit refused.
- **A planted FLAG rides too** — a signal flag or an Output/Input/Data tag in a moving
  pin's column-half (`flagsRiding` / `planRidingFlags` in `part-move.js`; review
  2026-10-26). It is one lead in that node, and leaving it behind cut the stimulus off the
  pin while the wires beside it rode. It keeps its row and offset exactly as a wire end
  does, is lifted out and claimed in the same batch (`prepareClusterMove`'s `flags` and
  the checker's fourth argument), previews through `SignalLayer`/`IntegrationLayer`
  `setPreview`, and a flag with nowhere to land refuses the drop. A Shift drag leaves
  flags with the wiring.
- **A drag keeps the grab point under the finger, at ANY grab column** — `partSeatAt`'s
  `grabOffsetCols` is `null` for the placement ghost (centre on the cursor) and a NUMBER
  for a drag, 0 included. Overloaded as 0 = ghost, a chip held at its pin 1's own column
  jumped half its length left on the first move (2026-10-14).
- **Labels anchored to a part ride its PINS' MIDDLE** (`#carryAnchoredLabels`): the
  anchor's travel for a rigid move (a chip, a group — the same delta), half a lead's
  travel when one lead is dragged alone, nothing when a can spins about its centre or a
  bent TO-92 turns end for end (pin 1 moves; the part does not). The two-lead body drag
  previews the labels by the same middle, so preview and drop agree.
- **A rider crosses the trench with its pin, keeping the arrangement** (`holeAcross` +
  `rowsBetween`): the rider's OWN row is tried first and, only if that no longer reaches
  the pin's node, the row the PIN's own row delta puts it in — so a wire two holes from a
  part is still two holes from it afterwards, on the same side. Two candidates, not a
  search, and staying put wins whenever it works (every within-half move is bit-for-bit
  what it was). Without the second candidate a rider was stranded in the half its pin had
  just left and the plan could only refuse — which read as "there is no room over there"
  when there was plenty. Rows are counted as HOLES, not distance (`e` + 1 is `f`,
  straight across a gap three pitches wide). It is one RIGID row shift of pins and riders
  together, so the disjointness invariant survives it — a MIRROR (`a`↔`j`) would not, and
  would swap which side of the part each rider came out on. Running the wiring off the
  end of the board refuses, which is honest: dropping a row nearer the trench fits, and
  that is what the red is saying.
- **A rider follows the PIN whose node it sits in, not the part's anchor**
  (`partRideShift`, which `planPartMove` is stated in terms of). For a footprint part the
  two are the same; they part company for a rotatable part, whose pins can be on
  different strips and whose pin 1 may be on a RAIL (which owns no node at all). Per pin
  is a strict superset, so nothing about a chip's drag changed, across-the-trench refusal
  included.
- **`moves` names EVERY riding wire, always**, including one that does not actually move
  (a discrete slid along its own column-half stays in the same node). The no-op entry is
  what tells a batch check the hole is still SPOKEN FOR, which the cluster drag depends
  on, and it leaves every caller one convention instead of two. `points` takes its shift
  from the END delta rather than the anchor's, because a rider keeps its ROW and shifts by
  a COLUMN (`a5 → c7` moves riders (2, 0) while the anchor moves (2, 2)).
- **A rotatable part's BODY drag carries its wiring; its END drag does not.** A body drag
  (`drag-resistor`) moves both leads by ONE delta, so the ride rule applies unchanged, and
  the plan is told the FORM the part is landing in (`planPartMove`'s `params`), since a
  body drag rewrites a footprint-form part into the two-free-ends one. An END drag
  (`drag-resistor-end`, an Option/Alt press on the leg) carries nothing: the lead lands
  at any hole, angle and strip, so there is no column delta to follow — it is a re-bend,
  not a move. A plain press anywhere on the part — on a leg, and on a rot-0 LED that is
  all legs — is the BODY drag (which used to be unreachable on that LED: its one pitch
  sat inside both `WIRE_END_GRAB_RADIUS` circles).
  **Pin 1 is looked up twice**: the RAW translated point first (where the part actually
  is, and what the placement GHOST has always used), the rounded one as fallback. Rounding
  assumes a lattice and there is one only horizontally, so a spanned run's 17.52 leaves a
  rounded `dy` **0.48** off — past `HOLE_HIT_RADIUS` 0.45 — and the part could not be
  dropped on the board below AT ALL. On one board the two always name the same hole
  whenever either does, and the part is drawn from the hole it FOUND.
- **A rider with nowhere to land draws from the DOCUMENT, in red** — so the plan is
  re-derived on EVERY sample, including ones that resolve to nothing. A FOOTPRINT drag
  stops at its last good seat (a stale plan still describes the screen), but a ROTATABLE
  part is drawn at the RAW CURSOR whatever the position, so it walks away from a plan that
  stopped being re-derived — over the gap between two dovetailed boards the riders sat at
  a hole the part had long since left and jumped when it found ground again. The document
  position says the true thing instead: nothing is moving, and the red says it will not be
  dropped here.
- **Out of scope by construction**: a PSU/clock brick needs nothing — its wires end at a
  terminal address that already rides it.

**The WHOLE selection drags as one unit** (`model/cluster-move.js` +
`DeskDoc.prepareClusterMove` / `moveClusterWithWires` + the controller's `drag-cluster` —
`#beginGroupDrag` / `#resolveGroupMove` / `#commitGroupMove`, Feature 340 widened by the
selection & drag model). Grab any member and everything travels by ONE delta: the selected
BOARDS with their passengers, the independently selected parts with everything riding ANY
of them — the wires, and the LEADS of the two-terminal parts plugged into them (a resistor
bridging two members travels whole, one bridging a member and a fixed part bends) — and
the selected wires. A board in the selection no longer refuses the press.

- **One snap vector, from the grab.** A grabbed part's own resolver decides it (below); a
  grabbed board (or a passenger-free press on a selected strip's holes) the board lattice
  — rounded travel plus the magnetic `#pullToMate`; a grabbed wire (or bus) its END
  nearest the press, snapped to the hole it lands on (raw travel first). The boards take
  the same delta (`#groupBoardShift`: whole pitches across, the 0.01 grid down — refused if
  the delta is off that lattice).
- **Wires follow their ends.** A selected wire moves RIGIDLY (`#groupWireMoves`: an end in
  a moving board's hole or on a moving brick's terminal keeps its address, every other end
  is translated to the point it lands on); a rider follows its member's node; a wire with an
  end on a moving board and the other left behind STRETCHES for free (addresses ride their
  board). That last case is how a strip is UNSNAPPED: band the strip and its parts but not
  the rail, drag, and every wire into the rail stretches across the new gap. A selected
  wire is never also a rider, and a two-terminal part seated on a moving board is that
  board's passenger, never a rider.
- **The drop is ATOMIC.** One `legal` for everything: every member and rider seats (the
  holes the movers vacate count as open — `prepareClusterMove` lifts them all out), every
  moved or stretched wire end lands on a real free point, no part lands on a strip that is
  itself moving (`ontoMoving`), and `canMoveBoardsBy` accepts the strips. Any failure
  reverts the whole selection. The commit is `moveClusterWithWires` then `moveBoardsBy` +
  `#mateStrips` + the anchored labels (members' and passengers') inside one snapshot
  (restored if anything throws) — ONE doc-changed, ONE undo step ("move selection").
  The drop REUSES the last legal move's landing; only a refused last move falls back to
  the release point.

- **The delta is the grabbed member's own**, resolved by the same three resolvers a solo
  drag uses (`partSeatAt` for a footprint, snap-pin-1-to-a-hole for a lead, whole units
  for a brick), so the thing under the finger behaves exactly as it would alone — clamp at
  the end of a strip included. Rounding the POINTER's travel instead cannot express the
  move that matters most (a dovetailed stack puts the board below at 17.52 pitch, so an
  integer delta could never carry a selection from one board to the next). A member on a
  board at some OTHER offset lands between holes and the drop reddens, which is honest —
  two strips at different offsets share no lattice.
- **A brick grab has no lattice of its own, so it borrows a seated member's.** A PSU's
  resolver answers in whole units — right for the brick, wrong for everyone behind it,
  since 21.02 is not whole (grabbing the brick of a selection spanning a dovetailed stack
  rounded the delta to 21 and put every seated member a fifth of a pitch off its holes).
  The brick branch offers the RAW vector to the first seated member and reports whatever
  hole THAT member lands in, so the brick still moves in whole units and the parts land
  square. A selection of nothing but bricks keeps the raw vector; one whose seated member
  lands nowhere refuses. **Both snapping branches try the raw travel before the rounded
  one**, for the same reason the solo body drag does.
- **A claim set is the all-or-nothing authority, not the rigid-translation proof.**
  `paste-cluster.js`'s argument (a rigid integer translation needs no member-vs-member
  check) does NOT carry here, because riders keep their ROW and shift by a COLUMN, so
  "parts + riders" is not a rigid body: a pure row move slides the pins two rows and the
  riders not at all, and a pin can land on a stationary rider's hole. ONE shared `claimed`
  set over every landing address — each moving pin, both ends of each wire move — catches
  that, mover-vs-mover and pin-vs-a-rider's-far-end, with no proof obligation at all. What
  survives of the paste-cluster argument is brick-vs-brick rects, which a claim set cannot
  express and which are checked as rects.
- **Two documents, deliberately.** `prepareClusterMove` builds occupancy from the doc as
  if every mover — components AND wires — were gone, since a member landing in a hole a
  travelling companion is vacating is the ordinary case (which is exactly why
  `prepareWireBatchMove`, which lifts out only wires, could not be reused). But REALNESS
  is asked of the FULL component list: `isRealPoint` resolves `psu1.+` through the
  components, and a PSU does not stop existing because it is in the air. It is hoisted
  once per gesture (`canPlacePart` rebuilds the whole occupancy index per call, which for
  N members would be N rebuilds a frame) — hence the `occupancy` option. A placement may
  also bring its own **`params`**, which is how a bending lead is judged: the check must
  see the part as it will BE, not as it is.
- **A paste shares ONE occupancy index** (review 2026-10-26): `pasteDesign` builds it once
  and `addComponent`/`addWire` check against it and claim into it as each item lands
  (`#batchOcc`), instead of rebuilding it from the whole desk per item — a busy64 paste
  went from 68.6 s to tens of milliseconds, the result byte-identical. Gestures likewise
  build one index at the press for the checks they repeat every move
  (`DeskDoc.occupancyIndex`, the `occupancy` option of `canPlacePart` / `canReendWire` /
  `canMoveWire`), and the bus tool one per move (`freeHoles`).
- **A bus that loses its LAST member wire goes with it** (`#pruneBusesToWires`, review
  2026-10-26) — deleting a selected bus, all its wires or its board used to leave an empty
  record the analyzer still offered. A bus loaded or made empty stays.
- **The commit validates the whole batch, then writes.** `moveComponent`, `moveBrick` and
  `moveWiresBatch` each re-check against the LIVE document, so replaying them member by
  member throws the moment two members swap holes, and `moveWiresBatch`'s wires-only
  reduction would refuse a rider heading for a hole a part is vacating.
  `moveClusterWithWires` runs the SAME prepared predicate over the whole batch and then
  writes the fields, inside the `pasteDesign` snapshot/restore — ONE mutation, ONE undo
  step.
- **The collapse is at the RELEASE.** A press on a member cannot select it (a single pick
  replaces a set), so a sub-threshold CLICK does it instead (`#collapseTo`), and a
  click-toggling part still flips under the finger.
- **A cluster keeps a rotatable member's stored form** (a bend is measured FROM the
  anchor, so a rigid translation needs no rewrite) — deliberately different from the solo
  body drag, and the better behaviour. A part riding by ONE leg is the one case that does
  rewrite the form, because it BENDS.
- The wire layer needed no schema change: `setPartDrag`'s `shifts` map is keyed by WIRE,
  so N members' riders and the selected wires merge into one map; its `overrides` carry
  the moving bricks AND the moving boards (one map, distinct ids), and its third argument
  the routed bends riding those boards (`#pointRide`). `AnnotationLayer.render`'s shift became an `anchorIds` SET, the shape
  `#shiftAnchoredAnnotations` already committed with.

## The wire gauge & the BOM cutting list

**A wire's Properties dialog ends with the WIRE** (`components/wire-gauge.js`). The jumper
is drawn across the full width of the card in its own colour, its sleeve stripped back at
both ends to bare tinned lead (`--color-chip-leg`, the token the chips' legs use — same
material), with an arrowheaded dimension line under it stating the length in centimetres.
It answers the one question the desk cannot: WHICH LEAD OUT OF THE DRAWER IS THIS — on the
desk a wire is a curve between two holes at whatever zoom the camera is at.

- **The RUN comes from the desk; the WIRE is the run plus two strips** (`wireTotalMm`). A
  lead has to reach INTO both holes, so a jumper crossing one 2.54 mm pitch is
  2.54 + 2 × `STRIP_MM` ≈ **13 mm**, not 3. The caller hands over the RUN (`runMm`) and the
  drawing adds the strips itself, so the SLEEVE covers exactly the run, the bare tips are
  the strips, and the dimension spans the lot — the length you cut.
- **ONE measurement, in `model/wire-length.js`** — pure, DOM-free, over a plain document,
  because two things state a wire's length (this drawing and the BOM) and a second
  implementation could disagree with the picture on the desk. It answers `wireRunMm` (hole
  to hole) and `wireCutMm` (`= wireTotalMm(run)`), and owns `STRIP_MM` and the ONE length
  FORMAT (`wireLengthLabel`, cm to a tenth, locale-formatted via `tf` so it reads under
  `node --test`). The run is the DRAWN shape, never the chord: the sagging curve's ARC
  length for a direct wire, the polyline for a routed one, and for a BUS MEMBER its lead +
  the whole ribbon + its far lead (a conductor in a ribbon is as long as the cable however
  short the ends sticking out are). That is why a `model/` module reaches into `desk/` (the
  sag constants are px-space, hence `PX_PER_UNIT` → `pxToMm` → `MM_PER_UNIT`, the one place
  the desk's units meet real measure) and why `ribbonWidth` moved into
  `desk/ribbon-path.js`. Live drags are ignored on purpose: a wire is measured as the
  DOCUMENT has it.
- **To scale, within reason.** The drawing is a fixed width whatever the wire measures, so
  the one thing it can be honest about is the RATIO: each `STRIP_MM` is drawn as its share
  of the whole. Two clamps — a bare end never falls below `MIN_BARE` (a tip too small to
  see defeats the reason for drawing one) and never exceeds `MAX_BARE_SHARE`, which is
  DERIVED from the shortest wire the app can hold (`STRIP_MM / wireTotalMm(MM_PER_UNIT)`)
  so it can never bind on a real one. The dimension states the truth either way.
- The dialog repaints it on a colour pick through ONE custom property (`setWireGaugeColor`
  → `--wire-color`, the same property every wire on the desk carries), so the geometry is
  untouched. This is the only thing the dialog knows about the type.
- **The BOM's `wires` section is the same measurement as a NUMBERED CUTTING LIST**
  (`wireCuttingList`, the fifth and last `BOM_SECTION_KEYS` entry — you wire after you
  seat). One line per COLOUR and CUT LENGTH, tallied ("[3] Jumper wire (red, 6.1 cm) ×3" is
  three leads to cut the same, which is how you work through a drawer), sorted by the app's
  own colour order then shortest first, and NUMBERED in that order so an item number is
  stable against everything but a change to the desk. Being one catalog entry it reaches
  the panel AND the RTF export with no second list, and it needs no netlist — a BOM is a
  fact about the desk, not about connectivity.
- **The item number is a cross-reference, and it replaced a whole tab.** Every step that
  runs a wire calls its number out (`wireItemLabel` → `[3]`, the parts-drawing convention,
  so not translated): in the SENTENCE for a power wire (`plan.step.powerWire`, one wire per
  step) and LEADING each run line of a bus/net step (`wireRunLine`), where the callouts
  form a column you read down while cutting. The numbering is derived ONCE in `makeContext`
  (`ctx.wireBom` + `ctx.wireItem`) and handed to both the BOM and the steps — two
  derivations could disagree, and a cross-reference that disagrees is worse than none.
  **The build guide therefore has TWO tabs, BOM · Steps**: the third was *Wiring*, and a
  step that names its wire AND says where it goes is that list in the order you do it in.
  The RTF export dropped its Wiring section with it. `buildWiringList` itself stays — the
  single-member-net WARNING is derived from it.
- **A routed wire's bend drops as the last move SHOWED it** (`wire-tools.js` `#onPointUp`,
  `m.shown`; the regrade, 2026-10-23): merged onto a neighbour if the knob was shown pulled
  onto one, else at the point it was drawn — never re-resolved at the release (it was, via
  `releaseWorld`, and a release a hair either side of the merge reach did the opposite of
  what the preview showed).
