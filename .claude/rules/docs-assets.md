---
paths:
  - "src/web/docs/**"
  - "src/web/docs.html"
  - "src/web/scripts/docs-*.js"
  - "src/web/scripts/heading-slug.js"
  - "src/web/scripts/components/docs-viewer.js"
  - "src/web/scripts/components/datasheet-download-dialog.js"
  - "scripts/build-*.mjs"
  - "scripts/check-datasheet*.mjs"
  - "scripts/make-icons.mjs"
  - "website/**"
  - "src/web/datasheets/**"
  - "src/app/datasheets/**"
  - "src/web/scripts/tests/docs-viewer.test.js"
  - "src/web/scripts/tests/heading-slug.test.js"
  - "src/web/scripts/tests/website-*"
  - "src/app/tests/datasheet-*.test.js"
---

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
  and moving a name in or out of it is how a part leaves or rejoins the to-do list. The
  46 CD4000 parts are deliberately NOT excused, and deliberately NOT cut yet: Jason
  defers them until the family has proven worthwhile (2026-10-03). When they are, they
  come from the TI sheets the downloader fetches; until then they stay on the missing
  list.

## User guide & docs

**One Markdown source drives three outputs that can never diverge**: `src/web/docs/*.md`
(+ committed `images/*.png`) feeds the in-app viewer (Help ▸ *Chip Hippo User Guide*,
`⌘/`), the hosted website (`make docs` → `website/docs/`) and a PDF (`make pdf` →
`docs/chip-hippo-user-guide.pdf`).

- The page index (`PAGES` — slug, optional `file`, title) lives ONCE, in
  `web/scripts/docs-pages.js`, imported by both the viewer and `scripts/build-docs.mjs`.
  `tests/docs-viewer.test.js` holds it to `src/web/docs/*.md` in both directions — a page
  left off the list is unreachable everywhere (`docs.open` drops it, an in-guide link goes
  external, the website and PDF skip it), which is how `exporting.md` first shipped.
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
- **Opening the guide ON a page** is `window.chiphippo.docs.open(slug)` → `docs:open`
  (slug-validated like `docs:read`): a new window gets `?page=`, one already open is told
  over the `docs:show` push (deferred to `did-finish-load` while it is still loading, and
  listened for in `docs-window.js` BEFORE its font-size await). An unknown slug opens the
  overview. Its one caller today is the **Serial Protocol** page
  (`src/web/docs/serial-protocol.md` — the NORMATIVE wire protocol lives in the guide, so
  the app, website and PDF all carry the one copy): the book icon
  (`components/protocol-doc-button.js`) left of the × on Settings ▸ Serial I/O (shown on
  that tab only) and on the Generate card.
- **Website**: `scripts/build-docs.mjs` renders the same Markdown through `marked` under
  Node (no DOMPurify — first-party content) into themed static HTML (`STYLE`/`LOGO_SVG`
  in the file, the green `--accent:#3fb950` tokens matching `website/index.html`) under
  `website/docs/` plus `website/sitemap.xml`, and copies `images/`. It resolves `marked`
  **by file path** (`src/node_modules/marked/…`, or `MARKED_DIR`) since it is ESM-only
  and bare specifiers ignore `NODE_PATH`. `website/index.html` carries Guide nav +
  footer links.
- **Supported chips** (`website/chips.html`) is GENERATED, not written:
  `scripts/build-chips-page.mjs` (plain Node, no `marked` — it must not import
  `build-docs.mjs`) projects `CHIP_DEFS` into seven sections, with ✦ wherever
  `src/web/demos/<id>.json` exists (main's own test for the example button). `make docs`
  runs it, so the deploy regenerates it on every push. Its one hand-kept table is
  `SECTIONS` (catalog `group`s → sections, in bands), and it THROWS on a chip whose group
  no section claims or a claimed group no chip has — a new group can't vanish from the
  site. Row titles are the catalog's `title`s verbatim; a better wording is a catalog fix.
  `tests/website-chips.test.js` holds the committed page to the generator.
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
  server bar three — the '83's and '573's archive, the '533's Rochester sheet and the
  CD4528B's HGSEMI sheet, both on LCSC's asset hosts — the links expected to rot, which
  the run reports by name rather than hiding. The one entry whose KEY is not its part number is
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
  files may only be aimed at a directory the app made. Each UNIQUE URL is fetched ONCE
  and saved under every part that names it (TI documents the CD4001B, CD4002B and
  CD4025B in one PDF), so a shared sheet's failure is reported against each of its parts
  without being retried per part (`fetchPdf` / `savePdf`; `tests/datasheet-download.test.js`
  runs it against a stub fetch). **`make datasheet-urls`**
  (`scripts/check-datasheet-urls.mjs`, `--strict` to exit 1) asks every unique URL
  whether it still serves a `%PDF` — deliberately OUTSIDE `make test`, which makes no
  network calls. Fetching is **sequential** (the point
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
