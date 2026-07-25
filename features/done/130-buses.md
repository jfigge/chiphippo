# Feature 130 — Buses: bundled multi-bit signals

## Context

Wires today are one `{ id, from, to, color }` at a time (Feature 50). That is fine for
a handful of gate connections, but the moment a design has an 8-bit data path or a
16-bit address path — exactly what the memory chips of Features 170–190 need — the desk
becomes an unreadable thicket, and laying sixteen wires one click-pair at a time is
tedious and error-prone.

Real bench builds group these into a labelled ribbon or a mental "bus": `D0..D7`,
`A0..A15`. A bus is not a new electrical object — each bit is still its own net on its
own hole — it is a **naming + drawing convenience** that makes parallel signals legible
and fast to route.

Prerequisites: Features 50 (wires), 120 (net names — a bus is a named set of nets).

## Goal

Introduce a **bus**: a named, ordered set of single-bit nets (`name[hi:lo]`) that draws,
routes, and reads as one unit, while remaining N independent wires and N independent
nets underneath. Attaching a bus to a chip's pin-range lays all its wires in one
gesture.

## Design decisions (settled)

### A bus is metadata over wires, not a new wire type

`doc.buses`: `{ id: "bus<n>", name, width, color, members: [wireId…] }`. Each member is
an ordinary wire that already exists in `doc.wires`; the bus just records which wires
belong to bit 0..width-1 and in what order. Deleting a bus offers "keep wires" (unbundle)
or "delete wires" (cascade). Deleting a member wire shrinks the bus, never corrupts it.
The netlist, occupancy, and engine are **completely unchanged** — they still see plain
wires. This is the Feature 110 "strips stay in `doc.boards`" move applied to wires.

### The bus tool lays a run at once

Arming the bus tool (shortcut `B`) and clicking a **start hole then an end hole** on two
parallel hole-runs lays `width` wires between the two aligned ranges (bit *i* → column
*i* offset on each side), snapping to consecutive holes. A second mode taps a bus onto a
**chip pin-range**: pick the chip, pick the first pin of a labelled group (the catalog
marks pin groups — see below), and the tool fans the bus's bits to that pin run. Illegal
targets (occupied holes, wrong width) tint red exactly like the wire rubber-band.

### Bus width and bit order come from its name

The name grammar `D[7:0]` (msb:lsb) or `A[0:15]` sets width and direction; a bare name
defaults to width 1 (a degenerate bus, i.e. a named single wire). Bit order drives which
member maps to which chip pin, so a `[7:0]` data bus wires D7 to the high pin.

### Catalog pin groups

Add an optional `pinGroups` block to chip defs (pure data): `{ name: "D", pins: [8,9,…],
dir: "io" }`. It names contiguous functional pin runs (data, address, control) so the
bus-tap mode knows where a bus lands and the schematic view (150) can draw a bus stub
instead of eight pin stubs. Existing chips get no groups and behave exactly as today.

### Rendering: a ribbon cable, flared only at the ends

A bus renders in `WireLayer` as a flat ribbon body (`desk/ribbon-path.js`'s
`ribbonLayout`, pure geometry: the centroid of the members' `from`s to the centroid of
their `to`s, pulled back a short "collar" setback from each end) carrying the bus name
at its midpoint — not N full independent sagging wires end to end, which reads as an
unreadable thicket at 8 or 16 bits. Each member wire draws as two short leads off the
ribbon's collars into its own hole, so the individual strands are only visible fanning
out right where they land on the board — a real IDC ribbon cable's read. Selecting the
ribbon (its hit stroke spans the FULL corridor, flared ends included) selects the bus
(whole-bus drag/recolor/delete); an individual lead near a board is still its own
`.wire`, clickable/deletable on its own.

### Leads spread evenly across the ribbon's width, pipe drawn last

Two refinements sell the "real cable" read further. First, a member's collar-side
attachment point is no longer the single shared collar — `desk/ribbon-path.js`'s
`ribbonSpread(a, b, width, count)` (sharing `collarParam`/the same bezier tangent math
with `ribbonLayout`, so the two always agree on WHERE a collar is) hands back `count`
points evenly spaced across `width` world px, perpendicular to the ribbon's own local
direction there — so the leads fan out side by side across the pipe's face instead of
all converging on one vertex. Bit order runs in REVERSE across that face (member 0
takes the `+width/2` side, the last member `-width/2`): laid out the other way, every
strand had to cross the fan to reach its own hole, pinching the whole bundle through
one point right at the collar instead of opening cleanly. Reversed, no lead crosses
another and each member's own HOLE is untouched — only where its lead leaves the pipe
moved. There is still no twist between the two ends: the perpendicular is always taken
relative to the fixed a→b tangent direction (never flipped per end) and both ends share
the one index mapping. `#busGeometry`
computes this once per bus (`spreadA`/`spreadB`, indexed by the member's position in
`bus.members`) and `WireLayer`'s per-wire loop looks up ITS OWN spread point instead of
the old shared `collarA`/`collarB`. Second, the ribbon's VISIBLE body now renders AFTER
every wire (`WireLayer#buildBandCover`, opaque, no longer 0.9 translucent) instead of
before, so it paints OVER the base of each lead right where the spread points meet the
collar line — the leads read as entering a solid connector, not just touching its edge.
A **selected** member lead is the one exception to that paint order: a lead is only
about a collar setback long, so with the ribbon drawn on top there was practically none
of it left to carry a selection highlight — clicking one selected it invisibly.
`WireLayer.render` holds a selected lead back and re-appends it AFTER the band covers
(`raised`), and `setSelectedMany` re-renders when that raised set changes, since SVG has
no z-index and "on top" is DOM order. Releasing the selection puts it straight back in
document order, because the order is derived fresh every render rather than mutated in
place. It goes UNDER the end handles, not truly last: the ribbon body is what hid the
selection and the body is pointer-inert, so lifting a lead over it costs nothing —
lifting it over the handles as well would give a member's hit stroke priority over the
handle right at the collar, the exact ambiguity `WireTools#nearOwnBusHandle` exists to
settle. A non-member wire never reorders (nothing paints over it), so its selection
stays a pure class toggle.

This is otherwise purely a paint-order change: the ribbon's INTERACTIVE hit stroke stays exactly
where it was (`WireLayer#buildBandHit`, rendered early, before the wires, unchanged) —
splitting hit-testing from visuals this way means the "draw over" look can't reopen the
lead-vs-handle ambiguity the collar-overlap fix (above) exists to prevent, since every
child of the cover group is `pointer-events: none` in app.css and so never receives a
click regardless of where it sits in paint order.

### Two end handles, for moving just one side of the ribbon

Beyond the whole-ribbon grab, each collar carries its own **end handle** — an invisible
widened hit circle plus a small knob that only shows on hover (or for the whole gesture
once grabbed, since a captured pointer can wander off the tiny circle without CSS
`:hover` following it). Grabbing one translates every member's lead on THAT end only,
rigidly, in parallel — the other end and the ribbon's opposite collar stay exactly
where they were — reusing the same batch-move legality as the whole-bus drag
(`DeskDoc.canMoveWiresBatch`/`moveWiresBatch`): if any member's dragged end can't seat
in a free hole, nothing commits and the drag snaps back to its original position.
`BusTools#beginBusDrag` takes an `end: "from"|"to"|null` parameter (`null` = the
existing whole-bus behavior, both ends together) so the two gestures share one code
path; `WireLayer`'s `busDrag` spec carries the same `end` field through to rendering.
The handles are appended to the SVG LAST (after every wire), so they always win
hit-testing over a member lead's own hit stroke exactly at the collar, where the two
inevitably overlap.

### A member wire's cap declines its OWN drag only right at a collar

Z-order alone isn't enough: `WireTools#tryBeginDrag`'s first check, `wireEndNear`, grabs
the nearest wire endpoint within its radius by raw DISTANCE, with no notion of DOM
z-order — and on a wide bus a collar can land within a couple of screen px of one
member's own cap (measured, not hypothetical: an 8-bit bus put a collar 1.4px from its
6th member's hole; the collar sits at a fixed offset from the bus's CENTROID, not from
any particular member's hole, so which member — if any — ends up that close is
essentially incidental to bus width and layout). That put a press there at the mercy of
which grab happened to win, sometimes re-routing a single wire when the user meant to
drag the whole end. An earlier pass over-corrected and declined BOTH of a member's own
drags — endpoint re-route AND whole-body translate — everywhere, for every member,
regardless of position; the fix landed here is narrower: `WireTools#nearOwnBusHandle`
(desk/ribbon-path.js's `busEndHandleNear`, the SAME collar geometry WireLayer renders
the handles at, derived fresh from the bus's resolved member endpoints) excludes a
member's endpoint-drag ONLY when the press is within `HANDLE_HIT_RADIUS` of ITS OWN
bus's collar — the far end of that SAME wire, and every other member, re-route exactly
like an ordinary wire's cap. Whole-body translate (grab a lead's middle to translate
both its ends rigidly) stays off for every member regardless — a ~16px lead has little
to translate, and it was never actually the source of the ambiguity (DOM z-order
already puts the handle on top of a lead's hit-stroke, since handles render last).
`#onBoardPointerDown`'s existing wire-cap priority check (a cap sits on a real hole, so
a press there lands on the board SVG beneath) grew a companion `WireTools#capNear` —
bus-membership-blind — so a declined member cap still absorbs the press instead of
falling through to a board drag.

### Escape recovers a drag whose pointerup never arrives

A real pointerup is occasionally dropped by the OS/browser — a fast release, a focus
change mid-drag, capture lost with no matching event — and this is NOT hypothetical:
it reproduces on demand (send `pointerdown` + `pointermove` past the threshold, then
NO `pointerup` at all — the app has no way back in). `DeskController` already had a
recovery path for its OWN direct-manipulation drags (`#cancelDragGesture`, wired to
Escape): route a synthetic `pointercancel` through the same up-handler a real one would
reach, since every one of them already treats `e.type === "pointercancel"` as "tear
down the capture/listeners, revert, never commit." But `#dragGestureActive` /
`#cancelDragGesture`'s switch never listed the wire/bus gesture kinds
(`drag-wire-end`, `drag-wire`, `drag-bus`) — an oversight from when wiring was pulled
out into its own collaborator modules — so Escape did nothing for a stuck wire or bus
drag, and neither did the "shortcuts are inert mid-drag" guard (paste/delete could
clobber `#mode` out from under the pending pointerup too). Fixed by adding those three
kinds to both, plus a small public `cancelDrag()` on `WireTools` and `BusTools` (mode
kind → the matching private `#onXxxUp` fed a synthetic `{ type: "pointercancel",
pointerId }`) since their up-handlers are private to those classes, not
`DeskController`.

### A drop that misses its exact target snaps to the nearest legal one

Before this, a drag whose release point wasn't exactly on a legal hole/delta just
failed and reverted — correct, but unforgiving of the small pixel-level misses a real
pointer makes constantly. `model/nearest-legal.js` is the one shared, pure search
every drag-drop resolver goes through: `ringOffsets(r)` enumerates every integer
`(dx, dy)` at exactly Chebyshev distance `r` from an origin, sorted by TRUE Euclidean
distance (so a ring's closest point is tried first even though the ring itself is
square, not circular — an accepted minor approximation, same spirit as `wireSag` not
being a true catenary); `nearestLegalOffset(isLegal, maxRadius)` walks rings
outward, `r = 0, 1, 2, …`, and returns the first offset whose `isLegal(dx, dy)` is
true, so the common case (something legal is right there, or one hole off) stays
cheap — it never pre-builds or sorts a whole square of candidates up front.

Two callers, two very different radii, because "how far is worth calling a
near-miss" depends on what's moving:

- **Endpoint drags** — a single wire's own cap (`WireTools#resolveEndpointTarget`),
  a bus end-handle (`BusTools#onBusMove`/`#onBusUp` when `m.end` is set) — an END's
  own drag can commit at the CLOSEST legal hole with NO effective cap
  (`nearestLegalOffset`'s default `maxRadius`, `DEFAULT_SEARCH_RADIUS = 200` — large
  enough to reach anywhere on any realistic desk layout, small enough that a
  genuinely empty neighborhood still bails out promptly). Dragging just an END always
  lands somewhere real, however far the cursor actually let go — there's no "whole
  wire" left behind to make a big jump feel like a teleport, so "always find the
  nearest hole" is the right feel.
- **Whole-body rigid drags** — a whole wire (`WireTools#resolveWholeDragDelta`), a
  whole bus (`BusTools#onBusMove` when `m.end` is `null`) — keep the original tight
  `SNAP_RADIUS = 2` pitch-unit margin, end to end, with no unbounded fallback at all.
  Translating every member by the SAME delta means a large snap would relocate the
  whole wire/bus somewhere the cursor never was; a couple of pitch units of near-miss
  forgiveness reads as recovering a slightly-off drop, not as the app moving
  something the user didn't ask it to move.

Escape's existing recovery (the pointercancel synthesis above) needed no change for
any of this — the snap search only changes what a REAL pointerup resolves to; a
cancelled drag never reaches it.

### The unbounded search runs ONCE per gesture, at the drop — never per move

The first cut of the above ran `nearestLegalOffset` from inside `#onEndpointMove` /
`#onBusMove` directly — i.e. on EVERY `pointermove`, not just the eventual
`pointerup`. Measured (not hypothesized — a jsdom harness driving real pointer
events against a document with a few hundred wires) that cost ~20-30ms per move once
nothing legal sat within the search's reach of the cursor, which is the ORDINARY case
throughout most of a drag (the cursor spends most of its travel somewhere between the
grab point and the target, not already hovering a legal hole). At 60fps that's most
of two frames' budget on ONE event, repeated for every pixel the mouse crosses — a
real, visible stutter, not a rare edge case. Two compounding costs, both
per-CANDIDATE and both invoked up to ~160,000 times in the search's worst case (the
full 200-ring sweep): `nearestLegalOffset`'s own ring generation/sort (~13ms of pure
overhead for that many rings, independent of what the predicate does), and — far
worse on a wide bus — `canMoveWiresBatch` rebuilding the WHOLE occupancy map from
scratch via `isFreeHole` for every one of a bus's `2 × memberCount` addresses on
EVERY candidate it actually reached (`desk-doc.js`'s `canMoveWiresBatch` now builds
that map once per call instead, but the search still calls it up to 160,000 times a
move without the fix below).

Fixed by splitting the search itself in two, not by walking back the "always find the
nearest, however far" feature: `#onEndpointMove`/`#onBusMove` now call the SAME
resolver but bounded to `SNAP_RADIUS` (cheap — at most 25 candidates) for the LIVE
preview on every move, remembering the exact world point / raw delta that produced it
(`m.lastWorld` / `m.lastRawDx`,`m.lastRawDy`). Only `#onEndpointUp`/`#onBusUp` (bus:
end-handle only) fall back to the ONE unbounded search — and only when the cheap
bounded one came up empty right at the release point — before deciding what to
commit. Functionally identical (a release still always finds the true nearest hole,
however far), but the expensive search now runs at most once per gesture instead of
once per pixel of cursor travel. `wire-tools.js`'s `SNAP_RADIUS` and `bus-tools.js`'s
`SNAP_RADIUS` each picked up this second job (their doc comments spell out both uses)
rather than adding a differently-named twin constant for the same value.

### The drop is resolved at the RELEASE point, not at the last pointermove

Reported symptom: dragging a wide bus off the breadboard and letting go over bare
background lost the drop roughly a third to a half of the time. Two independent causes,
both structural, both fixed here.

**One: the commit replayed a stale sample.** `#onBusUp` (and `#onEndpointUp` /
`#onWholeUp`) committed whatever the last `pointermove` had resolved — `m.moves` /
`m.hover` / `m.target` — and never looked at the release event's own coordinates.
Pointer moves are coalesced, so that sample can be frames behind the cursor; a stale
sample that happened to sit somewhere illegal made the whole drop silently revert, and
one that sat somewhere legal committed at a delta the pointer had already left. All
three up-handlers now re-resolve from `releaseWorld(deskView, e, fallback)` — the
event's own position, falling back to the last move's only for the synthetic aborts
that carry none (Escape, a yanked capture, window blur, which never reach a commit
anyway). The per-move search is now purely the PREVIEW, which is all it was ever
suited to be.

**Two: the release had exactly one delivery route and no backstop.** The gesture's
`pointermove`/`pointerup`/`pointercancel` listeners hung on the wire SVG and rode
entirely on `setPointerCapture` succeeding — a best-effort call inside a swallowing
`try/catch` — while app.css turns OFF every hit target inside that SVG for the duration
of a drag (`.desk-viewport--wire-dragging .bus-band-hit`, `.bus-end-handle-hit`,
`.wire--dragging .wire-hit`) and the SVG root's own box is a token 1×1 at the world
origin. So with the capture gone the release hit-tested to `.desk-viewport`, which has
no gesture listener at all: the pointerup went nowhere and the drag stayed live, Escape
the only way out. The new **`components/pointer-gesture.js`** owns this plumbing for
all four wire/bus drags: `beginPointerGesture(target, pointerId, {onMove, onEnd})`
puts the listeners on `window` in the CAPTURE phase (seen whether or not the capture
held), still takes the capture so the MOVE stream keeps flowing off the grabbed shape,
and additionally ends the gesture on `lostpointercapture` and on the window losing
focus — the only two signals the browser gives for "this pointer isn't yours any more"
when no up or cancel is coming. It returns one teardown each handler calls instead of
unwinding listeners inline. Separately, `.desk-viewport` grew **`touch-action: none`**:
without it the browser can decide mid-drag that the movement was really a scroll it
should own, and takes the pointer by firing `pointercancel` — which every one of these
gestures correctly treats as "revert, never commit", so the drop just vanishes,
intermittently, on exactly the trackpad input most likely to cause it.

### Two costs pulled out of the per-move path

Both were what let the preview fall behind the cursor at bus width in the first place.

- **`DeskDoc.prepareWireBatchMove(wireIds)`** returns a `(moves) => boolean` that
  builds the reduced doc + its occupancy map ONCE, and `canMoveWiresBatch` is now a
  one-shot wrapper around it (one implementation, no drift). A bus drag prepares one in
  `#beginBusDrag` and reuses it for every candidate offset of every move — the document
  can't change until the gesture commits, and the commit still re-validates through
  `moveWiresBatch`. Before this, the snap search rebuilt the whole document's occupancy
  — deriving every chip's pin addresses — up to 25 times per `pointermove`.
- **A rigid whole-bus drag no longer re-renders.** `WireLayer.setBusDrag` used to call
  `render()` on every move, rebuilding every wire in the document, listeners and all. A
  whole-bus grab (`end` null) translates its ribbon and every member by the same delta,
  and every path this layer draws is translation-invariant (`wireSag` depends on the
  run, not on where it sits) — so the first move renders the bus at its BASE geometry
  and records the nodes (`#dragShift`), and each later move is one `transform` plus the
  illegal-tint toggle. An END-HANDLE drag moves one side only, which shifts the
  ribbon's centroid and reshapes every lead at both ends; no transform expresses that,
  so it still re-renders.

Also folded in: `#resolveBusDrop` hands back the batch its winning candidate already
built (`{dx, dy, moves}`) instead of the caller recomputing `#busMovesAt` at the
resolved delta.

## Implementation steps

1. **`model/desk-doc.js`** — `buses` array + `nextBusId`; `addBus(name, memberIds)`,
   `updateBus`, `removeBus(id, { cascadeWires })`; a bus-name parser
   (`parseBusName → { base, width, order }`). `normalizeDocument` drops dangling member
   ids and repairs width.
2. **`app/store/migrations.js`** — additive: default `buses: []`.
3. **`catalog/*.js` + `catalog/index.js`** — optional `pinGroups` on chip defs; a
   catalog-integrity test asserting group pins exist and don't overlap.
4. **`components/bus-tools.js`** (new, sibling to `wire-tools.js`) — the `B` tool: the
   two-hole run mode and the pin-tap mode, both emitting a batch `addWire` + `addBus`
   in one doc change. Shares `#mode` through the host facade, like `wire-tools.js`.
5. **`components/wire-layer.js`** — draw the bundle band + name for each bus; band hit
   target selects the bus; member wires keep their own hit strokes.
6. **`components/desk-controller.js`** — mount/route the bus tool; whole-bus drag moves
   all member endpoints that ride a board (reuses the wire whole-drag path per member);
   bus context menu (rename, recolor, unbundle, delete).
7. **`sim/` guard test** — settling a doc is byte-identical whether its wires are bare
   or bundled into buses (buses are inert to the engine).
8. **Tests** — bus name parsing; a run-tap lays width consecutive wires on aligned
   holes; a pin-tap fans to a `pinGroups` run in bit order; delete-with/without cascade;
   shrinking a bus by deleting one member.

## Acceptance criteria

- Naming a bus `D[7:0]` and dragging start→end lays eight wires and one bundle band.
- Tapping that bus onto a chip's `D` pin group wires all eight to the right pins in bit
  order, refusing an illegal landing with a red tint.
- The bundle selects/drags/recolors as one; individual wires still select underneath.
- The netlist and every simulated level are identical to the same wires drawn by hand.

## Constraints

- A bus is metadata; the netlist/occupancy/engine never learn buses exist.
- Wires re-render only on doc change or board drag (bundle band included) — never on
  pan/zoom.
- One hole still holds at most one lead; a bus lays one wire per hole, no exceptions.

## Verify

```bash
make fmt && make lint && make test && make debug
```

In the app: place two chips, define `D[7:0]`, run the bus between their data pins in one
gesture; recolor and drag the bundle; probe bit 3 and confirm it is its own net; delete
the bus keeping wires, then re-bundle them.
