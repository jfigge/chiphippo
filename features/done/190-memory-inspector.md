# Feature 190 — Memory inspector / hex editor

## Context

Features 170/180 make a memory chip hold bytes and back them with a file, but there is no
way to **see or edit** those bytes inside the app. To program a ROM you would hand-craft
a `.bin`; to know whether a RAM recorded the right thing you would open the file in an
external hex editor. The project goal — chips that supply data to and record information
from the circuit — is only usable once the user can author the supplied data and read
back the recorded data in place.

The pin-assignments window (Feature 100) already proves the pattern: a separate floating
OS window (`pinout:open` → `web/pinout.html` → `scripts/pinout.js`) rendering a per-part
view. A memory inspector is the same pattern with a hex/ASCII grid.

Prerequisites: Features 170 (memory chips + image), 180 (file binding + `mem:*` IPC).

## Goal

A **memory inspector**: a floating window per memory chip showing its contents as a
scrollable hex + ASCII grid, editable when stopped, live-updating while running, with
load/save/import/export of the backing `.bin`, so ROMs can be programmed and RAM/EEPROM
contents observed and edited.

## Design decisions (settled)

### A floating window, like the pinout

Double-clicking a memory chip (or a context-menu "Inspect memory…") opens
`web/memory.html` → `scripts/memory.js` via a new `memory:open(compId)` push, one window
per component (re-open focuses), `alwaysOnTop` optional like the pinout. Pure DOM, native
frame owns the title bar. This reuses the whole Feature 100 window plumbing; no new
modal system.

### The grid is virtualized, address-labelled, editable when stopped

A canonical hex view: 16 bytes per row, offset gutter (`0x0000:`), hex cell columns, an
ASCII sidebar, only the visible rows in the DOM (virtual scroll — a 32 KB image is 2048
rows). Editing a hex or ASCII cell writes one byte. Editing is enabled only while the sim
is **stopped** (a running image is engine-owned and volatile-consistent); during a run
the grid is **read-only and live**, tinting bytes the engine wrote this tick.

### Two data paths: stopped edits the file, running mirrors the image

- **Stopped:** the window is the authority. It loads via `chiphippo.mem.load(path,size)`,
  edits mutate a local buffer, and Save flushes via `mem.flush` (or a full write). This
  is how you program a ROM before running.
- **Running:** the `SimController` owns the live image; it broadcasts a lightweight
  `chiphippo:mem-state` (compId → changed byte ranges, throttled) that open inspector
  windows apply, so the grid shows writes as they happen without the window touching the
  file. On Stop, the window reloads from the (now-flushed) file.

### Import / export / fill

Buttons for: Import a `.bin`/`.hex` (Intel HEX parsing is a small pure module) into the
image, Export the image to a file, Fill a range with a value, and Go-to-address. These
are file/main operations (import/export) plus pure buffer ops (fill/goto). Intel HEX
support makes it trivial to load assembler output.

### Binding management

The window sets/clears the Feature 180 `storage` binding (path + `rom`/`ram` mode) and
shows load errors inline — the one place a user manages a chip's backing file.

## Implementation steps

1. **`web/memory.html`** + **`web/scripts/memory.js`** (new) — the window entry, mirrors
   `pinout.html`/`pinout.js`.
2. **`components/memory-inspector.js`** (new, pure DOM) — the virtualized hex/ASCII grid
   (offset gutter, hex + ASCII columns, visible-rows-only), cell editing, go-to,
   fill-range, selection.
3. **`model/hex-format.js`** (new, pure) — Intel HEX ⇄ byte-array parse/emit + a raw
   `.bin` passthrough; unit-tested.
4. **`app/main.js` + `app/preload.js`** — `memory:open(compId)` push (main→renderer
   pattern) and window management (one per compId, focus on re-open); `mem:import`/
   `mem:export` file handlers over `mem-store.js` + native dialogs; parity-guarded.
5. **`components/sim-controller.js`** — broadcast throttled `chiphippo:mem-state`
   (changed ranges) during a run; reload signal on Stop.
6. **`components/desk-controller.js` / chip-view** — dblclick / context-menu on a memory
   chip opens the inspector (route the compId, like the pinout `#onOpenPinout`).
7. **Tests** — `hex-format` round-trips Intel HEX and raw bin (incl. record checksums);
   the grid renders only visible rows for a large image and edits the right byte offset
   (jsdom); a fill/goto pure-op test; the `memory:*` channels are in the parity list.

## Acceptance criteria

- Double-clicking a memory chip opens a hex/ASCII inspector for its contents.
- While stopped, editing a cell (or Import/Fill) changes the image and Save writes the
  `.bin`; a programmed ROM then drives those bytes on Run.
- While running, the grid is read-only and shows RAM writes live as the circuit records
  them.
- Intel HEX and raw `.bin` import/export both work; go-to-address and fill-range work.

## Constraints

- One inspector window per component; pure DOM, native frame (Feature 100 pattern).
- File import/export/flush all go through main via parity-guarded IPC; the window never
  touches the filesystem directly.
- Editing only while stopped; the running image stays engine-owned (the window mirrors,
  never writes it).

## Verify

```bash
make fmt && make lint && make test && make debug
```

In the app: open a ROM's inspector, Import an Intel HEX program, Save, Run, and confirm
the bytes drive the bus; open a RAM's inspector, Run a write loop, and watch cells update
live; Stop and confirm the file on disk matches the grid.
