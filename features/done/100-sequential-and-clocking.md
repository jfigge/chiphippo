# Feature 100 — Sequential logic & clocking

## Context
The v1 engine (Feature 90) settles combinational circuits with zero-delay semantics
and warm-started nets — enough for gate-feedback latches, but not for
**edge-triggered** parts: a 7474 needs to see a clock *transition*, and a counter
needs a clock *source*. This stage adds chip-internal state and edge detection to
the engine, a clock-source component, transport controls (run/pause/step/speed),
and the first MSI wave — turning Chip Hippo into something that can run a real
counter, shift register, or decoded display driver chain.

## Goal
The user drops a clock source, wires it to a 74161, and watches the count ripple
through LEDs at a chosen speed; pauses; single-steps edge by edge; and builds
classics (divide-by-two, Johnson counter, 74138-decoded LED bar) that behave like
the datasheets say.

## Design decisions (settled — do not relitigate)
- **Two-phase evaluation** replaces the flat settle for stateful parts. Each
  **tick** (any input event or clock transition): ① *sample* — every sequential
  chip reads its input-pin levels and the previous tick's levels, detects its
  clock/gate edges, and computes its next internal state via the def's
  `step(state, inputs, prevInputs) → state'`; ② *settle* — the Feature 90 loop
  runs with sequential outputs driven from the *new* state (their `outputs(state,
  inputs)` fn) alongside combinational chips, until fixpoint. This is the standard
  synchronous two-phase trick: all edges observed simultaneously, then the
  combinational cloud settles. Async inputs (7474/7476 preset/clear, 74161 async
  reset, 74193's separate up/down clocks) are handled inside `step`/`outputs` per
  datasheet — level-sensitive overrides beat clocked state.
- **Def shape** (extends Feature 80's forward-compatible `logic`):
  `{ state0, step, outputs, units? }` — data-plus-pure-functions per chip *family*
  (one shared D-FF implementation parameterized per unit, etc.). Engine stores
  per-component state in the run's volatile memory (never in the document), reset
  on Run.
- **Chip wave**: latches/FFs **7473, 7474, 7475, 7476, 74107**; MSI **74138,
  74139** (decoders), **74151, 74157** (mux/selector), **74161** (sync 4-bit
  counter), **74164, 74165** (shift registers), **74175** (quad D), **74193**
  (up/down counter). Decoders/mux are combinational — they ride the Feature 80
  evaluator with wider truth functions; only genuinely stateful parts use
  `step`. DIP-14/16 all; datasheet-exact pinouts and control semantics
  (active-low enables, sync vs async clears).
- **Clock source**: a desk-level component like the PSU (`kind: "clock"`,
  terminals `clk1.out` / `clk1.gnd`, wired like any terminal). `params.hz ∈ 1 | 2 |
  5 | 10 | manual`; body shows a pulse glyph that blinks with the output. The
  **timer lives in `SimController`** (renderer, `setInterval`-based, honors
  pause) — the engine stays pure and timerless: the controller calls
  `engine.tick()` with the clock terminals' toggled levels. `manual` mode makes
  the clock body a click-to-toggle button.
- **Transport controls**: the header Run control grows into Run / Pause / **Step**
  (one half-period per press — each press toggles clock level, so two presses per
  full cycle; shown as such) / speed selector applying to all auto clocks
  (multiplier ×¼ ×1 ×4). Editing stays locked whenever the transport isn't
  Stopped.
- **Test fixtures extend the Feature 90 harness**: 7474 divide-by-two over scripted
  edges; async clear mid-count; 74161 counts 0–15 with terminal-count carry;
  74165 parallel-load-then-shift; 74138 one-hot outputs; two-phase correctness
  (a 74164 fed by a 7474 shifts the FF's *pre-edge* value — the classic
  race-through check).

## Implementation steps
1. **Engine two-phase core.** Tick pipeline (sample → step → settle), per-component
   state store, previous-level tracking; race-through fixture first (TDD the
   two-phase contract).
2. **Sequential def framework.** `step`/`outputs` plumbing in `chip-eval.js`;
   shared FF/counter/shift implementations; catalog integrity extended (state0
   present, outputs cover output-role pins).
3. **Chip wave defs + datasheet tests.** The 14 chips, each with fixture tests for
   its control-line corner cases.
4. **Clock component.** Catalog def, `ClockView` (blinking glyph, manual click),
   desk placement, params menu (hz), terminals in netlist/occupancy (reuses the
   Feature 60 terminal machinery).
5. **Transport.** SimController timer, pause/step semantics, speed multiplier,
   header UI, edit-locking unification.
6. **jsdom tests.** Transport button states; clock body blink class tracks level;
   step advances exactly one half-period.

## Acceptance criteria
- 7474 wired Q̄→D divides a 1 Hz clock by two, visibly on an LED; Step advances it
  deterministically half-period at a time.
- 74161 + 74138 + LEDs runs a walking-bit display at every speed; pause freezes
  and resume continues from the same count; async clear works mid-run.
- The race-through fixture passes: chained FFs shift, never fall through, across
  ticks in a single settle.
- Datasheet corner cases (active-low enables, preset/clear priority, 74193 dual
  clocks) pass their fixtures; manual clocks toggle by click.
- Engine remains pure/timerless (timer proven to live in the controller by tests
  running ticks with no timers); `make fmt && make lint && make test` green.

## Constraints
- Chip state is run-volatile — never serialized into the desk document.
- Sequential behavior only via the `step`/`outputs` framework — no bespoke engine
  branches per chip; extend the framework vocabulary if a part doesn't fit.
- Zero-delay-within-tick semantics stand; true propagation-delay modelling is out
  of scope (backlog: instrumentation/timing view).
- House rules throughout (tokens, naming, pure/DOM split, popup menus).

## Verify
`make fmt && make lint && make test`, then `make debug`: build the divide-by-two
and step it; build a 74161 → 74138 walking-bit bar and run it at each speed, pause,
step, resume; hit the counter's clear mid-run; switch a clock to manual and click
it through a full count cycle.
