# Batched ticks — the sim clock as an event queue

> **How to use this file.** A self-contained brief for implementing the feature. Read
> `CLAUDE.md` and `.claude/rules/simulation.md` ("Simulation" — SimController, the
> settle boundary, the debugger) and `.claude/rules/parts.md` ("SimController owns the
> sim clock", "The cap") first, then this file top to bottom. Shape: Context · Goal ·
> Settled design · Open decisions · Implementation steps · Acceptance criteria ·
> Constraints · Verify. Unnumbered on purpose: give it a stage number in
> `features/ROADMAP.md` when it is scheduled.

## Context

`SimController` (`components/sim-controller.js`) runs the board off wall-clock timers:

- **One `setInterval` per free-running clock** (`#startTimer`), at `#halfMsOf(c)` =
  `max(MIN_HALF_PERIOD_MS, 1000 / (2·hz·speed))`. Each firing flips that clock and
  calls `#tickNow()`.
- **One `setTimeout` for timed parts** (`#armWake`), firing at the engine's `wakeAt`.
- **Every tick publishes** `chiphippo:sim-state` (`#publish`) and broadcasts its memory
  writes (`chiphippo:mem-state`). So one edge = one engine tick + one full view pass.

`MIN_HALF_PERIOD_MS` (5 ms) is derived from the top of `CLOCK_HZ` (100 Hz), so the app
tops out at **~200 edges/s**. Today only 50 Hz and 100 Hz at ×4 ask for more than
that, and they silently get 200.

Measured 2026-10-07 (`make profile`, busy fixture, 8 slices, 100 Hz at ×4):

| per second of wall time | Digital | Spice Lite |
|---|---|---|
| ticks published | 201 (the cap) | 201 (the cap) |
| engine | 31 ms (≈0.15 ms/tick) | 164 ms (≈0.82 ms/tick) |
| views reacting to `sim-state` | 20 ms (≈0.10 ms/tick) | 29 ms (≈0.14 ms/tick) |
| frames committed | 119 | — |
| main thread idle | 74% | 56% |

So the view pass is about 40% of a digital tick, and the display shows at most ~120
frames a second anyway. Anything published between two frames is never seen.

## Goal

Let simulated time run **faster than the display**: run every edge that is due in a
batch, then publish **once**. Concretely:

1. Requested edge rates past 200/s actually happen, up to what the engine can do.
2. The view pass runs at most once per batch (≤ frame rate), not once per edge.
3. When the engine cannot keep up, the app **says so** rather than quietly running slow.
   This is the rule `MIN_HALF_PERIOD_MS` was written to keep.
4. Nothing an edge-by-edge observer depends on is lost: the logic analyzer still
   records every tick, the Arduino integration still gets every settle boundary, and
   the chip debugger still stops on the tick it should.

## Settled design

### The schedule is in simulated time, not wall time

A pure, DOM-free module, **`sim/schedule.js`**, owns "what happens next". This is the
transport-level event model.

- Each ticking clock carries `{ id, halfS, origin, n }`. Its next edge is at
  `origin + n·halfS`, computed from the count and never accumulated, so floats never
  drift. `halfS = 1 / (2·hz)` in **simulated** seconds. Speed scales the sim clock, not
  the schedule.
- `nextEvent(schedule, wakeAt)` → `{ at, clocks: [ids] }`: the earliest clock edge or
  timed-part wake. **Edges falling at the same instant (|Δ| < 1 ns) are one event and
  one tick**, every clock in it flipped together. This is what Step already does
  (`#advance` flips every ticking clock at once), and the engine's two-phase `tick`
  observes all edges at once by design. Today two coincident clocks tick in whatever
  order their intervals happen to fire.
- Retiming: a new, re-rated or resumed clock gets `origin = now`, `n = 1` (first edge
  one half-period on), which is what restarting its interval does today.
  `#reconcileClocks` keeps its rule of leaving an unchanged clock alone. A clock paused
  on its own leaves the schedule.

### One pacer drives everything

The per-clock intervals and the wake timeout are replaced by **one timer**: the pacer
(`components/sim-pacer.js`, injected into `SimController` so tests can drive it).

- **A batch**: `target = #simNow()`. While `nextEvent.at ≤ target`, flip that event's
  clocks and tick with **`now = event.at`** (the event's exact time, not the wall
  clock's reading at the moment the timer happened to fire). The batch then publishes
  once if anything ticked.
- **Waking**: the pacer sleeps until the next event, but **no sooner than `FRAME_MS`
  (8 ms) after the last publish**. A 1 Hz clock still wakes once per edge, exactly
  as today. A 100 Hz ×4 clock wakes about every 8 ms and runs ~6 edges per batch.
- **A timer, not `requestAnimationFrame`**: rAF does not fire in a hidden window
  (`ai-panel.js` says why it avoids it for the same reason). A board driving an Arduino
  must keep running when the window is covered.
- **Budget**: a batch stops after `BATCH_BUDGET_MS` (6 ms) of work, even with events
  still due. The debt is then **dropped, not queued**: the sim clock re-anchors at the
  last event run (`#simAnchor = event.at`, `#realAnchor = wallMs()`), the same "time
  freezes, edges are skipped" rule a stall already follows. So a board that can't keep
  up runs slower and smoothly. It never bunches up and never freezes the UI.
- **Saying so**: the pacer keeps a rolling ratio of simulated to wall time over ~1 s.
  When it is below 95% of the requested speed, the speed button shows the achieved
  rate in amber beside its own (`×4 · ×2.3`), cleared once it catches up. The ratio
  rides `sim-state` as `achieved`. It is display state and never stored.

### What runs per tick, and what runs per batch

| | per tick (every edge) | per batch (once) |
|---|---|---|
| engine `tick`, `#warm`/`#state`/`#prevPins`, `wakeAt` | ✓ | |
| `#persistDamage` (a smoke latch must hold from the next tick) | ✓ | |
| integration `settled` (the settle boundary) | ✓ | |
| debugger `observer` / `afterTick` | ✓ | |
| warnings → `#report` (toasts are keyed, so repeats are free) | ✓ | |
| **`chiphippo:sim-tick`** (new; the recorders' stream) | ✓ | |
| memory writes into the run image | ✓ | |
| `chiphippo:mem-state` changes (merged in order) | | ✓ |
| **`chiphippo:sim-state`** (the views) | | ✓, the last tick's board |

- **`chiphippo:sim-tick`** carries what a recorder needs from ONE tick:
  `{ at, netLevels, nodeVolts, lamps, mode }`. These are references to the tick's own
  maps, with no copies. That is safe because a recorder reads them synchronously inside
  its handler (the analyzer's fold already does), so it does not matter whether a later
  tick reuses a map.
  The **logic analyzer moves to it** (`scope-view.js` `#onSim`). Its column stays one
  per tick, so its tick-indexed model does not change. `at` (simulated seconds) is
  there so the Δ readout can later use real stamps in place of `tickMsFor`'s estimate
  (follow-up, not this stage).
- **`sim-state` stays exactly what it is**, the last tick of the batch. Every other
  listener (overlay, schematic, 3D, signal rail, properties dialog, chip debugger's
  live follow) is untouched and simply hears it less often.
- **Anything that ends the batch early publishes on the way out**. An integration
  stall (a promise from `settled`) ends the batch and publishes the board it stalled
  on. A debugger stall already publishes through `show`/`showFinal`. Stop publishes
  its cleared state as today.

### Input events still answer at once

A switch, signal key, manual clock, part-state, doc change, `wake()` or clock pause:
**first run the batch that is due** (catch up to now, within budget, so the input lands
after the edges that preceded it), **then** tick the input and **publish
immediately**. Inputs are human-paced, so this costs nothing, and the board answers on
the same event as today. Code that reads sim state synchronously after an input (the
reason rAF coalescing was turned down before) keeps working. Step, Pause and Stop
behave as today. Step keeps its "flip every ticking clock" rule.

### What goes away

`MIN_HALF_PERIOD_MS`, `#timers`/`#timerHalfMs`/`#startTimer`/`#stopTimer`/
`#clearTimers`, and `#armWake`/`#wakeTimer` as separate timers. The tests that stub
`setInterval` to inspect half-periods (`sim-controller.test.js` ~L448–L560) are
rewritten against `sim/schedule.js`, where the same facts are pure and exact.

## Decisions (Jason, 2026-10-07)

1. **Faster rates, not faster speeds.** `CLOCK_HZ` gains **250 Hz and 1 kHz**
   (labelled `1 kHz` by `catalog/parts.js` `hzLabel`); `SPEEDS` stays ×¼ / ×1 / ×4.
2. **The timed parts' cap goes to 1 kHz too.** `TIMING_CAP_HZ` stays DERIVED from
   the top of `CLOCK_HZ`, which is now 1 kHz, so `MIN_SHOWN_S` is 0.5 ms.
3. **The lamps lose their glow past 25 Hz.** Jason first said 100 Hz, then "better
   yet, 25 Hz". Sim-state carries `fastestHz` (the fastest ticking clock, and
   every timed part's drawn oscillation from `oscillationHz`, × speed). Past
   `GLOW_MAX_HZ` (25, `sim-overlay.js`) the viewport takes
   `desk-viewport--flat-lamps`, which drops the drop-shadow halo on lit LEDs,
   display segments, clock lamps and transistor lamps. Colour and brightness
   stay. The rule is per run, not per lamp.

### Found while building

- **A timed part's wake comes no sooner than `MIN_SHOWN_S` after the last tick**
  (`#nextEvent`). Spice Lite asks for a wake at every crossing. If each one is
  ticked at its exact moment, no tick ever spans the crossings that
  `spice/cycles.js` recognises a cycle by, so a fast oscillator would run edge by
  edge forever. The old wake timer's 1 ms wall floor had been hiding this.
  Clock edges keep their exact moments.
- `sim-pacer.js` holds the constants and `RunMeter`. The one timer itself lives
  in `SimController` (`#arm` / `#runBatch`), injectable through the constructor's
  `clock` option, which the tests drive.
- The speed button writes its face only when it changes, because it hears every
  `sim-state`.

### Measured (`make profile`, busy fixture, 8 slices)

| | before | after |
|---|---|---|
| 100 Hz ×4, digital: edges run | 201/s | **806/s** (asked 800) |
| …main thread busy | 29% | 26% |
| …layerize/commit | 16.6% | 6.6% (flat lamps) |
| 1 kHz ×4, digital | — | 3,551/s of 8,000 asked; button reads `×4 · ×1.7`; 60% busy, 71 fps |
| 100 Hz ×4, Spice Lite | 201/s | 528/s of 800 asked; `×4 · ×2.6`; 58% busy, 77 fps |

## Implementation steps

1. **`sim/schedule.js` + `tests/sim-schedule.test.js`**: clocks by count, `nextEvent`
   with coincidence, retime/remove, wake folding. Pure; no controller yet.
2. **`components/sim-pacer.js`**: the one timer, `FRAME_MS`, `BATCH_BUDGET_MS`, debt
   drop, the achieved-ratio window. Injectable `{ now, setTimeout, clearTimeout }`.
3. **`SimController`**: replace the intervals and the wake timeout with the pacer.
   `#tickOnce` takes `now` from its event, and publishing moves out of `#tickOnce` into
   the batch end and the input path. Keep `#tickNow` as the input path: catch up, then
   tick, then publish.
4. **`chiphippo:sim-tick`** per tick; move `scope-view.js` to it; merge `mem-state`
   per batch.
5. **The behind readout** on the speed button (`app.js` ~L510), with i18n keys in
   every locale (see "Language support").
6. **The decisions above.**
7. **`scripts/profile-desk.mjs`**: report ticks *run* and `sim-state`s *published*
   separately, plus achieved vs asked edge rate.
8. Docs: the user guide's transport/speed section (the behind readout, any new
   speeds); `.claude/rules/simulation.md` ("SimController") and `parts.md` ("owns the
   sim clock", "The cap").

## Acceptance criteria

- Busy fixture, digital, 100 Hz at ×4: **800 edges/s run** (was 201), `sim-state`
  published ≤ ~125/s, and main thread busy no worse than today's 29%.
- Same at Spice Lite: runs as fast as the budget allows, and the speed button shows
  the achieved rate in amber.
- At ×1 and ≤ 20 Hz, behaviour is indistinguishable from today: one publish per edge,
  same levels.
- The logic analyzer records one column per tick at every speed (a test drives a batch
  of N edges and expects N columns).
- An Arduino Output still stalls on the exact edge that triggers it, and a batch ends
  there. A debugger breakpoint still stops on its tick.
- A switch flipped mid-batch lands after the edges due before it, and its result is
  published before the handler returns.
- `make fmt && make lint && make test` green; `make bench` unchanged (engine untouched).

## Constraints

- The engine stays pure and timerless; nothing under `sim/` learns about frames, and
  `sim/schedule.js` is pure arithmetic.
- No Web Worker. Moving the engine off the main thread was considered: the integration
  boundary and the debugger observer are synchronous per tick, and a worker would turn
  each into a round trip. With the view pass gone from the per-edge path, the engine is
  3–16% of the main thread, not enough to pay for that.
- Views still render only from `sim-state`; recorders only from `sim-tick`. Nobody
  queries the engine.

## Verify

- `make profile` (digital) and `PROFILE_SPICE=1 make profile`, before and after:
  ticks run vs published, achieved rate, main-thread busy.
- `make debug`: the busy fixture at each speed; a 1 Hz clock still blinks on the beat;
  a 555 demo still reads its rate; an analyzer trace at ×4 shows every count; hide the
  window, return, and the board has kept running (slower is fine; frozen is not).
