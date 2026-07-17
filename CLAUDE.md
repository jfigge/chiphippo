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
**Stages 00–40 have landed**: the hardened Electron shell + `window.chiphippo` bridge
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
searchable palette panel, and `chip-view.js` (drawn DIPs with pin hover).
When a stage is finished, move its plan file into `features/done/`.

## Naming & identity

- Product name **Chip Hippo**; npm package `chiphippo`; Electron `appId`
  `com.chiphippo.app`; repo `github.com/jfigge/chiphippo`.
- IPC bridge object **`window.chiphippo`**; global renderer events prefixed
  **`chiphippo:`**.
- App icon source `src/web/chiphippo-icon.svg`; download site domain
  **chiphippo.com** (via `website/CNAME`) when a site lands, falling back to the
  `*.github.io` Pages URL until the domain is configured.

## Source Directories

- `src/app/` — Electron **main** process (Node.js, CommonJS): window lifecycle and
  IPC handlers. All native I/O (filesystem, dialogs) lives here. Key entry points:
  `main.js` (window + lifecycle + ipcMain handlers), `preload.js` (the
  `window.chiphippo` bridge), `window-state.js` (bounds restore with display-fit
  check), and `store/` (`io.js` atomic-write primitives, `settings-store.js`,
  `desk-store.js` + `migrations.js` for the desk document at `userData/desk.json`).
- `src/web/` — **renderer** (Vanilla JS ES modules + plain CSS): the UI. Sandboxed;
  talks to main only through `window.chiphippo.*`. Entry points: `index.html` →
  `scripts/app.js`. Pure DOM-free logic lives under `scripts/desk/` (camera math),
  `scripts/model/` (breadboard specs/addressing/connectivity, `DeskDoc`,
  `footprints.js`, `occupancy.js`), and later `scripts/sim/`; part metadata under
  `scripts/catalog/` (pure data + integrity test — never chip-specific code
  paths); thin view components under `scripts/components/`.
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
  `.layer-boards` → `.layer-parts` (chips) → `.layer-wires` (50) →
  `.layer-overlay` (ghosts, hover ring, tooltips — pointer-inert). Boards and
  chips are one static inline SVG each; **no per-hole or per-pin DOM nodes,
  listeners, or ids** — all hole/pin interaction is `holeAt()` / derived-pin math
  from pointer coordinates. Pan/zoom must never rebuild or re-lay-out surface
  children (transform-only).
- **Components**: `{ id, kind, ref, board, anchor, params }` with `c<n>` ids; pin
  positions are always DERIVED (footprint + anchor), never stored; `occupancy.js`
  is the single collision authority (one hole, one lead — wires join it in 50).
- **Popups/menus**: `popup-manager.js` (ported from Port Hippo) is the only
  app-wide dialog/menu seam; build DOM with `dom.js` `el()`.

- The main process owns all filesystem and native I/O. The renderer is sandboxed
  (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`) and
  communicates exclusively via `window.chiphippo.*`.
- **Keep `main.js` ipcMain handlers and the `preload.js` exposure in lockstep** —
  enforced by `app/tests/ipc-parity.test.js` (add new `ipc/*.js` files to its scan
  list; channels follow `area:noun[:verb]`, lowercase + hyphenated).
- **Addresses are the only cross-module currency for holes** (`bb1.f12`); nothing
  outside `model/breadboard.js` does row/column arithmetic by hand.
- Live state pushed main → renderer uses one-way broadcasts the preload re-dispatches
  as global `chiphippo:*` `CustomEvent`s (pattern arrives with the first push channel).
- The **simulation engine is pure computation, not I/O** — it lives in the renderer as
  DOM-free ES modules under `src/web/scripts/sim/` (from Feature 90), fully testable
  with `node --test`.

## Common Commands

```bash
make install   # Install npm dependencies (npm ci, into src/node_modules)
make debug     # Run Electron with hot-reload (primary dev workflow)
make fmt       # Format JS/CSS/HTML via Prettier
make fmt-check # Check formatting without writing
make lint      # Lint JS via ESLint
make test      # License-header guard + Node unit tests (node --test)
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
