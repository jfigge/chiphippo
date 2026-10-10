# 10 — End-of-tick work proportional to what changed

**Review refs:** engine review §3.6, §4.2 (supply droop & sag, warnings), §4.3
**Depends on:** 09
**Accuracy:** must not change any result. The golden suite and parity must be
**bit-identical**.

## Problem

At the end of every tick the engine:

- measures every supply;
- computes droop and wire sag for the whole desk;
- judges every LED, diode and load;
- assembles every warning.

It does this whether or not anything electrical moved. `report()` is already
cached per cluster. The rest is not.

## Goal

Recompute each end-of-tick product only when its inputs changed.

## Design

1. **Supply demand per PSU**: the sum of its clusters' cached currents.
   Recompute a PSU's demand, droop and sag only if one of its clusters was
   re-solved this tick.
   - "Changed" means **any** change in a contributing current.
   - Do not add a new ε. `DROOP_EPS` keeps its existing role, and only that
     role.
2. **LEDs, lamps, loads, stress**: judge per re-solved cluster. Keep the
   previous judgement for clusters not re-solved. Burning still opens the
   part and re-solves its cluster, as today.
3. **Warnings**: keep per-source warning sets (per cluster, per chip, per
   supply). Rebuild only the dirty sources. Merge in a stable order identical
   to today's.
4. **Moving analog nodes**: a cluster whose voltage depends on a moving RC
   node is re-solved when the node is re-linearized. Its currents change
   continuously between ticks, but they are evaluated only at ticks today
   too, so the behaviour is unchanged. Don't evaluate more often, and don't
   evaluate less often.

## Must hold

- Bit-identical golden and parity, including warnings and their order.
- `spice-current.test.js` and `spice-sag.test.js` are green.
- Assertion mode recomputes everything and compares on every tick. Run the
  suite once with it on.

## Acceptance

`busy-*` and `rc-sine` ms/sim-s fall. The end-of-tick share in the profile
shrinks. Record in RESULTS.md.
