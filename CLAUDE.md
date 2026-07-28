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
the desk-document save IPC (since re-cut as `project:save`, which writes every
desktop at once — see below), ipc-parity guard; breadboard rendering & placement
(30) — one static SVG per board (no per-hole DOM), `DeskController` (layers,
add-flow ghost, select/drag/delete, hover addressing), ported popup manager; and
the component framework & DIP chips (40) — `footprints.js` (DIP-14/16/20
derivation), `occupancy.js` (the single collision authority), the data-driven
12-chip 74xx catalog (`catalog/`), desk-doc component ops with `c<n>` ids, the
searchable palette panel, and `chip-view.js` (drawn DIPs with pin hover); and
wires (50) — `{id, from, to, color}` with `w<n>` ids and address endpoints in
the shared occupancy index, the pure `desk/wire-path.js` sag math, `WireLayer`
(one SVG, outline+core+caps, the sanctioned per-wire hit-stroke exception),
the click-click wire tool (shortcut W, chaining, colors picked with 1–8 while
armed and shown as a dot on the toolbar's Wire button), cross-board wires
riding board drags, and cascade-on-board-delete;
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
engine stays pure and timerless; the derived logical **schematic view**
(150 — landed out of tree order; its plan file still needs moving to
`features/done/`) that flips in via `Tab` alongside the breadboard, drawing
chip symbols + routed named nets + bus lines from the same `DeskDoc`
(`components/schematic-view.js` + `model/schematic-layout.js` +
`catalog/symbols.js`), sharing the desk's camera/probe/live sim tint and
persisting only a per-symbol `schematicPos` layout nudge — never a second
source of truth; and (skipping the still-deferred 160/170 wave in the tree)
**file-backed memory + inspector** (180/190). Volatility decides
everything: a **volatile SRAM** (`ram-8k`/`HM62256`/`AS6C1024`, flagged
`volatile` in the catalog) is never file-backed — run-volatile only; a
**non-volatile ROM/EPROM/EEPROM** is backed by a real `.bin` in the app working
folder, named by a per-chip GUID minted on placement (`params.storage.guid`).
EEPROM/EPROM are treated as ROMs (the app can't drive their write cycle), so the
CIRCUIT never writes any file-backed chip — a ROM is programmed only by the
in-app **external programmer** (a menu action: pick a `.bin`/`.hex`, copy it to
the file's start with a size warning). The main-side byte store
`app/store/mem-store.js` (`create` noise-filled / `load` / `program` / `writeAll`
/ `remove`, atomic over `io.js`) sits behind the GUID-keyed, parity-guarded
`mem:*` IPC (main alone maps a GUID → path). The SimController loads each ROM's
file on Run (async gate before the first tick), drops any reported write (ROMs
are read-only), and warns when a chip flagged `programmed` finds its file missing
(the delete-then-undo data-loss case). The **inspector** is a floating
per-component hex/ASCII window (`web/memory.html` → `scripts/memory.js`) on the
virtualized `components/memory-inspector.js` grid (offset · hex · ASCII, a reused
row pool so a 32 KiB image is ~30 rows in the DOM), pure `model/hex-format.js`
(Intel HEX ⇄ bytes) for Import/Export, editable-when-stopped (ROM only) /
read-only-live-when-running, showing the ROM's backing-file path; the
renderer-side `components/memory-bridge.js` coordinator runs the programmer +
Save through the DeskController (so the `programmed` flag rides undo/redo) and
relays context + live byte writes across the main↔inspector window boundary;
and the **user guide** (230) — one Markdown source (`src/web/docs/*.md`)
driving the in-app Help ▸ *Chip Hippo User Guide* window, the hosted website
(`make docs`), and a PDF (`make pdf`); see the "User guide & docs" section
below; and **projects & tabbed desktops** (240) — a project of several PEER
desktops as tabs (`Desktop N`; no privileged main desk), the document swapped
in place per tab, plus the whole-design clip that carries a sub-assembly from
one desktop onto another; and **the project is the document** (250) — ONE
`.chiphippo` file holding every desktop AND every programmed ROM's bytes, so
there is one dirty marker, one Save, one File menu, and nothing is written
until you save. A desktop stopped being a file: Save As / Open on one became
**Export / Import** snapshots, and the two-file-lifetime machinery (app-kept
flags, orphan collection, eager write-through, `desk.json`, the
recent-DESKTOPS list) is gone (see the "Projects & tabbed desktops" section
below); and the **AI circuit builder** (260, all but its last step — describe a
circuit and get a wired, SIMULATION-PROVEN design, on the user's own
`safeStorage`-held API key. The model emits a coordinate-free **netlist** it
cannot get geometry wrong in; a pure compiler places, routes, and proves it
through the real engine, and only then arms it as a placement ghost. See the
"AI circuit builder" architecture note below; step 15, refactoring `make demos`
onto `model/autobuild.js`, is still open).
When a stage is finished, move its plan file into `features/done/`.

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

## Datasheet crops

The pin-assignments window shows each **chip's** manufacturer datasheet region
(connection diagram + function/truth table, or the internal logic diagram for
parts with no table) as a committed PNG under **`src/web/datasheets/<id>.png`**
— regenerate them with **`make datasheets`**. Like `make icons`, the script
(`scripts/make-datasheets.mjs`) runs **under Electron** (`npx electron …`): it
renders the source PDF page at 216 DPI with **`pdfjs-dist`** (a build-only dev
dependency) inside a hidden Chromium window, then crops to the per-chip
rectangle. Electron is required because the diagrams are **JBIG2-encoded
bitmaps** — pdfjs decodes those through a WASM module and a same-origin worker,
so the harness loads a real `file://` page and wires up pdfjs' `wasmUrl` /
`standardFontDataUrl` / `cMapUrl`. The crop manifest is data, not code:
**`scripts/datasheet-crops.mjs`** maps each catalog id → `{ file, page, crop }`
where `crop` is `{x,y,w,h}` as FRACTIONS of the rendered page (hand-tuned per
datasheet — Fairchild/TI/Motorola layouts all differ; some diagrams live on
page 2 or behind a Jameco cover). The **source PDFs are NOT in the repo** (they
live in the user's datasheet folder — override with `DATASHEETS_DIR`); only the
46 cropped PNGs are committed. The four catalog chips with no matching `74LS*`
datasheet (74164, 74193, 7427, 7476) have no crop — the window shows only their
pin map (see the Pin-assignments window architecture note).

## User guide & docs

**One Markdown source drives three outputs that can never diverge**:
**`src/web/docs/*.md`** (+ `images/*.png`, committed screenshots) feeds the
**in-app viewer** (Help ▸ *Chip Hippo User Guide*, `⌘/`), the **hosted
website** (`make docs` → `website/docs/`), and a **PDF** (`make pdf` →
`docs/chip-hippo-user-guide.pdf`). The page index (`PAGES` — slug, optional
`file` override, title) is **hand-duplicated, not shared**, between
`src/web/scripts/components/docs-viewer.js` (browser) and
`scripts/build-docs.mjs` (Node) — keep the two in sync when adding a page.
- **In-app**: `web/docs.html` + `scripts/docs-window.js` mount
  `components/docs-viewer.js` (`DocsViewer`) into a **non-modal** floating OS
  window (`openDocsWindow()` in `main.js`, a true singleton — unlike
  pinout/memory windows it carries no document state, so it's NOT closed by
  `closeAuxWindows()` on New/Open, only when the app itself quits). It fetches
  a page's raw Markdown over **`window.chiphippo.docs.read(slug)`** — never
  `fetch()`, so it works under `file://` in both `make debug` and a packaged
  build — through the SAME shared `preload.js` bridge every other window uses
  (Chip Hippo has one bridge, not Rest Hippo's per-window narrow preload). The
  `docs:read` handler slug-validates (`^[a-zA-Z0-9-]+$`) AND path-contains the
  resolved file inside `src/web/docs/`, defense in depth against a crafted
  slug. Rendering goes through **`web/scripts/vendor/markdown.js`** — `marked`
  + DOMPurify bundled by **esbuild** from `vendor/markdown-entry.js`
  (`make vendor-markdown` / `npm run vendor-markdown`; the whole `vendor/`
  directory is exempt from both the license-header guard and ESLint, since
  it's a generated artifact) — every link is forced `target="_blank"` so
  clicking one asks main's `setWindowOpenHandler` to open the system browser
  instead of navigating the guide. `DocsViewer` rewrites `images/x.png` →
  `docs/images/x.png` (resolving relative to `docs.html`) and stamps
  GitHub-style heading ids (`marked` no longer emits them) so in-page
  `#anchor` links and cross-page `*.md` links resolve without leaving the
  window; a monotonic load-token guards a rapid nav click from a slower
  in-flight page load clobbering a newer one.
- **Website**: `scripts/build-docs.mjs` renders the same Markdown through
  `marked` directly under Node (no DOMPurify — first-party, trusted content)
  into Chip Hippo–themed static HTML (`STYLE`/`LOGO_SVG` in the file, the
  green `--accent:#3fb950` tokens, matching `website/index.html`) under
  `website/docs/`, copies `images/`, and writes `website/sitemap.xml`. It
  resolves `marked` **by file path** (`src/node_modules/marked/...`, or
  `MARKED_DIR` override) since `marked` is ESM-only and bare specifiers don't
  honor `NODE_PATH` — matters if CI builds the site without `src/`'s
  devDependencies installed. `website/index.html` carries a **Guide** nav
  link + footer link.
- **PDF**: `scripts/build-pdf.mjs` **imports `PAGES`/`SRC`/`renderBody`/
  `LOGO_SVG` from `build-docs.mjs`** (real code reuse, not a hand-synced copy)
  so it can't drift from the website; it stitches a cover page + table of
  contents + one section per page into a single print-styled (light-theme)
  HTML document, absolutizes `images/` to `file://` URLs, and prints it via a
  hidden **Electron** window's `printToPDF` — so it runs `cd src && npx
  electron ../scripts/build-pdf.mjs` (`make pdf`), never plain Node. It awaits
  `document.fonts.ready` + every `<img>`'s load/error before printing
  (`loadFile` resolves before images necessarily have). `PDF_OUT` overrides
  the output path (default `docs/chip-hippo-user-guide.pdf`, committed).
- **Screenshots**: the committed PNGs under `src/web/docs/images/` are
  captured by driving a real, separately-launched `make debug`-equivalent
  Electron process over the Chrome DevTools Protocol (`--remote-debugging-port`,
  a raw `ws` WebSocket, `Page.captureScreenshot`) — the same technique as an
  ad hoc verification launch, not an in-process hidden `BrowserWindow`
  harness. This capture tooling is **local developer tooling, not committed**
  (mirrors Rest Hippo's own `.docs-build/`, which is gitignored there too) —
  only the resulting PNGs are checked in.

## Source Directories

- `src/app/` — Electron **main** process (Node.js, CommonJS): window lifecycle and
  IPC handlers. All native I/O (filesystem, dialogs) lives here. Key entry points:
  `main.js` (window + lifecycle + ipcMain handlers), `preload.js` (the
  `window.chiphippo` bridge), `window-state.js` (bounds restore with display-fit
  check), and `store/` (`io.js` atomic-write primitives, `settings-store.js`,
  `project-store.js` + `project-images.js` + `project-migrate.js` (below),
  `desk-store.js` + `migrations.js` — the desk-document schema migrations, plus
  the by-PATH reader `project-migrate.js` uses to inline a v3 desktop file —
  `mem-store.js`, the atomic byte store behind a memory chip's `.bin`
  sidecar, Feature 180, and `credential-store.js`, the `safeStorage`-encrypted
  API-key sidecar, Feature 260), plus `ai/` (`providers.js` + `client.js`) —
  the app's ONLY outbound network call, in main because the renderer's CSP
  forbids one.
  **Files**: there is exactly ONE — the open PROJECT (`<name>.chiphippo`),
  which holds every desktop's document and every programmed ROM's bytes (see
  "Projects & tabbed desktops" below). The whole file surface is
  `project:boot`/`:new`/`:open`/`:open-recent`/`:save`/`:choose-path`, plus
  `desktop:export`/`:import`/`:duplicate` for the snapshot fragments. Nothing
  reloads the window: a document swap goes through
  `DeskController.loadDocument`'s `#rebuildScene`. Dirty = the whole live
  project vs the baseline the workspace holds (`projectSignature`); it drives
  the ONE `document.title` marker and every discard prompt (File menu
  ⌘N/⌘O/⌘S/⇧⌘S/⌘B push `menu:project-*` / `menu:build-guide` →
  `chiphippo:project-*` / `chiphippo:build-guide`, and the Desktop menu pushes
  `menu:desktop-*`, which `app.js` forwards straight to the workspace).
  **The header toolbar mirrors the File menu exactly** — one File **pill** whose
  four icon-only segments (New · Open · Save · Save As) dispatch the SAME
  `chiphippo:project-*` events, so the two can never drift; only **Bill Of
  Materials** sits elsewhere (it toggles a desk panel, so it is a desk-tool
  segment — see the toolbar note below). `settings.recentProjects` is the last
  10 PROJECT paths, most recent first — `store/recent-files.js` is still the
  pure list arithmetic, `project:recent:list`/`:remove` + `project:open-recent`
  the IPC. That list is also the **allowlist** for the one read of a
  renderer-named path no dialog mediated, returning `{ok:false,
  code:"missing"}` for an entry whose file has since gone so the renderer can
  offer to forget it. Every OTHER path crossing the bridge is gated by main's
  `knownPath`: anything inside the app's saves folder, plus what a dialog (or
  an opened project file) ESTABLISHED this session.
- `src/web/` — **renderer** (Vanilla JS ES modules + plain CSS): the UI. Sandboxed;
  talks to main only through `window.chiphippo.*`. Entry points: `index.html` →
  `scripts/app.js`. Pure DOM-free logic lives under `scripts/desk/` (camera, wire
  path, and `rect-outline.js` union-boundary math), `scripts/model/` (breadboard
  specs/addressing/connectivity, `DeskDoc`, `footprints.js`, `occupancy.js`,
  `mating.js`, and `seating.js` — the world-point → `{board, anchor}` placement
  search), and `scripts/sim/` (the engine package:
  `union-find.js`, `netlist.js`, `levels.js`, `chip-eval.js`, `sequential.js`,
  `resolve.js`, `engine.js`) and `scripts/ai/` (the renderer half of the AI
  builder: `catalog-brief.js` derives the system prompt from the catalog,
  `generate.js` is the reply → compile → verify → clip pipeline — both pure);
  part metadata
  under `scripts/catalog/` (pure data + integrity test — never part-specific code
  paths); thin view components under `scripts/components/`. `DeskController`
  keeps the whole public surface but delegates cohesive slices to collaborators
  it owns: `sim-overlay.js` (the live LED/badge/clock face + net-level lookups,
  driven from `chiphippo:sim-state`), `probe-inspector.js` (the connectivity
  probe — owns its netlist cache, net-highlight overlay, and status readout),
  and `wire-tools.js` (the click-click wire tool + the endpoint/whole-wire
  drags + the per-wire context menu; it shares the controller's `#mode` through
  a host object so the viewport dispatcher's mode checks are unchanged — its
  drags and `bus-tools.js`' run on the shared `components/pointer-gesture.js`
  plumbing, see the pointer-capture discipline note below). All the
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
  ├── Stores         (src/app/store/)        settings.json + ONE project file
  │                                          (atomic io.js; every desk document
  │                                          inside it loads through migrations.js)
  ├── Window state   (src/app/window-state.js)  bounds restore + debounced save
  ├── IPC handlers   (app:*, settings:get/set, project:*, desktop:* — more per stage)
  └── IPC bridge     (src/app/preload.js)   →  window.chiphippo.*
        └── Renderer / UI (src/web/scripts/app.js)
              ├── DeskView (components/desk-view.js) ← desk/desk-geometry.js (pure)
              ├── ProjectWorkspace (components/project-workspace.js)
              │     owns the open project + which desktop is on the desk
              └── DeskController (components/desk-controller.js)
                    owns DeskDoc (model/desk-doc.js ← model/breadboard.js, pure),
                    the surface layers (boards→parts→wires→overlay), and mounts
                    BreadboardView children; `chiphippo:doc-changed` re-derives
                    the • dirty marker (a desktop is saved deliberately)
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
- **Memory: file-backing + inspector** (`app/store/mem-store.js` +
  `components/memory-inspector.js` + `components/memory-bridge.js`, Features
  180/190). **Volatility is the whole axis.** A **volatile SRAM** (catalog flag
  `volatile`, via `isVolatileMemory`) is NEVER file-backed — run-volatile only.
  A **non-volatile** chip (ROM/EPROM/EEPROM) is backed by a real `.bin` **sidecar**
  in the app working folder (`userData/memory/<guid>.bin`); the desk document
  stores only `params.storage = { guid }` (a `crypto.randomUUID()` minted on
  placement) plus a `programmed` flag — never the bytes, never a user-chosen
  path. Since Feature 250 that folder is a **cache**, not the source of truth:
  a programmed chip's bytes are collected into the PROJECT file on save and
  hydrated back on open (`app/store/project-images.js`), so a design carries
  its ROMs with it. The
  CIRCUIT can never write a file-backed chip: EEPROM/EPROM are treated as ROMs
  (the app can't drive a write cycle), so the SimController **drops** any reported
  write to a non-volatile chip; a ROM is programmed only by the in-app **external
  programmer**. **All file I/O is in main** over the GUID-keyed, parity-guarded
  `mem:*` IPC (`create`/`load`/`program`/`write`/`delete`/`path`/`pick-image`/
  `export`) — main alone maps a GUID → path (rejecting a hostile one), and
  `mem-store.js` is byte-oriented + atomic (`create` fills a fresh file with
  **random noise**, `program` copies an image to the file's start — short writes
  a prefix, long truncates, both warned). File lifecycle rides the DeskController:
  a ROM gets its noise file on placement (`#provisionMemory`) and loses it on
  removal (`#releaseMemory`); a chip flagged `programmed` whose file is later
  found missing (delete-then-undo) is recreated as noise and **warned** (the loss
  the flag exists to catch). The **inspector** is a floating OS window per
  component (like the pinout); because it is its own sandboxed renderer it reaches
  the main renderer ONLY through main's `memory:*` relay
  (`open`/`to-inspector`/`to-host`, re-dispatched by preload as
  `chiphippo:memory-inbound` / `chiphippo:memory-host-inbound`). The main-window
  `MemoryBridge` answers a window's `ready` with its chip context (kind + GUID +
  display path, or the live image bytes while running), runs the programmer +
  Save through the controller (so `programmed` rides undo/redo), and streams
  `chiphippo:mem-state` byte writes out to open windows. The grid is
  **virtualized** (a reused row pool — only ~viewport rows in the DOM), **editable
  when stopped** for a ROM (Save writes its file) and a **read-only live viewer**
  for SRAM + any running chip (it mirrors the engine-owned image, never writes
  it). Intel HEX ⇄ bytes is the pure `model/hex-format.js`.
- **Projects & tabbed desktops** (`app/store/project-store.js` +
  `app/store/project-images.js` + `app/store/project-migrate.js` +
  `model/project-doc.js` + `components/project-workspace.js` +
  `components/project-tabs.js` + `model/design-clip.js`).
  **THE PROJECT IS THE DOCUMENT.** ONE file — `<name>.chiphippo` — holds every
  desktop's desk document AND every programmed ROM's bytes, so there is one
  dirty marker, one Save, one Save As, one recent list, and one File menu.
  A desktop is STRUCTURE INSIDE that document, not a file:

  ```jsonc
  { version: 4, name, description?, activeTab, nextIndex,
    tabs:   [ { id, name, description?, doc } ],
    images: { "<rom-guid>": "<base64>" } }   // programmed ROMs only
  ```

  **A TAB IS A DOCUMENT, NOT A SECOND DESK**: there is still exactly one
  `DeskView` / `DeskController` / `SimController` / palette / guide / analyzer,
  and switching desktops SWAPS THE DOCUMENT in place through
  `DeskController.loadDocument` — the same `restore` + `#rebuildScene` path
  undo/redo has used since Feature 200 (which is why a tab switch needs no
  `window.location.reload()`: reload was the guaranteed teardown for a scene
  there was no other way to dismantle; `#rebuildScene` IS the in-process one,
  and it is now the ONLY one — nothing in the app reloads the window any more).
  The ACTIVE desktop's document lives in the shared `DeskDoc`; `#stash()` folds
  it back into the meta whenever the WHOLE project is needed (a save, a switch,
  an export, the dirty test), and every other desktop's sits in
  `meta.tabs[].doc`. `ProjectWorkspace` keeps PER TAB only the camera and its
  own `HistoryStore` — so ⌘Z after switching back undoes THAT desk's last edit.
  A camera is deliberately NOT in the file: panning must never mark a design
  dirty, and neither must moving between tabs (`projectSignature` drops
  `activeTab`). A switch stops the sim and closes the aux windows (`c3` on one
  desktop is a different chip from `c3` on another); the controller's copy
  buffers deliberately survive it, which is what makes a cross-desktop paste
  work.
  **THERE IS ALWAYS A PROJECT**, from the first launch: `project:boot` answers
  with one every time, so there is no second "working desk" mode beside it and
  `app.js` has no project/no-project branch left anywhere. An unsaved project —
  blank `name`, blank `location` — lives in the ONE fixed working slot
  `saves/default.chiphippo`, which is to a project exactly what `desk.json`
  used to be to a schematic. **STARTUP** is that fact read backwards
  (`bootProject`): the working slot if it exists, else the head of
  `settings.recentProjects` still on disk, else a brand-new project. So the
  slot's file exists exactly while the open project is unsaved — `project:save`
  to a real path drops it (`dropDefault`), and so does opening another project.
  **A NEW PROJECT IS ALWAYS EXACTLY ONE DESKTOP**, numbering started over at 1;
  a project grows through `addDesktop`, which mints the next `Desktop N`
  (`nextIndex` only counts up) with no dialog at all.
  **NOTHING IS WRITTEN UNTIL YOU SAVE.** Every eager write the multi-file
  design carried existed so the filesystem would not lie about where a desktop
  was; with no companion files there is nothing to lie about, so adding,
  renaming, duplicating, importing and deleting a desktop are plain unsaved
  changes and "close without saving" is a complete, honest revert of the
  session. `save()` on an untitled project writes the working slot SILENTLY —
  designing something and keeping it must never require choosing a file —
  and `saveAs()` is what gives it a home, taking the project's NAME from the
  file picked (so there is no name prompt in front of the save panel).
  Replacing an existing file is the NATIVE dialog's question and ONLY its
  question (`properties: ["showOverwriteConfirmation"]` is how the Linux panel
  is told to ask); `choosePath` returns a path or null, so declining a replace
  reads back as a cancel.
  **ROM BYTES TRAVEL IN THE FILE** (`project-images.js`). `userData/memory/`
  demotes to a working CACHE that a project open rebuilds in full: `write`
  COLLECTS every chip flagged `programmed` into `images` (noise does not need
  to travel), `read` HYDRATES them back before the renderer sees the project,
  and `reseatImages` gives a COPIED desktop (Import, Duplicate) fresh guids and
  fresh files so two chips can never share one. This is the second place in
  main with document knowledge after `migrations.js`, and equally narrow — it
  reads `components[].params.storage.guid` + `params.programmed` and nothing
  else. The cache is never SWEPT: a `.bin` left by a deleted chip is dead
  weight in userData and can never re-enter a project file.
  **CHANGING PROJECTS OR QUITTING** runs through `#confirmLeaveProject`, which
  on "save" LETS THE ACTION GO AHEAD (the user is not made to ask twice).
  Quitting is the silent case — no Save button was clicked, so nothing is asked
  about WHERE. Changing projects (New Project / Open… / Open Recent) differs in
  one way, and it is why an UNTITLED project is **always** asked about, dirty or
  not: it lives in the one working file the incoming project is about to claim,
  and there is nowhere else for it to go, so replacing it is destructive whether
  or not anything is "unsaved" — a ⌘S into the slot does not make it less so.
  That is also why "save" there means `saveAs`, a home of its own. A SAVED
  project has a file nothing is claiming, so it is asked about only when dirty.
  Every path resolves `false` for a cancel, and a save that never landed IS a
  cancel — `save` /
  `saveAs` / `exportTab` all return `Promise<boolean>` and every dialog is
  promise-wrapped, since PopupManager fires its callbacks on EVERY dismissal
  path (mask click included) so an awaiting caller can't hang.
  **EXPORT / IMPORT replaced a desktop's Save As / Open.** A
  `.desktop.chiphippo` is a SNAPSHOT — the document plus its ROM bytes, with no
  link retained — so unlike a v3 desktop file it can never dangle. Import is
  always an ADDITION (no file operation can replace the desk on screen) and
  re-mints the snapshot's ROM guids, so importing one twice leaves two
  independent copies. Opening a bare `.desktop.chiphippo` (or a loose
  `.chiphippo` design) wraps it in a new one-desktop project with NO location.
  **EVERY DESKTOP IS A PEER**: any can be renamed, duplicated, exported or
  deleted; the ONE rule is that a project keeps at least one, mirrored by the
  strip disabling Delete on the last remaining tab. A tab's context menu is the
  **board's** shape — Properties… · Duplicate · Export… · rule · Delete
  Desktop — NOT the part menu's: a desktop has no pins at all, so the leading
  Pin Assignment and its separator are gone (`project-tabs.js`). There is also
  no per-tab dirty dot: a desktop cannot be saved on its own, so a marker no
  action could clear would be a lie. **Properties…** opens the app-wide
  `PartPropertiesDialog` with the universal **Name/Description** pair alone
  (the description shows in the tab's tooltip — its only room on the strip);
  a desktop has no Location, because it is not a file. The PROJECT has the same
  dialog (`File ▸ Project Properties…`) plus one `"readonly"` **Location**,
  blank until it has been saved. **The strip is ALWAYS on screen** because
  there is always a project to fill it, and the `+` beside it needs nothing to
  exist first. The `+` splits the way a TAB does — a PRIMARY click does the
  common thing (adds a desktop, no menu, no questions) and a SECONDARY click
  drops the two-item menu, **New Desktop** · **Import Desktop…**. Those are the
  two ways a desktop ARRIVES, and neither belongs to any particular tab, which
  is why they live on the `+` and not in a tab's own menu; both are additions
  that land on the new desk (an import can no more replace what is on screen
  than a new desktop can), and both mirror the Desktop menu's leading pair, so
  the wordings must stay in step.
  **v3 → v4** (`project-migrate.js`): a project that listed desktop PATHS has
  them inlined on read, NON-DESTRUCTIVELY — a desktop file the user saved
  somewhere of their own is read and left exactly where it is. A tab whose file
  has gone (the dangling absolute path v4 abolishes) opens EMPTY with a warning
  naming it. `upgradeLegacyDefault` is the one destructive case: it rewrites
  the old working slot as v4 and only THEN removes the v3 file and the
  app-kept desktops it alone pointed at, returning its warnings for
  `bootProject` to carry out on the meta (the upgraded file cannot hold them).
  The **design clip**
  (`model/design-clip.js`, pure) is `paste-cluster.js` one level up: it carries
  the BOARDS too (plus everything seated on them, selected desk bricks, every
  wire with BOTH ends inside, and the buses / net names / anchored labels
  riding them), so a sub-assembly brings its own holes and its wiring survives
  the trip. Legality is per-board only and the drop is **all-or-nothing** —
  half a design would silently cut the wires that crossed to the board left
  behind. The ghost is built ONCE in the clip's own coordinates and then just
  TRANSLATED (it is rigid), and `DeskDoc.pasteDesign` stamps it in one
  snapshot-guarded mutation that rolls itself back on any refusal.
- **AI circuit builder** (Feature 260 — `app/store/credential-store.js` +
  `app/ai/{providers,client}.js` + `model/{pin-resolve,column-allocator,
  autobuild,autobuild-verify}.js` + `web/scripts/ai/{catalog-brief,generate}.js`
  + `components/ai-panel.js`). **AN LLM CANNOT EMIT GEOMETRY, SO IT IS NEVER
  ASKED TO.** The model answers exactly one question — which parts, and which
  of their pins share a net — as a coordinate-free `{parts, nets, tests}`
  spec, and a pure, DOM-free compiler decides every hole, column, anchor and
  wire. `sim/junction.js` (the LED burn rule, moved out of the view because it
  is PHYSICS, not logic) is why the compiler interposes a series resistor
  itself: an unlimited LED burns rather than lights, so a netlist must not have
  to mention one.
  - **Compile** (`autobuild.js`): `compileNetlist(spec)` → `{document,
    warnings, partMap, nets}`. Power is DERIVED — every def declares
    `role:"vcc"|"gnd"`, so a spec never lists a power pin; the compiler wires
    them, plants a PSU, and bridges the kit's two rail strips (they share no
    node). `column-allocator.js` hands out EXCLUSIVE column runs, which makes
    the worst machine-generation bug — two parts sharing a column-half, hence
    silently shorted — unrepresentable rather than merely unlikely. Routing is
    per-net star-from-hub over `freeAt` (you never wire TO a pin, you wire to a
    free hole on the pin's NODE), the hub being the highest-capacity port
    (a rail is ∞). `pin-resolve.js` is FAIL-CLOSED and case-FIRST: pin names
    are case-distinguished in the catalog (74LS47's `A`–`D` inputs vs its
    `a`–`g` outputs), so folding case would MANUFACTURE ambiguity; the one real
    ambiguity is `74LS148` (inputs *named* `0`–`7` that do not match their pin
    numbers), reported with both readings, with `#N` as the escape.
  - **Verify** (`autobuild-verify.js`): the L3a–L7 ladder, faults tagged
    `abort` (OUR bug) or `repair` (the SPEC's mistake) — the split the panel's
    retry loop needs. **L4 is the important one**: it compares the DECLARED net
    partition against the one `buildNetlist` DERIVES, which is the only thing
    that catches an accidental short (counts match, it loads clean, it settles,
    and it computes something else). **L7 is the highest-value one**: the spec
    states its own acceptance tests and the app RUNS them, so a perfectly-built
    adder with its bit order reversed is caught. Bit ordering in `set`/`expect`
    is PINNED by a test, not inferred. L5 settles with every clock idle-low —
    a bare `settle` leaves a clock line at `Z` and L6 would report a good
    circuit as undriven.
  - **Place**: the output is a **design clip** (`designClipOf` =
    `captureDesign` with everything selected, never a second converter), handed
    to `DeskController.armGeneratedDesign` — a ghost the user positions, NOT a
    circuit that appears. `applyGeneratedDesign(clip, {at})` drops it outright
    (shift from `nearestLegalOffset`). Both go through the one `#dropDesign`,
    so a generated circuit is ONE undo step and rides the same atomic
    `pasteDesign` transaction as a paste — there is deliberately no
    `applyBatch`.
  - **The prompt is DERIVED, never hand-written** (`ai/catalog-brief.js`):
    `buildCatalogCard()` projects `PALETTE_DEFS` (ids, packages, exact
    `n:name` pin lists — `JSON.stringify` would silently drop the FUNCTION
    fields). A new 74xx part reaches the model the moment it lands in
    `catalog/`. ~3.7 K tokens, over the prompt-cache minimum, so a repair round
    re-reads rather than re-pays.
  - **The renderer makes NO network call** — its CSP is `default-src 'self'`
    with no `connect-src`, so the whole outbound path is main's, exactly as
    filesystem I/O is. `ai/client.js` uses Node's global `fetch` (no runtime
    dependency; `src/package.json` still has no `dependencies` block) with an
    `AbortController` registry keyed by request id and an SSE reader that
    carries the tail across chunk boundaries. `ai/providers.js` holds BOTH
    adapters in one file behind `buildRequest`/`readEvent`/`buildPing`; nothing
    else branches on provider. A **refusal is a failure** — Anthropic returns
    HTTP 200 on a policy decline, so `stop_reason:"refusal"` is checked before
    the text is used. `ai:test` pings with `buildPing` (unstreamed,
    unschema'd): Test connection asks "can I reach you", so it must not fail
    because a model declined to fill a netlist.
  - **THE KEY NEVER CROSSES THE BRIDGE.** `credential-store.js` writes it
    through `safeStorage` into `userData/credentials.json` and REFUSES rather
    than falling back to plaintext when the OS has no store; `ai:key:status`
    answers `{configured, encryptionAvailable}` and nothing more. That is
    exactly why it does not ride `settings:set` — settings.json is plaintext
    and is handed back to the renderer whole on every read. Only the NON-secret
    half (`ai: {provider, baseUrl, model}`) lives there. The provider LIST is
    itself IPC (`ai:providers`), so the Settings picker cannot drift from the
    adapters, and the AI tab's panel therefore fills in asynchronously.
  - **The panel** (`components/ai-panel.js`) shares the analyzer's docked shell
    and its toolbar-pill segment discipline. `ai/generate.js` is the DOM-free
    seam (`parseNetlist` → compile → verify → clip), so a whole generation is
    testable with no window and no network; the clip is taken from the VERIFIED
    (loaded) document, since what the desk places must be what the loader would
    keep. Repair rounds cap at **2** and only `repair`-class faults are sent
    back — the model cannot fix our compiler, so re-asking would just spend the
    user's tokens. `ai:delta`/`:done` are a SEPARATE message stream from the
    `ai:start` invoke result, so pushes that beat the reply back are held and
    replayed rather than dropped.
  - **NO CONNECTION, NO SEGMENT.** The builder is the one tool that cannot work
    on the user's own machine, so the toolbar's AI segment is **disabled** until
    there is something to ask: `ai/connection.js` (pure) reads the settings' `ai`
    config, the `ai:providers` list, and `ai:key:status` for the provider the
    Settings picker would show — one `effectiveProvider` rule, so the button can
    never be gated on a key for a provider the panel isn't showing. Validity is
    decided WITHOUT asking the provider (nothing is sent anywhere until the user
    asks for a build): a key is stored, the provider is one this build has an
    adapter for, and a typed base URL parses as http(s). Whether the server would
    ACCEPT that key is only the server's to say — Settings ▸ AI's Test connection
    is where that is found. Every refusal carries the sentence the disabled
    button shows as its tooltip. The two ways the answer changes are a settings
    patch carrying `ai` and the key itself, which bypasses settings entirely —
    hence the dialog's `chiphippo:ai-key-changed` broadcast, which says only THAT
    it changed. The panel's remembered `aiOpen` is restored only once the answer
    is known (an `aiOpen` from a session that HAD a key must not reopen a panel
    whose button is now dead), and a key cleared while the panel is open closes
    it — a panel no button can close would be stranded.
- **Header toolbar**: two shapes, and no others. A **pill**
  (`.toolbar-pill`) groups buttons that read as ONE control — it carries the
  only border and the only background, its `.toolbar-pill-btn` segments are
  separated by spacing rather than by borders of their own (there is no
  split-button seam anywhere), and an armed segment FILLS instead of gaining
  an accent border. Three exist: the desk tools (Wire · Bus · Fade · Probe ·
  Analyzer · Fit · **BOM** · **AI** — BOM lives here, not with the file
  actions, because it toggles a desk panel exactly as Analyzer does, and like
  Analyzer its armed state comes from the panel's own `onVisibilityChange`, so
  the segment tracks the panel however it was closed; the AI builder is the
  same shape for the same reason, and the one segment that is DISABLED when it
  has nothing to offer — no API key, no builder; see the AI note above),
  **File** (New · Open · Save · Save As, all
  aimed at the PROJECT, which is the document — every file action is its OWN
  icon-only segment rather than a row hidden behind a ▾, since they are peers
  and a toolbar's job is to show what is available; the name + accelerator live
  in each segment's tooltip. There is no Open Recent here — an MRU list can't
  be a button, so it stays a File-menu submenu), and the **transport**
  (`.toolbar-pill--transport`, Feature 90/100),
  which is the one pill whose SEGMENT COUNT changes: stopped it holds only
  **Run**, and running it becomes **Stop** with Pause · Step · speed unhidden
  beside it (`.toolbar-pill-btn[hidden]` collapses the rest), so the pill never
  offers a control that doesn't apply. Run/Stop keeps its green/red signal as
  colour alone — the pill carries the only border, so no segment accents one of
  its own. Everything else is a plain `.toolbar-btn` / `.toolbar-icon-btn`.
  The pill is the APP's grouping shape, not the toolbar's alone — the desktop
  tab strip (`.project-tabs`) is the same thing floating over the
  desk, its active tab filling exactly as an armed tool segment does.
  A pill segment may carry a **readout** — the Wire button's color dot, the
  Bus button's `8`/`16` badge — and a readout is exactly that: it shows the
  active option and is NOT a picker (1–8 set the wire color and 1/2 the bus
  width while that tool is armed; a placed wire's color is changed through its
  Properties dialog). The **parts tray is deliberately NOT in the toolbar**: it
  carries its own chevron in the palette header's top-right corner and its own
  `.palette-flap` — a drawer pull absolutely positioned on the desk's left edge,
  so a shut tray costs zero layout width — with both on the SAME vertical line,
  so the control reads as one thing sliding into the wall. Both, and ⌘P, route
  through app.js's one `togglePalette` (the only thing that persists
  `paletteOpen`); `PalettePanel.setVisible` flips the pair and stamps
  `.app-main--tray-closed`, which insets `.project-tabs` past the flap.
  `.toolbar-btn--active` remains the one class every
  toolbar button's armed state toggles, whatever its shape.
- **Popups/menus**: `popup-manager.js` (ported from Port Hippo) is the only
  app-wide dialog/menu seam; build DOM with `dom.js` `el()`. `PopupManager.close()`
  fires a one-way `chiphippo:popup-closed` event so stateful dialogs can reset
  their open-guard however they were dismissed. Beyond `menu` / `confirm` /
  `prompt` / `notify` / `dialog` there is **`choose`** — the Cancel + N-choices
  shape a "save, discard, or cancel" question needs (the tab delete, the
  leave-a-project guard), where "no" splits into two different answers; its `onChoose` fires
  with `null` for every dismissal, so a caller can never miss one. `menu`'s
  item vocabulary is `{ label, disabled, danger, swatch, icon, accelerator,
  title, submenu + emptyLabel, onSelect, onRemove }` — a card where ANY item
  has an `icon` gives every item the 16 px slot (so labels line up), a
  `submenu` opens as a SIBLING card in the same dialog (hover or click; never
  nested, so it can't be clipped), and `onRemove` renders a trailing × that
  drops its row IN PLACE and leaves the menu open (removing a recent-project
  entry is not a selection). `emptyLabel` is a CARD-level option — passed
  alongside `items` for the root card, or on the owning item for a submenu —
  and is both the placeholder for an empty list and what the last `onRemove`
  falls back to; without one, an empty list opens an empty card. Everything is opt-in: an item with none of them
  renders exactly as it always did.
- **Part context menu — ONE shape for every kind**: `DeskController.#onPartContextMenu`
  builds the exact same three items, always, in this order: **Pin
  Assignment**, **Properties…**, **Delete Component**. No per-kind branching
  and no extra items — an item that doesn't currently apply stays PRESENT but
  `disabled` (Pin Assignment when a part has no pins/terminals; Properties…
  when it has no fields; Delete Component while `#editingLocked`), so the
  menu's shape never changes, only its enabled state. There is no Rotate or
  "Replace chip" item any more — rotating an already-placed, selected part is
  `R` only (`handleKeyDown`), and a damaged chip's only recovery is deleting
  it and placing a fresh one (`SimController.replaceChip` still exists and is
  still tested, just with no UI caller left).
- **Part Properties dialog** (`components/part-properties-dialog.js`): the ONE
  shared modal every part's **Properties…** item opens (enabled only when
  `DeskController.#propertyFieldsFor(comp, def)` returns at least one field).
  A catalog def declares its own editable fields as data (`properties: [{
  key, label, type, options }]`) — the dialog is a pure renderer over that
  list (one `buildControl`/`buildRow` dispatch per `type`) and knows nothing
  about any specific part. Four types today: `"color"` (every colored
  discrete — LED, `seg8cc`/`seg8ca`, `bar8`/`bar8iso` — shares one
  `LED_COLOR_OPTIONS` list of 5 colors and a row of clickable swatches
  reusing the `--color-wire-<name>` tokens; any def with a `colors` list
  arms placement directly with the "Default LED color" setting instead of a
  placement-time swatch popover, per `app.js`'s `onPickChip`), `"select"` (a
  `<select>` over `options: [{value, label}]` — the PSU's volts, the clock/
  oscillator's Hz, the LCD's size; a `<select>`'s value is always a STRING,
  so `buildSelect`'s change handler looks the typed option value back up by
  its stringified match rather than handing the raw string on to
  `normalizeParams`, which compares by `===`), and `"action"` (a full-width
  command button, not a value — a memory chip's `"Inspect memory…"` /
  `"Load image… (program)"`, appended by `#propertyFieldsFor` itself rather
  than the catalog, since a ROM's program action is additionally gated on
  `!#editingLocked`; clicking one closes the dialog and calls `onAction(key)`
  instead of `onChange`), and `"readonly"` (a value the dialog SHOWS but does
  not edit — the PROJECT's **Location**, which Save As is what changes; it
  takes the stacked full-width row a path needs. A desktop has none: it is not
  a file).
  A future part's properties are purely a catalog
  change (plus, only for a genuinely new control shape, one more `type` case
  in `buildControl`) — no changes to the dialog shell or the context-menu
  wiring. Like the Settings dialog, value fields apply live (`onChange(key,
  value)` fires per control change, no Save/Cancel); `DeskController
  #setComponentProperty` applies the patch via `DeskDoc.setComponentParams`
  and **remounts** the part view (`#remountPart`, not `updateParams` alone —
  a rotatable/span part like the LED only redraws through its span geometry,
  which `updateParams` alone skips) before committing through
  `#emitDocChanged` (coalesced) to ride undo/redo.
- **Application menu + dialogs**: `main.js buildMenu()` installs the native app
  menu; its **About** / **Settings…** items are one-way pushes
  (`menu:show-about` / `menu:open-settings` via `webContents.send`), which the
  preload re-dispatches as `chiphippo:show-about` / `chiphippo:open-settings`
  (the documented main→renderer broadcast pattern — the parity test ignores
  push channels, only `ipcMain.handle`↔`ipcRenderer.invoke`). The bar is
  **File · Desktop · Edit · View · Window · Help**. **FILE IS THE PROJECT's**,
  because the project is the document: New Project ⌘N · Open… ⌘O · Open Recent
  ▸ · rule · Save ⌘S · Save As… ⇧⌘S · rule · Project Properties… · rule · Bill
  Of Materials… ⌘B, each a `menu:project-*` (or `menu:build-guide`) push the
  preload re-dispatches as `chiphippo:project-*`. **DESKTOP** is the structure
  inside it — New Desktop · Duplicate · rule · Import… · Export… · rule ·
  Properties… · Delete, as `menu:desktop-*` → `chiphippo:desktop-*`, every one
  aimed at the ACTIVE desktop. The tab strip mirrors it in two halves, so the
  labels must stay in step: the `+`'s secondary-click menu carries the two
  ARRIVALS (New Desktop · Import Desktop…), which belong to no particular tab,
  and a tab's context menu carries the rest for the one it was opened on. So
  must their AVAILABILITY: **Duplicate** and **Delete** carry menu-item ids and
  take their enabled state from the renderer over **`menu:desktop-state`**
  (`{canDelete, canDuplicate}`), exactly as Edit ▸ Undo/Redo does over
  `menu:edit-state` — the workspace owns the tab set and the run lock, and
  pushes on every change to either (`#pushMenuState`, from `#renderTabs` and
  `setEditingLocked`). `refreshAppMenu` replays it, since a fresh template
  starts from its own defaults. Without that the menu bar would offer what the
  strip forbids, and an item that silently does nothing is worse than a greyed
  one. `app.js` hands all of them straight to `ProjectWorkspace` — the only
  side that knows what is open and what is unsaved. The toolbar's File pill
  dispatches the SAME `chiphippo:project-*` events, so the two can't drift.
  Open Recent is the one push carrying a **payload** (the project file its
  item names), so the preload's re-dispatch passes `detail` through for every
  channel; and it is baked into the menu TEMPLATE, so main rebuilds the whole
  menu (`refreshAppMenu`) whenever the MRU list changes —
  `setEditMenuState` therefore remembers the renderer's last Undo/Redo
  availability and replays it, since a fresh template starts both disabled.
  `app.js` opens the
  matching PopupManager modal: `components/about-dialog.js` (name/subtitle/desc
  + version info from `app:info:get`) and `components/settings-dialog.js`. The
  **Settings dialog is dumb**: it broadcasts a `chiphippo:settings-changed`
  patch and `app.js`'s `applySettings` both persists it (`settings.set`) and
  applies it live. It is a **tabbed** master-detail card (left nav rail →
  panels). The **Appearance** tab (the first/default tab — there is no
  General) leads with **`theme`** — a `.settings-segmented` picker (the
  dialog's form of the toolbar pill) offering **System / Light / Dark**,
  default `"system"`. It is the ONE setting the renderer does not apply:
  main turns it into Electron's **`nativeTheme.themeSource`**, and everything
  follows from that — every window's `prefers-color-scheme` (so theme.css's
  light palette reaches the main window AND every auxiliary window with no
  per-window plumbing and no flash), the native menus/dialogs, and each new
  `BrowserWindow`'s pre-paint `backgroundColor` (`windowBackground()`). The
  `:root[data-theme]` blocks in theme.css stay as a manual override only.
  The tab also drives **`showDeskHub`** (off by default — toggles the
  `DeskHud` overlay via `setVisible`), **`selectionColor`** (`#rrggbb` or null → sets
  the `--color-selection` custom property that `.board-outline-path` strokes
  with, falling back to `--color-accent`), and **`defaultLedColor`** (one of
  `catalog/parts.js`'s `LED_COLOR_OPTIONS`, default `"red"` — the color any
  newly placed colored discrete (LED, `seg8cc`/`seg8ca`, `bar8`/`bar8iso`)
  gets; not a live-apply setting, only read at placement time by `app.js`'s
  `onPickChip`). The **Data Sheets** tab drives
  **`datasheetDir`** (the external datasheet-PDF folder, default null) — its
  Browse button calls the native `settings.chooseDatasheetDir` picker and
  emits the chosen path; no live apply
  (the pinout window reads it at open time). The **AI** tab drives the
  NON-SECRET half of the user's connection (`ai: {provider, baseUrl, model}`,
  emitted WHOLE as an object-valued setting) and is the one panel built
  asynchronously — its picker comes from `ai:providers`, so it cannot drift
  from `app/ai/providers.js`. Its API-key field is the ONE control in the
  dialog that bypasses `#emit` entirely, calling `ai.key.set` directly; see
  the AI-circuit-builder note above for why. Window bounds and the desk camera
  (incl. **zoom**) are already persisted in `settings.json` (`windowBounds` via
  `window-state.js`; `viewport` via the renderer's debounced save).
- **Pin-assignments window** (Feature 100): **Pin Assignment**, the item
  leading every part's context menu (`DeskController.#onPartContextMenu` →
  `#onOpenPinout(ref, rows, rot)` — read-only, so it's offered even while the
  circuit runs), invokes `pinout:open`, and main opens a **separate floating
  OS window**
  (`web/pinout.html` → `scripts/pinout.js`, rendering
  `components/chip-pinout.js` `buildPartPinout`). One builder per catalog shape:
  DIP chips → the physical two-column diagram; discretes → a linear pin list
  keyed to anchor-hole offsets; PSU/clock bricks → a terminal map. One window
  per ref (re-open focuses); it's `alwaysOnTop` by default, and a native
  right-click menu toggles that for every open pinout and persists it as
  `settings.pinoutFloat` (a de-facto global, ready for a future settings
  dialog). Pure DOM, no modal chrome — the native window frame owns the title
  bar + close. Below the pin map, a **chip** pinout also shows the manufacturer
  **datasheet crop** — the connection-diagram / function-table region cut from
  the source PDF (`web/datasheets/<id>.png`, built by `make datasheets`, see
  below). The `<img>` loads lazily and its `<figure>` REMOVES ITSELF on load
  error, so the four chips with no datasheet (and every discrete/brick) simply
  show the pin map; main widens the window when a crop exists for the ref.
  Separately, the user can point **Settings ▸ Data Sheets** at an external
  folder of manufacturer datasheet PDFs (`settings.datasheetDir`, default null,
  chosen via the native `settings:choose-datasheet-dir` picker). When that
  folder holds a `<ref>.pdf`, main flags the window (`?pdf=1`) and the header
  grows a top-right line-drawn **document button** (`chip-pinout.js`
  `datasheetButton`, wired in `pinout.js`) that invokes `datasheet:open` →
  `shell.openPath` to open the PDF in the OS viewer. This external-PDF path is
  independent of the committed PNG crop above — either, both, or neither may be
  present. It is the ONE reason the otherwise bridge-free pinout window loads
  `preload.js`.

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
make datasheets # Regenerate the pinout-window datasheet crops (see below)
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
  `porthippo/src/web/scripts/components/card-canvas.js`). The capture is for the
  MOVE stream only — never the sole delivery route for the RELEASE. The four
  wire/bus drags go through **`components/pointer-gesture.js`**
  (`beginPointerGesture` → one teardown): `pointerup`/`pointercancel` listen on
  `window` in the CAPTURE phase, so a release reaches the gesture whether or not
  the capture held, and `lostpointercapture` + window `blur` end it too (the only
  signals for "this pointer isn't yours" with no up/cancel behind them). A drop
  is resolved from the RELEASE event's own position (`releaseWorld`), never from
  the last `pointermove` — coalesced moves lag the cursor, and a stale sample
  used to silently lose the drop. `.desk-viewport` sets `touch-action: none` so
  the browser can't claim a gesture mid-drag and cancel it.
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
- **A chip and a LINEAR discrete belong to the pin-board** — their `comp.board`
  never names a rail (the footprint is grid-column arithmetic). A **rotated
  two-terminal part** (resistor / LED) is instead a free two-ends device: pin 1
  anchors in ANY hole — a grid row OR a power rail (`LEAD_ANCHOR_RE` in
  `occupancy.js`) — and pin 2's free lead is a `{dx, dy}` **bend** from that
  anchor, resolved geometrically against whatever strip lies under it
  (`partPinAddresses`). So **both leads can reach rails** (a resistor bridging two
  rails), subject only to each def's `minSpan`. A lead — or the anchor — over
  nothing resolves to `null` and **floats** — legal, and what happens when a rail
  is moved or deleted; the part keeps its exact position. Deleting a strip removes
  only what is *seated* on it (`comp.board === id`), never a neighbour's lead.

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
