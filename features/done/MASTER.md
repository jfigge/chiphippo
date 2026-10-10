# Spice Lite performance series — master runbook

You are working through a series of performance improvements to ChipHippo's
Spice Lite engine. The background is two reviews dated 2026-10-09:

- `spice-lite-engine-review.md` (how the engine runs and where time goes);
- `spice-lite-accuracy-review.md` (the golden scorecard against ngspice).

Read both before starting. Each step's prompt is in this folder.

## Ground rules

1. **Accuracy is the hard constraint; speed is the goal.** Every step states
   its accuracy rule in its header. Most are **bit-identical**. If a step
   changes any golden value, parity result or shipped-example output beyond
   what its header allows, **stop**. Report in RESULTS.md, and do not
   continue to the next step.
2. **One step at a time, in order.** Each step runs on its own branch
   (`perf/NN-slug`), off the previous step's merged result.
3. **Start from a clean baseline.** The reviews were written against an
   uncommitted working tree (bench parts, clock waves, wave-frame fixes).
   Before step 00, confirm with Jason that this work is committed. If it is
   not, stop and ask. Do not commit it yourself.
4. **Measure every step** with `make bench-compare` against the previous step,
   and against the 00 baseline.
5. **Keep assertion modes.** Steps 06–10 each add an env-flagged mode that
   runs the old path beside the new one and asserts equality. Run the full
   suite once with each mode on. Keep the flags afterwards; they are the
   regression net.
6. **Don't widen scope.** Each prompt has an "Out of scope" section. If you
   find a worthwhile change outside it, note it under "Follow-ups" in
   RESULTS.md and move on.

## Order

| #  | Step                                    | File                              | Accuracy rule                    | Gate to proceed                                      |
| -- | --------------------------------------- | --------------------------------- | -------------------------------- | ---------------------------------------------------- |
| 00 | Islands bench + work counters           | `00-bench-islands.md`             | No engine change                 | Baseline JSON committed                              |
| 01 | Stop waking the engine for the display  | `01-display-wakes.md`             | Bit-identical                    | Golden identical; sampler test green                 |
| 02 | Replay drawn cycles from recording      | `02-cycle-replay.md`              | Bit-identical; counts identical  | Counter equivalence green; `555-fast` < 200 ms/s     |
| 03 | Engine in a Worker                      | `03-sim-worker.md`                | No engine change                 | Worker vs main-thread snapshots identical            |
| 04 | Islands: per-island cycles/budgets      | `04-island-analog-bookkeeping.md` | Bit-identical on single-island   | Both-555 periods correct; `555-68k+wave` running     |
| 05 | Skip redundant replay settle            | `05-skip-replay-settle.md`        | All A; deltas ≤ 1e-4, listed     | Incremental exactness green                          |
| 06 | Sparse `outputs` hook                   | `06-sparse-outputs-hook.md`       | Bit-identical                    | Assertion mode clean                                 |
| 07 | Delta level maps                        | `07-delta-level-maps.md`          | Bit-identical                    | Assertion mode clean                                 |
| 08 | Warm incremental cache across ticks     | `08-warm-incremental-cache.md`    | Bit-identical                    | Assertion mode clean on suite + examples             |
| 09 | Cache per-tick analysis                 | `09-cache-tick-analysis.md`       | Bit-identical                    | Assertion mode clean                                 |
| 10 | Change-driven end-of-tick               | `10-change-driven-end-of-tick.md` | Bit-identical incl. warnings     | Assertion mode clean                                 |
| 11 | Allocation-free `piecesAt`              | `11-pieces-scratch.md`            | Bit-identical                    | Golden identical                                     |
| 12 | Islands: per-island scheduling          | `12-island-scheduling.md`         | Single-island identical; ≤ 1e-4  | Examples identical; droop test exact                 |
| 13 | Per-island quantum (optional)           | `13-per-island-quantum.md`        | Intentional change; all A        | **Jason's sign-off**                                 |

Steps 09 and 11 are low-risk and independent. If a higher-risk step stalls,
they may be pulled forward, but note it in RESULTS.md.

## Per-step procedure

1. Read the step's prompt, and the review sections it cites.
2. Read the code it names before changing anything. Where a prompt asks you to
   write down a rule first, do that first: the order dependence in 06, the
   invalidation rule in 08.
3. Implement.
4. Run, in this order:
   - `make test`
   - `SPICE_GOLDEN_REPORT=/tmp/golden-NN.json node --test web/scripts/tests/spice-golden.test.js`
     (from `src/`), then diff against the previous step's report
   - the step's assertion mode, if it has one, over the full suite
   - `make bench BENCH_JSON=bench/results/NN.json`
   - `make bench-compare BASE=bench/results/<prev>.json HEAD=bench/results/NN.json`
5. Append a section to `spice-perf/RESULTS.md` (template below).
6. If the gate passes, commit on the step's branch and merge, or open a PR if
   Jason prefers. Then go to the next step.
7. If the gate fails, stop. Write up what failed, what you tried and the
   options, then wait for Jason.

## RESULTS.md template

```markdown
## NN — <title>

**Branch:** perf/NN-slug  **Commit:** <sha>  **Status:** done | stopped

### What changed
- …

### Accuracy
- Golden: identical | N values changed (table: case, quantity, before, after, Δ)
- Parity / incremental: green | …
- Assertion mode: clean | …

### Performance (ms per sim-second; ticks; settles)
| Fixture | Previous | This step | 00 baseline | Ratio vs prev |
| ------- | -------: | --------: | ----------: | ------------: |

### Notes / follow-ups
- …
```

## Stop conditions (any one)

- A golden value changes in a step whose rule is bit-identical.
- Any golden case drops below A.
- `engine-parity` or `engine-incremental` fails.
- An assertion mode reports a mismatch.
- A step makes any fixture slower by more than 5%, without an explanation
  accepted in RESULTS.md.
- A design question the prompt leaves to Jason, such as step 13's sign-off.
