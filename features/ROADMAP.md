# Chip Hippo — Implementation Roadmap

**Chip Hippo** is a cross-platform desktop app for designing and simulating **74xx TTL
logic circuits on virtual breadboards**. The main window is an **infinitely pannable,
zoomable desk**. The user places solderless breadboards on the desk — Full-size
(830 tie points), Half-size (400), Tiny (170) — then populates them with 74xx-family
DIP chips, wires, switches, LEDs, and power sources (3 V / 5 V / 12 V). Every tie
point, rail hole, and component terminal is **individually addressable**, so chip pins
and wire ends bind to real holes. A **simulation engine** emulates each chip's logic:
it traces electricity from the power sources, resolves every electrical net, computes
chip outputs from pin inputs, and ripples changes through the circuit until it
settles — LEDs light, switches interact live.

It is built as a **native JS / Node.js / Electron** app (no UI framework), with the
same engineering setup as its siblings **Rest Hippo**
(`/Users/jason/src/js/projects/resthippo`) and **Port Hippo**
(`/Users/jason/src/js/projects/porthippo`): a `Makefile`-driven build, `src/app`
(Electron main) + `src/web` (renderer) split, file-based storage under `userData`,
electron-builder packaging, and Apache-2.0 with a license-header guard. External npm
packages only when necessary — at the start the only planned runtime dependency is
`electron-updater` (later, for auto-update); the breadboards, wires, and the entire
simulation engine are first-party code.

## How to use these plans
Each numbered file is one **stage**, written to be implemented **in order, one at a
time**. Every plan follows the sibling projects' feature-doc shape — Context, Goal,
settled Design decisions, numbered Implementation steps, Acceptance criteria,
Constraints, and a Verify recipe. When a stage is finished, move its file into
`features/done/`. Later stages assume the earlier ones have landed; each names its
prerequisites in **Context**. The near-term emphasis is **UI first**: stages 10–70
build the whole desk/board/wiring experience; the engine arrives rudimentary in 90
and grows in 100.

## Stages

| #   | Plan | What it delivers | Depends on |
|-----|------|------------------|------------|
| 00  | [Project scaffold & build system](00-project-scaffold.md) | Repo layout, Makefile, `src/app`+`src/web` Electron shell, empty desk shell, `window.chiphippo` IPC bridge, lint/format/test/build/`make debug`, Apache-2.0 + license-header guard | — |
| 10  | [Infinite desk workspace](10-infinite-desk.md) | Pannable/zoomable infinite desk (camera transform, not scrollbars), dot grid, zoom controls, pure world↔screen geometry module, settings store + persisted viewport | 00 |
| 20  | [Breadboard model & tie-point addressing](20-breadboard-model.md) | Pure breadboard geometry/addressing/connectivity model for all three sizes (830/400/170), the desk-document store with autosave IPC, migrations stub, ipc-parity test | 00 |
| 30  | [Breadboard rendering & placement](30-breadboard-rendering.md) | Boards drawn (SVG per board, math hit-testing — no per-hole DOM) on the desk; add/drag/select/delete boards; hover any hole to see its address | 10, 20 |
| 40  | [Component framework & DIP chip placement](40-chip-placement.md) | Component/occupancy model, data-driven 74xx catalog (metadata + pinouts), searchable chip palette, DIP footprints straddling the trench, ghost preview, legal placement, pin tooltips | 30 |
| 50  | [Wires](50-wires.md) | Hole-to-hole wires (incl. cross-board), click-click wiring with rubber-band preview, colored sagging bezier rendering on an SVG overlay, select/delete | 40 |
| 60  | [Switches, LEDs & power sources](60-discrete-components.md) | Discrete parts in the same framework: slide switch, push button, LEDs (4 colors, polarized), and desk-level PSU bricks (3 V / 5 V / 12 V) with addressable terminals | 50 |
| 70  | [Netlist & connectivity inspector](70-netlist-and-inspector.md) | Pure union-find netlist over strips/rails/wires/switch-state; hover-to-highlight an entire electrical net across boards; net summary readout | 60 |
| 80  | [74xx behavioral library v1](80-ttl-chip-library.md) | Signal levels (H/L/Z/X), generic gate evaluator, behavioral defs + truth-table tests for the combinational gate wave (7400/02/04/08/10/11/20/27/30/32/86, 74125) | 40 |
| 90  | [Simulation engine v1](90-simulation-engine.md) | Rudimentary but real: power-rail seeding, chip VCC/GND power checks, iterative settle loop with warm start (SR latches work), conflict & oscillation detection, live switches, glowing LEDs, Run/Stop | 70, 80 |
| 100 | [Sequential logic & clocking](100-sequential-and-clocking.md) | Stateful edge-triggered chips (7473/74/75/76, 74107), MSI wave (74138/139/151/157/161/164/165/175/193), clock-source component, run/pause/single-step + speed control | 90 |
| 110 | [Breadboards as strips & snap groups](done/110-board-strips-and-grouping.md) | Breadboards decomposed into pin-board + rail strips, kits, snap groups, magnetic mating, group drag/break, board outline highlighter | 30 |

## North-star goals (what the next wave drives toward)

Two outcomes shape stages 120–210, beyond "more parts":

1. **Buildable schematics.** A Chip Hippo design should yield artifacts an engineer can
   *follow to build the real circuit on a real breadboard* — named nets, a legible
   logical schematic, a step-by-step build guide + wiring list + BOM, and printable/
   shareable exports. Stages **120, 130, 140, 150, 160** (and **210**'s timing charts).
2. **File-backed memory.** Memory chips (ROM / RAM / EEPROM) that **supply data to** and
   **record information from** the circuit, backed by **actual files** as byte storage,
   with an in-app hex editor to program and observe them. Stages **170, 180, 190**.

## Stages (next wave)

| #   | Plan | What it delivers | Depends on |
|-----|------|------------------|------------|
| 120 | [Net names, labels & annotations](done/120-net-names-and-labels.md) | User-named nets bound by address (survive edits), freeform labels/notes on the desk, reserved-name quick-picks; pure metadata, engine-inert | 70 |
| 130 | [Buses: bundled multi-bit signals](130-buses.md) | Named ordered nets (`D[7:0]`), a bus tool that lays/taps whole runs at once, bundle rendering; still N plain wires underneath | 50, 120 |
| 140 | [Build guide, wiring list & BOM](140-build-guide-and-wiring-list.md) | A pure `build-plan.js` deriving a BOM, net-grouped human-addressed wiring list, and ordered assembly steps + warnings | 70, 120, 130 |
| 150 | [Schematic view](150-schematic-view.md) | A derived logical diagram — chip symbols + routed named nets + bus lines, deterministic auto-layout with nudge, live sim tint, shared probe | 70, 120, 130 |
| 160 | [Export to SVG / PNG / PDF](160-export-image-and-pdf.md) | Standalone vector/raster export of desk + schematic and a full build-package PDF (schematic + board + guide); fonts embedded, main-side write | 140, 150 |
| 170 | [Memory chips & wide DIPs](170-memory-chips-and-wide-dips.md) | DIP-24/28 footprints, a `memUnit` vocabulary, ROM/SRAM/EEPROM catalog defs; async read + reported writes over a run-volatile image, engine stays pure | 40, 80/100, 130 |
| 180 | [File-backed byte storage](180-file-backed-memory.md) | Memory bound to a real `.bin` via `mem:*` IPC; controller loads on Run, flushes writes atomically, binding persists in the doc | 170 |
| 190 | [Memory inspector / hex editor](190-memory-inspector.md) | Per-chip floating hex/ASCII window; edit-when-stopped, live-when-running, Intel HEX + `.bin` import/export, fill/goto, binding management | 170, 180 |
| 200 | [Undo / redo & command history](done/200-undo-redo.md) | Snapshot-based bounded history over every doc mutation via one commit seam, gesture coalescing, ⌘Z/⇧⌘Z; run-volatile state excluded | 20–110 |
| 210 | [Logic analyzer & timing view](210-logic-analyzer.md) | A passive recorder over `chiphippo:sim-state`: net/bus channels, scrolling waveforms + hex bus lanes, cursors/Δ readout, exportable timing charts | 90/100, 120, 130, 170 |

## Backlog (unwritten — author a plan file when promoted)

Ideas queued behind the stages above, roughly in priority order. None has a plan file
yet; write one in the house format when it's next up. (Landed since first draft: project
files & save/load, copy/paste/duplicate, 7-segment displays, and the 74LS glue wave —
buffers/latches/transceivers/decoders/comparators/adders.)

| Idea | What it would deliver |
|------|----------------------|
| Two-board memory straddle | 600-mil DIP placement across two stacked pin-boards (the real wide-part footprint), beyond Feature 170's single-board modelling |
| Extended 74xx coverage | Open-collector variants (7401/03/05…), arithmetic (74181/283 family), further waves until the family is broadly covered |
| More discrete parts | DIP-switch banks, real resistors/pull-ups (drop the idealized-LED rule), buzzer, potentiometer |
| Interactive build mode | Tick off Feature 140's build-guide steps live, highlighting the target holes on the desk as you go |
| Assembler / HEX toolchain hooks | Import listing files that map addresses to source lines in the memory inspector |
| CI/CD, packaging & website | Signed/notarized multi-platform builds, GitHub Actions, auto-update, download site (port Port Hippo's Feature 70) |
| Docs & user guide | In-app + hosted user guide from one Markdown source (port Port Hippo's Feature 80) |
| i18n | Locale catalogs + `t()` seam (mirror the siblings) |

## Cross-cutting conventions (apply in every stage)
- **No UI framework.** Plain DOM + class-based ES modules; CSS via design tokens in
  `src/web/styles/theme.css`. Class naming: `prefix-name` elements,
  `block--modifier` state — never bare `.selected`.
- **Process split.** Filesystem and any native I/O live in the **main** process
  (`src/app`); the sandboxed renderer talks only over the `window.chiphippo.*` IPC
  bridge; keep `main.js` handlers and `preload.js` exports in lockstep (guarded by an
  ipc-parity test from Feature 20 on). The **simulation engine is pure computation,
  not I/O** — it lives in the renderer as DOM-free ES modules under
  `src/web/scripts/sim/`, fully testable with `node --test`.
- **Pure-logic/DOM split.** All geometry, addressing, occupancy, netlist, and
  simulation logic lives in DOM-free modules with sibling tests; view components stay
  thin. This is the Port Hippo `card-canvas.js`/`grid-layout.js` discipline.
- **Pointer-capture drag discipline.** Drags use pointer events + `setPointerCapture`
  with a ~4 px threshold separating click from drag (never native HTML5 DnD), per
  `porthippo/src/web/scripts/components/card-canvas.js`.
- **Everything is addressable.** Every hole, rail position, and component terminal has
  a stable string address (`bb1.f12`, `bb1.t+7`, `psu1.+`); model documents reference
  addresses, never pixels.
- **Events vs callbacks.** Parent-owned widget reporting to its creator → constructor
  callback; app-wide state change any number of panels may react to → a global
  `chiphippo:*` `CustomEvent`. No event-bus library.
- **License headers.** Apache-2.0; every first-party `src/app`/`src/web` JS+CSS and
  build script carries the standard header, enforced by a guard in `make test`.
- **Green gate.** `make fmt && make lint && make test` must pass before a stage is
  done; each plan's Verify section also drives the real app via `make debug`.

## Naming & identity (use consistently across all stages)
- Product name **Chip Hippo**; npm package `chiphippo`; Electron `appId`
  `com.chiphippo.app`; repo `github.com/jfigge/chiphippo`.
- IPC bridge object **`window.chiphippo`**; global renderer events prefixed
  **`chiphippo:`**.
- App icon source `src/web/chiphippo-icon.svg`; download site domain
  **chiphippo.com** (via `website/CNAME`) when a site lands, falling back to the
  `*.github.io` Pages URL until the domain is configured.

## Domain reference (shared vocabulary — used by every stage)
- **World unit = one breadboard pitch = 0.1 in (2.54 mm).** All board geometry,
  footprints, snapping, and desk coordinates are integer-friendly in pitch units.
- **Board types** (tie-point counts match the real parts):
  - **Full** — 830 points: 63 columns × 10 rows (630) + 4 power rails × 50 (200).
    ~165 × 55 mm.
  - **Half** — 400 points: 30 columns × 10 rows (300) + 4 power rails × 25 (100).
    ~82 × 55 mm.
  - **Tiny** — 170 points: 17 columns × 10 rows (170), **no rails**. ~45 × 34.5 mm.
- **Rows**, top to bottom: rails `t+`,`t−` · rows `j i h g f` · **trench** ·
  rows `e d c b a` · rails `b+`,`b−`. Each column-half (`a–e`, `f–j`) is one
  internal 5-hole node; each rail is one continuous node; the trench isolates the
  halves — DIP chips straddle it (pins in rows `e` and `f`).
- **Addresses**: `<ownerId>.<point>` — `bb1.a12` (hole), `bb1.t+7` (rail hole 7),
  `psu1.+` (component terminal). One hole holds at most one lead (pin or wire end).
