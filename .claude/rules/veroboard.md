---
paths:
  - "src/web/scripts/model/vero-presets.js"
  - "src/web/scripts/desk/vero-copper.js"
  - "src/web/scripts/components/cut-tools.js"
  - "src/web/scripts/components/vero-custom-dialog.js"
  - "src/web/scripts/tests/veroboard*.test.js"
  - "src/web/docs/veroboard.md"
---

## Veroboard

**Stripboard as a third kind of board** (Feature 440, 2026-10-19,
`features/done/440-veroboard.md`; guide `veroboard.md`). A sheet of holes on the
2.54 mm pitch with copper strips under it, every hole of a strip one node until the
strip is CUT.

- **The type key IS the size** — `vero-<w>x<h>` in mm, one decimal, canonical
  (`vero-presets.js` `veroTypeKey`/`parseVeroKey`, 10–500 mm a side). There is no
  table of them: `board-types.js` `veroSpec(key)` derives one (memoised) and
  `breadboard.js` `spec` resolves through `boardSpec`. Holes =
  `floor((mm − 2·margin)/2.54) + 1` each way, centred (`colStartX`/`rowStartY`), unless
  the preset states its maker's layout (`cols`/`rows`, turned with the board). A preset
  is matched in EITHER orientation (`presetForSize`). Ask `isBoardType(type)`, never
  `BOARD_TYPES[type]`, and `kitFor(key)`, never `BREADBOARD_KITS[key]`.
- **The copper runs down the desk, always** (kind `"vero"`, `cols` strips × `rows`
  holes). A DIP sits across the strips at its package's width (3 or 6 holes,
  `footprints.js` `veroPinHoles`/`veroCoveredHoles`; no `wide` param), pin 1 at the
  anchor in the LOWER row. Turning a board is placing its turned size (R on the ghost,
  `turnedVeroKey`); `canRotate` is false.
- **Holes `<STRIP><n>`** (`C14`; `stripLetters`/`stripNumber`, bijective base 26).
  `parseHole` → `{kind: "vero", strip, index}`. Footprint arithmetic with no board in
  hand uses `shiftVeroHole`; with one, `holeOffset`/`veroHoleAt`. A group move keeps a
  chip's SEAT, which on a veroboard is just "a veroboard" (`seatClassOf` → `VERO_SEAT`).
- **A board's x is placed so its HOLES are on whole pitches** (`holePhaseX`, DeskDoc
  `placeX(n, type)`): the board's edge takes the fraction. Drags move by whole pitches,
  so it stays there.
- **Cuts are per BOARD** — `board.cuts`, normalized (`normalizeCuts`: real holes, once,
  strip then hole), omitted when empty, REPLACED never edited (the node lookup caches on
  the array, `CUT_INDEX`). A cut is a spot-face AT a hole: the pad is its own node
  (`SCx14`), the strip either side two runs (`SC/1`, `SC/15`); a whole strip is `SC`.
  **Every reader that has a board must ask `boardNodeOf(board, hole)`** (or
  `boardHolesOfNode`) — a bare `nodeOf(type, hole)` sees no cuts. The netlist, sag,
  lamps, the bus tap and the build guide do; riding (`part-move.js`) and auto-route
  alternatives are grid-only and skip veroboards on purpose.
- **Where the copper is** is `veroRuns(type, cuts)` (breadboard.js) →
  `desk/vero-copper.js` `veroCopper` rects — what the desk draws through the board and
  the 3D underside draws, so the gap and the node can never disagree.
- **Never mates** — `mating.js` `boardRect` carries `mates: false`.
- **Desk drawing**: holes are ONE `<pattern>`-filled rect (a 12 × 17 in sheet is 20 400
  holes), copper is its own `.vero-copper` group redrawn by `BreadboardView.setCuts`
  (the Cut tool calls it through its host; undo/redo remount the board). A cut
  is shown by the copper's gap ONLY — no ring is left on the board (Jason). Labels only
  where the margin is ≥ `VERO_LABEL_MARGIN`.
- **Cut Track** (`components/cut-tools.js`, K, the toolbar segment after Bus): shares
  `#mode` (`kind: "cut"`), the shared ring (`--restore` dashed over a cut), one
  `toggleCut` + `#emitDocChanged` per click (one undo step). Refused while running and
  disarmed by Run; every other tool's `arm` calls `disarmCutTool` and it theirs.
  **Offered only with a veroboard on the desktop** (Jason, 2026-10-19):
  `DeskController.hasVeroboard`; app.js `showCutTool` hides the segment on every
  `chiphippo:doc-changed` (edits, undo, desktop swaps) and disarms the tool when the
  last veroboard goes; `CutTools.arm` refuses without one (so K does nothing).
- **3D** (`scene3d/board-model.js` `buildVeroBoard`): a 1.6 mm sheet on four
  stand-offs, holes top and bottom, copper runs underneath, solder under each hole
  scene.js finds a lead or wire in (`solderedHoles`). No credit line on a veroboard
  (Jason, 2026-10-19): `BOARD_ATTRIBUTION` goes under each PIN-BOARD instead
  (`printCredit`, facing down, `boardLabel` colour; rails carry none). The camera
  may go under the desk by orbiting (`PITCH_MIN` −88°) — there is NO button for it
  (Jason removed View underside / View top side) — and `Desk3DView` drops the floor
  and `gl-renderer` flips the sun and sky (`u_up`, `LIGHT_BELOW`) while it is
  (`isUnderneath`).
- **Out of the generators**: the AI builder, the demo benches and auto-build seat on
  breadboards only.
