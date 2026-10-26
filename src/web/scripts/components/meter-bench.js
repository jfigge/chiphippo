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
// document last changed, run on the wall clock (`PUMP_MS` a reading, the
// run's own display rate) until it comes to rest, and handed to its view
// (`setOffline`); the LEDs it lights go to the desk (`onLamps`). Not the
// run's engine: it answers from the current document while nothing runs,
// as the Properties card's Timing row does.
//
// The beeper is Web Audio's, a few milliseconds of a square at a buzzer's
// pitch while any meter whose Sound is on beeps (continuity, Beep-Jack, a
// REC record). Its context is made the first time there is something to
// hear — a click put the meter there, so the browser lets it start — and
// suspended between.

import { isSourceFunction, meterSetup } from "../catalog/meter.js";
import { GAP_PERCENT } from "../sim/spice/config.js";
import { BenchRun, measureCapacitance } from "../sim/meter-offline.js";

/** How long after the last change the stopped bench is started again, ms. */
const SETTLE_MS = 120;

/** How often a bench in motion is read, ms: the display's own rate
    (components/sim-controller.js METER_UPDATE_MS). */
const PUMP_MS = 200;

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
  #config = { enabled: true };
  // meter id → its stopped bench: `{run, started}` (Ω, continuity, diode —
  // a BenchRun) or `{cap, started}` (capacitance — measureCapacitance's).
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
      this.refresh();
    });
  }

  /** Spice Lite on or off (its setting, `{enabled, …}`). */
  setSpiceLite(on, config = null) {
    this.#spiceLite = on === true;
    if (config) this.#config = { ...config, enabled: true };
    this.refresh();
  }

  /** Start the stopped bench again, soon. */
  refresh() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#start(), SETTLE_MS);
  }

  /** Every meter on a test function gets a bench of its own, from now. */
  #start() {
    this.#timer = null;
    this.#benches = new Map();
    const doc = this.#doc.toJSON();
    const started = performance.now();
    for (const comp of doc.components ?? []) {
      if (comp.kind !== "meter") continue;
      const view = this.#views.get(comp.id);
      if (!view?.setOffline) continue;
      const { fn } = meterSetup(comp.params);
      if (!this.#spiceLite || !this.#stopped || !isSourceFunction(fn)) {
        view.setOffline(null);
        continue;
      }
      try {
        if (fn === "cap") {
          const cap = measureCapacitance(doc, comp.id, this.#config);
          this.#benches.set(comp.id, { cap, started });
        } else {
          const run = new BenchRun(doc, comp.id, this.#config);
          this.#benches.set(comp.id, { run: run.reads ? run : null, started });
        }
      } catch (err) {
        console.error("[renderer] meter reading failed:", err);
        view.setOffline(null);
      }
    }
    this.#read();
  }

  /** Each bench as it stands now; read again in PUMP_MS while any moves. */
  #read() {
    clearTimeout(this.#pump);
    this.#pump = null;
    const now = performance.now();
    let moving = false;
    const lamps = new Map();
    for (const [id, bench] of this.#benches) {
      const view = this.#views.get(id);
      const t = (now - bench.started) / 1000;
      if (bench.cap !== undefined) {
        // Shown once the meter has had the time it takes to measure.
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
    this.#onLamps?.(lamps.size ? lamps : null);
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
