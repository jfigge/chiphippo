# Feature 110 — Breadboards as strips, and snap groups

## Context

Today a breadboard is one atomic entity: `{ id, type, x, y }` in `doc.boards`, with
`type` one of `full` / `half` / `tiny`, and all four power rails baked into the spec
(`board-types.js:54-59`). Rails are atomic at every layer — one `{id, y, polarity}`
object, one node id from `nodeOf`, one stripe rect in `buildBoardSvg`, one contiguous
hole run from `railHoleX`.

Real breadboards are not atomic. They are three snap-together parts: a top power-rail
strip, a centre pin-board, and a bottom power-rail strip. Every part has the same
dovetail on each edge, so any part mates with any other of matching size and
orientation. Two boards pushed together become one physical unit; two boards stacked
so their rails coincide share a single rail.

This stage rebuilds the breadboard out of those parts, and makes snapped parts drag as
one. It deliberately stops short of proximity snapping and rail absorption — those are
Feature 120, and they become nearly free once this lands.

Prerequisites: Features 20, 30 (board model, rendering, placement, drag).

## Goal

Delete the monolithic breadboard. A "breadboard" becomes a **kit** — a preset group of
strips placed in one user action. Strips already snapped together move together on
drag, exactly as seated chips ride a board today.

## Design decisions (settled)

### Strips stay in `doc.boards`

A strip is a board with a narrower spec. Keeping strips in the existing `boards` array
with existing `bb<n>` ids means `breadboard.js`, `occupancy.js`, `netlist.js`, the
whole `sim/` package, and `buildBoardSvg` need **no changes** — they are already
generic over the spec table. This is the single most important decision in the stage:
it converts what looked like a rewrite into a spec-table change plus a migration.

### Five specs replace three

| key | width | height | cols | rails | rail holes |
|---|---|---|---|---|---|
| `pins-full` | 65 | 14 | 63 | — | — |
| `pins-half` | 32.3 | 14 | 30 | — | — |
| `pins-tiny` | 17.7 | 14 | 17 | — | — |
| `rail-full` | 65 | 4 | — | `+` @1, `−` @2 | 50, start x 3 |
| `rail-half` | 32.3 | 4 | — | `+` @1, `−` @2 | 25, start x 2 |

All three pin-boards share today's **tiny** row map (`j:1…f:5`, `e:8…a:12`,
`trench.centerY: 6.5`) — it is already the centre-strip layout. They differ only in
`cols` and `width`.

A rail strip carries **both** polarities, `+` and `−`, because that is the real part.
Its holes are `+7` / `-7`, so `parseHole`'s rail regex loosens from
`/^([tb][+-])([1-9]\d*)$/` to `/^([+-])([1-9]\d*)$/`. Node ids from `nodeOf` become
`"+"` / `"-"` — board-local, so nothing downstream cares.

### Kits

```
full:  rail-full @(0,0) · pins-full @(0,4) · rail-full @(0,18)
half:  rail-half @(0,0) · pins-half @(0,4) · rail-half @(0,18)
tiny:  pins-tiny @(0,0)
```

Offsets reproduce today's rail rows exactly (top `+` at y=1, bottom `+` at y=19).
Stacked height is 22 vs today's 21.7 — a 0.76 mm difference that buys integer origins
for every strip, preserving the "all holes on the global 0.1-in lattice" invariant.

**Tiny has no rails** (`board-types.js:118` already encodes this), so its kit is one
strip. The real 170-point part has no rails to give it.

### Groups

Each board entry gains `group` — a `g<n>` id from a persisted `nextGroupId`, or `null`
for an ungrouped strip. A group is implicit: the set of strips sharing an id. No
`groups` array, nothing to keep in sync, and `removeBoard` needs no cascade beyond
what it already does.

Drag moves every strip sharing the dragged strip's group, as one rigid translation.
`canPlace` validates the whole group's rects against non-members.

Breaking a group apart is **not** in this stage — a kit placed today cannot yet be
separated. Feature 120 introduces both the joining gesture and the separating one
together, so they can be designed as a pair.

### Parts belong to the pin-board; leads may reach off it

A part is **always** seated on the centre pin-board — `comp.board` never names a
rail. But splitting the rails off broke something that used to work: a rotated
resistor or LED could put one leg in a power rail and the other in a grid row, because
both holes belonged to one board. That is the ordinary pull-up/pull-down gesture, and
it must survive.

So a rotated part's free lead stops being a hole id and becomes a **`{dx, dy}` bend**
from the anchor hole. Which hole it touches is resolved geometrically, against
whatever strip lies under it (`occupancy.js` → `addressAtWorld`, `partPinAddresses`).
Consequences, all of them wanted:

- The lead may land on a neighbouring strip — a rail — with no per-lead board field.
- Pull the rail away and the part **stays exactly where it is**; the lead resolves to
  `null` and floats, like a real leg with nothing under it. `removeBoard` therefore
  keys on `c.board` (where a part is *seated*) and never on where a lead *lands*.
- Slide a rail back under it and it reconnects.
- Floating is a state you fall into, never one you can place into: `canPlacePart`
  still requires every lead in a real hole.

The cost, recorded honestly: occupancy is no longer independent of board positions.
Moving a strip can now change what a bent lead touches. That was previously an
invariant (`moveBoard` needed no occupancy revalidation) and it is now false for
rotated two-terminal parts only.

### Migration v1 → v2

Each `full`/`half` board becomes three strips (tiny becomes one), sharing a fresh
group:

- `bb1.t+7` → `<top>.+7`, `bb1.t-7` → `<top>.-7`
- `bb1.b+7` → `<bottom>.+7`, `bb1.b-7` → `<bottom>.-7`
- `bb1.a12` → `<pins>.a12`
- components' `board: "bb1"` → `<pins>` (parts seat only in grid rows)
- a rotated part's `end: "b-3"` → `{ dx, dy }`, measured in the v1 frame

The kit offsets (rail 0 / pins 4 / rail 18) were chosen so every hole keeps its
position relative to the board origin. That is what makes the lead conversion exact —
a delta measured in the v1 frame is still correct in v2 — and it is asserted directly
in `app/tests/migrations.test.js`.

`migrations.js` carries its own frozen copy of the v1 geometry rather than importing
the live specs: a migration describes an old schema, and the real specs now describe
strips and will keep moving.

Component **anchors are hole names**, not coordinates, and row letters are unchanged
on a pin-board — so anchors migrate untouched. Wire endpoints are already addresses,
so they rewrite by string substitution.

## Implementation steps

1. **`model/board-types.js`** — replace `BOARD_TYPES` with the five strip specs;
   add `BREADBOARD_KITS` (size → array of `{ type, dx, dy }`) and `KIT_KEYS`.
   Keep `BOARD_TYPE_KEYS` as the strip keys for validation.
2. **`model/breadboard.js`** — loosen the rail regex; confirm `nodeOf`,
   `holesOfNode`, `holeAt`, `holePosition` need no other change. Update the module
   comment's layout diagram.
3. **`model/desk-doc.js`** — add `group` to the board shape and `nextGroupId` to the
   document; `addKit(kitKey, x, y)` placing a grouped set atomically (all-or-nothing
   overlap check); `moveGroup(groupId, dx, dy)`; `groupOf(id)` / `boardsInGroup(id)`.
   `normalizeDocument` validates/repairs `group`.
4. **`app/store/migrations.js`** — `DESK_DOC_VERSION = 2` and the v1 step above.
5. **`components/desk-controller.js`** — board drag collects the group and translates
   all members (`#onBoardPointerMove` at :1655, commit at :1672); ghost preview and
   `addBoardAt` go through `addKit`; `#repositionBoardParts` and the `WireLayer`
   override map handle multiple ids per drag.
6. **`components/board-toolbar.js`** — the Add menu offers kits, not strip types.
7. **Tests** — spec integrity (tie-point counts still 830/400/170), the rail-hole
   regex, kit geometry (strips abut, no overlap, integer origins), group drag keeping
   relative offsets, and a migration fixture round-tripping a v1 doc with wires on
   both rails and a chip on the grid.

## Acceptance criteria

- Adding a full or half breadboard places three strips that look identical to today's
  board and drag as one unit.
- Adding a tiny breadboard places one pin-board.
- An existing `desk.json` at v1 loads with every wire, chip, and discrete still
  attached to the right hole.
- Tie-point counts remain 830 / 400 / 170 per kit.
- Every strip origin is an integer; every hole stays on the global lattice.
- Nothing under `sim/`, `occupancy.js`, or `netlist.js` changes.

## Constraints

- No per-hole DOM; `buildBoardSvg` stays built-once per strip.
- Addresses remain the only cross-module currency for holes.
- Pan/zoom must still be transform-only.

## Verify

```bash
make fmt && make lint && make test && make debug
```

In the app: add each kit size; drag one — all strips move together; hover holes on a
rail strip and confirm addresses read `bb<n>.+7`; wire across strips; run the
simulation and confirm rails still power chips.
