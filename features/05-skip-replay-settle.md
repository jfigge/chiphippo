# 05 — Skip the redundant replay settle

**Review refs:** engine review §3.3 ("Two consequences…"), §7.1
**Depends on:** 00
**Accuracy:** a **known, bounded timing shift**. Event times may move by a few
gate delays (`passes × quantum`, tens of ns). Every golden case must stay
**A**. Report every changed golden value with its delta in RESULTS.md. Any
change above 1e-4 relative is a stop.

## Problem

On a desk with any analog node, each tick does at least two whole-desk
settles:

1. one replaying from `prior.time` on the previous tick's inputs;
2. one at `target`.

The previous tick usually already settled exactly that state, so the replay
mostly recomputes it.

## Goal

When the replay would reproduce the previous tick's final digital state, skip
it, and start the loop as if it had happened.

## Design

1. **Define "ended settled"** precisely. The previous tick:
   - was not capped (`MAX_ANALOG_EVENTS` and `MAX_CATCHUP_EVENTS` not hit);
   - was not resettling for droop or sag at its end;
   - was not oscillating or chattering;
   - has no pending holds;
   - had no reading flips outstanding.
2. **Same inputs**: no user input, clock edge or bench-source change between
   `prior.time` and the start of this tick. Carry a flag or a cheap signature
   of the inputs in `analog`.
3. **When both hold**, seed the loop from the carried final levels and state.
   Then decide how to advance `t`:
   - Option A: advance `t` by the carried `passes × quantum`, so timing is
     unchanged. Prefer this if it is possible.
   - Option B: skip the offset. This moves timing by gate delays.

   Document which option was chosen and why. Option A should make the golden
   suite bit-identical; try it first.
4. **Otherwise** fall back to today's replay.

## Must hold

- `engine-incremental.test.js` (full vs incremental exactness): green.
- `engine-parity.test.js`: green.
- Golden suite: all A. Any changed value is listed with its delta.
- Tick-spacing invariance: green.

## Tests to add

A counter (`settles` from 00) assertion. On `rc-sine` and `busy-triangle`,
settles per tick falls toward 1 in steady state.

## Acceptance

Settles per sim-s fall by about 2× on every fixture with analog nodes, with
ms/sim-s falling correspondingly. Record in RESULTS.md.

## Out of scope

Warm cache across ticks (08).
