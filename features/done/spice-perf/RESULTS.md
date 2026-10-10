# Spice Lite performance series — results

Runbook: `features/MASTER.md`. One section per step, in order.

**How this was run.** Every step was done on `main`'s working tree, uncommitted:
the project's CLAUDE.md forbids Claude from committing or creating branches, and
Jason edits in parallel (a branch switch would sweep his work up). So the
"Branch / Commit" lines below name what the step _would_ be committed as; the
work itself is left for Jason to review and commit. The baseline (bench parts,
clock waves, wave-frame fixes) was confirmed committed before step 00:
`d64a3e6 Added variable clock wave forms` holds them, and `git status` showed
nothing modified but the untracked plan files.

Artifacts:

- bench JSON per step: `src/web/scripts/bench/results/NN.json`
  (`make bench BENCH_JSON=…`); the 00 baseline also as
  `src/web/scripts/bench/baselines/spice-perf-00.json`;
- golden scorecard per step: `features/spice-perf/golden/NN.json`
  (`SPICE_GOLDEN_REPORT=…`), diffed with `node scripts/golden-diff.mjs A B`
  (every value not bit-identical, with its relative change).

Timing noise: the same tree benchmarked twice moves a fixture's ms/sim-s by up
to ~10 % on this machine (busy-square 77–87 ms). Each fixture is timed three
times (after a JIT warm-up) and the fastest kept; counters (ticks, settles,
passes, evaluations, outputs calls, cluster solves) are deterministic and are
the numbers to judge a step by.

---

## 00 — Islands bench + work counters

**Branch:** perf/00-bench-islands (not created — see above) **Commit:** — **Status:** done

### What changed

- `src/web/scripts/bench/drive-spice.js` — the reusable driver: Spice Lite
  ticked exactly as SimController ticks it (netlist with inductors as
  branches, `prepareCircuit` kept, clocks idle LOW at Run and counted from 0 by
  `EdgeSchedule`, `clockTimes`, each tick handed the last one's `netLevels`,
  `state`, `pinLevels`, `analog`; the next tick at the earlier of the next edge
  and `max(wakeAt, last + MIN_SHOWN_S)`; `scope` → `spice.waveFrames`).
- `src/web/scripts/bench/islands-fixtures.js` — the ten fixtures. The busy
  board is `busyDocument(4)` (28 chips); each 555 is `astable555` (RA 1 k,
  RB 10 k; C 1 µF / 10 nF / 1 nF for ~69 Hz / ~6.9 kHz / ~68 kHz) relabelled
  onto its own board and its own PSU; the second 555 of `555-fast-x2` has
  RB 12 k (a different period, so the pair never lines up by accident); the
  wave fixtures are a clock brick (own PSU) into an RC low-pass (10 k/1 µF for
  the 10 Hz triangle, 1 k/1 µF for the 250 Hz sine).
- `src/web/scripts/bench/islands.bench.js` — per fixture, over the last 80 %
  of its run: ms, ticks, settles, passes, chip evaluations, `outputs`-hook
  calls and cluster solves per simulated second, plus a RUNNING CHECK per
  oscillator (its timing readout's measured period — true time, a drawn cycle
  included — against 0.693·(RA+2RB)·C; `running` / `chatter` (an `oscillation`
  warning in the window) / `not running`; and whether the run ended `drawn`
  by a cycle schedule or `stepped` edge by edge).
- Counters: `opts.stats` already carried the digital engine's `passes`,
  `evaluations`, `solves`, `clusterSolves`; Spice Lite now adds `settles` (in
  `settleAt`) and `outputsCalls` (in the `outputs` hook) — two guarded
  increments, nothing when `stats` is absent.
- `Makefile`: `make bench` runs the old busy-circuit tick bench and the
  islands bench (`BENCH_ONLY=islands` skips the former; `BENCH_JSON=path`
  writes JSON, path relative to the repo root); `make bench-compare BASE=…
HEAD=…` (`scripts/bench-compare.mjs`) prints head/base per fixture and
  counter and both running checks.
- `scripts/golden-diff.mjs` — golden scorecard diff (used from step 01 on).

### Accuracy

- No engine behaviour changed (two counters behind `if (opts.stats)`).
- `make test`: 4547 tests, 4545 pass, 2 skipped (the Digital CLI pair), 0 fail.
- Golden: reference report written, `features/spice-perf/golden/00.json`.

### Performance (ms per sim-second; per sim-second counters) — the baseline

| Fixture               |     ms | ticks | settles | passes |  evals | outputs | clusters | oscillators                      |
| --------------------- | -----: | ----: | ------: | -----: | -----: | ------: | -------: | -------------------------------- |
| busy-square           |   77.3 |   201 |     201 |    703 |   4348 |    9835 |      831 |                                  |
| busy-triangle         |  452.5 |   603 |    1558 |   3070 |  26423 |   42980 |     4075 |                                  |
| busy-triangle-noscope |  333.1 |   403 |    1108 |   2620 |  20123 |   36680 |     3425 |                                  |
| 555-slow              |   88.2 |   336 |     873 |   1408 |   1274 |    1408 |     1476 | running, stepped, 1.0209×        |
| busy+555-slow         |  385.8 |   528 |    1273 |   2315 |  21573 |   34725 |     2908 | running, stepped, 1.0209×        |
| 555-fast              |  423.0 |  2000 |   10000 |  18000 |  16000 |   18000 |    14000 | running, drawn, 1.0218×          |
| 555-fast-x2           | 9209.4 |  2000 |   52862 | 151862 | 179975 |  303725 |   159225 | both running, **stepped**        |
| busy+555-fast         | 2229.9 |  2006 |   10031 |  18562 | 166062 |  278437 |    14875 | running, drawn, 1.0218×          |
| 555-68k+wave          |  126.7 |    21 |     680 |   2018 |   1668 |    2018 |     2039 | **chatter** (backed off), 1.029× |
| rc-sine               |   83.7 |   501 |    1003 |   2005 |      0 |       0 |     1504 |                                  |

(The "ratio" is the measured period over the datasheet formula: Spice Lite's
NE555 runs ~2 % long against 0.693·(RA+2RB)·C with RA = 1 k — the formula
ignores the discharge transistor's saturation and the comparator bias the
silicon models; the golden NE555 area grades the part against ngspice at A.)

### Against the review's §6 table (same machine class)

| Desk                | Review §6 | 00 baseline | Note                                                                         |
| ------------------- | --------: | ----------: | ---------------------------------------------------------------------------- |
| busy, 100 Hz square |       192 |          77 | the review's numbers include the JIT warm-up of a one-shot script; see below |
| 555 ~69 Hz alone    |       249 |          88 | ″                                                                            |
| busy + slow 555     |       818 |         386 | same shape: **2.3× the sum of the parts** (review: 1.9×)                     |
| fast 555 alone      |      1194 |         423 | drawn as a cycle, 2000 ticks/s in both                                       |
| two fast 555s       |    12 392 |        9209 | same shape: **22× one**, never a cycle (review: 10×)                         |
| busy + fast 555     |      4143 |        2230 | same shape: **5.3× the 555 alone** (review: 3.5×)                            |
| 555 68 kHz + wave   |       333 |         127 | same shape: chattering, 21 ticks/s — **not running**                         |

The absolute numbers are 2–3× lower than the review's because the bench warms
the JIT and keeps only the steady 80 % of a run (a one-shot timing of the same
fixture, cold, gave 188 / 146 / 559 / 516 / 9834 / 2473 / 245 — the review's
range). Every _shape_ the review reports reproduces: the coupled desks cost
more than the sum of their parts, two unrelated fast oscillators never form a
cycle, and the 68 kHz 555 beside a wave chatters into the back-off.

### Notes / follow-ups

- `make bench`'s old busy-circuit section still runs first (BENCH_ONLY=islands
  skips it); its numbers are unchanged by this step.

---

## 01 — Stop waking the engine for the display

**Branch:** perf/01-display-wakes (not created) **Commit:** — **Status:** done (two deviations from the prompt's design, below — please review)

### What changed

- **`sim/spice/sample.js`** (new): `sampleAnalog(analog, t)` — every RC node,
  running wave and coil read off the carried curves (`valueAt`, the engine's
  own evaluator; a drawn cycle off its schedule exactly as `applySeg` stands
  it), no settle, nothing mutated; and `nextDisplayFrame(analog, target, t,
  {gapPercent, waveFrames})` — the old frame rule (a moving node every
  `ANALOG_FRAME_S`, a running wave `WAVE_FRAMES` a period while the analyzer
  records, a coil still moving; none while chattering), now in one place.
- **Engine** (`sim/spice/engine.js`): the three display-frame `later(…)` calls
  are gone from `wakeAt`; the same rule is reported beside it as **`frameAt`**.
  `wakeAt` now holds only crossings/corners (incl. coil and group corners),
  drawn-cycle segments, timers, relays, regulator cool-down, the chatter
  back-off and the resettle nudge — documented in the file header. The analog
  state carries `waves` (wave net → clock id) for the sampler.
- **SimController**: publishes at most every `PUBLISH_MS` = 40 ms (25 fps;
  `sim-pacer.js`; batches still run on the 8 ms `FRAME_MS` cadence, an input's
  tick still publishes at once). A published board is the last tick's with its
  moving nets **sampled at the sim clock** (`#sampled`/`#shownAt`, clamped to
  the next wake); while anything moves (`#frameAt`), the pacer re-arms every
  `PUBLISH_MS` though no event is due, so an RC charging with nothing reading
  it is redrawn at 25 fps with **no tick at all**; pause shows the paused
  moment. While the analyzer records, the frames between two ticks go out as
  sim-ticks of their own, read off the curves (`#emitFrames`) — the analyzer's
  columns land where the engine's frame ticks used to put them.
- **Pre-existing bug fixed (required by this step):** `analog.inputs` was the
  caller's clock/signal maps BY REFERENCE, and SimController flips them in
  place — so the next tick's history replay (`before`, "the previous tick's
  inputs") ran on the NEW clock phase. A 10 Hz square clock into an RC
  (τ = 10 ms) through `driveSpice` showed the node at 4.97 V at the first
  edge, where it should be 0.00 V: the RC was charged from the previous tick,
  half a period early (HEAD does the same whenever the node had arrived and no
  frame ticked in between). With display frames gone the replay window is the
  whole gap between events, so this had to be fixed for the step's "no engine
  result changes" to hold in the app: `analog.inputs` is now a copy. Every
  test harness passed fresh maps per tick, which is why nothing caught it.
- **Pre-existing test-harness bug fixed:** on Node 23.11 the golden harness's
  `measure()` result (an object literal `{"period/s": …}`) was observed
  SHARED between calls once the JIT warmed — later calls' values written into
  an earlier case's answer, even after `Object.freeze`. The tick-spacing check
  then compared each re-run with itself, and the report held another case's
  numbers (the 00 report happened to be written by a run where it did not
  trigger; verified value-by-value against area-by-area runs). Built by
  assignment now. Not reduced to a standalone reproduction.
- Tests: `tests/spice-sample.test.js` (new — sampler against a forced engine
  tick at 200 random instants per fixture: single curves, a coupled group, a
  coil, two waves, a drawn cycle; `nextDisplayFrame`), two SimController tests
  (25 fps redraws of a moving node with no tick, paused value, stops when
  arrived; analyzer frames as sim-ticks); tests that walked time by `wakeAt`
  through frames now walk `min(wakeAt, frameAt)` (the old cadence) and assert
  `frameAt` where they asserted frames.
- Tooling: `scripts/profile-desk.mjs` gained `PROFILE_WAVE`, `PROFILE_SCOPE`
  and counts every page exception / `console.error` during the run.
- Rules updated: `.claude/rules/spice-lite.md` ("Display frames are no wakes"),
  `.claude/rules/simulation.md` (publish cadence).

### Accuracy

- **Golden: bit-identical** to 00 (`node scripts/golden-diff.mjs`): the
  harness keeps `frameAt` in its tick grid, so the scorecard measures exactly
  what it did (and the engine computes the same thing for the same ticks).
  **Ticked without frames** (the app's cadence now) the values move by at
  most **6.0e-8 relative** (the coupled gate oscillators, whose group is
  re-anchored at every tick; the NE555/Schmitt cases ≤ 8e-12, every transient
  case identical) — 1600× inside the tick-spacing bar (1e-4). That run is now
  one more entry in every case's tick-spacing check, on every `make test`.
- Sampler vs forced tick: single curves agree to 1e-9 V, drawn cycles exactly;
  a coupled group's node to 1e-9·(2 + |V|) and a coil's current to 1e-6 of
  itself — the forced tick re-anchors and re-linearizes the group (common mode
  balanced to `BALANCE_V` = 1e-9 V, slopes read numerically); the sample reads
  one curve exactly. (Against the closed form of a sine into an RC, the
  sample is the right one: 1.78365 V at 5 ms vs 1.78364 analytic.)
- `make test`: 4556 tests, 4554 pass, 2 skipped, 0 fail. Parity and
  incremental exactness green.
- Real app (`PROFILE_SPICE=1 PROFILE_WAVE=triangle PROFILE_SCOPE=1 make
  profile`, 8-slice busy board): 0 page exceptions, 24 sim-states/s, the
  analyzer recording; digital and Spice Lite square runs likewise clean.

### Performance (ms per sim-second; per sim-second counters)

| Fixture               |   00 |   01 |  ratio | ticks 00→01 | settles 00→01 |
| --------------------- | ---: | ---: | -----: | ----------: | ------------: |
| busy-square           |   77 |   80 |   1.04 |   201 → 201 |     201 → 201 |
| busy-triangle         |  453 |  264 | **0.58** | 603 → **403** | 1558 → 838 |
| busy-triangle-noscope |  333 |  247 | **0.74** |   403 → 403 |  1108 → 838 |
| 555-slow              |   88 |   88 |   1.00 |   336 → 336 |     873 → 873 |
| busy+555-slow         |  386 |  377 |   0.98 |   528 → 528 |   1273 → 1273 |
| 555-fast              |  423 |  420 |   0.99 | 2000 → 2000 |  10000 → 10000 |
| 555-fast-x2           | 9209 | 9294 |   1.01 | 2000 → 2000 |  52862 → 52862 |
| busy+555-fast         | 2230 | 2257 |   1.01 | 2006 → 2006 |  10031 → 10031 |
| 555-68k+wave          |  127 |  132 |   1.04 |     21 → 21 |     680 → 680 |
| rc-sine               |   84 |   79 |   0.94 |   501 → 501 |   1003 → 1003 |

Acceptance: `busy-triangle` falls to `busy-triangle-noscope` (264 vs 247 ms,
403 ticks each) — the scope's wave frames are gone. No fixture is slower
beyond noise (every counter identical or lower; the 1.04s are timing noise).
`busy-triangle-noscope` loses a quarter of its settles without losing a tick:
that is the `analog.inputs` fix — its history replays no longer see the clock
edge early and chase it.

### Deviations from the prompt (for Jason)

1. **`sim-tick` is not coalesced to one per frame with an event log, and the
   analyzer is not redrawn from curve segments at pixel resolution.** The
   analyzer's recorder is tick-indexed (its x axis is TICKS — stated in the
   user guide); rebuilding it on a time axis is a feature of its own. Instead
   it keeps receiving one sim-tick per engine tick (now only real events) plus
   one per old display frame, sampled from the curves — the same columns it
   recorded before, no engine work behind them.
2. **Item 6 (no per-segment wakes for a drawn cycle with no digital
   consumer) is left to step 02**, which the prompt allows ("otherwise keep
   today's behaviour in this step").

### Notes / follow-ups

- Not sampled between ticks (they need a solve, not a curve): a NON-node net
  in a moving cluster (the far end of a resistor from a capacitor) and an
  LED's current off a moving node. They used to move at every frame tick; now
  they move at the next real event (a corner of the node's network, e.g. a
  junction-table sample, is one). An LED fading from a capacitor will step
  between its corners instead of every 1/30 s. A follow-up could carry each
  moving cluster's affine statement (`volt.affine`, already computed for
  listeners) and the junctions' currents in `analog` and sample those too.
- `driveSpice` mutates its clock map in place on purpose (as SimController
  does) — it is what exposed the aliasing.

---

## 02 — Replay drawn cycles from recording

**Branch:** perf/02-cycle-replay (not created) **Commit:** — **Status:** done

### What changed (all in `sim/spice/engine.js`)

- **Scope** (`cycleScope`, at `enterCycle`): the cycle's chips — those on the
  nodes' networks, the very set the drive signature counts — and every net
  their pins are on (rails aside). No scope (every segment settled exactly as
  before) when a **memory chip** is anywhere on the desk (each settle reports
  its writes) or there is a **consumer**: any other chip with an input on one
  of those nets, or anywhere in a voltage cluster one of them is in.
- **Record** (`settleSeg`): each segment settled keeps what it did to that
  scope — the nets' levels and the chips' state, read pins, driven and held
  outputs before and after, its drive signature and its own spike peak.
- **Replay** (`replaySeg`): a segment whose scope stands EXACTLY where a
  record's "before" stood (deep equality, chip by chip) is put back from the
  record — levels, state, pins, outputs, holds — its readouts noted and its
  spikes booked, and then its drive is checked as a settle's would be (a
  supply, a CONT voltage moved from outside: settled instead). Never before
  the tick's first settle (the context is the settle's to build). The tick's
  own moment is always settled for real, so every tick ends fully settled.
  Clocks and signals are not compared: a segment's settle runs on the inputs
  the previous tick's own settle ran on, and they reach the cycle's chips only
  through its nets, whose levels are compared.
- **Frame jumps**: a whole cycle of segments replayed (or settled to exactly
  their record) is STEADY; a steady cycle with nothing recording it
  (`spice.waveFrames === false` — SimController's "no analyzer channels") is
  woken `max(next segment, target + ANALOG_FRAME_S)` — a display frame, not
  a segment. Each such tick walks at least one cycle of segments, starting at
  the segment after the last one shown (the board stands where it left it;
  starting anywhere else broke the drive check), so a timing readout still
  measures a rise against the one a shown period before. While the analyzer
  records, every segment is still woken (and replayed).
- `spice.replay: false` settles every segment — the reference; carried state
  `analog.cycleMemo`, `cycleSteady` and `quiet` (a record is carried only
  after a tick that ended settled, not capped, nothing left to resettle).
- `driveSig` reads `prev` (the pins a replay put back) — identical to the
  last settle's `result.pinLevels` whenever a settle ran.
- A settle's spike peak is folded at its own start and end (`settlePeak`);
  folding an empty pass changes nothing.

### Accuracy

- Golden: **bit-identical** to 01 (no golden case draws a cycle).
- `make test`: 4565 tests, 4563 pass, 2 skipped, 0 fail.
- `tests/spice-cycle-replay.test.js` (new), each case run replayed and with
  `replay: false`:
  - fast 555 alone, 0.5 s: levels, every part's state and read pins
    identical at the end; readout period equal to 1e-12; cycle period equal;
    20× fewer settles, 10× fewer ticks;
  - the same with the analyzer recording: the same wakes, still replayed;
  - **counter-on-555 at 4.7 / 10 / 22 nF: identical counts and boards** (a
    consumer: never replayed). Run at **10 s each** once, green (30 s of wall
    time); kept at 2 s (0.5 s in `test-fast`) in the suite;
  - a 4060 counting its own oscillation: never steady (its state is no
    cycle's), the same ticks, the same board;
  - RESET pulled at 0.3 s: the cycle ends at **exactly 0.3 s** both ways and
    is drawn again after it is released;
  - an SRAM on the desk: never replayed;
  - the busy counter board beside a fast 555 (the `busy+555-fast` fixture),
    0.1 s: identical board, 4× fewer settles.
- The existing silicon tests (the 4060's true count, the 555/4541 true
  rates, a fast 555 following CONT moved through a resistor — a drive check
  failing on replay) are unchanged and green.

### Performance (ms per sim-second; per sim-second counters)

| Fixture               |   01 |      02 | ratio vs 01 | 00 baseline | ticks 01→02 | settles 01→02 |
| --------------------- | ---: | ------: | ----------: | ----------: | ----------: | ------------: |
| 555-fast              |  420 | **5.3** |    **0.01** |         423 |   2000 → 30 |   10000 → 60 |
| busy+555-fast         | 2257 | **205** |    **0.09** |        2230 |  2006 → 206 |  10031 → 412 |
| busy-square           |   80 |      79 |        0.98 |          77 |   201 → 201 |     201 → 201 |
| busy-triangle         |  264 |     272 |        1.03 |         453 |   403 → 403 |     838 → 838 |
| busy-triangle-noscope |  247 |     257 |        1.04 |         333 |   403 → 403 |     838 → 838 |
| 555-slow              |   88 |      92 |        1.04 |          88 |   336 → 336 |     873 → 873 |
| busy+555-slow         |  377 |     381 |        1.01 |         386 |   528 → 528 |   1273 → 1273 |
| 555-fast-x2           | 9294 |    9466 |        1.02 |        9209 | 2000 → 2000 | 52862 → 52862 |
| 555-68k+wave          |  132 |     132 |        1.00 |         127 |     21 → 21 |     680 → 680 |
| rc-sine               |   79 |      79 |        1.00 |          84 |   501 → 501 |   1003 → 1003 |

Acceptance: `555-fast` **5.3 ms/sim-s** (target < 200); settles fall by more
than two orders of magnitude for both fast-555 fixtures (10000 → 60; 10031 →
412). The other fixtures' counters are identical; their 1.02–1.04 ms ratios
are timing noise. `busy+555-fast` now costs about `busy-square` + a little:
the 555's segments are replayed between the counter's own edges.

### Notes / follow-ups

- Replay falls back to settling every segment (listed, as the prompt asks):
  a memory chip anywhere on the desk; any chip outside the cycle reading one
  of its nets or a net in one of its voltage clusters (a counter on a 555's
  OUT, a gate on its capacitor); a cycle whose chips' state changes from one
  cycle to the next (a 4060/4541 counting it — they are advanced by their
  true cycle count at each settle exactly as before, so nothing is lost, but
  their cycle is never steady and is woken per segment).
- "Advance a counting part by its true cycles in one step" (the prompt's
  first option) was not needed: the 4060/4541 already count from the true
  cycle count at every settle; the gain for them would need their slow
  outputs to stay exact between frame ticks — left as is.
- Two unrelated fast oscillators (`555-fast-x2`) and a 555 beside a running
  wave still never form one cycle — step 04.

---

## 03 — Engine in a Worker

**Branch:** perf/03-sim-worker (not created) **Commit:** — **Status:** done
(first stopped on a design question; Jason, 2026-10-09: "do step 03 — when a
user is working with an Arduino or debugging a custom chip I am fine for the
simulation to run slower and therefore in the main thread". 09 was done in the
meantime, below.)

### Design

- **The Worker runs the very same SimController** the main thread does
  (`components/sim-worker-host.js`, entry `components/sim-worker.js`, a module
  Worker loaded from `file://` under the page's CSP — verified first with a
  probe worker importing the engine). So the transport, batches, pacing,
  sampling, warnings and memory logic exist once and cannot drift; what
  differs is only what surrounds it. SimController and NetlistCache gained a
  `scope` option (the EventTarget they hear and tell events on — the window,
  or the Worker's global) and SimController a `pacing` option.
- **`components/sim-host.js` `SimHost`** is what the app now holds: the same
  public surface as SimController, method for method. Where it can it runs
  the run on the Worker; on the main thread (a local SimController) when the
  desk has an Arduino integration, a custom chip is armed for debugging, there
  is no Worker (Node, jsdom), or `localStorage["chiphippo.simWorker"] ===
  "off"`.
- **Across the boundary**: the document snapshot (at Run and on every edit),
  the held buttons, the setting, the speed, the catalog (the Worker raises the
  toasts) and the custom chips go in; every `sim-state`, `sim-tick` and
  `mem-state` the Worker's controller dispatches comes back in order, batched
  per task, re-dispatched on the window with THIS thread's netlist of the same
  version put back (the Worker leaves its own behind; net ids are the same —
  one `buildNetlist` of one document). A sim-tick is cut to the nets the
  analyzer reads. Toasts, damage latches (written into the real document,
  `chiphippo:doc-changed` told as SimController tells it), ROM loads (the
  `window.chiphippo.mem` bridge, answered by the main thread) cross back as
  messages.
- **The transport is answered on the main thread at once** (Run/Pause/Resume/
  Step lock and unlock the desk on the press); **Stop entirely** — toasts
  dismissed, latches cleared from the document before the transport change,
  the stopped board published — and every message names its run, so nothing
  a stopped run had in flight lands in what is loaded next. An input reaches
  the board a message later: it shows on the next frame.
- **A custom chip armed mid-run**: the host sees the debugger's observer come
  on, asks the Worker for the run (`SimController.exportRun` — the whole
  run-volatile state as plain data, the analog curves included, a drawn cycle
  left to be found again) and carries on in the local controller
  (`importRun`); calls made meanwhile are replayed there. It stays on the main
  thread until Stop. `chipSnapshot` (what the debugger arms from) answers from
  each frame's custom-chip readings; `imageBytesOf` from a mirror of the
  memories (their bytes at Run, then every `mem-state` change).
- **Pacing in the Worker** (`WORKER_PACING`): no gap after a publish and 30 ms
  of work per batch (of a 40 ms publish frame) — with the main thread's 6 ms
  batches it ran no faster than on the main thread (timer clamping between
  short batches); with 30 ms it runs 1.5× the main thread's rate.

### Accuracy

- No engine change: golden **bit-identical** to 09.
- `make test`: 4677 tests, 4675 pass, 2 skipped, 0 fail.
- `tests/sim-worker.test.js` (new): one scripted run — Run, time, a signal
  pressed and released, a clock paused on its own, Pause, Step ×2, Resume,
  an edit, Stop — on a Spice Lite desk (a 555, a clock, an RC, a flag, an
  analyzer channel) through SimController and through SimHost on an
  in-process "Worker" (its own scope, every message structured-cloned, each
  delivered as a task), each on its own fake clock: **every sim-state
  identical** (all fields but the netlist object), every analyzer column's
  time, level and voltage identical, the same toasts. Plus: an Arduino on the
  desk runs on the main thread; a chip armed mid-run is handed over and the
  run carries on; a damage latch reaches the real document and Stop clears
  it; an SRAM's bytes on the main thread equal the direct run's.
- The real app (`make profile`, 0 page exceptions in every run; Spice Lite):

| Desk                                   | Main thread                                | Worker                                     |
| -------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| 8 slices, 100 Hz triangle + analyzer ×1 | ×0.95 achieved, main thread 58 % busy      | **×1 (keeps up), main thread 8 % busy**    |
| 16 slices, 100 Hz square, ×4           | 373 ticks/s (×2.0), main thread 73 % busy  | **554–572 ticks/s (×2.8), main thread 11–12 % busy** |

  Headroom: the engine gets most of a core (30 ms of each 40 ms) instead of
  6 ms of each 8 ms shared with rendering and GC, and the views keep ~25 fps
  sim-states and 30–40 committed frames a second with the engine saturated.
  (Two profile runs drew no frames — the window hidden or the display asleep;
  discarded. The Worker kept simulating through them; the main thread did
  not.)

### Notes / follow-ups

- The bench (engine only) is unchanged by this step; `results/03.json` was
  taken while another Electron app was busy on the machine (every fixture
  ~1.5× slower, every counter identical) — compare counters, not ms.
- Not exercised in the real app here: the debugger hand-over and the ROM
  bridge (covered by the unit tests only); worth a manual check: arm a custom
  chip mid-run; run a desk with an EPROM.
- A language change mid-run reaches the Worker's toasts at the next Run.

---

## 09 — Cache per-tick analysis (pulled forward while 03 waited)

**Branch:** perf/09-cache-tick-analysis (not created) **Commit:** — **Status:** done

### What changed

- `sim/engine.js` `contextFor`: under hooks, the last context built is reused
  while every hook answer it read is the same (`hookKey`: each PSU's
  `psuVolts`, each part's `chipDrop`, and `chipVolts` for a part fed off the
  rails — `hookShapeOf` lists them once per document + netlist, on the
  context's `fixed` facts) and `logicOf` is the same. A context is a pure
  function of those, the document and the netlist.
- `sim/spice/engine.js`: `analyze` cached per context + setting (`ANALYSES`);
  the listeners, their key map and each node's own supply per context
  (`HEARD`, also keyed by the analysis and topology objects); `relaysOf` per
  document snapshot.
- `sim/spice/voltages.js`: `makePlan` (the per-context plan) per context +
  setting + topology (`PLANS`).
- `sim/assert-modes.js` (new): the series' assertion-mode flags.
  `SPICE_ASSERT_ANALYSIS=1` rebuilds every reused context / analysis /
  listener set / plan and throws if any field differs.
- `tests/spice-examples-run.test.js` (new): every shipped example desktop run
  as the app runs it (prepared context kept) — a smoke run normally, the run
  the assertion modes are switched on over (`SPICE_EXAMPLE_SECONDS=5`).

### Accuracy

- Golden: **bit-identical** to 02.
- `make test`: 4673 tests, 4671 pass, 2 skipped, 0 fail.
- **Assertion mode**: `SPICE_ASSERT_ANALYSIS=1 make test` — 4671 pass, 0 fail;
  every example for 5 s under it — clean. Hit rate on the bench fixtures:
  every settle after a run's first reused its context and listeners.

### Performance

| Fixture               |   02 |   09 | ratio |
| --------------------- | ---: | ---: | ----: |
| busy-square           |   79 |   66 |  0.84 |
| busy-triangle         |  272 |  244 |  0.90 |
| busy-triangle-noscope |  257 |  224 |  0.87 |
| 555-slow              |   92 |   82 |  0.90 |
| busy+555-slow         |  381 |  321 |  0.84 |
| busy+555-fast         |  205 |  170 |  0.83 |
| rc-sine               |   79 |   76 |  0.96 |

Counters identical. 10–16 % off the busy desks (target 5–10 %); in the CPU
profile `buildContext`, `analyze`, `listenersOf` and `makePlan` drop out of
the top 40.

---

## 04 — Islands, analog half: per-island cycles, budgets and back-off

**Branch:** perf/04-island-analog (not created) **Commit:** — **Status:** done

### What changed

- `sim/spice/islands.js` (new): the desk's islands — union-find over the
  voltage topology's clusters (resistors, junctions, channels, transistors,
  off-rail chip feeds, bench devices, coils), both plates of every capacitor
  and every pin of every chip; rails never a join point. Each named by its
  least net; ANALOG when an RC node, a running wave or a coil is on it.
  Cached per analysis + topology (`SPICE_ASSERT_ANALYSIS` recomputes and
  compares).
- `sim/spice/engine.js`: every piece of cycle and chatter bookkeeping is
  island by island.
  - **Cycles**: one timeline per island, recording only the island's OWN
    moments (a moment another island's crossing settled at is none of its
    cycle's); a signature and drive signature of its own nodes, listeners and
    chips; `analog.cycles` (island → `{cycle, done, memo, steady}`). Several
    islands drawn at once walk their segments merged in time order
    (`runCycles`); drawn beside islands still stepped, each segment is an
    event of the loop (`nextSeg`, processed at its own moment before any
    settle past it — `pendingSeg`), replayed or settled, and the stepped
    islands are not re-read at it (they cannot see it). A drawn island's nodes
    are its schedule's: `updateNodes` leaves them alone.
  - **Budgets**: `MAX_ANALOG_EVENTS` and `MAX_CATCHUP_EVENTS` counted per
    island; one past its event budget is CAPPED (no more crossings this tick,
    its chatter remembered), one past its catch-up budget skips the rest of
    its history; the tick ends early only when no island is left stepping.
  - **Chatter**: `analog.chatters` (`{key, nets, at, backoff}` — matched to
    the next tick's islands by name, or by a shared net after an edit). A
    chattering island holds back its own wakes and frames only; the whole-desk
    clamp applies when every analog island chatters. A late tick catches up on
    every island that is neither drawn nor chattering.
  - **Warnings**: one `oscillation` per capped island, naming its nets, in
    island order.
  - Back-compat fields: `analog.cycle` (the first drawn cycle), `analog.chatter`
    (the first chatter), `analog.oscillating` (any island capped).
  - A desk whose analog side is ONE island runs the code it ran before
    (`oneIsland()`: maps kept whole, never sorted into islands).
- `sim/spice/sample.js`: `sampleAnalog` stands each drawn island at its own
  schedule, every other node on its curve.
- **A step-02 bug, found here and fixed** (it is what made `555-68k+wave`
  report 16× its period): a steady cycle woken a frame at a time walked one
  cycle and a bit of segments, so in two phases out of three the readout's
  last two rises were a frame apart — a 6.9 kHz 555 alone read 33× its period
  on one tick in three (`555-fast`, every frame tick; the bench only looked at
  the last). The walk now takes at least TWO cycles (`walkOf`), so a rise is
  always timed from the one before it. 555-fast: replays 370 → 610 /s,
  ~1 ms/s.
- `replaySeg` copies the board's maps once per settle instead of once per
  replay (and puts back in place); a run ending on a replay settles once more
  so the returned board is the replayed one.
- `bench/islands-fixtures.js` exports its builders; `islands.bench.js`
  reports how many islands a run ended drawing.

### Accuracy

- Golden: **bit-identical** to 03 (every golden case is one island).
- Parity, incremental exactness, tick-spacing invariance: green.
- `tests/spice-islands.test.js` (new):
  - two 555s on their own boards are two analog islands;
  - two unconnected 555s (RB 10 k / 12 k): **both drawn**, no oscillation, each
    period = its run alone (within the NE555 area's A — they agree to 1e-4);
  - a 68 kHz 555 beside a triangle clock: drawn, its period = alone, on EVERY
    tick's readout (the step-02 bug above);
  - a chattering CD4069UB relaxation loop beside a 69 Hz 555: the 555's
    every rise lands within 1e-9 s of the same desk with the loop quiet (the
    same chips — one quantum, features/13), and the period matches. Before
    this step the rises were up to 22 ms late, one missing.
- `SPICE_ASSERT_ANALYSIS=1` over the islands, cycle-replay, engine, silicon and
  examples suites: clean.
- `make test`: 4681 tests, 4679 pass, 2 skipped, 0 fail.

### Performance (ms per simulated second; `results/04.json`)

| Fixture               |    00 |   09 |   04 | 04/09 |
| --------------------- | ----: | ---: | ---: | ----: |
| busy-square           |    77 |   66 |   68 |  1.04 |
| busy-triangle         |   453 |  244 |  218 |  0.90 |
| 555-slow              |    88 |   82 |   82 |  1.00 |
| busy+555-slow         |   386 |  321 |  322 |  1.00 |
| 555-fast              |   423 |  4.6 |  4.4 |  0.95 |
| **555-fast-x2**       |  9209 | 8679 |  9.1 | 0.001 |
| busy+555-fast         |  2230 |  170 |  143 |  0.84 |
| **555-68k+wave**      |   127 |  123 |   13 |  0.11 |
| rc-sine               |    76 |   76 |   82 |  1.08 |

- **555-fast-x2 is 2.07× 555-fast** (acceptance: about 2×, not 10×): ticks
  25 vs 30 /s, settles 50 vs 60, replays 1075 vs 610 — both drawn.
- **555-68k+wave: running, 1.4977e-5 s** (was "chatter"): settles 680 → 83.
- Every one-island fixture's counters are identical to 09 but 555-fast's and
  busy+555-fast's replays (the two-cycle walk). busy-square / rc-sine within
  the bench's noise (the machine had load 2.5 throughout).

### Notes / follow-ups

- Every island still shares the desk's quantum (a pass is the shortest gate
  delay ANYWHERE): adding a CD4069UB beside a 555 moves the 555's output
  edges by ~1 µs. That is step 13's.
- A wave island is never drawn (a wave's period spans ticks); it no longer
  blocks anyone else's cycle.
- The user guide's limitation ("two unrelated oscillations both faster than
  the desk can show … reported as oscillating") now says it of two on ONE
  circuit (`docs/spice-lite.md`); the website and PDF are not rebuilt
  (`make docs`, `make pdf`). `.claude/rules/spice-lite.md` updated.

---

## 05 — Skip the redundant replay settle

**Branch:** perf/05-skip-replay (not created) **Commit:** — **Status:** done

### What changed

- `sim/spice/engine.js` `quietReplay` / `restAt`: a late tick's first settle
  replays the last tick's final moment (`prior.time`) on the last tick's own
  inputs (`before`). When that tick ended **RESTED** — `rested` in `analog`:
  settled, nothing capped, resettling, chattering, holding or written, no
  memory chip on the desk, no cycle drawn, begun or ended (a counting part's
  state keeps what its schedule told it until a settle without one) — on the
  very same desk (`ran`: document + netlist), and no relay's coil crossed a
  threshold in between, that settle is not run. Everything it does beside the
  digital tick is: the moment, relays, the bench's sources, the CONTEXT
  (`sim/engine.js` `contextOf` — new, the very `contextFor` a tick would use —
  handed to `hooks.context`, so the analysis, islands, listeners and node
  bookkeeping are built exactly as the settle would build them).
- **"Same inputs" is not a condition.** The plan asked for no clock edge or
  input between ticks; but the replay runs on the LAST tick's inputs, the ones
  that tick ended on, whatever this tick brings at its own moment. So a clock
  edge every tick (rc-sine, busy-triangle) still skips. The assertion mode
  confirms it on every suite.
- **Timing: Option A, nearly.** Such a settle runs ONE pass on every bench
  fixture (measured: every replay settle on every fixture, 1 pass, levels
  unchanged), so the skip advances `t` by one quantum, as the settle would. Now
  and then it would have run two: a voltage solve still settling its last
  digits (a coil's cluster) keeps it busy a pass more, and the solve it would
  have done is left to the next settle. That is the whole golden shift below.
- `sim/assert-modes.js`: `SPICE_ASSERT_REPLAY` runs every skipped settle and
  throws if it changed a level, a state or a read pin.
- `tests/spice-replay-skip.test.js` (new): settles per tick on rc-sine and
  busy-triangle in steady state < 1.2 (they are 1.00 and ~1.08).

### Accuracy

- Golden: every area A (floors unchanged). **32 values moved, worst 2.75e-10
  relative** (limit 1e-4), all in the two relay cases (the coil-cluster solve
  above), each also in its `[grid 2]` run:

  | Case          | Values                                      | Worst rel |
  | ------------- | ------------------------------------------- | --------: |
  | relay-flyback | collector & l1 at 19.5, 20.3, 20.6, 21, 21.5 ms | 1.14e-10 |
  | relay-kick    | collector & l1 at 20.02, 20.05, 20.1 ms     |  2.75e-10 |

  (full list: `node scripts/golden-diff.mjs features/spice-perf/golden/04.json
  features/spice-perf/golden/05.json`)
- `make test`: 4683 tests, 4681 pass, 2 skipped, 0 fail — engine-incremental
  (full vs incremental exactness), engine-parity and tick-spacing invariance
  green.
- **Assertion mode** `SPICE_ASSERT_REPLAY=1 make test`: 4679 pass, 4 skipped
  (the two counter tests skip themselves under it), 0 fail.

### Performance (`results/05.json`; machine load ~3 during the run)

| Fixture               | settles 04 → 05 |   ms 04 |   ms 05 | ratio |
| --------------------- | --------------: | ------: | ------: | ----: |
| busy-triangle         |      838 → 435  |     218 |     191 |  0.88 |
| busy-triangle-noscope |      838 → 435  |     213 |     187 |  0.88 |
| 555-slow              |      873 → 536  |      82 |      74 |  0.90 |
| busy+555-slow         |     1273 → 745  |     322 |     286 |  0.89 |
| rc-sine               |     1003 → 501  |      82 |      70 |  0.85 |
| busy-square           |   201 (no node) |      68 |      76 |  noise |
| drawn-cycle fixtures  |       unchanged |       — |       — |     — |

- Settles fall ~2× (0.50–0.61) on every stepped fixture with analog nodes, as
  the plan expected. **ms falls only 10–15 %**, not 2×: the replay settle was
  the cheap one — one incremental pass that changes nothing — and the tick's
  cost is the settle at its own moment, the voltage report and the supply
  measurement. Recorded rather than chased (08, the warm incremental cache,
  is the step that goes after a settle's own cost).
- Fixtures with a drawn cycle (555-fast, -x2, busy+555-fast, 555-68k+wave)
  never replay history (a drawn island starts at `now`) — unchanged.
  busy-square / 555-fast-x2 timings moved +10 % with identical counters:
  machine noise.

---

## 06 — Only route chips with something to do through the `outputs` hook

**Branch:** perf/06-sparse-outputs (not created) **Commit:** — **Status:** done

### The order dependence, written down (now at the head of the change in `sim/incremental.js`)

The Spice Lite `outputs` hook (`spice/engine.js`) per call: `holdOutputs`
counts a held output down once per CALL (`pending`, per tick) and commits it
when the count runs out (`committed`); it books a switching spike — outputs
that went H↔L against what the chip last DROVE (`driven`) — into its supply's
running sum (`spikeNow`, a float sum: ORDER matters); it records `driven`; and
it tells the voltage side (`volt.outputs`, which ignores the very map it was
last given). For a chip whose outputs were NOT evaluated again this pass (the
same `raw` object) and with no hold in flight, the call hands back the map it
handed back last, which is `driven` — so it books nothing, commits nothing,
tells nothing: a no-op. The other calls are made in `ctx.chips` order (the
sorted subset), so every spike is added to its sum in the full walk's order.

### What changed

- `sim/incremental.js`: under the outputs hook, a pass after a solve's first
  visits the chips evaluated again (marked by a moved input, `reread`), the
  watched and those the hook says are HOLDING (`hooks.holding()` — Spice
  Lite's `pending`); a solve's first pass adds every sequential chip (the
  state rule). Cold passes visit every chip. `mode: "full"` is untouched (the
  reference still calls every chip every pass).
- `spice/engine.js`: `hooks.holding()`.
- `sim/assert-modes.js` `SPICE_ASSERT_OUTPUTS`: every skipped call is made
  anyway, flagged `quiet`, and the hook throws unless it returned what it
  drove, left `committed` and the spike sums untouched and started no hold.

### Accuracy

- Golden: **bit-identical** to 05.
- `make test`: 4683 tests, 4681 pass, 2 skipped, 0 fail (engine-parity,
  engine-incremental — whose Spice Lite cases compare the sparse walk with
  `mode: "full"`, field by field — green).
- `SPICE_ASSERT_OUTPUTS=1 make test`: 4681 pass, 0 fail.

### Performance (`results/06.json`)

| Fixture        | outputs calls/sim-s 05 → 06 | evaluations |   ms 05 |   ms 06 |
| -------------- | --------------------------: | ----------: | ------: | ------: |
| busy-square    |              9835 → 4348    |        4348 |      76 |      78 |
| busy-triangle  |             13090 → 7620    |        7620 |     191 |     189 |
| busy+555-slow  |             26813 → 13760   |       13660 |     286 |     270 |
| busy+555-fast  |             13781 → 7837    |        7737 |     157 |     159 |
| 555-68k+wave   |               124 → 83      |          83 |      14 |      13 |

- Calls now equal the chips evaluated (plus a few holding): 0.44–0.58×.
- **ms barely moves** (within the ±5 % noise on the islands bench). On `make
  bench`'s 8-slice busy fixture under Spice Lite, measured A/B (the hook's
  `holding` renamed away = the full walk): 0.667 → 0.657 ms/tick, ~1.5 %. The
  hook's own work per no-op call was a few map lookups; the pass's cost is the
  voltage side and the resolutions.

---

## 07 — Return deltas from the `levels` hook (no copy mode)

**Branch:** perf/07-delta-levels (not created) **Commit:** — **Status:** done

### What changed

- `spice/voltages.js`: `passOverrides(next, info)` — `pass` saying only the
  nets it shows otherwise than `next` (null where it shows `next` as it is);
  `pass` is now that applied to a copy (the full loop and the digital
  engine's `mode: "full"` still use it). `next` need only answer `get`.
- `spice/engine.js`: `hooks.levelsDelta` beside `levels` — the voltage side's
  overrides plus the listeners' view, as a Map; null exactly where `levels`
  would have handed its input back unchanged (that is what copy mode's strong
  aliasing hung on).
- `sim/incremental.js` (the contract change kept additive: `levels` still
  works, `levelsDelta` is preferred when there is no observer): no copy mode
  under Spice Lite. Each pass hands the hook a view of the cache (or a
  fallback's reading), applies its overrides to the working map in place, and
  keeps every overridden net STALE (not the cache's) so the next pass
  reconsiders it; the fixpoint, the cap's marking map and the strong levels
  (`alias`: the working map where the hook changed nothing, else the cache)
  are the in-place loop's, which equal copy mode's. With an observer, copy
  mode as before.
- `sim/assert-modes.js` `SPICE_ASSERT_DELTA`: after every delta pass the whole
  map is held to "the hook's override, else the pass's own level", net by net.

### Accuracy

- Golden: **bit-identical** to 06.
- `make test`: 4683 tests, 4681 pass, 2 skipped, 0 fail
  (engine-incremental holds the in-place Spice Lite settle to `mode: "full"`
  — copy maps — field by field).
- `SPICE_ASSERT_DELTA=1 make test`: 4681 pass, 0 fail.

### Performance (`results/07.json`, load ~3)

| Fixture        | ms 06 | ms 07 | ratio |
| -------------- | ----: | ----: | ----: |
| busy-square    |    78 |    68 |  0.88 |
| busy-triangle  |   189 |   171 |  0.91 |
| 555-slow       |    75 |    69 |  0.92 |
| busy+555-slow  |   270 |   232 |  0.86 |
| busy+555-fast  |   159 |   132 |  0.83 |
| 555-68k+wave   |    13 |    12 |  0.93 |
| rc-sine        |    73 |    68 |  0.93 |

Counters identical. `make bench`'s busy fixture under Spice Lite: 0.657 →
0.577 ms/tick (−12 %). Allocation: young-generation collections over 1 s of
busy-triangle 334 → 328 (`--trace-gc`) — barely: the per-pass map was a few
hundred entries; what a Spice Lite tick allocates is mostly the voltage
side's reports and the digital tick's own maps. The time saved is the copy
and the whole-map comparison every pass, not GC.

---

## 08 — Carry the incremental cache across ticks (no cold first pass)

**Branch:** perf/08-warm-cache (not created) **Commit:** — **Status:** done
(gate met — assertion mode clean on the suite and the examples; the 1.3×
acceptance target is NOT reached: 1.55×, see Performance)

### The invalidation rule (also at `sim/incremental.js` `warmStartOf`)

A digital settle's work (each chip's evaluated outputs, what the outputs hook
let through, the state each was read with, every net's drivers and cached
resolution) is right at the end of a settled solve. Why the next settle
started cold, and what each thing now dirties instead:

| Changes outside a solve                         | Dirties                                    |
| ----------------------------------------------- | ------------------------------------------ |
| a net's level (`warmStart` ≠ the level the work ended on: assembly, a replayed segment, …) | the net → its readers evaluated again |
| clock levels, signals (the bench sources)       | their nets' drivers rebuilt and resolved   |
| a sequential chip's state replaced (step, replay) | that chip (the existing state rule)     |
| a memory's image, a can's clock phase           | every memory and can, always               |
| how a pin READS (Spice Lite's listener readings, relays, voltage readings, the shown `view`) | the hook's `warmDirty()`: those chips, and the readers of the view nets that moved |
| what the outputs hook was told a chip drives (a replay put it back) | that chip (`warmDirty`)  |
| power, document, netlist, a def (`logicOf`), the config | a new context → cold                  |
| an observer; `SPICE_COLD_SETTLE=1`              | cold                                       |
| a settle that did not settle (capped, oscillating) | no work kept → cold                      |

The work is CHANGED in place by the solve that takes it, so only one tick may
start from it (`taken`): a caller that ticks twice from one result (a test
branching a run) gets a cold start the second time — found by the assertion
mode (`spice-sample.test.js`'s forced tick).

### What changed

- `sim/engine.js` `tick`: `warm` in (the last tick's work, or null; given at
  all, the result carries `warm` out — `{work, levels, stale}`, taken right
  after the last solve, before any marking); passed to the first solve.
- `sim/incremental.js`: `warmStartOf` (the rule above), `sourcesBase`; a warm
  first pass marks the dirty chips and readers, seeds the moved bench-source
  nets, keeps the overridden nets stale, and is otherwise an ordinary
  incremental pass. `SPICE_ASSERT_WARM` evaluates every chip the rule left
  clean and rebuilds every driver, and throws on any difference;
  `SPICE_COLD_SETTLE` forces the old cold start.
- `spice/engine.js`: carries the work settle to settle and tick to tick
  (`analog.warm`, `settledAt`, `reread` — stripped by `exportRun`);
  `hooks.warmDirty()`; replays note the chips whose outputs they put back.
- `tests/incremental-fixtures.js` `compareRuns`: the analog comparison leaves
  out `warm`/`reread` (the incremental settle's own bookkeeping, which the
  full loop has none of) — every other field still held exactly, now with the
  incremental side warm.

### Accuracy

- Golden: **bit-identical** to 07.
- `make test`: 4683 tests, 4681 pass, 2 skipped, 0 fail — engine-incremental
  (warm incremental vs `mode: "full"`, every field, every tick) and parity
  green.
- `SPICE_ASSERT_WARM=1 make test`: 4681 pass, 0 fail. Every shipped example
  for 5 s under it (`SPICE_EXAMPLE_SECONDS=5`): clean.

### Performance (`results/08.json`, load ~3.5)

| Fixture        | evals/sim-s 07 → 08 | ms 07 | ms 08 | ratio |
| -------------- | ------------------: | ----: | ----: | ----: |
| busy-square    |        4348 → 1530  |    68 |    52 |  0.77 |
| busy-triangle  |        7620 → 2330  |   171 |   153 |  0.89 |
| 555-slow       |         938 → 669   |    69 |    64 |  0.93 |
| busy+555-slow  |       13660 → 2755  |   232 |   180 |  0.78 |
| busy+555-fast  |        7737 → 1756  |   132 |   110 |  0.83 |
| rc-sine        |               0     |    68 |    68 |  1.00 |

- Every tick but a run's first now starts warm (bench: one cold pass a run).
  Evaluations 0.20–0.35× on the busy desks. `make bench`'s busy fixture under
  Spice Lite: 0.577 → 0.48 ms/tick.
- **busy+555-slow = 180 vs busy-square + 555-slow = 116: 1.55×** (was 1.69×;
  target 1.3×). The digital half is no longer the reason: profiled, a Spice
  Lite tick on it is now 25 % GC, 15 % the end-of-tick lamps/voltage report,
  12 % `updateNodes`, 7 % `createVoltages` (copying the carried voltage state
  each tick), 5 % `record`/`driveSig`, 3 % `supplySag` (geometry each tick) —
  per-tick whole-desk work on the analog side, which steps 10 (change-driven
  end of tick) and 11 (allocation-free `piecesAt`) are for. Re-measured after
  them.

### Notes / follow-ups

- The digital engine (no hooks) supports `warm` too, but SimController's
  digital run doesn't pass it — it would cut its cold first passes the same
  way. Not done (scope: the Spice Lite series).

---

## 10 — End-of-tick work proportional to what changed

**Branch:** — **Commit:** — **Status:** attempted, measured, **reverted** (no
gain; nothing of it is left in the tree)

### What was tried

1. **Keyed on identity.** The voltage side's last report carried tick to tick
   (it already handed back the same answer within a tick while no cluster
   re-solved), and the lamps' verdicts, the supply measurement, the sag and
   the loads/stress each kept with the objects they were made from, made again
   only when those changed (`SPICE_ASSERT_END` remade every kept one and
   compared: clean on the spice, parity and incremental suites; golden
   bit-identical). **Hit rate on every bench fixture: zero.** Every tick of
   every fixture re-solves at least one cluster — a clock edge moves outputs,
   an RC node moves its own cluster — so the report is never the same object
   and nothing downstream is either. A tick that changes nothing electrical is
   rare by construction now (display frames are no wakes since 01).
2. **Per cluster.** The report patched rather than merged: the last answer's
   maps copied and only the re-solved clusters' junctions, parts and lead
   currents put in (a hole several clusters book re-summed over its bookers in
   the merge's order; any change of what a cluster books → full merge).
   Assertion mode held every patched report to the full merge — clean; it
   patched on ~99 % of ticks. **Timing: no gain** (busy-square 52 → 54,
   busy+555-slow 180 → 186, `make bench` busy fixture 0.48 → 0.51 ms/tick —
   noise-level, if anything worse): copying the maps and diffing the keys of
   the re-solved entries costs what the merge it replaces cost.
   (`bench/results/10-attempt.json`.)

### Why the end of the tick does not shrink this way

The profile (busy+555-slow, after 08): `report`'s own merge ~8 % of a tick,
the lamp verdicts ~2 %, `supplySag` ~3 % (routing every draw), `collectVolts`
~2 %, `measureSupplies` ~1 %, GC ~23 %. It is spread thin, and the lists the
report builds (draws, outputs, stress, switches, devices, brownouts — whose
ORDER the warnings and the per-supply float sums depend on) still have to be
rebuilt whole. Making them incremental means per-supply sums and per-source
warning sets kept in place across ticks — a restructuring of supply.js,
sag.js and loads.js, with order-dependent float sums to preserve exactly.

### Follow-ups (for Jason to decide)

- The bigger per-tick costs left are allocation (GC ~23 %), `updateNodes`
  (~15 %, the networks re-linearized), and `createVoltages` copying ~20
  carried maps every tick (~4–7 %) — copy-on-write for the carried voltage
  state would be a cleaner win than step 10 as specified.

---

## 11 — Allocation-free `piecesAt` in `linearizeGroup`

**Branch:** — **Commit:** — **Status:** done

### What changed

- `spice/network.js`: `piecesBy(drivers, branches, vAt)` — `pieces` reading
  each node's voltage through a function (`pieces` itself is now that over
  its two maps, unchanged for every other caller).
- `spice/voltages.js` `linearizeGroup`'s `piecesAt`: one scratch overlay per
  network, made once per linearization; each sample writes only the moving
  nodes into it, instead of copying the network's `fixed` and `volts` maps
  (two Map copies per network per sample, ~100 samples a corner search). The
  values read are the same numbers by construction (a moving node reads its
  carried value whichever map it sat in).

### Accuracy

- Golden: **bit-identical** to 08 (multi-RC, coupled-oscillator and
  CMOS-stage areas included).
- `make test`: 4683 tests, 4681 pass, 2 skipped, 0 fail.

### Performance

The two-gate CD4069UB oscillator (golden case `two-gate-cd4069ub`, a coupled
nonlinear group — the bench's fixtures do not exercise group corners much),
2 s simulated, A/B in place: **54.0 → 49.0 ms/sim-s (−9 %)**, ticks
identical. The islands bench is unaffected (its groups are linear or single
nodes).

---

## Between 11 and 12 — Jason's "option 2": the carried voltage state copy-on-write, and allocation cut

**Branch:** — **Commit:** — **Status:** done (asked for 2026-10-09 before
deciding on 12)

### What changed (all `spice/voltages.js`, plus `spice/network.js` from 11)

- **Copy-on-write carried state.** `createVoltages` took ~18 carried maps and
  sets from the last tick's snapshot by copying every one, every tick. They
  are now taken by REFERENCE and copied on this tick's first write to each
  (`own.<name>()` at every write site; `CARRIED`). The last tick's snapshot is
  never written, so the engine stays a pure function of its inputs — a caller
  ticking twice from one result (spice-sample.test's forced ticks) still sees
  it untouched. The per-pass bookkeeping that rewrote unchanged values
  (`fixedUsed`, `coilUsed`, clearing empty `stale`/`setStale`) now writes only
  what moved, so an untouched map is never copied.
- **A network built once, solved per sample.** `network()` is now
  `networkShape` (the branches, drivers, maps, union-find — everything but the
  solve) + `solveShape`; `pinnedAt(k, net)` builds the shape once and solves
  it per pinned voltage. `linearize` (its two slope reads and the whole
  `farCorner` bisection, up to ~50 solves) and `headingOf` use it: the
  branches and maps were rebuilt for every one of those solves.
- **The report's merge** over every cluster entry: index loops instead of
  iterators and spreads (it was a tenth of a tick's garbage). (A first cut
  used `forEach` on what are arrays of pairs and keyed the transistor/analog
  maps by index — the transistor tests caught it; the golden suite, which
  reads voltages only, did not.)

### Accuracy

- Golden: **bit-identical** to 11 (`golden/opt2.json`).
- `make test`: 4683 tests, 4681 pass, 2 skipped, 0 fail (engine-incremental
  and parity green; the analog snapshot compared field by field).

### Performance

- Allocation over 1 simulated second of busy+555-slow (V8 sampling heap
  profiler, collected objects included): **800 → 604 MB**.
- `make bench` busy fixture under Spice Lite: 0.48 → ~0.45 ms/tick.
- Islands bench vs 08 (`results/opt2.json`, load ~2.5):

| Fixture        |  08 | opt2 | ratio |
| -------------- | --: | ---: | ----: |
| busy-square    |  52 |   49 |  0.95 |
| busy-triangle  | 153 |  151 |  0.99 |
| 555-slow       |  64 |   45 |  0.69 |
| busy+555-slow  | 180 |  155 |  0.86 |
| 555-fast       | 5.7 |  3.8 |  0.66 |
| busy+555-fast  | 110 |  105 |  0.96 |
| rc-sine        |  68 |   64 |  0.94 |

- busy+555-slow vs the sum of its halves: 155 / (49 + 45) = **1.65×** — the
  ratio did not improve, because the 555 alone sped up the most (its
  linearizations were the shape rebuilds). What a tick on the busy desk still
  pays is whole-desk: the digital settle's map copies and lazily built strong
  levels (`solveIncremental`, `strongMap`: ~11 % of what is allocated), the
  report's merge (~10 %, it must still rebuild its lists in order), the lamp
  verdicts (~5 %), the sag routing (~4 %), `samplePins` for every sequential
  chip (~3 %). Only per-island ticks (12) stop a 555 crossing paying for the
  counter board.

---

## 12 — Islands, scheduling (the SCOPED form Jason chose, 2026-10-09)

**Branch:** — **Commit:** — **Status:** done

Scope agreed: each island gets its own next event and a tick touches only
the islands it is for; the end of the tick (report, lamps, supplies, sag,
warnings) and the supply coupling stay whole-desk and exact. The transport
(SimController, the Worker host) is unchanged: it still ticks at the earliest
wake.

### What changed

- `spice/islands.js`: the ACTIVE islands (a chip, a node, a bench source or a
  part in a network on them — a bare row of holes is an island too, but no
  one's concern), each island's SUPPLY GROUP (`groupOf`/`members`: islands
  reaching one supply — a rail, a clock brick's supply — are one group) and
  each bench source's island (`sourceIsland`).
- `spice/engine.js`:
  - `islandNext` (each analog island's own next event — its crossing, its
    drawn cycle's next segment or frame, its chatter back-off) and
    `globalNext` (what is nobody's: a part's timer, a regulator cooling or
    tripping, a settle left unfinished), carried in `analog`.
  - `dueIslands()`: a tick is FOR the islands whose own next event is due,
    those a bench source on them moved (a clock edge, a signal, a re-rate),
    and every island in their supply groups. Every island (`due` null — the
    old path, exactly) when there is one active group, when nothing in
    particular is due (a look at the desk: a test's grid, a run's last
    moment, a transport catching up), when a timer or regulator is due, on a
    new desk, with a coil anywhere, or under `SPICE_UNSCOPED` /
    `spice.scoped: false`.
  - An island the tick is not for stands on its curves untouched: it is not
    `live` (no flips, crossings, records, budget), `updateNodes` and `restate`
    leave it (its listeners keep their statements), its drawn cycle is not
    walked, its RC nodes are told to the voltage side where they were last
    solved (`rcOf` / `voltages.js nodeVoltUsed`) so its networks are not
    re-solved, its chips are not stepped (`sim/engine.js` `tick`'s new
    `scope`: their state and read pins stand), and its timing readouts say
    what they said at its own last tick (read at another island's moment a
    readout looked stopped).
  - The wake is the least of every island's own next (an island not ticked
    keeps the one it had) and `globalNext`.
- `tests/spice-islands.test.js`: islands sharing a supply are ticked together
  — **every tick identical** to unscheduled (levels, volts, supplies, wakes);
  islands on their own supplies are ticked apart (`scopedTicks` > 0) and each
  555's period equals the one alone **to INVARIANCE (1e-4)**; the chattering-
  loop test's bound became the rubric's (a crossing may be settled a few gate
  delays from where another island's tick happened to catch it: 5e-8 s on a
  14.9 ms period).

### What it does NOT do (the scoped form, and why the target is not met)

The end of the tick is whole-desk: an island not ticked still has its report
entries merged, its LEDs judged, its supply measured — from its cached
answers, but walked. So is the digital settle's bookkeeping (the level map
copy, the warm diff, the assembled result, the strong levels). Displayed
voltages of an untouched island's non-node nets and its lead currents are
those of its own last tick (its node voltages are sampled exactly).

### Accuracy

- Golden: **bit-identical** to opt2 (every golden case is one supply group).
- Every shipped example, 1 s, tick by tick — levels, node voltages, timing,
  warnings: **identical** scheduled and unscheduled (each is one supply
  group: nothing to schedule apart).
- `make test`: 4685 tests, 4683 pass, 2 skipped, 0 fail; spice-current and
  spice-sag (droop) green.

### Performance

Best of 6 runs, 1 s simulated, scheduled vs `scoped: false` in one process
(the islands bench had load ~3.3 and moved ±7 % between identical code paths):

| Fixture        | scheduled | unscheduled | ratio |
| -------------- | --------: | ----------: | ----: |
| busy+555-fast  |      63.9 |        94.6 |  0.67 |
| busy+555-slow  |     128.9 |       141.6 |  0.91 |
| busy-triangle  |     124.5 |       120.8 |  1.03 (one group: same path) |
| busy-square    |      48.7 |        45.5 |  1.07 (one group: same path, noise) |
| 555-slow       |      37.4 |        37.0 |  1.01 (one group) |
| rc-sine        |      57.3 |        57.3 |  1.00 (one group) |

- busy+555-slow is now 129 vs busy-square + 555-slow = 82: **1.56×** (target
  1.3× — not met; see above). A 555 wake on the busy desk went 374 → 358 µs
  (its steps), a busy edge 418 → 388 µs (the 555's analog work no longer
  done there).
- Against 00 (`results/12.json`): busy-square 0.68, busy-triangle 0.34,
  555-slow 0.52, busy+555-slow 0.39, 555-fast 0.01, 555-fast-x2 0.001,
  busy+555-fast 0.03, 555-68k+wave 0.08 (running), rc-sine 0.81.

### Follow-ups

- To reach 1.3× the per-tick whole-desk work has to go: per-group supply
  measurement and sag, report entries merged per group, the digital result
  assembled per island — the restructuring step 10 found too costly to do
  piecemeal.
- Two fast oscillators on separate supplies are still woken together (the
  transport's MIN_SHOWN_S floor puts both their segments in one tick); each
  is drawn by its own schedule regardless (04).

---

## 13 — Per-island quantum (Jason's go-ahead 2026-10-09)

**Branch:** — **Commit:** — **Status:** done — Jason signed off on the changed values below (2026-10-09)

### What changed

- `spice/engine.js`:
  - `analyze` keeps each chip's gate delay (`delays`, chip id → ns) beside the
    desk-wide quantum, holds and longest hold it already computed; the
    arithmetic moved into `quantumOf(delays, config, bare)`.
  - `pace()` — the tick's quantum, holds and longest hold, read wherever the
    desk's were (`holdOutputs`, `maxIterations`, both `t += passes × quantum`,
    the segment memo and replay checks). Its "desk" is the chips on the
    islands the tick is FOR: a tick for one CD4000 island runs at that
    island's 125 ns with holds of 1. A desk not yet sorted into islands keeps
    `analyze`'s figures exactly.
  - **Holds are counted in the tick's quantum, not each island's own.** I tried
    the island-local version first. It keeps a co-ticked 555 exact, but it
    counts a CD4000 gate in 74LS quanta whenever the two share a tick: 10 ns
    instead of 125 ns. Counting holds in the tick's quantum keeps every chip's
    delay at the same nanoseconds (±half a quantum of rounding) whoever shares
    its tick.
  - **`bare`**: an island whose chips have no gate delay of their own (a lone
    555) counts at the 74LS fallback (10 ns), as it does alone. Without this,
    a tick for both the 555's island and a CD4000 island (11 of 84 ticks on
    the chatter test's desk) left the 555 out of the minimum. Those ticks ran
    the 555 at 125 ns, and its period drifted 1.4 µs a cycle.
- `tests/spice-islands.test.js`: a new test, "a CD4000 island beside a 74LS
  board keeps its own gates' pace". A CD40106 relaxation oscillator on its own
  supply, beside `busyDocument(1)`: each flip settles in at most one pass more
  than the oscillator takes alone, and each flip on a tick for its own island
  lands within INVARIANCE·period of where it does alone. The test fails on
  step 12: "flip 0: 14 passes, 2 alone". I also rewrote the comment on the
  chatter test, which said every island shares one quantum.
- `bench/islands-fixtures.js`: a new fixture, `busy+cd40106` (the busy board
  plus that oscillator).

### Every changed value (old → new, reason)

**Golden: none.** `golden/13.json` is bit-identical to `golden/12.json`,
because every golden case is a single family. **Shipped examples: none.**
Every `src/web/demos` desktop was run for 1 s, tick by tick (levels, node
voltages, timing periods, warnings), on 12 and on 13: the output is
byte-identical.

Model figures, on a desk mixing families across islands:

| Where | Figure | 12 | 13 | Reason |
| --- | --- | --: | --: | --- |
| A tick for a CD4000-only island, with a 74LS chip on another island | quantum | 10 ns | 125 ns (5 V; scales with supply) | the island's own gates |
| — the same tick | a CD4000 chip's hold | 13 | 1 | in its own quanta |
| — the same tick | pass cap (`MAX_ITERATIONS × maxHold`) | ×13 | ×1 | follows the hold |
| A tick for a 555-only island, with a CD4000 chip on another island | quantum | 125 ns | 10 ns | the 555's island alone runs at the fallback |
| A tick for every island: 74LS + CD4000 | quantum / CD4000 hold | 10 / 13 | 10 / 13 | unchanged |
| A tick for every island: a bare 555 island + a CD4000 island | quantum / CD4000 hold | 125 / 1 | 10 / 13 | `bare`: the 555 at its own pace, the CD4000 still 125 ns |

Values these produce (none is an asserted test value, and every existing
assertion passes unchanged):

- Chatter test (`spice-islands`: a 555 beside a chattering CD4069). The 555's
  OUT rises, first 8, in seconds:
  - **chatter desk, 12:** 0.0193129773 0.0341720716 0.0490311660 0.0638902603 0.0787493546 0.0936084490 0.1084675953 0.1233266896
  - **chatter desk, 13:** 0.0193118419 0.0341695629 0.0490272838 0.0638850047 0.0787427257 0.0936004466 0.1084583497 0.1233160706
  - **quiet-loop desk, 12:** the same as the chatter desk on 12, except rises 7–8 (…0.1084675433, 0.1233266376)
  - **quiet-loop desk, 13:** 0.0193118419 … 0.1084581676 0.1233158885, exactly the 555 alone
  - **the 555 alone (unchanged):** 0.0193118419 0.0341695629 0.0490272838 0.0638850047 0.0787427257 0.0936004466 0.1084581676 0.1233158885

  On 12 the 555 ran 1.1 µs late at the first rise and 10.8 µs late by the
  eighth, because it was cut into the inverter's 125 ns. On 13 the quiet-loop
  desk matches the 555 alone exactly. The chatter desk matches through rise 6
  and is then 0.18 µs off (1.2e-5 of a period): a tick for both islands
  settles them together, so the 555's crossing waits on the other island's
  passes.
- `busy+cd40106` (`busyDocument(4)` + the CD40106 loop, 0.5 s): flip ticks
  2–8, in seconds:
  - **12:** 0.087097087 0.129552156 0.168654645 0.211109714 0.2505 0.292667271 0.331769760 (each settled in 14 or 15 passes)
  - **13:** 0.087097087 0.129552346 0.168655012 0.211110271 0.2505 0.292668195 0.331770861 (2 or 3 passes)
  - **alone:** 0.087097307 0.129552566 0.168655232 0.211110491 0.250213156 0.292668415 0.331771081 (2 passes)

  On 12 the loop drifted against its run alone: −0.2, −0.4, −0.6, −0.8,
  −1.1 µs. On 13 it holds a constant −0.22 µs, which comes from the first,
  whole-desk tick. 0.2505 is a frame tick that caught the flip; it is seen at
  the tick's end on both 12 and 13.

### Accuracy

- Golden: bit-identical to 12 (all A).
- Shipped examples: byte-identical (above).
- `make test`: 4686 tests, 4684 pass, 2 skipped, 0 fail. ESLint and Prettier are clean on the changed files.

### Performance (`results/12-pre13.json` → `results/13.json`, islands bench)

Every counter on every existing fixture is identical. `busy+cd40106`:

| counter  | 12   | 13   | 13/12 |
| -------- | ---: | ---: | ----: |
| passes   | 1058 |  763 |  0.72 |
| outputs  | 2785 | 2530 |  0.91 |
| clusters |  915 |  895 |  0.98 |
| settles  |  230 |  235 |  1.02 (the loop's crossings land at slightly different moments, so 5 more settle where a frame tick catches one) |

The ms figures are within noise.
