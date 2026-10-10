# 09 — Cache the per-tick whole-desk analysis

**Review refs:** engine review §4.2 ("Per-tick whole-desk analysis"), §5, §7.3
**Depends on:** 00
**Accuracy:** must not change any result. The golden suite and parity must be
**bit-identical**.

## Problem

Several computations run on every tick and walk the whole desk:

- `analyze`: capacitor candidates, waves, delays, quantum, holds, spikes;
- `relaysOf`;
- `listenersOf` per context;
- `makePlan`, `buildContext`;
- the timing readouts.

They only change when the netlist, the config or chip power changes. The
profile shows `analyze`, `listenersOf`, `makePlan` and `buildContext` together
at about 10%.

## Goal

Compute each of these once per **netlist + config + chip-power signature**.
Cache them in `WeakMap`s keyed by the netlist, like `voltageTopology`.

## Design

1. For each function, list exactly what it reads. Anything time-varying must
   be split out of the cached part. Examples: a node's current voltage, the
   state of a wave.
2. **Chip-power signature**: a cheap hash or bitset of which chips are powered
   and in range. It changes only when power changes.
3. Use a `WeakMap<netlist, Map<signature, analysis>>`, holding a small number
   of entries.

## Must hold

- Bit-identical golden and parity.
- Assertion mode recomputes and compares on every tick. Run the suite once
  with it on.

## Acceptance

5–10% fewer ms/sim-s on `busy-*`. The cached functions disappear from the
profile. Record in RESULTS.md.
