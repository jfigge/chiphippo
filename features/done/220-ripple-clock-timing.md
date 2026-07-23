# Feature 220 — Ripple-clock timing (output→clock within one tick)

## Context

The engine's synchronous step (Feature 100) is a fixed **two-phase** `tick`
(`sim/engine.js`): ① pre-settle with the OLD per-component state (propagating the
new `clockPhase` + input changes), ② sample each sequential chip's inputs from the
pre-settle levels and `step` it (edges = pre-settle vs the last tick's
`prevPinLevels`; async overrides win), ③ post-settle with the NEW state. All edges
are observed **at once**, off the pre-settle snapshot.

That is exactly right for **synchronous** designs (every flip-flop shares one
external clock — chained 74LS74, a 74161 ENT/ENP cascade, etc.): the shared clock
edge is present in the pre-settle levels, so every stage samples it together.

It is **wrong** for a **ripple** chain, where one chip's *output* drives another
chip's *clock*. At phase ②, the downstream clock net still shows the driver's
**pre-step** output, so the downstream edge is not seen on the tick it actually
happens — it is deferred to the next tick, and observed at the wrong clock phase.

### The concrete failure

The 74LS90 is a decade counter only when wired the standard way — QA (pin 12) fed
back into CKB (pin 1), since the catalog keeps `cka`/`ckb` separate
(`catalog/chips-74ls.js`). Stepping CKA and pausing after each falling edge yields

```
1, 0, 2, 3, …        (observed)
1, 2, 3, 4, …        (correct — a real 7490)
```

The ÷5 stage never sees QA's fall on the tick it happens; it fires on the *next*
CKA transition. The same class of error hits any manual ripple counter (74107 /
74112 with Qn→CLKn+1) and every cascaded ripple divider. Synchronous designs are
unaffected — this is strictly an output→clock (and output→async-override) ordering
bug.

There is no in-circuit 7490 ripple fixture today, so the truth-table + per-family
suites never expose it (they exercise each chip's `logic` block directly, not a
cross-chip ripple through `tick`).

## Goal

Make an output→clock ripple chain settle to the correct sequence **within one
tick**, matching real hardware (a ripple counter's stages toggle in a cascade of
propagation delays that all complete well inside one input clock period), **without
changing the behavior of synchronous designs** and **without touching the engine's
purity, determinism, or warm-start latch hold**.

## Design decisions (settled)

### Iterate the sequential step to a state fixpoint, not a fixed two phases

Replace the single ②→③ pass with a bounded loop:

1. Pre-settle with the current per-component state (phase ①, unchanged).
2. Sample every sequential chip's inputs from the current settled levels and
   `step` each, detecting edges against the inputs seen at the **start of this
   tick** (`prevPinLevels`) — NOT against the previous inner iteration, so an edge
   is consumed once per tick, never re-triggered.
3. Post-settle with the new state.
4. If any sequential chip's state changed in (2), an output it drives may have just
   created a **new** edge on another chip's clock/async pin. Re-sample and repeat
   from (2), tracking edges relative to a per-tick "already consumed" record so a
   given physical edge fires a given flip-flop at most once.
5. Stop when an iteration produces no state change, or at a hard cap (mirror the
   settle loop's oscillation cap → mark still-changing nets `X` + report
   oscillation).

The invariant that makes this safe: **edges are measured against the tick's entry
inputs plus a per-tick consumed-edge set**, so re-iterating cannot double-count the
external clock edge (synchronous parts step exactly once) yet CAN observe a
*new* internal edge that a just-updated output produced (ripple parts cascade).

### Synchronous designs must be provably unchanged

A shared external clock's edge is consumed on the first inner iteration by every
flip-flop on it; no output on those flip-flops feeds another flip-flop's clock, so
iteration (4) finds no new edges and exits after one pass — byte-for-byte the old
two-phase result. This must be locked by a regression test asserting existing
synchronous fixtures (chained 74LS74, 74161 cascade, cross-coupled NAND latch hold)
produce identical `state`/`pinLevels`.

### Still pure, timerless, warm-started

The loop lives entirely inside `tick` (`sim/engine.js`), a pure function. It adds no
timer and no I/O; warm-starting net levels by stable `netId` across the inner
iterations is what lets each settle converge cheaply (a ripple step perturbs only a
local neighborhood). `SimController` is untouched — it still drives one `tick` per
transport step.

### Termination + oscillation

The inner loop is bounded (same spirit as the 200-iteration settle cap). A pathological
ring oscillator wired as its own clock cannot spin forever: past the cap, the
still-changing sequential nets are marked `X` and an oscillation warning is reported,
exactly as the combinational settle loop already does.

## Implementation steps

1. **`sim/engine.js`** — refactor `tick`'s ②/③ into a bounded fixpoint loop over the
   sequential step; thread a per-tick consumed-edge record so each physical edge
   fires each flip-flop once; keep phase ① and the combinational `settle` calls
   intact; add an inner-iteration cap with the same `X`+oscillation reporting.
2. **Edge bookkeeping** — the edge detector must compare against the tick's entry
   `prevPinLevels` (not the prior inner iteration) AND a consumed-edge set, so
   `step` is idempotent for an already-fired edge within the tick.
3. **Tests (new circuit fixtures through `tick`)**:
   - 74LS90 decade (QA→CKB): stepping CKA yields 0,1,2,…,9,0 — the headline case.
   - 74107 / 74112 ripple pair (Q0→CLK1): a 2-bit ripple counts 0,1,2,3.
   - Cascaded ripple divider (three stages) divides correctly.
   - **Regression**: chained 74LS74 and a 74161 ENT/ENP cascade produce byte-for-byte
     the same settled `state`/`pinLevels` as before (synchronous unchanged).
   - Warm-start latch hold (cross-coupled NAND) still holds.
   - A self-clocking ring hits the cap → `X` + oscillation warning, no hang.
4. **`sim/sequential.js`** — no family-builder change expected; if the consumed-edge
   record needs a hook, extend the shared edge helper, never a per-chip path.

## Acceptance criteria

- A 74LS90 wired QA→CKB, stepped on CKA, counts 0–9 and rolls over.
- A 74107/74112 ripple pair and a multi-stage ripple divider count/divide correctly
  through `tick`.
- Every existing synchronous/latch fixture is unchanged (byte-for-byte state).
- The engine stays a pure, timerless function; a self-clocking loop terminates at the
  cap with an oscillation warning rather than hanging.

## Constraints

- No `SimController` / transport change — the fix is confined to `tick`.
- No per-chip evaluator code; edge bookkeeping stays in the generic step path.
- Determinism preserved (no `Date`/`Math.random`); warm-start net levels retained.
- The inner loop is bounded; oscillation is reported, never spun on.

## Verify

```bash
make fmt && make lint && make test && make debug
```

In the app: place a 74LS90, wire QA→CKB and a clock/switch to CKA, Run (or single-step
the clock), and watch the BCD outputs count 0→9→0. Then confirm a synchronous 74161
cascade is unchanged.
