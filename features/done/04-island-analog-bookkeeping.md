# 04 — Islands, analog half: per-island cycles, budgets and back-off

**Review refs:** engine review §4.2 (shared-things table), §8.2 ("Islands"),
§8.3 step 3
**Depends on:** 00; best after 02
**Accuracy:** improves accuracy for desks with more than one independent
oscillator. On single-island desks, results must be **bit-identical**. That
includes every golden case and every shipped example.

## Problem

One cycle signature, one event budget and one chatter back-off cover the
whole desk. As a result:

- Two unrelated oscillators never repeat as a whole, so neither is drawn as a
  cycle. They run edge by edge into the event cap: two fast 555s cost 10× one.
- A clock wave anywhere blocks every other oscillator's cycle. The 68 kHz 555
  beside a triangle wave is **not running**.
- One busy island spends the budget, and the whole desk gets marked
  oscillating or chattering.

## Goal

Compute the island partition, and give each island its own:

- cycle and cycle signature;
- `MAX_ANALOG_EVENTS` and `MAX_CATCHUP_EVENTS` budgets;
- chatter state and back-off.

The tick stays whole-desk. No settle changes.

## Design

1. **Islands** (`sim/spice/islands.js`), cached per netlist in a `WeakMap`
   like `voltageTopology`. Use union-find over every element that can carry
   signal or current between nets:
   - all pins of a chip (a chip couples all its pins);
   - resistors, diodes, LEDs, switch channels, transistors;
   - capacitors (both plates), inductors, bench devices;
   - clock bricks and signal flags with the nets they drive.

   **Rails are never a join point.** Use the same rule as `voltageTopology`.

   Output: island id per net, per chip, per analog node, per listener, per
   wave and per clock brick.
2. **Per-island signature**: `cycles.js` records and compares signatures per
   island. A cycle is entered per island. Several islands can be drawn as
   cycles at once, or a mix of drawn and stepped.
3. **Drawing several cycles**: `runCycle` handles a set of drawn cycles, each
   with its own schedule. A segment boundary in one island does not end
   another island's cycle.
4. **Budgets and back-off per island**:
   - an island that exceeds its budget is marked oscillating or chattering on
     its own;
   - only that island's wakes are held back;
   - warnings name the island's parts.
5. **Warnings**: merge them in a stable order (island order, then today's
   order within an island). Parity tests compare warnings.

## Must hold

- Single-island desks: bit-identical results, golden suite and parity.
- Tick-spacing invariance green.

## Tests to add

- Two unconnected 555s with different periods: both drawn as cycles; each
  period matches the 555 run alone, to the same precision as the golden NE555
  area.
- 555 at 68 kHz + triangle clock elsewhere: the 555 is drawn and its period
  is correct.
- One island chattering doesn't delay a healthy island's crossings. Its
  measured period is unchanged.

## Acceptance

`make bench-compare`:

- `555-fast-x2` is about 2× `555-fast`, not 10×.
- `555-68k+wave` reports **running** with the right period.

Record in RESULTS.md.

## Out of scope

Per-island ticks or settles (12). Per-island quantum (13).
