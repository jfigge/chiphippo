# 08 — Carry the incremental cache across ticks (no cold first pass)

**Review refs:** engine review §3.3 ("Each settle is the whole desk"), §4.2
("Cold first pass"), §7.6
**Depends on:** 05, 06, 07
**Accuracy:** must not change any result. The golden suite, parity and
incremental exactness must be **bit-identical**.

## Problem

Every settle's first pass is cold:

- every chip is evaluated;
- every net is resolved.

A tick caused by one 555 crossing therefore re-evaluates the whole counter
board. This is the digital half of the island idea, and the main reason a busy
board makes everything else expensive.

## Goal

A settle starts from the previous settle's resolved state. It evaluates only:

- chips whose read nets or readings changed;
- chips with internal time-dependent state due;

and resolves only nets whose drivers changed. Everything statically coupled
follows via `settle-index.js` as today.

## Design

1. **Write the invalidation rule first**, as a doc comment and in RESULTS.md.
   Find out why the settle starts cold today:
   - state objects replaced between ticks;
   - memory images;
   - signals;
   - anything else that changes outside a settle.

   For each, define what it dirties.
2. **Dirty sources** at the start of a settle:
   - clock edges (their nets);
   - user inputs and bench sources (their nets);
   - listener flips (that pin's chip);
   - analog readings that changed (`volt.reading` per pin);
   - supply moves (all chips on that PSU);
   - state replaced externally (that chip);
   - CPU `step` functions (always dirty while running);
   - power changes and netlist changes (full cold pass, as today).
3. **Cache lifetime**: keyed to netlist + prepared context. Invalidate fully
   on document change, power change and config change.
4. **Fallback**: an env flag forces cold first passes. Keep it for debugging
   and for the assertion mode.

## Must hold

- Bit-identical golden, parity and incremental exactness.
- **Assertion mode** (env flag): run a cold settle beside every warm settle
  and assert identical levels, state and pin levels. Run the full test suite
  with it on, plus every shipped example for 5 simulated seconds.

## Acceptance

- `busy+555-slow` approaches the sum of `busy-square` and `555-slow`. The
  target is within 1.3× of the sum.
- Chip evaluations per sim-s fall in proportion.

Record in RESULTS.md.
