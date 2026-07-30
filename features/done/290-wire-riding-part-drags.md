# Feature 290 — Option-drag a part and its wires come with it

## Context

Re-seating a wired part is currently a **silent rewiring**. Nudge a wired 74LS00 one
column to the right and the drag succeeds — rows `e`/`f` are free in the new columns, so
`canPlacePart` has no reason to refuse — but every wire that fed it is still in the hole
it was laid in, one column back. The chip's pins now sit on different nodes; the netlist
partitions differently; the circuit computes something else. Nothing turns red, nothing
is reported, and the only cue is that a design that worked before the nudge does not
after it.

The gesture a bench gives you instead is: pick the chip up *with its wiring attached*.
Nothing in the app expresses that today. The board drag comes closest — Option narrows a
group drag to a torn-off run (`desk-controller.js:2914`, `matedChain`) — but a part drag
takes the part alone, always.

Everything the electrical half of this needs already exists, in two places that were
written for other reasons and fit this one exactly:

- **`nodeOf(type, hole)`** (`breadboard.js:363`) already answers "which column-half is
  this hole in", and the trench is what splits `L` from `U`. "The wires in rows a–e where
  the pin is in e, and f–j where the pin is in f" *is* `nodeOf`.
- **`DeskDoc.prepareWireBatchMove(wireIds)`** (`desk-doc.js:1760`) already judges a set
  of wire moves as ONE atomic batch — every mover lifted out so the holes they
  collectively vacate read free, every target a real point, claimed by exactly one move —
  and its docstring already asks for this caller: *"A drag probing the SAME wire ids over
  and over should hoist that map out of its search loop entirely."* Prepared once per
  gesture, called per `pointermove`.

Prerequisites: 40 (footprint seating), 50 (wires as addresses), 110 (strips), 130 (buses
as metadata over wires), 200 (one commit seam per gesture). Nothing here touches the
engine, the netlist, or occupancy's rules.

## Goal

**Option-drag** a footprint-seated part and every wire end sitting in a node one of its
pins occupies moves with it, keeping its row and its offset from the part. The far ends
stay put. The drop is **all-or-nothing**: if any riding end cannot seat, the part and
every riding wire tint red and the release reverts, exactly as an illegal seat does
today. A plain drag is unchanged — the part moves alone.

## Design decisions (settled)

**OPTION, NOT SHIFT — Shift is selection.** Shift-drag anywhere rubber-bands a marquee
(`desk-controller.js:3864`), which is precisely why both the part and board pointerdown
handlers bail on `e.shiftKey` (`:3190`, `:2893`) and let it bubble to the viewport. That
bail stays. Option is free on a part, and it already carries this exact meaning one level
up: **Option changes what this drag takes with it.** On a board it narrows the set (the
torn-off run); on a part it widens it (the wiring). One key, one idea.

**The modifier is read at POINTERDOWN, and the riding set is FROZEN there** — matching
the board drag, which reads `e.altKey` once and walks `matedChain` once. Recomputing per
sample would grow and shrink the set as the part slides over other wires' holes, so the
drop would depend on the path taken to it rather than on where it landed.

**RIDING IS A NODE RULE, NOT A COLUMN RULE.** A wire end rides when its hole is in a node
that one of the part's pins occupies, keyed per board (`bb1` + `c7L` — two boards share
node ids). For a DIP that is the same as "any column the chip spans", but for a footprint
that skips columns it is not: a bar array at offsets `[0, 3]` owns `c5L` and `c8L` and has
nothing to do with `c6L`. The node rule is the electrically true one — a wire in `c6L` is
not connected to that part — and it is what makes the feature explicable in one sentence.

**A riding end keeps its ROW and its COLUMN OFFSET.** The shift is the part's own anchor
delta, so the whole cluster translates rigidly and every riding end stays on the node it
was on. That is the entire point: the netlist after the drag is the netlist before it.

**Pin holes and riding holes are DISJOINT, which is why the two legality checks compose
instead of interfering.** A riding end is by construction in a *non-pin* row at its
column offset — the pin's own hole is taken, one hole one lead — and a rigid column shift
preserves each hole's row while the footprint's pin rows at a given offset are fixed. So
no riding end can ever land on a hole this part's pins want, in either direction, at any
offset, including a move onto overlapping columns. `canPlacePart(…, {ignoreId})` therefore
stays exactly as it is, `prepareWireBatchMove` needs no notion of the moving part, and
legality is `seatLegal && batchLegal`. This invariant is load-bearing enough to get its
own test rather than a comment.

**All-or-nothing, and the refusal is the existing one.** A part whose seat is illegal
already tints through `view.setIllegal(!d.legal)`; folding the batch result into the same
`d.legal` means the red already in the app now means "this drop is refused" for the whole
cluster, with no second visual language. Half a move would cut the wires it left behind —
the same reason `pasteDesign` is all-or-nothing.

**Cross-board is free, and its refusals are correct.** The seat search already lets a part
land on another board (`#resolvePartSeat` → `partSeatAt`), so a riding end simply
re-addresses onto the target board. Move a chip onto a Tiny 170 and any riding end past
column 17 fails `isRealPoint` → red. That is the honest answer, not a limitation.

**A NARROWER TARGET BOARD IS WHY `holeAlong` GROWS A SECOND TYPE.** `holeAlong(type,
hole, delta)` parses and re-validates on ONE type, so a chip moved from column 50 of a
full board to column 3 of a half board would refuse a riding end at `a52` — not because
its destination (`a5`) doesn't exist, but because its *origin* doesn't exist on the
destination's type. `holeAlongTo(fromType, toType, hole, delta)` parses on one and
validates on the other, and `holeAlong` becomes it with one type. All column arithmetic
stays inside `breadboard.js`, per the standing rule that nothing outside it derives
row/column offsets by hand.

**Bus members RIDE, and the ribbon follows for nothing.** A bus is metadata over wires and
its collars are derived from its members' endpoints (`wire-layer.js:558`,
`#busGeometry`) — so shifting every member's near end shifts the ribbon with it, on both
the live preview and the commit, with no bus code at all. This is the payoff case: drag a
chip and its data bus comes along. It is also why the preview shift has to be honoured
*inside* `#busGeometry` and not only in the main wire loop — otherwise the leads move and
the ribbon they enter does not.

**A ROUTED wire's waypoints move only when BOTH its ends do.** Waypoints are the one part
of a wire that is not an address, so they are the one part that has to be moved by hand
(the same reason `translateAll` and `pasteDesign` shift them explicitly). One end riding
means the far end is pinned and the user's bend still belongs where they put it; both ends
riding means the wire is translating rigidly and the bend is part of the shape that is
moving. Anything else either drags a route away from a fixed end or leaves a rigid
translation kinked.

**NET NAMES AND ANALYZER CHANNELS STAY PUT — the name follows the HOLE, not the signal.**
A net name binds to an address (`desk-doc.js:2060`) and resolves to whatever net that hole
is on at each netlist rebuild. No existing move gesture re-binds one, and this must not
be the exception: a re-seat is not a rename, and a binding that chased the wiring would
make ⌘Z's inverse ambiguous. Stated here so it is a decision rather than an oversight.

**ROTATABLE parts are out of scope; BRICKS already have it.** `#onPartPointerDown` sends
LEDs and resistors down the `drag-resistor`/`drag-resistor-end` gestures (`:3216`) — two
free ends, an arbitrary bend, no column delta to shift a riding end by — so v1 covers the
`drag-part` gesture, which is chips plus every non-rotatable footprint part (switches,
button, DIP banks, displays, resistor networks, memory). A PSU or clock brick needs
nothing: its wires end at `psu1.+`, a terminal address that rides the brick already.

**A flip mid-drag (`R` on a chip in hand, `:1583`) changes nothing.** A DIP's footprint
maps onto itself, so the node set is identical; only the pin numbering turns.

**One mutation, one undo step.** `moveComponent` + `moveWiresBatch` commit inside one
snapshot-guarded `DeskDoc` method that rolls back on any refusal — the `pasteDesign`
idiom (`desk-doc.js:2291`) — followed by a single `#emitDocChanged("move part")`. ⌘Z
restores the part and its wiring together, because they were never two edits.

## Implementation steps

1. **`model/breadboard.js`** — `holeAlongTo(fromType, toType, hole, delta)`; re-express
   `holeAlong(type, hole, delta)` as `holeAlongTo(type, type, hole, delta)`.
2. **`model/part-move.js`** (new, pure, DOM-free) —
   - `partNodeKeys(doc, comp)` → `Set<"<boardId>|<node>">` from `partPinAddresses` +
     `nodeOf`, skipping floating leads.
   - `wiresRidingPart(doc, compId)` → `[{ wireId, ends: ["from"|"to", …] }]`, one entry
     per wire (a jumper between two of the part's own nodes rides by both ends).
   - `planPartMove(doc, { id, board, anchor })` → `{ moves: [{id, from, to}], points,
     resolved }` — `resolved:false` when any riding end has no destination hole, so the
     caller refuses without inventing one. `points` carries the both-ends-riding waypoint
     shifts.
3. **`model/desk-doc.js`** — thin wrappers over the private doc, matching `canPlacePart`'s
   shape: `wiresRidingPart(id)`, `planPartMove(id, boardId, anchor)`. Then
   `moveComponentWithWires(id, boardId, anchor, plan)`: `snapshot()` → `moveComponent` →
   `moveWiresBatch` → waypoint shifts, `restore()` on throw.
4. **`components/wire-layer.js`** — factor `#wireEnds(wire, overrides)` (the
   `#endpointWorld` pair plus any active shift) and call it from BOTH the main wire loop
   (`:291`) and `#busGeometry` (`:558`). Add the `#partDrag` channel + `setPartDrag({
   shifts: Map<wireId, {from?, to?}>, legal })`, tinting shifted wires with the existing
   `wire--dragging` / `wire-preview--illegal`.
5. **`components/desk-controller.js`** —
   - `#onPartPointerDown`: leave the `e.shiftKey` bail; on `e.altKey`, put `riding` and
     `checkBatch = this.#doc.prepareWireBatchMove(ids)` on the `drag-part` mode (`:3258`).
   - `#resolvePartSeat` (`:3308`): plan the batch and fold it into `d.legal` — the ONE
     function the move and the release both call, so preview and drop cannot disagree.
   - `#onPartPointerMove`: publish `setPartDrag`.
   - `#onPartPointerUp` (`:3511`): the release-point re-resolve re-plans the wires too,
     then commit through `moveComponentWithWires`; `setPartDrag(null)` on every exit.
   - `#rebuildScene`'s gesture cancel: clear the preview.
6. **`src/web/docs/components.md`** — one short section, worded off `the-desk.md`'s
   existing Option-drag paragraph so the two gestures read as one idea.
7. **`CLAUDE.md`** — a note under the part-gesture/wire material.

## Acceptance criteria

- Option-drag a wired 74LS00 two columns left: the chip and every wire in its nodes move
  together, the far ends stay, and the netlist is unchanged (`buildNetlist` partitions
  identically before and after).
- A plain drag of the same chip is byte-for-byte what it is today.
- A riding end whose destination is occupied by a non-moving lead, or off the strip,
  reddens the part AND the riding wires, and the release reverts everything.
- The riding set overlapping its own vacated holes (a two-column shift) is legal.
- A chip whose 8 data pins carry a bus: the ribbon follows live and on the drop.
- A routed riding wire keeps its waypoints when one end rides, and translates them when
  both do.
- Shift-drag started over a part still rubber-bands a marquee.
- One ⌘Z restores the part and all its wiring; one ⇧⌘Z reapplies both.
- Cross-board: the same drag onto a mated neighbour re-addresses the riding ends; onto a
  Tiny 170 that cannot hold them, it refuses.
- Nothing rides for an LED, a resistor, or a PSU brick (the brick's wires already follow).

## Constraints

- No new user-facing strings, so no `locales/*.json` churn and no i18n-guard surface.
- Occupancy keeps its one rule (one hole, one lead) and gains no new concept; the netlist,
  the engine, and `sim/` are untouched.
- No column/row arithmetic outside `breadboard.js`.
- `prepareWireBatchMove` is built ONCE per gesture — a per-`pointermove` rebuild of the
  whole document's occupancy is the cost its own docstring exists to warn about.
- The commit stays one `#emitDocChanged` call; nothing new enters the coalescing rules.

## Verify

```bash
make fmt && make lint && make test
make debug
```

New tests: `part-move.test.js` (the node rule; the disjointness invariant across every
offset of a two-column shift; both-ends riding; cross-board onto a narrower strip; the
all-or-nothing refusal), a `holeAlongTo` case in `breadboard.test.js`, a
`moveComponentWithWires` rollback case in `desk-doc.test.js`, and a `drag-part` case in
`desk-drag-release.test.js` — the release-point re-plan is exactly the shape of bug that
suite exists for (a fast release must not commit the batch computed at the last coalesced
move).

In the app: place a 74LS00 on a full board, wire four inputs from a rail and two outputs
to LEDs, **Space** to confirm it runs. Stop, Option-drag the chip two columns left — the
wires come — **Space** again: same behaviour. ⌘Z: chip and wires go back together.
Option-drag it right until a riding end runs off the board: everything reddens, release
reverts. Then Shift-drag from on top of the chip and confirm you get a marquee.

## Follow-up (landed after the plan above)

**The hint: holding Option rings what would ride.** The gesture as planned only answered
"what comes with it?" *during* the drag, by moving the wires — which is after the user has
already committed to it. So with a part SELECTED, holding Option now rings every wire end
an Option-drag would carry, and releasing it puts the rings away.

- Drawn with the shared, pooled **`HoleRings`** the bus tool already uses — "MANY holes at
  once" is exactly what that class is for, and it is the same `.hole-ring` look as the
  single hover ring, so the app gains no new visual vocabulary.
- **A wire riding by BOTH ends gets TWO rings.** That is the part worth having: it shows
  which ends travel and which stay put, which no single per-wire highlight could say.
- It stands down while the drag is in flight (the moving wires answer better, and rings on
  holes being vacated would say the opposite), while the circuit runs, and for anything
  that is not one selected part.
- The modifier is **pushed in** from `app.js` (`setRidePreview`) rather than handled in
  `handleKeyDown`, whose contract is "did I CONSUME this key" — a modifier must not.
  Listeners are the keydown/keyup/**blur** trio the Fit button's Shift-held preview uses;
  blur is the only reliable end for a modifier released outside the window.
- `#refreshRidePreview` re-derives from current state and is called from every transition
  that can change the answer (selection, doc edit, drag start/end, run lock, rebuild).
