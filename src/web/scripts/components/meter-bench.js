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

// meter-bench.js — the multimeters on a STOPPED bench, and their beepers.
//
// Stopped, the bench is switched off: nothing runs, so a meter on ohms,
// continuity, diode test or capacitance reads the unpowered circuit with
// its own test source (sim/meter-offline.js) — and reads it IN TIME, from
// the moment the bench last changed: across a capacitor the ohms reading
// climbs as the test current charges it, an LED on the diode test glows
// faintly with it, and a capacitance shows `----` for as long as the meter
// takes to time it. Each meter's bench is started again a moment after the
// document last changed — only where the change could move its reading
// (sim/meter-offline.js `OffBench`: the switched-off desk and its one
// netlist, shared by every meter, and `benchKey`, what the probes reach): a
// supply put down, another meter, a part on a strip it does not reach leave
// a reading as it stands — then run on the wall clock (`PUMP_MS` a reading,
// the run's own display rate) until it comes to rest, and handed to its
// view (`setOffline`); the LEDs it lights go to the desk (`onLamps`). A
// capacitance is timed in slices of `SLICE_MS` between the page's own work.
// Not the run's engine: it answers from the current document while nothing
// runs, as the Properties card's Timing row does.
//
// The beeper is Web Audio's, a few milliseconds of a square at a buzzer's
// pitch while any meter whose Sound is on beeps (continuity, Beep-Jack, a
// REC record). Its context is made the first time there is something to
// hear — a click put the meter there, so the browser lets it start — and
// suspended between.

import { isShunt, isSourceFunction, meterSetup } from "../catalog/meter.js";
import { GAP_PERCENT } from "../sim/spice/config.js";
import { BenchRun, OffBench, capacitanceSteps } from "../sim/meter-offline.js";

/** How long after the last change the stopped bench is started again, ms. */
const SETTLE_MS = 120;

/** How often a bench in motion is read, ms: the display's own rate
    (components/sim-controller.js METER_UPDATE_MS). */
const PUMP_MS = 200;

/** How long a capacitance measurement works before the page gets its turn,
    ms (a busy bench's timing is a tenth of a second and more of solves). */
const SLICE_MS = 8;

/** The beeper's pitch, Hz (an assumption — the manual gives none), and its
    loudness, as a gain. */
const BEEP_HZ = 2700;
const BEEP_GAIN = 0.05;

/** A short beep's length, ms (REC's new MAX or MIN). */
const CHIRP_MS = 80;

export class MeterBench {
  #doc;
  #views;
  #onLamps;
  #spiceLite = false;
  #stopped = true;
  #timer = null;
  #pump = null;
  #slice = null; // the timer of the next capacitance slice
  #config = { enabled: true };
  // meter id → its stopped bench: `{run, started, own, desk, key}` (Ω,
  // continuity, diode — a BenchRun) or `{cap, steps, started, own, desk,
  // key}` (capacitance — the measurement once made, `capacitanceSteps`
  // while it is being); `own`, `desk` and `key` what it stands on.
  #benches = new Map();
  #beeping = new Set(); // meter ids beeping now
  #chirps = new Set(); // meter ids sounding a short beep
  #audio = null; // {ctx, osc, gain} once something has been heard

  /**
   * @param {object} doc - the DeskDoc
   * @param {Map<string, object>} views - component id → its view
   * @param {{onLamps?: (lamps: Map|null) => void}} [callbacks] - the LEDs
   *   the stopped benches light (spice/lamps.js verdicts), or null for none
   */
  constructor(doc, views, { onLamps } = {}) {
    this.#doc = doc;
    this.#views = views;
    this.#onLamps = onLamps ?? null;
    window.addEventListener("chiphippo:doc-changed", () => this.refresh());
    window.addEventListener("chiphippo:sim-state", (e) => {
      const stopped = e.detail?.running !== true;
      if (stopped === this.#stopped) return;
      this.#stopped = stopped;
      this.#benches = new Map(); // a bench switched on and off again: anew
      this.refresh();
    });
  }

  /** Spice Lite on or off (its setting, `{enabled, …}`). */
  setSpiceLite(on, config = null) {
    const was = this.#spiceLite;
    this.#spiceLite = on === true;
    if (config) this.#config = { ...config, enabled: true };
    if (config || was !== this.#spiceLite) this.#benches = new Map();
    this.refresh();
  }

  /** Start the stopped bench again, soon. */
  refresh() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#start(), SETTLE_MS);
  }

  /** Every meter on a test function gets a bench of its own, from now —
      or keeps the one it has, where nothing it stands on changed. */
  #start() {
    this.#timer = null;
    clearTimeout(this.#slice);
    this.#slice = null;
    const kept = this.#benches;
    this.#benches = new Map();
    const doc = this.#doc.toJSON();
    const started = performance.now();
    let off = null; // the switched-off desk, shared — made when first needed
    for (const comp of doc.components ?? []) {
      if (comp.kind !== "meter") continue;
      const view = this.#views.get(comp.id);
      if (!view?.setOffline) continue;
      const setup = meterSetup(comp.params);
      const { fn } = setup;
      if (!this.#spiceLite || !this.#stopped || !isSourceFunction(fn)) {
        view.setOffline(null);
        continue;
      }
      try {
        off ??= new OffBench(doc);
        // The same desk and setting, or the same parts reached on the same
        // nets: the same bench, run on from where it is.
        const own = JSON.stringify(comp.params);
        const old = kept.get(comp.id);
        if (old && old.own === own && old.desk === off.key) {
          this.#benches.set(comp.id, old);
          continue;
        }
        const key = off.benchKey(comp);
        if (old?.key === key) {
          this.#benches.set(comp.id, { ...old, own, desk: off.key });
          continue;
        }
        // (A shunt — a lead in a current jack — is a point of its own
        // netlist the shared one has not got.)
        const bench = isShunt(setup.element) ? null : off;
        const at = { started, own, desk: off.key, key };
        if (fn === "cap") {
          const steps = capacitanceSteps(doc, comp.id, this.#config, { bench }); // prettier-ignore
          this.#benches.set(comp.id, { ...at, cap: null, steps });
        } else {
          // Its first tick in a slice of its own (`warm`, run by
          // #runSlices): on a busy desk it is ~10 ms, and three meters an
          // edit reached were one 30 ms task.
          const run = new BenchRun(doc, comp.id, this.#config, null, { bench }); // prettier-ignore
          const reads = run.reads && !run.shorted;
          this.#benches.set(comp.id, { ...at, run: run.reads ? run : null, warm: reads ? run.advanceSteps(0) : null }); // prettier-ignore
        }
      } catch (err) {
        console.error("[renderer] meter reading failed:", err);
        view.setOffline(null);
      }
    }
    // (The slices from the next task: this one has built the benches.)
    if ([...this.#benches.values()].some((b) => b.warm || b.steps)) this.#slice = setTimeout(() => this.#runSlices(), 0); // prettier-ignore
    this.#read();
  }

  /** The capacitance measurements under way, and each new bench's first
      tick, `SLICE_MS` of work at a time and then the page's turn; a reading
      again when one is done. */
  #runSlices() {
    clearTimeout(this.#slice);
    this.#slice = null;
    const until = performance.now() + SLICE_MS;
    let left = false;
    let done = false;
    for (const bench of this.#benches.values()) {
      if (bench.warm) {
        try {
          while (performance.now() < until) {
            if (!bench.warm.next().done) continue;
            bench.warm = null;
            done = true;
            break;
          }
        } catch (err) {
          console.error("[renderer] meter reading failed:", err);
          bench.run = null;
          bench.warm = null;
          done = true;
        }
        if (bench.warm) left = true;
        continue;
      }
      if (!bench.steps) continue;
      try {
        while (performance.now() < until) {
          const step = bench.steps.next();
          if (!step.done) continue;
          bench.cap = step.value;
          bench.steps = null;
          done = true;
          break;
        }
      } catch (err) {
        console.error("[renderer] meter reading failed:", err);
        bench.cap = null;
        bench.steps = null;
        done = true;
      }
      if (bench.steps) left = true;
    }
    if (left) this.#slice = setTimeout(() => this.#runSlices(), 0);
    if (done) this.#read();
  }

  /** Each bench as it stands now; read again in PUMP_MS while any moves. */
  #read() {
    clearTimeout(this.#pump);
    this.#pump = null;
    const now = performance.now();
    let moving = false;
    let warming = false;
    const lamps = new Map();
    for (const [id, bench] of this.#benches) {
      const view = this.#views.get(id);
      const t = (now - bench.started) / 1000;
      // Its first tick still to come (#runSlices): the display stands as it
      // is until then, and so do the LEDs.
      if (bench.warm) {
        warming = true;
        continue;
      }
      if (bench.cap !== undefined) {
        // Shown once the meter has had the time it takes to measure (`----`
        // while it is still being timed).
        if (bench.steps) {
          view?.setOffline({ farads: null });
          continue;
        }
        const done = !bench.cap || t >= bench.cap.seconds;
        view?.setOffline(bench.cap ? { farads: done ? bench.cap.farads : null } : null); // prettier-ignore
        if (!done) moving = true;
        continue;
      }
      if (!bench.run) {
        view?.setOffline(null);
        continue;
      }
      let volts = null;
      try {
        volts = bench.run.voltsAt(t, { arrived: GAP_PERCENT });
      } catch (err) {
        console.error("[renderer] meter reading failed:", err);
      }
      view?.setOffline(volts == null ? null : { volts });
      for (const [key, lamp] of bench.run.lamps ?? []) {
        if (lamp?.lit) lamps.set(key, lamp);
      }
      if (!bench.run.settled) moving = true;
    }
    if (!warming) this.#onLamps?.(lamps.size ? lamps : null);
    if (moving) this.#pump = setTimeout(() => this.#read(), PUMP_MS);
  }

  /**
   * A meter's beeper on or off (its view's `onBeep`); heard only while its
   * Sound is on.
   * @param {string} id
   * @param {boolean} on
   */
  beep(id, on) {
    const sound = this.#doc.getComponent(id)?.params?.sound === "on";
    if (on && sound) this.#beeping.add(id);
    else this.#beeping.delete(id);
    this.#sound(this.#beeping.size + this.#chirps.size > 0);
  }

  /** A short beep from a meter whose Sound is on (REC's new MAX or MIN). */
  chirp(id) {
    if (this.#doc.getComponent(id)?.params?.sound !== "on") return;
    this.#chirps.add(id);
    this.#sound(true);
    setTimeout(() => {
      this.#chirps.delete(id);
      this.#sound(this.#beeping.size + this.#chirps.size > 0);
    }, CHIRP_MS);
  }

  #sound(on) {
    if (!on && !this.#audio) return;
    if (!this.#audio) {
      const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!Context) return;
      const ctx = new Context();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = BEEP_HZ;
      gain.gain.value = 0;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      this.#audio = { ctx, osc, gain };
    }
    const { ctx, gain } = this.#audio;
    gain.gain.setTargetAtTime(on ? BEEP_GAIN : 0, ctx.currentTime, 0.003);
    if (on) ctx.resume?.();
    else setTimeout(() => this.#beeping.size + this.#chirps.size || ctx.suspend?.(), 50); // prettier-ignore
  }
}
