# 01 — Stop waking the engine for the display

**Review refs:** engine review §3.2, §3.3 (`wakeAt`), Appendix A (`ANALOG_FRAME_S`,
`WAVE_FRAMES`, `WAVE_FRAME_MIN_S`, `MIN_SHOWN_S`)
**Depends on:** 00
**Accuracy:** must not change any engine result. The golden suite must be
**bit-identical**, and the tick-spacing invariance check must stay green.

## Problem

Many of the engine's wakes exist only so the UI has something to draw:

- `ANALOG_FRAME_S` (1/30 s): a whole-desk tick while any node moves.
- `WAVE_FRAMES` (16 per period, ≥ 2 ms): ticks while the scope records. That
  is ~1,600 ticks/s on a 100 Hz wave, and the 750 vs 552 ms/s gap in §6.

Each of these is a full Spice Lite tick: at least two whole-desk settles plus
the end-of-tick work.

Between events, the carried analog state is already exact closed-form curves:
node curves, group modes, cycle schedules. Digital levels are piecewise
constant. The views can sample that state themselves.

## Goal

The engine wakes only for events with an electrical or digital consequence:

- crossings
- corners
- clock edges
- timers
- chatter back-off
- regulator cool-down
- coil events
- user input

The UI updates at **25 fps** from the carried state, sampled at the frame's
simulated time.

## Design

1. **A pure sampler**, e.g. `sim/spice/sample.js`, with
   `sampleAnalog(analog, t)`. It returns node volts at `t` from the carried
   curves, groups (via `dynamics.js`), coils and a drawn cycle's schedule (its
   phase at `t`). No settle, no mutation. Reuse the exact evaluators the engine
   uses, so there is one implementation of each curve.
2. **Remove the display wakes** from the `wakeAt` computation:
   `ANALOG_FRAME_S` and the scope's wave frames.
   - Keep any frame that exists for a physical reason. If a wave's frames also
     serve as corners for a nonlinear load, keep the corner. The display
     frame goes.
   - Document each wake source left in `wakeAt` and what it is for.
3. **Publishing at 25 fps.** SimController (or the pacer) publishes
   `sim-state` once per display frame (40 ms real time), carrying the analog
   state and the time it is valid from. Views call `sampleAnalog` at the
   frame's simulated `now`.
   - Coalesce `chiphippo:sim-tick` to once per frame.
   - Consumers that need every event get an **event log** for the frame (edges
     with their simulated times, per net) instead of a publish per tick.
4. **Scope.** Build traces from the curve segments and the edge log, not from
   frame samples. Draw analog traces by evaluating curves at the scope's pixel
   resolution. This is more accurate than 16 samples per period.
5. **Probe, LEDs, meters** read from the sampler at frame time.
   - LED brightness under a drawn cycle uses the cycle's duty, as today.
6. **Drawn cycles: the `MIN_SHOWN_S` floor.**
   - A drawn cycle whose island has no digital consumer needs no wakes between
     frames. A consumer is a chip input reading the cycle's nets that is not
     advanced by the cycle's own counting.
   - Otherwise keep today's behaviour in this step. Step 02 removes the
     per-segment settling, which makes frame-sized jumps cheap.
7. **Golden and test path.** Readings at exact instants must still land
   exactly. Keep or add a `sampleTimes` option, as the accuracy review's
   Appendix C did with "the next reading time":
   - The test driver ticks or samples at those instants.
   - The value read comes from the sampler and must equal today's reading.

## Must hold

- `tests/spice-golden.test.js`: every value identical to before.
- Tick-spacing invariance: green.
- `tests/engine-parity.test.js`: green.
- Debugger single-step still works. Step = one event, not one frame.
- Pausing shows the state at the paused simulated time, via the sampler.

## Tests to add

- Sampler vs engine: run several fixtures and, at 200 random instants per run,
  compare `sampleAnalog` against a forced engine tick at that instant.
  Agreement must be within 1e-9 V.
- Scope trace from segments vs the old frame samples, at the old sample times.

## Acceptance

`make bench-compare` against the 00 baseline:

- `busy-triangle` ms/sim-s and ticks/sim-s fall to about `busy-triangle-noscope`
  or below.
- No fixture gets slower.

Record in RESULTS.md.

## Out of scope

Cycle replay without settling (02). Workers (03).
