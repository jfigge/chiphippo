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
  running past it) → `.layer-overlay` (ghosts, hover rings, tooltips — pointer-inert).
- Boards and chips are ONE static inline SVG each; the tie-point/pin `<rect>`s carry **no
  id, no `data-*`, no listener** — all hole/pin interaction is `holeAt()` / derived-pin
  math from pointer coordinates. The sanctioned per-item event exceptions are all widened
  invisible hit targets where idiomatic SVG beats hand-rolled distance math: each wire's
  hit stroke (`pointer-events: stroke`, `wire-layer.js`, listeners on the `g.wire`
  group), each rotatable discrete's `.part-span-hit`, each push button's
  `.part-button-cap`, and each signal flag's `<polygon>` (eight arbitrary rotated
  pentagons is exactly the case that argument was written for).
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
- Pan/zoom must **never** rebuild or re-lay-out surface children (transform only); wires
  re-render only on doc changes or live drags (positions passed as overrides).
- An `<svg>` with width/height 0 renders NOTHING per spec — zero-size anchors need a
  token 1×1 box + `overflow: visible`.
- **The desk padlock locks an INPUT, not the camera** (`components/desk-lock.js` →
  `DeskView.setWheelLocked`, **⌘L**). Top-right of the viewport, transparent background
  (it sits on the desk, not in a card). Shut, the wheel stops reaching the camera;
  drag-to-pan, the zoom cluster, the keyboard and Fit all still work — it exists for a
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

## Selection

**The selection is built two ways, and the modifier is the difference**
(`model/selection-toggle.js`, pure). A **Shift-drag marquee** REPLACES the selection with
everything a box wholly encloses; a **⌘/Ctrl-click** ADDS one item or takes one out. Both
fill the same three sets (`#multi` / `#multiWires` / `#multiBoards`), so Delete, ⌘C's
cluster/design clip and the board highlighter are untouched by the second existing.

- **⌘ on macOS, Ctrl everywhere else.** **Ctrl cannot be it on a Mac** — there Ctrl-click
  IS the system's secondary click, so admitting it means the press arriving as button 2
  and raising a `contextmenu` the desk then has to SWALLOW, costing Ctrl-click its
  context menus everywhere on the desk. Only the PRIMARY button counts, so Ctrl+
  right-click off a Mac stays a right-click. Shift and Option are excluded rather than
  ignored — each belongs to a gesture of its own (the marquee; the wiring-carrying part
  drag / the torn-off board run). The predicate is pure because the app only ever runs
  one side of its platform branch.
- **A wire and a bus toggle on the PRESS**, from the viewport's pointerdown, so every
  kind of item joins at the same moment. Their own click listeners merely STAND DOWN for
  the chord (the click that follows would replace the selection just toggled).
- **One item collapses to the ordinary single pick** (`singlePick`) — a one-item
  multi-selection would look identical and quietly do none of what a single pick does (R,
  Properties…, the Option ride hint).
- **A toggle is all-or-nothing over the ids it is given**, which lets a BOARD toggle its
  whole snapped group and a BUS toggle its member WIRES (the selection holds no bus of
  its own). A group only PARTLY selected completes rather than half-clearing — that is an
  answer the next click can undo.
- **The single pick is folded in** (`#selectionSets`), since it is what a
  modifier-click most often extends. Annotations are the one kind left out: they are none
  of the three sets, so the chord leaves the selection as it was.
- Refused while `#mode` owns the pointer and while the circuit RUNS (including on a
  running switch, which the press must not fall through and FLIP). A modifier-press
  starts NO drag (the wire/bus grabs stand down for it), and landing on empty desk **does
  not deselect** — an add that found nothing is not a request to clear. A press near a
  wire's END CAP toggles that WIRE (`WireTools.wireIdNear`), never the board under it: a
  cap is not a pointer target, so the wire's own click listener never runs for a press the
  board absorbed.

## Moving parts and clusters

**Option-dragging a part takes its wiring with it** (`model/part-move.js`, Feature 290).
A plain part drag re-seats the part alone, which on a WIRED part is a **silent
rewiring**: rows e/f are free in the new columns so `canPlacePart` has no reason to
refuse, every wire stays in the hole it was laid in, and the wire that fed pin 1 now
feeds pin 3. Option is the key the board drag already uses for the same idea — **Option
changes what this drag takes with it**. Shift could not be (it rubber-bands a marquee,
which is why `#onPartPointerDown`/`#onBoardPointerDown` bail on `e.shiftKey`).

- **Riding is a NODE rule**: a wire end rides when its hole is in a node (one 5-hole
  column-half, `nodeOf`) that one of the part's pins occupies, keyed per BOARD. For a DIP
  that equals "any column it spans", but not for a footprint that SKIPS columns — a push
  button at `a5` owns `c5L` and `c7L` and has nothing to do with `c6L`. GRID nodes only:
  a rail is one node for its whole length, so counting it would pick up the board's
  entire power distribution.
- **Holding Option over a selected part rings what would ride**, before any gesture
  (`setRidePreview(on)` + `#refreshRidePreview`, drawn with the shared pooled
  `HoleRings`). A wire riding by BOTH ends gets TWO rings — which is the useful part: it
  shows which ends travel and which stay. It stands down while the drag is in flight (the
  moving wires answer it better) and while the circuit RUNS. A MULTI-selection rings
  every member's riders too (deduped — two members can share a node), but only when the
  press would actually START a drag: a selection holding a BOARD refuses
  (`#beginClusterDrag`), so ringing would promise a move the app declines. Anything else
  — no selection, a selected wire, a lone annotation — rings nothing. The state is PUSHED
  IN from `app.js` rather than read off `handleKeyDown`, whose contract is "did I CONSUME
  this key" — a modifier must not. Its listeners are keydown/keyup/**blur**: a modifier
  released outside the window never fires our own keyup, and a ring left behind is a lie.
  `#refreshRidePreview` re-derives from whatever is true now and is called from every
  transition that can change the answer (selection, doc edit, drag start/end, run lock,
  scene rebuild); it costs nothing when Option is up.
- **The set is read at pointerdown and FROZEN**, as the board drag reads `e.altKey` and
  walks `matedChain` once. Recomputed per sample it would grow and shrink as the part slid
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
  pinned the user's bend still belongs where they put it). **Net names stay put** — the
  name follows the HOLE, not the signal; no other move gesture re-binds one, and a
  re-seat is not a rename.
- **ONE mutation, ONE undo step, and ONE rule for both gestures**: a solo Option-drag IS
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
  refusal (`canPlacePart`'s `minSpan`), not the plan's.
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
  (`drag-resistor-end`) carries nothing: the lead lands at any hole, angle and strip, so
  there is no column delta to follow — it is a re-bend, not a move. A rot-0 LED is one
  pitch wide against `WIRE_END_GRAB_RADIUS` 0.6, so it has no body region at all and every
  press on one is an end grab; stood up (or in a cluster) it behaves like everything else.
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

**A multi-selection drags as one unit, and Option widens what it carries**
(`model/cluster-move.js` + `DeskDoc.prepareClusterMove` / `moveClusterWithWires` + the
controller's `drag-cluster`, Feature 340). Grab any member and every selected component
travels by one rigid delta; hold Option and everything riding ANY of them travels too —
the wires, and the LEADS of the two-terminal parts plugged into them (a resistor bridging
two members travels whole, one bridging a member and a fixed part bends).

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
- **The commit validates the whole batch, then writes.** `moveComponent`, `moveBrick` and
  `moveWiresBatch` each re-check against the LIVE document, so replaying them member by
  member throws the moment two members swap holes, and `moveWiresBatch`'s wires-only
  reduction would refuse a rider heading for a hole a part is vacating.
  `moveClusterWithWires` runs the SAME prepared predicate over the whole batch and then
  writes the fields, inside the `pasteDesign` snapshot/restore — ONE mutation, ONE undo
  step.
- **A board in the selection refuses the press** and starts nothing: a strip has its own
  drag, carrying everything seated on it under overlap and mating rules a part re-seat
  knows nothing about. The selection is left intact to narrow or to grab by a board, which
  a silent collapse would have thrown away.
- **The collapse moved to the RELEASE.** A press on a member cannot call
  `selectComponent` (a single pick replaces a marquee), so a sub-threshold CLICK does it
  instead, and a `CLICK_TOGGLE_REFS` part still flips under the finger. Without that a
  click inside a selection would do nothing at all.
- **A cluster keeps a rotatable member's stored form** (a bend is measured FROM the
  anchor, so a rigid translation needs no rewrite) — deliberately different from the solo
  body drag, and the better behaviour. A part riding by ONE leg is the one case that does
  rewrite the form, because it BENDS.
- The wire layer needed no schema change: `setPartDrag`'s `shifts` map is keyed by WIRE,
  so N members' riders merge into one map; it gained only a second `overrides` argument,
  for the one thing an address cannot express (a wire ending on a MOVING brick's
  terminal). `AnnotationLayer.render`'s shift became an `anchorIds` SET, the shape
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
