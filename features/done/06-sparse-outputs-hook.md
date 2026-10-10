# 06 — Only route chips with something to do through the `outputs` hook

**Review refs:** engine review §3.3, §4.2 ("`outputs` hook for every chip every
pass"), §7.4
**Depends on:** 00
**Accuracy:** must not change any result. The golden suite and parity must be
**bit-identical**.

## Problem

Under Spice Lite, every powered chip goes through the `outputs` hook on every
pass. The hook:

- counts gate-delay holds;
- books switching spikes;
- tells the voltage side what is driven.

The work is linear in the desk's chip count per pass, even when one chip
changed. `incremental.js` notes why it was left this way: the hook's counting
and spike booking are order-sensitive.

## Goal

A chip goes through `outputs` on a pass only if:

- its computed outputs differ from its committed outputs; or
- it has a pending hold (count > 0); or
- the voltage side must be told about it (first pass after power or netlist
  change).

Every other chip's outputs are read by the voltage side from a cache.

## Design

1. Read the hook and `incremental.js`, and write down the order dependence
   precisely: what is counted, in what order, and what reads it. Put this note
   at the top of the change.
2. Keep a **pending set**: chips with holds in flight. Add chips whose outputs
   changed this pass. Remove chips whose hold completed with no new change.
3. **Spikes** are booked only on an output switch. A chip with no output
   change books none, so skipping it is exact. Preserve the booking order:
   - iterate the dirty chips in the same order the full walk would visit
     them, e.g. sorted by the chip index used today;
   - or prove order-independence and document it.
4. **Voltage side**: give it a cached "driven outputs" view, updated only for
   chips that passed through the hook.

## Must hold

- `engine-parity`, `engine-incremental`, golden: bit-identical.
- A debug assertion mode (env flag) runs the full walk alongside the sparse
  one and asserts identical hold counts, spikes and driven sets on every
  pass. Run the whole test suite once with it on, and report.

## Acceptance

On `busy-*` fixtures:

- `outputs`-hook calls per sim-s fall to roughly the number of switching
  chips;
- ms/sim-s falls.

Record in RESULTS.md.
