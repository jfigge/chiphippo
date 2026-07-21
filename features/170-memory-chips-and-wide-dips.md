# Feature 170 — Memory chips & wide DIP footprints

## Context

The catalog covers gates, flip-flops, counters, decoders, muxes, latches, buffers, and
bus transceivers (Features 80/100 + the 74LS wave). It has **no memory** — nothing that
holds an addressable array of bytes and reads/writes it. Memory is the centrepiece of
the second project goal: chips that *supply data to* and *record information from* the
rest of the circuit.

Two things block it today. First, footprints stop at DIP-20 (`model/footprints.js`
`DIP_PACKAGES`); memories are DIP-24/28. Second, the behavioral vocabulary
(`sim/chip-eval.js` + `sim/sequential.js`) has no notion of an address-indexed byte
array. This stage adds both — but keeps the byte store **in volatile RAM**, resetting on
Run. Persisting it to an actual file is Feature 180; editing it is Feature 190.

Prerequisites: Features 40 (footprints/occupancy), 80/100 (evaluator + sequential
builders), 130 (buses — how you wire the address/data pins sanely).

## Goal

Add a **memory-chip family** — asynchronous ROM, static RAM, and (write-enabled)
EEPROM-style parts — as data-driven catalog entries over new wide DIP packages, with a
behavioral model that reads/writes an in-memory byte image through the existing pure
engine. Wire it up, drive the address pins, and the data pins present the stored byte.

## Design decisions (settled)

### Wide DIP packages, same derivation

Extend `DIP_PACKAGES` with `DIP-24`, `DIP-28` (and the 600-mil body variant flag).
`footprints.js` already derives pin holes from pin count + package; the additions are
data. **Width caveat, recorded honestly:** real 600-mil memories are wider than a single
breadboard trench. This stage models memory pins in the standard trench-straddling rows
(pin 1 at row e, like every other DIP) so a part is buildable on one board; the def
carries `bodyWidth: 600` purely for the drawn body + the build-guide note. A true
two-board-straddle placement is out of scope (a later footprint stage).

### A memory unit in the sim vocabulary

Add a `memUnit(m)` builder to `sim/sequential.js` alongside `dffUnit`/`registerTs4`/
etc. Its state is `{ image /* Uint8Array ref */, size, width /* data bits */, addrPins,
dataPins, ... }`. Config `m` names the address pins, the data pins, and the control pins
(`/CE`, `/OE`, `/WE`) and the geometry (`size` bytes, data `width`). The unit is pure
over its `image` input — see the read/write contract below. Memory chips are therefore
**data**, like every other 74xx part: a new memory is a catalog record, not code.

### Read is combinational; write is edge/level-latched — engine stays pure

The engine is a pure function that *reports* effects and never does I/O (Feature 90/100).
Memory obeys the same rule:

- **Read (async ROM / RAM output):** while `/CE` and `/OE` are asserted, the unit's
  `outputs(state, inputs)` drives the data pins from `image[addr]` (per bit), where
  `addr` is decoded from the address pins each settle iteration. `image` is an **input**
  the unit reads; it is never mutated during `settle`. Undriven/deselected → the data
  pins are `Z` (tri-state), so a shared data bus resolves correctly (Feature 90's
  strength precedence already handles `Z`).
- **Write (RAM/EEPROM):** during `tick`'s two-phase step (Feature 100), on the write
  condition (`/CE` low, `/WE` pulse/level per the part), the unit **reports** a write op
  `{ compId, addr, value }` in the tick result — it does **not** mutate `image`. The
  renderer's `SimController` owns the image, applies reported writes after the tick, and
  the new byte is visible on the next tick. This mirrors "the engine reports chipStatus,
  never mutates params," and keeps `settle`/`tick` pure and copy-free.

### The image lives with run-volatile state (this stage)

Like sequential state and clock phase, the byte image is **run-volatile**: created on
Run (ROM images seeded from the def's `initial` data or zero; RAM zeroed), held by
`SimController` keyed by component id, discarded on Stop. No file, no persistence yet —
Feature 180 swaps the volatile image for a file-backed one behind the same interface, so
this stage's engine/sim contract does not change when persistence lands.

### First parts

A small, honest starter set expressed purely as data: a generic **async ROM**
(`rom-8k`, 8Kx8, `/CE` `/OE`, seedable), a generic **SRAM** (`ram-8k`, 8Kx8, `/CE` `/OE`
`/WE`), and one recognizable real part (e.g. a 2Kx8 `6116` SRAM / `28C16` EEPROM shape)
to prove the datasheet mapping. More parts are later data-only additions.

## Implementation steps

1. **`model/footprints.js`** — add `DIP-24`/`DIP-28` to `DIP_PACKAGES`; a `bodyWidth`
   hint (300/600 mil) used by the drawn body + build note; confirm `allPinHoles`/
   `packageSpec` derive the new counts with no other change.
2. **`components/chip-view.js`** — draw the wider/longer body for 24/28-pin parts
   (body size from `bodyWidth`); pins still derived, no per-pin DOM.
3. **`sim/sequential.js`** — `memUnit(m)`: `state0` (image ref + geometry), `step`
   (detect the write condition, **report** `{addr,value}` — see engine change), and
   `outputs` (drive data pins from `image[addr]`, `Z` when deselected). Address/data
   decoding helpers (bit-array ⇄ integer) shared with tests.
4. **`sim/engine.js`** — `tick` collects per-component **memory write ops** into the
   result (a `memWrites` array), alongside `chipStatus`. `settle`/read paths accept an
   `images` map (compId → Uint8Array) as pure input. No mutation inside the engine.
5. **`components/sim-controller.js`** — own the `images` map; seed on Run (ROM `initial`
   / zeros), pass it into `tick`, apply returned `memWrites` after each tick, discard on
   Stop. (Feature 180 replaces the in-RAM map with a file-backed store behind this same
   seam.)
6. **`catalog/chips-mem.js`** (new) + `catalog/index.js` — the memory defs (pins, roles,
   `logic: memUnit(...)`, `pinGroups` for A/D buses, optional `initial`), stamped
   `kind: "chip"`; palette shows them under a "Memory" group with the sim-ready badge.
7. **`components/chip-pinout.js`** — the pin-assignments window already handles DIPs;
   confirm 24/28-pin parts render (two-column diagram scales).
8. **Tests** — footprint counts for 24/28; `memUnit` truth: async read returns the
   seeded byte, deselect → `Z`, a `/WE` pulse reports the right write op and the next
   read reflects it; a data-bus fixture with two RAMs sharing D[7:0] resolves via `Z`;
   engine purity (no image mutation inside `settle`/`tick`).

## Acceptance criteria

- A ROM placed, powered, and addressed drives its data pins with the seeded byte; the
  data pins go high-impedance when `/OE`/`/CE` are deasserted.
- A RAM written by a `/WE` pulse returns the written byte on the next read.
- Two memories can share one data bus without conflict (tri-state resolves).
- Memory chips are pure catalog data over `memUnit`; no per-chip evaluator code; the
  engine never performs I/O and never mutates the image.

## Constraints

- The engine stays pure and timerless — reads take the image as input, writes are
  reported and applied by the controller.
- Memory behavior is data (`memUnit` config), not a forked code path — extend the
  vocabulary, never per-chip logic.
- Run-volatile only this stage: no file, no persistence (that is Feature 180).

## Verify

```bash
make fmt && make lint && make test && make debug
```

In the app: place `rom-8k`, wire A[0:12] to counters and D[0:7] to LEDs, seed a small
pattern in code fixtures, Run, and watch the bytes march out; place `ram-8k`, wire a
write path, pulse `/WE`, and read the value back.
