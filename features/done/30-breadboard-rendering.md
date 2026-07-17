# Feature 30 — Breadboard rendering & placement

## Context
Feature 10 gave us the infinite desk camera; Feature 20 gave us the board model,
addresses, and the persisted desk document. This stage makes breadboards **visible
and manipulable**: drawn boards (HTML/CSS/SVG — not photos, so they stay crisp at
every zoom) that can be added in any of the three sizes, dragged around the desk,
selected, deleted — and whose every hole reveals its address on hover. This is the
first stage where the app *feels* like a workbench.

## Goal
From an empty desk the user can add Full / Half / Tiny breadboards via the toolbar,
place them with a live ghost preview, drag them to reposition (integer-pitch snap,
no overlaps), select and delete them, hover any tie point to see a highlight ring and
its address (`bb1.f12`), and find everything exactly where they left it after a
relaunch.

## Design decisions (settled — do not relitigate)
- **Boards are drawn, not images.** Each board is one absolutely positioned
  `.board` element on the desk surface containing a **single inline `<svg>` built
  once from the Feature 20 spec**: body (rounded rect, plastic-tone tokens), trench
  groove, red/blue rail stripes, row letters (`a`–`j`) and column numerals (1, 5,
  10, …), and every hole as a small dark rounded square. **No per-hole DOM events or
  ids** — 830 holes × N boards must stay inert; all hole interaction is math via
  `holeAt()` from pointer coordinates. The SVG scales with the camera for free.
- **Layer order** inside `.desk-surface`: `.layer-boards` → `.layer-parts` (40/60) →
  `.layer-wires` (50) → `.layer-overlay` (ghosts, hover ring, selection, tooltips).
  Established now so later stages just fill in.
- **Add flow**: toolbar "Add board" split-button (Full / Half / Tiny) arms placement
  mode → a translucent board ghost tracks the cursor snapped to integer pitch →
  legal placement shows accent tint, overlap shows danger tint → click places (and
  disarms), `Esc` cancels. Placement uses the Feature 20 `desk-doc` API.
- **Selection & movement**: click a board body selects it (`board--selected` accent
  outline); drag moves it with the pointer-capture discipline (4 px threshold, ghost
  snap, danger tint + revert on illegal drop); `Delete`/`Backspace` or context-menu
  "Remove board" deletes (context menu via the popup manager, step 5). Click empty
  desk deselects. Empty-desk drag still pans (Feature 10) — board drags win because
  they start on a board.
- **Hover addressing**: pointer over a hole (found via `holeAt`, ~0.45-pitch radius)
  after a ~150 ms dwell shows a highlight ring in the overlay layer plus a small
  tooltip `bb1.f12`; rails show `bb1.t+7`. Suppressed below 75% zoom (holes too
  small to mean anything). This is the proof that addressing works end-to-end.
- **Renderer state**: a single `DeskController` owns the in-memory `DeskDoc`,
  constructs/removes `BreadboardView` children, and emits `chiphippo:doc-changed`
  for autosave; views report gestures through constructor callbacks (house rule).
- **Popup manager**: port the lightweight popup/context-menu manager pattern from a
  sibling (`porthippo/src/web/scripts/popup-manager.js`) now — every later stage
  needs menus.
- **Performance target**: 10 mixed boards pan/zoom with no per-frame layout or SVG
  rebuild (transform-only), verified by eye + the dev HUD.

## Implementation steps
1. **Board SVG builder.** `src/web/scripts/components/breadboard-view.js` renders
   the spec into SVG (pure build function separated from the class so a jsdom test
   can count holes/labels); theme tokens for all colors.
2. **DeskController + layers.** Create the four layers, mount boards from the loaded
   document, wire `chiphippo:doc-changed` autosave (Feature 20 plumbing).
3. **Toolbar & placement mode.** Header toolbar gains the Add-board split-button;
   ghost + legality tinting; placement commits through `desk-doc`.
4. **Select / drag / delete.** Pointer-capture drag with snapping ghost and overlap
   rejection; keyboard delete; selection visuals per class-naming rules.
5. **Popup manager + context menu.** Port the manager; board context menu with
   "Remove board" (and a disabled "Properties…" placeholder).
6. **Hover addressing.** Dwell timer, overlay ring, tooltip; hide on move-away,
   drag, or zoom-out past the threshold.
7. **Tests.** Pure: overlap/snap logic (already in `desk-doc`, extend as needed) and
   ghost-legality helper. jsdom: SVG builder emits the right hole counts per type
   and labels; DeskController mounts/unmounts board views on doc changes.

## Acceptance criteria
- All three board sizes render with correct proportions, rails (none on Tiny), row
  letters, column numerals, and hole lattices matching the Feature 20 spec.
- Add → ghost → place works with snap + overlap rejection; drag-move and delete
  work; every mutation persists across relaunch.
- Hovering any hole at ≥75% zoom shows the ring + correct address, including rail
  addresses; below the threshold hover stays quiet.
- Panning/zooming with 10 boards stays smooth (no SVG rebuilds on camera moves).
- `make fmt && make lint && make test` is green.

## Constraints
- No per-hole DOM nodes, listeners, or ids — hole interaction is `holeAt()` math.
- Plain DOM + class-based ES modules; tokens from `theme.css`; class naming
  `prefix-name` / `block--modifier`; pointer-capture drags only.
- All document mutations flow through `desk-doc` (never poke the JSON in views);
  persistence stays in main via `window.chiphippo.desk.*`.

## Verify
`make fmt && make lint && make test`, then `make debug`: add one of each size, drag
them around and into overlap (rejected), delete one, hover holes and rails on each
size checking addresses against the printed row/column labels, zoom to 25% and 400%,
relaunch and confirm the desk restores exactly.
