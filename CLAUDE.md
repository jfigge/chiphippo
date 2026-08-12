# Chip Hippo — Project Guide for Claude

## What This Is

**Chip Hippo** is a cross-platform desktop app for designing and simulating **74xx TTL
logic circuits on virtual breadboards**. The main window is an infinitely pannable,
zoomable **desk**: the user places solderless breadboards (Full 830 / Half 400 / Tiny
170 tie points), populates them with 74xx DIP chips, wires, switches, LEDs and power
sources (3 V / 5 V / 12 V), and a **simulation engine** traces electricity from the
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
drags · language support.

**Deferred** (`features/deferred/`): 160 export image & PDF, 300 selection drags.
**Still open**: 260 step 15 — refactor `make demos` onto `model/autobuild.js` (which
now has `centreDocument` and a second output to honour).

## Naming & identity

- Product **Chip Hippo**; npm package `chiphippo`; Electron `appId` `com.chiphippo.app`;
  repo `github.com/jfigge/chiphippo`.
- IPC bridge object **`window.chiphippo`**; renderer events prefixed **`chiphippo:`**.
- Icon source `src/web/chiphippo-icon.svg`; download domain **chiphippo.com** (via
  `website/CNAME`), falling back to the `*.github.io` Pages URL until DNS is configured.

## App icons

`make icons` regenerates every raster from two committed SVGs: `chiphippo-icon.svg`
(edge-to-edge → Windows `.ico`, the Linux `icons/` set, `chiphippo-logo.png`) and
`chiphippo-mac-icon.svg` — the same art inside the macOS **safe area** (rounded square
at ~80% of the canvas, transparent border on every side, so the dock renders it at
native visual weight) → `chiphippo-mac-icon.png` (electron-builder `mac`/`mas` icon +
the runtime dock icon). `scripts/make-icons.mjs` runs **under Electron**
(`npx electron …`), rasterising via `<canvas>` + `toDataURL` — **never `qlmanage`**,
which flattens SVG transparency onto WHITE. `main.js` sets both the BrowserWindow
`icon` and (darwin) `app.dock.setIcon`. All rasters are committed.

## Datasheet crops

The pin-assignments window shows a part's manufacturer datasheet region as a committed
PNG under **`src/web/datasheets/<name>.png`**. **The crops are cut by hand** — a
generator existed and never cropped well enough to ship (vendors lay pages out
differently, some diagrams sit on page 2 or behind a cover); the source PDFs are not in
the repo, only the cropped PNGs.

- **A crop is named by the CATALOG, not by the id** — `catalog/index.js`'s
  **`datasheetCrop(def)`** is the one place that rule lives. A DIP part's sheet IS its
  id; anything else must NAME its sheet with a **`datasheet`** field (most discretes
  have no datasheet at all, and both character-LCD modules share one controller sheet,
  `HD44780.png`). The `<figure>` lives in the shared `pinoutShell`, so a module can show
  a sheet without being a chip, and it REMOVES ITSELF on load error (a def may name a
  file that isn't there). Main sizes the window from the same file and has no catalog,
  so the renderer passes the name as `sheet` in `pinout:open`'s opts, validated like a
  ref.
- **The caption splits on `def.package`** — `pinout.datasheetCaption` (a chip: a REGION
  of a datasheet page, "internal diagram & function table") vs
  `pinout.datasheetCaptionModule` (a whole connection drawing, no table). Keyed on the
  package, deliberately not on which of the two named the file. The `alt` is that
  sentence after the id via a template literal — which the i18n scanner cannot see, and
  is why it is not a second hand-written English string.
- **`make datasheets` REPORTS, it does not generate** (`scripts/check-datasheets.mjs`,
  plain Node — no PDFs, no Electron, no network, writes nothing). A part with no crop is
  invisible (the window just shows a pin map), so it walks the catalog through
  `datasheetCrop`, names **missing** crops to cut and **orphaned** PNGs no part asks for,
  and `--strict` exits 1 on a missing one. Its one hand-kept list is `NO_DATASHEET` —
  the four chips with no matching `74LS*` sheet (74LS164, 74LS193, 74LS27, 74LS76) —
  and moving a name in or out of it is how a part leaves or rejoins the to-do list.

## User guide & docs

**One Markdown source drives three outputs that can never diverge**: `src/web/docs/*.md`
(+ committed `images/*.png`) feeds the in-app viewer (Help ▸ *Chip Hippo User Guide*,
`⌘/`), the hosted website (`make docs` → `website/docs/`) and a PDF (`make pdf` →
`docs/chip-hippo-user-guide.pdf`).

- The page index (`PAGES` — slug, optional `file`, title) is **hand-duplicated** between
  `web/scripts/components/docs-viewer.js` and `scripts/build-docs.mjs`; keep the two in
  sync when adding a page (a missing entry is a page that visibly doesn't appear).
- **The heading-id rule is NOT duplicated** — `web/scripts/heading-slug.js` is imported
  by both (dependency-free ESM; `src/web/scripts` is `{"type":"module"}`, so Node imports
  it by path exactly as the browser loads it). It was two copies and they DID disagree,
  invisibly, until a heading contained punctuation. **GitHub's rule wins** (the same
  `.md` is read on GitHub): lowercase, trim, drop all but word chars / whitespace /
  hyphen, each whitespace char → one hyphen, **consecutive hyphens never collapsed**.
  `tests/heading-slug.test.js` pins it, sweeps every `#fragment` in the guide against the
  real headings, and ratchets against a third copy appearing.
- **In-app**: `web/docs.html` + `scripts/docs-window.js` mount `DocsViewer` into a
  non-modal floating window (`openDocsWindow()`), a true singleton that carries no
  document state — so `closeAuxWindows()` on New/Open does NOT close it. It reads raw
  Markdown over **`window.chiphippo.docs.read(slug)`** (never `fetch()`, so it works
  under `file://`) through the one shared `preload.js`; the `docs:read` handler
  slug-validates `^[a-zA-Z0-9-]+$` AND path-contains the resolved file inside
  `src/web/docs/`. Rendering goes through `web/scripts/vendor/markdown.js` (marked +
  DOMPurify bundled by esbuild from `vendor/markdown-entry.js` — `make vendor-markdown`;
  the whole `vendor/` tree is exempt from the license-header guard and ESLint). Links are
  forced `target="_blank"` so main's `setWindowOpenHandler` opens the system browser;
  `images/x.png` is rewritten to `docs/images/x.png`; GitHub-style heading ids are
  stamped; a monotonic load token stops a slow page clobbering a newer one.
- **Website**: `scripts/build-docs.mjs` renders the same Markdown through `marked` under
  Node (no DOMPurify — first-party content) into themed static HTML (`STYLE`/`LOGO_SVG`
  in the file, the green `--accent:#3fb950` tokens matching `website/index.html`) under
  `website/docs/` plus `website/sitemap.xml`, and copies `images/`. It resolves `marked`
  **by file path** (`src/node_modules/marked/…`, or `MARKED_DIR`) since it is ESM-only
  and bare specifiers ignore `NODE_PATH`. `website/index.html` carries Guide nav +
  footer links.
- **PDF**: `scripts/build-pdf.mjs` **imports `PAGES`/`SRC`/`renderBody`/`LOGO_SVG` from
  `build-docs.mjs`** (real reuse, so it can't drift), stitches cover + TOC + one section
  per page, absolutizes `images/` to `file://`, and prints via a hidden **Electron**
  window's `printToPDF` — hence `cd src && npx electron ../scripts/build-pdf.mjs`, never
  plain Node. It awaits `document.fonts.ready` and every `<img>` before printing
  (`loadFile` resolves before images necessarily have). `PDF_OUT` overrides the output
  path (default committed at `docs/`).
- **Screenshots**: the committed PNGs under `src/web/docs/images/` are captured by
  driving a separately-launched `make debug`-equivalent Electron over the Chrome DevTools
  Protocol (`--remote-debugging-port`, raw `ws`, `Page.captureScreenshot`). That capture
  tooling is local and **not committed**; only the PNGs are.

## Source layout

- **`src/app/`** — Electron **main** (Node, CommonJS): window lifecycle, IPC, and ALL
  native I/O. `main.js` (windows + lifecycle + `ipcMain`), `preload.js` (the
  `window.chiphippo` bridge), `window-state.js` (bounds restore with display-fit check),
  `close-guard.js` (the close/quit state machine, pure so it is testable), `i18n.js`,
  `updater.js`, `store-build.js`, plus:
  - `store/` — `io.js` (atomic writes), `settings-store.js`, `project-store.js` +
    `project-images.js` + `project-migrate.js`, `desk-store.js` + `migrations.js` (desk
    schema migrations + the by-PATH reader `project-migrate.js` uses), `mem-store.js`,
    `credential-store.js` (`safeStorage` API key), `bookmark-store.js` (security-scoped
    bookmarks for MAS), `recent-files.js` (pure list arithmetic).
  - `ai/` (`providers.js` + `client.js`), `datasheets/` (`sources.js` + `download.js`),
    `updater.js` — **the app's only three outbound network calls**, all in main (the
    renderer's CSP forbids one), all the same shape (a hard-coded statement of where
    they may go beside the thing that goes there), and all **opt-in**, so an
    unconfigured Chip Hippo never reaches the network at all.
- **`src/web/`** — **renderer** (ES modules + plain CSS), sandboxed, talking to main only
  through `window.chiphippo.*`. `index.html` → `scripts/app.js`.
  - `scripts/desk/` — pure geometry: `desk-geometry.js` (camera), `wire-path.js` (sag +
    polyline), `ribbon-path.js`, `rect-outline.js` (union-boundary math).
  - `scripts/model/` — pure document logic: `breadboard.js` + `board-types.js`,
    `desk-doc.js`, `footprints.js`, `occupancy.js`, `mating.js`, `seating.js`,
    `part-geometry.js`, `part-move.js` + `cluster-move.js`, `design-clip.js`,
    `paste-cluster.js`, `project-doc.js`, `schematic-layout.js`, `hex-format.js`,
    `wire-length.js`, `wire-colors.js`, `wire-crossing.js`, `selection-toggle.js`,
    `pin-resolve.js`, `column-allocator.js`, `autobuild.js`, `autobuild-verify.js`.
  - `scripts/sim/` — the DOM-free engine: `union-find.js`, `netlist.js`, `levels.js`,
    `chip-eval.js`, `sequential.js`, `resolve.js`, `engine.js`, `junction.js`,
    `w65c02.js`, `z80.js`, `z80-ops.js`.
  - `scripts/ai/` — `catalog-brief.js`, `generate.js`, `connection.js`, `usage.js`
    (pure).
  - `scripts/catalog/` — part metadata as pure data + integrity tests; never
    part-specific code paths. `index.js`, `parts.js`, `chips-*.js` (`chips-seq.js`,
    `chips-io.js`, `chips-cpu.js`, …), `symbols.js`, `labels.js`.
  - `scripts/components/` — thin views. `DeskController` keeps the public surface but
    delegates to `sim-overlay.js` (live LED/badge/clock faces from
    `chiphippo:sim-state`), `probe-inspector.js` (shortcut `I` — its own netlist cache,
    the `NetHighlight` overlay, the net-summary readout), `wire-tools.js` (the wire tool,
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
- **Every path crossing the bridge is gated by main's `knownPath`**: anything inside the
  app's saves folder, plus what a dialog (or an opened project) established this session.
  The one exception is `settings.recentProjects`, which is itself the allowlist for
  re-opening an MRU entry (answering `{ok:false, code:"missing"}` for a file that has
  gone, so the renderer can offer to forget it).
- **The simulation engine is pure computation, not I/O** — DOM-free ES modules under
  `src/web/scripts/sim/`, fully testable with `node --test` (circuit-fixture suites build
  documents in code and assert settled levels). All user-visible sim state (LEDs, badges,
  probe tints) renders from `chiphippo:sim-state`, never by querying the engine.

## Desk surface & rendering

- **Layers** inside `.desk-surface`: `.layer-boards` → `.layer-parts` → `.layer-wires`
  (one shared SVG) → `.layer-overlay` (ghosts, hover rings, tooltips — pointer-inert).
- Boards and chips are ONE static inline SVG each; the tie-point/pin `<rect>`s carry **no
  id, no `data-*`, no listener** — all hole/pin interaction is `holeAt()` / derived-pin
  math from pointer coordinates. The sanctioned per-item event exceptions are all widened
  invisible hit targets where idiomatic SVG beats hand-rolled distance math: each wire's
  hit stroke (`pointer-events: stroke`, `wire-layer.js`, listeners on the `g.wire`
  group), each rotatable discrete's `.part-span-hit`, each push button's
  `.part-button-cap`.
- Pan/zoom must **never** rebuild or re-lay-out surface children (transform only); wires
  re-render only on doc changes or live drags (positions passed as overrides).
- An `<svg>` with width/height 0 renders NOTHING per spec — zero-size anchors need a
  token 1×1 box + `overflow: visible`.
- **The desk padlock locks an INPUT, not the camera** (`components/desk-lock.js` →
  `DeskView.setWheelLocked`, **⌘L**). Top-right of the viewport, transparent background
  (it sits on the desk, not in a card). Shut, the wheel stops reaching the camera;
  drag-to-pan, the zoom cluster, the keyboard and Fit all still work — it exists for a
  **Magic Mouse**, whose surface reports a scroll from a resting finger. `#onWheel` calls
  `preventDefault` BEFORE the lock check (a locked desk must not fall through to page
  zoom). The state is **session-only and open at launch** — a remembered lock would greet
  a new session with a desk that ignores the wheel and no memory of why. The icon changes
  SHAPE (open vs shut shackle), its label says what a CLICK would do (with its
  accelerator), `aria-pressed` says what it IS, and ⌘L goes through the padlock's own
  `toggle()` so key and button can never disagree.
- **Fit (⌘F) is the one camera action that EDITS the document**, deliberately.
  `#recentreDesk` slides the whole desk onto the origin (`DeskDoc.translateAll`: every
  board, brick and label by one integer delta — seated parts and wires are addresses, so
  they ride their board) before framing, so a long session cannot creep out into the
  coordinate space. The move is RIGID (it can neither be refused nor break a mating),
  rides `#emitDocChanged` as one undo step, marks the project dirty, and is skipped while
  the sim runs. Fit follows the ACTIVE view (`fitActiveView`); the schematic's own `fit()`
  is camera-only.
- **The same move happens on every LOAD, and there it is nobody's edit**
  (`DeskController.fitLoadedDesk` ← `frameLoadedView` ← `ProjectWorkspace#frameLoaded`).
  A project that opens (boot, Open…, Open Recent, New) and a new example desktop are
  centred and framed before they are looked at, but the move is NOT recorded
  (`#restoring`), the history's present entry is re-baselined to the centred document,
  and `#markClean` follows — putting a design where it can be seen must never earn a •,
  or a save-or-discard question about a project nobody has touched. A tab SWITCH
  deliberately does neither: that desk's camera and state are the user's.

## Schematic view

The derived logical schematic (`components/schematic-view.js` +
`model/schematic-layout.js` + `catalog/symbols.js`) flips in via **Tab** alongside the
breadboard, drawing chip symbols + routed named nets + bus lines from the same `DeskDoc`.
It keeps its own `DeskView` and its own wheel (there is no padlock over there, and so no
invisible lock either), shares the desk's camera / probe / live sim tint, and persists
only a per-symbol **`schematicPos`** layout nudge — **never a second source of truth**.
Its own `fit()` is camera-only, since its symbol positions are derived and there is
nothing to move.

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
  flush edges with a tolerance (`FLUSH_EPS`): 3.70 + 14.02 is not exactly 17.72 in
  binary, and a joint that fails by an ulp is a kit that silently comes apart.
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
  DIPs straddle it (pins in rows `e` and `f`). A rail strip carries both polarities, `+`
  and `−`, each one continuous node for its length.
- **Addresses** are the only cross-module currency for holes: `<ownerId>.<point>` —
  `bb1.a12` (grid hole), `bb2.+7` (rail hole), `psu1.+` (component terminal). One hole
  holds at most one lead. **Nothing outside `model/breadboard.js` does row/column
  arithmetic by hand** — callers use its lattice primitives (`holeAt`, `columnAt`,
  `rowNear`, `clampColumn`, `parseHole`, `parseAddress`, `nodeOf`, `holeAlong`,
  `holeAlongTo`, `holeAcross`, `rowsBetween`). The ONE deliberate exception is
  `app/store/migrations.js`: a frozen snapshot of the v1 address grammar that must NOT
  track the live specs (a spec change would silently rewrite saved documents), and which
  as main-process CommonJS cannot import renderer ESM anyway. **Leave its hand-rolled
  copy alone.**
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

## Simulation

- **Netlist** (`sim/netlist.js`): a pure union-find partition of every point into nets,
  keyed by the lexicographically smallest member address (stable across rebuilds). Part
  state (switch position, button pressed) is an INPUT — a switch's `internalBridges`
  conduct; chip pins are net MEMBERS, never conduits (that is the simulator's job).
  Always a full rebuild, invalidated on `chiphippo:doc-changed` / `chiphippo:part-state`
  by `NetlistCache`.
- **Levels** (`sim/levels.js`): H/L/Z/X, `asInput` = "floating reads HIGH", ternary gate
  primitives.
- **Chip behaviour is DATA, never per-chip code.** Combinational chips carry a
  `logic.units` block the ONE generic `evaluate(def, pinLevels)` in `sim/chip-eval.js`
  walks — gate primitives, tri-state `BUF3`, and `COMB` units (a pure `compute` over
  fanning-out inputs: the decoder/mux vocabulary). Sequential chips carry
  `{ state0, step, outputs }` built by the pure family builders in `sim/sequential.js`
  (D-FF, JK-FF, transparent latch, sync + up/down counters, SIPO/PISO shift);
  `step(state, inputs, prevInputs)` advances on detected edges + level-sensitive async
  overrides, `outputs(state, inputs)` drives the pins. **A new 74xx part is data** — if
  it can't be expressed, extend the vocabulary, never fork. Zero-delay and
  power-agnostic; the truth-table harness enumerates every gate unit exhaustively,
  MSI/sequential parts prove out in circuit fixtures.
- **The CPUs and the PROCESSOR group** (`catalog/chips-cpu.js` + `sim/w65c02.js` +
  `sim/z80.js` + `sim/z80-ops.js`) are the far end of "genuine per-part code behind the
  STANDARD sequential contract" — a whole instruction set behind
  `{state0, step, outputs}`. They live in their OWN group, which is why the W65C02 left
  `chips-io.js` (that file is the 65xx PERIPHERAL wave). The group is `PROGRAM_ONLY`
  (`scripts/demo-build.mjs`) so it gets no bench demo and no example button, and it is in
  `PROTOCOL_GROUPS` (`chips-tristate.test.js`) because a CPU floats pins on a bus
  PROTOCOL, not on any pin you can tie.
  - **They disagree about the clock, and that is the design difference.** A 6502 IS one
    bus access per PHI2 cycle, so `w65c02.js` collapses to that and loses nothing. A Z80
    is not (an opcode fetch is four T-states with a REFRESH cycle glued to its back half,
    a read is three, an I/O cycle four), so `z80.js` runs a real M-cycle/T-state machine
    — the only way `/M1`, `/RFSH` and `/WAIT` mean anything. It is affordable because the
    transport ticks the engine once per clock EDGE (`sim-controller.js`'s
    `1000 / (2 * hz * speed)`), i.e. HALF-T resolution — what the Z80's timing diagrams
    are drawn at — and because `outputs` may read the LIVE clock off its own input pins,
    so the state carries only WHICH T-state it is in. `SIGNALS` is the datasheet's timing
    diagram transcribed as DATA, not code.
  - **They latch the data byte from opposite places.** `w65c02.js` reads from `prev`
    because a 65xx peripheral gates its bus drivers on PHI2 — an INPUT already flipped by
    the falling-edge settle. `z80.js` reads from `ins`, because it enables the device
    with its OWN `/MREQ` + `/RD`, still asserted in the pre-settle picture. The corollary
    is the subtle one: the byte is taken on the edge ENTERING the sampling T-state
    (`t + 1 === sample`), since an M1 releases `/MREQ`//`/RD` and puts the REFRESH
    address up at T3's rising edge — sample a tick later and every fetch reads a
    deselected memory, i.e. `$FF`.
  - Both cores keep a small `log` of the bytes already returned for the current
    instruction and RE-RUN a clean interpreter from the committed registers each M-cycle,
    throwing at the first new access — plain data, no generators, so the engine's
    structural `sameState` still works. **`step` MUST be edge-gated and return its state
    VERBATIM off-edge**, or the tick's step fixpoint never settles and the circuit is
    reported as oscillating.
- **The engine** (`sim/resolve.js` + `sim/engine.js`) is pure and DOM-free. `resolveNet`
  picks a net's level by strength precedence (supply beats chip output; opposing supplies
  → `X` + short; disagreeing outputs → `X` + conflict; `Z`/undriven contributes nothing;
  a clock source drives its `out` net at output strength).
  `settle({document, netlist, warmStart})` gates each chip on its VCC/GND nets (5 V ok,
  3 V underpowered-inert, 12 V damaged), then loops resolve → `evaluate` → re-drive to a
  fixpoint or the 200-iteration cap (→ still-changing nets marked `X` + oscillation).
  **Warm-starting net levels by stable netId is exactly why cross-coupled NAND latches
  HOLD.** The engine is a pure function: it REPORTS `chipStatus` and returns
  run-volatile `state`/`pinLevels`, never mutating `params` and never touching a timer.
- **`tick(...)`** adds the synchronous two-phase step on the same solver: ① pre-settle
  with the OLD per-component state (propagating the new `clockPhase` + input changes),
  ② sample each sequential chip's inputs and `step` it (edges from the pre-settle vs the
  last tick's `prevPinLevels`; async overrides win), ③ post-settle with the NEW state —
  so all edges are observed at once and then the combinational cloud settles.
- **`SimController`** (renderer) owns the **transport** (Run / Pause / Step / speed),
  drives each free-running clock's edges from a `setInterval` (handing `tick` each
  clock's level via `clockPhase`), re-ticks on every input event, routes warnings to the
  `NotificationStack`, and publishes `chiphippo:sim-state` (net levels + chip status +
  clock levels) that live views render from — **views never query the engine**.
  Sequential state and clock phases are run-volatile (reset on Run, never serialized).
  - **The timer's floor is DERIVED from the top of `CLOCK_HZ`**, never typed. Every edge
    is a full tick plus a `sim-state` publish, so there IS a ceiling on edge rate — and a
    hand-picked one is how a picker comes to offer a rate the app quietly runs slower
    than (at a flat 20 ms a "100 Hz" clock ticked at 25 and said nothing). Tying them
    together makes the ceiling equal the fastest rate on offer, so ×1 is always exact and
    only the SPEED multiplier can saturate. Offering a rate past ~100 Hz is a question
    about the tick budget (the heaviest shipped demo settles in ~0.6 ms), not about that
    constant.
  - **12 V damage is run-volatile, and that took work to be true.** `#persistDamage`
    writes `params.damaged` into the DOCUMENT because that is what the pure engine reads
    (`powerStatus`) and a chip that let its smoke out at tick 5 must stay dead at tick 6
    — a timerless solver has nowhere else to remember it. But burning a chip is a WIRING
    mistake, not a property of the circuit, so `stop()` calls `#clearAllDamage()`
    **before** `#onTransportChange` (stopping re-baselines undo/redo against the live
    document via `#history.sync`, and a later clear would leave the baseline holding
    damage for ⌘Z to bring back), and `DeskDoc`'s load path drops the flag through
    `loadParams` (deliberately NOT `normalizeParams`, which `setComponentParams` shares
    and the latch needs) — covering a project ⌘S'd mid-run, older documents, every import
    and every paste. `SimController.replaceChip` is GONE: Stop recovers every damaged
    chip.

## Memory chips

**Volatility decides everything** (`isVolatileMemory`).

- A **volatile SRAM** (`ram-8k`/`HM62256`/`AS6C1024`, flagged `volatile`) is never
  file-backed — run-volatile only.
- A **non-volatile ROM/EPROM/EEPROM** is backed by a real `.bin` **sidecar** in
  `userData/memory/<guid>.bin`. The document stores only `params.storage =
  { guid, source?, edited? }` (a `crypto.randomUUID()` minted on placement) plus a
  `programmed` flag — **never the bytes**. `source` is a LABEL, NEVER A PATH: nothing
  resolves it, opens it or hands it to `fs`, which is what makes it safe to keep an
  absolute path written on someone else's machine; `edited` marks bytes hand-changed in
  the inspector since.
- **The CIRCUIT can never write a file-backed chip.** EEPROM/EPROM are treated as ROMs
  (the app can't drive a write cycle), so `SimController` drops any reported write to a
  non-volatile chip and loads each ROM's file on Run (an async gate before the first
  tick), warning when a chip flagged `programmed` finds its file missing (the
  delete-then-undo data-loss case). A ROM is programmed only by the in-app **external
  programmer** (a menu action: pick a `.bin`/`.hex`, copy it to the file's start with a
  size warning).
- **All file I/O is in main**, over the GUID-keyed, parity-guarded `mem:*` IPC
  (`create`/`load`/`program`/`write`/`delete`/`path`/`pick-image`/`export`) — main alone
  maps a GUID → path and rejects a hostile one. `app/store/mem-store.js` is
  byte-oriented + atomic over `io.js`: `create` fills a fresh file with **random noise**,
  `program` copies an image to the file's start (short writes a prefix, long truncates,
  both warned), plus `writeAll`/`remove`. Lifecycle rides the DeskController:
  `#provisionMemory` on placement, `#releaseMemory` on removal, and a `programmed` chip
  whose file has gone is recreated as noise and warned.
- Since Feature 250 `userData/memory/` is a **cache**, not the source of truth: a
  programmed chip's bytes are collected into the PROJECT file on save and hydrated back
  on open (`app/store/project-images.js`).
- **The inspector** is a floating OS window per component (`web/memory.html` →
  `scripts/memory.js` → `components/memory-inspector.js`). Being its own sandboxed
  renderer it reaches the main renderer ONLY through main's `memory:*` relay
  (`open`/`to-inspector`/`to-host`, re-dispatched by preload as
  `chiphippo:memory-inbound` / `chiphippo:memory-host-inbound`). The grid is
  **virtualized** (a reused row pool — a 32 KiB image is ~30 rows in the DOM),
  **editable when stopped** for a ROM (Save writes its file) and a **read-only live
  viewer** for SRAM and any running chip (it mirrors the engine-owned image, never writes
  it). Intel HEX ⇄ bytes is the pure `model/hex-format.js`.
- The renderer-side **`components/memory-bridge.js`** answers a window's `ready` with its
  chip context (kind + GUID + display path + the image's source file and whether it has
  been edited, or the live bytes while running), runs the programmer + Save **through the
  controller** (so `programmed` and the source label ride undo/redo together), and
  streams `chiphippo:mem-state` byte writes out to open windows.

## Projects, files & desktops

**THE PROJECT IS THE DOCUMENT.** ONE file — `<name>.chiphippo` — holds every desktop's
desk document AND every programmed ROM's bytes, so there is one dirty marker, one Save,
one Save As, one recent list and one File menu.

```jsonc
{ version: 5, name, description?, activeTab, nextIndex,
  tabs:   [ { id, name, description?, doc } ],
  images: { "<rom-guid>": { "blob": "sha256-<hex>" } },  // programmed ROMs only
  blobs:  { "sha256-<hex>": "<base64>" } }               // stored once, shared
```

Code: `app/store/project-store.js` + `project-images.js` + `project-migrate.js` +
`model/project-doc.js` + `components/project-workspace.js` + `components/project-tabs.js`
+ `model/design-clip.js`. The whole file surface is
`project:boot`/`:new`/`:open`/`:open-recent`/`:save`/`:choose-path`/`:regrant`, plus
`desktop:export`/`:import`/`:duplicate`.

- **A tab is a DOCUMENT, not a second desk.** There is exactly one `DeskView` /
  `DeskController` / `SimController` / palette / guide / analyzer; switching desktops
  SWAPS THE DOCUMENT in place through `DeskController.loadDocument` — the same
  `restore` + `#rebuildScene` path undo/redo has used since Feature 200. **Nothing in the
  app reloads the window any more**: `#rebuildScene` is the in-process teardown that made
  `window.location.reload()` unnecessary. The ACTIVE desktop's document lives in the
  shared `DeskDoc`; `#stash()` folds it back into the meta whenever the WHOLE project is
  needed (save, switch, export, dirty test), and every other desktop's sits in
  `meta.tabs[].doc`. `ProjectWorkspace` keeps PER TAB only the camera and its own
  `HistoryStore`, so ⌘Z after switching back undoes THAT desk's last edit. A camera is
  deliberately not in the file (panning must never mark a design dirty, and neither must
  switching tabs — `projectSignature` drops `activeTab`). A switch stops the sim and
  closes the aux windows (`c3` on one desktop is a different chip from `c3` on another);
  the copy buffers deliberately survive it, which is what makes a cross-desktop paste
  work.
- **There is always a project**, from first launch: `project:boot` always answers with
  one, so `app.js` has no project/no-project branch. An unsaved project — blank `name`,
  blank `location` — lives in the ONE fixed working slot `saves/default.chiphippo`, which
  is to a project what `desk.json` used to be to a schematic. **Startup**
  (`bootProject`) is that read backwards: the working slot if it exists, else the head of
  `settings.recentProjects` still on disk, else a new project. The slot's file exists
  exactly while the open project is unsaved (`project:save` to a real path drops it —
  `dropDefault` — and so does opening another project). **A new project is always exactly
  one desktop**, numbering restarted at 1; `addDesktop` mints the next `Desktop N`
  (`nextIndex` only counts up) with no dialog at all.
- **Nothing is written to the user's file until you save.** Adding, renaming,
  duplicating, importing and deleting a desktop are plain unsaved changes, so "close
  without saving" is a complete, honest revert of the session.
- **And nothing is lost to a crash, because those are different questions.** Every
  `AUTO_SAVE_MS` (30 s) the open project is stashed in the app's own WORKING SLOT — never
  the user's file — so the • still means "not in your file". The slot means one of two
  things, and a `recoveryFor` stamp is the difference:
  - **unstamped** — an untitled project's actual home. A stash IS a save, so it goes
    through the ordinary `#writeProject` and the • CLEARS. A clean quit keeps it.
  - **stamped** — a copy of a project that HAS a file, holding work that file does not.
    Dropped by any save to a real path (main enforces that, so a call site cannot forget)
    and by a clean quit — so "a stamped slot exists at startup" means exactly "the last
    session did not finish". That is the whole crash detector: no timestamps, which cloud
    sync and a corrected clock will both lie about.
  - **Two baselines** follow: `#saved` is the project as its FILE holds it and drives the
    •; `#stashed` is it as the SLOT holds it and is what the tick compares. They part
    company the moment a stash gets ahead of the file — the normal state for a titled
    project, and why the tick cannot just watch `dirty` (true from the first edit until
    ⌘S, so it would rewrite the same bytes forever).
  - The tick does NOT listen for `chiphippo:doc-changed`: that event is wrong in both
    directions — `#setTabProperty`/`#setProjectProperty` never dispatch it (a rename
    would never be stashed) and it fires on load and on every undo/redo restore (nothing
    to write). `#imagesTouched` is the one change no signature can see (a ROM's bytes
    live in a sidecar; `setMemoryProgrammed` writes `true` over `true`, and for a re-load
    of the SAME file an identical `storage` too), so `MemoryBridge` reports it through an
    injected `onImagesChanged`.
  - **A restore is not a question.** `recoveryBoot` restores the stash outright and the
    renderer says so (`workspace.recovered*` — main hands over the FACTS
    `{name, path, homeless}`, since `m()` is for text MAIN renders). Restored work
    arrives UNSAVED (`#saved`/`#stashed` left null) so ⌘Z and close-without-saving both
    still work; a launch modal would ask for an irreversible-looking decision about a
    reversible thing with the destructive button one mis-click away. A recovery whose own
    file has gone restores as UNTITLED, so Save As re-homes it.
  - Guards: `#busy` (a leave/quit question is out, or a swap is mid-flight — a stash then
    would preserve the very work being discarded), `#inFlight` (a tick SKIPS, a manual ⌘S
    QUEUES, since `#askUnsaved` reads a `false` as a cancel), `#autoStopped` (a STATE,
    not merely a cleared interval, because `autoSaveNow` is public) and `#autoSaveFailed`
    (one quiet failure RETIRES the tick rather than reopening the same modal every 30 s).
    `#writeProject`'s baseline is **the bytes that went** (`projectSignature(written)`),
    never `#project` after the await — every META edit reassigns `#project`, so the old
    code folded an unwritten rename into the baseline and lost it. `visibilitychange`
    flushes on the way out of sight; the interval `unref?.()`s (a real `Timeout` under
    `node --test` would keep the runner alive per constructed workspace);
    `autoSaveMs: 0` is the harness's off switch.
- **Save vs Save As.** `save()` on an untitled project writes the working slot SILENTLY —
  designing something and keeping it must never require choosing a file — and `saveAs()`
  is what gives it a home, taking the project's NAME from the file picked (so there is no
  name prompt in front of the save panel). Replacing an existing file is the NATIVE
  dialog's question and only its question (`properties: ["showOverwriteConfirmation"]` is
  how the Linux panel is told to ask); `choosePath` returns a path or null, so declining
  a replace reads back as a cancel.
- **ROM bytes travel in the file, content-addressed** (`project-images.js`). `write`
  COLLECTS every chip flagged `programmed`, HASHES its bytes and records chip → blob
  (noise does not need to travel); `read` HYDRATES them back before the renderer sees the
  project; `reseatImages` gives a COPIED desktop (Import, Duplicate) fresh guids and
  fresh files so two chips can never share one. This is the second place in main with
  document knowledge after `migrations.js`, and equally narrow — it reads
  `components[].params.storage.guid` + `params.programmed` and nothing else.
  - **The bytes are the key**: identical images name ONE blob however many chips or
    desktops hold them (four desktops sharing an 8 KiB ROM: 14 916 bytes against v4's
    47 688), and a file re-read after being edited on disk hashes differently and becomes
    a second blob. **The hash is main's, taken at save time from the real sidecar** —
    never stored in the document, where it would have to be re-derived on every hand-edit
    and a stale one would restore the WRONG BYTES. It is a DEDUP KEY, not a checksum: the
    read path must never verify it and skip on a mismatch, since the only useful response
    to one is to write the bytes anyway.
  - **The per-chip entry is an OBJECT, and that is load-bearing**: an OLDER build runs
    `Buffer.from(value, "base64")` over `images`, and a bare hash string decodes to 53
    non-zero bytes — past the zero-length guard, over a good sidecar, and collected back
    by that build's next save. An object is not a string, so the old loop SKIPS it and
    the existing "programmed, but its data file is missing" warning explains itself.
    Honest degradation, not corruption.
  - **Dedup lives in the file, never in the cache** — one `.bin` per chip is what keeps
    `#releaseMemory`'s unconditional delete-by-guid correct with no refcounting. A v4
    file (inline base64, no `blobs`) still reads: `imagesOf` flattens EITHER shape into
    the `guid → base64` map every consumer already speaks — dispatching on the structural
    tell, and aliasing rather than copying a shared blob — so `hydrateImages`,
    `reseatImages` and `copyImage` are untouched. The cache is never SWEPT.
- **Changing projects or quitting** runs through `#confirmLeaveProject`, which on "save"
  LETS THE ACTION GO AHEAD (the user is not made to ask twice). Quitting is the silent
  case (no Save button was clicked, so nothing is asked about WHERE). Changing projects
  differs in one way: an UNTITLED project **that holds something** is asked about dirty
  or not, because it lives in the one working file the incoming project is about to claim
  and there is nowhere else for it to go — so "save" there means `saveAs`. The exception
  is the state the app BOOTS INTO: a **pristine** project (`#isPristine` — no name, no
  description, ONE desktop, `isEmptyDocument`, not dirty) is let go silently, or the very
  first New or Open of a session would open with a save-or-discard question over a blank
  desk. Both halves are load-bearing: an unsaved change is caught by `dirty`, one already
  ⌘S'd into the slot by the project still holding something. `isEmptyDocument` reads only
  the CONTENT lists (derived from `emptyDocument()`, so a list added later can't be
  forgotten) and never the `next*Id` counters — those say what a desk has ever held. A
  SAVED project has a file nothing is claiming, so it is asked about only when dirty.
- **Every path resolves `false` for a cancel**, and a save that never landed IS a cancel:
  `save`/`saveAs`/`exportTab` all return `Promise<boolean>` and every dialog is
  promise-wrapped, since PopupManager fires its callbacks on EVERY dismissal path (mask
  click included) so an awaiting caller can't hang.
- **The guard must ANSWER, and answering is three separate promises** — main waits on
  `confirmClose()` with NO TIMEOUT and LATCHES `closePending` until the reply lands, so
  anything less than an answer is an app that can never be closed again:
  - **it settles** — PopupManager fires a callback and DISCARDS what it returns, so an
    `async onChoose` that rejected skipped its own `resolve` and left the promise pending
    for the life of the process. `#askUnsaved` now catches and resolves FALSE.
  - **it never rejects** — `confirmClose()` reads the live document (the dirty test),
    which can throw before any dialog is up. It catches, reports through `#fail`, and
    answers false.
  - **it never answers TRUE by accident** — `app.js`'s handler used to default `ok` to
    `true` on a throw, trading the user's unsaved project for an unwedged app. Main's
    latch is per-attempt, so blocking costs ONE refused ⌘Q while proceeding costs the
    work. **A failed guard is never permission to discard.**
  - Underneath, `#doWrite`/`#writeRecovery` put their WHOLE body in the try (`#stash()`
    and `projectForFile()` included) so "a write answers, it doesn't throw" is enforced
    rather than asserted, and `#serialize` awaits its predecessor as
    `prior.catch(() => {})` so one failed write can't reject the chain behind it.
    `PopupManager` routes every callback through `fire()`, which reports a throw or
    rejection instead of dropping it. Main's backstop is `watchRendererForClose`: a
    renderer that CRASHES mid-question releases the latch. A renderer that is alive and
    silent is invisible from there, which is why the guarantee lives on the renderer
    side.
  - **Main's half is `app/close-guard.js`** — the three flags and their transitions with
    no Electron in them, so `main.js` keeps only the event wiring. **The confirmation
    authorises ONE close and no other**, which is what `closed()` is for: it used to be a
    one-way latch, and on macOS (where closing the last window does not quit) that was
    silent data loss — close, answer "discard", click the dock icon, and the fresh window
    inherited a set latch, so every later close and ⌘Q skipped the guard entirely.
- **Export / Import replaced a desktop's Save As / Open.** A `.desktop.chiphippo` is a
  SNAPSHOT (the document plus its ROM bytes, no link retained), so it can never dangle.
  Import is always an ADDITION (no file operation can replace the desk on screen) and
  re-mints the snapshot's ROM guids, so importing twice leaves two independent copies.
  Opening a bare `.desktop.chiphippo` (or a loose `.chiphippo` design) wraps it in a new
  one-desktop project with NO location.
- **Every desktop is a peer**: any can be renamed, duplicated, exported or deleted; the
  ONE rule is that a project keeps at least one, mirrored by the strip disabling Delete
  on the last tab. A tab's context menu is the **board's** shape — Properties… ·
  Duplicate · Export… · rule · Delete Desktop — not the part menu's, since a desktop has
  no pins. There is no per-tab dirty dot (a desktop cannot be saved on its own, so a
  marker no action could clear would be a lie). **Properties…** opens the shared
  `PartPropertiesDialog` with the universal Name/Description pair alone (the description
  shows in the tab's tooltip); the PROJECT has the same dialog (File ▸ Project
  Properties…) plus one `"readonly"` **Location**, blank until saved — a desktop has
  none, because it is not a file.
- **The strip is always on screen** (there is always a project), and the `+` beside it
  splits the way a TAB does: a PRIMARY click adds a desktop with no menu and no
  questions, a SECONDARY click drops **New Desktop** · **Import Desktop…**. Those are the
  two ways a desktop ARRIVES and neither belongs to a particular tab; both land on the
  new desk, and both mirror the Desktop menu's leading pair, so the wordings must stay in
  step. A THIRD way — a chip's **example circuit** — deliberately lives on that part's
  pin-assignments window, because it belongs to a PART.
- **v3 → v4** (`project-migrate.js`): a project that listed desktop PATHS has them
  inlined on read, NON-DESTRUCTIVELY — a desktop file the user saved somewhere of their
  own is read and left where it is. A tab whose file has gone opens EMPTY with a warning
  naming it. `upgradeLegacyDefault` is the one destructive case: it rewrites the old
  working slot as v4 and only THEN removes the v3 file and the app-kept desktops it alone
  pointed at, returning its warnings for `bootProject` to carry out on the meta.
- **The design clip** (`model/design-clip.js`, pure) is `paste-cluster.js` one level up:
  it carries the BOARDS too (plus everything seated on them, selected desk bricks, every
  wire with BOTH ends inside, and the buses / net names / anchored labels riding them),
  so a sub-assembly brings its own holes and its wiring survives the trip. Legality is
  per-board only and the drop is **all-or-nothing** — half a design would silently cut
  the wires that crossed to the board left behind. The ghost is built ONCE in the clip's
  own coordinates and then TRANSLATED (it is rigid), and `DeskDoc.pasteDesign` stamps it
  in one snapshot-guarded mutation that rolls itself back on any refusal.

## AI circuit builder

`app/store/credential-store.js` + `app/ai/{providers,client}.js` +
`model/{pin-resolve,column-allocator,autobuild,autobuild-verify,wire-crossing}.js` +
`web/scripts/ai/{catalog-brief,generate,connection,usage}.js` + `components/ai-panel.js`.

**An LLM cannot emit geometry, so it is never asked to.** The model answers exactly one
question — which parts, and which of their pins share a net — as a coordinate-free
`{parts, nets, tests}` spec, and a pure, DOM-free compiler decides every hole, column,
anchor and wire.

- **The compiler interposes what a netlist must not have to mention.** `sim/junction.js`
  (the LED burn rule, moved out of the view because it is PHYSICS) is why a series
  resistor is added automatically. The **pull rule** is the same fact one step over: a
  switch is a CONTACT, not a source, so an input fed from one floats when the switch is
  open — and a floating TTL input reads HIGH, i.e. a switch that appears to do nothing. A
  signal net with no rail, no output driver and no resistor of its own, whose only path
  to a supply runs through a contact, gets a pull to the OPPOSITE rail (`contactPairs`
  probes each def's own `internalBridges` at both extremes of its parameter domain,
  rather than adding a second catalog field that could drift). Which rail is READ off the
  far side of the contact, never assumed (a GND-side switch gets a pull-UP); a net whose
  contacts disagree, or reach no rail, is left as declared for L6 to report. Pulls to one
  rail pack eight to an `rnet9`; a lone one is a bare `resistor`.
- **Compile** (`autobuild.js`): `compileNetlist(spec)` → `{document, warnings, partMap,
  nets}`. Power is DERIVED — every def declares `role:"vcc"|"gnd"`, so a spec never lists
  a power pin; the compiler wires them, plants a PSU, and bridges the kit's two rail
  strips. `column-allocator.js` hands out EXCLUSIVE column runs, which makes the worst
  machine-generation bug — two parts sharing a column-half, hence silently shorted —
  unrepresentable rather than merely unlikely. Routing is per-net star-from-hub over
  `freeAt` (you never wire TO a pin, you wire to a free hole on the pin's NODE), the hub
  being the highest-capacity port (a rail is ∞), and a port is keyed by its NODE so two
  pins already sharing one are never wired to each other.
- **Boards snap together and a stacked pair shares the rail between them** — rule 1 of
  "Power layout" below, which the compiler shares with every other generator here
  (`railSpineOrder` is rule 2, `railLink` rule 3). The compiler emits one RUN of strips,
  `rail · pins · rail · pins · rail`; the shared strip sits in BOTH kits' `rails`, the
  bridge loop CHAINS (R0–R1 across the first board, R1–R2 across the second), and
  `railStripIds` is read off `boards` rather than off `kits`, whose lists now overlap
  (walking the kits would offer the shared strip's holes twice). The run carries ONE
  `group`, as `DeskDoc.addKit` gives a palette-placed kit (`pasteDesign` re-mints the id
  on the way in).
- **Placement is a step, not an accident.** Three rules decide the layout; together they
  took the 8-bit adder from two breadboards and 74 wires to one board and 58, and across
  all 51 demo benches −18% wire and 104 fewer wires.
  - `orderByConnectivity` — greedy cluster growth from the busiest part, then whichever
    unplaced part shares the most nets with what is down. Since the seating loop fills
    one board before starting the next, an order where neighbours are adjacent also keeps
    a net's parts on ONE board, and the cross-board wires that remain fall on the
    genuinely least-connected seam. RAIL nets are deliberately not adjacency (every part
    touches power, and a rail net routes to the nearest rail hole). Ties break by spec
    order, so a spec always lays out the same way.
  - `seatCompanion` — a pull pack seats IN the columns of the switch bank it pulls (an
    `rnet9` under a `sw-dip8` buys eight pull-downs for zero wires and zero columns).
    Sharing a column-half is otherwise the exact disaster `column-allocator.js` prevents,
    so NOTHING is inferred: the net equality is given (the pull rule CREATED one net per
    pack pin), the geometry is proved pin by pin with `nodeOf`, and every column touched
    must be free or the host's (hence `columnOwner`, and hence a column recording WHO
    owns it). Any check failing returns null and the part seats the ordinary way, so this
    can only cost columns, never correctness; L4 checks the result regardless. One host
    per pack only.
  - `freeRail(…, {fromEnd})` — the PSU brick stands off the RIGHT of the boards, and a
    rail is one node end to end, so reaching for hole 1 bought nothing but two wires the
    width of the desk.
- **Seating is two passes, and a second breadboard is a LAST RESORT.** Pass 1 fills each
  board before starting the next — the only way to learn how many boards a design
  actually needs, which the column budget cannot know.
  - **The blank column goes before the board does.** `GAP` is a courtesy (so neighbours
    do not read as one block), but insisting on it fetched a whole breadboard for a
    1-column shortfall, so a spilled design is re-seated with `gap = 0` and that is kept
    ONLY when it saves a board. This alone took the demo corpus from 9 multi-board
    circuits to 1.
  - **The split is CHOSEN, not fallen into** (`splitAcrossBoards`, pure): a design that
    genuinely needs two boards is cut where it severs the FEWEST NETS, not at the halfway
    column (a naive even split turned 8 cross-board wires into 22). Every position
    leaving the board reasonably filled (`FLOOR`) is a candidate, ties go to the evenest;
    RAIL nets are excluded (every part touches power, so they sever nothing); a companion
    costs 0, since it rides its host's columns. The assignment is a **preference, never a
    refusal** (assigned board first, then every board), and a re-seat needing MORE boards
    is discarded for the one that came before it. Corpus-wide: −13% strips, −8% wire
    length, −11% crossings. A serpentine fill was tried and REJECTED — it only helps when
    the first board is full to its last column, and with a properly chosen split it
    rarely is (with a half-filled first board it made the 8-bit bus port 43% longer).
  - **Kits are PRUNED, not predicted.** The column budget must assume a pull pack costs
    its nine columns and companion seating then costs none, so a design that fits on one
    board was handed two and the spare shipped EMPTY with bridges stitched across it.
    Nothing tries to estimate better (guessing low costs a `NO_ROOM` refusal, which is
    not recoverable; guessing high costs a board that is simply given back). Seat first,
    then keep only the kits something landed on — which is also why the power wiring and
    routing moved AFTER seating. A design with no seated parts keeps the first kit (the
    PSU still needs a rail to reach).
- **Routing minimises length AND crossings** (`model/wire-crossing.js`, pure). A DIP
  straddles the trench with pins in rows e/f and everything else the compiler seats lies
  along row `a`, and a wire attaches to a free hole on the pin's NODE — which offers five
  ROWS. Taking "the first free hole" took row `a` every time, the one row every discrete
  occupies. So a port OFFERS its free holes and `bestPair` picks by
  `distance + 20 × crossingCount`, `segmentHitsBox` being Liang–Barsky (sampling steps
  over a corner clip, and near-misses read as crossing). The same chooser does the POWER
  wiring, so nearest-that-flies-over-nothing picks the rail on the pin's own side of the
  trench with nothing told to it — and the bridges and PSU leads are wired AFTER seating,
  since before it there is nothing to avoid and a bridge always went down column 1,
  exactly where the first part goes. Residual crossings are REPORTED
  (`WIRES_CROSS_PARTS`), never hidden: a net joining a pin below the trench to one above
  has to get across. Corpus-wide: wire length −38%, crossings −44% (932 → 518).
- `pin-resolve.js` is FAIL-CLOSED and case-FIRST: pin names are case-distinguished in the
  catalog (74LS47's `A`–`D` inputs vs its `a`–`g` outputs), so folding case would
  MANUFACTURE ambiguity. The one real ambiguity is `74LS148` (inputs *named* `0`–`7` that
  do not match their pin numbers), reported with both readings, with `#N` as the escape.
- **Verify** (`autobuild-verify.js`): the L3a–L7 ladder, faults tagged `abort` (OUR bug)
  or `repair` (the SPEC's mistake) — the split the panel's retry loop needs.
  - **L4** compares the DECLARED net partition against the one `buildNetlist` DERIVES —
    the only thing that catches an accidental short (counts match, it loads clean, it
    settles, and it computes something else). It derives that partition from **wiring
    alone** (`{bridges: false}`, every switch treated as an open contact), because a
    switch thrown to a rail genuinely does make its signal net that rail, and holding
    THAT against the declared topology condemned the most ordinary input stage there is
    (every slide-switch design aborted as `NET_SHORTED_TO_RAIL`, a fault the model could
    neither cause nor repair). A severed net and two parts sharing a column-half are
    facts about wiring, which no switch position can hide or invent; a real electrical
    short is L5's to report, from the conducting netlist it keeps.
  - **L5** settles with every clock idle-low — a bare `settle` leaves a clock line at `Z`
    and L6 would report a good circuit as undriven.
  - **L6** uses the tri-state data: a net that floats with a tri-state driver on it
    reports `OUTPUTS_DISABLED`, naming the chip, the pin and "tie it to GND", instead of
    `NET_NOT_DRIVEN` sending a repair round hunting for a wire that was never missing.
  - **L7** is the highest-value one: the spec states its own acceptance tests and the app
    RUNS them, so a perfectly-built adder with its bit order reversed is caught. Bit
    ordering in `set`/`expect` is PINNED by a test, not inferred.
- **Every generated circuit explains itself.** The spec carries a `notes` paragraph and
  `assemble` stamps it above the boards as a caption, in the line pitch and muted body a
  demo bench uses — a generated circuit and a shipped demo should read the same way on
  the desk. It is **anchored to the leftmost seated part** — load-bearing, since
  `captureDesign` carries ONLY anchored labels, so an unanchored note would be silently
  dropped on the way to the ghost. `wrapText` breaks to 64 characters because a label is
  `white-space: nowrap` (a word longer than that overflows rather than being cut, and
  `.annotation--label` clears the shared `max-width`). The 30-line cap is a GUARD, not a
  budget (~1900 characters), and a trim marks its last line with an ellipsis, because a
  caption that simply stops reads as one written badly. The prompt states the length it
  wants (four to eight sentences). The same paragraph is handed back on the build result
  so the panel can say it while the user is still deciding whether to place the design. A
  `title` with no notes still captions the circuit with one line.
- **Place**: the output is a **design clip** (`designClipOf` = `captureDesign` with
  everything selected, never a second converter) handed to
  `DeskController.armGeneratedDesign` — a ghost the user positions, NOT a circuit that
  appears. `applyGeneratedDesign(clip, {at})` drops it outright (shift from
  `nearestLegalOffset`). Both go through the one `#dropDesign`, so a generated circuit is
  ONE undo step on the same atomic `pasteDesign` transaction as a paste — there is
  deliberately no `applyBatch`.
- **The prompt is DERIVED, never hand-written** (`ai/catalog-brief.js`):
  `buildCatalogCard()` projects `PALETTE_DEFS` (ids, packages, exact `n:name` pin lists —
  `JSON.stringify` would silently drop the FUNCTION fields), so a new 74xx part reaches
  the model the moment it lands in `catalog/`. ~4.4 K tokens, over the prompt-cache
  minimum, so a repair round re-reads rather than re-pays. Each pin carries a
  one-character MARK (`pinMark`): `>` output, `<>` bidirectional, `!` **active-low output
  enable**. The first exists because "two outputs must not share a net" is a rule the
  compiler ENFORCES; the `!` is the one fact nothing else reveals (the pins are called
  `1G`, `OE`, `M`, `N`) and getting it wrong is silent — the part floats every output it
  gates, an unwired enable reads HIGH, and a datasheet-correct netlist comes up dead.
- **Tri-state is DECLARED, then PROVED** — `outputEnable: [pins]` on the nine parts that
  have one, plus `tests/chips-tristate.test.js`. Not derived, because the catalog
  expresses tri-state four ways and only one is introspectable (a `BUF3` unit '125/'244;
  a `COMB` returning `Z` '240/'245/'257; a sequential `outputs()` returning `Z`
  '173/'533/'573/'595; a memory image). So the test probes the REAL evaluator: every
  declared pin must float an output that drives when it is LOW (pinning the active-low
  convention), and a behavioural sweep requires any part that floats an output to declare
  one — which is what found the '595, whose title never says "tri-state". `74LS245`'s
  `DIR` is deliberately NOT an enable (it picks which side drives; only `OE` stops both),
  and the Memory/Interface/PROCESSOR groups are out of the sweep — a CPU or PIA floats
  its bus on a PROTOCOL and its ports on a direction register, neither of which is a pin
  anyone can tie.
- **The compiler's corpus is the DEMO BENCHES** (`tests/autobuild-corpus.test.js`).
  `scripts/demo-specs.mjs` describes 52 circuits — one per 74xx part, each proved through
  the real engine by `make demos` against a datasheet truth table — and is ALREADY
  coordinate-free (`inputs`, `ties`, `links`, `clock`, `leds`), so a forward mapping
  turns each into a netlist spec. Every one is compiled and verified on `make test`, with
  no API key and no network. Deliberately a forward map from the SPECS, never a
  reverse-compile of the committed documents: a document's derived netlist includes
  whatever its switches are currently conducting, which would promote a transient switch
  position into declared topology. Two exception lists carry what the DSL cannot say,
  each named and argued: the `route` demo (a switch that STEERS a signal) and the seven
  tri-state parts whose demo hangs an enable on a switch (a spec cannot state a switch's
  RESTING position; the answer is to tie the enable, which the prompt says and the corpus
  proves builds clean).
- **The renderer makes NO network call** — its CSP is `default-src 'self'` with no
  `connect-src`. `ai/client.js` uses Node's global `fetch` (no runtime dependency of its
  own; `electron-updater` is the only entry in `src/package.json`'s `dependencies`) with
  an `AbortController` registry keyed by request id and an SSE reader that carries the
  tail across chunk boundaries. `app/ai/providers.js` holds BOTH adapters in one file
  behind `buildRequest`/`readEvent`/`buildPing`; nothing else branches on provider. **A
  refusal is a failure** — Anthropic returns HTTP 200 on a policy decline, so
  `stop_reason:"refusal"` is checked before the text is used. `ai:test` pings with
  `buildPing` (unstreamed, unschema'd): Test connection asks "can I reach you", so it
  must not fail because a model declined to fill a netlist.
- **The key never crosses the bridge.** `credential-store.js` writes it through
  `safeStorage` into `userData/credentials.json` and REFUSES rather than falling back to
  plaintext when the OS has no store; `ai:key:status` answers
  `{configured, encryptionAvailable}` and nothing more. That is why it does not ride
  `settings:set` — settings.json is plaintext and is handed back whole on every read.
  Only the NON-secret half (`ai: {provider, baseUrl, model}`) lives there. The provider
  LIST is itself IPC (`ai:providers`), so the Settings picker cannot drift from the
  adapters.
- **The panel** (`components/ai-panel.js`) shares the analyzer's docked shell and the
  toolbar-pill segment discipline. `ai/generate.js` is the DOM-free seam (`parseNetlist`
  → compile → verify → clip), so a whole generation is testable with no window and no
  network; the clip is taken from the VERIFIED (loaded) document, since what the desk
  places must be what the loader would keep. Repair rounds cap at **2** and only
  `repair`-class faults are sent back — the model cannot fix our compiler.
  `ai:delta`/`:done` are a SEPARATE message stream from the `ai:start` invoke result, so
  pushes that beat the reply back are held and replayed rather than dropped.
- **No connection, no segment.** The toolbar's AI segment is **disabled** until there is
  something to ask: `ai/connection.js` (pure) reads the settings' `ai` config, the
  `ai:providers` list and `ai:key:status` for the provider the Settings picker would show
  — one `effectiveProvider` rule, so the button can never be gated on a key for a
  provider the panel isn't showing. Validity is decided WITHOUT asking the provider
  (nothing is sent anywhere until the user asks for a build): a key is stored, the
  provider has an adapter, and a typed base URL parses as http(s). Whether the server
  would ACCEPT the key is Settings ▸ AI's Test connection. Every refusal carries the
  sentence the disabled button shows as its tooltip. The two ways the answer changes are
  a settings patch carrying `ai` and the key itself (which bypasses settings entirely —
  hence the dialog's `chiphippo:ai-key-changed` broadcast, saying only THAT it changed).
  The remembered `aiOpen` is restored only once the answer is known, and a key cleared
  while the panel is open closes it.

## Power layout — the three rules every GENERATED circuit follows

These bind everything this repo GENERATES — `model/autobuild.js`,
`scripts/make-demos.mjs` and `scripts/demo-bench.mjs`. They do **not** constrain what a
user builds by hand. They exist because a generator has no eye: it will happily emit a
circuit that simulates perfectly and looks like nothing anyone would build.

1. **Boards are spanned, and the rail between two of them is SHARED.** A bench dovetails
   two 830s and the strip in the middle serves the board above and the board below — you
   do not fit a second one against it. So a stack is ONE flush run,
   `rail · pins · rail · pins · rail`, never N self-contained kits with a gap. Everything
   else falls out: rail-to-rail links CHAIN instead of leaping the height of a whole
   breadboard; the run carries ONE group, so it drags as a unit and the outline traces
   the assembly; and every row of every board has a rail 2.76 pitch away, which is what
   makes rule 3 possible. ONE rail strip serving four pin-boards is not a shape a
   breadboard can be in — the heights are fractional, so a typed y leaves a gap, nothing
   mates, and a chip four boards down has nowhere near to reach for power. The one
   sanctioned exception is an **open bottom**: a run may end on a pin-board where a
   bottom-mounted module (an HD44780 panel) plugs into row `a` and its body hangs down
   off the bench.
2. **The supply is a vertical spine down the END of the run — RIGHT for preference, then
   LEFT, then the middle.** Two rail strips share no node, so something has to tie them,
   and a rail-to-rail wire crosses the pin-board and cannot be routed around (both ends
   are fixed to a hole and the chips are in between). The ends are where the boards are
   EMPTY. Right first because that is where the PSU brick stands; left next as the only
   other edge; the middle only when both ends are blocked, and then in from the right.
   "The end" means the line's last GROUP of holes (`railGroup`), not its last hole — that
   is the unit the part is drilled in, and it is what makes a blocked hole 50 step to 49
   rather than across the desk to hole 1. Two consequences of *one hole, one lead*: a
   middle rail is the bottom end of the segment above AND the top end of the one below,
   so its leads sit in ADJACENT holes and the spine steps one column per board, leaning
   the same way all the way down; and the two POLARITIES take different columns, or the
   supply and ground wires would lie a single pitch apart over their whole length and
   read as ONE line.
3. **A power lead takes the shortest route — the rail on its own side of the trench,
   nearest its own column.** Rows f–j face the rail above, a–e the rail below; once rule
   2 has tied them the two are the same net, so reaching for the far one costs a lead
   straight over the chip it is powering. "Nearest column" is the other half: a rail is
   one node end to end, so its leftmost free hole is exactly as correct as the nearest
   one and just as much a wire dragged the width of the board. Neither half is a special
   case — `autobuild.js` picks a supply hole with the SAME `bestPair` chooser the signal
   router uses, and nearest-that-flies-over-nothing arrives there on its own. The FACING
   rail loses only when there is none (an open-bottom run's last board).

**Where they are enforced.** `model/autobuild.js` — `assemble`'s strip run (1),
`railSpineOrder` + `bridge` (2), `railLink` → `bestPair(pinPort, railPort)` (3).
`scripts/make-demos.mjs` — `stack`/`extend` (1), `spine` (2), `tie` (3); `stack` is the
ONLY way to put a board on the desk there (`board` is not exported from `builder()`), so
rule 1 holds by construction. `scripts/demo-bench.mjs` — `BOARDS`, `#railFor`/`railNear`/
`wireToRail` (a single kit, so rules 1–2 have nothing to decide). Held by
`autobuild.test.js`, by each generator's own `assertClean` (a non-flush board is DROPPED
by `normalizeDocument` as an overlap, so the arithmetic cannot drift silently), and by
`demos.test.js`, which runs the shipped files through the real engine.

## Selection

**The selection is built two ways, and the modifier is the difference**
(`model/selection-toggle.js`, pure). A **Shift-drag marquee** REPLACES the selection with
everything a box wholly encloses; a **⌘/Ctrl-click** ADDS one item or takes one out. Both
fill the same three sets (`#multi` / `#multiWires` / `#multiBoards`), so Delete, ⌘C's
cluster/design clip and the board highlighter are untouched by the second existing.

- **⌘ on macOS, Ctrl everywhere else.** **Ctrl cannot be it on a Mac** — there Ctrl-click
  IS the system's secondary click, so admitting it means the press arriving as button 2
  and raising a `contextmenu` the desk then has to SWALLOW, costing Ctrl-click its
  context menus everywhere on the desk. Only the PRIMARY button counts, so Ctrl+
  right-click off a Mac stays a right-click. Shift and Option are excluded rather than
  ignored — each belongs to a gesture of its own (the marquee; the wiring-carrying part
  drag / the torn-off board run). The predicate is pure because the app only ever runs
  one side of its platform branch.
- **A wire and a bus toggle on the PRESS**, from the viewport's pointerdown, so every
  kind of item joins at the same moment. Their own click listeners merely STAND DOWN for
  the chord (the click that follows would replace the selection just toggled).
- **One item collapses to the ordinary single pick** (`singlePick`) — a one-item
  multi-selection would look identical and quietly do none of what a single pick does (R,
  Properties…, the Option ride hint).
- **A toggle is all-or-nothing over the ids it is given**, which lets a BOARD toggle its
  whole snapped group and a BUS toggle its member WIRES (the selection holds no bus of
  its own). A group only PARTLY selected completes rather than half-clearing — that is an
  answer the next click can undo.
- **The single pick is folded in** (`#selectionSets`), since it is what a
  modifier-click most often extends. Annotations are the one kind left out: they are none
  of the three sets, so the chord leaves the selection as it was.
- Refused while `#mode` owns the pointer and while the circuit RUNS (including on a
  running switch, which the press must not fall through and FLIP). A modifier-press
  starts NO drag (the wire/bus grabs stand down for it), and landing on empty desk **does
  not deselect** — an add that found nothing is not a request to clear. A press near a
  wire's END CAP toggles that WIRE (`WireTools.wireIdNear`), never the board under it: a
  cap is not a pointer target, so the wire's own click listener never runs for a press the
  board absorbed.

## Moving parts and clusters

**Option-dragging a part takes its wiring with it** (`model/part-move.js`, Feature 290).
A plain part drag re-seats the part alone, which on a WIRED part is a **silent
rewiring**: rows e/f are free in the new columns so `canPlacePart` has no reason to
refuse, every wire stays in the hole it was laid in, and the wire that fed pin 1 now
feeds pin 3. Option is the key the board drag already uses for the same idea — **Option
changes what this drag takes with it**. Shift could not be (it rubber-bands a marquee,
which is why `#onPartPointerDown`/`#onBoardPointerDown` bail on `e.shiftKey`).

- **Riding is a NODE rule**: a wire end rides when its hole is in a node (one 5-hole
  column-half, `nodeOf`) that one of the part's pins occupies, keyed per BOARD. For a DIP
  that equals "any column it spans", but not for a footprint that SKIPS columns — a push
  button at `a5` owns `c5L` and `c7L` and has nothing to do with `c6L`. GRID nodes only:
  a rail is one node for its whole length, so counting it would pick up the board's
  entire power distribution.
- **Holding Option over a selected part rings what would ride**, before any gesture
  (`setRidePreview(on)` + `#refreshRidePreview`, drawn with the shared pooled
  `HoleRings`). A wire riding by BOTH ends gets TWO rings — which is the useful part: it
  shows which ends travel and which stay. It stands down while the drag is in flight (the
  moving wires answer it better) and while the circuit RUNS. A MULTI-selection rings
  every member's riders too (deduped — two members can share a node), but only when the
  press would actually START a drag: a selection holding a BOARD refuses
  (`#beginClusterDrag`), so ringing would promise a move the app declines. Anything else
  — no selection, a selected wire, a lone annotation — rings nothing. The state is PUSHED
  IN from `app.js` rather than read off `handleKeyDown`, whose contract is "did I CONSUME
  this key" — a modifier must not. Its listeners are keydown/keyup/**blur**: a modifier
  released outside the window never fires our own keyup, and a ring left behind is a lie.
  `#refreshRidePreview` re-derives from whatever is true now and is called from every
  transition that can change the answer (selection, doc edit, drag start/end, run lock,
  scene rebuild); it costs nothing when Option is up.
- **The set is read at pointerdown and FROZEN**, as the board drag reads `e.altKey` and
  walks `matedChain` once. Recomputed per sample it would grow and shrink as the part slid
  over other wires' holes, so the drop would depend on the path taken to it.
- **Pin holes and riding holes are disjoint by construction**, which is why the two
  legality checks compose instead of interfering: a riding end is in a NON-pin row at its
  column offset (the pin's own hole is taken — one hole, one lead), and a rigid column
  shift preserves each hole's row while the footprint's pin rows at a given offset are
  fixed. So no rider can land on a hole this part's pins want, at any offset, including a
  move onto overlapping columns. `canPlacePart(…, {ignoreId})` stays as it is and
  `prepareWireBatchMove` needs no notion of the moving part; `part-move.test.js` sweeps
  the invariant rather than a comment asserting it.
- **`DeskDoc.prepareWireBatchMove` is the whole legality story**, hoisted ONCE per
  gesture: it lifts every mover out, so riders may shuffle among the holes they
  collectively vacate (a two-column shift), where a per-wire `isFreeHole` would have been
  wrong. `#resolvePartSeat` folds its verdict into the SAME `d.legal` the part's own tint
  reads — one refusal, one visual language, preview and drop derived by one function.
- **`resolved:false` refuses rather than inventing a hole**, stated generally (every
  landing address must be in a node the part occupies AFTER the move) rather than as a
  list of ways to fail, so anything the footprint vocabulary grows is caught by
  construction. **`holeAlongTo(fromType, toType, …)`** names the destination separately,
  because a part carried onto a NARROWER strip has riders whose ORIGIN column may not
  exist there (`a52` full → `a5` half); all column arithmetic stays in `breadboard.js`.
- **Bus members ride and the ribbon follows for nothing** — `WireLayer#wireEnds` is
  shared by the wire loop AND `#busGeometry`, so body moves with leads. `setPartDrag` is
  the layer's one MANY-wire preview channel, and its ends are ADDRESSES rather than
  cursor points, so the preview resolves through the path the committed wire will.
- **A routed rider translates its waypoints only when BOTH ends ride** (with one end
  pinned the user's bend still belongs where they put it). **Net names stay put** — the
  name follows the HOLE, not the signal; no other move gesture re-binds one, and a
  re-seat is not a rename.
- **ONE mutation, ONE undo step, and ONE rule for both gestures**: a solo Option-drag IS
  a one-member cluster, so `moveComponentWithWires` is `moveClusterWithWires` with the
  dragged part at the head of the placements, checked by the same `prepareClusterMove`
  predicate (which is what lets a riding LEAD, whose params change, be checked and
  committed at all).
- **A two-terminal part's LEAD rides too** (`leadsRiding` / `planRidingLead`). A resistor
  with one leg in a moving pin's column-half is connected to it exactly as a jumper in
  the next hole along is. Riding by ONE leg is a **BEND** — the other leg stays, and the
  part is rewritten into the two-free-ends form, because only that form can express one
  (a rot-0 LED therefore stands up, exactly as dragging one of its legs by hand makes
  it); riding by BOTH is a rigid translation keeping whichever form it is stored in. Only
  a `rotatable` part qualifies — it is the only kind whose leads move independently.
  **The rule closes at ONE hop**, which is why nothing recurses: a riding lead lands in
  the node its pin lands in and every other rider there travels with it, while a lead
  that stays put leaves its own node untouched. A transitive closure would pick up the
  whole circuit from one nudge. A bend the body cannot physically make is the BATCH's
  refusal (`canPlacePart`'s `minSpan`), not the plan's.
- **A rider crosses the trench with its pin, keeping the arrangement** (`holeAcross` +
  `rowsBetween`): the rider's OWN row is tried first and, only if that no longer reaches
  the pin's node, the row the PIN's own row delta puts it in — so a wire two holes from a
  part is still two holes from it afterwards, on the same side. Two candidates, not a
  search, and staying put wins whenever it works (every within-half move is bit-for-bit
  what it was). Without the second candidate a rider was stranded in the half its pin had
  just left and the plan could only refuse — which read as "there is no room over there"
  when there was plenty. Rows are counted as HOLES, not distance (`e` + 1 is `f`,
  straight across a gap three pitches wide). It is one RIGID row shift of pins and riders
  together, so the disjointness invariant survives it — a MIRROR (`a`↔`j`) would not, and
  would swap which side of the part each rider came out on. Running the wiring off the
  end of the board refuses, which is honest: dropping a row nearer the trench fits, and
  that is what the red is saying.
- **A rider follows the PIN whose node it sits in, not the part's anchor**
  (`partRideShift`, which `planPartMove` is stated in terms of). For a footprint part the
  two are the same; they part company for a rotatable part, whose pins can be on
  different strips and whose pin 1 may be on a RAIL (which owns no node at all). Per pin
  is a strict superset, so nothing about a chip's drag changed, across-the-trench refusal
  included.
- **`moves` names EVERY riding wire, always**, including one that does not actually move
  (a discrete slid along its own column-half stays in the same node). The no-op entry is
  what tells a batch check the hole is still SPOKEN FOR, which the cluster drag depends
  on, and it leaves every caller one convention instead of two. `points` takes its shift
  from the END delta rather than the anchor's, because a rider keeps its ROW and shifts by
  a COLUMN (`a5 → c7` moves riders (2, 0) while the anchor moves (2, 2)).
- **A rotatable part's BODY drag carries its wiring; its END drag does not.** A body drag
  (`drag-resistor`) moves both leads by ONE delta, so the ride rule applies unchanged, and
  the plan is told the FORM the part is landing in (`planPartMove`'s `params`), since a
  body drag rewrites a footprint-form part into the two-free-ends one. An END drag
  (`drag-resistor-end`) carries nothing: the lead lands at any hole, angle and strip, so
  there is no column delta to follow — it is a re-bend, not a move. A rot-0 LED is one
  pitch wide against `WIRE_END_GRAB_RADIUS` 0.6, so it has no body region at all and every
  press on one is an end grab; stood up (or in a cluster) it behaves like everything else.
  **Pin 1 is looked up twice**: the RAW translated point first (where the part actually
  is, and what the placement GHOST has always used), the rounded one as fallback. Rounding
  assumes a lattice and there is one only horizontally, so a spanned run's 17.52 leaves a
  rounded `dy` **0.48** off — past `HOLE_HIT_RADIUS` 0.45 — and the part could not be
  dropped on the board below AT ALL. On one board the two always name the same hole
  whenever either does, and the part is drawn from the hole it FOUND.
- **A rider with nowhere to land draws from the DOCUMENT, in red** — so the plan is
  re-derived on EVERY sample, including ones that resolve to nothing. A FOOTPRINT drag
  stops at its last good seat (a stale plan still describes the screen), but a ROTATABLE
  part is drawn at the RAW CURSOR whatever the position, so it walks away from a plan that
  stopped being re-derived — over the gap between two dovetailed boards the riders sat at
  a hole the part had long since left and jumped when it found ground again. The document
  position says the true thing instead: nothing is moving, and the red says it will not be
  dropped here.
- **Out of scope by construction**: a PSU/clock brick needs nothing — its wires end at a
  terminal address that already rides it.

**A multi-selection drags as one unit, and Option widens what it carries**
(`model/cluster-move.js` + `DeskDoc.prepareClusterMove` / `moveClusterWithWires` + the
controller's `drag-cluster`, Feature 340). Grab any member and every selected component
travels by one rigid delta; hold Option and everything riding ANY of them travels too —
the wires, and the LEADS of the two-terminal parts plugged into them (a resistor bridging
two members travels whole, one bridging a member and a fixed part bends).

- **The delta is the grabbed member's own**, resolved by the same three resolvers a solo
  drag uses (`partSeatAt` for a footprint, snap-pin-1-to-a-hole for a lead, whole units
  for a brick), so the thing under the finger behaves exactly as it would alone — clamp at
  the end of a strip included. Rounding the POINTER's travel instead cannot express the
  move that matters most (a dovetailed stack puts the board below at 17.52 pitch, so an
  integer delta could never carry a selection from one board to the next). A member on a
  board at some OTHER offset lands between holes and the drop reddens, which is honest —
  two strips at different offsets share no lattice.
- **A brick grab has no lattice of its own, so it borrows a seated member's.** A PSU's
  resolver answers in whole units — right for the brick, wrong for everyone behind it,
  since 21.02 is not whole (grabbing the brick of a selection spanning a dovetailed stack
  rounded the delta to 21 and put every seated member a fifth of a pitch off its holes).
  The brick branch offers the RAW vector to the first seated member and reports whatever
  hole THAT member lands in, so the brick still moves in whole units and the parts land
  square. A selection of nothing but bricks keeps the raw vector; one whose seated member
  lands nowhere refuses. **Both snapping branches try the raw travel before the rounded
  one**, for the same reason the solo body drag does.
- **A claim set is the all-or-nothing authority, not the rigid-translation proof.**
  `paste-cluster.js`'s argument (a rigid integer translation needs no member-vs-member
  check) does NOT carry here, because riders keep their ROW and shift by a COLUMN, so
  "parts + riders" is not a rigid body: a pure row move slides the pins two rows and the
  riders not at all, and a pin can land on a stationary rider's hole. ONE shared `claimed`
  set over every landing address — each moving pin, both ends of each wire move — catches
  that, mover-vs-mover and pin-vs-a-rider's-far-end, with no proof obligation at all. What
  survives of the paste-cluster argument is brick-vs-brick rects, which a claim set cannot
  express and which are checked as rects.
- **Two documents, deliberately.** `prepareClusterMove` builds occupancy from the doc as
  if every mover — components AND wires — were gone, since a member landing in a hole a
  travelling companion is vacating is the ordinary case (which is exactly why
  `prepareWireBatchMove`, which lifts out only wires, could not be reused). But REALNESS
  is asked of the FULL component list: `isRealPoint` resolves `psu1.+` through the
  components, and a PSU does not stop existing because it is in the air. It is hoisted
  once per gesture (`canPlacePart` rebuilds the whole occupancy index per call, which for
  N members would be N rebuilds a frame) — hence the `occupancy` option. A placement may
  also bring its own **`params`**, which is how a bending lead is judged: the check must
  see the part as it will BE, not as it is.
- **The commit validates the whole batch, then writes.** `moveComponent`, `moveBrick` and
  `moveWiresBatch` each re-check against the LIVE document, so replaying them member by
  member throws the moment two members swap holes, and `moveWiresBatch`'s wires-only
  reduction would refuse a rider heading for a hole a part is vacating.
  `moveClusterWithWires` runs the SAME prepared predicate over the whole batch and then
  writes the fields, inside the `pasteDesign` snapshot/restore — ONE mutation, ONE undo
  step.
- **A board in the selection refuses the press** and starts nothing: a strip has its own
  drag, carrying everything seated on it under overlap and mating rules a part re-seat
  knows nothing about. The selection is left intact to narrow or to grab by a board, which
  a silent collapse would have thrown away.
- **The collapse moved to the RELEASE.** A press on a member cannot call
  `selectComponent` (a single pick replaces a marquee), so a sub-threshold CLICK does it
  instead, and a `CLICK_TOGGLE_REFS` part still flips under the finger. Without that a
  click inside a selection would do nothing at all.
- **A cluster keeps a rotatable member's stored form** (a bend is measured FROM the
  anchor, so a rigid translation needs no rewrite) — deliberately different from the solo
  body drag, and the better behaviour. A part riding by ONE leg is the one case that does
  rewrite the form, because it BENDS.
- The wire layer needed no schema change: `setPartDrag`'s `shifts` map is keyed by WIRE,
  so N members' riders merge into one map; it gained only a second `overrides` argument,
  for the one thing an address cannot express (a wire ending on a MOVING brick's
  terminal). `AnnotationLayer.render`'s shift became an `anchorIds` SET, the shape
  `#shiftAnchoredAnnotations` already committed with.

## Header toolbar

**Two shapes, and no others.** A **pill** (`.toolbar-pill`) groups buttons that read as
ONE control: it carries the only border and the only background, its `.toolbar-pill-btn`
segments are separated by spacing rather than borders (there is no split-button seam
anywhere), and an armed segment FILLS instead of gaining an accent border. Everything else
is a plain `.toolbar-btn` / `.toolbar-icon-btn`. `.toolbar-btn--active` is the one class
every armed state toggles, whatever the shape. The pill is the APP's grouping shape, not
the toolbar's alone — the desktop tab strip (`.project-tabs`) is the same thing floating
over the desk, its active tab filling exactly as an armed segment does.

Three pills:

- **Desk tools** — Wire · Bus · Fade · Probe · Analyzer · Fit · **BOM** · **Schematic** ·
  **AI**. BOM lives here rather than with the file actions because it toggles a desk panel
  exactly as Analyzer does, and like Analyzer its armed state comes from the panel's own
  `onVisibilityChange`, so the segment tracks the panel however it was closed. AI is the
  same shape and the one segment DISABLED when it has nothing to offer. **Schematic** is
  the odd one: it arms no tool and opens no panel, it SWAPS THE VIEWPORT, so its icon
  shows the view it would take you TO (diagram boxes on the desk, a tie-point board on the
  schematic), the way Fit previews zoom-out-full while Shift is held. It is `Tab`'s button
  — both call app.js's one `setMode`, which owns icon, tooltip and armed state.
- **File** — New · Open · Save · Save As, all aimed at the PROJECT. Every action is its
  OWN icon-only segment rather than a row behind a ▾: they are peers, and a toolbar's job
  is to show what is available; the name + accelerator live in each tooltip. An MRU list
  still can't be a BUTTON, but it is what **Open's SECONDARY click** offers (the same
  split the tab strip's `+` uses) and what **⇧⌘O** drops, anchored under that same
  segment. That chord is the ONE file accelerator `bindShortcuts` owns rather than the
  native menu (an Electron accelerator on a submenu PARENT swallows the key without
  opening anything), which is also why it sits ahead of the typing guard — a file action
  is aimed at the app, not at whatever has focus. `ProjectWorkspace.openRecentMenu(x, y)`
  builds it from main's ONE list (`project:recent:list`, also the allowlist the open is
  checked against), asked for as the card opens rather than remembered here — main
  rewrites it on every save and open, so a copy on this side could only fall behind. An
  EMPTY list still opens a card with the same disabled placeholder the native submenu
  shows (`menu.file.noRecent`): a menu saying "nothing yet" answers the click. Each row is
  the file NAME with the whole path as tooltip (the only thing telling two projects of the
  same name apart) and carries the × `PopupManager` renders for an `onRemove` — dropping
  an entry is not a selection, so the menu stays open.
- **Transport** (`.toolbar-pill--transport`) — the one pill whose SEGMENT COUNT changes:
  stopped it holds only **Run**; running it becomes **Stop** with Pause · Step · speed
  unhidden beside it (`.toolbar-pill-btn[hidden]` collapses the rest), so it never offers
  a control that doesn't apply. Run/Stop keeps its green/red signal as colour alone — the
  pill carries the only border, so no segment accents one of its own.

**A pill segment may carry a READOUT** — the Wire button's colour dot
(`components/wire-color-dot.js`) and the Bus button's width badge
(`components/bus-width-badge.js`, `2`–`8`/`16`). A readout SHOWS the active option, and
both of today's two are also the PICKER for what they show (a small `PopupManager.popover`
— the wire dot the SAME eight swatches the wire's Properties dialog offers, the bus badge
one circled number per `BUS_WIDTHS` preset in a row). ONE contract, written once and
applied twice, which is why each is a module rather than a few lines of app.js:

- **Picking does not arm the tool** — the segment already arms when its label is clicked,
  so the readout must be the one place that doesn't, or there would be no way to set the
  pending option without entering the tool (the keyboard paths are themselves gated on the
  tool being armed). Its listener `stopPropagation()`s.
- It stays a `<span>` inside the one `<button>` (a nested `<button>` is invalid HTML, and
  re-splitting the segment is exactly what the redesign removed) and stays `aria-hidden`:
  an interactive DESCENDANT of a button has no honest place in the accessibility tree, so
  a readout is a pointer shortcut to something already reachable another way, never the
  only way.
- While the circuit RUNS it must be taken out by hand — a DISABLED `<button>` suppresses
  its own activation but still delivers a click to a descendant (measured in the real app,
  not assumed), so the readout asks the button it is in and CSS drops it from the hit test.
- The popover **closes FIRST, then reports** (the order `menu()`/`confirm()` use, so a
  callback that opens something of its own is never queued behind it), and closes even
  when the option picked is the one already active — the click answered the question.

The keyboard path is the same choice without the pointer: 1–8 set the wire colour or the
bus width **while that tool is armed**; `2`–`8` name their own width and `1` is the 16-bit
bus, since no digit spells 16 and the widest bus is worth the first key (`busWidthForKey`
in `model/desk-doc.js` owns that mapping, which is why `BUS_WIDTHS` stays in natural
narrowest-first order — the picker and the badge both walk it in that order). Either
readout sets what the tool lays NEXT and nothing already on the desk — a placed wire's
colour changes through its Properties dialog, a placed bus through its context menu.

**The parts tray is deliberately NOT in the toolbar**: it carries its own chevron in the
palette header's top-right corner and its own `.palette-flap` — a drawer pull absolutely
positioned on the desk's left edge, so a shut tray costs zero layout width — both on the
SAME vertical line, so the control reads as one thing sliding into the wall. Both, and ⌘P,
route through app.js's one `togglePalette` (the only thing that persists `paletteOpen`);
`PalettePanel.setVisible` flips the pair and stamps `.app-main--tray-closed`, which insets
`.project-tabs` past the flap. Its WIDTH is the user's: `.palette-resize` is the analyzer's
resize seam stood on end (same grip, `ew-resize`, straddling the border so it never covers
the list's scrollbar), clamped to `[180, half the window]` and persisted as
`settings.paletteWidth` — reported by the panel, written by app.js. It survives a
close/reopen for free, since shutting the tray HIDES the panel rather than rebuilding it.
The drag runs on `pointer-gesture.js`.

## Popups & menus

`popup-manager.js` (ported from Port Hippo) is the only app-wide dialog/menu seam; build
DOM with `dom.js` `el()`. `PopupManager.close()` fires a one-way `chiphippo:popup-closed`
so stateful dialogs can reset their open-guard however they were dismissed. Every callback
goes through `fire()`, which reports a throw or rejection instead of dropping it.

- Beyond `menu` / `confirm` / `prompt` / `notify` / `dialog` there is **`choose`** — the
  Cancel + N-choices shape a "save, discard, or cancel" question needs (the tab delete,
  the leave-a-project guard), where "no" splits into two different answers; its `onChoose`
  fires with `null` for every dismissal, so a caller can never miss one — and
  **`popover`**, `menu`'s positioned, non-dimming host with the caller's OWN DOM in the
  card instead of an items array. The popover card is a plain SURFACE and takes no role of
  its own (whatever goes in brings its own semantics — the colour picker is a
  `role="radiogroup"`), and never closes itself when its content is used: that is the
  content's call.
- Both POSITIONED shapes hand coordinates to `open()` as `place`, and `mount()` clamps the
  card into the viewport right after `showModal()`: a card has to be shown before it can be
  measured, and a popup QUEUED behind another mounts long after its coordinates were named,
  so placing it at request time would clamp a node that is still zero-size.
- **PopupManager QUEUES a second popup rather than stacking it** — which is why a card
  raised from inside another modal must close the first (Settings ▸ Download…), and why the
  Settings info notes are NOT popovers (see `info-button.js`).
- `menu`'s item vocabulary is `{ label, disabled, danger, swatch, icon, accelerator, title,
  submenu + emptyLabel, onSelect, onRemove }`. A card where ANY item has an `icon` gives
  every item the 16 px slot (so labels line up); a `submenu` opens as a SIBLING card in the
  same dialog (hover or click; never nested, so it can't be clipped); `onRemove` renders a
  trailing × that drops its row IN PLACE and leaves the menu open. `emptyLabel` is a
  CARD-level option (passed alongside `items` for the root card, or on the owning item for
  a submenu) — both the placeholder for an empty list and what the last `onRemove` falls
  back to. Everything is opt-in: an item with none of them renders as it always did.

## Context menus & dialogs

- **Part context menu — ONE shape for every kind.** `DeskController.#onPartContextMenu`
  builds the same three items, always, in this order: **Pin Assignment**, **Properties…**,
  **Delete Component**. No per-kind branching and no extra items — an item that doesn't
  apply stays PRESENT but `disabled` (Pin Assignment with no pins/terminals; Properties…
  with no fields; Delete while `#editingLocked`), so the menu's shape never changes, only
  its enabled state. There is no Rotate (rotating a placed, selected part is `R` only, in
  `handleKeyDown`) and no "Replace chip" (**Stop** restores every damaged chip).
- **Part Properties dialog** (`components/part-properties-dialog.js`) is the ONE shared
  modal every **Properties…** opens, enabled when
  `DeskController.#propertyFieldsFor(comp, def)` returns at least one field. **A catalog
  def declares its own editable fields as data** (`properties: [{ key, label, type,
  options }]`) and the dialog is a pure renderer over that list (one
  `buildControl`/`buildRow` dispatch per `type`) that knows nothing about any specific
  part. A future part's properties are purely a catalog change, plus one more `type` case
  only for a genuinely new control shape. Six types:
  - `"color"` — every coloured discrete (LED, `seg8cc`/`seg8ca`, `bar8`/`bar8iso`) shares
    one `LED_COLOR_OPTIONS` list of 5 and a row of swatches reusing the
    `--color-wire-<name>` tokens. Any def with a `colors` list arms placement directly with
    the "Default LED color" setting instead of a placement-time popover (`app.js`'s
    `onPickChip`).
  - `"select"` — a `<select>` over `options: [{value, label}]` (PSU volts, clock Hz). A
    `<select>`'s value is always a STRING, so `buildSelect` looks the typed option value
    back up by its stringified match rather than handing the raw string to
    `normalizeParams`, which compares by `===`.
  - `"segmented"` — the SAME options list as one bordered track (the shared
    `components/segmented-picker.js` the Settings dialog uses), which is the point: a
    wire's **Layout Method** and the app-wide default for it are ONE choice met in two
    places, so they must not be a dropdown here and a segmented picker there. Pick it over
    `"select"` for a short, closed either/or whose choices should be readable without
    opening anything. It is also the one field whose value is DEFAULTED IN by its opener (a
    direct wire stores no `layout`, and a picker still has to show something).
  - `"action"` — a full-width command button, not a value (a memory chip's "Inspect
    memory…" / "Load image… (program)"), appended by `#propertyFieldsFor` itself rather
    than the catalog since a ROM's program action is additionally gated on
    `!#editingLocked`. Clicking one closes the dialog and calls `onAction(key)` instead of
    `onChange`.
  - `"readonly"` — a value SHOWN but not edited (the PROJECT's Location, which Save As is
    what changes; a memory chip's Image file, which the programmer is); both take the
    stacked full-width row a path needs and are DERIVED, so they are supplied through the
    dialog's `values` rather than read off `params`.
  - `"wire-gauge"` — a PICTURE, not an editor (below); the one type named after what it
    draws rather than after a kind of control.
  - Like Settings, value fields apply live (`onChange(key, value)` per control change, no
    Save/Cancel). `#setComponentProperty` applies the patch via
    `DeskDoc.setComponentParams` and **remounts** the part view (`#remountPart`, not
    `updateParams` alone — a rotatable/span part only redraws through its span geometry)
    before committing through `#emitDocChanged` (coalesced) so it rides undo/redo.

## The wire gauge & the BOM cutting list

**A wire's Properties dialog ends with the WIRE** (`components/wire-gauge.js`). The jumper
is drawn across the full width of the card in its own colour, its sleeve stripped back at
both ends to bare tinned lead (`--color-chip-leg`, the token the chips' legs use — same
material), with an arrowheaded dimension line under it stating the length in centimetres.
It answers the one question the desk cannot: WHICH LEAD OUT OF THE DRAWER IS THIS — on the
desk a wire is a curve between two holes at whatever zoom the camera is at.

- **The RUN comes from the desk; the WIRE is the run plus two strips** (`wireTotalMm`). A
  lead has to reach INTO both holes, so a jumper crossing one 2.54 mm pitch is
  2.54 + 2 × `STRIP_MM` ≈ **13 mm**, not 3. The caller hands over the RUN (`runMm`) and the
  drawing adds the strips itself, so the SLEEVE covers exactly the run, the bare tips are
  the strips, and the dimension spans the lot — the length you cut.
- **ONE measurement, in `model/wire-length.js`** — pure, DOM-free, over a plain document,
  because two things state a wire's length (this drawing and the BOM) and a second
  implementation could disagree with the picture on the desk. It answers `wireRunMm` (hole
  to hole) and `wireCutMm` (`= wireTotalMm(run)`), and owns `STRIP_MM` and the ONE length
  FORMAT (`wireLengthLabel`, cm to a tenth, locale-formatted via `tf` so it reads under
  `node --test`). The run is the DRAWN shape, never the chord: the sagging curve's ARC
  length for a direct wire, the polyline for a routed one, and for a BUS MEMBER its lead +
  the whole ribbon + its far lead (a conductor in a ribbon is as long as the cable however
  short the ends sticking out are). That is why a `model/` module reaches into `desk/` (the
  sag constants are px-space, hence `PX_PER_UNIT` → `pxToMm` → `MM_PER_UNIT`, the one place
  the desk's units meet real measure) and why `ribbonWidth` moved into
  `desk/ribbon-path.js`. Live drags are ignored on purpose: a wire is measured as the
  DOCUMENT has it.
- **To scale, within reason.** The drawing is a fixed width whatever the wire measures, so
  the one thing it can be honest about is the RATIO: each `STRIP_MM` is drawn as its share
  of the whole. Two clamps — a bare end never falls below `MIN_BARE` (a tip too small to
  see defeats the reason for drawing one) and never exceeds `MAX_BARE_SHARE`, which is
  DERIVED from the shortest wire the app can hold (`STRIP_MM / wireTotalMm(MM_PER_UNIT)`)
  so it can never bind on a real one. The dimension states the truth either way.
- The dialog repaints it on a colour pick through ONE custom property (`setWireGaugeColor`
  → `--wire-color`, the same property every wire on the desk carries), so the geometry is
  untouched. This is the only thing the dialog knows about the type.
- **The BOM's `wires` section is the same measurement as a NUMBERED CUTTING LIST**
  (`wireCuttingList`, the fifth and last `BOM_SECTION_KEYS` entry — you wire after you
  seat). One line per COLOUR and CUT LENGTH, tallied ("[3] Jumper wire (red, 6.1 cm) ×3" is
  three leads to cut the same, which is how you work through a drawer), sorted by the app's
  own colour order then shortest first, and NUMBERED in that order so an item number is
  stable against everything but a change to the desk. Being one catalog entry it reaches
  the panel AND the RTF export with no second list, and it needs no netlist — a BOM is a
  fact about the desk, not about connectivity.
- **The item number is a cross-reference, and it replaced a whole tab.** Every step that
  runs a wire calls its number out (`wireItemLabel` → `[3]`, the parts-drawing convention,
  so not translated): in the SENTENCE for a power wire (`plan.step.powerWire`, one wire per
  step) and LEADING each run line of a bus/net step (`wireRunLine`), where the callouts
  form a column you read down while cutting. The numbering is derived ONCE in `makeContext`
  (`ctx.wireBom` + `ctx.wireItem`) and handed to both the BOM and the steps — two
  derivations could disagree, and a cross-reference that disagrees is worse than none.
  **The build guide therefore has TWO tabs, BOM · Steps**: the third was *Wiring*, and a
  step that names its wire AND says where it goes is that list in the order you do it in.
  The RTF export dropped its Wiring section with it. `buildWiringList` itself stays — the
  single-member-net WARNING is derived from it.

## Application menu

`main.js buildMenu()` installs the native menu: **File · Desktop · Edit · View · Window ·
Help**. Its items are one-way pushes (`menu:*` via `webContents.send`) the preload
re-dispatches as `chiphippo:*`; `app.js` hands the project/desktop ones straight to
`ProjectWorkspace` — the only side that knows what is open and what is unsaved.

- **FILE is the PROJECT's**: New Project ⌘N · Open… ⌘O · Open Recent ▸ · rule · Save ⌘S ·
  Save As… ⇧⌘S · rule · Project Properties… · rule · Bill Of Materials… ⌘B — each a
  `menu:project-*` (or `menu:build-guide`) becoming `chiphippo:project-*` /
  `chiphippo:build-guide`. **The toolbar's File pill dispatches the SAME events**, so the
  two can't drift.
- **DESKTOP** is the structure inside it — New Desktop · Duplicate · rule · Import… ·
  Export… · rule · Properties… · Delete (`menu:desktop-*` → `chiphippo:desktop-*`), every
  one aimed at the ACTIVE desktop. The tab strip mirrors it in two halves (the `+`'s two
  ARRIVALS; a tab's context menu for the rest), so the labels must stay in step — and so
  must their AVAILABILITY: **Duplicate** and **Delete** carry menu-item ids and take their
  enabled state from the renderer over **`menu:desktop-state`**
  (`{canDelete, canDuplicate}`), exactly as Edit ▸ Undo/Redo does over `menu:edit-state`.
  The workspace pushes on every change to the tab set or the run lock (`#pushMenuState`,
  from `#renderTabs` and `setEditingLocked`), and `refreshAppMenu` replays it. A menu that
  offers what the strip forbids is worse than a greyed item.
- Open Recent is the one push carrying a **payload**, so the preload passes `detail`
  through for every channel; and it is baked into the menu TEMPLATE, so main rebuilds the
  whole menu (`refreshAppMenu`) whenever the MRU changes — which is why `setEditMenuState`
  remembers the renderer's last Undo/Redo availability and replays it (a fresh template
  starts both disabled).
- **HELP** is User Guide ⌘/ · rule · Keyboard Shortcuts ⌘K · rule · Check for Updates…
  (with About and a second rule ahead of Shortcuts off macOS, where there is no app menu to
  hold it). Check for Updates is the ONE item that pushes nothing — it calls
  `updater.checkForUpdates({manual:true})` in main directly, because the result comes back
  on the `updater:*` channels regardless of who asked. It is also the one item that can be
  ABSENT rather than disabled (a store build has no updater at all), and its separator goes
  with it, since a menu must not end on a rule.
- **About** / **Settings…** push `menu:show-about` / `menu:open-settings`, re-dispatched as
  `chiphippo:show-about` / `chiphippo:open-settings`; `app.js` opens
  `components/about-dialog.js` (name/subtitle/desc + version info from `app:info:get`) and
  `components/settings-dialog.js`.

## Settings

**The Settings dialog is dumb**: it broadcasts a `chiphippo:settings-changed` patch and
`app.js`'s `applySettings` both persists it (`settings.set`) and applies it live. It is a
tabbed master-detail card (left nav rail → panels): **Appearance** (first/default — there
is no General), **Data Sheets**, **AI**, **About**.

- **`theme`** — a **segmented picker** (`components/segmented-picker.js`: a DIALOG's form
  of the toolbar pill — one bordered track, borderless `.segmented-option`s, the chosen one
  filled; shared with the Properties dialog's `"segmented"` field exactly as
  `color-swatches.js` is shared with its `"color"` field, which is why the class names
  carry no `settings-` prefix). System / Light / Dark, default `"system"`. **The one
  setting the renderer does not apply**: main turns it into Electron's
  `nativeTheme.themeSource`, and everything follows — every window's
  `prefers-color-scheme` (so theme.css's light palette reaches every auxiliary window with
  no per-window plumbing and no flash), the native menus/dialogs, and each new
  `BrowserWindow`'s pre-paint `backgroundColor` (`windowBackground()`). The
  `:root[data-theme]` blocks in theme.css stay as a manual override only.
- **`selectionColor`** (`#rrggbb` or null → the `--color-selection` custom property
  `.board-outline-path` strokes with, falling back to `--color-accent`).
- **`defaultLedColor`** (one of `LED_COLOR_OPTIONS`, default `"red"`) and
  **`defaultWireLayout`** (Direct / Routed, default `"direct"`) — both **not live-apply**,
  read only at placement time (`applySettings` just keeps
  `DeskController.setDefaultWireLayout` current).
- **`fontSize` — ONE BASE, AND EVERY OTHER SIZE DERIVED FROM IT**
  (`web/scripts/font-scale.js` + the type scale in `theme.css`). Six steps
  `11 · 12 · 13 · 14 · 16 · 18`, default 13, a segmented picker under Language, plus
  **⌘= / ⌘− / ⌘0**. theme.css derives the whole ramp off `--font-size`
  (`-xs`/`-sm`/`-lg`/`-xl`/`-display`) **additively** — a UI step is one pixel at every
  base, so a caption stays exactly one step under its label however large the app is set,
  and the shipped 13 reproduces the original values exactly. The two small ranks carry a
  `max()` FLOOR (chrome text stops being readable below a size); nothing is capped at the
  top, the direction the setting exists for. `--header-height` / `--control-height` /
  `--toolbar-height` / `--segment-height` derive from it too, on the law that **a box is
  ONE LINE OF TEXT PLUS CONSTANT CHROME** — the px term is the padding, not the box — so a
  control grows with its text instead of clipping it. (The toolbar gets its own pair
  because a row of mixed text and icon buttons has to stay FLUSH: sized by content, the
  text ones would grow and the icon ones would not.)
  - **Only chrome scales.** The desk's own type is stated in SVG **user units** (one unit =
    one pitch) — `.part-chip-label`, `.board-row-label`, `.bus-band-label`, every
    `font-size` ATTRIBUTE `schematic-view.js` writes — plus `.annotation-text` /
    `.annotation-editor` (document content inside the zoom-scaled layer) and
    `.wire-gauge-length` (a viewBox's own coordinates). All of it stays literal: it is
    printed ON THE CIRCUIT, it scales with the camera, and a screen-pixel token there would
    slide a label off the part it names and make one saved desk read differently on two
    machines. `tests/type-scale.test.js` is the ratchet, since a bare px looks completely
    normal and renders perfectly at 13; every exemption is a SELECTOR with its reason,
    checked in both directions so a stale one fails too.
  - It is the **third** setting main acts on and the only one with nothing native to ride
    (there is no font-size `nativeTheme.themeSource`), so `settings:set` fans `fontSize`
    out itself as `settings:font-size` → `chiphippo:font-size-changed`, to every window BUT
    the sender (which already applied it) and by `getAllWindows()` rather than the aux
    registries, so a later window type follows for free. The three auxiliary renderers only
    ever follow, hence `followFontSize(bridge)`: one awaited line each, before they paint.
    `MemoryInspector` is the one place the size feeds ARITHMETIC rather than layout (its
    grid is virtualized, so `#rowH` decides how many rows exist and which one a scroll
    offset lands on) — it measures `--font-size` at construction and `refreshMetrics()`
    re-measures on the push; under `node --test` there is no stylesheet, so it falls back to
    the shipped 22.
- **The app has two scales and Option is the whole difference**, which is why ONE pure
  `scaleStepForEvent` decides both rather than two modules that could drift: **⌘=/−/0
  resize the app's TEXT**, **⌥⌘=/−/0 zoom the desk CAMERA**. Bare ⌘ is the text because
  that is what a reader who cannot see the screen reaches for first, and the desk already
  has a zoom cluster, a Fit button and the wheel. Both are matched on **`e.code`** — the
  one place in the app that cannot use `e.key`, because with Option held macOS reports the
  alt-layout CHARACTER (`⌥=` is `≠`, `⌥-` is `–`, `⌥0` is `º`), so a key-name match would
  make the DESK pair silently never fire. The block sits AHEAD of `bindShortcuts`' Cmd gate
  (which discards every Alt chord) and ahead of the typing guard, but UNDER the
  `PopupManager.isOpen()` guard: a dialog owns the keyboard, and Settings is precisely the
  one that would be open, where its own picker would then show a size the app had stopped
  using. A font step that saturates changes nothing and says nothing — the resizing is the
  feedback. NOTE macOS's own Zoom binds `⌥⌘=`/`⌥⌘−` when *Use keyboard shortcuts to zoom*
  is on and takes them first, which costs the DESK zoom rather than the text size (the zoom
  cluster and ⌘F are its other routes).
- **Data Sheets** drives **`datasheetDir`** (the external datasheet-PDF folder, default
  null; Browse calls the native `settings:choose-datasheet-dir` picker, exposed as
  `settings.chooseDatasheetDir`), with no live apply (the pinout window reads it at open
  time). Beside it **Download…** FILLS that folder (below); both end in the same one-line
  patch, and nothing downstream knows which button produced it.
- **AI** drives the NON-SECRET half (`ai: {provider, baseUrl, model}`, emitted WHOLE as an
  object-valued setting) and is the one panel built asynchronously — its picker comes from
  `ai:providers`, so it cannot drift from `app/ai/providers.js`. Its API-key field is the
  ONE control that bypasses `#emit` entirely, calling `ai.key.set` directly.
- **About** is the updater's UI and the one panel with LIVE state: the version from
  `app:info:get`, **`autoUpdateCheck`** as a segmented On/Off (default Off), a Check
  button, and a status line fed by the `chiphippo:updater-*` broadcasts — whose listeners
  belong to the dialog's OPEN lifetime, so `buildAboutPanel` hands back a `dispose` that
  `onClose` runs.
- Window bounds and the desk camera (incl. zoom) are already persisted in `settings.json`
  (`windowBounds` via `window-state.js`; `viewport` via the renderer's debounced save).
- **Every explanatory note is behind an (i), not printed under its row** (`rowWithNote()` +
  `components/info-button.js`). Eight of them across the four tabs, several a full
  paragraph, turned each panel into more prose than settings. The note FLOATS over the rows
  below rather than pushing them down (a note that reflowed the panel would move the very
  control the reader is about to reach for), which is why it is a CHILD of its
  `.settings-row` (`position: relative`) rather than its sibling — hiding a row takes its
  note with it (a store build hides two). It is deliberately **not** a
  `PopupManager.popover` (PopupManager QUEUES, so a card raised from inside the Settings
  modal would not appear until Settings closed), hence `info-button.js` — un-prefixed and
  shared, as `segmented-picker.js` and `color-swatches.js` are, because the About dialog's
  version details are the same control. **Escape is the whole reason it is a module**: both
  callers sit inside a native modal `<dialog>`, where Escape fires `cancel` and closes the
  WHOLE card, so the keydown is caught in the **capture** phase and `preventDefault`ed —
  the first Escape closes the note, the next closes the dialog. A click outside and the (i)
  again also dismiss it, and the listeners self-remove if the card's dialog is torn down
  while it is open. The target's `hidden` attribute is the single source of truth. The one
  note NOT behind an (i) is About's store-build message, which is the only thing on that
  panel (it explains why every control above it is gone).
- **One CSS rule the whole card depends on**: a settings element that sets a `display` of
  its own must be listed in the shared **`[hidden]`** rule beside `.settings-panel`,
  because a class selector outranks the UA sheet's `[hidden] { display: none }`. Without it
  `el.hidden = true` sets an attribute that changes nothing — which is exactly how Data
  Sheets came to offer a **Clear** button with no folder to clear. `.settings-note` is on
  that list (it sets `display: flex`).

## Auxiliary windows

Each is its own sandboxed renderer using the ONE shared `preload.js` (Chip Hippo has one
bridge, not Rest Hippo's per-window narrow preloads), awaits `i18n.init()` and
`followFontSize(bridge)` before painting, and — except the docs window — is closed by
`closeAuxWindows()` on New/Open.

**Pin-assignments window** — **Pin Assignment**, the item leading every part's context
menu (`#onOpenPinout(ref, rows, rot)` → `pinout:open`), opens `web/pinout.html` →
`scripts/pinout.js` rendering `components/chip-pinout.js`'s `buildPartPinout`. One builder
per catalog shape: DIP chips → the physical two-column diagram; discretes → a linear pin
list keyed to anchor-hole offsets; PSU/clock bricks → a terminal map. One window per ref
(re-open focuses); `alwaysOnTop` by default, with a native right-click menu toggling that
for every open pinout and persisting it as `settings.pinoutFloat` (a de-facto global). Pure
DOM, no modal chrome — the native frame owns the title bar and close. It is offered even
while the circuit runs (the pin map is read-only; the example button is not, but adding a
desktop stops the run exactly as switching tabs does).

- Every pinout is at least **`PINOUT_MIN_WIDTH`** (500 px) and the plain default sits ON
  that floor: a pin line is `badge · name · role` against a right-aligned detail, so a
  narrower window reads as two unrelated columns rather than one row. Main widens it (640)
  when a datasheet crop exists; the `<img>` loads lazily and its `<figure>` removes itself
  on error.
- The header's top-right carries two line-drawn buttons, one box with two glyphs
  (`.pinout-header-btn`, one CSS rule) — and they are the only two reasons this otherwise
  bridge-free window loads `preload.js`:
  - **datasheet PDF** (`datasheetButton`, shown when main flags `?pdf=1` because
    `settings.datasheetDir` holds a `<ref>.pdf`) → `datasheet:open` → `shell.openPath`.
    Independent of the committed PNG crop: either, both, or neither may exist.
  - **example circuit** (`exampleButton`, shown when main flags `?demo=1`).

**Memory inspector** — see "Memory chips". **Docs window** — see "User guide & docs".

## Downloading the datasheets

`app/datasheets/sources.js` + `app/datasheets/download.js` +
`components/datasheet-download-dialog.js`. Settings ▸ Data Sheets ▸ **Download…** fills the
folder the tab points at, so the external-PDF button works with nothing for the user to
find or name.

- **The renderer names no URL and no path.** It asks for "the datasheets" and is told where
  they landed; the ref → URL table is hard-coded in MAIN — a download button must not
  become a way to make the app fetch something arbitrary.
- **The table is hand-written, never derived**: a part id is not a file name anywhere in
  the world (the '86 is `sn74ls86a.pdf`, the '139 lives inside the '138's file, WDC ships
  the '02 as `W65C02s.pdf`), so guessing a vendor's naming buys a silent 404 per part. It
  is **ONE BLOCK PER LIBRARY**, each owning its `base` with its parts' paths RELATIVE to it
  — that is the whole extensibility story: a part whose datasheet lives on another host is
  a line in a new block, never a special case in the downloader. A block need not hold a
  DATASHEET: Zilog's entry is the Z80 family USER MANUAL (`um0080.pdf`, ~1.6 MB), which is
  why it is named for a document number and why it is the one entry most likely to time out
  (45 s per request).
- Vendor naming bites both ways and both are in the table: TI files a sheet under the
  DEVICE it was written around, so the revision suffix is part of the name ('73A, '107A,
  '257B) and the '01 lives under its 54-series sibling; Microchip's `docNNNN` numbers say
  nothing about the part, and several exist per part (doc0258 is the '16-T, TSOP-only,
  against doc0540's mainline '16 with the DIP-24 this catalog seats). A source is therefore
  VERIFIED — opened, and its part number and package read (by RENDERING page 1 where the
  file is a scan with no extractable text, which is how the '83 was confirmed as Motorola's
  SN54/74LS83A and not the '283 that replaced it) — before it is written down, and its host
  is chosen for one that ANSWERS A PROGRAM rather than only a browser: distributor mirrors
  and some vendor front-ends sit behind bot protection and return a 403, or an HTML
  challenge with status 200, so `ww1.microchip.com` is used and not the
  `www…/content/dam/…` path the site itself links. Every block is a manufacturer's own file
  server bar one — the '83's, an archive, which is the link expected to rot and which the
  run reports by name rather than hiding. The one entry whose KEY is not its part number is
  `AS6C1024` (Alliance Memory call it the AS6C1008): the sheet is right, the catalog id is
  what is off, and a ref is stamped into saved documents, so correcting it is a migration
  rather than a rename.
- The escape check is **per entry**, against the library it was declared in (`base` rides
  along on every flattened source) — an absolute URL pasted into a `parts` block is exactly
  what it is for. The table is **deliberately partial**: a part with no entry is not
  downloaded. `tests/datasheet-sources.test.js` holds every KEY against the real catalog
  (imported, not copied — a ref typo is invisible, since the PDF downloads fine under a name
  the `<ref>.pdf` lookup will never ask for), holds each library to an `https://…/` base (a
  base with no trailing slash makes `new URL` drop its last segment, turning the whole block
  into 404s that read like the vendor moved their files), and forbids two blocks claiming
  one part (the flatten would silently keep the later copy).
- The destination is the app's OWN `userData/datasheets/` (a sibling of `memory/`), never a
  folder the user picked — the run REPLACES what it finds, and a button that overwrites
  files may only be aimed at a directory the app made. Fetching is **sequential** (the point
  is the `n/TOTAL` count, and a counter that jumps is worse than one that takes longer) and
  every body is checked for the `%PDF` magic before it is written, because a host that
  answers a missing file with a friendly HTML page and status 200 would otherwise land
  `74LS00.pdf` as something that opens as garbage.
- Progress is a one-way `datasheet:progress` push (→ `chiphippo:datasheet-progress`),
  separate from the `datasheet:download` invoke that resolves with the summary, exactly as
  `ai:delta` is separate from `ai:start`. The dialog REPLACES the Settings card
  (PopupManager queues, so the caller closes Settings first), DISMISSING IT CANCELS (it is
  the run's only user interface), and it NAMES the parts that failed — "38 of 41" without
  saying which three leaves the user to diff a folder by hand.

## Example circuits

Every benchable 74xx part's demonstration bench, shipped INSIDE the app as
`src/web/demos/<ref>.json` and offered as a button on that part's pin-assignments window.

- **One build, two outputs**: `make-gate-demos.mjs` writes each desktop into its group
  project (`demos/<Group>.chiphippo`) AND on its own into `src/web/demos/`, from the SAME
  `buildDemo(spec)` call, and `gate-demos.test.js` holds them to byte-for-byte agreement.
  Minified (nobody reads that one) and pre-**CENTRED** on the origin by `demo-build.mjs`'s
  `centreDocument` — which is load-bearing, not tidy: `fitToScreen` RECENTRES as well as
  frames, so an uncentred example would put a "recentre desk" undo step at the top of a
  brand-new desk's history and the user's first ⌘Z would slide the circuit off-centre.
  Centred, the fit finds a zero delta, returns before `#emitDocChanged`, and is pure
  camera. The directory is **SWEPT** every run: a chip dropped from the catalog must not
  leave a document behind that still puts a button on a pinout window. Per-chip rather than
  per-group because it makes "does this part have an example?" an `fs.existsSync` — main
  answers with no catalog knowledge and no JSON parse.
- **Two channels, because there are two windows and only one can use the bytes**: a PINOUT
  window has a ref and nothing else, so it asks (`demo:open`) and main RELAYS
  `demo:host-inbound` to the app window after raising it (the pinout is `alwaysOnTop`, so
  an unraised desk would land behind the click); the APP window then READS the document
  (`demo:read`) itself, so the bytes cross the bridge once, into the window that will hold
  them.
- `ProjectWorkspace.openExample(ref)` is `importTab` with the file picker swapped for that
  read: an ADDITION, reseated through `desktop.duplicate` (no shipped example carries a ROM
  today, but "two chips can never share a guid" must not have a door in it), landing as
  `<ref> example`. Asking twice **switches** to the desktop already holding it — the tab
  NAME is the whole identity test, which is also its cost (rename it and the next ask brings
  a fresh one, the honest answer since the v4 schema keeps no per-tab marker a rename could
  not erase). An in-flight map keyed by ref makes a double-click ONE desktop (the name check
  and the insert are separated by awaits). The answer is three-valued
  (`"added"`/`"switched"`/null) because a NEW example desktop is centred, framed and left
  CLEAN while one already open is none of those — its camera and whatever the user has made
  of it are theirs. Clean is the deliberate half: looking an example up is not work to keep
  or throw away, and it must not put a save-or-discard question in front of the next New or
  Open. Editing it is an unsaved change like any other.
- Memory/Interface/PROCESSOR chips get no example and therefore no button: a RAM or a CPU
  cannot be demonstrated by flipping switches at it, and the 65xx demos are excluded for a
  sharper reason — their program lives in a separate `.hex`, so the document alone would
  arrive not working.

## Auto-update & the store gate

`app/updater.js` + `app/store-build.js` + `components/updater-monitor.js` + Settings ▸
About. A thin wrapper over `electron-updater`'s `autoUpdater`, pointed at the GitHub
Releases feed the Release workflow ALREADY publishes (`latest*.yml` has been uploaded
beside every installer since the workflow was written), so nothing about releasing changed
to turn this on.

- **Nothing restarts without consent**: an update downloads in the background and installs
  on a normal quit (`autoInstallOnAppQuit`) or through a clicked `quitAndInstall()`, which
  still runs main's ordinary before-quit guard, so an unsaved project is asked about first
  and a cancelled quit leaves the update for next time.
- **The updater ANSWERS; it does not decide what to say.** Every lifecycle event is a
  one-way `updater:*` push re-dispatched as `chiphippo:updater-*`, and the renderer owns
  every word: `UpdaterMonitor` (always-on toasts, session-long, ONE shared toast key so the
  stages of one update replace each other rather than stacking) and the About panel's
  inline status line (dialog-lifetime, hence its `dispose`). Each push carries **`manual`**
  — main's record of whether a human pressed the button — because the difference between
  "you're up to date" and silence is entirely whether it answers a question that was asked.
  A `reason` (`"store-build"`/`"dev-build"`) rides on not-available, so a build that CANNOT
  update reports a fact rather than an error. `download-progress` is deliberately never
  forwarded: there is no progress bar to feed.
- **A store build is gated at RUNTIME, never by branching the build** (`store-build.js`, the
  only place that reads Electron's `process.mas` / `process.windowsStore`). The MAS updates
  its own apps, electron-builder strips the feed from a MAS package, and the sandbox forbids
  an app replacing itself — so `checkForUpdates` short-circuits, the Help item is absent
  rather than disabled, and About hides its controls and says why. The renderer learns this
  from **`app:info:get`'s `distribution`** rather than a bridge flag of its own: main is the
  side where `process.mas` is unambiguous, and the panel already awaits that object.
- **The check is OPT-IN** (`autoUpdateCheck`, default false) — an outbound call, and Chip
  Hippo makes none unasked. Off still leaves both manual routes working; on adds one delayed
  check ~10 s after launch, off the busy launch path. **`require("electron-updater")` is
  deliberately LAZY** (inside the functions, not at module scope): reading the getter
  constructs the platform updater, which dereferences Electron's native `autoUpdater` —
  absent under `node --test`, where `main.js` is read but never run.

## Mac App Store packaging

`src/packaging/` + the `mas`/`masDev` blocks in `src/package.json` + `make mas` /
`make mas-dev` + `app/store/bookmark-store.js`. ONE codebase down every channel: a store
build is the same code with `store-build.js`'s runtime gate turning the updater off.
`make mas` signs a universal `.pkg` (Apple Distribution for the app, 3rd Party Mac
Developer Installer for the installer) and `make mas-dev` a locally-runnable sandboxed
build to try first; both SKIP with a message and exit 0 when their git-ignored
`src/packaging/*.provisionprofile` is absent, so a fresh clone still builds everything else.
See STORE-PUBLISHING.md for the submission itself.

- **The sandbox forgets every launch, and two features depend on remembering.** A sandboxed
  app may touch a path only if a native dialog handed it over in THIS process — which breaks
  Open Recent (`settings.recentProjects`, read again at `bootProject` and
  `openRecentProject`) and the external datasheet folder (`settings.datasheetDir`). The
  answer is **security-scoped bookmarks**: minted by the dialog that granted the path
  (`dialogOpts` + `captureOpen`/`captureSave` — note the save panel's SINGULAR `bookmark`
  against the open panel's array), redeemed through `withAccess` for a one-shot read or
  `hold("project", …)` for the open project's whole session, and stopped on `will-quit`.
  They live in a MAIN-ONLY sidecar (`userData/bookmarks.json`), never in `settings.json`
  (handed to the renderer whole on every read), and there is **no IPC channel and no preload
  export at all** — `ipc-parity.test.js` is untouched and the renderer never learns bookmarks
  exist. `knownPath` is unchanged and unbypassed: it answers whether the RENDERER may aim
  main at a path, a bookmark answers whether the KERNEL will allow it, and both must say yes.
- **A scope is PROVED, not assumed — and this was got wrong once, expensively.** Electron
  hands back a stop function, not a resolved path, so a dead blob and a live one are the same
  value at that line. The original reasoning was that every caller's next `existsSync` would
  answer false for anything unreachable. **IT DOES NOT**: the App Sandbox answers metadata
  questions about paths it refuses to open, so `existsSync` returns TRUE for a file that then
  raises `EPERM`. Worse, the commonest bookmark in the app is stale BY CONSTRUCTION — a SAVE
  panel with `securityScopedBookmarks` creates a blank file and mints a bookmark against it
  that never resolves again (**electron/electron#32544**, open upstream since 2022) — so
  every project created with Save As failed to reopen on the next launch with a raw `EPERM`
  in a dialog. So `_start` VERIFIES the scope it just obtained with the read the caller is
  about to do (`readable` — a `readdirSync` for a directory, an `openSync` for a file,
  because those are the calls actually made; `existsSync`/`accessSync` are the ones that
  lie), stops and drops a blob that fails, and `canAccess` lets a caller tell **gone** from
  **denied**. They need opposite offers, which is the whole point of splitting them: a file
  that moved is forgotten, a file merely out of reach is **re-granted** through
  `project:regrant` — an OPEN panel aimed at that exact path, whose bookmark does survive, so
  the repair is permanent and asked once per project rather than once per launch. The panel's
  answer is checked against the path asked about: picking a different file is refused, never
  reinterpreted, or a permission prompt would become an open-any-file gesture that skipped
  the MRU allowlist.
- **`atomicWrite` cannot be atomic in a store build, and that is not a bookmark problem.**
  `io.js` writes `<file>.chiphippotmp-N.tmp` beside its target and renames over it; a save
  panel's grant covers the chosen FILE, not the folder holding it, and that temp name is not
  in the same-basename form the sandbox forgives as a related item. So under `isMas()` ONLY,
  and only after a genuine `EPERM`/`EACCES`/`EROFS`, it falls back to a durable in-place
  write — a direct build's atomicity is byte-for-byte what it was. The cost is real and
  stated where it is paid: a store build's writes to USER-CHOSEN files are no longer
  crash-atomic. Everything the app owns is under `userData`, inside the container, where the
  atomic path still works — including the 30-second autosave slot, so the work is still
  recoverable.
- **`mas-dev` deliberately does not pin `CSC_NAME` the way `mas` does.** electron-builder
  applies one name qualifier to BOTH the `.app` and `.pkg` identity searches, so `mas` pins
  the substring common to *Apple Distribution: Jason Figge (2C564TQ2FY)* and *3rd Party Mac
  Developer Installer: …(2C564TQ2FY)* — anything more specific finds no installer certificate
  at all. The development profile embeds *Apple Development: Jason Figge (F457H24AUH)*, whose
  parenthetical is a per-developer identifier, NOT a team id and NOT a mismatch (both are
  under `2C564TQ2FY`, the cert's OU field) — but it is enough for the pin to filter out the
  one certificate that profile authorizes.
- The entitlements are five keys and no more (`entitlements.mas.plist`, committed and
  commented): `app-sandbox`, `cs.allow-jit`, `files.user-selected.read-write`,
  `files.bookmarks.app-scope` — **without which the dialogs return EMPTY bookmark strings and
  the two features above quietly stop working a launch after install** — and `network.client`
  for the AI builder and the datasheet download. `app/tests/packaging.test.js` holds the
  config to them, and to their absences (`disable-library-validation` is forbidden under the
  sandbox; `network.server` would ask for something nothing listens on), on every platform
  and with no Apple material present.

## Language support

The app speaks **English, German, Spanish, French, Italian, Japanese and Chinese
(Simplified)**, chosen in Settings ▸ Appearance ▸ **Language** (or left on *System*). One
JSON catalog per language under `src/web/locales/`, and **`en.json` is the REFERENCE**:
every other file must cover its leaf keys exactly.

- **MAIN resolves the locale for the whole app** (`app/i18n.js`). It owns the filesystem the
  catalogs live on and the OS locale they default from, and every window is `file://` under
  a CSP with no `connect-src` — so a renderer cannot read or fetch a catalog, and this is
  the only route one can travel. The order is `settings.locale` (unless `"system"`) →
  `app.getLocale()` → English; a language with no shipped catalog falls back to English
  rather than failing. `readCatalog` validates the subtag against `^[a-z]{2,3}$` before it
  touches a path, which is what stops a crafted locale escaping the locales directory. Each
  renderer asks ONCE over **`i18n:load`**, whose payload is
  `{active, lang, messages, fallback, locales}` — the English catalog always rides along as
  the fallback, and the shipped-language LIST rides along too (from the same `LOCALES` table
  the reader resolves against) so the Settings picker can be built synchronously and can
  never offer a language with nothing behind it.
- **The renderer's seam is `t()`** (`web/scripts/i18n.js`): dotted keys against the nested
  catalog, `{name}` interpolation, CLDR plurals through `Intl.PluralRules` when a numeric
  `count` is passed, and the chain active → English → **the key itself**, so a missing
  string is visible rather than blank. `app.js` awaits `i18n.init()` **before anything
  renders**; so do `pinout.js` and `memory.js`, each its own sandboxed renderer, with a
  top-level `await`. **NEVER call `t()` at module scope** — the catalog is not loaded yet,
  and a top-level call freezes the English key into a module constant. That is why every
  options list that used to be a `const` (`THEME_OPTIONS`, `SHORTCUT_GROUPS`, …) is now a
  function.
- **`tf(key, fallback)` is `t()` for a string whose English lives somewhere else.** The
  parts CATALOG is pure data evaluated at import time, so its `title`/`label` fields cannot
  be `t()` calls — and they are not only UI text either (the BOM export,
  `scripts/demo-specs.mjs` and the catalog's own integrity tests read them under Node). So
  the English stays there as the DATA, the translations live under `parts.*` / `boards.*`,
  and **`catalog/labels.js`** is the one place that resolves them (`partTitle`, `kitLabel`),
  falling back to the def's own English rather than to a raw key, so a part added without an
  entry reads correctly, just untranslated. `model/wire-colors.js` is the same shape for the
  eight stored colour TOKENS (`wireColorName` / `wireColorLabel`) — the token is what a
  document stores and what CSS suffixes; only the word shown is translated.
- **MAIN renders text itself in three places no `t()` can reach** — the application menu,
  each auxiliary window's title bar, and the native dialogs' file-type filter names — so it
  keeps the resolved catalog to hand and reads those through **`m(key, fallback)`**. The
  payload is cached (the menu is rebuilt on every recent-list change, ~30 labels a time) and
  `settings:set` drops the cache when `locale` moves, which is what makes a language change
  reach the menu bar with no restart. **`--hot-reload` drops it too when the changed file is
  under `locales/`**: that cache is process-lifetime, so a window reload alone re-asked
  `i18n:load` and got the catalog read at LAUNCH — a string added mid-session rendered as
  its raw dotted key however many times the renderer reloaded, which reads like a bug in the
  code that asked for it. Cut/Copy/Paste stay native ROLES (Electron supplies the OS's own
  word, which beats anything this catalog could say). `PROJECT_FILTERS`/`DESKTOP_FILTERS`
  became FUNCTIONS for this — a `const` is evaluated at require time, long before `app` is
  ready.
- **A language change is applied IN PLACE, because nothing here reloads the window** (an
  unsaved project lives only in memory; a reload to change a label would throw the user's
  work away). `app.js`'s **`relabelChrome`** re-applies the header, both pills, the transport
  and the window title, and calls `relocalize()` on the palette, tab strip, build guide,
  analyzer, AI panel, zoom cluster, desk padlock and schematic. Only PERSISTENT chrome needs
  it: every dialog, context menu, popover and notification is built when it opens and
  therefore speaks the current language for free. Three of the calls are relabel functions
  the app already had for their own reasons (`setMode`, `updateLocateIcon`,
  `onTransportChange` each own a button whose label depends on state, so re-running them
  unchanged IS a relabel). It ends by dispatching **`chiphippo:locale-changed`**, fired only
  AFTER `i18n.init()` has re-read the catalog, so a listener can rebuild in the language it
  is being told about.
- **The Settings dialog is the one dialog that relocalizes itself**, and for one reason: the
  Language picker is INSIDE it, so it is the only card that can still be on screen when the
  language changes, and leaving it in the language just left makes the setting look like it
  did nothing. It listens for `chiphippo:locale-changed` for its OPEN lifetime (the rule the
  About panel's updater listeners follow, dropped in the same `onClose`) and **closes and
  reopens itself** rather than re-labelling in place: the header, nav rail, every row and the
  asynchronously-built AI panel are all `t()` at build time, so a relabel path would be a
  second hand-maintained copy of the whole card that could silently fall behind it.
  `PopupManager.close()` runs `onClose` synchronously — dropping the listener and clearing
  the open guard — before it drains the queue, so the reopen mounts cleanly. Two pieces of
  state survive and both are load-bearing: `#settings` (the dialog's own copy, patched by
  every `#emit`, so the picker shows the language JUST CHOSEN rather than springing back)
  and `#tab` (so the user is put back on the panel they were reading — a FRESH open still
  starts on Appearance, and `#relabelling` is what tells the two apart).
- **Identity is never translated.** A palette section's English name stays its
  collapse-state key and its grouping key (`sectionLabel()` shows the translation;
  `#toggleGroup` is still called with the English), or a section would forget whether it was
  open the moment the language changed. A BOM line's tally key is built from stored tokens,
  so a language change can never split or merge a row — a WIRE line's is its colour token
  plus whole MILLIMETRES, which is also exactly the precision shown, so two wires that
  display the same length cannot land on different rows. The `<ref> example` tab name is the
  example's whole identity test, so it stays English. `Desktop N` IS translated — it is a
  default NAME, data from the moment it is created, like any name the user types.
- **Deliberately English**, each because it is reference material or protocol rather than
  the application's own words:
  - the **user guide** (one Markdown source drives three outputs, so `docs-viewer.js`'s
    chrome stays English to match the pages it lists — Settings says so);
  - a part's **`blurb`** and the pinout window's per-pin **`detail`** text and `ROLE_TAG`
    abbreviations — datasheet prose about the part. The rule is statable: *short names and
    labels are translated; per-pin and per-part datasheet descriptions are not.*
    `partBlurb()` exists anyway so that decision has exactly one place to be revisited;
  - the **AI ladder's fault messages** (`autobuild.js`, `autobuild-verify.js`,
    `generate.js`) — `buildRepairMessage` sends them BACK TO THE MODEL as the repair
    instruction, and the system prompt and catalog card they answer are English by
    construction. Translating them would degrade the repair round; the panel shows each
    beside a fault CODE, which is what the user acts on. The ladder's own progress labels
    ARE localized (`ai.gate.*`);
  - the product name, the copyright line, format names (SVG/PNG/Intel HEX), "ASCII", and
    every keyboard glyph (⌘, Tab, Esc, W) — the modifier already varies by PLATFORM, never
    by locale.

### The guards (`make test-i18n`, and part of `make test`)

Five tests, and the point is that an i18n regression is otherwise **invisible**: `t()` falls
back to English, so a missing translation looks like a proper noun and a hardcoded literal
looks like a translation that happens to match.

- **`web/scripts/tests/i18n-catalogs.test.js`** — holds every locale to `en.json` in the
  four ways a translation silently goes wrong (missing key; lost `{placeholder}`, which
  renders as a gap; broken plural shape; empty value, which renders as nothing) and the
  three ways the CODE drifts from the catalog: **a key the source asks for that does not
  exist** (`t("zoom.out")` renders the text `zoom.out` — a real bug this caught on its first
  run), **a `tf()` FALLBACK whose `{placeholders}` differ from its own en.json entry's**,
  and **a catalog part, board kit, group or colour token with no entry**. Coverage must be
  EXACT in both directions: an extra key is a rename left behind, i.e. a translation nothing
  will ever read. The fallback check is the subtle one — `tf()` PREFERS the catalog, so
  adding a placeholder to the fallback and forgetting the catalog silently drops the value
  at runtime (a wire step shipped without the BOM item number it exists to quote), and the
  locale-parity check cannot see it because en.json was the stale one.
- **`web/scripts/tests/no-hardcoded-strings.test.js`** — the complement: a display literal
  that never entered the catalog at all. It scans the assignment forms (`textContent`,
  `title`, `placeholder`, `setAttribute`) and, most valuably, the **UI-bearing object
  properties** (`label:`, `message:`, `confirmLabel:`, …) that are how `el()` and every
  PopupManager dialog RECEIVE their text. It is a ratchet over
  `no-hardcoded-strings.baseline.json`, which **is currently empty**, so there is no debt to
  shrink (regenerate with `UPDATE_HARDCODED_BASELINE=1`). Every exclusion in
  `SKIP_FILES`/`INTENTIONAL` carries its reason in place, because an exclusion is a stated
  decision and not somewhere to put an inconvenience.
- **`app/tests/no-hardcoded-native-strings.test.js`** — the same for main, whose strings the
  renderer scanner cannot see. A localized call reads
  `label: m("menu.file.new", "New Project")`, so its English sits as the FALLBACK ARGUMENT,
  invisible to the rules; drop the `m()` wrapper and the literal lands right after the key
  again and this fails. Its second half is the converse — that the menu really is built from
  ~30 `m()` calls and that every key exists, since a wrong key silently makes the fallback
  the only thing anybody ever sees.
- **`app/tests/i18n.test.js`** (resolution order + path safety) and
  **`web/scripts/tests/i18n.test.js`** (the `t()`/`tf()`/plural/format contract).
- `tests/jsdom-setup.js` installs the REAL `locales/en.json` for every component test, so
  the existing English assertions both keep working and start exercising the catalog: a key
  deleted from `en.json` now fails the test that reads it.

**What the guards still cannot see, and the answer to it.** Both scanners match a UI-bearing
property followed by a **quote**, so a string built with a TEMPLATE LITERAL or chosen by a
TERNARY in the same position is invisible — which is how a set of leaks survived every green
run (the desk's own hover tooltip, the most-read string on the desk; the part Properties
dialog's title, which also reached past `partTitle()` to the def's raw English source; the
annotation ghost's "Note"/"Label" while `palette.annotation.*` sat unused; the AI token
readout in `ai/usage.js`; and three hardcoded `"Untitled"`s beside an existing
`common.untitled`). A whole-FILE exclusion hid one more: `autobuild-verify.js` is skipped
for its fault messages, and the L7 progress label was sitting inside that exclusion
untranslated while its own stated reason said the ladder's progress labels were localized.

Widening the regexes to reach inside a template is **not** the fix — it would match every
interpolated identifier in the app. The answer is **a test that RENDERS**: install a stub (or
real) catalog with `applyCatalog`, call the thing, and assert the catalog's words came out
(`part-geometry.test.js`, `part-context-menu.test.js`, `ai-usage.test.js`,
`autobuild-verify.test.js`, `settings-dialog.test.js` each carry one). Prefer a stub catalog
with bracketed markers over a shipped translation: it asserts that the KEY is consulted
without tying the test to someone's choice of wording. Two things those tests also pin that a
scanner never could — that a NUMBER moves with the words (`ai/usage.js` groups through
`formatNumber`, since a hand-grouped `5,200` states five point two to a German reader), and
that a `tf()` call still reads correctly under `node --test` with no catalog at all.

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
  teardown): the wire/bus/palette gestures and the eight DeskController owns (board, part,
  brick, **cluster**, resistor body, resistor end, annotation, marquee).
  - `pointerup`/`pointercancel` listen on `window` in the CAPTURE phase, so a release
    reaches the gesture whether or not the capture held; `lostpointercapture` + window
    `blur` end it too (the only signals for "this pointer isn't yours" with no up/cancel
    behind them). `.desk-viewport` sets `touch-action: none` so the browser can't claim a
    gesture mid-drag and cancel it.
  - **A drop is resolved from the RELEASE event's own position** (`releaseWorld`), never
    from the last `pointermove` — coalesced moves lag the cursor, and a stale sample
    silently lost the drop.
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
make demos      # Regenerate + engine-validate demos/ AND src/web/demos/
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

The project is **Apache-2.0** (`LICENSE` + `NOTICE` at the root; `"license": "Apache-2.0"`
in `src/package.json`). Every first-party source file must begin with the standard Apache
2.0 header comment — a hard requirement enforced by a guard.

- **Scope**: first-party `*.js` under `src/app/` and `src/web/scripts/`, `*.css` under
  `src/web/styles/`, and the build scripts under `scripts/`.
- **Exempt**: `src/node_modules/`, `src/web/scripts/vendor/` (a generated artifact), and
  non-comment file types (`*.json`, `*.md`, `*.html`).
- **Enforcement**: `scripts/license-header.mjs --check` runs as `make test-license-headers`,
  part of `make test` (so CI fails on a missing header).
- **Auto-fix**: `make license-headers` stamps every in-scope file missing one; it preserves
  shebangs and is idempotent.
