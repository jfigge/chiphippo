# 74LS-series catalog mapping

A record of the batch that added the 74LS wave (`src/web/scripts/catalog/chips-74ls.js`)
to the chip catalog: how each requested part maps onto the simulator's data-only
vocabulary, which parts could **not** be mapped, and the modelling caveats that
apply. Landed 2026-07-21.

## What this is

Chip behaviour in this project is **data, never per-chip code**. Combinational
parts carry a `logic.units` block (gate / tri-state / `COMB` units) the generic
evaluator (`sim/chip-eval.js`) walks; sequential parts carry a
`{ state0, step, outputs }` block built by the pure family builders in
`sim/sequential.js`. A new 74xx part is therefore a pin map plus a reference to a
builder. Where a requested shape didn't exist in the vocabulary, the **builder
was added to `sim/sequential.js`** and the catalog only supplies pins — the
evaluator was never forked.

The engine is **zero-delay, timerless, and power-agnostic**. Signal levels are
`H / L / Z / X` with the TTL rule that a floating input reads HIGH
(`asInput(Z) === H`). These properties decide what is and isn't expressible.

## Request triage (28 parts: 24 added, 4 excluded)

| Part | Function | Status | Mapping / reason |
| --- | --- | --- | --- |
| 74LS05 | Hex inverter (open-collector) | ✅ added | `INV` units (OC is analog) |
| 74LS14 | Hex Schmitt inverter | ✅ added | `INV` units (hysteresis is analog) |
| 74LS47 | BCD→7-segment decoder | ✅ added | `bcd7segUnits` (COMB) — see caveats |
| 74LS85 | 4-bit magnitude comparator | ✅ added | `comparator4Units` (exact cascade) |
| 74LS90 | Decade (÷10) ripple counter | ✅ added | `decadeCounter7490` |
| 74LS112 | Dual JK flip-flop | ✅ added | `jkUnit` (negative edge) |
| 74LS148 | 8→3 priority encoder | ✅ added | `priorityEncoder8Units` |
| 74LS151 | 8:1 multiplexer | ✅ added | `muxUnits` (identical to 74151) |
| 74LS153 | Dual 4:1 multiplexer | ✅ added | `muxUnits` ×2 |
| 74LS157 | Quad 2:1 selector | ✅ added | `selectorUnits` (identical to 74157) |
| 74LS169 | Sync up/down counter (1 clock) | ✅ added | `upDownCounter4Sync` |
| 74LS173 | 4-bit D register, tri-state | ✅ added | `registerTs4` |
| 74LS174 | Hex D flip-flop | ✅ added | `dffUnit` ×6 |
| 74LS240 | Octal buffer, inverting, tri-state | ✅ added | `busDriverUnits` (inverting) |
| 74LS244 | Octal buffer, tri-state | ✅ added | `BUF3` units |
| 74LS245 | Octal bus transceiver | ✅ added | `transceiverUnits` + new `io` role |
| 74LS257 | Quad 2:1 selector, tri-state | ✅ added | `selectorTsUnits` |
| 74LS259 | 8-bit addressable latch | ✅ added | `addressableLatch8` |
| 74LS273 | Octal D flip-flop | ✅ added | `dffUnit` ×8 |
| 74LS279 | Quad S̄R̄ latch | ✅ added | `srLatchUnit` (dual-set aware) |
| 74LS283 | 4-bit binary full adder | ✅ added | `adder4Units` |
| 74LS533 | Octal latch, inverting, tri-state | ✅ added | `latchTs` (invert) — '373 pinout |
| 74LS573 | Octal latch, tri-state | ✅ added | `latchTs` — flow-through pinout |
| 74LS595 | Shift register + output latch | ✅ added | `shiftRegister595` |
| 74LS122 | Retriggerable monostable | ❌ excluded | needs RC-timed pulse (see exceptions) |
| 74LS123 | Dual retriggerable monostable | ❌ excluded | needs RC-timed pulse |
| 74LS221 | Dual monostable | ❌ excluded | needs RC-timed pulse |
| 74LS404 | — | ❌ excluded | not a real 74-series part number |

## New vocabulary builders (`sim/sequential.js`)

Combinational (`COMB` unit factories):

- `selectorTsUnits` — quad 2:1 selector with 3-state (`Z`) outputs (74257/258).
- `busDriverUnits` — a bank of 3-state buffers on one enable, optional inverting
  (74240 inverting; 74244 uses plain `BUF3`).
- `transceiverUnits` — bidirectional octal bus transceiver (74245). Each A/B pair
  is two `COMB` units (one per direction), each returning `Z` on the passive side.
- `adder4Units`, `comparator4Units`, `priorityEncoder8Units`, `bcd7segUnits` —
  the 74283 / 74LS85 / 74LS148 / 74LS47 arithmetic and decode functions.

Sequential (`{ state0, step, outputs }`):

- `upDownCounter4Sync` — single-clock up/down counter with a direction pin (74169;
  the existing `upDownCounter4` is the two-clock 74193).
- `registerTs4` — D register with tri-state outputs (74173).
- `latchTs` — octal transparent latch with tri-state outputs, optional inverting
  (74573 / 74533).
- `addressableLatch8` — level-sensitive addressable latch, four modes (74259).
- `srLatchUnit` — asynchronous S̄R̄ latch, one or more set inputs (74279).
- `shiftRegister595` — shift register + storage register + tri-state parallel out
  and a non-tri-state serial output (74595).
- `decadeCounter7490` — dual-section (÷2 + ÷5) ripple counter with gated resets.

Tri-state outputs are expressed simply: a unit returns `Z`, which the resolver
treats as undriven. No engine change was needed — `driversFor` already drives
whatever level a unit returns.

## The `io` (bidirectional) role — added for the 74245

The pin-role model was strictly unidirectional: a pin is `input` *or* `output`,
and the catalog integrity test enforced that a unit only reads inputs and only
drives outputs. A bus transceiver's A/B lines are genuinely bidirectional, so a
new role was added:

- **`role: "io"`** — a bus line a unit may BOTH read and drive.
- The engine already permits this: it reads every pin's net level and drives
  whatever `evaluate()` returns, regardless of declared role. So no engine change.
- The **catalog integrity test** (`tests/chips-catalog.test.js`) now allows a unit
  to read an `input`/`io` pin and drive an `output`/`io` pin, and requires every
  `io` pin to be **driven exactly once AND read** (that is what makes it bidirectional).
- The **pinout window** (`chip-pinout.js`) labels `io` pins "I/O".

The 74245 is the only bidirectional part in the catalog. It settles cleanly in
the real engine in both directions (verified: A→B and B→A both strongly drive the
passive side; `ŌĒ` high floats both sides). There is no oscillation because, in a
given direction, the source-side unit returns `Z` and so does not depend on the
value it is (not) driving.

## Exceptions (could not be mapped)

### 74LS122 / 74LS123 / 74LS221 — monostable multivibrators

A monostable's defining behaviour is an **output pulse of a width set by an
external RC network** (`t ≈ 0.45·R·C`). The engine is **zero-delay and has no
timeline** — the only timed element is the clock source, and it is a fixed
free-running square wave, not a triggerable one-shot. There is no representation
for "go high for N milliseconds after this edge," so a one-shot cannot be modelled
without a fundamentally different (time-stepped, analog-aware) engine. Excluded.

### 74LS245 — resolved (no longer an exception)

Originally flagged as unmappable because of its bidirectional pins; now supported
via the `io` role described above. Kept here as a note in case the reasoning is
revisited.

### 74LS404 — not a real part

There is no 74LS404 in the 7400 series (the list runs …403 → 405). Every search
resolves to the **74LS04 hex inverter**, which is functionally what the added
74LS05 / 74LS14 already provide. Most likely a typo for 74LS04. Excluded as
non-existent.

## Caveats (modelling limitations of the added parts)

- **LS vs plain TTL is invisible here.** Low-power-Schottky is an analog
  speed/power distinction; in a zero-delay, power-agnostic sim a 74LSxx behaves
  identically to its 74xx cousin. The value of the wave is the real pinouts and a
  wider part shelf. 74LS151 / 74LS157 are logic-identical to the existing
  74151 / 74157, added under their own ids.

- **74LS47 BI/RBO is modelled as the input direction only.** Pin 4 (BĪ/RBŌ) is a
  bidirectional open-collector node. We model its **dominant BI (blanking-input)**
  direction — pulling it low forces all segments off. The ripple-blank-**out**
  direction (for chaining leading-zero suppression across digits) is out of scope.
  Lamp-test (LT̄), zero-blank-in (RBĪ), and the full segment font — including the
  7447 quirks (6 has no top bar, 9 no bottom bar) — all work.

- **74LS90 floating inputs sit in reset/set.** With every input floating (reads
  HIGH), both R0 pins are high (reset to 0) and both R9 pins are high (set to 9,
  which wins) — so an unwired 7490 shows 9, exactly as real TTL would. To count,
  hold at least one pin of each reset pair low. The two sections are independent;
  wire QA→CKB externally for a BCD decade count.

- **`X` is treated as `L` inside MSI compute functions.** The decode/mux/adder
  `COMB` units read a bit with `asBit`/`high` (an `X` reads as low), matching the
  existing MSI builders (`muxUnits`, `decoderUnits`) rather than propagating `X`.
  Simple gates still propagate `X` per the ternary rules.

- **7485 uses the exact datasheet cascade equations**, so the abnormal cascade-input
  rows (e.g. all three cascade inputs low) reproduce the datasheet, not a naive
  "pass the cascade inputs through on equality."

- **74LS533 uses the interleaved '373 pinout, not the '573 flow-through pinout.**
  It is "a '373 with inverted outputs," not "a '573 with inverted outputs" (that
  part is the '563). The builder is pinout-agnostic; only the pin map differs.

## Verification

- **Catalog integrity** (`tests/chips-catalog.test.js`) validates every def:
  package/pin-count, role legality (now including `io`), one VCC + one GND, unique
  names, and — for combinational parts — that every input is read, every output
  driven once, and every `io` pin both driven and read.
- **Truth-table harness** (`tests/truth-table.test.js`) auto-enumerates the new
  gate/`BUF3` parts (74LS05 / 74LS14 / 74LS244) exhaustively.
- **Behavioural tests** (`tests/chips-74ls.test.js`) exercise every added part's
  core behaviour through `evaluate()` (combinational) or `logic.step`/`outputs`
  (sequential), keyed to the datasheet pin numbers so a wrong pin map fails.
- The 74245 was additionally verified settling bidirectionally through the real
  `settle()` engine.
