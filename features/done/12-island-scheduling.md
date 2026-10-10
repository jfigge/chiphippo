# 12 — Islands, scheduling: per-island ticks and scoped settles

**Review refs:** engine review §8.2 (all), §8.3 step 4, §4.3
**Depends on:** 04 (island partition), 08 (warm cache), 10 (change-driven
end-of-tick)
**Accuracy:** must not change results on single-island desks, which must be
**bit-identical**. On multi-island desks, every island's results must equal
that island run alone, within the golden rubric's tick-spacing tolerance
(1e-4).

The supply coupling must be **exact as today**; see design item 4. This is
the one place a lazy implementation would lose accuracy.

## Problem

After 01–11, the remaining whole-desk coupling is the tick itself. Any wake
anywhere ticks every island, and every island has an event queue and settle
scope shared with the others.

## Goal

Each island has its own:

- `wakeAt` and event queue;
- analog state;
- scoped digital settle.

A wake ticks only the islands due at that moment. A user input ticks the
island its net is in.

## Design

1. **Scoped context**: from the island partition (04), build per-island chip
   and net lists. The settle and the voltage solve run on the island only.
   `settle-index.js` already partitions nets; extend it to chips.
2. **Transport**: SimController (or the Worker host from 03) keeps one batch.
   - The queue holds `(time, island)` entries.
   - Coincident events in one island are one tick.
   - Coincident events in different islands are separate island ticks at the
     same `now`, in stable island order.
3. **Clock bricks** belong to the island their `out` net is in. Their edges
   wake only that island.
4. **Supplies (global, exact)**:
   - A PSU's demand is the sum over the islands it feeds.
   - When an island ticks, recompute droop and sag for each PSU it touches
     using **every** fed island's current at this `now`:
     - an island that did not tick contributes its current evaluated at
       `now` from its carried curves (the sampler from 01, extended to
       currents), not a stale value;
     - for a purely digital island, its last value is exact.
   - If a PSU's voltage moves by more than `DROOP_EPS`, re-settle **every
     island that PSU feeds**, under the existing `RESETTLE_ROUNDS` rule.
   - Document the case where this differs from today, if any. The target is
     none.
5. **Publishing**: frames carry the union of each island's latest state. An
   untouched island keeps its last values, which is exact because nothing in
   it changed. The sampler handles moving curves.
6. **Warnings**: stable merge (island order).
7. **Debugger step**: one step is the next event across all islands.

## Must hold

- Single-island desks: bit-identical golden, parity and incremental
  exactness.
- Every shipped example: identical per-net levels and warnings over 5
  simulated seconds against the pre-12 engine. Any difference is listed and
  justified in RESULTS.md, or it is a stop.
- Multi-island equivalence test: each island of a multi-island desk matches
  that island alone, within 1e-4 relative on timings and voltages.
- A current-limited PSU feeding two islands: droop matches today's engine
  within 1e-6.

## Acceptance

`make bench-compare`:

| Fixture        | Target                                    |
| -------------- | ----------------------------------------- |
| `busy+555-slow` | ≈ sum of its parts                       |
| `busy+555-fast` | ≈ `555-fast` + `busy-square`             |
| `555-fast-x2`  | ≈ 2× `555-fast`                           |

Record in RESULTS.md.

## Out of scope

Per-island quantum (13). Multiple workers.
