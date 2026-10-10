# 360 — Automatic wire routing

**Prerequisites:** 50 (wires), 110 (strips & groups), 130 (buses), 200 (undo/redo),
260 (the AI compiler's `bestPair` / `wire-crossing.js`), 290 + 340 (the waypoint-carry
rules a routed wire already obeys).

> Numbering note: `features/done/` tops out at **340**; **350** is already claimed by the
> uncommitted CPU-inspector work, so this stage is **360**.

---

## Context

A wire today is a chord. `addWire` stores two **addresses** and a colour, and
`WireLayer` draws a sagging quadratic between wherever those two addresses resolve
(`desk/wire-path.js` `wirePath`). Nothing in the app has ever had an opinion about the
space *between* two holes — `autobuild.js:974-978` says so in as many words: *"The
compiler decides holes; it has no opinion about the path between them."*

The one thing that does look at that space is `model/wire-crossing.js`, and only to
**score** it: the AI compiler's `bestPair` picks between candidate holes with
`distance(a, b) + 20 × crossingCount(a, b, partBoxes, skip)`. Its own comment records
the ceiling that puts on quality (`autobuild.js:1541-1548`):

> *"Not every crossing can be routed away… a real bench routes the lead around the end
> of the chip, **which a straight run between two holes cannot express**. So this is a
> count, not a gate."*

The substrate for expressing it already landed with routed wires (Feature 290's
`WIRE_LAYOUTS`): a wire may carry `layout: "routed"` and up to `MAX_WIRE_POINTS` (20)
free desk-coordinate waypoints, drawn as a straight polyline. Every rule around them —
board drags carrying bends per point, cluster drags translating them, `normalizeDocument`
coercing them, the clip carrying them — is already written and tested. **Nothing
generates them.** `pasteDesign` is the only code path that has ever produced a whole
routed shape, and it only copies one.

This stage supplies the generator.

### What the earlier attempts got wrong

Three attempts exist; one survives read-only in `stash@{1}`. Two failure modes, both
worth stating because they shape the design decisions below:

1. **Routing was treated as an exception.** The stashed `planAutoRoute` switched a wire
   to `"routed"` only when its chord crossed a body or spanned ≥ 4 columns; everything
   else stayed a sagging direct wire. A desk of mostly-sagging wires with a few
   orthogonal ones looks worse than either pure style. **Auto-route converts every
   eligible wire.**
2. **The optimisation target was never written down.** A shortest collision-free path is
   not the goal; a *bench-legible* path is. Section "Cost model" below is the whole
   answer, and it is centralised in one file precisely so it can be argued with.

---

## Goal

One toolbar action that rewrites every eligible wire on the active desktop as an
orthogonal, board-aligned route: inside the boards, around the parts, clear of the other
wires, bundled into shared corridors, with as few bends and as little length as those
allow — deterministically, as **one undo step**, and with a per-wire cost report that
explains why each route is the one that was chosen.

Nothing electrical changes. A waypoint is a drawing; the netlist cannot see one.

---

## Findings that decide the design

These are facts about this codebase, established before any of the choices below.

### F1 — Units line up with the physical problem, exactly

- 1 **world unit** = one breadboard pitch = 0.1 in = **2.54 mm** (`desk-geometry.js:32,38`).
- The wire SVG is in **world px** = units × `PX_PER_UNIT` (10). Waypoints, however, are
  stored in **world units**, quantised to 2 decimals (`desk-doc.js:301`, `wireCoord`).
- So the specified **1.5 mm wire diameter is 0.5906 units**, and the clearance a pair of
  parallel wires needs is `(1.5 + clearance) mm`. With a 0.5 mm clearance that is
  **0.787 units** — *less than one pitch*.

**Therefore the board's own pitch lattice is the finest legal routing grid.** Two wires
one pitch apart clear each other by 1.04 mm; two wires a half-pitch apart overlap. This
is not a tuning choice, it is arithmetic, and it is why the grid below is built out of
the board's real feature lines rather than subdivided.

### F2 — Every wire endpoint is already on that lattice

- Board `x` is snapped to an integer (`placeX`), board `y` to 0.01 (`boardCoord`).
- Grid hole x = `board.x + col` (integer); rail hole x = `board.x + railStartX + k +
  floor(k/5)` — also integer. Row y = `board.y + PIN_ROW_Y[row]`, a 2-decimal constant.
- A brick's `x`/`y` are integers and its terminals are at **integer** offsets
  (`catalog/parts.js:900-901`, deliberately: *"wired terminals land on the global 0.1-in
  lattice"*).

**Consequence:** requirement 6's *"short curved/angled transition to align the wire with a
preferred routing direction"* has nothing to do in this app. Every terminal a wire can
end on is already a node of the routing grid, so a route leaves its hole along a track
with no transition geometry at all. The minimum-bend-radius work is entirely about
**corner fillets** (D7), not about pin escapes.

### F3 — The only non-axis-aligned board is impossible

`canRotate` is true only for `kind === "rail"` (`breadboard.js:113`), and `ROTATIONS` is
`[0, 90, 180, 270]`. Pin-boards are pinned at 0. So every board is axis-aligned in world
coordinates and requirement 3's *"understand the board's orientation rather than assuming
horizontal and vertical are correct"* is satisfied by construction — **board-aligned and
world-aligned are the same thing here.** A rotated rail's holes land on *fractional* x,
which the grid handles because it is built from the actual hole coordinates (D2), not
from an assumed pitch.

### F4 — There is no body rectangle in `model/`

`part-geometry.js` knows pin **extents** only. `wire-crossing.js`'s `boxOf(points, 0.45)`
is a pin extent plus a margin, which is roughly right for a DIP and badly wrong for a
7-segment digit (nine pins along one row, a block standing 7.7 units above them).

The real body rects exist only in the view layer: `chipBox(pkg)` (`chip-view.js:40`) and
`discreteBox(ref, rot)` (`discrete-view.js:114`), both in pitch units with the origin at
pin 1's hole. `model/` may not import `components/`. **The body box is therefore injected**
(D3) — the same seam the stashed attempt reached for, and the right one.

### F5 — Bus members can never be routed

Three independent enforcement sites: the renderer discards a member's `layout`
(`wire-layer.js:364-367`), `wire-tools.js` refuses to grab a member's body or points
(`:344,:349`), and `wire-length.js` measures a member as a ribbon lead before it even
looks at `layout` (`:151-163`). A bus member's shape belongs to its ribbon.

### F6 — 20 waypoints is a persistence limit, not a UI limit

`normalizeWirePoints` **truncates at 20 on load** (`desk-doc.js:352`). A 24-bend route
would round-trip through a file as a 20-bend route joined by a straight segment through
whatever is in the way. So the bend count is a hard constraint on the router (D9).

### F7 — There is no spatial index anywhere

`buildOccupancy` is a flat `Map<address, occupant>` and `isFreeHole` rebuilds the whole
index per call (`occupancy.js:324`). Nothing here can be reused for geometry. The router
brings its own structures, and hoists them once per run.

---

## Design decisions

### D1 — Algorithm: track-grid A\* with negotiated congestion, not "shortest path"

Rejected, with reasons:

| Candidate | Why not |
|---|---|
| Uniform-grid maze router | The y lattice is *not* uniform — 1 pitch inside a row group, 3 across the trench, 2.76 across a dovetail, and board `y` is fractional. A uniform grid either misses hole positions or is subdivided below the 0.787-unit clearance floor (F1), which buys nothing but nodes. |
| Euclidean visibility graph | Produces diagonals. Requirement 3 wants them prohibited, and turn cost has no natural expression on it. |
| Rectilinear Steiner / global ILP | The wires are point-to-point and independent; there is no multi-terminal net to Steinerise (the compiler already resolved fan-out into separate wires). Overkill. |
| Plain A\* on the grid | Fine as the inner loop, **but it is exactly the thing that gives wire A permanent priority over wire B** — requirement 7's stated problem. |

**Chosen:** a *non-uniform orthogonal track grid* (a Hanan-style grid: the classical
result is that an optimal rectilinear path around rectilinear obstacles exists on the
grid of the obstacle and terminal coordinates — our track set is a superset of that, so
the optimum is representable), searched by **direction-aware A\***, wrapped in
**PathFinder-style negotiated congestion** (McMurchie & Ebeling): route everything,
raise a per-edge *history* cost wherever wires contend, rip up and reroute, repeat.

That wrapper is the answer to requirement 7 and it is why the initial ordering is a seed
rather than a verdict. A pure difficulty ordering only decides who wins the first round;
negotiated congestion decides who *should* win, by making a contested edge progressively
expensive for whoever has an alternative until only the wire with no alternative is left
on it.

### D2 — Routing space: the board's own feature lines, filled to the clearance floor

`model/route-space.js` builds, once per run:

- **x tracks** = every distinct world x at which a hole or a brick terminal sits, across
  every board (integers for unrotated strips; fractional for a rotated rail — F3).
- **y tracks** = every distinct world y of a row, a rail line, or a brick terminal.
- **filler tracks** — any gap between consecutive tracks wider than `trackFillMax`
  (1.0 unit) is split evenly into pieces no wider than that. The trench (3.00) gains 2;
  the dovetail margin (2.76) gains 2, at 0.92 each. Filler never lands closer than the
  clearance floor (F1), which `trackFillMax = 1.0` guarantees for every gap the board
  geometry actually produces.
- **corridor tracks** are *derived, never listed*: a track with no hole on it. The trench
  fillers, the dovetail-margin fillers and the top/bottom board margins fall out as
  corridors automatically, and they get a small discount (D5) because a wire there covers
  no tie points. This is bench practice expressed as a property of the geometry rather
  than as a hand-kept list of magic y values.

A node is the intersection of an x track and a y track; an edge joins adjacent nodes on
one track. **No diagonal edges exist**, so requirement 3's "prohibit diagonals" is
structural rather than a penalty — and, usefully, every edge length is `|dx|` or `|dy|`
with no square root anywhere in the cost function, which is half of D10.

Node counts are small: a full 830 kit is 63 x-tracks × ~28 y-tracks ≈ 1 800 nodes. Each
A\* is additionally clipped to a **routing window** (the endpoints' bounding box plus
`searchWindowPad`, expanded and retried on failure), so a six-board desk does not pay for
the whole desk on every short hop.

### D3 — Obstacles: real body rects, inflated by half a wire plus clearance

Obstacle set, all as world-unit rects:

1. **Seated components** — `bodyBox(comp)` injected from the view layer (F4), placed at
   `board.{x,y} + holePosition(anchor) + box.min{X,Y}`. Falls back to
   `boxOf(pinPoints, 0.45)` when the injector returns null, which is honest for an
   unknown ref and correct for a DIP.
2. **Desk bricks** — `{c.x, c.y, ...partDef(c.ref).size}`, the same rect `canPlaceBrick`
   already uses.
3. Annotations are **not** obstacles: a label is not on the board.

Each is inflated by `wireRadius + clearance` = (0.75 + 0.5) mm = **0.492 units**. An edge
is illegal if its segment touches an inflated rect; a node is illegal if it lies inside
one. `segmentHitsBox` (Liang–Barsky, `wire-crossing.js:62`) already does the segment test
correctly — including the corner clips a sampling test misses — and is reused as-is.

Two exemptions, both necessary and both already precedented by `wireCrossings`'s
`skip`/`ownerOf` arguments:

- **The wire's own terminal parts.** A lead leaving a resistor network starts inside that
  network's own body. The parts a wire's two endpoints *belong to* (by node ownership,
  not by "the point falls inside the rect") are lifted out of the obstacle set for that
  wire only.
- **Nothing else.** In particular a chip is a hard obstacle to every wire that does not
  end on it. This is deliberate: a jumper draped over a DIP is the single thing that most
  makes a board unreadable.

The inflation is not cosmetic. A chip body's edges sit at `CHIP_BODY_TOP = -2.55` /
`CHIP_BODY_BOTTOM = -0.45` local (`chip-view.js:56`), i.e. 0.45 pitch clear of rows f and
e. Inflated by 0.492 the body's lower edge stands 1.49 mm short of row d — so a wire can
still run along row d beside a chip, which it must be able to do, and cannot run along
row e through one, which it must not.

### D4 — The legal region, and the two ways out of it

Requirement 1 is a hard constraint, but it cannot be *"inside a board"* full stop,
because a wire legitimately ends on a PSU or clock brick standing off the boards
(`autobuild.js` puts the PSU to the right of the run, by rule). **This is the one place a
stated requirement collides with the existing architecture, and it is resolved by making
the region explicit rather than by weakening the rule:**

```
region = ⋃ boardRect(b)                       entry cost 0     ← rule 1
       ∪ terminalCorridor(t) for each off-board terminal a wire ends on   entry cost 0
       ∪ gapBridge(A, B) between disjoint region components   entry cost gapCrossCost
```

- A **terminal corridor** is the axis-aligned rect from an off-board terminal to the
  nearest edge of the board region, `corridorHalfWidth` wide. It is mandatory (there is
  no other way to reach the terminal), so it is free.
- A **gap bridge** is the same shape between two board groups that do not touch. It is
  *soft* — requirement's own list puts "crossing a board gap when another legal route
  exists" under soft penalties — so it costs `gapCrossCost` to enter and the router takes
  it only when staying on one board is worse by more than that. Dovetailed strips are
  **flush** (`mating.js` requires it), so a mated kit is one region component and needs no
  bridge; a bridge only ever appears between separately-placed groups.

Anything outside `region` is not in the graph at all. There is no penalty for leaving the
board because there is no edge that leaves it.

### D5 — Cost model (the whole optimisation target, in one file)

`model/route-config.js` holds every number. Costs are stated in **pitch-equivalents**, so
"this bend is worth 4" reads as "worth four pitches of extra wire" and the priority order
in the requirements is legible as a set of magnitudes rather than as folklore.

**Hard constraints — not representable in the graph, so not costed at all:**

| Constraint | How it is made impossible |
|---|---|
| Route outside the legal region | No such edge exists (D4) |
| Route through a component body | Node/edge deleted by the inflated obstacle test (D3) |
| Violate minimum wire clearance | Track spacing ≥ clearance floor by construction, plus explicit conflict-neighbour sets where two boards sit closer than that (D6) |
| Terminate anywhere but the connection point | Endpoints *are* grid nodes (F2); the search's goal is the node, not a region |
| Non-orthogonal segment | No diagonal edges exist (D2) |
| More than `MAX_WIRE_POINTS` bends | Escalation, D9 |

**Soft costs:**

| Knob | Default | What it buys |
|---|---|---|
| `lengthCost` | 1.0 / pitch | requirement 8, the *lowest* priority |
| `bendCost` | 4.0 / turn | requirement 7 — ranks above length, so a 3-pitch detour that removes a bend is taken |
| `crossWireCost` | 12.0 / crossing | requirement 4 **and** requirement 14: crossing is allowed, but only when the cheapest alternative is more than ~12 pitches of detour. That single number is the entire "don't make crossings impossible" instruction |
| `overlapCostPerUnit` | 6.0 / pitch | two wires collinear on one track read as one wire — much worse than crossing, and priced per pitch of shared run so a 1-pitch touch is cheap and a 10-pitch shadow is not |
| `bundleBonusPerUnit` | 0.15 / pitch | requirement 5: an edge whose *parallel neighbour track* carries a wire over the same span is **cheaper**, so wires collect into corridors instead of each taking its own private optimum |
| `corridorBonusPerUnit` | 0.10 / pitch | a track with no holes on it (D2) covers no tie points |
| `gapCrossCost` | 20.0 | requirement's soft "crossing a board gap" |
| `overPartCost` | 250.0 | unreachable except in the escalation ladder (D9) |
| `minEdgeCostPerUnit` | 0.75 | the floor after discounts — see below |
| congestion | `presentFactor 1.0`, `historyIncrement 0.5`, `iterations 6` | D8 |

**The one subtlety worth flagging.** `bundleBonusPerUnit` and `corridorBonusPerUnit` are
*negative* costs, and negative edge weights break A\*'s admissibility. They are therefore
implemented as **discounts against a baseline of 1.0**, floored at
`minEdgeCostPerUnit = 1 − (0.15 + 0.10) = 0.75`, and the heuristic is scaled by that same
floor:

```
h(n) = minEdgeCostPerUnit × manhattan(n, goal) + bendCost × minTurns(n.dir, n → goal)
```

which is admissible because no edge can ever cost less than `minEdgeCostPerUnit` per
pitch and no route can turn fewer times than `minTurns`. The floor is a *derived* value,
not a typed one — change a bonus and the floor moves with it, or the heuristic silently
stops being admissible and the router silently stops being optimal.

### D6 — Wire-to-wire: one occupancy structure answers both questions

An occupancy map keyed by `(axis, trackIndex, spanIndex) → Set<wireId>` gives all three
wire-to-wire effects from one structure:

- **same edge, same axis** → *overlap* (`overlapCostPerUnit`)
- **crossing edges at a node** (one wire horizontal, one vertical) → *crossing*
  (`crossWireCost`)
- **parallel neighbour track over the same span** → *bundle discount*

Clearance is not assumed from the grid. Track construction guarantees ≥ 0.787 units
*within* a board, but two separately-placed boards can put two hole tracks 0.05 apart.
So each track carries a precomputed **conflict-neighbour set** — every track within the
clearance floor of it — and an edge consults occupancy on its own track *and* on its
conflict neighbours. That is the geometric clearance test, done once at grid-build time
instead of per-sample: two wires whose *centrelines* never meet still collide if their
1.5 mm bodies do.

Wires the router does not own — bus members (F5), and any wire it failed to route — are
folded in as **static obstacles for crossing purposes only**, by rasterising their drawn
shape (the ribbon lead / the sagging chord) onto the same structure. They are never
blocked, only costed, because they are not the router's to move.

### D7 — Rounded bends, and what that ripples into

Requirement 6 asks for a configurable minimum bend radius, and a real 1.5 mm jumper
cannot turn a mathematically sharp corner. `desk/wire-path.js` gains:

- `filletedPolylinePath(points, radius)` — the same polyline with each interior corner
  replaced by a circular arc, the radius clamped per corner to *half the shorter adjacent
  segment* so a 1-pitch jog never over-rounds (the clamp `outlinePath` already uses at
  `rect-outline.js:211`).
- `filletedPolylineLength(points, radius)` — the matching measurement.

**This is a decision the user has to make, because it is visible outside this feature.**
Fillets change how *every* routed wire is drawn, including ones hand-placed before this
stage, and they shorten each corner by `r(2 − π/2) ≈ 0.43 r`, which moves `wireRunMm` →
`wireCutMm` → the **BOM cutting list**. Both effects are, I think, improvements — the
drawn wire becomes physically buildable and the cutting list becomes more honest — but
they are not confined to the new button. `polylineLength` must be replaced rather than
supplemented: `wire-length.js` is *the one measurement*, and a drawing that disagrees
with the number beside it is the exact failure that file exists to prevent.

Default `bendRadiusMm: 2.5` (≈ 0.98 units, ≈ 10 world px).

### D8 — Ordering, and why it is only a seed

Round 1 routes in a deterministic difficulty order — endpoints with the least free space
around them first, then smallest bounding box, then wire id — because a constrained wire
routed late has nowhere to go. Then rounds 2…`iterations`:

1. Find every edge whose occupancy exceeds capacity (1) or whose conflict neighbours
   contend.
2. Add `historyIncrement` to those edges' persistent history cost.
3. Rip up **every** wire touching a contended edge and reroute it against the updated
   costs, in the same deterministic order.
4. Stop early when a round produces no contention.

History is what removes the first-mover advantage: an edge two wires both want gets more
expensive for *both*, round on round, until the one with a cheap alternative leaves and
the one with none stays. It converges because history only ever rises.

A final **improvement pass** (Phase 5) rips up each wire once more in id order and keeps
the reroute only if the *total* solution cost strictly falls — the requirement's own
suggestion, and the natural place to later add corridor-order swapping (two wires sharing
a corridor whose track assignment scissors) without disturbing anything above it.

### D9 — When there is no legal path

Hard obstacles can genuinely box a wire in — chips seated edge to edge across a whole
board leave no way from the top half to the bottom half except around the ends, and if
those are occupied too, none at all. A router that shrugs is worse than one that says so.
The ladder, per wire, in order, each step recorded in that wire's report:

1. Route with every hard constraint.
2. **Bend budget exceeded** (> `MAX_WIRE_POINTS` interior points, F6): re-run with
   `bendCost × 8`, which buys a straighter, longer route rather than truncating a valid
   one into an invalid one.
3. **No path**: re-run with component bodies demoted from hard obstacles to
   `overPartCost` — a finite 250. This is what a person does when boxed in: they run the
   lead over the chip. It is reported, not hidden.
4. **Still no path**: leave the wire exactly as it is, count it, and name it in the
   summary. `layout` is untouched, so nothing is lost.

### D10 — Determinism

- No `Math.random`, no `Date`, no iteration over a `Set`/`Map` built from unordered input.
- The A\* heap comparator is a **total** order — `(f, then −g, then nodeIndex, then
  directionIndex)` — because a binary heap is not stable and ties are common on a grid
  where many routes are equal-cost. Requirement 18 is a test, not a hope.
- **No square roots in the cost function.** Every edge is axis-aligned, so every length is
  an exact `|dx|`/`|dy|` on the 0.01 lattice; `Math.hypot`'s precision is
  implementation-defined and is kept out of the scoring path entirely (it survives only
  in the difficulty *seed*, where a tie is broken by wire id anyway).

### D11 — What the router does **not** do (v1)

**End re-seating is out, behind a flag.** Moving a wire's end to a different free hole on
the *same electrical node* is electrically free and is the single highest-leverage quality
move available (it is how `bestPair` gets its results, and the stashed attempt's
`redressPass`/`swapPass` were built on it). But it edits **addresses**, not just drawing:
it claims holes through `prepareWireBatchMove`, it changes what the build guide tells you
to plug in, and it is a different kind of change from "the same connection, drawn better".
`reseatEnds: false` ships in the config with the seam in place, and Phase 5 or a later
stage turns it on once the routing half is trusted.

> **Superseded — see "What landed", 23 and 26.** End re-seating shipped, in the two
> forms where it can be shown safe rather than argued for. A **power lead** slides along
> its rail (23): a rail is one node its whole length, and the netlist partition is
> compared before and after to prove the move invisible. A **signal wire** slides within
> its own five-hole column-half (26): those five holes ARE one node, so there is nothing
> to compare. What stays out is a move between DIFFERENT nodes, which is the only kind
> that could change the circuit.

---

## Architecture

Four new pure modules, one new overlay, three edits. No file owns more than one job.

```
model/route-config.js    ~120 lines  every constant + the mm→unit derivations
model/route-space.js     ~350 lines  region, obstacles, tracks, conflict sets, occupancy
model/route-search.js    ~250 lines  direction-aware A* + deterministic heap
model/rail-reseat.js     ~280 lines  the one PRE-pass address change: power leads (23)
model/autoroute.js       ~400 lines  ordering, congestion loop, improvement pass, report
components/route-debug-layer.js ~150 draw region / obstacles / corridors / chosen routes
```

Edits:

- `desk/wire-path.js` — `filletedPolylinePath` + `filletedPolylineLength` (D7).
- `model/wire-length.js` — measure fillets, so drawing and BOM stay one measurement.
- `model/desk-doc.js` — **`setWireRoute(id, points)`** (a whole path in one mutation; today
  a 12-bend route would be 12 `addWirePoint` calls) and **`applyRoutes(routes)`** (the
  batch, snapshot-guarded and rolled back on any refusal, exactly as `pasteDesign` is; a
  plan entry may also carry a moved endpoint, which rides the SAME transaction — the
  waypoints were computed for the new hole).
- `components/desk-controller.js` — `autoRouteWires()`, refusing while `#editingLocked`,
  injecting `partBodyBox` (F4), committing through one `#emitDocChanged("auto-route
  wires")`.
- `components/notification-stack.js` — re-notifying a live key rewrites its words in place
  (progress), and `dismissible: false` for a toast that is a running job's only interface.
- `app.js` + 7 locale files — one desk-tool pill segment.

**The public entry point is one pure function** (plus the same work as a generator, and a
slicing driver over it — item 25):

```js
routeDesk(document, { bodyBox, config, only }) → {
  routes:  Map<wireId, { points, status, bends, lengthUnits,
                         cost: { total, length, bends, crossings, overlap,
                                 congestion, bundle, corridor, gap, overPart } }>,
  reseats: [{ wireId, end, from, to, gain }],   // power leads moved (item 23)
  skipped: [{ wireId, reason }],      // bus member, unresolved endpoint, no path
  diagnostics: { rounds, contendedEdges, ripUps, gridNodes, gridEdges, ms },
}

routeDeskSteps(document, opts)                    // the same work, yielding per wire
routeDeskAsync(document, { …, signal, onProgress }) → Promise<result | null>
```

DOM-free, mutates nothing, testable under `node --test` with documents built in code —
the same discipline `sim/` has had since Feature 90.

**UI.** A one-shot segment in the desk-tool pill (Wire · Bus · **Auto-route** · Fade ·
Probe · Analyzer · Fit · BOM · Schematic · AI), in `editButtons` so it disables while the
circuit runs. It arms nothing and opens nothing — precedent is the Fit segment, which is
also an action. While it works it holds one sticky toast carrying the round count and a
**Cancel** button, and it ends by replacing that toast with the summary ("Routed 58 wires;
2 left direct. Moved 6 power leads to nearer holes on the same rail.").
**Option-click additionally mounts the debug overlay** for that run.

**Debug is deliberately graphical-only.** The overlay draws the legal region, the inflated
obstacles, the corridor tracks, and the chosen routes; it renders **no text**, so it needs
no catalog entries and cannot leak an untranslated string past `make test-i18n`. The
numbers live in the returned report — which is what the tests assert on, and which is the
real debuggability.

---

## Implementation steps

1. **`route-config.js`** — the config object, `mm→units` derivations, and the *derived*
   `minEdgeCostPerUnit`. Test: the floor tracks the bonuses; the clearance floor is under
   one pitch.
2. **`route-space.js`, part 1** — the legal region: board rects, region components,
   terminal corridors, gap bridges. Test: a mated kit is one component; two loose kits are
   two, with a bridge between them.
3. **`route-space.js`, part 2** — obstacles: injected body boxes, brick rects, inflation,
   per-wire terminal exemption.
4. **`route-space.js`, part 3** — tracks: hole/terminal coordinates, filler, corridor
   flags, conflict-neighbour sets, node/edge legality. Test: every hole and every brick
   terminal is a node; no two tracks are closer than the clearance floor without being
   conflict neighbours.
5. **`route-search.js`** — the direction-aware A\* with an injected cost function, the
   total-order heap, `minTurns`, and the routing window. Test: shortest path, turn cost,
   determinism under permuted input.
6. **`autoroute.js`, part 1** — single-wire routing end to end, the cost report, and the
   D9 escalation ladder.
7. **`autoroute.js`, part 2** — the congestion loop: occupancy, history, rip-up, early
   exit.
8. **`autoroute.js`, part 3** — the improvement pass.
9. **`wire-path.js` + `wire-length.js`** — fillets and the matching measurement (D7).
10. **`desk-doc.js`** — `setWireRoute` + `applyRoutes`, snapshot-guarded.
11. **`desk-controller.js`** — `autoRouteWires()`, the `partBodyBox` injector, one undo
    step, the run-lock refusal.
12. **`app.js` + locales** — the toolbar segment and its two strings in all seven
    catalogs.
13. **`route-debug-layer.js`** — the Option-click overlay.
14. **Tests** — the eighteen scenarios below, plus a corpus pass: auto-route every shipped
    demo in `src/web/demos/` and assert no route leaves its region, enters a body, or
    exceeds the bend cap. (The demos are the same free corpus `autobuild-corpus.test.js`
    already exploits, and they need no API key and no network.)

---

## Acceptance criteria

The eighteen required scenarios, as named tests:

| # | Scenario | Asserted |
|---|---|---|
| 1 | Two nearby pins | 0 bends, collinear |
| 2 | One 90° bend needed | exactly 1 waypoint |
| 3 | Multiple bends | route legal, bend count minimal for the geometry |
| 4 | Component directly between | route clears the inflated body; the chord does not |
| 5 | Narrow corridor between components | routed through it, clearance held |
| 6 | Two wires, no crossing needed | zero crossings |
| 7 | Two wires, crossing unavoidable | exactly one crossing, reported in the cost |
| 8 | Several parallel wires | adjacent tracks, no overlap, bundle discount applied |
| 9 | Near a board edge | stays inside `boardRect` |
| 10 | Between two mated boards | no bridge used (they are one region component) |
| 11 | Must cross a gap between groups | bridge used, `gapCrossCost` in the report |
| 12 | Short route crosses a part, longer one does not | the longer one is chosen |
| 13 | Short route crosses a wire, slightly longer does not | the longer one is chosen |
| 14 | Avoiding a crossing needs a ridiculous detour | the crossing **is** taken |
| 15 | Several wires where order would matter | same solution from any input permutation, and no wire is starved |
| 16 | Very close components | clearance held; the too-narrow gap is not used |
| 17 | Leaving a pin toward a routing direction | terminates exactly on the endpoint address (F2 — no transition needed) |
| 18 | Multiple equally valid routes | byte-identical output across runs and across input permutations |

Plus:

- Every route's endpoints resolve to the wire's own `from`/`to` addresses, as the run
  LEAVES them. Two kinds of end move: a power lead's rail end (item 23), only within its
  own net and only when the netlist proves the move invisible, and any end within its own
  five-hole node (item 26), where the node is the proof.
- The netlist before and after auto-route is identical, over every shipped demo — and, for
  the reseating specifically, over every fixture in `rail-reseat.test.js`.
- No route passes through a tie point that has a lead in it, asked of the document as the
  moves LEFT it, not as the router found it.
- Cancelling mid-run leaves the document byte-for-byte as it was, and a plan computed
  against a document that has since changed is dropped rather than applied.
- Auto-route then undo restores the document byte-for-byte.
- Bus members are untouched.
- No route exceeds `MAX_WIRE_POINTS` interior points.
- `make test` and `make test-i18n` pass.

---

## Constraints

- Pure/DOM-free model modules with sibling tests; views stay thin.
- No new runtime dependency (`electron-updater` remains the only one).
- One doc mutation, one undo step, refused while the circuit runs.
- Nothing electrical may change: waypoints are drawing only.
- No architectural change outside this feature. In particular, moving `discreteBox`'s
  `BOXES` table into the catalog — arguably where a body rect belongs — is **not** part of
  this stage; the injector (D3) is the seam that keeps the layering honest without it.

---

---

## What landed, and where it differs from the design above

The design survived implementation; five things were learnt building it, and each
changed the code rather than being written around.

1. **A pressure ramp was needed, and it was the single biggest quality win.**
   Enforcing congestion hard from round 1 freezes in whatever the first arrival
   did. Ramping the present-congestion term across rounds (`pressureRamp`) — so
   round 1 routes as if the board were empty and the squeeze comes on afterwards
   — took doubled-up wire across the corpus from **2.49% of routed length to
   0.69%**, where it is now flat against every other knob: what remains is a
   dense channel with more signals than free rows, and no cost model removes it.
   History is also bumped in proportion to the OVERUSE rather than by a flat step.

2. **`overloadCost` is 25, not 6.** At 6 a pitch of doubled-up wire was worth
   less than two bends, so the router cheerfully stacked wires rather than turn a
   corner. The trade it exposes is real and worth stating: forcing wires apart
   makes them **swap order instead**, so corpus crossings rose from 552 (as
   chords) to ~717 while segments running over a part fell from 355 to **6**.
   Clearance is a hard constraint and crossings are explicitly soft, so this is
   the right side of that trade — and crossings are precisely what `reseatEnds`
   (D11) would improve, since swapping which hole each wire lands in removes the
   need to swap order mid-channel.

3. **Wires the router does not own are TERRAIN, not empty space.** The design
   mentioned this in passing; it turned out to be load-bearing. Bus members, and
   every wire outside an `only` selection, are rasterised onto the grid by
   proximity before any routing starts — otherwise "auto-route the selection"
   lays every new run straight over the wiring already there.

4. **A chip's obstacle is its BODY SLAB, not `chipBox`.** `chipBox` reaches 0.6
   pitch past rows e and f to make room for the drawn legs; inflate that by a
   wire's clearance and row d — the row every wire on a chip's lower node leaves
   from — closes up, making a seated chip unwireable. `chip-view.js` gained
   **`chipBodyBox`** for the plastic alone. The legs need no allowance: each
   stands in its own pin's hole, which is already spoken for.

5. **The bend radius is 0.75 mm — a 1.5 mm turn diameter — not the 2.5 mm the
   design guessed at.** This one shipped wrong and had to be corrected against a
   real board. A tangent circle meets each leg `radius / tan(θ/2)` from the
   corner, which at a right angle is exactly the radius, so the fillet eats that
   much off BOTH legs. At 2.5 mm that is 0.98 pitch a side: a one-pitch segment
   between two corners was consumed entirely, every turn took two pin spaces,
   adjacent runs bulged into each other at their corners, and it stopped being
   possible to see which wire had turned away and which carried on. At 0.75 mm
   the bite is 0.3 pitch. `tests/wire-path.test.js` pins it — a one-pitch jog
   must still come out with real straight line between its two arcs.

6. **A fillet must refuse a corner too sharp to round.** A circle tangent to both
   legs touches them `r / tan(θ/2)` from the apex, which runs away as the corner
   sharpens: on a hairpin the tangent points land at the far ends of both legs and
   the "rounded" path cuts straight across, deleting half the wire. Bounding the
   arc's DEVIATION from the apex instead makes the test purely one of angle (the
   radius cancels) and lands at about 29° — far below anything an orthogonal
   route produces, and above the fold a hand-placed hairpin makes.

7. **Collinear run is removed pairwise, not globally.** A hardening pass lifts
   each wire out and offers it a route that may not share an edge with the wires
   it is currently doubled up with. Forbidding sharing with *every* wire was
   tried first and failed 14 times out of 14 on one board — with every other run
   pinned, a wire cannot even leave its own hole. Acceptance is on shared LENGTH,
   strictly, because a reroute that trades one doubled-up run for another is not
   progress and accepting it lets the pass cycle. It takes collinear run down by
   about 5%; the rest is structural (a channel with more signals than free
   tracks), and **`reseatEnds` is the lever for it** — moving a wire's end to
   another free hole on the same node removes the contention at source instead of
   routing around it.

8. **Charging a wire for running over another's end cap was tried and rejected.**
   It bought 4% less collinear run and cost **107 extra crossings** (720 → 824)
   corpus-wide. Recorded here because the idea is an obvious one to have again.

9. **Every wire gets its own plane, because the lattice cannot give it one.**
   The routing grid IS the board's hole lattice, and its lanes are one pitch
   apart because that is the finest spacing 1.5 mm wire can clear. A dense board
   has fewer lanes than wires, so runs MUST share one — and two runs on one lane
   land on exactly the same line: they draw as a single wire, and where one turns
   off there is nothing to say which did. **No routing cost fixes this.** Raising
   the overlap penalty twentyfold (25 → 500) moved the count on one board from 20
   collinear pairs to 22; widening the search window twentyfive-fold moved it to
   19. The alternatives are genuinely worse, and the cost model was proving it
   correctly — the same two wires separate perfectly in isolation.

   A real board does not have the problem because real jumpers **arch at
   different heights**: looking down on a well-wired bench, no two wires are ever
   exactly collinear, and each leaves its hole at a slight angle before settling
   parallel to the board. `separateLanes` is that in two dimensions — the runs
   sharing a lane are fanned either side of it, a straight wire with no corner to
   nudge is given a shallow bow instead, and **the ends never move**, so a wire
   still terminates exactly on its hole and picks up the short angled lead-in the
   routing requirements always allowed for. The fan stays inside the clearance an
   obstacle was already inflated by, so a nudged run cannot be pushed into a part.

   Collinear run corpus-wide: **156.5 pitch → 4.0** (0.71% → 0.02%). The stated
   cost is that fanned runs sit 0.4 pitch apart rather than a full pitch, which
   is under the clearance floor — deliberately, because that floor describes two
   wires lying in one plane and these do not.

10. **The routing grid is HALF a pitch, not one.** The hole lattice gives one
    lane per pitch (2.54 mm) — the coarsest grid on the board — and a dense desk
    has more wires than that has lanes, so the surplus had nowhere to go but on
    top of another wire. The fix needed one conceptual separation: `clearanceMm`
    is what a wire needs from a PART and stays tied to the wire's own width,
    while `laneSpacingMm` (1.2 mm) is what two RUNS need to read as two runs, and
    is deliberately smaller — because wires arch at different heights and a real
    bench runs them closer than their own diameter all the time. Tying the two
    together is what pinned every lane to the hole lattice. Half-pitch tracks
    improved **every** measure at once: crossings −26% (722 → 533, now below even
    the straight-chord baseline of 552), total length down, bends down, collinear
    run down. It costs time — 38 ms → 151 ms a board — which is nothing for a
    button. Filler is additionally capped so no two tracks land closer than
    `minSeparation`, or the extra lanes would be unusable and merely make the
    grid bigger.

11. **The hardening pass was comparing against a STALE cost.** A route's cost was
    recorded when it was laid — part-way through a round, against a board holding
    only the wires placed before it. By the time the pass ran the board was full
    and that wire might since have been crossed six times, but the recorded
    number knew nothing about it, so a plainly better route was refused. Every
    comparison now re-prices the route the wire already has under the CURRENT
    occupancy (`costOfPath`). On its own this took corpus crossings from 777 to
    722, and it is the fix for "this wire is crossed six times when one row over
    would have crossed once".

12. **The air between two boards is not a short cut.** A bridge exists so a wire
    can get from one board to another, but ANY wire could use it — and the gap is
    the cheapest real estate on the desk (no holes, so it drew the corridor
    bonus; no parts, so nothing was in the way). Congested wires dived off the
    board, ran along the gap and climbed back on. A wire may now enter a bridge
    only when its two ends are on different board groups, or one of them is a
    brick standing off the boards altogether — a hard constraint, which is what
    rule 1 asked for. A per-pitch `gapCostPerUnit` backs it up for the wires that
    legitimately do cross.

13. **A tie point with a lead in it is NOT free space.** The router treated
    every hole as air, so it would run a wire straight down a row of end caps —
    physically impossible, since the lead standing in that hole is in the way,
    and the single most obviously wrong thing it did. Occupied holes now come
    straight from `occupancy.js`'s map (the app's one collision authority, so the
    router cannot disagree with it about what is occupied) and are hard obstacles;
    a wire's own two ends are exempt, and the escalation ladder can relax them for
    a wire that would otherwise have no route at all.

    It costs crossings — 533 → 680 — and that number is the honest one: the 533
    was achieved by passing through holes that were not passable. It also raised
    bends per wire from 1.80 to 2.06, which is what dodging a lead looks like. It
    is what makes the half-pitch grid earn its keep, because the lane BETWEEN two
    rows of holes is now the natural place to run.

14. **The grid is 1.1 mm.** `laneSpacingMm` sets it. Note the interaction: between
    two rows a pitch apart, two lanes at 1.27 mm is all 1.1 mm spacing allows, so
    the finer setting bites hardest across the wider gaps — the trench and the
    dovetail margins — rather than between rows.

15. **Three hardening passes is the asymptote.** Measured 1 / 3 / 6 / 10 passes:
    308 / 293 / 292 / 292 crossings. And raising `crossWireCost` makes crossings
    WORSE, not better (12 → 25 → 40 gives 292 → 312 → 315), because avoiding one
    crossing lengthens a route into two more somewhere else. Recorded because it
    is the obvious knob to reach for and it points the wrong way.

16. **The negotiation keeps the BEST round, not the last.** PathFinder's rounds
    are not monotonically better — history rises to break deadlocks, and a later
    round can trade a good solution for a worse one that merely happens to be
    legal. Keeping whichever round came last is how a wire ends up going the long
    way round for no reason anybody can point at. Each round is now scored by the
    same cost every route in it was chosen by, and the best is kept: crossings
    680 → 662, for no extra time.

17. **THE SEARCH WINDOW WAS SILENTLY COSTING QUALITY, and it was the biggest
    single defect of the lot.** Each search was clipped to the endpoints'
    bounding box plus a margin, widened only when the search came back EMPTY. A
    route that is merely *worse* inside the window is still a route, so the
    widening never fired — and a far better path just outside was never
    considered at all. Caught by re-routing one real wire two ways: inside the
    window it cost **200** and crossed seven wires; with the window opened there
    was a route round the end of the board costing **116** that crossed nothing.

    The window is gone. A* with an admissible heuristic already declines to
    explore what it does not need; a box drawn round the endpoints was
    second-guessing it, and guessing wrong. On the desk it was found on, that one
    wire went from 9 bends and 12 crossings to 5 and 2, and the whole desk
    converged in 3 negotiation rounds instead of 8. It costs time — a 76-wire,
    three-board desk takes about 5 s — which is the one number here worth
    revisiting if it ever becomes annoying.

18. **A wire may cross only the gaps between its OWN two boards.** `allowBridge`
    was a single yes/no, so a wire spanning boards 1 and 2 was equally free to
    dive into the gap below board 3 and run along it — empty, part-free and
    hole-free, so much the cheapest ground on the desk. `bridgeMaskFor` walks the
    graph of board groups joined by gaps and opens only the ones on a shortest
    path between the wire's own two, plus the corridor out to a brick terminal
    when one of its ends is off the boards altogether.

19. **The report's `total` is re-priced.** It used to be the cost the search paid
    when the wire was laid, printed beside a breakdown computed against the
    finished board — so the parts could exceed the whole and the debug output
    could not be reasoned about. Both now come from the same occupancy.

20. **The grid is 0.85 mm — THREE lanes to a pitch.** Two, at 1.27 mm, could not
    fit a pair of runs through the gap between a chip's upper legs and the wires
    leaving the row above, which is a gap a real bench threads two wires through
    routinely. Three can. Corpus crossings fell again, **645 → 530**, with length
    and bends both down and doubled-up run at zero. There is a floor here: the
    lane spacing must stay under `MM_PER_UNIT / 3`, or the third lane cannot
    exist.

21. **The search's scratch is REUSED, stamped rather than cleared.** Three boards
    is ~40 000 nodes, so the per-state arrays are the better part of two
    megabytes; allocating and zeroing them once per wire per round was real time.
    A generation stamp makes "unvisited" a comparison instead of a memset. It is
    behaviour-neutral — identical routes, identical metrics — which is how it was
    checked. A COST-BOUNDED two-stage search was tried alongside it (a windowed
    incumbent bounding a full search) and made things WORSE, not better: two
    searches cost more than the bound saved. Reverted; recorded because it is a
    textbook optimisation that does not pay here.

22. **A long route now says so before it starts.** Routing a large desk is
    seconds of solid computation on the main thread — a 76-wire, three-board
    project takes about ten — and an app that stops repainting with no
    explanation reads as one that has crashed. The action posts a "Routing…"
    notice, yields long enough for it to paint, and replaces it with the result.
    **This is the number to revisit first** if the feature ever feels slow; the
    honest fix is to move the router off the main thread, not to make it search
    less, since every attempt to make it search less has cost quality.

23. **A POWER LEAD'S RAIL END IS MOVED — the one address the router changes.**
    Everything above is a drawing; this is not, and it is here because no
    drawing could fix what it fixes. Move a part and its SIGNAL wires ride with
    it (Feature 290's node rule); its power leads end on a rail hole belonging
    to no node the part occupies, so they stay put and stretch. A desk that has
    been edited for a while ends up with supply wires crossing the whole bench,
    and the router can only draw the best path between two holes — one of which
    is in the wrong place. `model/rail-reseat.js` moves it, before any routing,
    under three rules (its own header argues each): the wire's OTHER end must
    not be on a rail, so the rail-to-rail SPINE never slides into the middle of
    the board; the target must be a free hole on a rail line in the same
    **wiring-only** net, so a switch thrown to a rail cannot invent a
    connection; and the whole plan is checked by comparing the netlist
    partition before and after, which is what catches the case rule 2 cannot —
    the moving wire being itself the only path between the two rails, so that
    landing on one orphans the other. A move that fails is dropped, never
    degraded into a different one.

    On the desk this was written for (a 65xx + LCD build, 63 wires over four
    dovetailed boards) six leads moved, saving **302 pitch** of Manhattan reach
    before a single route was drawn, and the routed result came out at 568 cm
    against 679 cm and 193 bends against 238 — **−16% wire and −19% bends**,
    from an address change alone. Across the demo corpus it barely fires (16
    leads, 64 pitch), which is the expected answer: those circuits are compiler
    output and `autobuild.js` already puts every supply lead where rule 3 of
    "Power layout" says it goes. This is a repair for desks people have edited.

24. **The escalation ladder was abandoning at the rung written for the job.**
    A route that came back over the twenty-waypoint cap did `break`, not
    `continue` — so it left the ladder entirely instead of falling through to
    rung 2, whose whole purpose (`bendCost × 8`, D9) is to buy a straighter,
    longer route for exactly that wire. The wire was then reported as having no
    legal path at all. Invisible across the corpus, which never needs rung 2;
    found because reseating tightened one real board enough to produce a
    twenty-one-corner route.

25. **Routing is written once and driven twice, so it can be cancelled.**
    Eighteen seconds on the desk above, on the main thread. The negotiation is
    now a GENERATOR (`routeDeskSteps`) that yields once per wire; `routeDesk`
    runs it to completion synchronously — what every test and the corpus use,
    byte-identical to before — and `routeDeskAsync` runs it in ~24 ms slices,
    yielding to the host between them (`scheduler.yield()`, else a
    `MessageChannel` hop, never a nested `setTimeout` and its 4 ms clamp). Two
    drivers, one implementation; the alternative is a second copy of the
    negotiation loop that can silently disagree with the first. The clock is
    read only to decide when to let go of the thread, never what to do next, so
    D10's determinism is untouched — a slow machine and a fast one get the same
    routes.
    - **A cancel has nothing to put back.** The whole plan is computed off the
      document and applied in one `applyRoutes` at the end, so aborting simply
      throws the plan away; "restore the original wiring" is a property of the
      shape, not a code path that could be got wrong. The Cancel button lives on
      the progress toast, which is therefore the one toast in the app that a
      stray click does not dismiss (`dismissible: false`) — losing it would
      leave an eighteen-second job running with no way to stop it.
    - **The desk stays live, so a stale plan is possible and is dropped.** A
      board dragged mid-run leaves the waypoints drawn around a part that has
      moved. The controller compares the document before and after and bins the
      plan rather than drawing it — `applyRoutes` would refuse an *impossible*
      one anyway; this is for the possible-but-wrong ones.

26. **A WIRE'S END MAY SLIDE WITHIN ITS OWN TIE-POINT STRIP, and this is the
    largest single quality win in the feature.** Item 23 moves a power lead
    along its rail; this is the same idea at the scale a SIGNAL wire has. The
    five holes of a column-half are not merely the same net, they are the same
    NODE — one strip of copper inside the board — so a lead moved from `a12` to
    `d12` is connected to exactly what it was, and unlike the rail case there is
    nothing to verify, because no wiring anywhere on the desk could make it
    false. What it buys is which ROW a lead leaves from, and since learning 13
    made every occupied hole a hard obstacle, that is the difference between a
    run that threads out past its neighbours and one that has to climb round
    them.

    `swapEnds` runs LAST, after hardening, so it is not spending swaps on
    improvements the passes above were about to make anyway. It offers each wire
    the free holes of each end's node, ONE END AT A TIME (the cross product of
    two five-hole nodes is twenty-five searches a wire; moving each end in turn
    finds nearly all of it for a quarter of them), and keeps a swap only when
    the route is strictly better. Three guards stop it trading one defect for
    another: a lead is never planted in a node another route (or any terrain)
    is drawn across; the escalation rung may not get worse (an over-part route's
    price is not in `costOfPath`, so a cost comparison alone would happily buy
    one); and collinear run may not grow, or this pass and the hardening pass
    above would fight.

    Corpus-wide: **crossings 1 048 → 230 (−78%)**, bends per wire **1.98 →
    1.41**, total run −13%, 888 leads moved. Against the straight-chord baseline
    the orthogonal routing now costs **+17%** of wire rather than +39%. On the
    real four-board desk of item 23: 679 cm / 238 bends / 440 crossings with no
    moves at all, 571 / 200 / 454 with the rail reseat, **507 / 182 / 204** with
    both — a quarter less wire and half the crossings.

    It is also the most expensive pass here — one search per free alternative
    per end — and it is where the run time went: the corpus takes 18 s with it
    off, 30 s at one sweep and 38 s at two. Two is the shipped setting; a third
    is 44 s to take crossings 230 → 208 with bends no longer falling.

    - **The plan it produces is order-independent, and that took a `vacated`
      set.** A swap frees the hole it came from and the next wire along would
      take it, but the document is written one endpoint at a time and
      `setWireEndpoint` refuses a hole the previous occupant has not left yet.
      Ordering a chain of moves would still leave the cycle (two wires wanting
      each other's holes, neither able to go first), so a vacated hole is simply
      never offered to anyone else — the same discipline `rail-reseat.js` keeps
      by only claiming holes free in the original document.
    - **A wire that moves BOTH ends records both.** The first version kept one
      `moved` slot, so a wire that swapped its `from` and then its `to` applied
      the first silently: the route was drawn for a hole the wire was never
      moved into, and the hole it still occupied looked free to everyone else.
      Caught by `applyRoutes` refusing the plan on the third sweep, which is
      exactly what that refusal is for.
    - **The eighteen scenario tests now pin their endpoints** (`FIXED_ENDS` in
      `autoroute.test.js`). They ask what path the router chooses between two
      given holes, and with the ends free it answers a better question instead —
      scenario 2's one-corner geometry becomes a dead straight run. A test that
      cannot tell "wrong" from "improved" is no test. The shipped configuration
      is exercised end to end by the corpus, which additionally now checks that
      every route ends exactly on its wire's FINAL address and that no route
      passes through a hole occupied in the FINAL document.

**Measured over the 52 shipped example circuits** (`autoroute-corpus.test.js`,
no API key, no network): 1 285 wires routed, 0 skipped bar bus members, **1.41
bends per wire**, **0%** of run doubled up (fanned lanes, above), segments over a
part **355 → 6**, total wire length **+17%** against the straight chords
(orthogonal runs are longer — Manhattan against Euclidean is up to 41% worse on a
diagonal), ~720 ms per board, and byte-identical output — paths AND moved
addresses — across repeated runs and reversed wire order.

## Verify

```bash
make test          # unit + corpus + license headers
make test-i18n     # the two new toolbar strings, in all seven catalogs
make debug         # place a kit, seat three chips, wire them, press Auto-route
```

By hand: Auto-route, then ⌘Z — the desk returns exactly as it was, moved power leads
included (one mutation, one undo step). Auto-route with the circuit running — the segment
is disabled. Option-click Auto-route — the debug overlay shows the region, the bridges,
the hole-free lanes and every obstacle AS INFLATED, the gap between an obstacle's drawn
edge and its inflated one being exactly one wire's clearance. A second Option-click clears
it.

On a big desk (~60 wires over four boards, about twenty seconds): the toast counts its
rounds while it works and the window keeps repainting. Press **Cancel** — routing stops
and the wiring is exactly as it was, because nothing had been written. Drag a board while
it runs — the plan is dropped and says so rather than drawing routes around a part that
has moved.

Also by hand, for the end moves: drag a wired chip to a different board, so its supply
leads stretch across the desk, then Auto-route. Each lead lands on the nearest hole of a
rail that is *actually* connected to the one it left (a rail-to-rail bridge is what makes
the near strip the same net — remove the bridges first and the leads stay where they
are). The rail-to-rail spine itself never moves. A signal wire's end may shift a row or
two WITHIN its column — that is the swap pass, and the tie-point strip it sits in is the
connection, so it is the same hole electrically. Probe any net before and after: the
netlist is the same netlist.
