# Feature 160 — Export desk & schematic to SVG / PNG / PDF

## Context

Features 140 and 150 produce the *content* of a followable design — the build guide and
the logical schematic — but both live inside the app. To actually take a design to the
bench, print it, or share it, the user needs **files**: a vector or raster picture of
the breadboard, the schematic, and the build guide.

The renderer is sandboxed and cannot touch the filesystem; all file writing goes through
the main process over the `window.chiphippo.*` bridge, exactly as `desk:save-as` does
(Feature: schematic files). The desk and schematic are already SVG, which makes vector
export nearly free.

Prerequisites: the schematic-files save/open flow (`desk:save-as`), Features 140 (build
plan), 150 (schematic view).

## Goal

Export the current design as: **SVG** (vector, both breadboard and schematic), **PNG**
(raster, chosen resolution), and **PDF** (a paginated document combining the schematic,
the breadboard picture, and the build guide). Everything self-contained, fonts embedded,
no external services.

## Design decisions (settled)

### Serialize the live SVG, don't re-draw

The breadboard surface and the schematic are already SVG/DOM. Export **clones** the live
surface subtree, inlines the computed styles it needs (colors/sizes from the design
tokens), embeds the bundled Inter font as a data URI (never a CDN — house rule), strips
interaction-only nodes (ghosts, hover ring, hit strokes), and fits a `viewBox` to the
content bounds. The result is a standalone `.svg` string — no second rendering path to
drift from the on-screen picture.

### PNG via an offscreen canvas in the renderer

The SVG string is drawn to an `OffscreenCanvas` (or a hidden `<canvas>`) at a
user-chosen scale (1×/2×/4×) and read back as PNG bytes. This reuses the exact
`make-icons.mjs` technique already in the repo (SVG → canvas → dataURL under the app),
so there is a proven path and no new raster dependency. The renderer hands the byte
buffer to main to write.

### PDF assembled in the main process

A small, dependency-light PDF writer in main (a minimal vector-PDF emitter, or the one
already-permitted build dep if it fits the "external packages only when necessary" bar)
lays out: page 1 the schematic, page 2 the breadboard, pages 3+ the build guide (BOM /
wiring list / steps from Feature 140's plan object). Vector where possible (embed the
SVG), raster fallback for the breadboard if vector PDF proves heavy. Main owns the file
write and the native Save dialog.

### One export flow, three targets

A single "Export…" dialog (PopupManager modal) picks target (SVG/PNG/PDF), source
(breadboard / schematic / full build package), and options (PNG scale, PDF sections),
then calls a new `export:write` IPC. Defaults produce a sensible "full build package"
PDF in one click.

## Implementation steps

1. **`web/scripts/export/svg-export.js`** (new, pure-ish DOM) — clone a surface,
   inline the needed styles + font data URI, drop interaction nodes, fit the viewBox →
   standalone SVG string. Shared by desk and schematic (pass the root + a node filter).
2. **`web/scripts/export/raster-export.js`** (new) — SVG string → PNG bytes via
   canvas at a scale factor (the `make-icons.mjs` pattern).
3. **`app/store/*` + `app/main.js`** — an `export:write(filename, bytes|string,
   kind)` IPC handler using the atomic `io.js` write + a native Save dialog; register in
   `main.js`, expose in `preload.js` (keep ipc-parity green).
4. **`app/pdf/build-pdf.js`** (new, main) — assemble the PDF from the SVG/PNG payloads +
   the Feature 140 plan text; return bytes to write.
5. **`components/export-dialog.js`** (new) — the Export modal (target/source/options),
   calling the export modules then `chiphippo.export.write(...)`.
6. **Menu/header** — "Export…" entry (File menu + toolbar icon), and a keyboard accel.
7. **Tests** — `svg-export` produces a self-contained string with the font embedded and
   no `.wire-hit`/ghost nodes and a content-fitted viewBox (jsdom); the export IPC is in
   the parity list; `build-pdf` emits a valid header/xref for a fixture plan (byte-level
   assertions, main-side `node --test`).

## Acceptance criteria

- "Export…" writes a standalone SVG of the breadboard or schematic that opens correctly
  in a browser with fonts intact and no interaction artifacts.
- PNG export writes a crisp image at the chosen scale.
- The full-build-package PDF contains the schematic, the breadboard, and a readable
  build guide, in one file.
- No external network access; the bundled font is embedded, never linked.

## Constraints

- All file I/O in main via IPC (parity-guarded); the renderer only produces bytes.
- Self-contained assets only — no CDN fonts/styles/scripts (Artifact/house rule).
- Export reflects exactly what is on screen; no divergent second render path.

## Verify

```bash
make fmt && make lint && make test && make debug
```

In the app: design a circuit, Export → full-package PDF, open it and confirm the
schematic + breadboard + wiring list are all present and legible; export the schematic
as SVG and open it in a browser.
