# 07 — Return deltas from the `levels` hook (no copy mode)

**Review refs:** engine review §3.3, §4.2 ("Copy-mode level maps"), §7.5
**Depends on:** 06 recommended
**Accuracy:** must not change any result. The golden suite and parity must be
**bit-identical**.

## Problem

The `levels` hook takes and returns whole level maps. Under Spice Lite,
`incremental.js` therefore runs in "copy mode": a fresh map of every net, on
every pass.

## Goal

The `levels` hook returns only the nets whose shown level it overrides or
changes this pass, as a delta. The incremental settle applies the delta in
place. Full maps are built only for consumers that need them: the
observer/debugger paths, and the end-of-tick publish.

## Design

1. Change the hook contract to `levels(changedNets, levels) → overrides`,
   where `overrides` is a small Map or array of `[net, level]`. Keep the old
   signature behind an adapter for any caller still using it.
2. `volt.pass()` already knows which clusters it re-solved and which readers
   it re-read. The delta is exactly the nets whose shown level changed among
   those.
3. **Observers and debugger**: when one is attached, materialise a full map
   (as today). When none is attached, don't.
4. The engine with no hooks must keep its existing behaviour.
   `engine-parity` guards it.

## Must hold

- Bit-identical golden, parity and incremental exactness.
- Debug assertion mode: build the full map both ways and compare on every
  pass. Run the suite once with it on.

## Acceptance

On `busy-*`, ms/sim-s falls, and allocation is visibly lower (`--cpu-prof` /
heap snapshot). Record in RESULTS.md.
