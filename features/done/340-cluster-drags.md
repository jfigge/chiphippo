# Feature 340 — A multi-selection drags as one, and Option carries its wiring

## Context

Feature 290 gave a *single* seated part an Option-drag that takes its wiring with it,
because re-seating a wired part without its wires is a silent rewiring: the pins land on
different nodes, the wires stay in the holes they were laid in, and the circuit quietly
computes something else.

That left two gaps a bench user runs straight into.

**There was no multi-part drag at all.** `#onPartPointerDown` called
`selectComponent(id)` before it built any drag mode, and `#select` clears a marquee
selection on any single pick — so the press that would have moved a group *destroyed*
the group and moved one part. `#multi` was a delete/copy-only selection: `⌘C`, Delete
and the highlighter honoured it, nothing else did.

**And Option wire-riding reached only footprint parts.** `#onPartPointerDown` routes on
`partDef(ref)?.rotatable` first, and `led` and `resistor` are `rotatable: true` *even at
rot 0* — so Option-dragging an LED or a resistor carried nothing, and neither did a PSU
or clock brick. Those are exactly the parts a user names when they ask for this ("an LED,
a button and a resistor").

Prerequisites: 290 (the ride rule), 40 (footprint seating), 50 (wires as addresses),
110 (strips), 200 (one commit seam per gesture), 240 (the marquee's three selection sets).
Nothing here touches the engine, the netlist, or occupancy's rules.

## Goal

Grab any member of a multi-selection and **every selected component moves by one rigid
delta**, keeping the arrangement exactly as it was built. Hold **Option** and everything
riding *any* member travels too — the wires, and the **leads** of the two-terminal parts
plugged into them. The drop is **all-or-nothing** — one member, one wire end or one leg
with nowhere to land turns the whole group red and the release reverts — and a legal drop
is **one undo step**.

## Decisions

- **A plain drag moves the group too.** Option only widens what the drag *carries*, never
  which items move. That matches Delete and `⌘C`, which have honoured the selection since
  Feature 240, and the board drag's grab-one-drag-many.
- **A board in the selection REFUSES the press**, starting nothing and leaving the
  selection intact. A strip has its own drag, carrying everything seated on it under
  overlap and mating rules a part re-seat knows nothing about. Half-honouring the
  selection is worse than declining it; collapsing it silently is worse still.
- **Bricks (PSU, clock) are components and travel.** They already join a marquee.
- **Wires ride, they are not selected into the move.** A wire in the selection that rides
  nothing stays where it is: the ride rule alone decides wires, in a group exactly as it
  does for one part.

## Design

### The delta is the GRABBED member's own

`clusterDelta` asks whichever resolver that member's form already uses — `partSeatAt` for
a footprint (clamp at the end of a strip included), snap-pin-1-to-the-hole-under-it for a
lead, whole units for a brick — and reports the resulting world vector. So the thing under
the finger behaves exactly as it would dragged alone, and everything else is carried by
the vector its answer implies.

Rounding the *pointer's* travel to whole pitches instead cannot express the move that
matters most: a dovetailed stack puts the board below at 17.52 pitch, so an integer delta
could never take a selection from one board to the next. A member on a board at some
*other* offset lands between holes and the drop reddens — honest, since two strips at
different offsets share no lattice and no rigid move can seat parts on both.

**A BRICK GRAB HAS NO LATTICE OF ITS OWN, so it borrows a seated member's.** A PSU or
clock stands on the desk rather than in a board, so its resolver answers in whole
units — which is right for the brick and wrong for everyone behind it: 21.02 is not a
whole number, so grabbing the brick of a selection spanning a dovetailed stack rounded
the delta to 21 and put every seated member a fifth of a pitch off its holes. The
grab-branch therefore takes the raw vector, offers it to the first **seated** member,
and reports whatever hole that member lands in — so the brick still moves in whole
units (its own answer, one hole's worth away) while the parts land square. A selection
of nothing but bricks keeps the raw vector, which is exactly what it was before; one
with nowhere for its seated member to land refuses, as every other unresolvable sample
does.

### A wire end is not the only thing in a node

`leadsRiding` + `planRidingLead`. A resistor with one leg in the column-half a
moving pin occupies is connected to it exactly as a jumper in the next hole along
is, so leaving it behind is the same silent rewiring the gesture exists to
prevent. Riding by ONE leg is a **bend** — the other leg stays put and the part
is rewritten into the two-free-ends form, since only that form can express one
(a rot-0 LED therefore stands up, exactly as dragging one of its legs by hand
makes it). Riding by BOTH is a rigid translation that keeps whichever form it is
stored in.

Only a `rotatable` part qualifies: it is the only kind whose leads move
independently. "Carry the chip next door because a wire's worth of copper joins
them" is a different gesture, and one that cascades.

**The rule closes at one hop**, which is why nothing recurses: a riding lead
lands in the node its pin lands in and every *other* rider in that node travels
with it, while a lead that stays put leaves its own node untouched — so a rider
never strands anything behind it. A transitive closure would pick up the whole
circuit from one nudge.

A bend the body cannot physically make is the **batch's** refusal, not the
plan's: `planRidingLead` answers where the leg goes, and `canPlacePart`'s
`minSpan` is what says a quarter-watt body will not fit in two columns.

### A rider crosses the trench with its pin, keeping the arrangement

`holeAcross` + `rowsBetween` (breadboard.js — all row arithmetic lives there). The ride
lookup tries the rider's **own row** first and, only if that no longer reaches the pin's
node, the row the **pin's own row delta** puts it in. So a wire two holes from a part is
still two holes from it afterwards, on the same side. Two candidates, not a search;
staying put wins whenever staying put works, which is every within-half move, leaving
those bit-for-bit what they were.

Without the second candidate a rider was stranded in the half its pin had just left and
the plan could only refuse — reported as red over a top half with plenty of room in it,
and it made a whole selection undroppable there.

Rows are counted as **holes, not distance** (`e` + 1 is `f`, straight across a gap three
pitches wide, where every other step is one), which is what makes "the same number of
holes apart" survive the crossing. Because it is one rigid row shift of the pins and their
riders together, the disjointness invariant survives it too — a **mirror** (`a`↔`j`,
`c`↔`h`) would not, and would swap which side of the part each rider came out on. Drag far
enough that the wiring would run off the edge of the board and it refuses, which is
honest: a row nearer the trench fits.

### A rider follows its own PIN

`part-move.js` gained `partRideShift`, and `planPartMove` is now stated in terms of it. A
rider keeps its ROW, shifts by **that pin's** column delta, lands on **that pin's** target
board, and must still be in that pin's node afterwards. For a footprint part every pin
shares one board and one delta, so this reduces to the old code exactly (across-the-trench
refusal included) — but a rotatable part's pin 1 may be on a RAIL, which owns no node, and
reading the shift off the anchor refused that part outright even though its grid pin had a
perfectly ordinary neighbourhood to carry.

Two contract changes fall out, both shared with the solo drag:

- `moves` **names every riding wire, always**, including one that does not move (a
  discrete slid along its own column-half). The no-op entry is what tells a batch check
  the hole is still spoken for — see the claim set below — and it leaves callers one
  convention instead of two.
- `points` takes its shift from the **end** delta, not the anchor's. A rider keeps its row
  and shifts by a column, so `a5 → c7` moves riders (2, 0) while the anchor moves (2, 2);
  the old code gave a routed wire's bends a spurious vertical shift.

### A claim set, not the rigid-translation proof

`paste-cluster.js` argues that a rigid integer translation needs no member-vs-member
collision check. That does **not** carry here: riders keep their row and shift by a
column, so "parts + riders" is not a rigid body — a pure row move slides the pins two rows
and the riders not at all, and a pin can land on a stationary rider's hole. One shared
`claimed` set over every landing address (each moving pin, both ends of each wire move)
catches that, mover-vs-mover, and pin-vs-a-rider's-far-end, with no proof obligation.
What survives of the paste-cluster argument is brick-vs-brick rects, checked as rects.

### Two documents

`DeskDoc.prepareClusterMove({componentIds, wireIds})` — the sibling of
`prepareWireBatchMove`, hoisted once per gesture for the same reason (`canPlacePart`
rebuilds the whole occupancy index per call, which for N members would be N rebuilds a
frame; hence the one new `occupancy` option on it). It builds occupancy from the doc as if
every mover — components **and** wires — were gone, since a member landing in a hole a
travelling companion is vacating is the ordinary case rather than a collision. That is
precisely why `prepareWireBatchMove`, which lifts out only the wires, could not be reused.
But **realness** is asked of the full component list: `isRealPoint` resolves `psu1.+`
through the components, and a PSU does not stop existing because it is in the air.

### The commit validates the whole batch, then writes

`moveComponent`, `moveBrick` and `moveWiresBatch` each re-check against the live document,
so replaying them member by member throws the moment two members swap holes, and
`moveWiresBatch`'s wires-only reduction would refuse a rider heading for a hole a part is
vacating. `moveClusterWithWires` therefore runs the *same* prepared predicate over the
whole batch and then writes the fields, inside the `pasteDesign` snapshot/restore.

**A solo Option-drag IS a one-member cluster**, so `moveComponentWithWires` became that
call with the dragged part at the head of the placements, and `#resolvePartSeat` checks
through the same `prepareClusterMove` predicate. One transaction rule and one legality
rule for both gestures rather than two that could drift — and it is what lets a riding
lead, whose `params` change, be checked and committed at all (a placement may carry its
own params; the check has to see the part as it will BE, not as it is).

**And the rotatable part's own BODY drag joined them.** `drag-resistor` predates all of
this and carried nothing, so an LED carried its wiring as a member of a selection but not
when dragged on its own — one part, two answers. A body drag moves both leads by one
delta, which is the same rigid move a footprint part makes, so the ride rule applies
unchanged; `planPartMove` gained a `params` field for it, since a body drag rewrites a
footprint-form part into the two-free-ends one and the rule has to read the pins it will
actually have. The **end** drag still carries nothing, deliberately: that lead lands at
any hole, at any angle, on any strip, so there is no column delta for a rider to follow —
it is a re-bend, not a move. (A rot-0 LED is one pitch wide against the 0.6 end-grab
radius, so it has no body region and every press on one is an end grab.)

It writes **board and anchor only** for a board member, so a rotatable one keeps whichever
form it is stored in — a bend is measured from the anchor, so a rigid translation needs no
rewrite. A solo body drag converts a rot-0 LED to the two-free-ends form; a group drag
deliberately does not.

### Two candidates for the anchor, and the raw one crosses a spanned run

Rounding the pointer's travel to whole pitches assumes a lattice, and there is one
only **horizontally**: a column is one unit and every strip lines its columns up with
every other, but the vertical heights are MEASURED. A spanned run (`rail · pins · rail ·
pins · rail`) therefore puts the next pin-board **17.52** pitch down, so a rounded `dy`
lands the anchor **0.48** off the hole it aimed at — past `HOLE_HIT_RADIUS` 0.45, which
finds nothing. The part could not be dropped on the other board at all, so its wiring
never went either: wire a resistor's two pins to the rails, drag it to the board below,
and *nothing* moves.

Both the solo body drag (`#trackResistorDrag`) and `clusterDelta`'s two snapping branches
now try the **raw** translated point first — where the part actually is, and what the
placement ghost has always used — and fall back to the rounded one. On a single board the
two always name the same hole whenever either does, so the fallback costs nothing and
keeps the sliver between two rows, where the raw point is nearest to nothing, behaving as
it did. The body drag then draws the part from the hole it FOUND, so the preview is the
seat that will be committed.

### A rider with nowhere to land draws from the DOCUMENT

The plan is re-derived on **every** sample, including the ones that resolve to nothing,
and a rider the plan did not place is drawn where the document has it — in red.

The two drags differ in what they do with a sample that seats nowhere, and that is
where this bites. A footprint drag **stops at its last good seat**, so a stale plan
still describes the picture on screen. A rotatable part is drawn at the **raw cursor**
whatever the position, so it walks away from a plan that stopped being re-derived — and
the riders sat at a hole the part had long since left, then jumped when it found ground
again. Over the gap between two dovetailed boards, dragging an LED across looked like
its wiring simply stopped following it.

Falling back to the document says the true thing instead: nothing is moving, and the red
says it will not be dropped here.

### The collapse moved to the release

A press on a member cannot call `selectComponent` — a single pick replaces a marquee — so
a sub-threshold **click** does it instead: the selection narrows to the part pressed, and
a `CLICK_TOGGLE_REFS` part still flips the position under the finger. Without that, a
click inside a selection would do nothing at all.

### What did NOT need changing

`WireLayer.setPartDrag`'s `shifts` map is keyed by **wire**, so N members' riders merge
into one map with no schema change; it gained only a second `overrides` argument, for the
one thing an address cannot express (a wire ending on a moving brick's terminal follows a
position, not a new address). `#dragGestureActive` derives "is a drag live" from the kind
NAME, so Escape, the mid-drag shortcut guard and `#rebuildScene` covered `drag-cluster`
for free. `AnnotationLayer.render`'s shift became an `anchorIds` **Set** — the shape
`#shiftAnchoredAnnotations` already committed with.

## Files

| File | What |
|---|---|
| `web/scripts/model/cluster-move.js` | **new** — `memberDragForm`, `clusterMembers`, `clusterDelta`, `resolveClusterTargets`, `wiresRidingCluster`, `partsRidingCluster`, `planClusterRiders` |
| `web/scripts/model/part-move.js` | `partRideShift` + `ridePointShift` + `leadsRiding` / `partsRidingPart` / `planRidingLead`; `planPartMove` re-based on them |
| `web/scripts/model/occupancy.js` | `canPlacePart`'s optional prebuilt `occupancy` |
| `web/scripts/model/desk-doc.js` | `prepareClusterMove`, `moveClusterWithWires`, `#brickRects({ignoreIds})`, the four delegates |
| `web/scripts/components/desk-controller.js` | `drag-cluster`: `#beginClusterDrag`, `#resolveClusterMove`, `#clusterDragPreview`, `#clusterBrickOverrides`, `#applyClusterPreview`, `#restoreClusterViews`; the multi-selection ride hint |
| `web/scripts/components/wire-layer.js` | `setPartDrag(spec, overrides)` |
| `web/scripts/components/annotation-layer.js` | `render({anchorIds, dx, dy})` |

Tests: `tests/cluster-move.test.js` (new — the pure module and the batch legality against
a real `DeskDoc`, including the netlist invariant), plus cluster sections in
`tests/desk-gestures.test.js`, `tests/desk-drag-release.test.js`,
`tests/desk-controller.test.js` and `tests/annotation-layer.test.js`.

Docs: `src/web/docs/components.md` ("Moving several parts at once"), CLAUDE.md.
