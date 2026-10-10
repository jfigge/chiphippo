/*
 * Copyright 2026 Jason Figge
 *
 * This file is part of Chip Hippo.
 *
 * Chip Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * Chip Hippo is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Chip Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

// drive-spice.js — Spice Lite driven headless EXACTLY as SimController drives
// it (features/00-bench-islands.md; the engine review's Appendix B), in one
// place, so every step of the performance series measures against the same
// transport and a step that changes the transport changes it here.
//
//   · The document and its netlist are built once (Spice Lite's variant, an
//     inductor a branch) and the circuit prepared once (`prepareCircuit`),
//     as SimController keeps them while nothing changes.
//   · The Run tick is at 0; every free-running clock's edges are counted from
//     there (`EdgeSchedule`), every clock idle LOW at Run.
//   · Each tick is handed the previous one's `netLevels`, `state`,
//     `pinLevels` and `analog`, the clocks' levels and `clockTimes` (each
//     one's half-period and last edge — where a wave is between edges).
//   · The next tick is at the earlier of the next clock edge and
//     `max(wakeAt, last tick + MIN_SHOWN_S)` — SimController's `#nextEvent`;
//     coincident edges are one tick, every clock in it flipped together.
//   · `scope` stands for the analyzer recording (`spice.waveFrames`).
//
// Pure of the wall clock except for what it times; no globals. `stats` is
// handed to the engine as its counters (sim/engine.js `opts.stats`, Spice
// Lite's own beside them) and costs nothing when absent.

import { buildNetlist } from "../sim/netlist.js";
import { prepareCircuit } from "../sim/engine.js";
import { ENGINES } from "../sim/engines.js";
import { H, L } from "../sim/levels.js";
import { MIN_SHOWN_S } from "../sim/timing.js";
import { EdgeSchedule, clockHalves } from "../sim/schedule.js";
import { partDef } from "../catalog/index.js";

/**
 * Run `doc` under Spice Lite from Run to `seconds` of simulated time.
 * @param {object} doc
 * @param {object} opts
 * @param {number} opts.seconds - how long to run, simulated seconds
 * @param {boolean} [opts.scope] - the analyzer is recording (wave frames)
 * @param {object|null} [opts.stats] - counters the engine adds to
 * @param {object} [opts.config] - the Spice Lite setting
 * @param {(now: number, result: object, input: object) => void} [opts.onTick]
 *   - after each tick, its moment, its result and the options it was handed
 *   (`tick(input)` again — with another `now` — replays it from the same
 *   state)
 * @param {(now: number) => void} [opts.beforeTick] - before each tick
 * @param {(now: number) => Map} [opts.signals] - the signal levels a tick
 *   at `now` runs with (a test's inputs; none by default)
 * @param {number[]} [opts.at] - moments an input changes: each is ticked, as
 *   SimController ticks an input event
 * @param {boolean} [opts.end] - tick at `seconds` itself too, so every run
 *   ends at the same moment however its wakes fell
 * @param {object} [opts.spice] - more of the `spice` option (`replay`, …)
 * @param {{at: number, doc: object}[]} [opts.edits] - the document replaced
 *   mid-run (a switch flipped, a part edited), each ticked at its moment as
 *   SimController ticks a doc change: a new netlist and context, the run's
 *   state, levels and analog side carried on
 * @returns {{ticks: number, result: object, netlist: object, now: number}}
 */
export function driveSpice(doc, opts) {
  const {
    seconds,
    scope = false,
    stats = null,
    config = { enabled: true },
    onTick = null,
    beforeTick = null,
    signals = null,
    at: inputs = [],
    end = false,
    spice = {},
    edits = [],
  } = opts;
  const { tick } = ENGINES.spice;
  let netlist = buildNetlist(doc, new Map(), { inductors: "branch" });
  let context = prepareCircuit(doc, netlist);
  const pendingEdits = [...edits].sort((a, b) => a.at - b.at);
  const clockDef = partDef("clock");
  const clocks = (doc.components ?? []).filter((c) => c.kind === "clock");
  const clockPhase = new Map(clocks.map((c) => [c.id, L]));
  const schedule = new EdgeSchedule();
  const since = new Map();
  const halves = new Map();
  for (const c of clocks) {
    if (!clockDef.isAuto(c.params)) continue;
    // A PWM's halves are unequal (its pulse width HIGH), as SimController
    // schedules them; every clock starts LOW.
    const { low, high } = clockHalves(c.params.hz, clockDef.dutyOf(c.params));
    halves.set(c.id, { low, high });
    schedule.set(c.id, low === high ? low : [low, high], 0);
    since.set(c.id, 0);
  }
  const clockTimes = () => {
    const out = new Map();
    for (const [id, { low, high }] of halves) {
      const half = clockPhase.get(id) === H ? high : low;
      out.set(id, { half, since: since.get(id) });
    }
    return out;
  };

  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  let analog = null;
  let result = null;
  let tickAt = 0;
  let ticks = 0;
  const run = (now) => {
    tickAt = now;
    while (pendingEdits.length && pendingEdits[0].at <= now) {
      doc = pendingEdits.shift().doc;
      netlist = buildNetlist(doc, new Map(), { inductors: "branch" });
      context = prepareCircuit(doc, netlist);
    }
    beforeTick?.(now);
    const input = {
      document: doc,
      netlist,
      warmStart: warm,
      state,
      prevPinLevels: prev,
      clockPhase,
      clockTimes: clockTimes(),
      signalLevels: signals ? signals(now) : new Map(),
      images: new Map(),
      now,
      context,
      stats,
      spice: { config, analog, waveFrames: scope, ...spice },
    };
    result = tick(input);
    ticks++;
    warm = result.netLevels;
    state = result.state;
    prev = result.pinLevels;
    analog = result.analog ?? null;
    onTick?.(now, result, input);
  };

  run(0);
  for (;;) {
    const wake =
      result.wakeAt == null
        ? null
        : Math.max(result.wakeAt, tickAt + MIN_SHOWN_S);
    const pending = [...inputs, ...edits.map((e) => e.at), ...(end ? [seconds] : [])].filter((x) => x > tickAt); // prettier-ignore
    const input = pending.length ? Math.min(...pending) : null;
    const event = schedule.next(wake == null ? input : input == null ? wake : Math.min(wake, input)); // prettier-ignore
    if (!event || event.at > seconds) break;
    for (const id of event.clocks) {
      clockPhase.set(id, clockPhase.get(id) === H ? L : H);
    }
    schedule.consume(event.clocks);
    const at = Math.max(event.at, tickAt);
    for (const id of event.clocks) since.set(id, at);
    run(at);
  }
  return { ticks, result, netlist, now: tickAt };
}
