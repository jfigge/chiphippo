---
paths:
  - "src/web/scripts/scene3d/**"
  - "src/web/scripts/components/desk-3d-view.js"
  - "src/web/scripts/components/gl-renderer.js"
  - "src/web/scripts/tests/scene3d*"
  - "src/web/docs/3d-view.md"
---

## 3D view

**The desk, stood up — to LOOK at, never to edit.** A cube segment in the desk-tool pill,
after Schematic, toggles it. It is a RUNTIME control, not a setting — Jason moved it out of
Settings ▸ Appearance (2026-10-05): it is switched on and off while looking at a desktop,
so it belongs where the Schematic toggle is. Whether that segment is OFFERED is a setting,
though: Settings ▸ Appearance ▸ **3D enabled** (`view3dEnabled`, default Off — see
"Settings") hides it, and Off while the view is up returns to the breadboard. The app always opens on the breadboard, and
the mode is not persisted. **New Project always drops out of the 3D view** (Jason,
2026-10-05): `ProjectWorkspace`'s `onNewProject` hook fires once the new project has really
arrived (never for a New called off at the leave guard, never for Open), AHEAD of the
frame, so the breadboard is what gets framed; app.js sets the mode back to `"desk"`. A
schematic on screen is left as it is. app.js's `setMode` grows a third mode, `"3d"`, beside `"desk"`
and `"schematic"`. Each view's segment goes TO its
view from either other one and back to the breadboard from its own (`Tab` is
Schematic's key, so it does the same) — which keeps every icon and label, "where this
takes you", true in all three modes. `getActiveView`/`fitActiveView` include it, so Fit, ⇧⌘F and ⌥⌘=/−/0
reach it; the desk padlock locks its wheel too (`applyWheelLock` + DeskLock's onChange).

- **Nothing GPU happens at boot**: the `GlRenderer` is made on the view's first SHOW
  (`#ensureRenderer`), and its `#init` catches every failure (no context, a shader that
  will not compile, a GPU reset mid-compile) into `supported === false` — a GPU must never
  be able to touch startup for a view the user may never open. A restored context
  re-uploads the scene and calls back (`onRestored`) so the view repaints.
- **A projection, like the schematic**: `components/desk-3d-view.js` (`Desk3DView`) reads
  the same `DeskDoc`, stores nothing, and REBUILDS the whole scene from the document on
  `chiphippo:doc-changed` / `:part-state` — lazily: a hidden view only marks itself stale,
  and draws on demand (one coalesced animation frame per change), so a hidden or idle view
  costs nothing. It frames the desk on its first draw and again on `frameNext()` —
  `frameLoadedView` (a project/example landing) and `onActiveChange` (a desktop switch).
- **No WebGL library** — the app takes no framework and has no bundler, so
  `components/gl-renderer.js` is the ONE file that touches WebGL: two GLSL-100 programs
  (lit triangles; textured quads), plain non-indexed buffers, `webgl2` then `webgl`, a
  sun + sky ambient, BOTH faces drawn with each normal turned toward the camera (so a
  primitive's winding never matters — `scene3d/mesh.js` says why), context loss
  rebuilt. No WebGL → a `view3d.unsupported` sentence instead of a canvas.
- **Pure scene, DOM-free** (`scripts/scene3d/`, all testable under `node --test`):
  `buildScene(doc, palette)` → `{mesh, lamps, labels, screens, bounds, modelled, errors}`.
  WORLD coordinates throughout — x = desk x, **z = desk y**, y up, one unit one pitch,
  board tops at y 0, the desk at `DESK_Y` (−8.5 mm of board). The STATIC `mesh` is one
  buffer, one draw; a LAMP is geometry the SIMULATION colours (LED lens, display segment,
  clock lamp, transistor lamp) with its own small buffer; a LABEL is text on a face (part
  numbers, values, annotations) drawn into a canvas texture shared per text/colour/font;
  a SCREEN is an LCD's glass, repainted from the module's framebuffer (`glyphRows`, the
  desk's own font). One part that throws is REPORTED (`errors`) and skipped, not fatal.
- **Every model is the desk's drawing given height** (`part-models.js`): WHERE pins are
  comes from `partPinsWorld` / `holePosition` (a leg goes into the hole the netlist
  joins); OUTLINES the 2D views state are IMPORTED, not restated — `chipBodyBox`/`chipBox`,
  and from `discrete-view.js` (exported for this) `TO220`, `inductorSize`,
  `DIP_BODY_TOP/BOTTOM`, `TYPE_LABEL` and `resistorBandLayout` (the band layout the desk
  now draws from too). Colours are the theme's tokens (`scene3d/palette.js`
  `readPalette(getVar)`, dark-theme fallbacks), re-read on a light/dark flip.
  **`modelKind(def)` must name a model for EVERY `PALETTE_DEFS` entry** — the
  `tests/scene3d.test.js` ratchet, alongside a fixture with one of every part
  (`tests/scene3d-fixture.js`, seated through DeskDoc's own placement API) and every
  shipped demo desktop. A new part without a model fails there.
- **Wires** (`wire-model.js`) end at `addressWorld` — a hole's top, or a brick's binding
  post — with tinned tips down into the holes: a DIRECT wire arches (higher the longer),
  a ROUTED one lies flat through its waypoints, a BUS is a ribbon whose collars and
  per-member spread are `desk/ribbon-path.js`'s (`ribbonLayout`/`ribbonSpread`, in world
  px exactly as WireLayer calls them), so the conductors keep the desk's order. Signal
  flags and Output/Input tags are post-and-pennant flags; labels and notes lie flat at
  board-top height (on the desk floor they would hide behind the board they caption).
- **COLLISIONS ARE IGNORED (first pass)** — a jumper may pass through a chip, as on the
  flat desk.
- **Lamps never re-decide anything**: `lampState(lamp, live)` lights an LED or segment from
  the desk's OWN verdict — `SimOverlay` now KEEPS what it hands its views
  (`ledOf`/`segmentOf`, read through `DeskController.ledOf`/`segmentOf`; the controller's
  sim-state listener is registered first, so the verdicts are current when the 3D view's
  runs) — and a clock's / transistor's straight off `chiphippo:sim-state`
  (`clockLevels`, `channels`). A tick that changes no lamp and no glass draws no frame
  (`#liveKey`).
- **Brightness and smoke are the desk's too** (2026-10-08). `lampLevel` reads the verdict's
  `level` (Spice Lite's current, 1 on the digital engine, null on a replay pass = full) and
  `lampLook` turns it into the desk's look: lens from off toward on by `0.3 + 0.7·min(1, L)`,
  emissive `LIT_GLOW` × the same, washing toward white past 1, and a HALO — a round lamp's
  (`sb.lamp({halo: {center, radius}})`: LED lens, clock lamp, transistor lamp; segments and
  bars have none) camera-facing additive disc whose radius grows with L uncapped (×0.35…2),
  as the desk's drop-shadow does. `glowing` false (SimOverlay's `GLOW_MAX_HZ`, read through
  `DeskController.lampsGlowing`) drops the halo and keeps the lens, as the desk goes flat.
  SMOKE: `SimOverlay.smokeOf(id)` is the one answer — "brown" for `overloaded`, "grey" for
  `reversed`/`damaged` or a junction burnt (LED, any segment, diode), else null — read
  through `DeskController.smokeOf`. Every modelled part gets a PLUME (`sb.mark()` before
  the build, `sb.plume(id, mark)` after: the top centre of everything drawn for it —
  `MeshBuilder.boundsSince` + its lamps — puff radius 0.28 × its narrower side, 0.3…1).
  `scene3d/smoke.js`'s `plumePuffs(plume, t)` is the desk's CSS plume stood up (2.4 s
  cycle, the keyframes' 0.95/0.85 opacities, rising and swelling); reduced motion holds a
  still column. Halos and puffs are SPRITES — `gl-renderer.js`'s third program, one shared
  unit quad laid along `billboardAxes(camera)`, depth-tested, never depth-written (halos
  pulled toward the camera so the face under them does not clip them). Smoke is the one
  thing that draws CONTINUOUSLY: while any plume smokes (and motion is allowed) `#draw`
  schedules the next frame, and stops when nothing does. Not shown: the desk's red X, the
  warning triangle, an LCD's Spice Lite backlight/contrast.
- **Gestures**: drag orbits, right/middle/Shift-drag pans along the desk, wheel/pinch
  dollies, double-click frames — through `pointer-gesture.js` like every desk drag (a
  move with no button down also ends it) (`scene3d/orbit-camera.js`: yaw 0 looks up the desk from
  its bottom edge as the breadboard is seen; pitch clamped 5°–88°; `fitBounds` SEARCHES
  the distance at which all eight corners of the bounds are on screen, then centres the
  picture, since a bounding sphere frames mostly floor).
