# Feature 10 — Infinite desk workspace (pan & zoom)

## Context
Feature 00 landed the Electron shell with an inert `.desk-viewport` placeholder. This
stage turns it into the app's core surface: an **infinitely pannable, zoomable desk**
that everything else (boards, chips, wires) will live on. Port Hippo's `CardCanvas`
(`porthippo/src/web/scripts/components/card-canvas.js` + `grid-layout.js`) supplies
the house discipline — pointer-capture drags, pure-logic/DOM split, math-based hit
testing — but it is scroll-based; a **camera transform** (translate + scale) is new
work. No breadboards yet: this stage is proven with the grid alone.

## Goal
The desk pans smoothly in any direction without bounds, zooms about the cursor
between 25% and 400%, shows a pitch-aligned dot grid, exposes zoom controls and
shortcuts, and restores its viewport (and window bounds) across restarts.

## Design decisions (settled — do not relitigate)
- **Camera, not scrollbars.** A fixed `.desk-viewport` element clips a single
  `.desk-surface` child carrying `transform: translate(tx px, ty px) scale(z)`.
  Children of the surface are absolutely positioned in **world pixels** =
  `worldUnits × PX_PER_UNIT`. No scroll container (this deliberately differs from
  Port Hippo's CardCanvas).
- **World unit = one pitch = 0.1 in**; `PX_PER_UNIT = 10` at zoom 1.0 (a Full board
  is ~650 px wide at 100%). Viewport state = `{ cx, cy, zoom }` — the world point at
  the viewport center plus the zoom factor.
- **Zoom** range 0.25–4.0, exponential steps (~1.15×/step), always **anchored at the
  cursor** (the world point under the pointer stays put). Inputs: `ctrl/cmd + wheel`,
  trackpad pinch, `cmd +` / `cmd -` / `cmd 0` (reset to 100%), and a bottom-right
  control cluster (−, percentage readout that clicks back to 100%, +). Disable
  Chromium visual zoom (`setVisualZoomLevelLimits(1, 1)`).
- **Pan** inputs: plain wheel / two-finger scroll (dx/dy), middle-button drag, and
  left-drag on empty desk. `space`+drag is not needed while empty-desk drag pans;
  revisit only if a marquee-select backlog stage claims empty-drag.
- **Pure geometry module** `src/web/scripts/desk/desk-geometry.js` (DOM-free):
  `worldToScreen`, `screenToWorld`, `zoomAboutPoint`, `clampZoom`, transform
  composition. Sibling `node --test` coverage. The `DeskView` component
  (`src/web/scripts/components/desk-view.js`) stays a thin DOM shell over it.
- **Dot grid** rendered as a CSS `background-image` (radial-gradient dot tile) on the
  **viewport**, with `background-size`/`background-position` recomputed from the
  camera — the grid is infinite for free and costs nothing during pans. One dot per
  pitch; below ~60% zoom switch to one dot per 5 pitches; below ~30% hide dots. Grid
  colors from `theme.css` tokens.
- **Persistence.** This stage introduces the main-process store foundation:
  `src/app/store/io.js` (atomic write, ported from a sibling) +
  `src/app/store/settings-store.js` (frozen `DEFAULTS`, `get`/`set(patch)`), IPC
  `settings:get`/`settings:set` on the bridge. Viewport saves debounced (~500 ms);
  window bounds via a ported `window-state.js` with the display-fit check.
- Rendering hygiene: pan/zoom only mutates the surface `transform` and grid
  background — never triggers child re-render/layout. `will-change: transform` on the
  surface; transforms rounded to device pixels at rest to keep future hole rendering
  crisp.

## Implementation steps
1. **Geometry module + tests.** `desk-geometry.js` with the camera math; tests for
   round-tripping, zoom-about-point invariance (anchor stays fixed), and clamping.
2. **DeskView component.** Owns the viewport/surface DOM, applies the camera,
   translates pointer/wheel events into pans and zooms (pointer capture, 4 px drag
   threshold), and exposes `worldFromEvent(e)` plus an `onViewportChange` constructor
   callback. Cursor: grab/grabbing while panning.
3. **Zoom control cluster.** Bottom-right overlay (`desk-zoom` block): −, readout, +;
   keyboard shortcuts registered centrally; wire to DeskView.
4. **Store foundation.** `io.js`, `settings-store.js`, `settings:*` IPC registered in
   `main.js` and exposed in `preload.js`; `window-state.js` for bounds. Unit tests
   for the store (temp-dir userData) per the siblings' pattern.
5. **Viewport restore.** On boot, load settings, apply saved viewport before first
   paint (no flash); save debounced on change.
6. **Debug HUD (dev only).** Under `--hot-reload`/`--dev`, a small overlay showing
   `cx, cy, zoom` and the world coordinate under the cursor — invaluable for every
   later stage; hidden in production.

## Acceptance criteria
- Dragging empty desk, middle-dragging, and two-finger scrolling all pan; there are
  no bounds in any direction and no scrollbars.
- `ctrl/cmd+wheel` and pinch zoom about the cursor (the point under the pointer does
  not drift); `cmd +/-/0` and the control cluster work; zoom clamps at 25%/400% and
  the readout tracks.
- The dot grid stays aligned with world coordinates through arbitrary pan/zoom and
  coarsens/fades at low zoom.
- Quit and relaunch restores window bounds and desk viewport.
- `desk-geometry.js` and the settings store have passing sibling tests;
  `make fmt && make lint && make test` is green.

## Constraints
- Plain DOM + class-based ES modules; all colors/sizes from `theme.css` tokens.
- Geometry/camera math is DOM-free and tested; `DeskView` contains no math beyond
  delegation.
- Filesystem persistence lives in main (`src/app/store/`); renderer only via
  `window.chiphippo.settings.*`. Keep `main.js`/`preload.js` in lockstep.
- Pointer-capture drag discipline; never native HTML5 drag-and-drop.

## Verify
`make fmt && make lint && make test`, then `make debug`: pan/zoom by every input
listed above, watch the HUD coordinates, confirm the anchor-point invariance by
zooming in and out over a grid dot, relaunch and confirm the viewport restored.
