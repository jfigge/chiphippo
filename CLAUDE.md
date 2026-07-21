# Chip Hippo — Project Guide for Claude

## What This Is

**Chip Hippo** is a cross-platform desktop app for designing and simulating **74xx TTL
logic circuits on virtual breadboards**. The main window is an **infinitely pannable,
zoomable desk**: the user places solderless breadboards (Full 830 / Half 400 / Tiny 170
tie points), populates them with 74xx-family DIP chips, wires, switches, LEDs, and
power sources (3 V / 5 V / 12 V), and a **simulation engine** traces electricity from
the power sources, resolves every electrical net, and ripples changes through the
circuit until it settles.

Built with **Electron + Vanilla JavaScript + Node.js**, no UI framework. The
engineering setup mirrors its sibling projects **Rest Hippo** (`../resthippo`) and
**Port Hippo** (`../porthippo`).

## Status

Built stage-by-stage from the plans in `features/` (see `features/ROADMAP.md`).
**Stages 00–100 have landed**: the hardened Electron shell + `window.chiphippo` bridge
and `make` toolchain (00); the infinite desk (10) — camera-transform pan/zoom
(`DeskView` over the pure `desk-geometry.js`), dot grid, zoom controls, settings
store; the breadboard domain model (20) — `board-types.js` + `breadboard.js`
(holes ⇄ positions ⇄ nodes, 830/400/170), `DeskDoc`, desk store + migrations stub,
`desk:load/save` autosave IPC, ipc-parity guard; breadboard rendering & placement
(30) — one static SVG per board (no per-hole DOM), `DeskController` (layers,
add-flow ghost, select/drag/delete, hover addressing), ported popup manager; and
the component framework & DIP chips (40) — `footprints.js` (DIP-14/16/20
derivation), `occupancy.js` (the single collision authority), the data-driven
12-chip 74xx catalog (`catalog/`), desk-doc component ops with `c<n>` ids, the
searchable palette panel, and `chip-view.js` (drawn DIPs with pin hover); and
wires (50) — `{id, from, to, color}` with `w<n>` ids and address endpoints in
the shared occupancy index, the pure `desk/wire-path.js` sag math, `WireLayer`
(one SVG, outline+core+caps, the sanctioned per-wire hit-stroke exception),
the click-click wire tool (shortcut W, chaining, color cycling + toolbar
swatches), cross-board wires riding board drags, and cascade-on-board-delete;
and discrete parts & power (60) — `catalog/parts.js` (slide switch / push
button / LED / PSU with `internalBridges`/`source`/`normalizeParams`
contracts), discretes seating in ANY grid row via generalized
`partPinHoles`/`canPlacePart`, desk-level PSU bricks (`psu<n>` ids,
`nextPsuId`) with addressable wireable terminals (`psu1.+`), `DiscreteView` /
`PsuView` (interactive slider + momentary cap emitting
`chiphippo:part-state`), LED color popover + `F`-to-flip ghost, and PSU
volts via context menu; and the netlist & connectivity inspector (70) — the
DOM-free engine package `scripts/sim/` (`union-find.js` + `netlist.js`
partitioning every point into stable-id nets from board nodes / wires /
component pins / active switch-button bridges), the `NetlistCache` (full
rebuild on `chiphippo:doc-changed` / `chiphippo:part-state`), and the probe
tool (shortcut `I`) with the `NetHighlight` overlay + net-summary readout;
and the 74xx behavioral library (80) — `sim/levels.js` (H/L/Z/X vocabulary,
"floating reads HIGH", ternary gate primitives), the ONE generic
`sim/chip-eval.js` evaluator, `logic` blocks (data, never per-chip code) on
all 12 gate defs, the exhaustive truth-table harness (468 combinations), and
the palette "sim-ready" badge; and the simulation engine v1 (90) — the pure
`sim/resolve.js` (per-net driver → level with supply-beats-output strength
precedence + short/conflict taxonomy) and `sim/engine.js` (power gating from
VCC/GND nets, the warm-started settle loop with a 200-iteration oscillation
cap, damage bookkeeping — reported, never mutated by the pure engine), the
renderer-side `SimController` (owns Run/Stop, re-settles on every input event,
publishes `chiphippo:sim-state`, persists 12 V damage through `desk-doc`,
routes warnings to the `NotificationStack`), live views (LEDs light on
anode-H/cathode-L, chip health badges, level-tinted probe highlights), and the
header **Run/Stop** toggle (shortcut `Space`) that freezes editing while
running; and sequential logic & clocking (100) — the engine's two-phase
`tick` (pre-settle with the old state → sample edges + `step` every sequential
chip → post-settle with the new state) layered over the Feature 90 solver, the
pure `sim/sequential.js` family builders (D-FF / JK-FF / transparent latch /
sync + up-down counters / SIPO+PISO shift, plus `COMB` decoder/mux units), the
14-chip datasheet-exact wave in `catalog/chips-seq.js` (7473/74/75/76, 74107,
74138/139/151/157/161/164/165/175/193 — non-standard power pins and all), the
desk-level **clock source** brick (`clk<n>` ids, `out`/`gnd` terminals,
1/2/5/10 Hz or manual) with `ClockView`, and the SimController **transport**
(Run / Pause / Step / speed) whose `setInterval` drives clock edges while the
engine stays pure and timerless. When a stage is finished, move its plan file
into `features/done/`.

## Naming & identity

- Product name **Chip Hippo**; npm package `chiphippo`; Electron `appId`
  `com.chiphippo.app`; repo `github.com/jfigge/chiphippo`.
- IPC bridge object **`window.chiphippo`**; global renderer events prefixed
  **`chiphippo:`**.
- App icon source `src/web/chiphippo-icon.svg`; download site domain
  **chiphippo.com** (via `website/CNAME`) when a site lands, falling back to the
  `*.github.io` Pages URL until the domain is configured.

## App icons

Two vector sources drive every raster (regenerate with **`make icons`**):
`chiphippo-icon.svg` (edge-to-edge logo → Windows `.ico`, the Linux `icons/`
set, and `chiphippo-logo.png`) and **`chiphippo-mac-icon.svg`** — the SAME art
inside the macOS **safe area** (a rounded square at ~80% of the canvas with a
**transparent border** on every side, so the dock renders it at native visual
weight) → `chiphippo-mac-icon.png` (electron-builder's `mac`/`mas` icon + the
runtime dock icon). `scripts/make-icons.mjs` runs **under Electron**
(`npx electron …`), rasterising each SVG in a hidden window via `<canvas>` +
`toDataURL` — `qlmanage` flattens SVG transparency onto WHITE, so it must not be
used for these. `main.js` loads the per-platform icon once and sets both the
BrowserWindow `icon` and (darwin) `app.dock.setIcon` so `make debug` shows the
Chip Hippo icon, never the default Electron one. All rasters are committed.

## Source Directories

- `src/app/` — Electron **main** process (Node.js, CommonJS): window lifecycle and
  IPC handlers. All native I/O (filesystem, dialogs) lives here. Key entry points:
  `main.js` (window + lifecycle + ipcMain handlers), `preload.js` (the
  `window.chiphippo` bridge), `window-state.js` (bounds restore with display-fit
  check), and `store/` (`io.js` atomic-write primitives, `settings-store.js`,
  `desk-store.js` + `migrations.js` for the desk document at `userData/desk.json`).
- `src/web/` — **renderer** (Vanilla JS ES modules + plain CSS): the UI. Sandboxed;
  talks to main only through `window.chiphippo.*`. Entry points: `index.html` →
  `scripts/app.js`. Pure DOM-free logic lives under `scripts/desk/` (camera, wire
  path, and `rect-outline.js` union-boundary math), `scripts/model/` (breadboard
  specs/addressing/connectivity, `DeskDoc`, `footprints.js`, `occupancy.js`,
  `mating.js`, and `seating.js` — the world-point → `{board, anchor}` placement
  search), and `scripts/sim/` (the engine package:
  `union-find.js`, `netlist.js`, `levels.js`, `chip-eval.js`, `sequential.js`,
  `resolve.js`, `engine.js`); part metadata
  under `scripts/catalog/` (pure data + integrity test — never part-specific code
  paths); thin view components under `scripts/components/`. `DeskController`
  keeps the whole public surface but delegates cohesive slices to collaborators
  it owns: `sim-overlay.js` (the live LED/badge/clock face + net-level lookups,
  driven from `chiphippo:sim-state`), `probe-inspector.js` (the connectivity
  probe — owns its netlist cache, net-highlight overlay, and status readout),
  and `wire-tools.js` (the click-click wire tool + the endpoint/whole-wire
  drags + the per-wire context menu; it shares the controller's `#mode` through
  a host object so the viewport dispatcher's mode checks are unchanged). All the
  world-coordinate/hit-test geometry the controller used to inline now lives in
  the pure, tested `model/part-geometry.js`. What remains in the controller is
  the direct-manipulation input state machine (the shared `#mode`, board
  placement + the intertwined part rotation, the board/part/marquee drag
  gestures, mounting, selection, doc mutations, and the one viewport pointer
  dispatcher) — one responsibility, exercised by the characterization suite in
  `tests/desk-gestures.test.js`.
- `src/web/fonts/` — bundled Inter variable font; never load fonts from a CDN.
- `src/web/styles/` — `theme.css` (design tokens + reset) and `app.css` (shell). Use
  the tokens; don't hardcode colours/sizes.
- `scripts/` — build tooling (`license-header.mjs`).
- `Makefile` — the authoritative list of dev/build/test commands.
- `src/package.json` — Node dependencies and the electron-builder `build` config.
- `data/` — git-ignored dev `--user-data-dir` used by `make debug`.

Do **not** modify anything under `build/` or `src/node_modules/`.

## Architecture

```
Electron main process (src/app/main.js)
  ├── Stores         (src/app/store/)        settings.json + desk.json (atomic io.js;
  │                                          desk loads through migrations.js)
  ├── Window state   (src/app/window-state.js)  bounds restore + debounced save
  ├── IPC handlers   (app:*, settings:get/set, desk:load/save — more per stage)
  └── IPC bridge     (src/app/preload.js)   →  window.chiphippo.*
        └── Renderer / UI (src/web/scripts/app.js)
              ├── DeskView (components/desk-view.js) ← desk/desk-geometry.js (pure)
              └── DeskController (components/desk-controller.js)
                    owns DeskDoc (model/desk-doc.js ← model/breadboard.js, pure),
                    the surface layers (boards→parts→wires→overlay), and mounts
                    BreadboardView children; autosave via `chiphippo:doc-changed`
```

- **Desk surface layers** (inside `.desk-surface`, established in Feature 30):
  `.layer-boards` → `.layer-parts` (chips) → `.layer-wires` (one shared SVG) →
  `.layer-overlay` (ghosts, hover ring, tooltips — pointer-inert). Boards and
  chips are one static inline SVG each; the tie-point/pin `<rect>`s that draw
  them carry **no id, no `data-*`, and no listener** — all hole/pin *interaction*
  is `holeAt()` / derived-pin math from pointer coordinates, never a per-hole
  event or DOM lookup. The sanctioned per-item event exceptions, all widened
  invisible hit targets where idiomatic SVG beats hand-rolled distance math:
  each wire's hit stroke (`pointer-events: stroke`, `wire-layer.js` — listeners
  on the `g.wire` group), each rotatable discrete's `.part-span-hit` stroke, and
  each push button's `.part-button-cap` (a `pointerdown` target sized to the
  cap). Pan/zoom must never rebuild or
  re-lay-out surface children (transform-only); wires re-render only on doc
  changes or live board drags (positions passed as overrides). NOTE: an `<svg>`
  with width/height 0 renders NOTHING per the SVG spec — zero-size anchors need
  a token 1×1 box + overflow: visible.
- **Components**: `{ id, kind, ref, board, anchor, params }` with `c<n>` ids
  (kinds `chip` | `discrete`); desk-level **bricks** carry `{ id, kind, ref, x, y,
  params }` instead of a board anchor — PSUs (`psu<n>`, kind `"psu"`) and clock
  sources (`clk<n>`, kind `"clock"`, `out`/`gnd` terminals). Bricks share the
  overlap/drag/terminal machinery via `board == null`. Pin positions are always
  DERIVED (footprint + anchor),
  never stored; params are coerced through each def's `normalizeParams`.
  Electrical contracts (`internalBridges`, `source`, `polarity`) live in the
  catalog as pure data + pure functions — never in views or the netlist.
  **Wires**: `{ id, from, to, color }` with `w<n>` ids, `from`/`to` ADDRESSES
  (never pixels) — board holes or PSU terminals (`psu1.+`) — colors from
  `WIRE_COLORS` (a `--color-wire-<name>` token each; LEDs share these tokens).
  `occupancy.js` is the single collision authority (one hole/terminal, one
  lead).
- **Netlist** (`sim/netlist.js`, Feature 70): a pure union-find partition of every
  point into nets, keyed by the lexicographically smallest member address (stable
  across rebuilds). Part state (switch position / button pressed) is an INPUT — a
  switch's `internalBridges` conduct; chip pins are net MEMBERS, never conduits (the
  simulator's job). Always a full rebuild, invalidated on `chiphippo:doc-changed`
  and `chiphippo:part-state`.
- **Chip behavior** (`sim/levels.js` + `sim/chip-eval.js` + `sim/sequential.js`):
  signal levels H/L/Z/X (`asInput` = "floating reads HIGH"). Combinational chips
  (Feature 80) carry a `logic.units` block the ONE generic `evaluate(def, pinLevels)`
  walks — gate primitives, tri-state `BUF3`, and `COMB` units (a pure `compute` fn
  over fanning-out inputs — the decoder/mux vocabulary). Sequential chips (Feature
  100) carry a `logic` block of `{ state0, step, outputs }` built by the pure family
  builders in `sequential.js` (D-FF, JK-FF, transparent latch, sync + up/down
  counters, SIPO/PISO shift); `step(state, inputs, prevInputs)` advances state on
  detected edges + level-sensitive async overrides, `outputs(state, inputs)` drives
  the output pins. **No per-chip evaluator code** — a new 74xx part is data; if it
  can't be expressed, extend the vocabulary, never fork. Zero-delay, power-agnostic;
  the truth-table harness enumerates every gate unit exhaustively, sequential/MSI
  parts prove out in circuit fixtures.
- **Simulation engine** (`sim/resolve.js` + `sim/engine.js`, Feature 90): pure and
  DOM-free. `resolveNet` picks a net's level by strength precedence (supply beats
  chip output; opposing supplies → `X`+short; disagreeing outputs → `X`+conflict;
  `Z`/undriven contributes nothing; a clock source drives its `out` net at output
  strength). `settle({document, netlist, warmStart})` gates each chip on its VCC/GND
  nets (5 V ok, 3 V underpowered-inert, 12 V damaged), then loops
  resolve→`evaluate`→re-drive until a fixpoint or the 200-iteration cap (→
  still-changing nets marked `X` + oscillation). Warm-starting net levels by stable
  netId is exactly why cross-coupled NAND latches HOLD. **`tick(...)` (Feature 100)**
  adds the synchronous two-phase step for stateful parts on top of the same solver:
  ① pre-settle with the OLD per-component state (propagating the new `clockPhase` +
  input changes), ② sample each sequential chip's inputs and `step` it (edges from
  the pre-settle vs the last tick's `prevPinLevels`; async overrides win), ③
  post-settle with the NEW state — all edges observed at once, then the combinational
  cloud settles. The engine is a pure function — it REPORTS `chipStatus` and returns
  run-volatile `state`/`pinLevels`, never mutating `params` and never touching a
  timer. The renderer's `SimController` owns the **transport** (Run / Pause / Step /
  speed), drives each free-running clock's edges from a `setInterval` (handing `tick`
  each clock's current level via `clockPhase`), persists 12 V damage through
  `desk-doc`, re-ticks on every input event, and publishes `chiphippo:sim-state`
  (net levels + chip status + clock levels) that live views render from — views never
  query the engine. Sequential state and clock phases are **run-volatile** (reset on
  Run, never serialized).
- **Popups/menus**: `popup-manager.js` (ported from Port Hippo) is the only
  app-wide dialog/menu seam; build DOM with `dom.js` `el()`. `PopupManager.close()`
  fires a one-way `chiphippo:popup-closed` event so stateful dialogs can reset
  their open-guard however they were dismissed.
- **Application menu + dialogs**: `main.js buildMenu()` installs the native app
  menu; its **About** / **Settings…** items are one-way pushes
  (`menu:show-about` / `menu:open-settings` via `webContents.send`), which the
  preload re-dispatches as `chiphippo:show-about` / `chiphippo:open-settings`
  (the documented main→renderer broadcast pattern — the parity test ignores
  push channels, only `ipcMain.handle`↔`ipcRenderer.invoke`). `app.js` opens the
  matching PopupManager modal: `components/about-dialog.js` (name/subtitle/desc
  + version info from `app:info:get`) and `components/settings-dialog.js`. The
  **Settings dialog is dumb**: it broadcasts a `chiphippo:settings-changed`
  patch and `app.js`'s `applySettings` both persists it (`settings.set`) and
  applies it live. Current settings keys it drives: **`showDeskHub`** (off by
  default — toggles the `DeskHud` overlay via `setVisible`) and
  **`selectionColor`** (`#rrggbb` or null → sets the `--color-selection` custom
  property that `.board-outline-path` strokes with, falling back to
  `--color-accent`). Window bounds and the desk camera (incl. **zoom**) are
  already persisted in `settings.json` (`windowBounds` via `window-state.js`;
  `viewport` via the renderer's debounced save).
- **Pin-assignments window** (Feature 100): double-clicking ANY part (every
  part view fires `dblclick` → `DeskController.#onOpenPinout(ref, rows)`)
  invokes `pinout:open`, and main opens a **separate floating OS window**
  (`web/pinout.html` → `scripts/pinout.js`, rendering
  `components/chip-pinout.js` `buildPartPinout`). One builder per catalog shape:
  DIP chips → the physical two-column diagram; discretes → a linear pin list
  keyed to anchor-hole offsets; PSU/clock bricks → a terminal map. One window
  per ref (re-open focuses); it's `alwaysOnTop` by default, and a native
  right-click menu toggles that for every open pinout and persists it as
  `settings.pinoutFloat` (a de-facto global, ready for a future settings
  dialog). Pure DOM, no modal chrome — the native window frame owns the title
  bar + close.

- The main process owns all filesystem and native I/O. The renderer is sandboxed
  (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`) and
  communicates exclusively via `window.chiphippo.*`.
- **Keep `main.js` ipcMain handlers and the `preload.js` exposure in lockstep** —
  enforced by `app/tests/ipc-parity.test.js` (add new `ipc/*.js` files to its scan
  list; channels follow `area:noun[:verb]`, lowercase + hyphenated).
- **Addresses are the only cross-module currency for holes** (`bb1.f12`); nothing
  outside `model/breadboard.js` does row/column arithmetic by hand. Renderer and
  model call its lattice primitives (`holeAt`, `columnAt`, `rowNear`,
  `clampColumn`, `parseHole`, `parseAddress`) — they never re-derive the offsets.
  The ONE deliberate exception is `app/store/migrations.js`: a frozen snapshot of
  the v1 address grammar that must NOT track the live specs (a spec change would
  silently rewrite already-saved documents), and which as main-process CommonJS
  cannot import the renderer's ESM anyway. Leave its hand-rolled copy alone.
- Live state pushed main → renderer uses one-way broadcasts the preload re-dispatches
  as global `chiphippo:*` `CustomEvent`s (pattern arrives with the first push channel).
- The **simulation engine is pure computation, not I/O** — it lives in the renderer as
  DOM-free ES modules under `src/web/scripts/sim/` (Feature 90), fully testable
  with `node --test` (circuit-fixture suites build docs in code and assert settled
  levels). All user-visible sim state (LEDs, chip badges, probe tints) renders from
  `chiphippo:sim-state` events — never by querying the engine directly.

## Common Commands

```bash
make install   # Install npm dependencies (npm ci, into src/node_modules)
make debug     # Run Electron with hot-reload (primary dev workflow)
make fmt       # Format JS/CSS/HTML via Prettier
make fmt-check # Check formatting without writing
make lint      # Lint JS via ESLint
make test      # License-header guard + Node unit tests (node --test)
make icons     # Regenerate app-icon rasters from the SVG sources (see below)
make build     # Build the Electron app for macOS (dir only, unsigned)
make dmg       # Build an unsigned macOS .dmg (bare `make` default)
make clean     # Remove build/ and dist/
```

## Git Workflow

- **Claude must not create commits.** Do not run `git commit` (or `git push`) — the
  user handles all committing and pushing themselves, even when a task is finished and
  verified. You may stage changes or draft a commit message when asked, but leave the
  actual commit to the user.
- **Never create a branch unless explicitly told to.** This is a solo project; work
  happens directly on the current branch (normally `main`). Do not auto-branch, even
  for large changes.
- When you draft a commit message, end it with the required `Co-Authored-By` trailer.

## Tech Stack

- **Renderer**: Vanilla JS (ES2022 modules), plain CSS with custom-property design
  tokens. **No UI framework, ever** — this is a hard, permanent constraint.
- **Main process**: Node.js, Electron 42+ (CommonJS).
- **Build**: Makefile + npm + electron-builder (no bundler for app code).
- **Lint/format**: ESLint 9 (flat config, `src/eslint.config.js`) + Prettier (defaults).
- **Testing**: Node built-in test runner (`node --test`); jsdom for renderer-component
  tests in later features.

## Coding Conventions

- **No framework** — plain DOM APIs and CSS. Do not introduce React, Vue, or similar,
  or an event-bus library.
- **No god files** — keep each module focused on a single responsibility; split along
  seams rather than letting one file own everything.
- Components are class-based ES modules; follow the pattern in existing files.
- **CSS** uses the custom properties in `src/web/styles/theme.css` — use them, don't
  hardcode colours or sizes.
- **CSS class naming**: `prefix-name` for elements (flat, hyphen-delimited, e.g.
  `desk-viewport`, `app-header-icon`); `block--modifier` for state/variant (e.g.
  `board-hole--occupied`). Never bare state classes (`.active`, `.selected`). The `--`
  double-hyphen is reserved for modifiers (and for `--color-*`/`--space-*` tokens).
- **Pure-logic/DOM split**: all geometry, addressing, occupancy, netlist, and
  simulation logic lives in DOM-free modules with sibling tests; view components stay
  thin. (This is the Port Hippo `card-canvas.js`/`grid-layout.js` discipline.)
- **Pointer-capture drag discipline**: drags use pointer events + `setPointerCapture`
  with a ~4 px threshold separating click from drag — never native HTML5 DnD (per
  `porthippo/src/web/scripts/components/card-canvas.js`).
- **Events vs callbacks**: a parent-owned widget reporting to the one parent that
  created it → **constructor callback**; an app-wide state change any number of panels
  may react to → a global **`chiphippo:*` `CustomEvent`**. No event-bus library.
- IPC channels registered in `main.js` are exposed through `preload.js` as
  `window.chiphippo.*`; keep the two in lockstep.

## Domain reference (shared vocabulary — used by every stage)

- **World unit = one breadboard pitch = 0.1 in (2.54 mm).** All board geometry,
  footprints, snapping, and desk coordinates are integer-friendly in pitch units.
- **A breadboard is not one part — it is STRIPS** (Feature 110), as on a real bench:
  a centre **pin-board** plus dovetailed **power-rail** strips. Each strip is its own
  entity in `doc.boards`; a "breadboard" is a **kit** of them placed in one action.
  - **Strip types** — `pins-full` (63 cols, 630 pts) · `pins-half` (30, 300) ·
    `pins-tiny` (17, 170) · `rail-full` (2 rails × 50) · `rail-half` (2 × 25).
    Pin-boards are 13 tall, rails 3; all three pin-boards share ONE row map.
  - **Kits** (`BREADBOARD_KITS`) — Full 830 = rail@0 · pins@3 · rail@16; Half 400
    likewise; **Tiny 170 is a bare pin-board** (the real part has no rails).
    Offsets are integers, so every hole stays on the global 0.1-in lattice.
  - **Rotation — power rails ONLY** (`canRotate` = `kind === "rail"`). A rail is
    two lines of holes, so it reads the same stood on end: turned 90° beside a
    breadboard it becomes a **signal bus** (a clock line, say) that can tap into
    the board at any point. Pin-boards are pinned at 0 — a trench, and every DIP
    straddling it, is built for one orientation. `board.rot` ∈ `ROTATIONS`
    (0/90/180/270, coerced by `normalizeRotation`, always 0 for a pin-board);
    **R cycles it while the placement ghost is in hand**, and a strip's angle is
    fixed once placed. Hole ids and nodes are always stated in the strip's OWN
    unrotated frame — `rotatePoint`/`unrotatePoint` in `breadboard.js` are the
    only bridge to desk coordinates, and `holePosition`/`holeAt`/`boardSize` all
    take the rotation as a trailing argument. So addresses, occupancy, the
    netlist, and the whole simulation are rotation-blind; only geometry and
    rendering care. The view spins ONE pre-built SVG with a CSS transform
    (`applyBoardRotation`, shared by the placed view and the ghost) that keeps
    the strip pinned to its top-left corner, so `board.x/y` mean the same thing
    at every angle.
    Alongside the assembled boards (`KIT_KEYS`) the same table carries the loose
    single-strip kits (`STRIP_KIT_KEYS` — `pins-full`/`pins-half` bare boards and
    `rail-full`/`rail-half` spare rails), each keyed by its own strip type. The
    Add-board menu offers them below a rule; placement, ghosting, and overlap
    all run the one kit code path.
- **Rows** of a pin-board, top to bottom: `j i h g f` · **trench** · `e d c b a`.
  Each column-half (`a–e`, `f–j`) is one internal 5-hole node; the trench isolates
  the halves — DIP chips straddle it (pins in rows `e` and `f`). A rail strip
  carries both polarities, `+` and `−`, each one continuous node for its length.
- **Groups**: strips snapped together share a `group` id (`g<n>`, or `null` when
  loose) and drag as one rigid unit. A kit arrives pre-grouped. Anything landing
  flush against a board **mates** with it — `model/mating.js` owns the rule
  (`matingEdge`/`rectMatingEdge`: matching size across the shared edge, flush,
  no gap; stacked OR side by side), which drives `matingStrips` →
  `joinMatedGroup`, uniting both strips' whole groups under one id and reusing
  an existing group before minting one. **Placing and dropping follow the ONE
  rule** — a lone strip, a torn-off run, and a whole assembled kit all mate, and
  the controller offers every strip of the set (`#mateStrips`) so a kit touching
  on more than one edge joins them all.
  - **Magnetic snap**: `snapCorrection` (pure, `mating.js`) returns the smallest
    correction — at most `SNAP_RANGE` (2 pitch) on BOTH axes — that lands a
    moving strip flush against one it can dovetail with; the whole set moves by
    it, so a kit snaps as one piece. `DeskDoc.snapBoardsBy(ids, dx, dy)` serves
    drags and `snapKitAt(kit, x, y)` the placement ghost; the controller
    (`#pullToMate` / `#pullGhostToMate`) applies the pull only when the snapped
    position is still legal — a magnet must never turn a legal drop illegal.
    Mismatched sizes never attract, and an already-flush pair is left alone.
  - **Breaking a snap** is a modifier on the board grab. Plain = the whole
    group. **Option** = `matedChain(id, "forward")` — the run reachable from
    the grabbed strip through *below/right* edges only; **Option+Shift** =
    `"backward"` (above/left). The walk stays inside the group, so a strip
    merely resting flush is never dragged along. Dragging a partial set commits
    through `moveBoardsBy(ids, …)`, which tears the group: `#regroupAfterBreak`
    re-derives BOTH halves from what is still mated within each (`matedComponents`),
    minting a fresh id per run of two or more and going `null` for a lone strip —
    fresh on both sides, so the halves can never come out sharing an id. The set
    lights up on mouse-down (`board--drag-set`, a wash not a border, so flush
    neighbours read as one block).
  - **The selection highlighter** outlines the whole set a grab would move, not
    the one strip clicked: `BoardOutline` draws ONE path in the overlay layer
    from `desk/rect-outline.js` (`unionOutline` traces the boundary of a union
    of rects by coordinate compression + edge stitching; `outlinePath` rounds
    the corners), so flush strips show no seam. It follows the drag live, tracks
    an Option grab's torn-off run, and reddens on an illegal drop — boards carry
    no selected/illegal outline of their own.
- **Addresses**: `<ownerId>.<point>` — `bb1.a12` (grid hole), `bb2.+7` (rail hole 7
  on a rail strip), `psu1.+` (component terminal). One hole holds at most one lead
  (pin or wire end).
- **Parts belong to the pin-board** — `comp.board` never names a rail. A rotated
  two-terminal part's free lead is a `{dx, dy}` **bend** from its anchor, resolved
  geometrically against whatever strip lies under it (`partPinAddresses`), so it can
  reach a rail. A lead over nothing resolves to `null` and **floats** — legal, and
  what happens when a rail is moved or deleted; the part keeps its exact position.
  Deleting a strip removes only what is *seated* on it, never a neighbour's lead.

## License headers

The project is **Apache-2.0** (`LICENSE` + `NOTICE` at the root; `"license":
"Apache-2.0"` in `src/package.json`). Every first-party source file must begin with
the standard Apache 2.0 header comment — a hard requirement enforced by a guard.

- **Scope**: first-party `*.js` under `src/app/` and `src/web/scripts/`, `*.css` under
  `src/web/styles/`, and the build scripts under `scripts/`.
- **Exempt**: `src/node_modules/`, and non-comment file types (`*.json`, `*.md`,
  `*.html`).
- **Enforcement**: `scripts/license-header.mjs --check` runs as
  `make test-license-headers`, part of `make test` (so CI fails on a missing header).
- **Auto-fix**: run `make license-headers` to stamp every in-scope file missing the
  header; it preserves shebangs and is idempotent.
