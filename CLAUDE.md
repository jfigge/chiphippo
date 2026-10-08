# Chip Hippo — Project Guide for Claude

## What This Is

**Chip Hippo** is a cross-platform desktop app for designing and simulating **74LS TTL
and CD4000 CMOS logic circuits on virtual breadboards**. The main window is an
infinitely pannable, zoomable **desk**: the user places solderless breadboards (Full
830 / Half 400 / Tiny 170 tie points), populates them with DIP chips, wires, switches,
LEDs and power sources (3 / 5 / 9 / 12 / 15 V), and a **simulation engine** traces
electricity from the
sources, resolves every electrical net, and ripples changes through the circuit until
it settles.

**Electron + vanilla JavaScript + Node.js, no UI framework** — a hard, permanent
constraint. Same engineering setup as its siblings **Rest Hippo** (`../resthippo`) and
**Port Hippo** (`../porthippo`).

## Status

Built stage by stage from the plans in `features/` (see `features/ROADMAP.md`); when a
stage is finished its plan file moves into `features/done/`. Landed:

00 scaffold · 10 infinite desk · 20 breadboard model · 30 rendering & placement ·
40 chip placement · 50 wires · 60 discretes & power · 70 netlist & inspector ·
80 TTL library · 90 simulation engine · 100 sequential & clocking · 110 strips &
groups · 120 net names & labels · 130 buses · 140 build guide & wiring list ·
150 schematic view · 170 memory chips & wide DIPs · 180 file-backed memory ·
190 memory inspector · 200 undo/redo · 210 logic analyzer · 220 ripple clock timing ·
230 user guide & docs · 240 projects & tabbed desktops · 250 single-file projects ·
260 AI circuit builder · 270 example circuits · 280 auto-update · 290 wire-riding part
drags · 310 Mac App Store · 320 AI desk review · 330 shared memory blobs · 340 cluster
drags · 370 external signals · 380 Arduino serial integration · language support ·
400 CD4000 CMOS family · 410 CD4000 batch 2 (the MSI parts and the analog switches).

**Deferred** (`features/deferred/`): 160 export image & PDF, 300 selection drags.
**Still open**: 260 step 15 — refactor `make demos` onto `model/autobuild.js` (which
now has `centreDocument` and a second output to honour); 360 auto-routing (plan still in
`features/`; `model/autoroute.js` + `route-*.js`, the toolbar's Auto-route action).
**Landed without a plan file**: Desktop ▸ Export To — KiCad schematic and Digital `.dig`
(`model/export/`, `app/ipc/export.js`, "Feature 390" in its comments); the **3D view**
(the toolbar's cube segment — `scripts/scene3d/` + `components/desk-3d-view.js` +
`components/gl-renderer.js`, 2026-10-05; see "3D view").
**Spice Lite** (2026-10-07, no feature number): a second, more electrical simulation
engine behind Settings ▸ Spice Lite — time, closed-form RC nodes, fan-out read off the voltages and
brown smoke, PSU current limits and droop, wire resistance, switching spikes and
decoupling (plan `features/done/spice-lite.md`; user guide `spice-lite.md`; see
"Spice Lite"); and real LEDs — milliamps by colour datasheet, brightness, overdrive
and burn-out by junction temperature (2026-10-07, `features/done/spice-lite-leds.md`); and
EVERY NET A VOLTAGE — every input reads its own pin's voltage, diodes and transistors
as devices, chips powered off the rails, output/input limits, powered clock bricks and
real open-collector parts in both engines (2026-10-07, `features/done/spice-lite-audit.md`);
and the TIMERS AS SILICON — each timing part its datasheet's comparators and internals
on its pins, capacitor coupling, crossing listeners, fast oscillations drawn by schedule,
the LCD backlight and contrast (2026-10-07, `features/done/spice-lite-2-plan.md`).
**Batched ticks** (2026-10-07, no feature number, `features/done/batched-ticks.md`): clock
edges and timer wakes run in batches between frames, one `sim-state` per batch, every
tick on `chiphippo:sim-tick`; clocks to 1 kHz, the timer cap with them, lamps flat past
25 Hz (see `.claude/rules/simulation.md` → "Batched ticks").
**Landed without a feature number**: capacitors, typed resistor/capacitor values and the
RC timers — the 555 and the CD4047B/4060B/4098B/4538B (plan
`features/done/chiphippo-capacitors-555.md`; see "Values, capacitors & timed parts"); the
discretes — inductors, diodes, transistors (plan `features/done/chiphippo-discretes.md` +
`-amendment.md`; see "The discretes"); and, with no plan, the CD4000 parts those two
made possible — the CD4528B one-shot, the CD4541B programmable timer and the CD4007UB's
bare MOSFETs (2026-10-04). The CD4536B and CD4521B were read and left out (the 4536's
one-shot is given only as curves, its SET/test logic only as a scanned gate diagram;
the 4521's RC drawing could not be reconciled with its scanned logic diagram), as were the CD4046B (its
VCO wants a voltage) and the 4060's crystal mode (no crystal part). Also the **custom chip
designer** — a user-designed DIP whose behaviour is a Verilog subset, with a debugger that
steps through it while the circuit runs (plan `features/done/custom-chip-designer.md`,
2026-10-05; see "Custom chips").

## Naming & identity

- Product **Chip Hippo**; npm package `chiphippo`; Electron `appId` `com.chiphippo.app`;
  repo `github.com/jfigge/chiphippo`.
- IPC bridge object **`window.chiphippo`**; renderer events prefixed **`chiphippo:`**.
- Icon source `src/web/chiphippo-icon.svg`; download domain **chiphippo.com** (via
  `website/CNAME`), falling back to the `*.github.io` Pages URL until DNS is configured.

## Source layout

- **`src/app/`** — Electron **main** (Node, CommonJS): window lifecycle, IPC, and ALL
  native I/O. `main.js` (windows + lifecycle + `ipcMain`), `preload.js` (the
  `window.chiphippo` bridge), `window-state.js` (bounds restore with display-fit check),
  `close-guard.js` (the close/quit state machine, pure so it is testable), `i18n.js`,
  `updater.js`, `store-build.js`, `pinout-chip.js` (a custom chip's pinout-window data,
  held to shape), plus:
  - `store/` — `io.js` (atomic writes), `settings-store.js`, `project-store.js` +
    `project-images.js` + `project-migrate.js`, `desk-store.js` + `migrations.js` (desk
    schema migrations + the by-PATH reader `project-migrate.js` uses), `mem-store.js`,
    `credential-store.js` (`safeStorage` API key), `custom-chips.js` (the chip library
    and a designed chip's shape), `bookmark-store.js` (security-scoped
    bookmarks for MAS), `recent-files.js` (pure list arithmetic).
  - `ai/` (`providers.js` + `client.js`), `datasheets/` (`sources.js` + `download.js`),
    `updater.js` — **the app's only three outbound network calls**, all in main (the
    renderer's CSP forbids one), all the same shape (a hard-coded statement of where
    they may go beside the thing that goes there), and all **opt-in**, so an
    unconfigured Chip Hippo never reaches the network at all.
  - `serial/` (`protocol.js`, `link.js`, `ports.js`, `serial-manager.js`) + `ipc/serial.js`
    — the Arduino serial integration's main half (a USB port, not the network; see
    "Arduino serial integration").
- **`src/web/`** — **renderer** (ES modules + plain CSS), sandboxed, talking to main only
  through `window.chiphippo.*`. `index.html` → `scripts/app.js`.
  - `scripts/desk/` — pure geometry: `desk-geometry.js` (camera), `wire-path.js` (sag +
    polyline), `ribbon-path.js`, `rect-outline.js` (union-boundary math).
  - `scripts/model/` — pure document logic: `breadboard.js` + `board-types.js`,
    `desk-doc.js`, `footprints.js`, `occupancy.js`, `mating.js`, `seating.js`,
    `part-geometry.js`, `part-move.js` + `cluster-move.js`, `design-clip.js`,
    `paste-cluster.js`, `project-doc.js`, `schematic-layout.js`, `hex-format.js`,
    `wire-length.js`, `wire-colors.js` (which also OWNS `WIRE_COLORS`, re-exported from
    `desk-doc.js`), `wire-crossing.js`, `selection-toggle.js`, `signals.js`,
    `signal-keys.js`, `pin-resolve.js`, `column-allocator.js`, `autobuild.js`,
    `autobuild-verify.js`, `spec-lint.js`, `integration.js`, `integration-runtime.js`,
    `integration-codegen.js`, `serial-connections.js`, `component-value.js` (THE value
    parser) + `si-value.js` + `ohm-format.js` + `farad-format.js` + `henry-format.js` +
    `volt-format.js` + `hertz-format.js` (the one Hz label, shared by the catalog's
    `hzLabel` and `timing-summary.js`), `resistor-bands.js`, `timing-summary.js`, `custom-chip.js` (a
    designed chip's shape, pins and problems) + `chip-debug.js` (the debugger's pure
    replay).
  - `scripts/hdl/` — the custom chips' Verilog subset, pure and DOM-free: `lexer.js`,
    `parser.js`, `analyze.js`, `values.js` (4-state arithmetic), `memory.js` (an array's
    persistent copy-on-write contents), `program.js` (the
    interpreter + the debugger's traces), `compile.js`, `header.js`, `highlight.js`.
  - `scripts/sim/` — the DOM-free engine: `union-find.js`, `netlist.js`, `levels.js`,
    `chip-eval.js`, `sequential.js`, `resolve.js`, `engine.js`, `chip-status.js`
    (`CHIP_STATUS`, re-exported by engine.js), `settle-pass.js` (one settle pass's
    primitives — drivers, channel joins, `resolveAll` and its readings), `settle-index.js`
    (who depends on what) + `incremental.js` (the incremental settle), `junction.js`,
    `w65c02.js`, `z80.js`, `z80-ops.js`, `analog-switch.js`, `timing.js`, `rc-trace.js`,
    `timer-555.js`, `monostable.js`, `ripple-oscillator.js`, `programmable-timer.js`,
    `engines.js` (the seam: `ENGINES` + `engineFor`), and `spice/` — Spice Lite:
    `config.js`, `params.js`, `rc-curve.js`, `engine.js`, `network.js` (the one
    Newton solve), `voltages.js` (every net's voltage, every pass), `lamps.js`,
    `leds.js`, `diodes.js`, `output-stage.js`, `loads.js`, `supply.js`, `sag.js` (see
    "Spice Lite").
  - `scripts/ai/` — `catalog-brief.js`, `generate.js`, `connection.js`, `usage.js`
    (pure).
  - `scripts/scene3d/` — the 3D view's pure half (see "3D view"): `mat4.js`, `mesh.js`
    (`MeshBuilder`), `orbit-camera.js`, `palette.js`, `scene-builder.js`, `scene.js`
    (`buildScene`, `lampState`), `board-model.js`, `part-models.js`, `wire-model.js`,
    `annotation-model.js`.
  - `scripts/bench/` — performance tooling, outside `make test`: `busy-circuit.js`
    (a scalable busy fixture compiled through `model/autobuild.js` — chained 74LS161s
    with '47 displays, '138 LED rows and '283 bars on one clock) and
    `engine.bench.js` (`make bench`: ms/tick in both settle modes and under Spice Lite,
    where a tick goes, settle/step passes per tick, the chip evaluations and net
    resolutions each mode PERFORMS per pass and the incremental fallbacks — via
    `opts.stats` — and per-chip evaluation counts via the observer's optional
    `evaluated` hook). `scripts/profile-desk.mjs` (`make profile`) runs the same
    fixture in the real app and records a DevTools trace + CPU profile.
  - `scripts/catalog/` — part metadata as pure data + integrity tests; never
    part-specific code paths. `index.js`, `parts.js` (+ `discretes.js`,
    `lead-offset.js`, `value-fields.js`), `chips-*.js` (`chips-seq.js`, `chips-io.js`, `chips-cpu.js`, …),
    `symbols.js`, `labels.js`, `custom-chips.js` (a designed chip → its catalog def),
    `run-latches.js` (the params a run writes — `damaged`, `overloaded` — kept by every
    normalizer, stripped on every road into a desk).
  - `scripts/components/` — thin views. `DeskController` keeps the public surface but
    delegates to `sim-overlay.js` (live LED/badge/clock faces from
    `chiphippo:sim-state`), `probe-inspector.js` (shortcut `I` — the WIRING netlist for
    what it shows and names, the live one for its level tint, the `NetHighlight`
    overlay, the net-summary readout), `wire-tools.js` (the wire tool,
    endpoint/whole-wire drags, per-wire menu — sharing `#mode` through a host object) and
    `bus-tools.js`. What remains in the controller is the direct-manipulation input state
    machine (mode, board placement + rotation, the drag gestures, mounting, selection,
    doc mutations, the one viewport pointer dispatcher), exercised by
    `tests/desk-gestures.test.js`.
  - `locales/` — one bundled catalog per language; read by MAIN and handed to each
    renderer over `i18n:load`. A renderer never reads or fetches one.
  - `fonts/` — bundled Inter variable font; **never load fonts from a CDN**.
  - `styles/` — `theme.css` (tokens + reset) and `app.css` (shell). Use the tokens.
    **A `font-size` is either a `--font-size-*` token or a world/SVG user unit with a
    comment saying so** — a bare px is a piece of the app that stops resizing
    (`tests/type-scale.test.js` enforces it).
  - `docs/`, `datasheets/`, `demos/` — committed content (see their sections).
- **`scripts/`** — build tooling (`license-header.mjs`, `build-docs.mjs`,
  `build-pdf.mjs`, `make-icons.mjs`, `check-datasheets.mjs`, `demo-build.mjs`,
  `demo-bench.mjs`, `demo-specs.mjs`, `make-demos.mjs`, `make-gate-demos.mjs`).
- **`Makefile`** — the authoritative list of dev/build/test commands.
- **`src/package.json`** — dependencies + the electron-builder `build` config.
- **`data/`** — git-ignored dev `--user-data-dir` used by `make debug`.

Do **not** modify anything under `build/` or `src/node_modules/`.

## Architecture

```
Electron main (src/app/main.js)
  ├── Stores        (src/app/store/)      settings.json + ONE project file
  │                                       (atomic io.js; every desk document inside
  │                                       it loads through migrations.js)
  ├── Window state  (window-state.js)     bounds restore + debounced save
  ├── IPC handlers  (app:*, settings:*, project:*, desktop:*, mem:*, ai:*, …)
  └── IPC bridge    (preload.js)      →   window.chiphippo.*
        └── Renderer (src/web/scripts/app.js)
              ├── DeskView (components/desk-view.js) ← desk/desk-geometry.js (pure)
              ├── ProjectWorkspace (components/project-workspace.js)
              │     owns the open project + which desktop is on the desk
              └── DeskController (components/desk-controller.js)
                    owns DeskDoc (model/desk-doc.js ← model/breadboard.js, pure),
                    the surface layers (boards→parts→wires→overlay), and mounts
                    BreadboardView children
```

**Hard rules**

- Main owns all filesystem and native I/O. The renderer is sandboxed
  (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`) and talks to main
  only through `window.chiphippo.*`.
- **Keep `main.js`'s `ipcMain` handlers and `preload.js`'s exposure in lockstep** —
  enforced by `app/tests/ipc-parity.test.js` (add new `ipc/*.js` files to its scan list).
  Channels are `area:noun[:verb]`, lowercase + hyphenated.
- Live state pushed main → renderer uses one-way broadcasts the preload re-dispatches as
  global `chiphippo:*` `CustomEvent`s. The parity test ignores push channels — it checks
  `ipcMain.handle` ↔ `ipcRenderer.invoke` only.
- **The renderer writes its own settings, never main's**: `settings:set` passes through
  `rendererPatch` (`store/settings-store.js`), which drops the main-owned keys
  (`MAIN_OWNED` — `recentProjects` above all, since it IS the Open Recent allowlist) and
  keeps a `datasheetDir` only when main vouches for it (dialog-established, the app's own
  download folder, or the value already stored).
- **Every path crossing the bridge is gated by main's `knownPath`**: anything inside the
  app's saves folder, plus what a dialog (or an opened project) established this session.
  The one exception is `settings.recentProjects`, which is itself the allowlist for
  re-opening an MRU entry (answering `{ok:false, code:"missing"}` for a file that has
  gone, so the renderer can offer to forget it).
- **The simulation engine is pure computation, not I/O** — DOM-free ES modules under
  `src/web/scripts/sim/`, fully testable with `node --test` (circuit-fixture suites build
  documents in code and assert settled levels). All user-visible sim state (LEDs, badges,
  probe tints) renders from `chiphippo:sim-state`, never by querying the engine.

## Topic rules — the rest of this guide

This file holds only what nearly every task needs. **Everything else lives in
`.claude/rules/`**, one file per topic, each carrying a `paths:` list so it loads
by itself when a matching file is read or edited. The section names are unchanged, so a
code comment that says `see CLAUDE.md → "Language support"` (or "Power layout", …)
means the section of that name in the file below.

- **When a task touches a topic from a direction its globs will not catch** (a hub file
  like `app.js`, `main.js`, `desk-controller.js` or `desk-doc.js`, a cross-cutting
  question, a plan), **Read the matching rule file first** — it is not loaded otherwise.
- **New notes go in the matching rule file, not here.** Keep this file under ~50k
  characters; Claude Code refuses to load past 150k, and every character here is paid on
  every session. A new topic gets a new rule file with its own `paths:` and a row below.

| Rule file | Sections | What it covers |
|---|---|---|
| `.claude/rules/serial.md` | "Arduino serial integration" | Arduino serial integration: Outputs/Inputs, the wire protocol, link, Mock, codegen (C++/Python), connection window |
| `.claude/rules/ai-builder.md` | "AI circuit builder" | AI circuit builder: netlist spec, compiler (autobuild), seating/routing, verify ladder L3a–L7, prompt/catalog card, key storage, panel |
| `.claude/rules/generated-circuits.md` | "Power layout — the three rules every GENERATED circuit follows" · "Example circuits" | Power layout (the three rules every generated circuit follows) + Example circuits (demo benches, hand-built examples) |
| `.claude/rules/custom-chips.md` | "Custom chips — the chip designer" | Custom chips: chip library, the Verilog subset (hdl/), the designer window, the debugger |
| `.claude/rules/projects.md` | "Memory chips" · "Projects, files & desktops" | Projects, files & desktops (the .chiphippo file, autosave/recovery, close guard, tabs, import/export) + Memory chips (ROM sidecars, inspector) |
| `.claude/rules/simulation.md` | "Simulation" · "Logic families (Features 400, 410)" | Simulation engine (netlist, levels, chip-eval, settle/incremental, CPUs, analog switches, tick, SimController) + Logic families (74LS vs CD4000) |
| `.claude/rules/spice-lite.md` | "Spice Lite — the second engine" | Spice Lite: the second engine — every net a voltage, hooks seam, closed-form RC nodes, devices, loads/supply/sag, real LEDs, spikes, analyzer voltages |
| `.claude/rules/parts.md` | "Values, capacitors & timed parts" · "The discretes — inductors, diodes, transistors" | Values, capacitors & timed parts (value parser, combo fields, 555/CD4000 timers, rc-trace) + The discretes (inductors, diodes, transistors) |
| `.claude/rules/desk-editing.md` | "Desk surface & rendering" · "Schematic view" · "Selection" · "Moving parts and clusters" · "The wire gauge & the BOM cutting list" | Desk surface & rendering, Schematic view, Selection, Moving parts and clusters (Option-drag riders), wire gauge & BOM cutting list |
| `.claude/rules/signals.md` | "External signals" | External signals: signal buttons + flags, keys 1–0, engine drive, clips, schematic stubs |
| `.claude/rules/i18n.md` | "Language support" | Language support: main-resolved locale, t()/tf()/m(), relabel in place, what stays English, the i18n guards |
| `.claude/rules/settings.md` | "Settings" | Settings dialog: every setting, font-size scale (one base, derived ramp), ⌘= vs ⌥⌘=, info notes, [hidden] rule |
| `.claude/rules/ui-chrome.md` | "Header toolbar" · "Popups & menus" · "Context menus & dialogs" · "Application menu" · "Auxiliary windows" | Header toolbar (pills, readouts, parts tray rail), Popups & menus, Context menus & Properties dialog, Application menu, Auxiliary windows (pinout) |
| `.claude/rules/view-3d.md` | "3D view" | 3D view: lazy WebGL, pure scene3d/ builder, models from the desk's own outlines, lamps, gestures |
| `.claude/rules/docs-assets.md` | "App icons" · "Datasheet crops" · "User guide & docs" · "Downloading the datasheets" | User guide & docs (one Markdown → app/website/PDF), Datasheet crops, Downloading the datasheets, App icons |
| `.claude/rules/release.md` | "Auto-update & the store gate" · "Mac App Store packaging" · "Release signing (the direct-download mac build)" · "Linux packaging" | Auto-update & the store gate, Mac App Store packaging (bookmarks, sandbox), Release signing, Linux packaging |

## Domain reference (shared vocabulary)

**World unit = one breadboard pitch = 0.1 in (2.54 mm) — but the two axes are quantized
differently, because a real breadboard is.**

- **Horizontally the pitch IS the lattice**: a column is one unit, board x snaps to an
  integer, and every strip lines its columns up with every other.
- **Vertically there is no lattice**, and pretending there was compressed a 53.4 mm board
  into 48.3. A rail is 8.9 mm tall (3.50 pitch), a pin-board 35.6 (14.02), the channel
  2.3 (0.91) — not one of them whole. `board-types.js` states those THREE measurements in
  MILLIMETRES (`VERTICAL_MM`) and derives every strip height, row offset and rail row
  from them on a **0.01-unit grid** (`desk-doc.js`'s `boardCoord`, the quantum a wire
  waypoint also keeps). The fourth number a ruler reaches — 7.0 mm between the closest
  pins across a rail↔pin-board dovetail — is left DERIVED (2.76 pitch, 7.01 mm), as the
  check that the two strips' margins agree.
- So a board's y is fractional and a kit stacks at 0 · 3.50 · 17.52. **Nothing may round
  it**: `Math.round` on a board y jams a kit's lower strips into the neighbour above and
  `normalizeDocument` then DROPS the overlap. The desk stays tidy anyway because a board
  is PLACED at a whole-pitch x and DRAGGED by a whole-pitch delta — only a dovetail puts
  a board on a fraction, and there the exact value is the point. `mating.js` compares
  flush edges with a tolerance (`FLUSH_EPS`): a sum of 0.01-grid values need not be
  exact in binary (4.51 − 3 is 1.5099999999999998), and a joint that fails by an
  ulp is a kit that silently comes apart.
- **Integer by design**: the pitch within a group of five rows; the spacing between a
  strip's two RAILS (1 = 2.54 mm, so a lead bridging `+` to `−` lands square); and the 3
  pitches ACROSS the channel (7.62 mm, the 0.3-in row spacing every DIP is made to). So
  every trench-straddling footprint is exactly what it was — what moved is the plastic
  around the holes, not the holes.
- Two consequences: a resistor's `minSpan` is **2.5** (a quarter-watt body, ~6.3 mm) and
  not a whole 3, or the 2.76 reach from row `a` to the rail beside it — the commonest
  bench move there is — would be refused; and a bent lead's `{dx, dy}` is quantized
  rather than required whole, so it lands ON the hole it reaches. Existing desks re-stack
  on load via the **v10 → v11** migration in `app/store/migrations.js`.

**A breadboard is not one part — it is STRIPS** (Feature 110), as on a real bench: a
centre **pin-board** plus dovetailed **power-rail** strips. Each strip is its own entry
in `doc.boards`; a "breadboard" is a **kit** of them placed in one action.

- **Strip types** — `pins-full` (63 cols, 630 pts) · `pins-half` (30, 300) · `pins-tiny`
  (17, 170) · `rail-full` (2 rails × 50) · `rail-half` (2 × 25). Pin-boards are 14.02
  tall, rails 3.50 with their two lines one pitch apart, centred; all three pin-boards
  share ONE row map, its rows 1.51 in from each edge.
- **Kits** (`BREADBOARD_KITS`) — Full 830 = rail@0 · pins@3.50 · rail@17.52 (21.02 tall);
  Half 400 likewise; **Tiny 170 is a bare pin-board** (the real part has no rails). `dx`
  is an integer; `dy` is each strip's measured height quantized to 0.01. Alongside the
  assembled kits (`KIT_KEYS`) the same table carries the loose single-strip kits
  (`STRIP_KIT_KEYS`), offered below a rule in the Add-board menu; one code path serves
  both.
- **Rotation — power rails ONLY** (`canRotate` = `kind === "rail"`). A rail is two lines
  of holes, so it reads the same on end: turned 90° beside a board it becomes a signal
  bus that can tap in anywhere. Pin-boards are pinned at 0 (a trench and every DIP
  straddling it are built for one orientation). `board.rot` ∈ `ROTATIONS`, coerced by
  `normalizeRotation`; **R cycles it while the placement ghost is in hand**, and a placed
  strip's angle is fixed. **Hole ids and nodes are always stated in the strip's OWN
  unrotated frame** — `rotatePoint`/`unrotatePoint` are the only bridge to desk
  coordinates, and `holePosition`/`holeAt`/`boardSize` take the rotation as a trailing
  argument. So addressing, occupancy, the netlist and the whole simulation are
  rotation-blind; only geometry and rendering care. The view spins one pre-built SVG with
  a CSS transform (`applyBoardRotation`, shared with the ghost) that keeps the strip
  pinned to its top-left corner, so `board.x/y` mean the same at every angle.
- **Rows** of a pin-board, top to bottom: `j i h g f` · **trench** · `e d c b a`. Each
  column-half (`a–e`, `f–j`) is one internal 5-hole node; the trench isolates the halves;
  DIPs straddle it (pins in rows `e` and `f`; a 600-mil part's in `d` and `h` — below). A
  rail strip carries both polarities, `+` and `−`, each one continuous node for its length.
- **A DIP seats at its package's real width** (`model/footprints.js`, 2026-10-05, plan
  `features/done/chiphippo-600mil-chip-rendering.md`). `body` in `DIP_PACKAGES` decides it: a
  300-mil part (≤ DIP-20, the DIP switch banks) takes rows `e`/`f`, 3 pitches straight
  across the trench; a 600-mil one (DIP-24…40 — memories, 65xx, Z80, 74LS181) takes rows
  `d`/`h`, 6 pitches, its BODY standing over rows `e`–`g` between them. **The anchor's
  row says which** (`dipRows(pkg, anchorRow)`; `seatRow(pkg)` is the row a NEW seat
  takes): a 600-mil part anchored in `e` is the narrow seat every DIP had before, and a
  saved desk keeps it exactly — no migration. `chipSeat` (palette placement, a solo
  drag, ⌘V) gives the true width — and seats from anywhere the chip is DRAWN over
  (`seatBand`: `SEAT_BAND`, widened for a wide seat to its farther pin row, h at 3.5
  pitch, plus `LEG_REACH`), or a drag grabbing the upper legs found no seat at all — so moving an old narrow chip on its own re-seats it
  wide; a GROUP move or cluster paste is rigid, so each chip keeps the row (and width)
  it had (`partSeatAt`'s `chipRow`, `resolveClusterTargets`/`resolveCluster` refuse a
  chip carried out of its row). The covered holes are the body's (`coveredHoles` →
  occupancy.js `partCoverHoles`/`partCoverAddresses`): `buildOccupancy` claims them as
  `{kind: "body", componentId}` FIRST (lowest precedence), so `canPlaceWire`/
  `canReendWire`/flags/tags, the auto-router (`leadNodes`, `rail-reseat`) and
  `normalizeDocument` all refuse them for nothing more than reading the one map;
  `canPlacePart` also refuses a wide chip whose body would land on a lead already there;
  `prepareClusterMove` adds them to its claim set; `hoverHitAt` offers no ring there; and
  `partRideShift` keeps a rider out from under the body (and, when a chip CHANGES width,
  off its new pin holes — the rider travels with its pin instead). Drawing:
  `chip-view.js`'s `chipSpan(pkg, anchor)` (3 or 6, equal to the board's own `d`→`h`
  distance, which a test measures) sizes `chipBox`/`chipBodyBox`/`buildChipSvg`, and a
  `ChipView` redraws when a move changes its width; the 3D model reads the same
  `chipBodyBox`. The generators — the AI compiler, the demo benches — still seat every
  DIP in `e`/`f`, a seat that stays legal.
- **Addresses** are the only cross-module currency for holes: `<ownerId>.<point>` —
  `bb1.a12` (grid hole), `bb2.+7` (rail hole), `psu1.+` (component terminal). One hole
  holds at most one lead. **Nothing outside `model/breadboard.js` does row/column
  arithmetic by hand** — callers use its lattice primitives (`holeAt`, `columnAt`,
  `rowNear`, `clampColumn`, `parseHole`, `parseAddress`, `nodeOf`, `holeAlong`,
  `holeAlongTo`, `holeAcross`, `rowsBetween`). The ONE deliberate exception is
  `app/store/migrations.js`: a frozen snapshot of the v1 address grammar that must NOT
  track the live specs (a spec change would silently rewrite saved documents) — which is
  why it stays a copy even though main now CAN `require()` a dependency-free renderer ES
  module (the serial protocol's `serial-wire.js` does). **Leave its hand-rolled copy
  alone.**
- **Groups**: strips snapped together share a `group` id (`g<n>`, or `null` when loose)
  and drag as one rigid unit; a kit arrives pre-grouped. Anything landing flush against a
  board **mates** — `model/mating.js` owns the rule (`matingEdge`/`rectMatingEdge`:
  matching size across the shared edge, flush, no gap; stacked or side by side), driving
  `matingStrips` → `joinMatedGroup`, which unites both strips' whole groups and reuses an
  existing group before minting one. A lone strip, a torn-off run and a whole kit all
  mate by the one rule, and the controller offers every strip of the set (`#mateStrips`).
  - **Magnetic snap**: `snapCorrection` (pure) returns the smallest correction — at most
    `SNAP_RANGE` (2 pitch) on both axes — that lands a moving strip flush against one it
    can dovetail with; the whole set moves by it. `DeskDoc.snapBoardsBy` serves drags,
    `snapKitAt` the placement ghost, and the controller (`#pullToMate` /
    `#pullGhostToMate`) applies the pull only when the snapped position is still legal —
    **a magnet must never turn a legal drop illegal**. Mismatched sizes never attract; an
    already-flush pair is left alone.
  - **Breaking a snap** is a modifier on the board grab: plain = the whole group;
    **Option** = `matedChain(id, "forward")` (the run reachable through below/right edges
    only); **Option+Shift** = `"backward"`. The walk stays inside the group, so a strip
    merely resting flush is never dragged along. A partial set commits through
    `moveBoardsBy`, which tears the group: `#regroupAfterBreak` re-derives BOTH halves
    from what is still mated within each (`matedComponents`), minting a fresh id per run
    of two or more and `null` for a lone strip — fresh on both sides, so the halves can
    never share an id. The set lights up on mouse-down (`board--drag-set`, a wash not a
    border, so flush neighbours read as one block).
  - **The selection highlighter outlines the whole set a grab would move**:
    `BoardOutline` draws ONE path in the overlay from `desk/rect-outline.js`
    (`unionOutline` traces the boundary of a union of rects by coordinate compression +
    edge stitching; `outlinePath` rounds the corners), so flush strips show no seam. It
    follows the drag live, tracks an Option grab's torn-off run, and reddens on an
    illegal drop — boards carry no selected/illegal outline of their own.

## Document model

- **Components**: `{ id, kind, ref, board, anchor, params }` with `c<n>` ids (kinds
  `chip` | `discrete`). Desk-level **bricks** carry `{ id, kind, ref, x, y, params }`
  instead of a board anchor — PSUs (`psu<n>`, `nextPsuId`) and clock sources (`clk<n>`,
  `out`/`gnd` terminals, `CLOCK_HZ`). Bricks share the overlap/drag/terminal machinery
  via `board == null`, and are drawn by `DiscreteView` / `PsuView` / `ClockView` (the
  interactive slider and momentary cap emit `chiphippo:part-state`). **Pin positions are
  always DERIVED** (footprint + anchor), never stored; params are coerced through each
  def's `normalizeParams`. Electrical contracts (`internalBridges`, `source`, `polarity`)
  live in the catalog as pure data + pure functions — never in views or the netlist.
- **A chip and a LINEAR discrete belong to the pin-board** — `comp.board` never names a
  rail (the footprint is grid-column arithmetic). A **rotated two-terminal part**
  (resistor / LED) is a free two-ends device: pin 1 anchors in ANY hole, grid row or
  power rail (`LEAD_ANCHOR_RE` in `occupancy.js`), and pin 2's free lead is a `{dx, dy}`
  **bend** resolved geometrically against whatever strip lies under it (`partPinHoles` /
  `partPinAddresses`, checked by `canPlacePart`). Both leads can reach rails, subject
  only to `minSpan`. A lead — or the anchor — over nothing resolves to `null` and
  **floats**: legal, and what happens when a rail is moved or deleted; the part keeps its
  exact position. Deleting a strip removes only what is *seated* on it
  (`comp.board === id`), never a neighbour's lead.
- **Wires**: `{ id, from, to, color }` with `w<n>` ids; `from`/`to` are ADDRESSES (never
  pixels) — board holes or component terminals; colours from `WIRE_COLORS` (a
  `--color-wire-<name>` token each, shared with LEDs). **`occupancy.js` is the single
  collision authority** (one hole/terminal, one lead).
- **A dragged SINGLE POINT snaps within a hole's reach, or not at all** — a wire END,
  a two-terminal part's lead (and its pin 1, which carries a body drag), a signal flag,
  an Output/Input tag. ONE rule for all of them: `nearestLegalPoint` in
  `model/part-geometry.js` (`END_SNAP_RADIUS` 1.2 — orthogonal neighbours, never a
  diagonal). The candidates are the REAL points around the cursor —
  `connectionPointsNear` ← `holesNearWorld` ← `holesNear` — nearest first, and the first
  one the drag's own check accepts wins (`canReendWire`, `canPlacePart`,
  `canPlaceSignalFlag`, …; `accepted` hands back whatever seat that check derived, so it
  is never derived twice); nothing legal in reach and the tip rides the cursor, and a
  release there reverts. The shared `.hole-ring` marks the target (`aimRing` in
  `hole-rings.js`), red on a refused hole — except for a body drag, whose part previews
  its own seat. ONE bounded resolve serves preview and drop — and when the RELEASE point
  lands nowhere (it would revert), the drop falls back to the target the last move SHOWED,
  snapped and ringed: what was on screen at the release is a promise. The release point
  still wins whenever it lands, a flag's or tag's UNPLUG included. **Never search
  whole-pitch offsets (`nearestLegalOffset`) from a raw cursor**: it is not on the lattice, so half a pitch off a column every sample
  misses every hole on that strip while a strip on another lattice (a turned rail's
  holes sit on quarters) answers from pitches away — which is how an end dropped
  beside f1 used to land on a rail strip nearly five pitches off. Those offsets are
  for anchors that ARE on the lattice (a hole, a rigid delta between holes).
- **Wire layout — direct or routed** (`WIRE_LAYOUTS`, set in the wire's Properties
  dialog). A **direct** wire is the sagging hole-to-hole curve: its shape is DERIVED from
  its ends, so it carries no `layout` and no `points` at all — absence IS the default
  (the same omit-when-default convention as Name/Description), so a document that never
  routed anything round-trips byte-identical. A **routed** wire adds `layout: "routed"`
  and up to `MAX_WIRE_POINTS` (20) `points`, draws as a straight polyline through them
  (`polylinePath`/`fadedPolyline` in `desk/wire-path.js`, and `wirePath`'s counterparts),
  and its BODY DRAG **bends** instead of translating: pressing along the run inserts a
  waypoint at the segment `nearestOnPolyline` names, dragging a knob moves it, and
  dropping either onto a neighbouring point (a waypoint or one of the wire's own ends)
  MERGES it away. So a routed wire has no rigid whole-wire translate.
  - Waypoints are the ONE part of a wire that is not an address — free desk coordinates
    to two decimals, deliberately off the lattice (they sit in the space BETWEEN boards,
    so snapping them to an unrelated hole would be a lie) — which is why `translateAll`,
    `pasteDesign` and `moveBoardsBy` shift them EXPLICITLY where every other part of a
    wire rides its board for free.
  - **A board drag carries the bends drawn over it, PER POINT**
    (`DeskDoc.wirePointsOverBoards`). A waypoint rides when it lies over one of the
    moving strips' footprints (inclusive of the edge): position is the only thing a bend
    has to say where it belongs — one drawn over a board was drawn around what is ON it,
    one out in the free space belongs to a gap that just changed size. So one wire may
    carry some bends and not others. The set is read at **pointerdown and frozen** (as
    the part drag freezes its riders), reaches `WireLayer.render`'s second argument
    beside the board `overrides`, and is re-derived identically inside `moveBoardsBy` in
    the SAME mutation as the boards — hence ONE undo step. `moveBoard`, the absolute
    form, deliberately carries nothing: no user gesture is behind it.
  - Switching back to Direct DELETES the points (a curve has nowhere to keep a bend, and
    keeping them leaves invisible state waiting to reappear). A BUS MEMBER is never
    routed however it is set — its middle belongs to the ribbon. Settings ▸ Appearance ▸
    **Wire layout** (`defaultWireLayout`) seeds a NEW wire only, read at placement time;
    the AI builder ignores it and emits direct wires only.
- **Bus placement rings the WHOLE run, at BOTH ends** (`bus-tools.js` +
  `components/hole-rings.js` + `bus-layout.js`'s `busRunHoles`). A bus lands `width`
  leads in one click, so the single shared `.hole-ring` cannot state its case.
  `HoleRings` is that ring MANY at once — same element and class, pooled, in the
  pointer-inert overlay. Both phases ring every hole the click would claim: hover colour
  when it can have them all, `--illegal` when it can't.
  - **`busRunHoles` is BEST-EFFORT where `busRunAddresses` is all-or-nothing**: a run
    walking off the end of a strip reports the holes that DO exist, because five red
    rings where eight were asked for IS the explanation. `busRunAddresses` is derived
    from it (both ends, `fits` on each), so there is one walk.
  - **Anchoring is a placement, so it is checked like one**: the start run is checked
    whole (on the strip, every hole free) and refused where it is made. Testing only the
    hole under the cursor let a start be anchored where the bus could never fit, which
    made every LANDING look like the fault.
- **`normalizeDocument` enforces the PLACEMENT rules, not just the schema.** A document
  arrives from a file, so it can say things the app would have refused, and the loader's
  job is to land a desk you can work on. It drops a part whose footprint does not fit its
  anchor, a wire whose endpoint is not a real free point, a bus member that is not a
  wire, and:
  - **a board that overlaps one already loaded** (first wins; the strip's seated parts
    and wires cascade away through `boardIds`/`validEndpoint`). Not cosmetic: `canPlace`
    refuses an overlap at placement and `canMoveBoardsBy` at drop, so an overlapping PAIR
    **deadlocks** — neither strip can ever be moved again. The test is the same strict
    `rectsOverlap`, so flush strips still MATE. A **brick** is deliberately NOT held to
    this: `canPlaceBrick` refuses one over a board, but an overlapping brick is only a
    nuisance (it can always be dragged off one), not a deadlock, so dropping it on load
    would be a silent deletion to fix an inconvenience.
  - **one hole, one lead**, the half the seating check cannot see: that one proves each
    pin's hole EXISTS, so two parts seated in the SAME columns loaded clean and
    `buildOccupancy` (last-writer-wins) masked the loser's pins entirely — the hover
    readout, the probe and the build guide named one chip where two sat, while the
    netlist joined both. The claim is read through `partPinAddresses`, so a rotated
    part's BENT lead counts too (a lead resolving to nothing claims nothing — floating
    stays legal). First wins, and nothing cascades: dropping the loser FREES holes, so
    every wire that was legal stays legal.

## Coding conventions

- **No framework** — plain DOM APIs and CSS. Do not introduce React, Vue, or an event-bus
  library.
- **No god files** — keep each module focused on a single responsibility; split along seams
  rather than letting one file own everything.
- Components are class-based ES modules; follow the pattern in existing files.
- **CSS** uses the custom properties in `src/web/styles/theme.css` — use them, don't
  hardcode colours or sizes.
- **CSS class naming**: `prefix-name` for elements (flat, hyphen-delimited, e.g.
  `desk-viewport`, `app-header-icon`); `block--modifier` for state/variant (e.g.
  `board-hole--occupied`). Never bare state classes (`.active`, `.selected`). The `--`
  double hyphen is reserved for modifiers and for `--color-*`/`--space-*` tokens.
- **Pure-logic/DOM split**: all geometry, addressing, occupancy, netlist and simulation
  logic lives in DOM-free modules with sibling tests; view components stay thin. (This is
  the Port Hippo `card-canvas.js`/`grid-layout.js` discipline.)
- **Events vs callbacks**: a parent-owned widget reporting to the one parent that created it
  → **constructor callback**; an app-wide state change any number of panels may react to → a
  global **`chiphippo:*` CustomEvent**. No event-bus library.
- **Pointer-capture drag discipline** — drags use pointer events + `setPointerCapture` with
  a ~4 px threshold separating click from drag, **never native HTML5 DnD** (per
  `porthippo/src/web/scripts/components/card-canvas.js`). The capture is for the MOVE stream
  only, never the sole delivery route for the RELEASE. **Every direct-manipulation desk
  drag** goes through **`components/pointer-gesture.js`** (`beginPointerGesture` → one
  teardown): the wire/bus/palette gestures and the NINE DeskController owns (board, part,
  brick, **cluster**, resistor body, resistor end, annotation, **signal flag**, marquee).
  - `pointerup`/`pointercancel` listen on `window` in the CAPTURE phase, so a release
    reaches the gesture whether or not the capture held; `lostpointercapture` + window
    `blur` end it too (the only signals for "this pointer isn't yours" with no up/cancel
    behind them). `.desk-viewport` sets `touch-action: none` so the browser can't claim a
    gesture mid-drag and cancel it.
  - **A drop is resolved from the RELEASE event's own position** (`releaseWorld`), never
    from the last `pointermove` — coalesced moves lag the cursor, and a stale sample
    silently lost the drop. The single-point drags (wire end, lead, flag, tag) add the
    converse: a release that would land NOWHERE falls back to the target the last move
    showed with its ring, so a stray up event can't throw a visible drop away either.
  - **The re-resolve is one function per drag, shared by the move and the release**
    (`#resolveBoardDrag` / `#resolvePartSeat` / `#resolveBrickPos` /
    `#resolveAnnotationPos` / `#marqueeRect`, and the two resistor trackers, which take the
    drag as a defaulted argument because the up-handler clears `#mode` before re-resolving)
    — so preview and drop can never disagree. The part drag is why this matters most: its
    move handler leaves `d.legal` false for an off-board sample while KEEPING `d.seat`, so a
    fast release silently reverted a legal reseat.
  - Because the listeners outlive the dragged element, **`#rebuildScene` cancels any live
    gesture first** — undo/redo or a tab switch mid-drag would leave a release to commit
    against unmounted views. `tests/desk-drag-release.test.js` holds all eight to the three
    cases the old shape could not survive (release point ≠ last move, release off the
    dragged element, yanked capture).
  - **"Is a drag in flight?" is DERIVED from the kind's name, never a hand-kept list.**
    `#dragGestureActive` WAS a list and fell silently behind: the wire and bus tools mint
    their own kinds in their own modules, so when routed wires added `drag-wire-point` a
    bend drag was invisible to the controller — Escape stopped cancelling one,
    `#rebuildScene` stopped killing one (an undo or tab switch mid-bend left the gesture
    alive, window listeners and all, to commit into the document that replaced it), and the
    mid-drag shortcut guard stopped applying. Every drag anywhere names itself `drag…`; the
    marquee is the one that does not.
  - **A drag that spans Run REVERTS, whoever owns it.** Space and ⌘R reach the transport
    mid-gesture (`app.js` only declines them for an armed TOOL, and a drag is not one), so a
    gesture begun while editing was allowed can be released into a RUNNING circuit. The
    controller's seven fold `#editingLocked` into their `cancelled` test; the wire/bus drags
    did not, and quietly committed a topology edit with the simulation live (`disarm()`
    cannot catch it — `armed` is false once a drag owns `#mode`).
    `tests/wire-drag-abort.test.js` and `bus-drag.test.js` hold both rules.

## Tech stack

- **Renderer**: vanilla JS (ES2022 modules), plain CSS with custom-property design tokens.
- **Main**: Node.js, Electron 42+ (CommonJS).
- **Build**: Makefile + npm + electron-builder (no bundler for app code).
- **Lint/format**: ESLint 9 (flat config, `src/eslint.config.js`) + Prettier (defaults).
- **Testing**: Node's built-in runner (`node --test`); jsdom for renderer-component tests.

## Common commands

```bash
make install    # npm ci into src/node_modules
make debug      # Run Electron with hot-reload (primary dev workflow)
make fmt        # Prettier write   /  make fmt-check to check only
make lint       # ESLint
make test       # License-header guard + node --test
make test-i18n  # Just the language guards
make icons      # Regenerate app-icon rasters from the SVG sources
make datasheets # Report which pinout datasheet crops are missing/orphaned
make datasheet-urls # Check every datasheet download URL still serves a PDF (network)
make demos      # Regenerate + engine-validate demos/ AND src/web/demos/
make bench      # Time the engine headless on the busy fixture (not part of make test)
make spice-golden # Regenerate Spice Lite's ngspice references (needs ngspice; not in make test)
make profile    # DevTools trace + CPU profile of the app running the busy fixture
make docs       # Build the website docs;  make pdf  builds the user-guide PDF
make build      # macOS app (dir only, unsigned);  make dmg  (bare `make` default)
make mas        # Signed MAS .pkg;  make mas-dev  for a local sandboxed build
make clean      # Remove build/ and dist/
```

## Git workflow

- **Claude must not create commits.** Do not run `git commit` or `git push` — the user
  handles all committing and pushing themselves, even when a task is finished and verified.
  You may stage changes or draft a commit message when asked, but leave the actual commit
  to the user.
- **Never create a branch unless explicitly told to.** This is a solo project; work happens
  directly on the current branch (normally `main`). Do not auto-branch, even for large
  changes.
- When you draft a commit message, end it with the required `Co-Authored-By` trailer.

## License headers

The project is **GPL-3.0-or-later** (`LICENSE` + `NOTICE` at the root;
`"license": "GPL-3.0-or-later"` in `src/package.json`). It was Apache-2.0 up to and
including v1.1.1, and those releases stay Apache-2.0. Every first-party source file must
begin with the FSF's standard GPL notice — a hard requirement enforced by a guard.

**What the app GENERATES for a board is not GPL** (`LICENSE-EXCEPTION`, a section 7
additional permission): `ChipHippo.h`, `ChipHippoExample.ino`, `chiphippo.py`, `main.py`,
`code.py`, `boot.py` and `docs/examples/` may go into anyone's firmware under any terms —
otherwise shipping a sketch that includes the header would oblige its author to GPL their
firmware. The permission stops short of a program that uses that code as the TEMPLATE for
code IT generates (Bison's limit), so it cannot be used to lift the device side into a
closed competitor. Each generated file states it in its own comment
(`GENERATED_LICENSE` in `integration-codegen.js`, held by
`integration-codegen-python.test.js`), because a header copied into a sketch folder
travels without the repo's files beside it; the two generator modules' own headers say
so too.

- **Scope**: first-party `*.js` under `src/app/` and `src/web/scripts/`, `*.css` under
  `src/web/styles/`, and the build scripts under `scripts/`.
- **Exempt**: `src/node_modules/`, `src/web/scripts/vendor/` (a generated artifact), and
  non-comment file types (`*.json`, `*.md`, `*.html`).
- **Enforcement**: `scripts/license-header.mjs --check` runs as `make test-license-headers`,
  part of `make test` (so CI fails on a missing header).
- **Auto-fix**: `make license-headers` stamps every in-scope file missing one; it preserves
  shebangs and is idempotent. A file still opening with the old Apache terms (one from an
  older branch) counts as missing: the stamper swaps the terms in place, keeping that
  file's own copyright line, rather than stacking a second header above it.
