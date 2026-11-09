# Feature 300 — Dragging a selection

## Context

A marquee already selects across kinds — `#multi` (components), `#multiWires`, `#multiBoards`
— and the desk does a lot with that set: ⌘C copies it, Delete removes it, the design clip
carries it to another desktop. It cannot **move** it. `#multi` appears in no drag or move
code at all, and `#select` *clears* a marquee selection the moment a part is pressed
(`desk-controller.js:621`), so pressing one of five selected chips drops the other four and
drags that one alone. The only ways to relocate a sub-assembly in place today are one part
at a time, or copy-paste-delete.

Feature 290 (Option-drag carries a part's wiring) does not fill this and could not have: it
is a different operation. A selection drag moves WHOLE objects; wire-riding SPLITS a wire —
one end travels, the other is pinned — and two facts in the model make that gap
unbridgeable from the selection side. `wiresInRect` (`part-geometry.js:192`) takes a wire
only when BOTH endpoints are inside the box, but the wires worth carrying are exactly the
ones whose far end is elsewhere; and `canMoveWire` (`occupancy.js:357`) takes both
addresses, so dragging a selected wire moves both its ends and breaks the far connection
rather than preserving it.

What 290 *did* leave behind is most of the model this needs: the riding rule, the
all-or-nothing batch check, and the one-mutation commit are all already set-shaped.

Prerequisites: 240 (the marquee's board/wire sets), 290 (riding, the batch check,
`moveComponentWithWires`), 200 (one commit seam).

## Goal

Marquee a group of parts, press any one of them, and the whole selection moves together —
plain for the parts alone, **Option** to bring their wiring, refused as one if any of it
cannot land.

## Design decisions (settled)

**THE MOVING SET SHIFTS BY ONE COMMON DELTA, AND THAT ONE FACT CARRIES THE WHOLE DESIGN.**
A uniform shift preserves the disjointness of any two disjoint sets, and occupancy already
guarantees the moving set is internally disjoint (one hole, one lead). So nothing in the
moving set can collide with anything else in the moving set, at any delta — no cross-check
between moving parts and moving wires, none between one moving part and another. The only
collisions possible are with leads that are NOT moving, which is exactly one occupancy
lookup against a document with every mover lifted out. This is Feature 290's per-part
disjointness argument, generalized and made simpler by being generalized.

**THE DELTA IS COLUMNS ONLY, ON EACH PART'S OWN BOARD.** A DIP is pinned to rows e/f, so
any selection containing a chip can only shift horizontally, and a selection of only
discretes is not worth a second rule. Parts on different boards each shift within their
own. Two consequences:
- **A marquee drag does not change boards.** For one part "move it to that board" is a
  clear instruction and stays so (the single-part path is untouched); for a set spanning
  two boards it has no single meaning, and under all-or-nothing one ambiguous member
  poisons the whole drop. Relocating a sub-assembly to another board is what the design
  clip is for.
- **A desk BRICK in the selection rides the same delta** expressed in world units
  (`dcol` pitch in x, 0 in y). `componentsInRect` already selects a PSU by its terminals,
  so excluding it silently would be the odd choice; its wires ride it for free, since a
  terminal address does not change.

**BOARDS IN THE SELECTION ARE NOT MOVED BY THIS GESTURE.** A board moves in world
coordinates and CARRIES everything seated on it — seated parts are addresses, so they ride
for free — while a part moves by re-seating. One gesture cannot be both without
double-moving every part on a moving board, and reconciling it with mating, snapping,
groups and `#regroupAfterBreak` would be a second board drag rather than a shared one. The
two are already distinguished by what you press: press a part, the parts move; press a
board, the existing board drag moves its group. Nothing new is refused — a selected board
simply is not what this gesture moves.

**PLAIN MOVES THE PARTS; OPTION BRINGS THE WIRING — the same line Feature 290 drew.**
*(This corrects what I proposed when we discussed it: "plain carries wires with both ends
inside the set, Option adds the ones leaving it." That split is worse. The union rule
below needs no notion of inside-vs-leaving at all, and a plain multi-drag that silently
moved some wires but not others would be the least predictable option on the table.)*
- **Plain**: every selected part shifts. Wires stay. Consistent with the single-part drag,
  and it is a real operation — shoving five chips three columns right to make room.
- **Option**: additionally, `wiresRidingParts(ids)` — the UNION of Feature 290's node rule
  over every moving part. A wire between two selected chips has both ends in the union, so
  it rides by both and translates rigidly; a wire from a selected chip to a rail rides by
  one end. ONE rule covers both, with no special case for a wire that leaves the set.

**A SELECTED WIRE SHIFTS RIGIDLY, Option or not** — it is selected, so the user pointed at
it, and `canMoveWire`'s both-ends move is exactly what "move this wire" means. Where a wire
is both selected AND riding by one end, **riding wins**: it preserves a connection that a
rigid shift would break, and preserving it is the stronger reading of a gesture that was
given the Option key.

**THE GESTURE ENGAGES ON "the pressed part is in `#multi`"**, which is also the whole change
to `#select`'s clear-on-pick rule: press a part inside the marquee set and the set is kept;
press one outside it and the set is dropped, exactly as today. A single picked part
therefore keeps every bit of today's behaviour including cross-board re-seating; the
board-locked rule above applies only when a marquee selection is what is moving.

**ONE PREPARED CHECKER FOR THE WHOLE BATCH.** `prepareWireBatchMove`'s reduced-occupancy
build generalizes to lift moving PART PINS out as well, so it becomes
`prepareMoveBatch({componentIds, wireIds})` with `prepareWireBatchMove(ids)` re-expressed as
that with no components — one implementation, hoisted once per gesture as it already is.
This is the piece that genuinely did not exist: `moveComponent` validates each part against
the CURRENT document, so two chips swapping into each other's vacated columns fail
individually while the batch is legal.

**ONE MUTATION, ONE UNDO STEP**, as 290: `moveSelectionWithWires(plan)` applies every part,
every wire and every waypoint shift inside the snapshot/restore transaction, and rolls the
lot back on any refusal.

**THE HINT GENERALIZES FOR FREE.** Option over a marquee selection rings the union — the
same `HoleRings`, the same stand-down rules (during the drag, while running, when there is
nothing selected that could move).

## Implementation steps

1. **`model/part-move.js`** — `wiresRidingParts(doc, componentIds)`: the union of
   `partNodeKeys` over the set, then the same wire walk. `wiresRidingPart` becomes it with
   one id.
2. **`model/part-move.js`** — `planSelectionMove(doc, {componentIds, wireIds, riding, dcol})`
   → `{componentMoves, wireMoves, points, resolved}`. Same node check per riding end as 290
   (every landing address in a node the moving set occupies afterwards), plus the brick
   world-delta entries.
3. **`model/desk-doc.js`** — `prepareMoveBatch({componentIds, wireIds})` (the generalized
   reduced-occupancy checker, now validating derived pin addresses too), and
   `prepareWireBatchMove` re-expressed through it.
4. **`model/desk-doc.js`** — `moveSelectionWithWires(plan)`, the one transaction;
   `moveComponentWithWires` re-expressed as it with a one-part plan.
5. **`components/desk-controller.js`** — `#select` keeps the marquee set when the pressed
   part is in it; a `drag-selection` mode beside `drag-part` carrying the frozen riding set
   and the prepared checker; `#resolveSelectionSeat` (the ONE re-resolve both the move and
   the release call); N part views updated live + `setPartDrag` for the wires; commit.
6. **`components/desk-controller.js`** — `#ridePreviewPoints` reads the marquee set as well
   as `#selected`.
7. **Docs** — `components.md`'s moving section; `CLAUDE.md`.

## Acceptance criteria

- Marquee three chips, press one, drag two columns: all three move, and the two not pressed
  keep their exact spacing.
- Option: their wiring comes — including a wire between two of them, which translates
  rigidly, and a wire from one of them to a rail, which moves only its near end.
- A wire selected by the marquee shifts rigidly with or without Option.
- Any part or any wire end that cannot land reddens the whole set and the release reverts
  everything.
- Two selected chips swapping into each other's vacated columns is LEGAL (the case
  `moveComponent`'s per-part check refuses).
- One ⌘Z restores every part and every wire together.
- A selected board does not move; pressing that board still drags its group as today.
- Pressing a part OUTSIDE the marquee set drops the set and drags that part alone,
  cross-board re-seating included.
- Option over a marquee selection rings the union of what would ride.

## Constraints

- No new user-facing strings.
- `partSeatAt`, the single-part drag, and the board drag are untouched.
- The batch checker is built ONCE per gesture, as `prepareWireBatchMove` already is.
- One `#emitDocChanged` per drop.

## Verify

```bash
make fmt && make lint && make test
make debug
```

New tests: `part-move.test.js` (the union rule; the uniform-shift disjointness invariant
over N parts; both-ends riders in the set), `desk-doc.test.js` (`prepareMoveBatch` accepting
the swap `moveComponent` refuses, and the rollback), `desk-controller.test.js` (engage/keep
vs clear on press, the hint over a multi-selection, boards unmoved), and a `drag-selection`
case in `desk-drag-release.test.js`.

In the app: marquee two 74LS00s and the wires between them, press one, Option-drag three
columns — both chips and all the wiring move, and **Space** shows the circuit behaving as
before. ⌘Z puts everything back in one step. Then marquee a chip whose neighbour blocks the
landing and confirm the whole set reddens and reverts.

## What changed while building it

**A SELECTED WIRE DOES NOT SHIFT RIGIDLY** — dropped from the plan above, which had it
moving with the set "because the user pointed at it". The address arithmetic does not hold
up: a RAIL end would shift by rail INDEX, whose grouped lattice (blocks of 5 with a gap) is
not the column pitch, and a BRICK TERMINAL end cannot shift at all. Both would have to be
special-cased into a refusal, and refusing a drag because a selected wire happened to reach
a rail is worse than not moving it. Riding already covers every case connectivity depends
on — a wire between two moving parts rides by BOTH ends, which is the rigid shift that
mattered — so v1 moves wires only by riding, and "plain moves the parts, full stop" comes
out cleaner for it.

**`moveComponentWithWires` became `applyMove`**, one plan applier for the single-part drag
and the selection drag alike, and `planPartMove` grew `componentMoves` to match
`planSelectionMove`. `prepareWireBatchMove` is `prepareMoveBatch` with no components. So
Feature 290 now runs on Feature 300's machinery rather than beside it.

**`planRiders` restates every riding wire**, unchanged addresses included, rather than
emitting nothing when the shift re-addresses nothing. One entry per rider always, so the
batch checker's length test stays exact — a shorter list is indistinguishable from a
partial batch, which is what that test is for.

**Three defects the build surfaced**, each fixed with a test:
- `applyMove` on a REFUSED plan did nothing at all rather than throwing: a refusal is
  empty, and an empty batch passes its own check trivially.
- `prepareMoveBatch` asked the REDUCED doc whether an address was a real point, so a wire
  ending on a **moving brick's terminal** (`psu1.+`) reported the whole batch illegal — the
  brick had been lifted out to answer a different question. Occupancy and existence are not
  the same question; only the first wants the movers gone. Found by driving the real app.
- `#remountPart` restored a singly-picked part's highlight but not a marquee-selected
  one, so a refused selection drop dropped the set's outline.
