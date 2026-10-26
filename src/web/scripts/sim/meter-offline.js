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

// meter-offline.js — what a multimeter reads on a STOPPED bench. Pure and
// DOM-free.
//
// Stopped is the bench switched off: no supply, no clock, no signal is
// driving anything, so a meter on volts or amps reads nothing — but on ohms,
// continuity, diode test or capacitance it is the one source left, and
// reads the circuit as a real meter reads an unpowered board. That is Spice
// Lite's own solve of the desk with every source taken away and the meter's
// test source (catalog/meter.js `METER_ELEMENTS`) the only one — run IN
// TIME (`BenchRun`), from the moment the probes touch: across a capacitor
// the ohms reading climbs as the test current charges it, and an LED on the
// diode test glows faintly with it (components/meter-bench.js drives it on
// the wall clock). The meter's reading is the voltage across its probes, off
// the curves the engine carries (spice/sample.js). Every other meter is left
// out: two meters on ohms would read each other.
//
// Capacitance is TIMED (`measureCapacitance`): the test charges what is
// across the probes one way and the other between its two thresholds and
// times a whole swing — exactly the capacitance of a capacitor on its own,
// and whatever a resistor or another part across it makes of the timing.
//
// Not the run's engine: like the Properties card's Timing row it answers
// from the CURRENT document while nothing runs, and is asked again whenever
// the document changes (components/meter-bench.js).

import { buildNetlist } from "./netlist.js";
import { prepareCircuit } from "./engine.js";
import { ENGINES } from "./engines.js";
import { sampleAnalog } from "./spice/sample.js";
import {
  CAP_FULL,
  CAP_LOG,
  CAP_TEST,
  capOhms,
  capSwingS,
  isSourceFunction,
  meterSetup,
} from "../catalog/meter.js";
import { probeNets } from "../model/meter-probes.js";

/** The bricks that are sources: off when the bench is. */
const SOURCE_KINDS = new Set(["psu", "clock", "load", "ac", "adapter"]);

/** How long the stopped bench is run on before it is read, simulated
    seconds: through the meter's 8 kΩ, 750 µF charges past five time
    constants in it (a bigger capacitor still reads as it charges). */
export const REST_S = 30;

/** At most this many of the engine's wakes are run through in one go. */
const MAX_WAKES = 2000;

/** A capacitance range gives up on a swing after this many times its full
    scale's (and moves up a range; past the last, OL). */
export const CAP_TIMEOUT = 1.2;

/** How finely a stretch is scanned for a crossing before it is bisected. */
const SCAN_STEPS = 64;
const BISECTIONS = 60;

/**
 * The desk as it stands switched off, with one meter on it: every source
 * brick, every other meter, every signal and every integration gone.
 * @param {object} doc - a desk document
 * @param {string} meterId
 */
export function benchOff(doc, meterId) {
  return {
    ...doc,
    components: (doc.components ?? []).filter(
      (c) => !SOURCE_KINDS.has(c.kind) && (c.kind !== "meter" || c.id === meterId), // prettier-ignore
    ),
    signals: [],
    integrations: [],
  };
}

/** A desk with one meter's params patched (its own copy). */
function withMeter(doc, meterId, patch) {
  return {
    ...doc,
    components: doc.components.map((c) =>
      c.id === meterId ? { ...c, params: { ...c.params, ...patch } } : c,
    ),
  };
}

/**
 * The switched-off bench with one meter's test source on it, run in time
 * from 0 (the probes touching): ticked at each of the engine's own wakes on
 * the way to a moment asked for, read between them off its curves.
 */
export class BenchRun {
  #off;
  #meterId;
  #config;
  #drive = null; // the capacitance test's {range, sign}, or null
  #doc = null;
  #netlist = null;
  #context = null;
  #pos = null;
  #neg = null;
  #warm = new Map();
  #state = new Map();
  #prev = new Map();
  #analog = null;
  #result = null;
  #time = 0;

  /**
   * @param {object} doc - a desk document (the whole desk: it is switched
   *   off here)
   * @param {string} meterId
   * @param {object} [config] - the Spice Lite setting
   * @param {{range: number, sign: number}|null} [drive] - the capacitance
   *   test's, to start with
   */
  constructor(doc, meterId, config = { enabled: true }, drive = null) {
    this.#off = benchOff(doc, meterId);
    this.#meterId = meterId;
    this.#config = config;
    this.#drive = drive;
    this.#build();
  }

  #build() {
    const doc = this.#drive ? withMeter(this.#off, this.#meterId, { capDrive: this.#drive }) : this.#off; // prettier-ignore
    this.#doc = doc;
    this.#netlist = buildNetlist(doc, new Map(), { inductors: "branch" });
    this.#context = prepareCircuit(doc, this.#netlist);
    const meter = doc.components.find((c) => c.id === this.#meterId);
    const { red, black } = meter ? probeNets(meter, this.#netlist) : {};
    this.#pos = red ?? null;
    this.#neg = black ?? null;
  }

  /** Whether the meter touches anything: both probes on a net. */
  get reads() {
    return Boolean(this.#pos && this.#neg);
  }

  /** Whether both probes are on ONE net — a dead short between them, which
      reads 0 V across (0 Ω, the continuity beep): a wire joining the two
      holes, or two holes of one strip. */
  get shorted() {
    return this.reads && this.#pos === this.#neg;
  }

  #tick(now) {
    const result = ENGINES.spice.tick({
      document: this.#doc,
      netlist: this.#netlist,
      warmStart: this.#warm,
      state: this.#state,
      prevPinLevels: this.#prev,
      clockPhase: new Map(),
      clockTimes: new Map(),
      signalLevels: new Map(),
      images: new Map(),
      now,
      context: this.#context,
      spice: { config: this.#config, analog: this.#analog },
    });
    this.#warm = result.netLevels;
    this.#state = result.state;
    this.#prev = result.pinLevels;
    this.#analog = result.analog ?? null;
    this.#result = result;
    this.#time = now;
  }

  /** Run on to `t`: a tick at every wake on the way. */
  advance(t) {
    if (!this.#result) this.#tick(0);
    for (let n = 0; n < MAX_WAKES; n++) {
      const wake = this.#result.wakeAt;
      if (wake == null || wake > t) return;
      this.#tick(Math.max(this.#time, wake));
    }
  }

  /** The voltage across the probes at `t`, off the last tick's curves —
      `arrived` (the settle gap, percent) reading a node near its rest AT
      its rest, as the run's own resting frame does. */
  #read(t, arrived = null) {
    const { volts } = this.#analog ? sampleAnalog(this.#analog, t, { arrived }) : { volts: new Map() }; // prettier-ignore
    const at = (net) => volts.get(net) ?? this.#result.nodeVolts?.get(net) ?? null; // prettier-ignore
    const a = at(this.#pos);
    const b = at(this.#neg);
    if (a != null && b != null) return a - b;
    return this.#result.bench?.get(this.#meterId)?.volts ?? null;
  }

  /** The voltage across the probes at `t` (simulated seconds from the
      touch), or null when the meter touches nothing. */
  voltsAt(t, { arrived = null } = {}) {
    if (!this.reads) return null;
    if (this.shorted) return 0;
    this.advance(t);
    return this.#read(Math.max(t, this.#time), arrived);
  }

  /** Every LED's verdict on the last tick (spice/lamps.js), or null. */
  get lamps() {
    return this.#result?.lamps ?? null;
  }

  /** Whether the bench has come to rest: no wake to come, no node moving. */
  get settled() {
    return Boolean(this.#result) && this.#result.wakeAt == null && this.#result.frameAt == null; // prettier-ignore
  }

  /** Set the capacitance test's drive from `at` on: the bench as it stands
      then, its charges kept, with the source turned or its range changed. */
  drive(drive, at) {
    this.advance(at);
    // The bench brought to `at` as it stood — its charges are a tick's, so
    // the swing so far is booked before the source turns.
    if (this.#time < at) this.#tick(at);
    this.#drive = drive;
    this.#build();
    this.#tick(Math.max(at, this.#time));
  }

  /**
   * The first moment from `from` (never past `until`) the voltage across the
   * probes reaches `target` going `dir` (+1 up, −1 down) — or null. Scanned
   * along the curves between the engine's wakes, then bisected.
   */
  crossing(target, dir, from, until) {
    const past = (v) => v != null && (dir > 0 ? v >= target - 1e-12 : v <= target + 1e-12); // prettier-ignore
    if (past(this.voltsAt(from))) return Math.max(from, this.#time);
    let a = Math.max(from, this.#time);
    for (let n = 0; n < MAX_WAKES; n++) {
      const wake = this.#result.wakeAt;
      const end = wake != null && wake > a ? Math.min(wake, until) : until;
      let lo = a;
      for (let k = 1; k <= SCAN_STEPS; k++) {
        const hi = a + ((end - a) * k) / SCAN_STEPS;
        if (!past(this.#read(hi))) {
          lo = hi;
          continue;
        }
        let top = hi;
        for (
          let i = 0;
          i < BISECTIONS && top - lo > 1e-15 * Math.max(1, top);
          i++
        ) {
          const mid = (lo + top) / 2;
          if (past(this.#read(mid))) top = mid;
          else lo = mid;
        }
        return top;
      }
      if (end >= until) return null;
      this.#tick(end);
      a = end;
      if (past(this.#read(a))) return a;
    }
    return null;
  }
}

/**
 * What a meter on a test function (Ω, continuity, diode) reads on the
 * switched-off bench once it has come to rest (`REST_S` on): `{volts}`
 * across its probes — 0 with both on one net (a short) — or null when it
 * reads nothing (a probe loose, another function).
 * @param {object} doc - a desk document
 * @param {string} meterId
 * @param {object} [config] - the Spice Lite setting
 * @returns {{volts: number}|null}
 */
export function offlineMeterReading(doc, meterId, config = { enabled: true }) {
  const meter = (doc.components ?? []).find((c) => c.id === meterId);
  if (!meter) return null;
  const setup = meterSetup(meter.params);
  if (!isSourceFunction(setup.fn) || setup.fn === "cap" || !setup.reads || !setup.element) return null; // prettier-ignore
  const run = new BenchRun(doc, meterId, config);
  const volts = run.voltsAt(REST_S, { arrived: null });
  return volts == null ? null : { volts };
}

/**
 * A capacitance measurement on the switched-off bench, as the meter makes
 * it: from rest it drives the probes down to −threshold, then up, timing the
 * swing to +threshold; a swing its range cannot finish in `CAP_TIMEOUT` of
 * its full scale's time moves it up a range (past the last, OL). Returns
 * `{farads, seconds}` — Infinity for OL; `seconds` how long the meter took,
 * from the touch — or null when it reads nothing.
 * @param {object} doc - a desk document
 * @param {string} meterId
 * @param {object} [config] - the Spice Lite setting
 * @returns {{farads: number, seconds: number}|null}
 */
export function measureCapacitance(doc, meterId, config = { enabled: true }) {
  const meter = (doc.components ?? []).find((c) => c.id === meterId);
  if (!meter) return null;
  const setup = meterSetup(meter.params);
  if (setup.fn !== "cap" || !setup.reads || !setup.element) return null;
  let range = 0;
  let sign = -1;
  const run = new BenchRun(doc, meterId, config, { range, sign });
  // A short has nothing to charge: no swing to time.
  if (!run.reads || run.shorted) return null;
  const vt = CAP_TEST.threshold;
  const last = CAP_FULL.length - 1;
  let t = 0;
  let from = null; // where the swing being timed began
  for (let guard = 0; guard < 4 * CAP_FULL.length + 4; guard++) {
    const limit = t + CAP_TIMEOUT * capSwingS(range);
    const at = run.crossing(sign * vt, sign, t, limit);
    if (at == null) {
      if (range === last) return { farads: Infinity, seconds: limit };
      range++;
      t = limit;
      from = null;
      run.drive({ range, sign }, t);
      continue;
    }
    if (from != null) {
      return { farads: (at - from) / (capOhms(range) * CAP_LOG), seconds: at };
    }
    from = at;
    sign = -sign;
    t = at;
    run.drive({ range, sign }, t);
  }
  return { farads: Infinity, seconds: t };
}
