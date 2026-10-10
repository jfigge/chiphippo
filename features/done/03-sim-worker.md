# 03 — Run the engine in a Worker

**Review refs:** engine review §3.2 (`BATCH_BUDGET_MS` 6 ms of `FRAME_MS` 8 ms)
**Depends on:** 01 (25 fps publishing makes the message traffic small)
**Accuracy:** no engine change. Results must be identical to the main-thread
engine for the same event sequence.

## Problem

The engine shares the renderer's thread:

- It gets at most 6 ms of every 8 ms, minus rendering and GC.
- A run is marked `behind`, and its debt dropped, when that budget runs out.
  That is a correctness issue as well as a speed one, because dropped debt
  means skipped simulated time.

## Goal

The engine runs in a dedicated Worker and can use most of a core. The renderer
receives one state message per display frame (25 fps) and renders from the
sampler (step 01).

## Design

1. **Engine host in a Worker** (`sim/worker/engine-host.js`). It owns:
   - the netlist and prepared context;
   - the carried state;
   - the transport: event queue, `EdgeSchedule`, batches.

   SimController becomes a thin proxy: commands in, frames out.
2. **Messages in**: `load(document)`, `edit(delta)` (or a full reload, if
   simpler for a first cut), `run`, `pause`, `step`, `input(net, value)` and
   scope configuration.
3. **Messages out**: a per-frame snapshot. It contains:
   - the carried analog state (enough for `sampleAnalog`);
   - digital levels;
   - the frame's event log;
   - lamps, currents, supplies, warnings;
   - the `behind` status.

   Use structured clone. Measure size, and use transferables for typed arrays
   if large.
4. **Pacing in the Worker**:
   - simulated time follows wall-clock time;
   - the batch budget becomes a fraction of the frame (e.g. 30 ms of 40 ms) or
     continuous work;
   - `behind` keeps its meaning.
5. **Debugger and step**: synchronous single-step semantics must survive. A
   step is a request and response; the UI waits for it.
6. **Fallback**: keep a main-thread mode behind a flag for debugging and
   tests. Both modes use the same host module.

## Must hold

- `engine-parity`, `engine-incremental` and the golden suite are unchanged.
  They run the engine directly, not through the Worker.
- New test: the same scripted input sequence through the Worker host and
  through the main-thread host gives identical per-frame snapshots.
- No UI feature regresses: probe, scope, LEDs, warnings, debugger, step, edits
  while running.

## Acceptance

- In the app, `busy+555-slow` and `busy-triangle` run without `behind`.
- Main-thread frame time stays under 40 ms with the engine saturated.

Record what headroom the Worker gives (engine ms available per sim-second)
in RESULTS.md.

## Out of scope

Multiple workers per island. Revisit after 12.
