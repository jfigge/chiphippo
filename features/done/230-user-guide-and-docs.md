# Feature 230 — User guide & documentation (in-app + hosted, one Markdown source)

## Context

Chip Hippo has landed the whole design-and-simulate experience (stages 00–220) but
ships **no documentation**. New users get an empty desk with no explanation of the
palette, the wire tool, the transport, the memory programmer, or the analyzer. The
roadmap has always carried this as a backlog item — *"Docs & user guide: in-app +
hosted user guide from one Markdown source (port Port Hippo's Feature 80)."* This
stage promotes it.

The **sibling projects already solved this exact problem** and the pattern is proven
in `../resthippo`:

- **One Markdown source** under `src/web/docs/*.md` (+ `docs/images/*.png`) drives
  *three* outputs — the in-app guide, the hosted website guide, and a printable PDF —
  so none of them can drift.
- **In-app**: a standalone, non-modal `docs.html` window with a narrow
  `preload-docs.js` (exposing only a `docs:read` IPC), rendering through a two-pane
  `DocsViewer` component; opened from a **Help** menu item.
- **Website**: `scripts/build-docs.mjs` renders the same `PAGES` + Markdown into
  themed static HTML under `website/docs/`, copies the images, and writes
  `website/sitemap.xml`.
- **PDF**: `scripts/build-pdf.mjs` (run under Electron) reuses the same `PAGES` +
  `renderBody`, stitches a print-styled document, and prints it via Chromium
  `printToPDF`.

Chip Hippo already has the scaffolding this depends on: a `website/` (green theme,
`--accent:#3fb950`, `chiphippo.com` via CNAME) with `index.html`, `downloads.js`,
`sitemap.xml`; the **scripts-under-Electron idiom** (`make icons`, `make datasheets`
render in a hidden Electron window; `make demos` self-validates generated docs); and
the **auxiliary-window pattern** (`pinout.html` / `memory.html` are separate
BrowserWindows with narrow preloads). What it does **not** yet have: any `docs/`,
`src/web/docs/`, a Markdown renderer (`marked`/DOMPurify are not dependencies), a
**Help** menu, or a docs window. This stage adds them.

### Prerequisites

All the features the guide documents have landed: the desk (10), boards/strips/
grouping (30/110), chips + palette (40/80/100), wires/buses (50/130), discretes +
power + clocks (60/100), netlist + probe (70), net names/labels (120), simulation +
transport (90/100/220), build guide/wiring list/BOM (140), memory chips + file
backing + inspector (170/180/190), undo/redo (200), and the logic analyzer (210).
The **deferred** schematic view (150) and image/PDF export (160) are **not** in the
app and are **out of scope** for the guide.

## Goal

Ship a complete, screenshot-illustrated Chip Hippo user guide from a **single
Markdown source**, surfaced three ways that can never diverge:

1. **In-app** — Help ▸ *Chip Hippo User Guide* opens a non-modal reader window.
2. **Hosted** — `website/docs/` static site, linked from the marketing site nav.
3. **PDF** — `docs/chip-hippo-user-guide.pdf`, regenerable with `make pdf`.

Plus a **regenerable screenshot harness** (`make screenshots`) that renders the real
renderer at **1920×1080** against scripted demo scenes and captures committed PNGs —
so the images track the app the same way `make icons` / `make datasheets` /
`make demos` track their sources.

## Design decisions (settled)

### One source, three outputs — port Rest Hippo's pipeline verbatim in shape

The `PAGES` array (order + slugs + titles) is the single index, declared once in
`DocsViewer` and mirrored (kept in sync by a comment, exactly as Rest Hippo does) in
`scripts/build-docs.mjs`; `build-pdf.mjs` imports `PAGES` + `renderBody` from
`build-docs.mjs` so the PDF can't drift. Markdown lives in `src/web/docs/<slug>.md`
with images in `src/web/docs/images/`. Image `src`s are Markdown-relative
(`images/x.png`); each renderer rewrites them for its context (DocsViewer →
`docs/images/…`, website → copied alongside, PDF → absolute `file://`).

### In-app viewer is a separate window with a narrow bridge (not a modal)

Mirror the pinout/memory pattern: `web/docs.html` + `app/preload-docs.js` (exposes
**only** `docs.read(slug)`), a singleton `_docsWin` BrowserWindow opened by
`showDocsWindow()`, so the guide stays open **beside** the desk while the user works.
The `docs:read` IPC in `main.js` strictly validates the slug (`^[a-z0-9-]+$`) and
confirms the resolved path stays inside `src/web/docs/` before reading — no crafted
name can escape the docs dir. Register it and expose it in lockstep (the ipc-parity
test covers new `docs:read`). Markdown is fetched over IPC, never `fetch()`, so it
works under `file://` in both `make debug` and packaged builds.

### Markdown rendering is a bundled, sandboxed dependency

Add `marked` as a **`src/` devDependency** (used by the build scripts, matching Rest
Hippo) and bundle a vendored renderer `src/web/scripts/vendor/markdown.js`
(marked + DOMPurify sanitize) for the renderer, imported by `DocsViewer`. No CDN, no
network — consistent with the "never load fonts/scripts from a CDN" and CSP-sandbox
constraints. `docs.html` carries a strict CSP (`script-src` from the preload bundle
only; `img-src 'self' data:`).

### Screenshots are generated, committed, and self-checked — like every other asset

A new `scripts/make-screenshots.mjs` runs **under Electron** (`npx electron …`, like
`make-icons`/`make-datasheets`). It opens a **hidden 1920×1080** BrowserWindow, loads
the **real** `src/web/index.html` with a `?screenshot=<scene>` query, waits for the
scene to load + the sim to settle + fonts/images to be ready, then
`webContents.capturePage()` → `src/web/docs/images/<scene>.png`. The renderer honors
`?screenshot=<scene>` in `app.js`: it loads a **scripted scene** (reuse the
`make-demos.mjs` `builder()` to compute scenes deterministically, or ship dedicated
scene docs), sets the camera, and opens the panels a shot needs (palette, analyzer,
memory inspector, pinout). Auxiliary windows (pinout, memory inspector) are captured
by opening those BrowserWindows in the harness and `capturePage()`-ing them. Every
scene the harness renders is asserted non-blank (min byte size / non-uniform pixels)
before it's written, so a broken scene fails the build instead of committing a black
rectangle. Offscreen rendering (`webPreferences.offscreen` or `show:false` +
`paint` wait) keeps it headless; note Linux/CI needs `xvfb-run` (same as `make pdf`).

### Website guide matches Chip Hippo's own theme, not Rest Hippo's

`build-docs.mjs`'s embedded `STYLE` + `LOGO_SVG` are re-skinned to Chip Hippo's green
tokens (`--accent:#3fb950`, `--green:#56d364`) and hippo mark, and the site constant
becomes `https://chiphippo.com`. The marketing `website/index.html` grows a **Guide**
nav link (→ `/docs/`) and a footer link, alongside the existing GitHub/Donate links.
Sitemap includes every guide page.

### The page set covers what shipped — no deferred features

Fifteen pages, in this order (slug → title). The implementer may split/merge, but
these are the required topics:

| # | slug | Title | Covers |
|---|------|-------|--------|
| 1 | `overview` (README.md) | Overview | What Chip Hippo is; the desk; contents table |
| 2 | `getting-started` | Getting Started | Install; place a board, a chip, an LED, power; Run |
| 3 | `the-desk` | The Desk & Breadboards | Pan/zoom; kits (Full/Half/Tiny); strips + rails; snap/group/mate; rail rotation |
| 4 | `components` | Chips & Components | The palette; DIP chips; discretes (switch/button/LED/resistor); place/rotate/flip; occupancy |
| 5 | `wiring` | Wiring, Nets & Buses | Wire tool (W), colors, cross-board wires; buses (`D[7:0]`); addresses |
| 6 | `power-and-clocks` | Power & Clock Sources | PSU bricks (3/5/12 V, the 12 V damage rule); clock sources; ground |
| 7 | `chip-library` | The 74xx Chip Library | The catalog; combinational + sequential families; sim-ready badge; pin-assignments window + datasheet crops |
| 8 | `simulation` | Running a Simulation | Run/Stop/Pause/Step + speed; the settle model; LEDs light; chip-health badges; live switches |
| 9 | `probing` | Probing & Net Names | Probe tool (I); net highlight + summary; naming nets & labels/annotations |
| 10 | `memory` | Memory Chips & the Inspector | ROM/RAM/EEPROM; the external programmer; file-backed `.bin`; hex/ASCII inspector; Intel HEX import/export |
| 11 | `logic-analyzer` | Logic Analyzer & Timing | Channels; waveforms + hex bus lanes; cursors/Δ; export |
| 12 | `build-guide` | Build Guide, Wiring List & BOM | Deriving a BOM, human-addressed wiring list, ordered assembly steps; BOM download |
| 13 | `files-and-undo` | Files, Autosave & Undo | `desk.json` working doc; `.chiphippo` files; New/Open/Save/Save-As; undo/redo; the bundled demos |
| 14 | `settings` | Settings | The tabbed dialog; desk HUD; selection color; datasheet folder |
| 15 | `keyboard-shortcuts` | Keyboard Shortcuts | W / I / R / F / Space, ⌘Z/⇧⌘Z, ⌘N/⌘O/⌘S/⇧⌘S, etc. |

## Implementation steps

1. **Author the Markdown** — write `src/web/docs/README.md` + the 14 topic pages
   above, cross-linking between them (`*.md#anchor`), each illustrated with the
   screenshots from step 3. Add a `docs/README.md` note on how the source drives all
   three outputs (mirror Rest Hippo's `src/web/docs/README.md`).
2. **Screenshot harness** — `scripts/make-screenshots.mjs` (under Electron): hidden
   1920×1080 window → real renderer with `?screenshot=<scene>` → settle-wait →
   `capturePage()` → committed PNG under `src/web/docs/images/`, with a non-blank
   assertion per scene. Add the small `?screenshot=<scene>` scene-loader hook to
   `app.js` (build the scene via the shared demo `builder()`, set the camera, open the
   panels the shot needs). Cover: overview desk, palette open, a placed+wired chip,
   a running sim with lit LEDs, the probe highlight, the pinout window, the memory
   inspector, the logic analyzer, the build-guide/BOM panel, and the settings dialog.
3. **In-app viewer** —
   - `src/web/scripts/vendor/markdown.js` (bundled marked + DOMPurify) + `marked`
     added to `src/package.json` devDependencies (`make install`).
   - `src/web/scripts/components/docs-viewer.js` (port `DocsViewer`: `PAGES`, two-pane
     nav + content, IPC fetch, image/anchor post-processing, in-viewer `*.md`
     navigation, external links to the system browser).
   - `src/web/styles/docs.css` using the theme tokens.
   - `src/web/docs.html` (strict CSP) + `src/web/scripts/docs-window.js` mounting the
     viewer.
   - `src/app/preload-docs.js` exposing only `docs.read`.
   - `main.js`: `docs:read` IPC (slug-validated, path-contained), `showDocsWindow()`
     singleton window, and a **Help** menu with *Chip Hippo User Guide* (+ close the
     docs window in `closeAuxiliaryWindows()`). Keep `main.js` handlers ↔
     `preload.js` in lockstep (ipc-parity test).
4. **Website build** — `scripts/build-docs.mjs`: port with Chip Hippo's green
   `STYLE`/`LOGO_SVG`, `SITE_URL = https://chiphippo.com`, `PAGES` synced to the
   viewer; render `src/web/docs/*.md` → `website/docs/*.html`, copy images, write
   `website/sitemap.xml`. Add a **Guide** nav + footer link to `website/index.html`.
5. **PDF build** — `scripts/build-pdf.mjs`: port (imports `PAGES` + `renderBody`),
   Chip Hippo cover/footer, output `docs/chip-hippo-user-guide.pdf` (default
   `PDF_OUT`). Runs under Electron.
6. **Makefile** — add targets mirroring the siblings + the local idiom:
   - `screenshots:` → `npx electron scripts/make-screenshots.mjs`
   - `docs:` → `node scripts/build-docs.mjs`
   - `pdf:` → `cd src && PDF_OUT=… npx electron ../scripts/build-pdf.mjs`
   Document them in the `help:` target and in `CLAUDE.md` (a "User guide & docs"
   section, like the "App icons" / "Datasheet crops" notes).
7. **License headers** — every new first-party `.mjs`/`.js`/`.css` carries the Apache
   header (the vendored `markdown.js` is third-party — add it to the guard's exempt
   list like other vendor files, or keep the header per house rule; match how Rest
   Hippo treats `vendor/markdown.js`).

## Acceptance criteria

- Help ▸ *Chip Hippo User Guide* opens a non-modal window that renders every page,
  navigates between pages and to in-page anchors, shows the screenshots, and opens
  external links in the system browser — working in both `make debug` and a packaged
  build (`file://`).
- `make screenshots` regenerates all committed 1920×1080 PNGs from the real renderer;
  a deliberately broken scene fails the build rather than committing a blank image.
- `make docs` regenerates `website/docs/*.html` (Chip Hippo-themed) + `sitemap.xml`;
  the site's **Guide** link reaches them; images resolve.
- `make pdf` writes `docs/chip-hippo-user-guide.pdf` — cover + contents + one section
  per page, images embedded — identical in content to the in-app/web guide.
- The three outputs share one Markdown source; editing a `.md` and rebuilding updates
  all three. `PAGES` is synced between viewer and build script.
- `make fmt && make lint && make test` pass (ipc-parity includes `docs:read`; license
  headers present).

## Constraints

- **No UI framework**; `DocsViewer` is a plain class-based ES module, DOM via `dom.js`
  `el()` where idiomatic. No event-bus library.
- **Process split** — all docs file I/O is in **main** (`docs:read`); the docs window
  is sandboxed and talks only over its narrow `preload-docs.js`. Slug validated +
  path-contained; keep `main.js` ↔ preload in lockstep.
- **No CDN / network** — `marked`/DOMPurify are bundled; images are local PNGs; the
  bundled Inter font is reused. Strict CSP on `docs.html` and the website pages.
- **Screenshots are generated assets** — committed PNGs regenerated by `make
  screenshots`; never hand-edited. The scene hook is renderer-only and inert outside
  `?screenshot=`.
- **Single source of truth** — do not fork content between in-app / web / PDF; all
  three read `src/web/docs/*.md`. Cover only shipped features (no schematic view /
  image-PDF export — those are deferred).
- **Theme tokens** — website + `docs.css` use Chip Hippo's green tokens, not Rest
  Hippo's purple.

## Verify

```bash
make install           # pulls marked into src/node_modules
make screenshots       # regenerate the 1920×1080 PNGs
make docs              # website/docs/*.html + sitemap.xml
make pdf               # docs/chip-hippo-user-guide.pdf
make fmt && make lint && make test
make debug             # Help ▸ Chip Hippo User Guide → read every page
```

In the app: open **Help ▸ Chip Hippo User Guide**, page through the guide beside a
live desk, click an in-page anchor and a cross-page link, and confirm an external
link opens in the browser. Then open `website/docs/index.html` and the built PDF and
confirm all three show the same content and screenshots.
