# Feature 180 — File-backed byte storage for memory chips

## Context

Feature 170 gave memory chips a **run-volatile** byte image held by `SimController` —
gone on Stop, seeded from a def or zero on Run. The second project goal is that these
chips "use actual files as byte data storage": a ROM is programmed from a real `.bin` on
disk, and a RAM/EEPROM **records** what the circuit writes back into a real file that
survives the run and the session.

Feature 170 deliberately put the image behind a single seam in `SimController` (seed on
Run → `images` map → apply reported `memWrites`). This stage swaps the in-RAM image for
a **file-backed** one behind that exact seam. The engine, `memUnit`, and the catalog do
not change — persistence is an I/O concern, and I/O lives in the main process.

Prerequisites: Feature 170 (memory chips + the image seam), the schematic-files IPC
pattern (`desk:*` in `app/store/desk-store.js`), Feature 90/100 (SimController transport,
12 V damage persistence — the model for "controller owns run I/O").

## Goal

Bind each memory component to a real file on disk. On Run, load the file into the chip's
image; while running, flush reported writes back to the file (debounced, atomic); the
binding (a file path + mode) persists in the document so a ROM stays programmed and a RAM
keeps its recorded contents across sessions.

## Design decisions (settled)

### The binding is a document field; the bytes are a sidecar file

A memory component gains `params.storage = { path, mode }` where `mode` is
`rom` (read-only: load, never write back) or `ram` (read-write: load + flush). `path` is
resolved relative to the schematic file's folder when possible (portable projects), else
absolute. The **document stores the binding, never the bytes** — a `.chiphippo` file
stays small and text; the byte image is its own `.bin` sidecar, versioned/shared however
the user likes. An unbound memory falls back to Feature 170's volatile image (zeros /
def `initial`).

### All file I/O in main, over a guarded IPC pair

The renderer is sandboxed. A new `mem:*` IPC surface in `app/store/mem-store.js` +
`app/main.js`:

- `mem:load(path, size)` → a byte buffer (zero-padded/truncated to `size`), or an error
  the controller surfaces in the notification stack.
- `mem:flush(path, writes)` → apply a batch of `{ addr, value }` to the file atomically
  (read-modify-write through `io.js`, or an offset write), returning ok/err.

Exposed in `preload.js` as `chiphippo.mem.load/flush`, kept in lockstep with the parity
test. No streaming of the whole image on every write — flushes carry only the dirty
bytes accumulated since the last flush.

### The controller owns the load/flush lifecycle; the engine stays pure

`SimController` is the only place that touches memory files:

- **On Run:** for each memory component with a `storage` binding, `await mem.load(...)`
  into the `images` map (Feature 170's seam); unbound → volatile seed. Run does not start
  until loads resolve (or fail loudly).
- **While running:** each `tick` returns `memWrites`; the controller applies them to the
  in-RAM image immediately (so reads see them next tick) **and** queues them for a
  debounced `mem.flush` (RAM/EEPROM mode only; ROM mode drops writes with a one-time
  "write to read-only memory" warning). A final flush runs on Stop and on Pause.
- **The engine never learns any of this.** `tick`/`settle` still take an image map and
  report writes — identical to Feature 170. Swapping volatile for file-backed is entirely
  a controller concern.

### Consistency and safety

Flushes are atomic (`io.js` temp-write + rename) so a crash mid-run never corrupts the
`.bin`. A load failure (missing file, size mismatch) blocks Run for that chip with a
clear message rather than silently zeroing. Two components must not bind the same path in
`ram` mode (reported as a conflict). Writes are batched and debounced (~250 ms) to keep a
fast clock from hammering the disk; the in-RAM image is always the live truth during a
run, the file an eventually-consistent record flushed on a timer and on Stop.

## Implementation steps

1. **`app/store/mem-store.js`** (new, main) — `load(path, size)` and
   `flush(path, writes)` over `io.js` atomic primitives; path resolution relative to the
   current schematic folder.
2. **`app/main.js`** — register `mem:load` / `mem:flush` ipcMain handlers (area:noun:verb,
   lowercase-hyphenated); **`app/preload.js`** — expose `chiphippo.mem.load/flush`; add
   to the ipc-parity scan list.
3. **`model/desk-doc.js`** + memory `normalizeParams` (Feature 170 defs) — carry
   `storage: { path, mode }` through coercion; additive migration default (no binding).
4. **`components/sim-controller.js`** — the Run/flush/Stop lifecycle above: async load
   gate on Run, apply+queue writes per tick, debounced flush, final flush on Pause/Stop,
   ROM-write and load-failure warnings via the `NotificationStack`.
5. **`components/chip-pinout.js` / context menu** — a "Backing file…" action to set/clear
   the path and mode (the full editor is Feature 190; here it is just the binding).
6. **Tests** — `mem-store` load pads/truncates to size and flush is atomic (main-side
   `node --test` against a temp dir); the parity test sees `mem:*`; a controller-level
   test (with a stubbed `chiphippo.mem`) proves Run loads before ticking, writes flush
   debounced, ROM mode refuses writes, and a load error blocks that chip's run.

## Acceptance criteria

- Binding a ROM to a `.bin` loads its bytes on Run; the circuit reads them out.
- Binding a RAM/EEPROM to a `.bin` records writes back to that file; reopening the app
  and running again shows the recorded contents.
- ROM-mode writes are refused with a warning, not silently applied.
- A missing/mismatched file blocks Run for that chip with a clear message; the `.bin` is
  never left half-written after a crash (atomic flush).
- The engine and `memUnit` are byte-identical to Feature 170 — persistence lives only in
  the controller + main.

## Constraints

- All filesystem access in main via the parity-guarded `mem:*` IPC; the renderer holds
  only in-RAM images and byte batches.
- The engine stays pure/timerless; the debounce timer and file writes are the
  controller's, never the engine's.
- The document stores the binding, never the bytes; `.chiphippo` stays small and text.

## Verify

```bash
make fmt && make lint && make test && make debug
```

In the app: create a `program.bin`, bind a ROM to it, Run, and watch it drive the bus;
bind a RAM to `scratch.bin`, run a write loop, Stop, inspect the file changed on disk,
reopen the app and confirm the recorded bytes reload.
