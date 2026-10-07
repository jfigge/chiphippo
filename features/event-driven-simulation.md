# Event-driven simulation — implementation prompt

> **How to use this file.** It is a self-contained brief for an agent (or a person)
> implementing the feature. Read `CLAUDE.md` first — especially "Simulation", "Logic
> families", "The discretes", "Values, capacitors & timed parts", "Spice Light" and
> "The debugger" —
> then this file top to bottom before touching code. The plan follows the roadmap's
> shape: Context · Goal · Settled design · Implementation steps · Acceptance
> criteria · Constraints · Verify. Unnumbered on purpose: give it a stage number in
> `features/ROADMAP.md` when it is scheduled.

## Context

The simulation engine (`src/web/scripts/sim/engine.js`) is a **full-pass relaxation**.
`solve` repeats a pass until nothing changes (or `MAX_ITERATIONS`, 200, when it marks
the still-changing nets `X` and reports oscillation). Every pass:

1. `driversFor` evaluates **every** powered chip from the net levels as the pass began
   — combinational parts through `evaluate`, sequential ones through `outputsOf` with
   their fixed state, memories through `memoryOutputs`, oscillator cans from
   `clockPhase` — and collects each net's driver levels (`drivers`, plus `hard`, the
   drivers that can burn an LED).
2. `channelGroups` reads the analog switches' and transistors' control pins and decides
   which nets their ON channels join — with one `reading` per assignment of up to
   `MAX_UNKNOWN_CONTROLS` unknown controls.
3. `resolveAll` resolves **every** net (`resolveIn` → `sim/resolve.js` `resolveNet`):
   the diodes' strong drive to a fixpoint (`diodeDrive`), the resistor pull relaxation
   (already narrowed to the nets a pull can reach, `pullReach`), the final levels and
   the per-net warnings, and the strong levels the LED rule reads (`burn`). An unknown
   diode anode makes the pass `uncertain`, and `solve` resolves a second, WIDE reading
   and keeps what the readings agree on (`agreeing`).
4. `mapsEqual(next, levels)` decides whether the pass changed anything.

`tick` wraps that: ① a pre-settle with the old sequential state, ② a step loop that
samples every sequential chip, `stepChip`s it, and re-solves until no state changes
(`MAX_TICK_ITERATIONS`), ③ memory writes reported, `wakeAt` for timed parts, and
`assemble` (status warnings, floating CMOS inputs, boundary warnings, timing problems,
`channelsOf`).

**Measured** (`make bench`, `make profile`; see "Performance" in the Makefile) on the
busy fixture (`src/web/scripts/bench/busy-circuit.js`, 8 slices: 28 chips, 589 nets):

| | |
|---|---|
| Engine per tick, headless | ~0.67 ms (after `prepareCircuit` and `pullReach`) |
| Share of a tick spent in settle passes | ~94% |
| Settle passes per clock edge | 2 on a falling edge, 5 on a rising one (mean 3.5) |
| **Nets that change per pass** (after the first) | **~3 of 589 (0.5%)** — and still ~3 of 1,176 at 16 slices |
| Chip evaluations that saw a changed input | ~12% |

So every pass does O(all nets + all chips) work to discover ~3 changes, and the cost
grows with the size of the circuit rather than with its activity. That is what this
feature removes.

**Already in place**, and to be kept: `prepareCircuit(doc, netlist)` builds the fixed
context once and `tick`/`settle` take it back as `context` (reused only while both are
the very same objects — `contextFor`); SimController keeps one document snapshot and one
context per change (`#document()`, `#forgetDocument`); the bench drives `tick` the same
way. The engine's observer (`opts.observer`) has `round(phase, levels, strong)` at the
start of every pass, `chip(compId, ins, state, prev?, next?)` for every WATCHED chip a
pass evaluates, and the optional `evaluated(compId, pinLevels, outputs)` the bench
counts with.

**The debugger depends on the pass structure.** `model/chip-debug.js`'s `recorder`
stores each round's `levels` map BY REFERENCE, and `DebugSession` replays the record
pass by pass under the rule "every chip that changed in one pass pauses at once, each
reading the inputs as the pass began". So the sequence of passes, and the levels at the
start of each, are part of the engine's contract — not an implementation detail.

**Spice Light depends on the pass structure too, through hooks.** Spice Light
(`sim/spice/engine.js`, Settings ▸ Spice Light, CLAUDE.md "Spice Light") is a second
engine that never re-implements a settle. It runs THIS engine's `tick` through
`opts.hooks` (listed in `sim/engine.js`'s header), several times per tick (once per
analog event), and it reads simulated time off the pass count: one pass is one quantum,
the shortest gate delay on the desk. Every hook is stateful or time-bearing. Design 9 is
their contract, and it is as binding as the observer's.

**Two branches.** This prompt was written against the `performance` branch
(`prepareCircuit`, `contextFor`, `make bench`, `make profile`, the busy fixture). The
hooks came in on `spice`. Both forked from v1.3.0, and both change `sim/engine.js` and
`components/sim-controller.js`, so both must be in the tree before step 1. The merge
itself has a trap: `prepareCircuit(doc, netlist)` builds its context WITHOUT hooks, and
`contextFor` hands that context back to every tick. Merged naively, Spice Light's supply
droop, wire drop and RC curves are silently ignored. `engine-parity.test.js` and the
`spice-*` tests should catch it; design 9 says what to do.

## Goal

Make each settle pass do work **proportional to what changed**, with results that are
**bit-identical** to today's in every field, every tick, every pass — including the
number of passes, the levels at the start of each, the warnings and their order, what
the observer hears, and what Spice Light's hooks are called with (design 9). That holds
with Spice Light off (no hooks) and on.

This is the **zero-delay, delta-cycle** form of an event model ("selective trace"): the
passes stay exactly as they are; a pass simply skips the chips whose inputs did not
change and the nets whose drivers did not change. It is NOT a timed event wheel with
propagation delays.

## Settled design

1. **Semantics do not change.** Same passes, same fixpoint test, same oscillation
   handling, same warnings, same results. If any existing test expectation or any
   shipped demo's validated behaviour would have to change, that is a bug in the
   implementation, not a reason to edit the test. Stop and report it instead.

2. **The full-pass path stays, selectable.** `solve` gains an internal mode switch:
   `incremental` (the new default) and `full` (today's loop, unchanged). `tick` and
   `settle` accept `opts.mode` (`"incremental"` | `"full"`, default `"incremental"`)
   for tests and the bench only; nothing in the app passes it. The full path is also
   the **fallback** inside an incremental solve (step 7), so it must not rot.

3. **What a pass re-evaluates.** Pass k reads levels `L_k` and produces `L_{k+1}`. Let
   `Δ_k` be the nets whose level differs between `L_{k-1}` and `L_k`. In pass k, a chip
   is evaluated if and only if:
   - one of its pin nets is in `Δ_k`, or
   - it is the **first pass of this solve** and its outputs are not already known for
     this solve's fixed inputs (see 5), or
   - it is **watched by the observer** (the debugger's watched set is small, and its
     record must stay identical — `observer.chip` per pass for every watched chip, as
     today), or
   - it has no cached outputs yet.

   `Δ_k` is read from the levels AFTER `hooks.levels` (design 9), the same map the
   fixpoint test compares. With Spice Light's `hooks.outputs` present, a chip that is
   NOT re-evaluated still has its cached outputs handed to that hook every pass, as
   design 9 requires.

   Every other chip's outputs are reused from the previous pass. This is exact:
   within one solve a chip's outputs are a pure function of its pin levels and of
   things the solve holds fixed (its sequential `state`, `clockPhase`, `images`,
   `signalLevels`).

4. **What a pass re-resolves.** A net's level depends on its own drivers and supply
   flags, the pulls `pullReach` can deliver, its channel group's members, and diode
   feeds. In pass k, re-resolve exactly the **closure** of the nets whose driver list
   changed (because a chip re-evaluated to a different output on them):
   - every member of any channel group containing such a net (and the group set itself
     is recomputed only when a channel part's control net is in `Δ_k`; otherwise the
     previous pass's groups are reused);
   - the whole **resistor-connected component** containing such a net (the relaxation
     runs per component — precompute components once in `buildContext`);
   - the cathode nets of diodes whose anode net changed, and through them, their own
     closure.

   Every other net keeps its previous level, warning and strong level. The pass's
   result must equal what a full resolution would give — the closure exists to
   guarantee that, so err towards including a net rather than leaving it out.

5. **State lives in the solve, not in the module.** The per-chip output cache, the
   per-net driver lists, levels, warnings and strong levels are working state of ONE
   `solve` call (allocated at its start, discarded at its end). The engine stays a pure
   function: no module-level mutable caches. The context from `prepareCircuit` stays
   read-only — the dependency INDEXES it gains (step 2) are pure functions of the
   document and netlist. Re-solves within one `tick` (the step loop) may carry the
   cache forward from the previous solve of that same tick, seeded as dirty: every
   sequential chip whose state changed in the step, plus the nets whose levels the
   step pass did not produce (none, today — but say so in a comment).

6. **Levels handed out are never mutated afterwards.** Each pass's starting level map
   given to `observer.round` must be a distinct map that nothing changes later
   (`recorder` keeps it by reference). Build the next pass's map by copying only when an
   observer is present; without one, the working map may be updated in place. The
   maps in the RESULT (`netLevels`, `strongLevels`) are fresh and complete, as today.

7. **Fallback to a full pass**, for that ONE pass, when exactness would need more care
   than it is worth:
   - `channelGroups` returns more than one reading (an unknown control);
   - `resolveAll` reports `uncertain` (an unknown diode anode) for the incremental
     reading;
   - the first pass of a cold start (no warm start at all);
   - the pass that reaches the cap (the oscillation marking compares `prev` and
     `levels` over every net). The cap is `hooks.maxIterations` when Spice Light sets
     it, else `MAX_ITERATIONS`.
   A fallback pass recomputes everything and refreshes every cache, so the next pass
   can be incremental again.

8. **Warnings keep their order.** Today the last pass's warnings are pushed in
   `ctx.netIds` order, then the group shorts. Keep a per-net warning slot updated as
   nets are re-resolved, and build the list in that same order once, when the solve
   ends (it is only the LAST pass's warnings that `solve` returns).

9. **Spice Light's hooks keep their contract.** `tick` and `settle` take `opts.hooks`,
   and `sim/spice/engine.js` is their one caller. The incremental path calls every hook
   with the same arguments, in the same order and the same number of times as the full
   path. The hooks count calls and keep state, so "fewer calls, same answer" is not
   available. Hook by hook:
   - **`pass()`.** Called once per pass. Spice Light's clock IS the pass count
     (`t += passes × quantum`), so design 1's "same passes" is a TIMING requirement
     there, not only a determinism one.
   - **`maxIterations`.** Read once per solve, as the cap in place of `MAX_ITERATIONS`
     (Spice Light lifts it by its slowest gate's hold). Design 7's oscillation fallback
     fires at this cap.
   - **`outputs(c, outMap)`.**
     - **What it does.** Called today for every powered chip that is not an analog
       switch, every pass, in `ctx.chips` order. It is STATEFUL:
       - it holds a slow chip's new outputs back for that chip's hold count of passes
         (inertial delay — the countdown advances once per CALL);
       - it books a switching output's supply spike;
       - it records what each chip drove.
     - **What the incremental path must do.**
       - Hand it every chip the full path would.
       - For a chip whose inputs did not change, reuse its cached RAW evaluation, but
         still pass it through the hook.
       - Drive whatever the hook RETURNS. A held output can be released on a pass where
         nothing changed at that chip's pins, so a chip's driver contribution changes
         when the hook's return changes, not only when its evaluation does.
     - **A cheaper rule is allowed** only if both of these hold:
       - Spice Light gains an optional hook (say `held()`) naming the chips it is
         holding, and the path calls `outputs` for those plus the chips it re-evaluated.
       - The differential test shows the spike booking and the drive record unchanged.
   - **`busy()`.** Part of the fixpoint test (`mapsEqual(next, levels) && !busy()`). A
     pass where no net changed but a hold is still pending is NOT the end of the solve.
     The next pass has an empty `Δ_k`, and it must still call `outputs` as above —
     otherwise the hold never expires and the solve runs to the cap, reported as an
     oscillation.
   - **`input(c, pin, net, level)`.** What a chip READS on a pin: Spice Light answers
     with that chip's own reading of an RC node, which may differ from the net's level.
     - **Why caching is safe.** It is pure within one solve: Spice Light changes its
       answers only between digital ticks. So a cached evaluation keyed on the levels
       the hook was given stays exact.
     - **Say so in a comment.** A hook that ever answered differently mid-solve would
       make the cache wrong.
     - **Second call site.** The step loop's `samplePins` calls it too.
   - **`levels(next)`.** Overrides each pass's resolved levels on Spice Light's analog
     nodes. It is handed a complete map and returns one. `Δ_k`, the fixpoint test and
     the oscillation marking all read the map it returns.
   - **`context(ctx)`, `psuVolts(comp, set)`, `chipDrop(id)` and `curves`.**
     - **When they are read.** While a context is BUILT. A drooping supply and the
       wires' drop decide each chip's power status, and `curves` decides the timed
       parts' analyses.
     - **Why that matters here.** These change from tick to tick, so a context built
       with them is NOT a pure function of the document and netlist. `contextFor` must
       never hand one back from an earlier call.
     - **What to do.** Either build fresh when such hooks are present, or split the
       hook-dependent facts (power status, the timing analyses) out of the prepared
       context and recompute them per call. The dependency indexes this feature adds
       are hook-independent and belong in the prepared part.
     - **Every call.** `context` is still called on every call's context, reused or not.
   - **No hooks, none of this.** Without hooks (every caller but Spice Light), none of
     this design item applies.
   - **Leave Spice Light alone.** Do not change `sim/spice/engine.js` to make the
     incremental path easier, beyond answering an optional hook named above.

10. **Out of scope** (each is its own later feature): a timed event wheel or propagation
   delays; running the engine in a Web Worker; batching several clock edges per timer
   callback; integer/typed-array net storage (allowed as an internal optimisation in
   step 8 below only if the bench shows it is needed); C++ or WebAssembly.

## Implementation steps

1. **Baseline first.**
   - **Both branches in the tree.** Make sure `performance` and `spice` are both merged
     (Context, "Two branches"). Reconcile `prepareCircuit`/`contextFor` with
     `buildContext`'s hooks as design 9 says. That reconciliation must be a behavioural
     no-op: `engine-parity.test.js`, every `spice-*` test and `make demos` stay green
     with no expectation edited.
   - **Numbers.** Run `make bench` at 8 and 16 slices (`BENCH_SLICES=16 make bench`)
     and `make profile`, and keep the numbers for the summary.
   - **`opts.mode`.** Add it to `tick`/`settle`, with `"full"` routing to the current
     loop unchanged. Spice Light passes it through untouched: `sim/spice/engine.js`
     spreads its options into every digital `tick`.

2. **A differential test before any optimisation** —
   `src/web/scripts/tests/engine-incremental.test.js`. It runs the same circuit through
   `mode: "full"` and `mode: "incremental"` tick by tick and asserts every result field
   equal (`netLevels`, `strongLevels`, `chipStatus`, `warnings` IN ORDER, `iterations`,
   `settled`, `state`, `pinLevels`, `memWrites`, `timing`, `channels`, `wakeAt`), and
   that an observer hears the same `round`/`chip` sequence with equal levels. Fixtures:
   - the busy fixture at 3 and 8 slices, ~100 edges each;
   - every shipped example (`src/web/demos/*.json`, both payload shapes — read them
     through `model/example-desktops.js`), ~16 edges each;
   - the breadboard computers in `demos/` (`eater-core`, `eater-io`, `65xx-blink`,
     `65xx-lcd`) and `demos/ne555.chiphippo`, ~40 edges each, with their ROM images
     loaded the way `tests/demos.test.js` does;
   - targeted circuits for the fallbacks and couplings: an analog switch with a
     floating control (CD4051B), a diode chain with an unknown anode, a resistor chain
     (pull relaxation across several hops), a ring oscillator (oscillation marking), a
     CD4000 LED driven with no resistor (burn levels), a custom chip under the debugger
     observer;
   - **the same comparison under Spice Light.** Run `ENGINES.spice.tick` (Spice Light
     on) with `mode: "full"` against `mode: "incremental"`. Compare every digital field
     above, plus Spice Light's own: `analog`, `nodeVolts`, `supplies`, `loads`, `sag`,
     `lamps`, `currents` and `wakeAt`. Run it on:
     - every shipped example;
     - a mixed 74LS + CD4000 desk (holds longer than one pass: `outputs` and `busy`);
     - an RC node read by a 74LS input and a CD4000 input (`input`, `levels`);
     - a 40106 RC oscillator (crossings across many ticks);
     - a PSU past its current limit, and a long supply wire (`psuVolts`, `chipDrop`);
     - an LED network (`spice-leds.test.js`'s fixtures).

   It must pass against the unchanged engine (trivially) before step 3 starts, and stay
   green after every step.

3. **Dependency indexes in `buildContext`** (pure, built once per context): for each
   net, the chips that read it (by pin role, including `io`); for each channel part,
   its control nets and its terminal nets; the resistor-connected components (union of
   each resistor's two nets, excluding the supply nets, which nothing pulls); for each
   net, the diodes whose anode it is.

4. **Incremental chip evaluation.** Split `driversFor` into "evaluate one chip" and
   "assemble drivers", keep the per-chip outputs from the previous pass, and evaluate
   only the chips step-3 indexes say are touched by `Δ_k` (plus design 3's other cases).
   Maintain `drivers`/`hard` per net incrementally: when a chip's outputs change,
   replace its contributions on the nets it drives. Keep `observer.evaluated` firing
   for every chip actually evaluated.

5. **Incremental net resolution.** Implement design 4's closure and resolve only it,
   keeping each net's last `resolveIn` result (level + warning) and strong level.
   Rework `resolveAll` so the relaxation and the burn resolution can run on a subset;
   the full-pass call is the same code over every net.

6. **The step loop.** Carry the solve's caches into the next solve of the same tick
   (design 5), seeding the sequential chips whose state changed.

7. **Fallbacks** (design 7), each with a comment saying why it is there, and each
   exercised by a fixture in the differential test.

8. **Measure.** `make bench` at 8 and 16 slices; extend the bench report with the
   number of chip evaluations and net resolutions actually PERFORMED per pass (it
   reports today how many saw a changed input), and with a `mode: "full"` timing line
   beside the incremental one. Add a line for the busy fixture under Spice Light, in
   both modes. Its speedup may be smaller, because every powered chip still passes
   through `hooks.outputs` each pass; report it either way. Only if a profile still
   shows Map overhead dominating,
   consider integer net indices inside a solve (convert at the boundary; the public
   maps stay keyed by net id).

9. **Docs.** Update `CLAUDE.md` ("Simulation" — the engine bullet that already
   describes `prepareCircuit` and `pullReach`; and the debugger's note on passes) to
   describe the incremental pass, its fallbacks and the `mode` option. Update
   CLAUDE.md's "Spice Light" section only if the hook contract gained an optional hook.
   No user-guide change: nothing a user sees changes except speed.

## Acceptance criteria

- The differential test passes on every fixture: identical results in every field,
  every tick, and an identical observer record.
- `make test` passes with **no test expectation edited** (new tests only), including
  `demos.test.js`, `gate-demos.test.js`, every `engine-*.test.js` (**`engine-parity.test.js`**
  above all — every example through both engines) and every `spice-*.test.js`.
- The differential test's Spice Light fixtures match field for field, so Spice Light's
  simulated time, held outputs, droop, sag and LED currents are untouched.
- `make demos` regenerates `demos/` and `src/web/demos/` with **no diff**.
- The chip debugger behaves exactly as before: `chip-debugger.test.js` and
  `chip-design-bridge.test.js` unchanged and green; a breakpoint, Step, Step Out, To
  Settled and Detach checked once by hand in the app.
- `make bench`, 8 slices: the incremental mode is **at least 3× faster per tick** than
  `mode: "full"` on the same run. At 16 slices the speedup is **larger** than at 8 (the
  cost now tracks activity, not size).
- `make profile` at ×1: the engine's share of the main thread is lower than the
  baseline from step 1, at the same tick rate.

## Constraints

- The engine stays pure and DOM-free; `tick`/`settle` keep their signatures (new
  options are additive and default to today's behaviour apart from speed). No
  module-level mutable state.
- **The Spice Light hooks keep their names, signatures and call semantics** (design 9).
  The Spice Light seam (`sim/engines.js`: only SimController chooses, and everything
  else imports `sim/engine.js` directly) is unchanged.
- **Chip behaviour stays data.** No per-part code paths in the engine; anything a part
  needs is read from its def through `chip-eval.js`, as today.
- No new dependencies. Plain ES modules, the repo's comment style (say WHY, as the
  surrounding code does), GPL headers on new files, Prettier, ESLint.
- The full-pass mode is not deleted, and is not allowed to diverge: it is the fallback
  and the reference the differential test compares against.
- Do not change what the views receive (`chiphippo:sim-state` is unchanged) or how
  SimController drives the engine, beyond what is needed to keep it working.
- Do not commit or create a branch — leave the working tree for review (CLAUDE.md).

## Verify

```sh
make fmt && make lint && make test
node --test src/web/scripts/tests/engine-incremental.test.js   # the differential test
node --test src/web/scripts/tests/engine-parity.test.js src/web/scripts/tests/spice-*.test.js
make bench && BENCH_SLICES=16 make bench                       # report both modes
make profile                                                   # window must stay on screen
make demos && git diff --stat -- demos src/web/demos           # must be empty
```

Then, in the running app (`make debug`), open a busy circuit and a custom chip with a
breakpoint: Run, Step, Step Out, To Settled, Detach, Stop — and confirm the LEDs, the
schematic tint and the logic analyzer behave exactly as before. Then turn on Settings ▸
Spice Light and run the NE555 and a mixed 74LS/CD4000 desk. The analyzer's curves, the
PSU readout and the LED brightness should match a `mode: "full"` run.

In the summary, report: the baseline and final `make bench` numbers at 8 and 16 slices
for both modes, the `make profile` engine share before and after, how often each
fallback fired on the fixtures, and anything in the design above that turned out to be
wrong.

## finnalize

rename "spice light" as Spice Lite"
