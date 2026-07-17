# Feature 20 — Breadboard model & tie-point addressing

## Context
Features 00/10 delivered the shell and the infinite desk. Before any board is drawn,
Chip Hippo needs its **domain model**: the exact geometry of the three breadboard
sizes, a stable **address for every tie point** (the roadmap's "key aspect" — chips
and wires bind to holes by address, never by pixel), each board's **internal
connectivity** (5-hole strips, continuous rails, isolating trench), and a persisted
**desk document** to hold it all. This stage is almost entirely pure, tested logic
plus the document store; rendering follows in Feature 30.

## Goal
A DOM-free breadboard model that answers every geometric and electrical question
about the three board types — hole addresses ⇄ positions ⇄ internal nodes, with tie
point counts exactly 830 / 400 / 170 — plus a desk-document store with autosave IPC,
a migrations stub, and the ipc-parity guard test.

## Design decisions (settled — do not relitigate)
- **Units**: all model geometry in **pitch units** (1 = 0.1 in). Board outlines come
  from the real dimensions (Full 165×55 mm ≈ 65.0×21.7, Half 82×55 ≈ 32.3×21.7, Tiny
  45×34.5 ≈ 17.7×13.6 pitch units); hole lattices are integer offsets within them.
- **Board layouts** (top → bottom):
  - Full/Half: rail rows `t+` (red) and `t−` (blue) · gap · rows `j i h g f` ·
    trench (2 rows) · rows `e d c b a` · gap · rail rows `b+` (red), `b−` (blue).
  - Tiny: rows `j…f`, trench, rows `e…a` — no rails.
  - Columns numbered `1..N` left→right: Full N=63, Half N=30, Tiny N=17.
  - Rail holes: Full 50 per rail in 10 groups of 5 (one extra pitch of gap between
    groups, centered on the board); Half 25 per rail in 5 groups.
  - Counts therefore: Full 63×10 + 4×50 = **830**; Half 30×10 + 4×25 = **400**;
    Tiny 17×10 = **170**. A test locks these numbers.
- **Address scheme**: within a board, holes are `a1`…`j63` (row letter + column) and
  rails `t+1`…`t+50`, `t−…`, `b+…`, `b−…` (rail id + hole index). Globally
  `<boardId>.<hole>`, e.g. `bb1.f12`, `bb2.t+7`. Board ids are `bb<n>`, assigned by a
  per-document counter that never reuses ids.
- **Internal nodes** (what's electrically common inside one board): each column-half
  is one node (`a–e` of column c → node `c<c>L`; `f–j` → `c<c>U`); each rail is one
  continuous node (`t+`, `t−`, `b+`, `b−`) — no mid-board rail split (some real
  boards split rails; ours don't — revisit only via a future board option). The
  trench isolates L from U.
- **API** (pure module `src/web/scripts/model/breadboard.js` + `board-types.js`):
  `spec(type)` (outline, rows, cols, rail layout), `holes(type)` (iterate all),
  `holeAt(type, x, y)` (pitch-unit point → hole | null, with a forgiving ~0.45-pitch
  radius), `holePosition(type, hole)` → `{x, y}`, `nodeOf(type, hole)`,
  `holesOfNode(type, node)`, `parseAddress`/`formatAddress`. Everything derives from
  the specs table — no per-type code paths.
- **Desk document** (one per app for now; named project files are backlog):
  `{ version: 1, boards: [{ id, type, x, y }], components: [], wires: [] }` — the
  empty arrays reserve the shape Features 40–60 fill in. Board `x, y` are the
  board-origin world coordinates in pitch units, **snapped to integers** so every
  hole on the desk lands on the global 0.1-in lattice (this later makes cross-board
  work uniform). The viewport stays in settings (Feature 10), not the document.
- **Store**: `src/app/store/desk-store.js` on `io.js` (atomic write, load-or-default)
  with a `migrations.js` stub keyed on `version`; document lives at
  `userData/desk.json`. IPC `desk:load` / `desk:save` (renderer autosaves the whole
  document, debounced ~1 s — documents are small; deltas are premature). Add the
  sibling **ipc-parity test** now that channels are worth guarding.

## Implementation steps
1. **Specs + model module.** `board-types.js` (data) and `breadboard.js` (derivation
   functions above), with the geometry math for rail grouping and trench layout.
2. **Model tests.** Tie-point counts (830/400/170 exactly); `a1..e1` share a node,
   `f1` doesn't; rails continuous end-to-end; `holePosition` ⇄ `holeAt` round-trip
   for every hole of every type; address parse/format round-trip; trench isolation.
3. **Desk document module.** `src/web/scripts/model/desk-doc.js`: create/normalize,
   add/move/remove board (with id allocation, integer snapping, board-overlap
   rejection using outlines), serialize. Pure + tested.
4. **Store + IPC.** `desk-store.js`, `migrations.js`, `desk:load`/`desk:save`
   registered in `main.js`, exposed as `window.chiphippo.desk.*`; store tests against
   a temp userData dir; port the ipc-parity test from
   `porthippo/src/app/tests/ipc-parity.test.js`.
5. **Renderer plumbing.** On boot load the document into an in-memory `DeskDoc`
   instance; a `chiphippo:doc-changed` CustomEvent triggers the debounced autosave.
   (Nothing visible yet — Feature 30 renders it.)

## Acceptance criteria
- Model tests prove counts, node grouping, rail continuity, hit-radius behavior, and
  position round-trips for all three types.
- A board added via the model API gets a fresh `bb<n>` id, integer coordinates, and
  rejects placement overlapping an existing board's outline.
- `desk:load` returns a normalized document on first run (empty desk) and the saved
  one thereafter; killing the app within the debounce window loses at most ~1 s of
  changes; `migrations.js` runs (as a no-op) on load.
- ipc-parity test passes; `make fmt && make lint && make test` is green.

## Constraints
- The model is pure ES modules under `src/web/scripts/model/` — no DOM, no Electron,
  fully covered by `node --test`.
- Addresses are the only cross-module currency for holes; nothing outside the model
  converts row/column arithmetic by hand.
- Store code follows the siblings' `io.js` atomic-write discipline; all file I/O in
  main. Keep `main.js`/`preload.js` in lockstep (now enforced by the parity test).

## Verify
`make fmt && make lint && make test`. In `make debug` DevTools:
`await window.chiphippo.desk.load()` returns the empty document; save a document with
one board, relaunch, and confirm it loads back unchanged.
