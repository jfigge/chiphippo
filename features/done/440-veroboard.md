# Feature 440 — Veroboard (stripboard)

**Status:** built 2026-10-19, from the request in `features/veroboard_for_maydaym3.md`.

## Context

The request asked for a third kind of board beside the breadboard strips:
stripboard in standard and custom sizes, a Cut Track tool with undo, connectivity
taken from the cut copper in both engines, a 3D underside showing the copper and the
gaps, and persistence. Chip Hippo's connectivity already ran through one seam
(`nodeOf` → `sim/netlist.js` `partition`), its undo is snapshot-based, and its tools
share one `#mode` — so the board is a new KIND of spec plus a per-board cut list,
read everywhere a node is.

## Goal

A user can pick a standard or custom veroboard from BOARDS ▸ Veroboard, place it,
seat and wire parts on it, cut copper tracks, see the connectivity in the
simulator, look at the underside in 3D, and save and reopen it with its cuts.

## Design decisions (settled)

- **Pitch fixed at 2.54 mm.** The world unit IS the 0.1-in pitch and every part's legs
  are drawn on it. `pitchMm` is in the preset data and the tests hold it to 2.54.
- **The copper always runs down the desk.** A DIP then sits across the strips in its
  normal orientation, every pin on its own strip — pin 1 and pin 2n share one until
  the strip between the rows is cut, as on the bench. R while placing turns the
  board by placing its TURNED size (`vero-54x92`); a placed board never rotates.
- **A cut is a spot-face AT a hole**: the hole is isolated (its own node), the strip
  either side becomes two runs. A lead in a cut hole floats. End holes may be cut.
- **Holes are `<STRIP><n>`** — strips lettered A…Z, AA… left to right, holes numbered
  from 1 at the top (`C14`). Upper case cannot collide with a pin-board's `a–j` or a
  rail's `+`/`-`. Nodes: `SC` (a whole strip), `SC/15` (the run starting at hole 15),
  `SCx14` (a cut pad) — none ends in `+`/`-`, so `netPolarity` ignores them.
- **The type key IS the size** (`vero-92x54`, mm, one decimal). `veroSpec` derives the
  spec, memoised; holes = `floor((W − 2·1.27)/2.54) + 1` each way, centred, unless a
  preset states its maker's layout (`cols`/`rows`: the 65 × 144 is 24 × 56). The
  board's x takes the fraction that puts its HOLES on the desk's whole-pitch columns
  (`holePhaseX`, DeskDoc `placeX`).
- **The cuts are the BOARD's**: `board.cuts`, sorted (strip, then hole), unique, real
  holes only, omitted when empty. `nodeOf`/`holesOfNode` take them as a trailing
  argument; `boardNodeOf`/`boardHolesOfNode` hand a board's own over.
- **No document migration and no version bump.** Old files never mention a veroboard
  and load unchanged; bumping `DOC_VERSION` would only have restamped every demo
  (an older app leaves a newer document untouched and drops the unknown board anyway).
- **A veroboard never mates, snaps or groups** (`boardRect` → `mates: false`).
- **Not for the generators**: the AI builder, the demo benches and auto-build seat on
  breadboards only.

## What was built

- `model/vero-presets.js` (the sizes, limits, key grammar), `board-types.js`
  (`veroSpec`, `boardSpec`, `isBoardType`, `kitFor`, `VERO_KIT_KEYS`),
  `breadboard.js` (the vero hole kind in every primitive; `holeOffset`, `veroHoleAt`,
  `anchorColumn`, `veroIndexAt`, `shiftVeroHole`, cut-aware nodes, `veroRuns`,
  `normalizeCuts`, `isCuttable`).
- `desk-doc.js` (`toggleCut`, `setCuts`, cuts normalized on load, carried by paste),
  `design-clip.js` (cuts in a clip).
- Every `nodeOf` reader that holds a board passes its cuts: the netlist, Spice Lite's
  sag and lamps, the bus tap, the build guide.
- Seating: `footprints.js` `veroPinHoles`/`veroCoveredHoles`/`seatClassOf`,
  `occupancy.js` (every footprint form on a vero anchor), `seating.js` `veroSeat`.
- Desk: `breadboard-view.js` (holes as ONE pattern-filled rect; copper as runs in
  its own group, redrawn in place on a cut), `desk/vero-copper.js` (the rects both
  renderers draw), the palette's Veroboard folder and `vero-custom-dialog.js`.
- `components/cut-tools.js` (K, the toolbar's Cut track segment), the build guide's
  "Cut the copper strips of … at …" step.
- 3D: `board-model.js` (a 1.6 mm sheet on stand-offs, underside copper with real
  gaps, solder under occupied holes); the camera goes under the desk by orbiting
  (`PITCH_MIN` −88°), the floor is left out and the light flipped below.

**Revised the same day (Jason):** the BOM's boards section is "Boards"; the View
underside / View top side buttons are gone (orbit to get there); the credit line
moved from the veroboard's underside to each breadboard pin-board's, reading
"Designed by Jason, coded by Claud"; a cut leaves no ring on the desk — the gap in
the copper shows it; the Cut track button is shown only while the desktop holds a
veroboard.

## Weaknesses / follow-ups

- **Pitch 2.54 mm only.** 2.0/3.96 mm boards need a per-board lattice parts don't have.
- **Spot-face cuts only.** A knife cut between holes would be a second cut kind on the
  same seam (e.g. `C14|C15` entries).
- **No riding on a veroboard**: a part moved on one leaves its wires where they are —
  a strip is too long (like a rail) to tell which wires belong to the part.
- **Netlist on a 12 × 17 in sheet** rebuilds in ~11 ms (20 400 holes) against ~0.6 ms
  for a full breadboard; fine today, the place to look if many sheets are used.
- The AI builder, the demos and auto-build don't use veroboard.

## Verify

```bash
make fmt && make lint && make test
```

In the app: place 92 × 54, R-turn the ghost; seat a 74LS04, a resistor and an LED;
press K and cut under the chip; undo/redo; Run (both engines); save, reopen; 3D ▸ View
underside.
