# Feature 40 — Component framework & DIP chip placement

## Context
Boards render and holes are addressable (Feature 30). This stage introduces the
**component framework** — the one model that every placeable part (chips now,
switches/LEDs/power in Feature 60) flows through — and its first citizens: **74xx
DIP chips**, chosen from a searchable palette and seated across a breadboard trench.
Chips are *metadata only* here (identity, package, pin names); their behavior lands
in Feature 80.

## Goal
The user opens a chip palette, searches or browses the 74xx starter catalog, places
a DIP chip straddling a trench with a legality-checked ghost, sees it rendered as a
classic black DIP with notch/pin-1 dot/part number, can move and delete it, and can
hover any pin to see its name and seated hole ("7400 pin 3 · 1Y → bb1.e12") — all
persisted.

## Design decisions (settled — do not relitigate)
- **Component model** (extends the desk document's reserved `components` array):
  `{ id, kind, ref, board, anchor, params }` — `kind: "chip"` now (`"discrete"`,
  `"psu"` later), `ref` a catalog id (`"7400"`), `board` + `anchor` the seated
  board/hole of **pin 1**, `params` free-form per kind. Ids `c<n>` from the document
  counter. Pin positions are always *derived* from footprint + anchor — never stored.
- **DIP footprint** (`package: "DIP-14" | "DIP-16" | "DIP-20"`, all 0.3-in row
  spacing): notch left; for 2n pins, pin 1 sits at the anchor in row `e`, pins
  1…n run left→right along row `e`, pins n+1…2n run right→left along row `f` —
  the standard counterclockwise DIP numbering seated across the trench.
- **Occupancy**: one hole holds at most one lead, app-wide. A pure occupancy index
  (`src/web/scripts/model/occupancy.js`) built from the document maps
  address → occupant (component pin or, later, wire end); placement legality =
  every pin's hole exists, is free, and rows are exactly `e`/`f` across one trench.
  Feature 50 reuses the same index for wire ends.
- **Catalog** is data-driven under `src/web/scripts/catalog/`: one `chips-gates.js`
  module exporting defs `{ id, title, blurb, package, pins: [{ n, name, role }] }`
  with `role ∈ input|output|vcc|gnd|nc`. Starter set (metadata for the same wave
  Feature 80 animates): **7400, 7402, 7404, 7408, 7410, 7411, 7420, 7427, 7430,
  7432, 7486, 74125** — real pinouts, VCC/GND at the standard corners. A catalog
  test validates every def (pin count matches package, exactly one vcc + one gnd,
  unique pin numbers/names).
- **Palette UI**: a left side panel (toggle button in the toolbar) listing the
  catalog grouped by function, with a filter box matching id/title/blurb; clicking a
  chip arms placement mode (same ghost pattern as Feature 30: snap to legal
  anchor holes, accent/danger tint, click to place, `Esc` cancels). The panel is a
  class component; it will later grow discrete parts (Feature 60).
- **Rendering**: chips live in `.layer-parts` as absolutely positioned elements —
  black DIP body (theme tokens, subtle gradient), left notch, pin-1 dot, centered
  part number, and stub legs reaching the seated holes. Drawn HTML/CSS (+tiny SVG
  where easier); crisp at all zooms.
- **Interaction**: click selects (`part--selected` outline); drag moves with the
  ghost/legality treatment (pointer-capture rules); `Delete`/context menu removes.
  Board deletion with seated chips asks for confirmation via the popup manager and
  removes its components. Pin hover (math over derived pin positions, not per-pin
  DOM) shows "«ref» pin «n» · «name» → «address»".
- **No rotation in v1.** DIPs seat notch-left only; rotation/flip is a backlog item
  (it complicates footprints and reading order for little early value).

## Implementation steps
1. **Occupancy + footprint modules.** `occupancy.js` and `footprints.js`
   (pin→offset derivation for DIP-14/16/20), pure + tested (numbering order, trench
   straddle legality, collision detection).
2. **Catalog + validation test.** `chips-gates.js` defs; the catalog integrity test.
3. **Desk-doc extension.** Add/move/remove component operations with legality
   enforcement + tests; migrate nothing (shape was reserved in Feature 20).
4. **Palette panel.** Component list, grouping, filter; arms placement mode; panel
   show/hide persisted in settings.
5. **ChipView + placement.** DIP rendering, ghost placement, drag-move, delete,
   confirm-on-board-delete, pin hover tooltips.
6. **jsdom tests.** ChipView renders correct leg count/label; palette filters.

## Acceptance criteria
- Palette lists the 12-chip starter catalog with working filter; each def passes the
  integrity test.
- A DIP-14/16 places only where every pin lands on a free `e`/`f` hole across one
  trench; ghost shows legality live; occupied holes block both chips and (by shared
  index) future wires.
- Rendered chips look like DIPs (notch, pin-1 dot, label), track their board when it
  moves, move/delete correctly, and persist across relaunch.
- Pin hover reports pin number, name, and seated hole address correctly for pins on
  both rows.
- `make fmt && make lint && make test` is green.

## Constraints
- Pin positions derived, never stored; all mutations through `desk-doc`; occupancy
  is the single collision authority.
- Catalog is data + validation — no chip-specific rendering or logic code paths.
- Plain DOM, theme tokens, class-naming and pointer-drag rules; no per-pin DOM
  event targets.

## Verify
`make fmt && make lint && make test`, then `make debug`: place a 7400 on a Full
board (watch snapping and an illegal hover over the rails), a 74125 on a Tiny board,
collide two chips (rejected), move a board and see chips ride along, hover several
pins on both rows verifying names/addresses against a 7400 datasheet, relaunch and
confirm everything restores.
