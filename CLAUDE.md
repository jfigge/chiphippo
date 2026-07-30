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
all 12 gate defs, and the exhaustive truth-table harness (468 combinations);
and the simulation engine v1 (90) — the pure
`sim/resolve.js` (per-net driver → level with supply-beats-output strength
precedence + short/conflict taxonomy) and `sim/engine.js` (power gating from
VCC/GND nets, the warm-started settle loop with a 200-iteration oscillation
cap, damage bookkeeping — reported, never mutated by the pure engine), the
renderer-side `SimController` (owns Run/Stop, re-settles on every input event,
publishes `chiphippo:sim-state`, latches 12 V damage through `desk-doc` FOR THE
RUN and clears it on `stop()`,
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
(150 — landed out of tree order) that flips in via `Tab` alongside the
breadboard, drawing chip symbols + routed named nets + bus lines from the same
`DeskDoc` (`components/schematic-view.js` + `model/schematic-layout.js` +
`catalog/symbols.js`), sharing the desk's camera/probe/live sim tint and
persisting only a per-symbol `schematicPos` layout nudge — never a second
source of truth; and (skipping 160, still deferred — it is the one plan file
under `features/deferred/`) **memory chips & wide DIPs + file-backed memory +
inspector** (170/180/190). Volatility decides
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
onto `model/autobuild.js`, is still open — note it now has `centreDocument` and
a second output to honour); and **example circuits** (270) — every benchable
74xx part's demonstration bench shipped inside the app and offered as a button
on that part's pin-assignments window, landing as a `<ref> example` desktop;
and **auto-update** (280) — `electron-updater` against the release feed the
Release workflow was already publishing, a **Settings ▸ About** tab to check
on demand and opt into checking at launch (off by default — a check is an
outbound call), a restart only ever taken with consent and through the normal
unsaved-project guard, and ONE runtime `store-build.js` gate that turns the
whole feature off in a Mac App Store build; and **language support** — the app
in seven languages (English, German, Spanish, French, Italian, Japanese, Chinese)
off one JSON catalog each, with main resolving the locale for every window and a
change applied to the chrome IN PLACE, since nothing here reloads; the user guide
stays English by decision. See the "Language support" section below, including
the five guards that make an untranslated string fail the suite rather than ship.
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
  API-key sidecar, Feature 260), plus `ai/` (`providers.js` + `client.js`),
  `datasheets/` (`sources.js` + `download.js`) and `updater.js` — the app's
  ONLY THREE outbound network calls, all in main because the renderer's CSP
  forbids one, and all the same shape: a hard-coded statement of where it may
  go, beside the thing that goes there (the provider table, the source table,
  and electron-builder's `publish` block). All three are also OPT-IN — an AI
  build is asked for, a download is pressed, and the update check is off until
  Settings ▸ About turns it on — so a Chip Hippo nobody has configured never
  reaches the network at all. Beside the updater, `store-build.js` is the one
  place that answers "is this a store build?" (see the auto-update note below).
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
  plumbing — as, since the Feature 50 follow-up, do the controller's own seven,
  see the pointer-capture discipline note below). All the
  world-coordinate/hit-test geometry the controller used to inline now lives in
  the pure, tested `model/part-geometry.js`. What remains in the controller is
  the direct-manipulation input state machine (the shared `#mode`, board
  placement + the intertwined part rotation, the board/part/marquee drag
  gestures, mounting, selection, doc mutations, and the one viewport pointer
  dispatcher) — one responsibility, exercised by the characterization suite in
  `tests/desk-gestures.test.js`.
- `src/web/locales/` — one bundled message catalog per language (`en.json` is the
  reference; see "Language support"). Read by MAIN and handed to each renderer
  over `i18n:load` — a renderer never reads or fetches one itself.
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
  `.layer-overlay` (ghosts, hover ring(s), tooltips — pointer-inert). Boards and
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
  **FIT (⌘F) IS THE ONE CAMERA ACTION THAT EDITS THE DOCUMENT** — deliberately,
  not by oversight. `#recentreDesk` slides the WHOLE desk onto the origin
  (`DeskDoc.translateAll`: every board, brick, and label by one integer delta;
  seated parts and wires are addresses, so they ride their board) before the
  camera frames it, so a design built across a long session cannot creep ever
  further out into the coordinate space. The move is RIGID, so it can neither
  be refused nor break a mating; it rides `#emitDocChanged` as one undo step
  and marks the project dirty; and it is skipped while the sim runs, where
  topology is frozen. Fit follows the ACTIVE view (app.js's `fitActiveView`):
  the schematic's own `fit()` is camera-only, since its symbol positions are
  derived and there is nothing to move.
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
- **Wire layout — direct or routed** (`WIRE_LAYOUTS`, the wire's own
  Properties dialog). A **direct** wire is the sagging hole-to-hole curve
  every wire has always been: its shape is DERIVED from its two ends, so
  there is nothing to store and a direct wire carries no `layout` and no
  `points` at all — absence IS the default, the same omit-when-default
  convention as Name/Description, so a document that never routed anything
  round-trips byte-identical. A **routed** wire adds `layout: "routed"` and up
  to `MAX_WIRE_POINTS` (20) `points`, and the whole difference is that its
  shape is the USER's: it draws as a straight polyline through them
  (`desk/wire-path.js`'s `polylinePath`/`fadedPolyline`, `wirePath`'s
  counterparts) and its BODY DRAG bends it instead of translating it —
  pressing anywhere along the run inserts a waypoint at the segment
  `nearestOnPolyline` names, dragging an existing knob moves it, and dropping
  either onto a neighbouring point (a waypoint, or one of the wire's own ends)
  MERGES it away, which is how a bend comes back out. So a routed wire has no
  rigid whole-wire translate: the gesture that was it now bends. Waypoints are
  the ONE part of a wire that is not an address — free desk coordinates to two
  decimals, deliberately off the lattice (they sit in the space BETWEEN the
  boards, so snapping them to a hole they have nothing to do with would be a
  lie) — which is also why they are the one part that has to be moved by hand:
  `translateAll` (⌘F's recentre) and `pasteDesign` shift them explicitly,
  where every other part of a wire rides its board for free. Switching back to
  Direct DELETES them (a curve has nowhere to keep a bend, and keeping them
  would leave invisible state waiting to reappear). A BUS MEMBER is never
  routed however it is set — its middle belongs to the ribbon, so its leads
  win. Settings ▸ Appearance ▸ **Wire layout** (`defaultWireLayout`) seeds a
  NEW wire only, read at placement time exactly as the default LED colour is;
  the AI builder ignores it outright and emits nothing but direct wires, since
  a compiler places holes and has no route to draw.
- **Bus placement rings the WHOLE run, at BOTH ends** (`bus-tools.js` +
  `components/hole-rings.js` + `bus-layout.js`'s `busRunHoles`). A bus lands
  `width` leads in one click, so the single shared `.hole-ring` the wire tool
  hovers with cannot state its case: it answers "this hole" where the question
  is "these eight". `HoleRings` is that ring, MANY at once — the same element
  and class (so there is one ring look in the app), pooled (a pointermove
  redrawing eight divs to show the same eight circles is work with nothing to
  show for it), in the pointer-inert overlay. Both phases of the gesture ring
  every hole the click would claim: the hover colour when it can have them all,
  `--illegal` when it can't, exactly as a part's placement ghost reddens.
  Two rules follow, and the second is the one that was missing:
  - **`busRunHoles` is BEST-EFFORT where `busRunAddresses` is all-or-nothing.**
    A run that walks off the end of a strip reports the holes that DO exist
    rather than answering null, because five red rings where eight were asked
    for IS the explanation — "it doesn't fit" with nothing drawn is what a
    silent refusal already looked like. `busRunAddresses` is now derived from
    it (both ends, `fits` on each), so there is one walk.
  - **ANCHORING IS A PLACEMENT, so it is checked like one.** The first click
    used to test only the hole under the cursor, which let a start be anchored
    where the bus could never fit — and every second click then reported
    illegal, making the LANDING look like the fault wherever it went. The start
    run is now checked whole (on the strip, every hole free) and refused where
    it is made, red rings and all.
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
  each clock's current level via `clockPhase`), re-ticks on every input event, and
  publishes `chiphippo:sim-state`
  (net levels + chip status + clock levels) that live views render from — views never
  query the engine. Sequential state and clock phases are **run-volatile** (reset on
  Run, never serialized).
  **SO IS 12 V DAMAGE, and that took work to be true.** `#persistDamage` writes
  `params.damaged` into the DOCUMENT because the document is what the pure engine
  reads (`powerStatus`), and a chip that let its smoke out at tick 5 has to stay
  dead at tick 6 — a timerless solver has nowhere else to remember that. But it is
  not a property of the CIRCUIT: burning a chip is a WIRING mistake, and letting
  an experiment permanently spoil the design it was run on was never the intent.
  So `stop()` calls `#clearAllDamage()` — **before** `#onTransportChange`, because
  stopping re-baselines undo/redo against the live document (`#history.sync`) and a
  later clear would leave the baseline holding the damage for ⌘Z to bring back —
  and `DeskDoc`'s **load path** drops the flag through `loadParams` (deliberately
  NOT `normalizeParams`, which `setComponentParams` shares and the latch needs),
  which covers a project ⌘S'd mid-run, any document written before this rule, and
  every import and paste. `paste-cluster.js` and `design-clip.js` already stripped
  it calling it "run state"; the run boundary was the last place that disagreed.
  `SimController.replaceChip` is GONE — it was the single-chip manual recovery for
  a kill that now recovers itself, and it never had a UI caller.
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
  **NOTHING IS WRITTEN TO THE USER'S FILE UNTIL YOU SAVE.** Every eager write
  the multi-file design carried existed so the filesystem would not lie about
  where a desktop was; with no companion files there is nothing to lie about, so
  adding, renaming, duplicating, importing and deleting a desktop are plain
  unsaved changes and "close without saving" is a complete, honest revert of the
  session.
  **AND NOTHING IS LOST TO A CRASH, because those are different questions.**
  Every `AUTO_SAVE_MS` (30 s) the open project is stashed in the app's own
  WORKING SLOT — never in the user's file — so the • still means "not in your
  file", "discard" still discards, and a power cut costs at most half a minute.
  The slot therefore means one of TWO things, and a `recoveryFor` stamp is the
  difference:
  - **unstamped** — an untitled project's actual home, as it always was. For it a
    stash IS a save, so the tick goes through the ordinary `#writeProject` and
    the • CLEARS; there is no file for it to be pending against. A clean quit
    keeps it.
  - **stamped** — a copy of a project that HAS a file, holding work that file
    does not. Dropped by any save to a real path (main enforces that, so a call
    site cannot forget) and by a clean quit — which leaves "a stamped slot exists
    at startup" meaning exactly "the last session did not finish". That is the
    whole crash detector: no timestamps, which are the one thing cloud sync and a
    corrected clock will both lie about.

  **TWO BASELINES** follow: `#saved` is the project as its FILE holds it and
  drives the •; `#stashed` is it as the SLOT holds it and is what the tick
  compares. They part company the moment a stash gets ahead of the file, which
  for a titled project is the normal state — and is why the tick cannot just
  watch `dirty` (true from the first edit until ⌘S, so it would rewrite the same
  bytes every 30 s forever). The tick also does NOT listen for
  `chiphippo:doc-changed`: that event is wrong in BOTH directions —
  `#setTabProperty`/`#setProjectProperty` never dispatch it (so a desktop or
  project rename would never be stashed), and it fires on load and on every
  undo/redo restore (where there is nothing to write). `#imagesTouched` is the
  one change no signature can see: a ROM's bytes live in a sidecar, and
  `setMemoryProgrammed` writes `programmed: true` over `true` for a chip being
  RE-saved, so `MemoryBridge` reports it through an injected `onImagesChanged`.
  **A RESTORE IS NOT A QUESTION.** `recoveryBoot` restores the stash outright and
  the renderer says so (`workspace.recovered*`, localized — main hands over the
  FACTS `{name, path, homeless}`, since `m()` is for text MAIN renders). Restored
  work arrives UNSAVED (`#saved`/`#stashed` left null), so ⌘Z and
  close-without-saving both still work: a launch modal would be asking for an
  irreversible-looking decision about a reversible thing, with the destructive
  button one mis-click away. A recovery whose own file has gone restores as
  UNTITLED, so Save As re-homes it. Guards: `#busy` (a leave/quit question is
  out, or a swap is mid-flight — a stash then would preserve the very work being
  discarded), `#inFlight` (the write chain's tail; a tick SKIPS, a manual ⌘S
  QUEUES, since `#askUnsaved` reads a `false` as a cancel), `#autoStopped` (a
  STATE, not merely a cleared interval, because `autoSaveNow` is public), and
  `#autoSaveFailed` — one quiet failure RETIRES the tick rather than reopening
  the same modal every 30 s. `#writeProject`'s baseline is the BYTES THAT WENT
  (`projectSignature(written)`), never `#project` after the await: a desk edit
  landing mid-write was always safe (the dirty test re-reads the live `DeskDoc`),
  but every META edit reassigns `#project`, so the old code folded an unwritten
  rename into the baseline and lost it. `visibilitychange` flushes on the way out
  of sight, and the interval `unref?.()`s — a number in the renderer, a real
  `Timeout` under `node --test` that would keep the runner alive once per
  constructed workspace. `autoSaveMs: 0` is the off switch the harness uses.
  `save()` on an untitled project writes the working slot SILENTLY —
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
  one way, and it is why an UNTITLED project **that holds something** is asked
  about dirty or not: it lives in the one working file the incoming project is
  about to claim, and there is nowhere else for it to go, so replacing it is
  destructive whether or not anything is "unsaved" — a ⌘S into the slot does not
  make it less so. That is also why "save" there means `saveAs`, a home of its
  own. The exception is the state the app BOOTS INTO: a **PRISTINE** project
  (`#isPristine` — no name, no description, ONE desktop, `isEmptyDocument`, and
  not dirty) holds nothing for the incoming one to destroy, so it is let go
  silently. Otherwise the very first thing a session does — New Project, or
  Open… — would open with a save-or-discard question over a blank desk nobody
  has touched. Both halves of the test are load-bearing: an unsaved change is
  caught by `dirty`, and one already ⌘S'd into the slot (which is NOT dirty) by
  the project still having something in it. `isEmptyDocument` reads only the
  CONTENT lists (derived from `emptyDocument()`, so a list added later cannot be
  forgotten) and never the `next*Id` counters — those say what a desk has ever
  held, not what it holds, and a board placed then deleted leaves it as empty as
  it started. A SAVED
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
  the wordings must stay in step. A THIRD way arrives with Feature 270 and
  deliberately does NOT live on the `+`: a chip's **example circuit** belongs to
  a PART, not to the tab strip, so it is a button on that part's
  pin-assignments window.
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
  to mention one. The **pull rule** is the same fact one step over: a switch
  is a CONTACT, not a source, so an input fed from one floats whenever the
  switch is open — and a floating TTL input reads HIGH, which is a switch that
  appears to do nothing. So a signal net with no rail, no output driver and no
  resistor of its own, whose only path to a supply runs through a contact, gets
  a pull to the OPPOSITE rail (`contactPairs` probes each def's own
  `internalBridges` at both extremes of its parameter domain rather than adding
  a second catalog field that could drift). Which rail is READ off the far side
  of the contact, never assumed — a GND-side switch gets a pull-UP — and a net
  whose contacts disagree, or reach no rail at all, is left exactly as declared
  for L6 to report. Pulls to one rail pack eight to an `rnet9`; a lone one is a
  bare `resistor`.
  - **Compile** (`autobuild.js`): `compileNetlist(spec)` → `{document,
    warnings, partMap, nets}`. Power is DERIVED — every def declares
    `role:"vcc"|"gnd"`, so a spec never lists a power pin; the compiler wires
    them, plants a PSU, and bridges the kit's two rail strips (they share no
    node). `column-allocator.js` hands out EXCLUSIVE column runs, which makes
    the worst machine-generation bug — two parts sharing a column-half, hence
    silently shorted — unrepresentable rather than merely unlikely. Routing is
    per-net star-from-hub over `freeAt` (you never wire TO a pin, you wire to a
    free hole on the pin's NODE), the hub being the highest-capacity port
    (a rail is ∞), and a port is keyed by its NODE so two pins already sharing
    one are never wired to each other.
  - **THE BOARDS SNAP TOGETHER, AND A STACKED PAIR SHARES THE RAIL BETWEEN
    THEM.** A bench dovetails two 830s and the strip in the middle serves the
    board above it and the board below it — you do not fit a second one against
    it — so the compiler emits one RUN of strips,
    `rail · pins · rail · pins · rail`, not N self-contained kits with a gap
    between them. The shared strip sits in BOTH kits' `rails`, and everything
    else falls out of that: the bridge loop CHAINS (R0–R1 across the first
    board, R1–R2 across the second), so the two wires that used to run from
    kit 1 to kit 2 — the height of a whole breadboard, over everything on it —
    are not needed at all. Two boards therefore cost one fewer strip and two
    fewer wires than they did, and the supply is still one net end to end.
    `railStripIds` is read off `boards` rather than off `kits`, whose lists now
    overlap: walking the kits would offer the shared strip's holes twice. The
    run also carries ONE `group`, as `DeskDoc.addKit` gives a kit placed from
    the palette — the compiler used to leave every strip loose, so even a
    single generated kit came apart when its pin-board was dragged
    (`pasteDesign` re-mints the id on the way in).
  - **PLACEMENT is a step, not an accident.** Seating used to follow whatever
    order the spec listed parts in, with the compiler's own interposed
    resistors appended last — the worst possible order for exactly the parts
    it applies to, since a pull-down array serves ONE switch bank and was
    therefore seated as far from it as the board allowed (and, once a board
    filled, onto the next board entirely). Three rules now decide the layout,
    and together they took the 8-bit adder from two breadboards and 74 wires
    to **one board and 58**, total wire length −48%; across all 51 demo-bench
    circuits, −18% wire and 104 fewer wires.
    - `orderByConnectivity` — greedy cluster growth from the busiest part,
      then whichever unplaced part shares the most nets with what is down.
      Since the seating loop fills one board before starting the next, an
      order where neighbours are adjacent also keeps a net's parts on ONE
      board; the cross-board wires that remain fall on the genuinely
      least-connected seam. RAIL nets are deliberately not adjacency (every
      part touches power, and a rail net routes to the nearest rail hole
      rather than between its members). Ties break by spec order, so a spec
      always lays out the same way.
    - `seatCompanion` — a pull pack seats IN the columns of the switch bank it
      pulls, the bench move where an `rnet9` under a `sw-dip8` buys eight
      pull-downs for zero wires and zero columns. Sharing a column-half is
      otherwise the exact disaster `column-allocator.js` exists to prevent, so
      NOTHING here is inferred: the net equality is given (the pull rule
      CREATED one net per pack pin, each already holding that switch contact),
      the geometry is then proved pin by pin with `nodeOf`, and every column
      touched must be free or the host's — hence `columnOwner`, and hence a
      column recording WHO owns it rather than merely that it is owned. Any
      check failing returns null and the part seats the ordinary way, so this
      can only ever cost columns, never correctness; L4 checks the result
      regardless. One host per pack only — a pack serving four separate slide
      switches falls back.
    - `freeRail(…, {fromEnd})` — the PSU brick stands off the RIGHT of the
      boards, and a rail is one node end to end, so reaching for hole 1 bought
      nothing but two wires the full width of the desk.
    - **SEATING IS TWO PASSES, and a second breadboard is a LAST RESORT.**
      Pass 1 fills each board before starting the next — the only way to learn
      how many boards a design ACTUALLY needs, which the column budget cannot
      know (same reason the prune step exists). What happens next is decided
      from that answer, and both halves matter because a spilled design used
      to arrive as one board crammed to its last hole and another holding a
      single resistor.
      - **The blank column goes before the board does.** `GAP` is a courtesy —
        so neighbours do not read as one block — but insisting on it fetched a
        whole breadboard for a 1-column shortfall: eight LEDs reserving a
        blank each left two columns free at the edge and the last part needed
        three. So if pass 1 spilled, the design is re-seated with `gap = 0`,
        and that is kept ONLY when it saves a board. This alone took the demo
        corpus from **9 multi-board circuits to 1**.
      - **The split is CHOSEN, not fallen into** (`splitAcrossBoards`, pure).
        A design that genuinely needs two boards is cut where it severs the
        FEWEST NETS, not at the halfway column — cutting for an even split
        alone slices straight through a byte-wide bus, and 16 nets crossing
        the seam cost far more than a half-empty board (measured: a naive
        even split turned 8 cross-board wires into 22). Every position that
        leaves the board reasonably filled (`FLOOR`) is a candidate, ties go
        to the evenest. RAIL nets are excluded — every part touches power, so
        they sever nothing. A companion costs 0, since it rides its host's
        columns and follows it wherever it goes.
      - The assignment is a **preference, never a refusal**: the assigned
        board is tried first, then every board. So it can only change WHICH
        board a part lands on, never whether it lands — and a re-seat that
        needed MORE boards is discarded for the one that came before it.
      Corpus-wide this was **−13% strips, −8% wire length, −11% crossings**.
      Note a serpentine fill (alternate boards filling right-to-left) was
      tried and REJECTED: it only helps when the first board is full to its
      last column, and once the split is chosen properly it rarely is — with
      a half-filled first board it puts the seam at opposite ends and made
      the 8-bit bus port 43% longer.
    - **Kits are PRUNED, not predicted.** How many breadboards a design needs
      cannot be known before it is placed: the column budget has to assume a
      pull pack costs its nine columns, and companion seating then costs it
      none — so a design that fits comfortably on one board was handed two, and
      the spare shipped EMPTY with bridge wires stitched across it. Nothing
      tries to estimate better (guessing low costs a `NO_ROOM` refusal, which
      is not recoverable; guessing high costs a board that is simply given
      back). Seat first, then keep only the kits something landed on. This is
      the other reason the power wiring and the routing moved after seating:
      the bridges and rail taps are never built for a board that is about to
      go. A design with no seated parts at all keeps the first kit — the PSU
      still needs a rail to reach.
  - **ROUTING minimises length AND crossings** (`model/wire-crossing.js`, pure).
    A layout can be short and still unreadable, because "short" says nothing
    about what a wire passes OVER. The geometry that makes it tractable: a DIP
    straddles the trench with its pins in rows e/f, everything else the
    compiler seats lies along row **a**, and a wire attaches not to a pin but
    to a free hole on that pin's NODE — which offers five ROWS. Taking "the
    first free hole" took row a every time, i.e. the one row every discrete
    occupies. So a port now OFFERS its free holes and `bestPair` picks the
    pair by `distance + 20 × crossingCount`, `segmentHitsBox` being
    Liang–Barsky (sampling steps over a corner clip, and near-misses are
    exactly what reads as crossing). The same chooser does the POWER wiring,
    which is where it pays twice: a kit has a rail strip above the board and
    one below, bridged, so nearest-that-flies-over-nothing picks the rail on
    the pin's own side of the trench with nothing told to it. The bridges and
    PSU leads are therefore wired AFTER seating — a bridge crosses the whole
    pin-board, and before seating there is nothing to avoid, so it always went
    down column 1, which is exactly where the first part goes. Residual
    crossings are REPORTED (`WIRES_CROSS_PARTS`), never hidden: a net joining
    a pin below the trench to one above has to get across, and where both ends
    sit under a chip a straight hole-to-hole run cannot go around the end of
    it the way a hand would. Corpus-wide this took wire length −38% and
    crossings −44% (932 → 518). `pin-resolve.js` is FAIL-CLOSED and case-FIRST: pin names
    are case-distinguished in the catalog (74LS47's `A`–`D` inputs vs its
    `a`–`g` outputs), so folding case would MANUFACTURE ambiguity; the one real
    ambiguity is `74LS148` (inputs *named* `0`–`7` that do not match their pin
    numbers), reported with both readings, with `#N` as the escape.
  - **Verify** (`autobuild-verify.js`): the L3a–L7 ladder, faults tagged
    `abort` (OUR bug) or `repair` (the SPEC's mistake) — the split the panel's
    retry loop needs. **L4 is the important one**: it compares the DECLARED net
    partition against the one `buildNetlist` DERIVES, which is the only thing
    that catches an accidental short (counts match, it loads clean, it settles,
    and it computes something else). It derives that partition from **WIRING
    ALONE** — `buildNetlist(doc, …, {bridges: false})`, every switch treated as
    an open contact however it is set — because a switch thrown to a rail
    genuinely does make its signal net that rail, and holding THAT against the
    declared topology condemned the most ordinary input stage there is: L4
    aborted every slide-switch design as `NET_SHORTED_TO_RAIL`, a fault the
    model could neither cause nor repair. A severed net and two parts sharing a
    column-half are both facts about wiring, which no switch position can hide
    or invent; a real electrical short is L5's to report, from the conducting
    netlist it keeps. **L7 is the highest-value one**: the spec
    states its own acceptance tests and the app RUNS them, so a perfectly-built
    adder with its bit order reversed is caught. Bit ordering in `set`/`expect`
    is PINNED by a test, not inferred. L5 settles with every clock idle-low —
    a bare `settle` leaves a clock line at `Z` and L6 would report a good
    circuit as undriven.
  - **Every generated circuit explains itself.** The spec carries a `notes`
    paragraph and `assemble` stamps it above the boards as a caption, in the
    same line pitch and muted body a demo bench uses — a generated circuit and
    a shipped demo should read the same way on the desk. A generated circuit
    arrives with no history: the user did not build it and cannot ask it why it
    is wired the way it is, and the model already knew, it just had nowhere to
    say so. The caption is **anchored to the leftmost seated part**, and that
    is load-bearing rather than decorative: `captureDesign` carries ONLY
    anchored labels, on the rule that a free-floating one belongs to the desk
    it was written on rather than to the design, so an unanchored note would be
    silently dropped on the way to the ghost. `wrapText` breaks the paragraph
    to 64 characters because a label is `white-space: nowrap` — the width is
    not a style choice but how wide a line may be DRAWN, and 64 stays inside a
    full pin-board's own footprint (a word longer than that overflows rather
    than being cut — a split part number is worse than a ragged edge; and
    `.annotation--label` clears the shared `max-width`, which on a nowrap label
    could only shrink the box under the text, not wrap it). The 30-line cap is
    a GUARD, not a budget — ~1900 characters, past anything the prompt asks
    for — so an essay cannot bury the circuit it explains; at 12 lines of 42 it
    was a routine ceiling that cut an ordinary note off mid-sentence. A trim
    now marks its last line with an ellipsis, because a caption that simply
    stops reads as one written badly rather than one that was cut. The prompt
    states the length it wants (four to eight sentences) — an unstated budget
    is one the model cannot write to. The same paragraph is handed back on the build
    result, so the panel can say it while the user is still deciding whether
    to place the design. A `title` with no notes still captions the circuit
    with one line; neither gives no caption at all.
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
    `catalog/`. ~4.4 K tokens, over the prompt-cache minimum, so a repair round
    re-reads rather than re-pays. Each pin carries a one-character MARK
    (`pinMark`): `>` an output, `<>` bidirectional, `!` an **active-low output
    enable**. The first exists because "two outputs must not share a net" is a
    rule the compiler ENFORCES, and a bare `n:name` list left the model
    guessing which pins those were. The `!` is the one fact in the catalog
    nothing else reveals — the pins are called `1G`, `OE`, `M`, `N`, with no
    bar anywhere — and getting it wrong is silent: the part floats every
    output it gates, an unwired enable reads HIGH, so a datasheet-correct
    netlist comes up dead.
  - **Tri-state is DECLARED, then PROVED** — `outputEnable: [pins]` on the nine
    parts that have one, plus `tests/chips-tristate.test.js`. It is not derived
    because the catalog expresses tri-state FOUR ways and only one is
    introspectable: a `BUF3` unit ('125, '244), a `COMB` unit returning `Z`
    ('240, '245, '257), a sequential `outputs()` returning `Z` ('173, '533,
    '573, '595), and a memory image. So the test probes the REAL evaluator:
    every declared pin must float an output that drives when it is LOW (which
    also pins the active-low convention), and a behavioural sweep requires any
    part that floats an output to declare one — that sweep is what found the
    **'595**, whose title never says "tri-state". `74LS245`'s `DIR` is
    deliberately NOT an enable (it picks which side drives; only `OE` stops
    both), and the Memory/Interface groups are out of the sweep because a CPU
    or PIA floats its bus on a PROTOCOL and its ports on a direction register,
    neither of which is a pin anyone can tie. **L6** uses the same data: a net
    that floats with a tri-state driver on it reports `OUTPUTS_DISABLED`,
    naming the chip, the pin and "tie it to GND", instead of `NET_NOT_DRIVEN`
    sending a repair round hunting for a wire that was never missing.
  - **The compiler's corpus is the DEMO BENCHES** (`tests/autobuild-corpus.test.js`).
    `scripts/demo-specs.mjs` describes 52 circuits — one per 74xx part in the
    catalog, each proved through the real engine by `make demos` against a
    datasheet truth table — and it is ALREADY coordinate-free (`inputs`,
    `ties`, `links`, `clock`, `leds`), so a forward mapping turns each into a
    netlist spec. Every one is compiled and verified on `make test`, with no
    API key and no network: before this the compiler had ONE real circuit
    holding it honest, and its bugs arrived one paid-for bad build at a time.
    Deliberately a forward map from the SPECS, never a reverse-compile of the
    committed documents — a document's derived netlist includes whatever its
    switches are currently conducting, so reverse-compiling would promote a
    transient switch position into declared topology (which is exactly the
    confusion L4 above used to make). Two exception lists carry what the DSL
    cannot say, each named and argued rather than skipped: the `route` demo
    (a switch that STEERS a signal rather than sourcing it) and the seven
    tri-state parts whose demo hangs an enable on a switch — a spec cannot
    state a switch's RESTING position, and the answer is to tie the enable,
    which the prompt now says and the corpus proves builds clean.
  - **The renderer makes NO network call** — its CSP is `default-src 'self'`
    with no `connect-src`, so the whole outbound path is main's, exactly as
    filesystem I/O is. `ai/client.js` uses Node's global `fetch` — no runtime
    dependency of its own (`electron-updater`, which arrived with auto-update,
    is the only entry in `src/package.json`'s `dependencies`) — with an
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
  Analyzer · Fit · **BOM** · **Schematic** · **AI** — BOM lives here, not with
  the file
  actions, because it toggles a desk panel exactly as Analyzer does, and like
  Analyzer its armed state comes from the panel's own `onVisibilityChange`, so
  the segment tracks the panel however it was closed; the AI builder is the
  same shape for the same reason, and the one segment that is DISABLED when it
  has nothing to offer — no API key, no builder; see the AI note above. The
  **Schematic** segment between them is the odd one: it arms no tool and opens
  no panel, it SWAPS THE VIEWPORT, so its icon shows the view it would take
  you TO — diagram boxes on the desk, a tie-point board on the schematic —
  the way the Fit segment previews zoom-out-full while Shift is held. It is
  `Tab`'s button: both call app.js's one `setMode`, which owns the icon,
  tooltip, and armed state, so a key and a button can never disagree),
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
  A pill segment may carry a **readout** — the Wire button's color dot
  (`components/wire-color-dot.js`), the Bus button's width badge
  (`components/bus-width-badge.js`, `2`–`8`/`16`). A readout SHOWS the active
  option, and **both of today's two are also the PICKER for what they show**
  — clicking one opens a small `PopupManager.popover` (the wire dot the SAME
  eight swatches the wire's Properties dialog offers; the bus badge one
  circled number per `BUS_WIDTHS` preset, in a row, the badge's own glyph at a
  size worth clicking). ONE contract, written once and applied twice, which is
  why each is a module rather than a few lines of app.js — which no test
  mounts:
  - Picking **does not arm the tool**. The segment already arms when its label
    is clicked, so the readout has to be the one place that does not, or there
    would be no way to set the pending option without entering the tool (the
    keyboard paths — 1–8 for either — are themselves gated on the tool being
    armed). Hence its own listener `stopPropagation()`s the toggle.
  - It stays a `<span>` inside the one `<button>` — a nested `<button>` is
    invalid HTML and re-splitting the segment is exactly what the redesign
    removed — and stays `aria-hidden`: an interactive DESCENDANT of a button
    has no honest place in the accessibility tree, so a readout is a pointer
    shortcut to something already reachable another way, never the only way.
  - While the circuit RUNS it has to be taken out by hand: a DISABLED
    `<button>` suppresses its OWN activation but still delivers a click to a
    descendant (measured in the real app, not assumed), so the readout asks
    the button it is in and CSS drops it from the hit test to match.
  - The popover **closes FIRST, then reports** (the order `menu()`/`confirm()`
    use, so a callback that opens something of its own is never QUEUED behind
    it), and closes even when the option picked is the one already active —
    the click answered the question.
  The keyboard path is the same choice met without the pointer: 1–8 set the
  bus width while that tool is armed — `2`–`8` name their own width and `1` is
  the 16-bit bus, since no digit can spell 16 and the widest bus is worth the
  first key (`busWidthForKey` in `model/desk-doc.js` owns that mapping, which
  is why `BUS_WIDTHS` may stay in natural narrowest-first order — the picker
  and the badge both walk it in that order). Either readout sets what the tool
  lays NEXT and nothing already on the desk — a PLACED wire's color is changed
  through its Properties dialog, a placed bus through its own context menu.
  The **parts tray is deliberately NOT in the toolbar**: it
  carries its own chevron in the palette header's top-right corner and its own
  `.palette-flap` — a drawer pull absolutely positioned on the desk's left edge,
  so a shut tray costs zero layout width — with both on the SAME vertical line,
  so the control reads as one thing sliding into the wall. Both, and ⌘P, route
  through app.js's one `togglePalette` (the only thing that persists
  `paletteOpen`); `PalettePanel.setVisible` flips the pair and stamps
  `.app-main--tray-closed`, which insets `.project-tabs` past the flap. Its
  WIDTH is the user's: `.palette-resize` is the analyzer's resize seam stood on
  end (same grip, `ew-resize`, straddling the border so it never covers the
  list's scrollbar), clamped to `[180, half the window]` and persisted as
  `settings.paletteWidth` — reported by the panel, written by app.js, exactly
  as the open flag is. It survives a close/reopen for free, since shutting the
  tray HIDES the panel rather than rebuilding it. The drag runs on
  `pointer-gesture.js` (unlike the two bottom-docked panels, which predate it),
  so the release lands wherever the pointer is let go.
  `.toolbar-btn--active` remains the one class every
  toolbar button's armed state toggles, whatever its shape.
- **Popups/menus**: `popup-manager.js` (ported from Port Hippo) is the only
  app-wide dialog/menu seam; build DOM with `dom.js` `el()`. `PopupManager.close()`
  fires a one-way `chiphippo:popup-closed` event so stateful dialogs can reset
  their open-guard however they were dismissed. Beyond `menu` / `confirm` /
  `prompt` / `notify` / `dialog` there is **`choose`** — the Cancel + N-choices
  shape a "save, discard, or cancel" question needs (the tab delete, the
  leave-a-project guard), where "no" splits into two different answers; its `onChoose` fires
  with `null` for every dismissal, so a caller can never miss one — and
  **`popover`**, `menu`'s positioned, non-dimming host with the caller's OWN
  DOM in the card instead of an items array (the Wire button's color picker).
  The popover card is a plain SURFACE and takes no role of its own: whatever
  goes in brings its own semantics (the color picker is a `role="radiogroup"`),
  and burying that under an unnamed dialog layer would help nobody. For the
  same reason a popover never closes itself when its content is used — that is
  the content's call. Both POSITIONED shapes hand their coordinates to `open()`
  as `place`, and `mount()` clamps the card into the viewport right after
  `showModal()`: a card has to be shown before it can be measured, and a popup
  QUEUED behind another mounts long after its coordinates were named, so
  placing it at request time would clamp a node that is still zero-size.
  `menu`'s
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
  `R` only (`handleKeyDown`), and a damaged chip needs no recovery item at all:
  **Stop** restores every one of them (see the damage note above).
- **Part Properties dialog** (`components/part-properties-dialog.js`): the ONE
  shared modal every part's **Properties…** item opens (enabled only when
  `DeskController.#propertyFieldsFor(comp, def)` returns at least one field).
  A catalog def declares its own editable fields as data (`properties: [{
  key, label, type, options }]`) — the dialog is a pure renderer over that
  list (one `buildControl`/`buildRow` dispatch per `type`) and knows nothing
  about any specific part. Six types today: `"color"` (every colored
  discrete — LED, `seg8cc`/`seg8ca`, `bar8`/`bar8iso` — shares one
  `LED_COLOR_OPTIONS` list of 5 colors and a row of clickable swatches
  reusing the `--color-wire-<name>` tokens; any def with a `colors` list
  arms placement directly with the "Default LED color" setting instead of a
  placement-time swatch popover, per `app.js`'s `onPickChip`), `"select"` (a
  `<select>` over `options: [{value, label}]` — the PSU's volts, the clock/
  oscillator's Hz, the LCD's size; a `<select>`'s value is always a STRING,
  so `buildSelect`'s change handler looks the typed option value back up by
  its stringified match rather than handing the raw string on to
  `normalizeParams`, which compares by `===`), **`"segmented"`** (the SAME
  `options` list shown as one bordered track instead — the shared
  `components/segmented-picker.js` the Settings dialog's own pickers use,
  which is the whole point: a wire's **Layout Method** and the app-wide
  default for it are ONE choice met in two places, so they must not be a
  dropdown here and a segmented picker there. Pick it over `"select"` for a
  short, closed either/or set whose choices should be readable without
  opening anything. It is also the one field whose value is DEFAULTED IN by
  its opener rather than read straight off the record: a direct wire stores no
  `layout`, and a picker still has to show something), and `"action"` (a full-width
  command button, not a value — a memory chip's `"Inspect memory…"` /
  `"Load image… (program)"`, appended by `#propertyFieldsFor` itself rather
  than the catalog, since a ROM's program action is additionally gated on
  `!#editingLocked`; clicking one closes the dialog and calls `onAction(key)`
  instead of `onChange`), `"readonly"` (a value the dialog SHOWS but does
  not edit — the PROJECT's **Location**, which Save As is what changes; it
  takes the stacked full-width row a path needs. A desktop has none: it is not
  a file), and **`"wire-gauge"`** (a PICTURE, not an editor — see the wire-gauge
  note below; it is the one type named after what it draws rather than after a
  kind of control, and deliberately so).
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
- **The wire gauge — a wire's Properties dialog ends with the WIRE**
  (`components/wire-gauge.js`, the dialog's `"wire-gauge"` field, last of the
  wire's fields). The jumper is drawn straight across the full width of the card
  in its own colour, its sleeve stripped back at both ends to the bare tinned
  lead (`--color-chip-leg`, the same token the chips' legs use, because it is the
  same material), with an arrowheaded **dimension line** under it stating the
  length in centimetres. It answers the one question the desk cannot: WHICH LEAD
  OUT OF THE DRAWER IS THIS — on the desk a wire is a curve between two holes at
  whatever zoom the camera is at, so its length is unreadable there, and it is
  exactly what you need before cutting one.
  - **The RUN comes from the desk; the WIRE is the run plus two strips**
    (`wireTotalMm`). A lead does not stop at the surface of the board — it has to
    reach INTO both holes — so a jumper crossing one 2.54 mm pitch is
    2.54 + 2 × `STRIP_MM` ≈ **13 mm** of wire, not 3 mm, and two pitches is
    ≈ 15 mm. The caller therefore hands over the RUN (`runMm`) and the drawing
    adds the strips itself, since `STRIP_MM` is its own constant: both halves then
    agree with each other, because the SLEEVE covers exactly the run (what the
    insulated part of a real jumper spans, hole to hole), the bare tips are the
    strips, and the dimension line spans the lot — the length you cut.
  - **ONE MEASUREMENT, in `model/wire-length.js`** — pure, DOM-free, over a plain
    document, because two things state a wire's length (this drawing and the BOM's
    cutting list) and a second implementation could quietly disagree with the
    picture on the desk. It answers `wireRunMm` (hole to hole) and `wireCutMm`
    (`= wireTotalMm(run)`, the length you cut), and owns `STRIP_MM` and the ONE
    length FORMAT (`wireLengthLabel`, cm to a tenth, locale-formatted — `tf` so it
    reads under `node --test`). The run is the DRAWN shape, never the chord: the
    sagging curve's own ARC length for a direct wire, the polyline through the
    waypoints for a routed one, and for a BUS MEMBER its lead + the whole ribbon +
    its far lead, since a conductor in a ribbon cable is as long as the cable
    however short the ends sticking out are. Which is why a `model/` module reaches
    into `desk/` (the sag constants are px-space, hence `PX_PER_UNIT` → `pxToMm`
    → `MM_PER_UNIT`, the one place the desk's units meet real measure) and why
    `ribbonWidth` moved into `desk/ribbon-path.js` — WireLayer draws the leads
    across that width and this measures them against it, so it can only have one
    home. Live drags are ignored on purpose: a wire is measured as the DOCUMENT
    has it.
  - **TO SCALE, WITHIN REASON.** The drawing is a fixed width whatever the wire
    measures, so the one thing it can be honest about is the RATIO: each
    `STRIP_MM` is drawn as its share of the WHOLE wire, which is why a short hop
    shows generous copper and a long haul a whisker. Two clamps — a bare end never
    falls below `MIN_BARE` (a tip too small to see defeats the reason for drawing
    one) and never takes more than `MAX_BARE_SHARE`, which is DERIVED from the
    shortest wire the app can hold (`STRIP_MM / wireTotalMm(MM_PER_UNIT)`) so it
    can never bind on a real one and exists only to stop a nonsense length drawing
    an all-copper line. The dimension states the truth exactly either way.
  - **The dialog repaints it on a colour pick.** The card applies live and never
    rebuilds its rows, so a `"color"` field changed in the SAME dialog would
    otherwise leave the drawing in the colour it opened in. Repainting is ONE
    custom property (`setWireGaugeColor` → `--wire-color`, the same property every
    wire on the desk and the toolbar's colour dot carry), so the geometry is
    untouched. This is the only thing the dialog knows about the type.
  - **The BOM's `wires` section is the same measurement as a NUMBERED CUTTING
    LIST** (`wireCuttingList`, the fifth `BOM_SECTION_KEYS` entry, last — you wire
    after you seat, as the step groups already order it). One line per COLOUR and
    CUT LENGTH, tallied — "[3] Jumper wire (red, 6.1 cm) ×3" is three leads to cut
    the same, which is how you work through a drawer or a spool, and it is why
    length belongs in the line rather than beside it. Sorted by the app's own
    colour order (what the swatch pickers offer) then shortest first, and NUMBERED
    in that order, so an item number is stable against everything but a change to
    the desk. Being one catalog entry, it reaches the panel AND the RTF export
    with no second list to keep in step, and it needs no netlist — a BOM is a fact
    about the desk, not about connectivity.
  - **THE ITEM NUMBER IS A CROSS-REFERENCE, AND IT REPLACED A WHOLE TAB.** Every
    step that runs a wire calls its number out (`wireItemLabel` → `[3]`, the
    parts-drawing convention, punctuation around a numeral and so not translated):
    in the SENTENCE for a power wire (`plan.step.powerWire`, one wire per step) and
    LEADING each run line of a bus/net step (`wireRunLine`), where the callouts
    form a column you read down while cutting. So the numbering is derived ONCE, in
    `makeContext` (`ctx.wireBom` + `ctx.wireItem`), and handed to both the BOM and
    the steps — two derivations could disagree, and a cross-reference that
    disagrees is worse than none. **The build guide therefore has TWO tabs, BOM ·
    Steps**: the third was *Wiring*, a net-centric list of every connection, and a
    step that names its wire AND says where it goes is that list in the order you
    do it in. The RTF export dropped its Wiring section with it — the export
    mirrors the panel's tabs, so a printed page repeating it is the same
    duplication on paper. `buildWiringList` itself stays: the single-member-net
    WARNING is derived from it.
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
  **HELP** is User Guide ⌘/ · rule · Keyboard Shortcuts ⌘K · rule · Check for
  Updates… (Feature 280) (with About and a second rule ahead of Shortcuts off macOS, where
  there is no app menu to hold it). Check for Updates is the ONE item that
  pushes nothing: it calls `updater.checkForUpdates({manual:true})` in main
  directly, because the result comes back on the `updater:*` channels
  regardless of who asked — so routing it through the window would add a hop
  and a second path to the same status line. It is also the one item that can
  be ABSENT rather than disabled: in a store build there is no updater at all,
  and its separator goes with it, since a menu must not end on a rule.
  `app.js` opens the
  matching PopupManager modal: `components/about-dialog.js` (name/subtitle/desc
  + version info from `app:info:get`) and `components/settings-dialog.js`. The
  **Settings dialog is dumb**: it broadcasts a `chiphippo:settings-changed`
  patch and `app.js`'s `applySettings` both persists it (`settings.set`) and
  applies it live. It is a **tabbed** master-detail card (left nav rail →
  panels). The **Appearance** tab (the first/default tab — there is no
  General) leads with **`theme`** — a **segmented picker**
  (`components/segmented-picker.js`, a DIALOG's form of the toolbar pill:
  one bordered track, borderless `.segmented-option`s, the chosen one filled.
  Shared with the Part Properties dialog's `"segmented"` field exactly as
  `color-swatches.js` is shared with its `"color"` field, which is why the
  class names carry no `settings-` prefix) offering **System / Light / Dark**,
  default `"system"`. It is the ONE setting the renderer does not apply:
  main turns it into Electron's **`nativeTheme.themeSource`**, and everything
  follows from that — every window's `prefers-color-scheme` (so theme.css's
  light palette reaches the main window AND every auxiliary window with no
  per-window plumbing and no flash), the native menus/dialogs, and each new
  `BrowserWindow`'s pre-paint `backgroundColor` (`windowBackground()`). The
  `:root[data-theme]` blocks in theme.css stay as a manual override only.
  The tab also drives **`selectionColor`** (`#rrggbb` or null → sets
  the `--color-selection` custom property that `.board-outline-path` strokes
  with, falling back to `--color-accent`), and **`defaultLedColor`** (one of
  `catalog/parts.js`'s `LED_COLOR_OPTIONS`, default `"red"` — the color any
  newly placed colored discrete (LED, `seg8cc`/`seg8ca`, `bar8`/`bar8iso`)
  gets; not a live-apply setting, only read at placement time by `app.js`'s
  `onPickChip`), and **`defaultWireLayout`** (a second segmented picker —
  Direct / Routed, default `"direct"` — the layout a newly LAID wire gets;
  the same not-live-apply rule as the LED colour, so `applySettings` only
  keeps `DeskController.setDefaultWireLayout` current and the wire tool reads
  it when it commits. A wire's OWN Layout Method is the same control again,
  through the Properties dialog's `"segmented"` field, so the two places this
  choice is met look and behave alike). The **Data Sheets** tab drives
  **`datasheetDir`** (the external datasheet-PDF folder, default null) — its
  Browse button calls the native `settings.chooseDatasheetDir` picker and
  emits the chosen path; no live apply
  (the pinout window reads it at open time). Beside it, **Download…** FILLS
  that folder from the web (see the datasheet-download note below), and both
  end in the same one-line patch — the setting is a path either way, and
  nothing downstream knows which button produced it. The **AI** tab drives the
  NON-SECRET half of the user's connection (`ai: {provider, baseUrl, model}`,
  emitted WHOLE as an object-valued setting) and is the one panel built
  asynchronously — its picker comes from `ai:providers`, so it cannot drift
  from `app/ai/providers.js`. Its API-key field is the ONE control in the
  dialog that bypasses `#emit` entirely, calling `ai.key.set` directly; see
  the AI-circuit-builder note above for why. The **About** tab (Feature 280) is the
  auto-updater's UI and the one panel with LIVE state (see the auto-update
  note below): the version from `app:info:get`, **`autoUpdateCheck`** as a
  third segmented picker (On/Off, default Off), a Check button, and a status
  line fed by the `chiphippo:updater-*` broadcasts — whose listeners belong to
  the dialog's OPEN lifetime, so `buildAboutPanel` hands back a `dispose` that
  `onClose` runs. Window bounds and the desk camera
  (incl. **zoom**) are already persisted in `settings.json` (`windowBounds` via
  `window-state.js`; `viewport` via the renderer's debounced save).
  One CSS rule the whole card depends on: a settings element that sets a
  `display` of its own must be listed in the shared **`[hidden]`** rule beside
  `.settings-panel`, because a class selector outranks the UA sheet's
  `[hidden] { display: none }` — without it `el.hidden = true` sets an
  attribute that changes nothing, which is exactly how Data Sheets came to
  offer a **Clear** button with no folder to clear.
- **Pin-assignments window** (Feature 100): **Pin Assignment**, the item
  leading every part's context menu (`DeskController.#onPartContextMenu` →
  `#onOpenPinout(ref, rows, rot)` — offered even while the circuit runs; the
  pin map itself is read-only, though the **example-circuit button** below is
  not: it adds a desktop, which stops the run exactly as switching tabs does),
  invokes `pinout:open`, and main opens a **separate floating
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
  present. Beside it sits the **example-circuit button** (`exampleButton`,
  shown when main flags `?demo=1`) — see "Example circuits" below. The two
  buttons are one box with two glyphs (`.pinout-header-btn`, one CSS rule), and
  they are the only two reasons the otherwise bridge-free pinout window loads
  `preload.js`.
- **Downloading the datasheets** (`app/datasheets/sources.js` +
  `app/datasheets/download.js` + `components/datasheet-download-dialog.js`):
  Settings ▸ Data Sheets ▸ **Download…** FILLS the folder the tab points at,
  so the external-PDF button above works with nothing for the user to find or
  name. **THE RENDERER NAMES NO URL AND NO PATH.** It asks for "the
  datasheets" and is told where they landed; the ref → URL table is
  hard-coded in MAIN, which is the same rule that puts every path decision
  there — a download button must not become a way to make the app fetch
  something arbitrary. The table is **hand-written, never derived**: a part id
  is not a file name anywhere in the world (the '86 is `sn74ls86a.pdf`, the
  '139 lives inside the '138's file, WDC ships the '02 as `w65c02s.pdf`), so
  guessing a vendor's naming buys a silent 404 per part. It is **ONE BLOCK PER
  LIBRARY**, each owning its own `base` with its parts' paths RELATIVE to it,
  and that is the whole extensibility story: a part whose datasheet lives on
  another host is a line in a new block (TI, Microchip and Western Design
  Center for the parts their makers still publish, USC's course library for
  the older scans), never a special case in the downloader. Nothing about a
  vendor's naming is patterned either, and BOTH ways it can bite are already
  in the table: TI files a sheet under the DEVICE it was written around, so
  the revision suffix is part of the name ('73A, '107A, '257B) and the '01
  lives under its 54-series sibling; Microchip's `docNNNN` numbers say nothing
  at all about the part, and several exist per part (doc0258 is the '16-T,
  TSOP-only, against doc0540's mainline '16 with the DIP-24 this catalog
  actually seats). A source is therefore VERIFIED — opened, and its part
  number and package read (by RENDERING page 1 where the file is a scan with
  no extractable text, which is how the '83 was confirmed as Motorola's
  SN54/74LS83A and not the '283 that replaced it) — before it is written down,
  and its host is chosen
  for one that ANSWERS A PROGRAM rather than only a browser: distributor
  mirrors and some vendor front-ends sit behind bot protection and return a
  403, or an HTML challenge with status 200, so `ww1.microchip.com` is used
  and not the `www…/content/dam/…` path the site itself links. Every block is
  a MANUFACTURER's own file server bar one — the '83's, an archive, because
  Motorola's TTL line went to a host that serves HTML and TI documents only
  the '283; an archive link is the one expected to rot, which the run reports
  by name rather than hiding and which costs one part, not the download. The
  one entry
  whose KEY is not its part number is `AS6C1024`, which is the catalog's name
  for a chip Alliance Memory call the AS6C1008 (their `/as6c1024/` is a 404
  falling through to the home page); the sheet is right, the catalog id is
  the thing that is off, and a ref is stamped into saved documents so
  correcting it is a migration rather than a rename. The
  escape check is therefore PER ENTRY, against the
  library it was declared in — `base` rides along on every flattened source —
  since there is no single base left to compare against, and an absolute URL
  pasted into a `parts` block is exactly what that check is for. It is
  **deliberately partial**: a part with no entry is simply not downloaded.
  `tests/datasheet-sources.test.js` holds every KEY against the real catalog
  (imported, not copied) because a ref typo is invisible — the PDF downloads
  fine under a name the `<ref>.pdf` lookup will never ask for — and it holds
  each library to an `https://…/` base (a base with no trailing slash makes
  `new URL` drop its last segment, turning every part in the block into a 404
  that reads like the vendor moved their files) and forbids two blocks
  claiming one part (the flatten would silently keep the later copy). The
  destination is the app's OWN `userData/datasheets/` (a sibling of
  `memory/`), never a folder the user picked — the run REPLACES what it finds,
  and a button that overwrites files may only ever be aimed at a directory the
  app made; Browse… and Download… then end in the same one-line
  `{ datasheetDir }` patch, which is the only thing either leaves behind.
  Fetching is **sequential** (the whole point is the `n/TOTAL` count, and a
  counter that jumps is worse than one that takes longer) and every body is
  checked for the `%PDF` magic before it is written, because a host that
  answers a missing file with a friendly HTML page and status 200 would
  otherwise land `74LS00.pdf` as something that opens as garbage. Progress is
  a one-way `datasheet:progress` push (→ `chiphippo:datasheet-progress`),
  separate from the `datasheet:download` invoke that resolves with the
  summary, exactly as `ai:delta` is separate from `ai:start`. The dialog
  REPLACES the Settings card rather than sitting on it (PopupManager QUEUES a
  second popup rather than stacking it, so the caller closes Settings first),
  DISMISSING IT CANCELS (it is the run's only user interface), and it NAMES
  the parts that failed — "38 of 41" without saying which three leaves the
  user to diff a folder by hand.
- **Example circuits** (Feature 270): every benchable 74xx part's demonstration
  bench, shipped INSIDE the app as `src/web/demos/<ref>.json` and offered as a
  button on that part's pin-assignments window. **One build, two outputs**:
  `make-gate-demos.mjs` writes each desktop into its group project
  (`demos/<Group>.chiphippo`) AND on its own into `src/web/demos/`, from the
  SAME `buildDemo(spec)` call — so the copies cannot drift, and
  `gate-demos.test.js` holds them to byte-for-byte agreement. Minified (nobody
  reads that one) and pre-**CENTRED** on the origin by `demo-build.mjs`'s
  `centreDocument`, which is load-bearing rather than tidy: `fitToScreen`
  RECENTRES as well as frames, so an uncentred example would put a "recentre
  desk" undo step at the top of a brand-new desk's history and the user's first
  ⌘Z would slide the circuit off-centre. Centred, the fit finds a zero delta,
  returns before `#emitDocChanged`, and is pure camera. The directory is
  **SWEPT** every run: a chip dropped from the catalog must not leave a
  document behind that still puts a button on a pinout window. Per-chip rather
  than per-group because it makes "does this part have an example?" an
  `fs.existsSync` — main answers it with no catalog knowledge and no JSON
  parse, so its document knowledge stays the two narrow places it already was.
  **TWO channels, because there are two windows and only one can use the
  bytes**: a PINOUT window has a ref and nothing else, so it asks (`demo:open`)
  and main RELAYS `demo:host-inbound` to the app window (the memory
  inspector's host pipe, one step simpler) after raising it — the window is
  `alwaysOnTop`, so an unraised desk would land behind the click; the APP
  window then READS the document (`demo:read`) itself, so it crosses the bridge
  once, into the window that will hold it. `ProjectWorkspace.openExample(ref)`
  is `importTab` with the file picker swapped for that read: an ADDITION,
  reseated through `desktop.duplicate` (no shipped example carries a ROM today,
  but "two chips can never share a guid" must not have a door in it), landing
  as `<ref> example`. Asking twice **switches** to the desktop already holding
  it rather than copying it — the tab NAME is the whole identity test, which is
  also its cost: rename it and the next ask brings a fresh one, the honest
  answer since the v4 schema keeps no per-tab marker a rename could not erase.
  An in-flight map keyed by ref makes a double-click ONE desktop (the name
  check and the insert are separated by awaits, which is exactly where a
  duplicate gets in). The answer is three-valued (`"added"`/`"switched"`/null)
  because `app.js` frames it with `fitActiveView` — framing a brand-new desk is
  help, re-framing one the user has arranged is interference. Memory/Interface
  chips get no example and therefore no button: a RAM or a CPU cannot be
  demonstrated by flipping switches at it, and the 65xx demos are excluded for
  a sharper reason still — their program lives in a separate `.hex`, so the
  document alone would arrive not working.
- **Auto-update, and the store gate** (Feature 280 — `app/updater.js` +
  `app/store-build.js` + `components/updater-monitor.js` + Settings ▸ About).
  A thin wrapper over
  `electron-updater`'s `autoUpdater`, pointed at the GitHub Releases feed the
  Release workflow ALREADY publishes — `latest*.yml` has been uploaded beside
  every installer since the workflow was written, so nothing about releasing
  changed to turn this on. **NOTHING RESTARTS WITHOUT CONSENT**: an update
  downloads in the background and installs on a normal quit
  (`autoInstallOnAppQuit`) or through a clicked `quitAndInstall()` — which
  still runs main's ordinary before-quit guard, so an unsaved project is asked
  about first, and a cancelled quit simply leaves the update for next time.
  - **The updater ANSWERS; it does not decide what to say.** Every lifecycle
    event is a one-way `updater:*` push the preload re-dispatches as
    `chiphippo:updater-*`, and the renderer owns every word: `UpdaterMonitor`
    (the always-on toasts, session-long, one shared toast key so the stages of
    one update replace each other rather than stacking) and the About panel's
    inline status line (dialog-lifetime, hence its `dispose`). Each push
    carries **`manual`** — main's record of whether a human pressed the button
    — because the difference between "you're up to date" and silence is
    entirely whether it answers a question that was asked. A `reason`
    (`"store-build"` / `"dev-build"`) rides on not-available, so a build that
    CANNOT update reports a fact rather than an error. `download-progress` is
    deliberately never forwarded: there is no progress bar to feed.
  - **A store build is gated at RUNTIME, never by branching the build**
    (`store-build.js`, the only place that reads Electron's `process.mas` /
    `process.windowsStore`). The Mac App Store updates its own apps,
    electron-builder strips the feed from a MAS package, and the sandbox
    forbids an app replacing itself — so `checkForUpdates` short-circuits, the
    Help item is absent rather than disabled, and About hides its controls and
    says why. The renderer learns this from **`app:info:get`'s
    `distribution`** rather than a bridge flag of its own: main is the side
    where `process.mas` is unambiguous, and the panel already awaits that
    object before it draws anything.
  - **The check is OPT-IN** (`autoUpdateCheck`, default false) — an outbound
    call, and Chip Hippo makes none unasked. Off still leaves both manual
    routes working; on adds one delayed check ~10 s after launch, off the busy
    launch path. `require("electron-updater")` is deliberately LAZY (inside
    the functions, not at module scope): reading the getter constructs the
    platform updater, which dereferences Electron's native `autoUpdater` —
    absent under `node --test`, where `main.js` is read but never run.

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
make test-i18n # Just the language guards (catalog completeness + string leaks)
make icons     # Regenerate app-icon rasters from the SVG sources (see below)
make datasheets # Regenerate the pinout-window datasheet crops (see below)
make demos     # Regenerate + engine-validate demos/ AND src/web/demos/ (see below)
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
  MOVE stream only — never the sole delivery route for the RELEASE. **EVERY
  direct-manipulation desk drag** goes through
  **`components/pointer-gesture.js`** (`beginPointerGesture` → one teardown) —
  the wire/bus/palette gestures, and the seven DeskController owns (board,
  part, brick, resistor body, resistor end, annotation, marquee):
  `pointerup`/`pointercancel` listen on
  `window` in the CAPTURE phase, so a release reaches the gesture whether or not
  the capture held, and `lostpointercapture` + window `blur` end it too (the only
  signals for "this pointer isn't yours" with no up/cancel behind them). A drop
  is resolved from the RELEASE event's own position (`releaseWorld`), never from
  the last `pointermove` — coalesced moves lag the cursor, and a stale sample
  used to silently lose the drop. `.desk-viewport` sets `touch-action: none` so
  the browser can't claim a gesture mid-drag and cancel it.
  **The re-resolve is one function per drag, shared by the move and the
  release** (`#resolveBoardDrag` / `#resolvePartSeat` / `#resolveBrickPos` /
  `#resolveAnnotationPos` / `#marqueeRect`, and the two resistor trackers,
  which take the drag as a defaulted argument because the up-handler clears
  `#mode` before re-resolving) — so the preview and the drop can never
  disagree. The part drag is why this matters most: its move handler leaves
  `d.legal` false for an off-board sample while KEEPING `d.seat`, so before
  this a fast release silently reverted a legal reseat. Because the listeners
  now outlive the dragged element, **`#rebuildScene` cancels any live gesture
  first** — undo/redo or a tab switch mid-drag would otherwise leave a release
  to commit against unmounted views. `tests/desk-drag-release.test.js` holds
  all seven to the three cases the old shape could not survive (release point
  ≠ last move, release off the dragged element, yanked capture).
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

## Language support

The app speaks **English, German, Spanish, French, Italian, Japanese and
Chinese (Simplified)**, chosen in Settings ▸ Appearance ▸ **Language** (or left
on *System*). One JSON catalog per language under **`src/web/locales/`**, and
`en.json` is the REFERENCE: every other file must cover its leaf keys exactly.

- **MAIN RESOLVES THE LOCALE FOR THE WHOLE APP** (`app/i18n.js`). It owns the
  filesystem the catalogs live on and the OS locale they default from, and every
  window is `file://` under a CSP with no `connect-src` — so a renderer cannot
  read or fetch a catalog, and this is the only route one can travel. The order
  is `settings.locale` (unless `"system"`) → `app.getLocale()` → English, and a
  language with no shipped catalog falls back to English rather than failing.
  `readCatalog` validates the subtag against `^[a-z]{2,3}$` before it touches a
  path, which is what stops a crafted locale escaping the locales directory.
  Each renderer asks ONCE over **`i18n:load`**, whose payload is `{active, lang,
  messages, fallback, locales}` — the English catalog always rides along as the
  fallback, and the shipped-language LIST rides along too (from the same
  `LOCALES` table the reader resolves against) so the Settings picker can be
  built synchronously and can never offer a language with nothing behind it.
- **The renderer's seam is `t()`** (`web/scripts/i18n.js`): dotted keys against
  the nested catalog, `{name}` interpolation, CLDR plurals through
  `Intl.PluralRules` when a numeric `count` is passed, and the resolution chain
  active → English → **the key itself**, so a missing string is visible rather
  than blank. `app.js` awaits `i18n.init()` **before anything renders**; so do
  `pinout.js` and `memory.js`, each its own sandboxed renderer, with a top-level
  `await`. **NEVER call `t()` at module scope** — the catalog is not loaded yet,
  and a top-level call freezes the English key into a module constant. That is
  why every options list that used to be a `const` (`THEME_OPTIONS`,
  `SHORTCUT_GROUPS`, …) is now a function.
- **`tf(key, fallback)` is `t()` for a string whose English lives somewhere
  else.** The parts CATALOG is pure data evaluated at import time, so its
  `title`/`label` fields cannot be `t()` calls — and they are not only UI text
  either (the BOM export, `scripts/demo-specs.mjs` and the catalog's own
  integrity tests read them under Node). So the English stays there as the DATA,
  the translations live under `parts.*` / `boards.*`, and **`catalog/labels.js`**
  is the one place that resolves them (`partTitle`, `kitLabel`) — falling back to
  the def's own English rather than to a raw key, so a part added without an
  entry reads correctly, just untranslated. `model/wire-colors.js` is the same
  shape for the eight stored colour TOKENS (`wireColorName` /
  `wireColorLabel`) — the token is what a document stores and what CSS suffixes,
  and only the word shown is translated.
- **MAIN RENDERS TEXT ITSELF in three places no `t()` can reach** — the
  application menu, each auxiliary window's title bar, and the native dialogs'
  file-type filter names — so it keeps the resolved catalog to hand and reads
  those through **`m(key, fallback)`**. The payload is cached (the menu is
  rebuilt on every recent-list change, ~30 labels a time) and `settings:set`
  drops the cache when `locale` moves, which is what makes a language change
  reach the menu bar with no restart. **`--hot-reload` drops it too, when the
  changed file is under `locales/`** — that cache is process-lifetime, so a
  window reload alone re-asked `i18n:load` and got the catalog read at LAUNCH:
  a string added mid-session rendered as its raw dotted key however many times
  the renderer reloaded, which reads like a bug in the code that asked for it
  rather than like stale state. Cut/Copy/Paste stay native ROLES:
  Electron supplies the OS's own word for each, which beats anything this
  catalog could say. `PROJECT_FILTERS`/`DESKTOP_FILTERS` became FUNCTIONS for
  this — a `const` is evaluated at require time, long before `app` is ready.
- **A LANGUAGE CHANGE IS APPLIED IN PLACE, because nothing here reloads the
  window** (an unsaved project lives only in memory; a reload to change a label
  would throw the user's work away). `app.js`'s **`relabelChrome`** re-applies
  the header, both pills, the transport and the window title, and calls
  `relocalize()` on the palette, the tab strip, the build guide, the analyzer,
  the AI panel, the zoom cluster and the schematic. Only PERSISTENT chrome needs
  it: every dialog, context menu, popover and notification is built when it
  opens and therefore speaks the current language for free. Three of the calls
  are relabel functions the app already had for their own reasons — `setMode`,
  `updateLocateIcon`, `onTransportChange` each own a button whose label depends
  on state, so re-running them unchanged IS a relabel.
- **IDENTITY IS NEVER TRANSLATED.** A palette section's English name stays its
  collapse-state key and its grouping key (`sectionLabel()` shows the
  translation; `#toggleGroup` is still called with the English), or a section
  would forget whether it was open the moment the language changed. A BOM line's
  tally key is built from stored tokens, so a language change can never split or
  merge a row — a WIRE line's is its colour token plus whole MILLIMETRES, which is
  also exactly the precision shown, so two wires that display the same length
  cannot land on different rows (or vice versa). Feature 270's `<ref> example` tab name is the example's whole
  identity test, so it stays English. `Desktop N` IS translated — it is a
  default NAME, data from the moment it is created, like any name the user types.
- **WHAT IS DELIBERATELY ENGLISH**, each because it is reference material or
  protocol rather than the application's own words:
  - the **user guide** — one Markdown source drives the in-app viewer, the
    website and the PDF, so `docs-viewer.js`'s chrome stays English to match the
    pages it lists (Settings says so: "The user guide is only available in
    English");
  - a part's **`blurb`** and the pinout window's per-pin **`detail`** text and
    `ROLE_TAG` abbreviations — datasheet prose about the part, which sits with
    the guide on the reference side of the line. The rule is statable: *short
    names and labels are translated; per-pin and per-part datasheet descriptions
    are not.* `partBlurb()` exists anyway so that decision has exactly one place
    to be revisited;
  - the **AI ladder's fault messages** (`autobuild.js`, `autobuild-verify.js`,
    `generate.js`) — `buildRepairMessage` sends them BACK TO THE MODEL as the
    repair instruction, and the system prompt and catalog card they answer are
    English by construction. Translating them would degrade the repair round;
    the panel shows each beside a fault CODE, which is what the user acts on.
    The ladder's own progress labels are localized (`ai.gate.*`);
  - the product name, the copyright line, format names (SVG/PNG/Intel HEX),
    "ASCII", and every keyboard glyph (⌘, Tab, Esc, W) — the modifier already
    varies by PLATFORM, never by locale.

### The guards (`make test-i18n`, and part of `make test`)

Five tests, and the point of them is that an i18n regression is otherwise
**invisible**: `t()` falls back to English, so a missing translation looks like
a proper noun, and a hardcoded literal looks like a translation that happens to
match.

- **`web/scripts/tests/i18n-catalogs.test.js` — the untranslated-string
  guard.** Holds every locale to `en.json` in the four ways a translation
  silently goes wrong (a **missing key**; a **lost `{placeholder}`**, which
  renders as a gap; a **broken plural** shape; an **empty value**, which renders
  as nothing) and the three ways the CODE drifts from the catalog: **a key the
  source asks for that does not exist** (`t("zoom.out")` renders the text
  `zoom.out` — a real bug this caught on its first run), **a `tf()` FALLBACK whose
  `{placeholders}` differ from its own en.json entry's**, and **a catalog part,
  board kit, group or colour token with no entry**. Coverage must be EXACT in
  both directions: an extra key is a rename left behind, i.e. a translation
  nothing will ever read. The fallback check is the subtle one and it earned its
  place the same way the first did: `tf()` PREFERS the catalog, so adding a
  placeholder to the fallback and forgetting the catalog silently drops the value
  at runtime — the sentence still reads, it is just missing the thing it was added
  to say (a wire step shipped without the BOM item number it exists to quote). The
  locale-parity check cannot see it, because en.json was the stale one.
- **`web/scripts/tests/no-hardcoded-strings.test.js`** — the complement: a
  display literal that never entered the catalog at all. It scans for the
  assignment forms (`textContent`, `title`, `placeholder`, `setAttribute`) and,
  most valuably, the **UI-bearing object properties** (`label:`, `message:`,
  `confirmLabel:`, …) that are how `el()` and every PopupManager dialog RECEIVE
  their text. It is a ratchet over `no-hardcoded-strings.baseline.json` — which
  **is currently empty**, so there is no debt to shrink; regenerate with
  `UPDATE_HARDCODED_BASELINE=1`. Every exclusion in `SKIP_FILES` /`INTENTIONAL`
  carries its reason in place, because an exclusion is a stated decision and not
  somewhere to put an inconvenience.
- **`app/tests/no-hardcoded-native-strings.test.js`** — the same for main, whose
  strings the renderer scanner cannot see. A localized call reads
  `label: m("menu.file.new", "New Project")`, so its English sits as the
  FALLBACK ARGUMENT, invisible to the rules; drop the `m()` wrapper and the
  literal lands right after the key again and this fails. Its second half is the
  converse — that the menu really is built from ~30 `m()` calls and that every
  key exists, since a wrong key silently makes the fallback the only thing
  anybody ever sees.
- **`app/tests/i18n.test.js`** (the resolution order + path safety) and
  **`web/scripts/tests/i18n.test.js`** (the `t()`/`tf()`/plural/format contract).

`tests/jsdom-setup.js` installs the REAL `locales/en.json` for every component
test, so the existing English assertions both keep working and start exercising
the catalog: a key deleted from `en.json` now fails the test that reads it,
rather than quietly rendering a dotted key to the user.

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
