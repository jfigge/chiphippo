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

// lamp-average.js — how bright each LED LOOKS over a frame: its brightness
// averaged over the simulated time the frame covers. Pure and DOM-free;
// SimController records every tick and takes the average each time it
// publishes.
//
// The desk is redrawn some 25 times a second, and the run ticks far more
// often than that: a 250 Hz PWM clock is 500 edges a second. Shown as the
// last tick left it, an LED on that clock was ON or OFF frame by frame — a
// flicker — where a bench LED looks steadily dim, because the eye averages
// what it sees. So a frame shows each lamp's average: brightness × the time
// each tick held it, over the time since the last frame. An LED that did not
// change in a frame averages to exactly what it was — a slow blink still
// blinks, and a steady desk draws as it always did.
//
// A desk with nothing moving publishes only when something changes, so the
// frame after a switch is thrown averages mostly the time BEFORE it. A frame
// that shows an average is therefore always followed by one more
// (SimController's #glowShown), which takes none and shows the lamps as they
// stand.
//
// Brightness is a lamp's `level` under Spice Lite (its current against its
// datasheet's, spice/lamps.js) while lit, and 1 while lit on the digital
// engine (sim/junction.js's rule over the levels), 0 while dark.

import { partDef } from "../catalog/index.js";
import { partPinAddresses } from "../model/occupancy.js";
import { isLit, junctionState } from "./junction.js";
import { junctionKey } from "./spice/lamps.js";

/** Every LED's and display segment's junction on a desk, by its pins'
    addresses: `[{key, anodeAt, cathodeAt}]`. */
export function lampJunctions(doc) {
  const out = [];
  for (const comp of doc.components ?? []) {
    const def = partDef(comp.ref);
    if (!def) continue;
    const isLed = comp.ref === "led";
    if (!isLed && !def.segments) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const at = (pin) => pins.find((p) => p.pin === pin)?.address ?? null;
    if (isLed) {
      const { anodePin, cathodePin } = def.polarity(comp.params);
      out.push({ key: junctionKey(comp.id), anodeAt: at(anodePin), cathodeAt: at(cathodePin) }); // prettier-ignore
    } else {
      for (const seg of def.segments) {
        out.push({ key: junctionKey(comp.id, seg.id), anodeAt: at(seg.anodePin), cathodeAt: at(seg.cathodePin) }); // prettier-ignore
      }
    }
  }
  return out;
}

/**
 * Each lamp's brightness on one tick: key → 0 (dark) or how bright. Spice
 * Lite's from its lamps; the digital engine's by the junction rule, as the
 * desk lights it (components/sim-overlay.js).
 * @param {Array<{key: string, anodeAt: string|null, cathodeAt: string|null}>} junctions
 * @param {{netOfPoint: Map}} netlist - the tick's
 * @param {object} result - the tick's
 * @returns {Map<string, number>}
 */
export function lampBrightness(junctions, netlist, result) {
  const out = new Map();
  if (result.lamps) {
    for (const { key } of junctions) {
      const v = result.lamps.get(key);
      out.set(key, v?.lit ? Math.max(0, v.level ?? 0) : 0);
    }
    // A character LCD's backlight is a lamp of Spice Lite's too.
    for (const [key, v] of result.lamps) {
      if (!out.has(key)) out.set(key, v?.lit ? Math.max(0, v.level ?? 0) : 0);
    }
    return out;
  }
  const levels = result.netLevels ?? new Map();
  const strong = result.strongLevels ?? new Map();
  const net = (at) => (at ? netlist.netOfPoint.get(at) : null);
  for (const { key, anodeAt, cathodeAt } of junctions) {
    if (!anodeAt || !cathodeAt) {
      out.set(key, 0);
      continue;
    }
    const [a, k] = [net(anodeAt), net(cathodeAt)];
    const state = junctionState({
      anode: levels.get(a) ?? null,
      cathode: levels.get(k) ?? null,
      anodeStrong: strong.get(a) ?? null,
      cathodeStrong: strong.get(k) ?? null,
    });
    out.set(key, isLit(state) ? 1 : 0);
  }
  return out;
}

/** Each lamp's brightness, time-averaged between frames (see the header). */
export class LampAverage {
  #from = null; // where the window began, seconds
  #at = null; // when the brightness held now began
  #now = null; // key → brightness, as the last tick left it
  #sums = new Map(); // key → ∫ brightness dt over the window
  #varied = false; // whether anything changed inside the window

  /** Forget everything (a Run, a Stop). */
  reset() {
    this.#from = null;
    this.#at = null;
    this.#now = null;
    this.#sums = new Map();
    this.#varied = false;
  }

  /** The window so far as plain data (a run handed to another thread). */
  export() {
    return { from: this.#from, at: this.#at, now: this.#now && new Map(this.#now), sums: new Map(this.#sums), varied: this.#varied }; // prettier-ignore
  }

  /** A window exactly as `export` gave it: the next frame averages the
      time before the hand-over too — begun empty there, it covered none,
      and a PWM-driven LED showed its bare tick for a frame. */
  import(data) {
    this.#from = data?.from ?? null;
    this.#at = data?.at ?? null;
    this.#now = data?.now ? new Map(data.now) : null;
    this.#sums = new Map(data?.sums ?? []);
    this.#varied = data?.varied === true;
  }

  /** Book what was held from the last moment to `t`. */
  #hold(t) {
    if (!this.#now || this.#at == null) return;
    const dt = t - Math.max(this.#at, this.#from);
    if (dt > 0) {
      for (const [key, b] of this.#now) {
        this.#sums.set(key, (this.#sums.get(key) ?? 0) + b * dt);
      }
    }
    if (t > this.#at) this.#at = t;
  }

  /**
   * A tick's lamps at `at`, seconds.
   * @param {number} at
   * @param {Map<string, number>} brightness - `lampBrightness`'s
   */
  record(at, brightness) {
    if (this.#from == null) this.#from = at;
    this.#hold(at);
    if (this.#now && !this.#varied) {
      for (const [key, b] of brightness) {
        if ((this.#now.get(key) ?? 0) !== b) {
          this.#varied = true;
          break;
        }
      }
    }
    this.#now = brightness;
    this.#at = Math.max(at, this.#at ?? at);
  }

  /**
   * The window's averages up to `until`, and a new window from there: key →
   * mean brightness — or null when nothing changed in it, or it covers no
   * time (a frame shows the last tick then, as it always did).
   * @param {number} until - seconds
   * @returns {Map<string, number>|null}
   */
  take(until) {
    if (this.#from == null || !this.#now) return null;
    this.#hold(until);
    const span = until - this.#from;
    const varied = this.#varied;
    const sums = this.#sums;
    this.#sums = new Map();
    this.#varied = false;
    if (!(span > 0) || !varied) {
      if (until > this.#from) this.#from = until;
      return null;
    }
    this.#from = until;
    const out = new Map();
    for (const key of this.#now.keys()) out.set(key, (sums.get(key) ?? 0) / span); // prettier-ignore
    return out;
  }
}
