# Digital engine: an event-driven TICK

> Once approved, this file is saved as `features/digital-event-tick.md`. It is unnumbered:
> ad-hoc work does not get a feature number. It follows issue #12 (krangerich), whose
> findings this plan reproduces.

## Progress

- **A1 done (2026-10-30):** `warmStartOf` skips the per-net diff when it is handed the
  map the last tick returned (`warm.levelsOut`), and the logic engine no longer runs
  `keepLevels`. It still copies the map (`new Map(out)`); A2 removes that copy.
- **B1 done (2026-10-30):** the solve returns the nets it moved (`changed`). `tick`
  skips a sequential chip none of whose read nets moved, provided it still holds the
  state it was last stepped to and the same inputs. A state that steps to itself keeps
  its object. `SIM_ASSERT_STEP=1` checks every skip. Engine tests pass with it on, and
  the W65C02/Z80A examples ran 6000 edges with it on.
- **A2 first cut done (2026-10-30):** the `tick({inPlace: true})` option, passed only by
  the Worker's SimController (`#tickSink`), makes `warmStartOf` update the last tick's
  map in place with no copy. On the main thread (tests, debugger, Arduino) it still
  copies. The fuller design below (`levelOf`, lazy `netLevels`) would extend this to
  the main thread and is still open.
- **A2 done (2026-10-30), Worker and main thread:**
  - Every SimController ticks the logic engine with `inPlace: true`. Each tick's result
    reads its levels through a record (engine.js `lazyLevels`/`levelsOfRecord`).
  - `levelOf(net)` reads the live map until the next tick writes it.
  - `netLevels` is built only when read. It is rebuilt from the live map with each
    later tick's journal of overwritten levels laid back over it (`noteLevels`,
    `work.journal`), and memoized.
  - `liveLevels` (the live map itself) becomes `#warm`.
  - The lamps (`lampBrightness`), the main thread's analyzer cut and the Worker's
    `cutOnce` read one net at a time (`levelOf`/`levelReader`). Sim-tick details carry
    a lazy `netLevels` (`lazyTickLevels`).
  - 620 targeted tests pass with `SIM_ASSERT_STEP=1`, including the three that failed
    the first try.
- **A3 done (2026-10-30):** `chipIndex(ctx)` (incremental.js, now exported) also
  lists `memory` and `timed`. `tick`'s seed, step, memory and wakeAt loops walk only
  their own kind. 467 targeted tests pass with `SIM_ASSERT_STEP=1`. **Phase A is
  complete: the milestone run is next.**
- **Phase A milestone passed (2026-10-30):** `make test` 6443/6443, golden 272/272.
  W65C02 example 44.7 → 30.4 µs/edge; with 3 idle board copies (1966 nets) 94.3 → 32.0.
- **B2 done (2026-10-30):** a solve's first pass walks the marked, watched and
  sequential chips only, not every chip. Under hooks it is equivalent: an unvisited chip
  with no outputs hook is a no-op.
- **B3, first cut (2026-10-30):** `readPinsOf(def)` (chip-eval.js) lists the pins
  `inputLevels` reads, once per def. `inputLevels` walks that list, and `samplePins`
  (no hooks) reads only those pins. The per-chip `Uint8Array` comparison is not done;
  the Map stays the models' interface.
- 600 targeted tests pass with `SIM_ASSERT_STEP=1`, and golden plus incremental 305/305.
- **Phase B milestone (2026-10-30):** `make test` 6443/6443. An A/B against HEAD
  (Phase A, b301af8), with the same script on the same idle machine: W65C02 33.7 vs
  33.4–34.3 µs, Z80A 30.6–32.0 vs 30.9–31.9. **B2 and B3 are within noise.** A fused
  pin-reading check (`readingStands`) was tried and removed: no gain. The Phase A
  figures of 30.4/28.6 were taken on a cooler machine. Run to run, the noise is about
  ±1 µs.
- **What is left is the models:** CPU `step` replays each instruction and throws
  (`w65c02.js:27-40`, `z80.js`), plus the chip models' Map interface. That is a separate
  piece of work.
- **Full suite with `SIM_ASSERT_STEP=1` (2026-10-30): 6443/6443.** No skipped sequential
  chip, in any test, would have stepped anywhere.
- **`scripts/engine-diff.mjs` (2026-10-30): the accuracy gate for every change from here.**
  - It runs the working tree's logic engine beside the one at a git ref. Each tick it
    compares every field of every result (levels, states, pin levels, memory writes,
    warnings, status, wakes, settled, iterations).
  - It covers every example desk (125 desktops) and the busy-4 fixture.
  - It catches real differences: against v1.4.5 it flags the LM339/LM358 examples at
    tick 0.
- **C1 done (2026-10-30): one map for one reading.** `inputLevels(def, pins, prev, alt)`
  hands back `alt` too when it reads the same. The settle's `chipOutputs` passes the
  step's last sample (`c.sampled`), and `samplePins` passes the settle's (`c.lastIns`),
  with no hooks only.
  - Identical to v1.5.3 and HEAD: 250 000 ticks, plus 20 000 each on the W65C02, Z80A
    and busy-4.
  - Speed against HEAD: W65C02 33.8 → 31.2 µs/edge, Z80A 31.5 → 28.7 (about 8 %).
- **C2 tried and removed:** memoizing a sequential chip's `outputs` by (state, reading)
  identity was identical but no faster.
- **C3 done (2026-10-30): a chip's input reading is a `PinReading`** (chip-eval.js):
  levels in an array by pin number, with the part of a Map's surface the models use (`get`,
  `has`, `size`, `keys`, `values`, `entries`, `forEach`, iteration, in pin order) and
  `toMap()`. The models are unchanged.
  - SimController's `exportRun` sends readings as Maps (a structured clone keeps no
    class).
  - Spice Lite's `sameData`/`assertSameAnalysis` treat a reading as a Map
    (`mapLike`).
  - **Checked:**
    - `tests/pin-reading.test.js` drives every sequential, timed and memory def (57)
      through 400 seeded random steps on Maps and on PinReadings. States, outputs,
      memory outputs and writes are identical.
    - `engine-diff.mjs` against v1.5.3: 250 000 ticks, plus 20 000 each on the
      W65C02, Z80A and busy-4, identical.
    - `make test` with `SIM_ASSERT_STEP=1`: 6443/6443, Spice golden and parity
      included. The new test file was written while that run was going, so it was
      not counted.
  - **Speed** against b301af8 (Phase A): W65C02 33.0 → 27.5 µs/edge, Z80A 30.5 →
    25.9, with C1. C3 alone is about 8 %.
- **Full suite including pin-reading (2026-10-30):** `make test` with
  `SIM_ASSERT_STEP=1`, 6500/6500.
- **C4 done (2026-10-30): the chips' pin scratch is a `PinScratch`** (chip-eval.js, an
  array by pin number with `get`/`set`). It is used in `chipOutputs` and `samplePins`,
  read only by `evaluate`, `inputLevels` and `channelStates`. An observer still gets a
  Map of its own.
  - Identical to v1.5.3: 250 000 ticks, plus 20 000 each on the W65C02, Z80A and
    busy-4.
  - Targeted tests 657/657 with `SIM_ASSERT_STEP=1`, pin-reading included.
  - Speed against 8e3ccb0 (Part C): W65C02 about 28 → about 22 µs/edge, Z80A about
    26.4 → about 21.0 (about 20 %).
- **C5 tried and reverted (2026-10-30), all identical to v1.5.3 but no faster than
  C4 in A/B:**
  - an early return from `solve` when no loop net is X;
  - a getter on the solve result's literal in place of `defineProperty`;
  - one walk for `sameOutputs` and the output diff.
  The line profile's shares (6–12 %) did not turn into time. At about 21 µs/edge the
  W65C02 desk is now spread thin; what is left is the settle's own bookkeeping per
  pass.
- **Superseded first try: main thread in place, reverted.** Turning `inPlace` on for every SimController
  (with a copy at publish) failed 3 tests. They keep sim-tick or boundary boards past the
  next tick: the 555 wake test, the timed-part wake test, and "every settle is reported
  at the boundary". The main thread needs the `levelOf`/lazy design below, or those
  readers have to copy what they keep.
- **A2 audit notes:**
  - Per-edge readers of `result.netLevels` in the logic engine:
    - `SimController.#tickOnce` stores it as `#warm` (line ~2814); it can store the
      result and pass no `warmStart` when `warm` is carried.
    - `lampBrightness` (sim/lamp-average.js:108) does `.get` on junction nets only.
    - `#announceTick` (sim-controller.js ~3047) copies it into the sim-tick detail. The
      Worker's `cutOnce` (sim-worker-host.js:269) and the main thread's cut only `.get`
      the analyzer's nets, and do so only while recording; otherwise the map is never
      read.
    - `#boundary` (Arduino integration, main thread only) reads the whole map.
    - `#lastTick`, then publish at 25 fps, reads the latest result only.
  - Plan:
    - Engine: keep one live level Map in the warm work, mutated in place.
    - The result exposes `levelOf(net)` (live while it is the latest) and a lazy
      `netLevels` getter, materialised on read.
    - Before the next tick writes the live map, an unread previous result takes the
      old values of the nets about to change, the way `strongLater`/`beforeChange`
      do. Older results are materialised then, or refused.
    - Switch the readers above to `levelOf` so nothing materialises per edge.
- **Next:** A2 (lazy `netLevels`, SimController hands back `warm` only), then A3, B2,
  B3. Performance and the full `make test` wait for the Phase A milestone.

## Context

The digital engine's **settle** is already event-driven (`sim/incremental.js`, since
2026-10-07). A pass evaluates about 4 of 28 chips and resolves about 2 of 589 nets, and
is 8.3× faster than the full loop (`make bench`).

What is still **O(whole desk) on every clock edge, whatever changed**, is the tick
around the settle. My profile of the busy fixture and issue #12's profile of the
W65C02 example agree on where the time goes:

| where | busy fixture | W65C02 example (#12) | why it's O(N) |
|---|---|---|---|
| `warmStartOf` (incremental.js:286) | ~25 % | 17 % (49 % at 3502 nets) | copies every net into a new Map, diffs it against the last edge |
| `keepLevels` (engine.js:2092) | ~10 % | 6–17 % | copies every net back out |
| step loop (`samplePins`/`inputLevels`/`sameState`) | ~15–20 % | ~16–30 % | samples and steps every sequential chip every inner pass |
| GC | ~13 % | 6 % | the ~56 KB levels Map built each edge |

Reproduced on HEAD with Node 26: the W65C02 example takes 44.7 µs/edge at 430 nets and
94.3 µs at 1966. **The cost grows with nets that do nothing.**

**Goal:** a clock edge costs O(what changed).

## Constraints (from Jason, 2026-10-30)

1. **It must raise performance.** No benchmarked desk may get slower in either engine.
   The digital tick should improve ≥ 1.5× on the busy fixture and the W65C02/Z80A
   examples, and stay flat as idle nets are added.
2. **The ngspice quality gate holds.** Spice Lite stays within 2 % of ngspice:
   `tests/spice-golden.test.js` and `spice-golden-coverage.test.js` unchanged and green.
   Every code path taken with `hooks` set keeps today's behaviour exactly. The new paths
   are taken only when `hooks == null`.
3. **No excessive time to resolve.**
   - No settle takes more passes than today, and the oscillation and tie-break caps are
     unchanged.
   - The work is staged so that each phase is useful on its own and can stop there.
4. **The format may change.**
   - The tick's API, and the rule that a pass is identical to the full loop's, may be
     relaxed where that is what buys speed.
   - The bar becomes **edge-equivalence**: after every edge, the same net levels,
     sequential states, pin levels, memory writes, warnings, chip status and `wakeAt` as
     `mode: "full"`.

## Phase A — remove the per-edge desk walks (bounded, keeps exact identity)

### A1. Persistent levels in the warm work
- In `warmStartOf`, when `warmStart` is the object this work last returned
  (`work.levelsOut === warmStart`), skip the O(nets) copy and diff.
- The delta then comes only from what is already tracked: `touched` (the `sourcesBase`
  diff, which is O(sources)), `pending`, and replaced states.
- Any other map (tests, Run, debugger replay, `importRun`, any `hooks`) takes today's
  full diff.
- Levels live in the work's index-keyed array, updated in place, so `keepLevels` goes
  away.

### A2. Lazy `netLevels`
- `result.netLevels` becomes an accessor (like `strongLater`).
- Per-edge readers read the nets they need through `result.levelOf(net)`:
  - the analyzer cut;
  - `lampBrightness`;
  - the integration boundary.
- The Map is built at publish (25 fps) and wherever a caller keeps one by identity: the
  last shown board, the Worker's cut cache.
- SimController hands back `warm` alone; `warmStart` stays undefined.
- Audit every `.netLevels` reader in `components/` and `sim/` before switching.

### A3. Kind lists
- Precompute the timed, memory and sequential chip lists in `buildContext`, so `tick`'s
  `wakeAt`, memory and seed loops walk only their own kind.

### Phase A gate
- Run `make bench`, issue #12's `perf-6502.mjs` (W65C02 and Z80A at 0/1/3/6 board
  copies) and the full golden suite.
- **Stop here if Phase A reaches the target.**

## Phase B — event-driven step loop (uses the relaxed rule)

### B1. Step only the sequential chips something can have moved
- Each solve returns the net indices whose level changed (`solved.changed`, built up
  from the passes' deltas).
- A sequential chip is skipped (it keeps `prevIns`, state and `finalIns`) when:
  - none of its read nets changed (an inverse of `settle-index.js` `readers`);
  - its state is the object it was last stepped with;
  - it is not timed;
  - no observer watches it;
  - `hooks == null`.
- Without this, its step gets `ins === before` and must return state verbatim (the
  documented edge-gated, idempotent contract).
- `SIM_ASSERT_STEP=1` steps the skipped chips anyway and throws on any difference. This
  audits every builder in `sequential.js`, the timers and both CPUs.

### B2. No full re-evaluation on a solve's first pass
- Today the first pass of every re-solve evaluates every chip. The relaxed rule allows
  the first pass to evaluate only the chips whose state was replaced by the step, plus
  the readers of `changed`.
- This changes pass counts, not edge results, so the oracle below must hold it.

### B3. Cheaper input reading
- Replace `inputLevels`' per-call Map with a per-chip `Uint8Array` of read levels
  compared in place. A new Map is built only when a level changed, because the models
  keep their Map interface.

### Phase B gate
- The same benches.
- Any desk slower than after Phase A is backed out by step.

## Not in this plan

- A full rewrite like #12's prototype (a `Uint8Array` engine with its own queue). It
  needs warnings, power status, oscillation, tie-breaks, analog switches, diodes and
  timed parts rebuilt. That is too long for constraint 3.
- Revisit it only if Phase B leaves the CPU desks short of 10 kHz ×1.
- The CPU cores' replay and throw (`w65c02.js:27-40`), and Spice Lite: separate pieces
  of work.

## Files

- `src/web/scripts/sim/incremental.js`: `warmStartOf`, persistent levels, `changed`,
  first-pass marking
- `src/web/scripts/sim/engine.js`: `tick` (lazy netLevels, kind lists, step skip)
- `src/web/scripts/sim/settle-index.js`: per-chip read-net list
- `src/web/scripts/sim/chip-eval.js`: `inputLevels`
- `src/web/scripts/components/sim-controller.js`, `sim-worker-host.js`,
  `sim/lamp-average.js`: warm-only hand-back, by-net readers
- `src/web/scripts/bench/engine.bench.js`: add #12's CPU-example and idle-copies cases

## Verification

- **Edge oracle:** `tests/engine-incremental.test.js`. Phase A keeps its field-by-field
  equality as it is. Phase B relaxes it to per-edge result fields only (levels, state,
  pinLevels, memWrites, warnings, chipStatus, wakeAt), with the pass-count assertions
  dropped. Add the W65C02/Z80A examples (20k edges, both LCDs read "Hello World") and
  the warm identity hand-back.
- **ngspice:** `spice-golden.test.js` and `spice-golden-coverage.test.js` green, with no
  reference regenerated.
- `SIM_ASSERT_STEP=1` over the fixture suites and `make demos`.
- `sim-worker.test.js`, `sim-controller-timing.test.js`, `lamp-average-bounce.test.js`.
- **Performance:**
  - `make bench` and `perf-6502.mjs` before and after each phase;
  - `make profile` on busy16 at 1 kHz ×4 and the W65C02 example at 10 kHz ×4;
  - Spice Lite figures unchanged or better.
- Targeted tests per change; `make test` once at the end.

## Will it pay off?

- **Engine.**
  - Phase A removes ~35–45 % of a digital edge on the busy fixture, and most of the
    growth with idle nets.
  - Phase B removes much of the remaining step-loop share.
  - Expected: **about 1.5–2.5× per edge**, more on large, mostly idle desks.
- **Where users see it:** CPU computers at high clock rates or ×4, slower machines, and
  big desks reading behind (amber ×). On typical desks at ≤ 1 kHz ×1 the engine was ~2 %
  of the app's time, so the gain there is CPU and battery, not anything on screen.
- **Spice Lite:** unaffected by design (constraint 2). Its edges cost ~0.53 ms, ~9× a
  digital one, and it is where users wait most. It is the natural follow-on.
