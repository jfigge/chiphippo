# Feature 80 — 74xx behavioral library v1 (combinational gates)

## Context
Feature 40 gave chips identity and pinouts; Feature 70 gave the circuit topology.
This stage gives chips **behavior**: a signal-level vocabulary, a generic
combinational evaluator, and behavioral definitions for the gate-wave catalog — all
pure functions with truth-table tests. No engine yet (Feature 90 orchestrates); this
is the library the engine will call, and the pattern every future 74xx wave follows.
It only depends on Feature 40's catalog, so it can proceed even while 50–70 are in
flight.

## Goal
Every chip in the starter catalog can be asked "given these input-pin levels, what
do you drive on your output pins?" with correct TTL semantics (floating inputs read
HIGH, 74125 outputs go high-impedance when disabled), proven by exhaustive
truth-table tests over all input combinations.

## Design decisions (settled — do not relitigate)
- **Signal levels** in `src/web/scripts/sim/levels.js`: `H`, `L`, `Z` (high
  impedance / undriven), `X` (conflict/unknown). Helpers: `asInput(level)`
  implements the TTL rule **Z reads as H** (a floating TTL input pulls high — a
  deliberate, documented authenticity choice); `X` in propagates as `X` out.
- **Behavior is data, not per-chip code.** Each Feature 40 catalog def gains a
  `logic` block: `{ units: [{ fn, inputs: [pin…], output: pin }] }` where `fn ∈
  NAND | NOR | AND | OR | XOR | INV | BUF3 (tri-state buffer: extra `enable` pin,
  active-low) `. One generic evaluator (`sim/chip-eval.js`) walks the units:
  `evaluate(def, pinLevels) → Map<outputPin, level>`. Gate primitives handle `X`
  (any `X` input → `X` output, except where the other input forces the result — a
  NAND with one `L` is `H` regardless) — the standard ternary-logic shortcut rules.
- **Wave 1 chips** (matching the Feature 40 metadata set, real unit/pin wiring):
  7400 quad 2-NAND, 7402 quad 2-NOR (note its swapped in/out pin order — a good
  test), 7404 hex inverter, 7408 quad 2-AND, 7410 triple 3-NAND, 7411 triple 3-AND,
  7420 dual 4-NAND, 7427 triple 3-NOR, 7430 single 8-NAND, 7432 quad 2-OR, 7486
  quad 2-XOR, 74125 quad tri-state buffer (per-unit active-low enable → `Z` when
  disabled).
- **Power is not this stage's problem**: `evaluate` assumes a powered chip; VCC/GND
  checking, supply voltages, and damage rules are engine concerns (Feature 90).
  Likewise timing: v1 logic is zero-delay pure combinational.
- **Truth-table test harness**: each def ships `tests` data (or the harness
  enumerates all `H/L` input combinations per unit against a reference JS
  expression); one generic `node --test` file runs every chip × every unit × every
  combination, plus targeted `Z`-in (reads H) and `X`-propagation and 74125
  enable/disable cases. Adding a future chip means adding data, and the harness
  picks it up automatically.
- **Def shape is forward-compatible**: `logic.units` now; Feature 100 adds
  `logic.state`/`step` for sequential parts without reshaping this stage's work.

## Implementation steps
1. **`levels.js`.** Level constants, `asInput`, ternary gate primitives
   (nand/nor/and/or/xor/inv with X-shortcut rules), tested directly.
2. **`chip-eval.js`.** The generic unit walker + tri-state handling; tests with a
   synthetic def.
3. **Wire `logic` blocks** into the 12 catalog defs with real pin mappings from
   datasheets (unit boundaries matter: 7402's B-A-Y ordering, 7430's single gate,
   74125's per-unit enables).
4. **Truth-table harness.** Generic exhaustive runner + the Z/X/tri-state special
   cases; extend the Feature 40 catalog-integrity test to require a `logic` block
   whose pins all exist and cover every `input`/`output`-role pin exactly once.
5. **Palette polish.** Chips with behavior show a small "sim-ready" badge in the
   palette (trivial UI; keeps the promise visible as future waves land).

## Acceptance criteria
- All 12 chips pass exhaustive truth-table tests on every unit; 7402's pin order
  and 7430's 8-input gate are explicitly covered.
- Floating (`Z`) inputs evaluate as `H` everywhere; `X` propagates except where a
  dominant input forces the output; 74125 drives `Z` when its enable is high.
- Catalog integrity enforces complete, consistent `logic` blocks for every chip
  that declares one.
- `levels.js` / `chip-eval.js` are DOM-free and Electron-free;
  `make fmt && make lint && make test` green.

## Constraints
- No per-chip evaluator code — chips are data over the generic evaluator; if a
  future chip can't be expressed, extend the evaluator's vocabulary, don't fork it.
- No engine, no netlist coupling, no timing, no power semantics here.
- License headers on all new modules; house naming conventions.

## Verify
`make fmt && make lint && make test` (the truth-table suite is the verification —
watch its case count; 7430 alone contributes 256). In `make debug` confirm the
sim-ready badges appear in the palette.
