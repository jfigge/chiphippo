# Feature 50 — Wires

## Context
Chips seat into addressable holes (Feature 40) but nothing connects them. This stage
adds **jumper wires**: hole-to-hole connections drawn as colored, gently sagging
leads on an SVG overlay — including **across boards**, which is the whole point of
an infinite desk. Wires are pure topology for now; electricity waits for Features
70/90.

## Goal
The user arms the wire tool, clicks a free hole, sees a rubber-band preview follow
the cursor, clicks a second free hole to commit a colored wire (auto-cycling
palette, changeable per wire), can select/recolor/delete wires, sees wires follow
their boards when boards move, and everything persists.

## Design decisions (settled — do not relitigate)
- **Model**: `{ id, from, to, color }` appended to the desk document's `wires`
  array — `from`/`to` are hole addresses (`bb1.j5`), `color` a name from a fixed
  wire palette (red, black, blue, green, yellow, orange, white, purple). Ids `w<n>`.
  Endpoints occupy holes via the Feature 40 **occupancy index** (one lead per hole),
  so wires and pins can never collide. Self-wires within one internal node are
  allowed (harmless, and real boards do it).
- **Interaction**: a toolbar **wire tool** (shortcut `W`) arms wiring mode; cursor
  becomes crosshair; hole highlighting reuses the Feature 30 hover ring. Click a
  free hole → anchored rubber-band follows the cursor (danger tint over occupied
  holes) → click a second free hole commits and immediately re-arms starting fresh
  (chain-friendly); `Esc` or right-click cancels the pending wire; `Esc` again (or
  toolbar) disarms the tool. While armed, board/chip dragging is suspended.
- **Color**: new wires cycle the palette; a small swatch strip in the toolbar pins
  the next color; a selected wire's context menu offers recolor + delete.
- **Rendering**: one `<svg>` filling `.layer-wires` (above parts, below overlay).
  Each wire is a quadratic bezier from hole center to hole center with downward
  **sag** proportional to run length (clamped), a darker outline stroke under a
  colored core stroke, and small endpoint caps over the holes. Wire geometry math
  (`wire-path.js`: endpoints → path string + sag) is pure and tested. Wires
  re-render only when an endpoint's board moves or the wire list changes — never on
  pan/zoom (the camera transform handles that).
- **Hit-testing/selection**: wires are the exception to "no per-item DOM events" —
  each path gets `pointer-events: stroke` with a widened invisible hit stroke;
  click selects (`wire--selected` glow), `Delete` removes, context menu as above.
  This is idiomatic SVG and avoids hand-rolled curve-distance math.
- **Cross-board wires** are first-class: endpoints resolve through board origins at
  render time, so moving either board re-sags the wire. Deleting a board (or a chip
  whose… n/a — chips don't host wire ends; holes do) prompts when wires would
  dangle and deletes them with it.

## Implementation steps
1. **Model + occupancy.** Wire add/remove/recolor operations in `desk-doc` with
   occupancy enforcement + tests (free/occupied, dangling cleanup on board delete).
2. **Path math.** `wire-path.js` (pure): world endpoints → sagged bezier + hit
   stroke params; tests for sag clamping and endpoint accuracy.
3. **WireLayer component.** Owns the overlay SVG, renders from the document,
   updates on `chiphippo:doc-changed` and board-move callbacks, selection +
   keyboard delete + context menu (popup manager).
4. **Wire tool.** Toolbar toggle + shortcut, rubber-band preview in the overlay
   layer, legality tinting, chained placement, cancel paths.
5. **jsdom tests.** WireLayer renders N paths for N wires; selection class
   toggling; recolor updates stroke.

## Acceptance criteria
- Click-click wiring works within a board, between boards, and to rail holes; both
  endpoints must be free holes and become occupied.
- The rubber-band preview tracks the cursor with live legality tinting; `Esc`
  cancels cleanly at each stage.
- Wires render with sag + outline, stay glued to their holes through board drags
  and pan/zoom, and are selectable/recolorable/deletable; board deletion warns
  about and removes attached wires.
- Wire state persists across relaunch; `make fmt && make lint && make test` green.

## Constraints
- Endpoints are addresses; nothing stores pixel positions. All mutations through
  `desk-doc`; occupancy is the single collision authority.
- One overlay SVG; no wire re-render on camera moves; path math pure + tested.
- Theme tokens for the wire palette (defined once in `theme.css`); class naming
  and pointer-capture rules as always.

## Verify
`make fmt && make lint && make test`, then `make debug`: wire a 7400's pins to rail
holes on the same board, run a long wire from `bb1` to a hole on `bb2`, drag `bb2`
far away and watch the wire follow, chain several wires cycling colors, recolor and
delete one, try to land on an occupied hole (rejected), delete a board with wires
(warned), relaunch and confirm restoration.
