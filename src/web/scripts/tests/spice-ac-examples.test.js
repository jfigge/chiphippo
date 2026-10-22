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

// The AC examples, proved: the SHIPPED desktops of the AC adapter's example
// (demos/adapter.chiphippo — Clipping, Zero crossing, Schmitt trigger) and
// the transformer's and the mains' (demos/transformer.chiphippo — Step-down)
// run under Spice
// Lite as SimController runs them — ticked at every wake, a switch thrown by
// rebuilding the netlist — and each is held to what its caption says, every
// figure computed from the parts' own values on the desk.
// engine-parity.test.js exempts them (to the logic engine every AC brick is
// nothing at all); this is their proof.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ENGINES } from "../sim/engines.js";
import { buildNetlist } from "../sim/netlist.js";
import { H, L } from "../sim/levels.js";
import { partPinAddresses } from "../model/occupancy.js";
import { mainsSineOf, transformerWindings } from "../catalog/ac-parts.js";
import { exampleDesktops } from "../model/example-desktops.js";

const DEMOS = fileURLToPath(new URL("../../demos/", import.meta.url));

/** One shipped example desktop's document, by part ref and desktop name. */
function exampleDoc(ref, name) {
  const payload = JSON.parse(readFileSync(`${DEMOS}${ref}.json`, "utf8"));
  const desk = exampleDesktops(ref, payload).find(
    (d) => d.name === `${ref} ${name} example`,
  );
  assert.ok(desk, `${ref} has a ${name} desktop`);
  return structuredClone(desk.doc);
}

/** The one part of `ref` on the desk (or the one whose params match). */
function only(doc, ref, match = () => true) {
  const found = doc.components.filter((c) => c.ref === ref && match(c));
  assert.equal(found.length, 1, `one ${ref}`);
  return found[0];
}

/** The address of a part's pin `n` (a seated part's hole, a brick's
    terminal). */
function pinOf(doc, comp, n) {
  return partPinAddresses(doc, comp).find((p) => p.pin === n).address;
}

/**
 * A desk run under Spice Lite the way SimController runs it: a tick at
 * every wake the engine asks for (these desks have no clock bricks — an AC
 * supply's sine is a function of time alone), a switch thrown a netlist
 * rebuilt and a tick at that moment.
 */
function spiceRun(doc) {
  const { tick } = ENGINES.spice;
  const build = () => buildNetlist(doc, new Map(), { inductors: "branch" });
  let netlist = build();
  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  let analog = null;
  let last = null;
  let now = 0;
  const run = (t) => {
    last = tick({
      document: doc,
      netlist,
      warmStart: warm,
      state,
      prevPinLevels: prev,
      clockPhase: new Map(),
      clockTimes: new Map(),
      signalLevels: new Map(),
      now: t,
      spice: { config: { enabled: true }, analog },
    });
    warm = last.netLevels;
    state = last.state;
    prev = last.pinLevels;
    analog = last.analog ?? null;
    now = t;
  };
  const netOf = (address) => netlist.netOfPoint.get(address);
  run(0);
  return {
    get result() {
      return last;
    },
    /** A slide switch thrown: what a doc change does. */
    set(id, params) {
      const comp = doc.components.find((c) => c.id === id);
      comp.params = { ...comp.params, ...params };
      netlist = build();
      run(now);
    },
    volts(address) {
      return last.nodeVolts.get(netOf(address));
    },
    level(address) {
      return last.netLevels.get(netOf(address));
    },
    lit(id) {
      return last.lamps.get(id)?.lit === true;
    },
    /** Run on to `until`, ticking at every wake; `each(t)` after each. */
    advance(until, each = null) {
      while (now < until) {
        run(Math.min(until, last.wakeAt ?? Infinity));
        each?.(now);
      }
    },
  };
}

/** The gaps between successive moments. */
const gaps = (ts) => ts.slice(1).map((t, i) => t - ts[i]);

const near = (got, want, tol, what) =>
  assert.ok(Math.abs(got - want) <= tol, `${what}: ${got}, want ${want} ±${tol}`); // prettier-ignore

/** A smoking or overdriven part, of the warnings a run raised. */
const HARM = new Set(["input-clamp", "input-overvoltage", "output-current", "led-burnt", "led-overdriven", "diode-burnt"]); // prettier-ignore

test("Clipping: 12 V~ through 10 kΩ and a Zener, squared at 60 Hz, counted down to 6 Hz and 1 Hz", () => {
  const doc = exampleDoc("adapter", "Clipping");
  // Fed by an AC adapter, its S2 on the ground rail.
  const ac = only(doc, "adapter");
  const zener = only(doc, "zener");
  const schmitt = only(doc, "74LS14");
  const yellow = only(doc, "led", (c) => c.params.color === "yellow");
  const green = only(doc, "led", (c) => c.params.color === "green");
  const hz = ac.params.hz;
  // The Zener's cathode is the node the 74LS14's first input sits on.
  const node = pinOf(doc, schmitt, 1);
  const out = pinOf(doc, schmitt, 2);

  const sim = spiceRun(doc);
  assert.equal(sim.volts(pinOf(doc, zener, 2)), sim.volts(node), "the Zener is on the input"); // prettier-ignore
  const harm = [];
  const rises = { out: [], yellow: [], green: [] };
  const was = { out: sim.level(out), yellow: sim.lit(yellow.id), green: sim.lit(green.id) }; // prettier-ignore
  const watch = (t) => {
    for (const w of sim.result.warnings) if (HARM.has(w.type)) harm.push(w);
    const now = { out: sim.level(out), yellow: sim.lit(yellow.id), green: sim.lit(green.id) }; // prettier-ignore
    if (now.out !== was.out && now.out === H) rises.out.push(t);
    if (now.yellow && !was.yellow) rises.yellow.push(t);
    if (now.green && !was.green) rises.green.push(t);
    Object.assign(was, now);
  };
  // Read the clip at the peaks themselves: the Zener's breakdown above,
  // its forward drop below.
  sim.advance(1 / (4 * hz), watch);
  const top = sim.volts(node);
  sim.advance(3 / (4 * hz), watch);
  const bottom = sim.volts(node);
  assert.ok(top > 4.3 && top < 5, `clipped near the Zener's 4.7 V: ${top}`);
  assert.ok(bottom > -0.7 && bottom < -0.4, `a diode drop below ground: ${bottom}`); // prettier-ignore
  sim.advance(2.1, watch);

  // The 74LS14 squares it: one rising edge a cycle, as steady as the sine.
  assert.ok(rises.out.length >= 2 * hz, `${rises.out.length} edges`);
  for (const g of gaps(rises.out)) near(g, 1 / hz, 1e-6, "the 74LS14's period");
  // ÷10 lights the yellow LED at 6 Hz, then ÷6 the green one at 1 Hz.
  assert.ok(rises.yellow.length >= 12);
  for (const g of gaps(rises.yellow)) near(g, 10 / hz, 1e-6, "the yellow LED's period"); // prettier-ignore
  assert.equal(rises.green.length, 2);
  near(
    gaps(rises.green)[0],
    60 / hz,
    1e-6,
    "the green LED's period: one second",
  );
  assert.deepEqual(harm, [], "nothing on the desk is harmed");
});

/**
 * The comparator desktops: the LM358's output and what sets its input —
 * the 100 kΩ from the adapter's S1 (R1), the 2.2 kΩ to the reference, the 22 kΩ
 * feedback (Rf) where there is one.
 */
function comparatorDesk(name) {
  const doc = exampleDoc("adapter", name);
  const amp = only(doc, "LM358");
  const adapter = only(doc, "adapter");
  const ohms = (n) => only(doc, "resistor", (c) => c.params.ohms === n);
  return {
    doc,
    out: pinOf(doc, amp, 1),
    inn: pinOf(doc, amp, 2),
    inp: pinOf(doc, amp, 3),
    s1: `${adapter.id}.S1`,
    s2: `${adapter.id}.S2`,
    r1: ohms(100e3).params.ohms,
    rf: doc.components.some((c) => c.params?.ohms === 22e3) ? ohms(22e3).params.ohms : null, // prettier-ignore
    led: only(doc, "led"),
    hz: adapter.params.hz,
  };
}

test("Zero crossing: one flip per crossing, and the LED at a tenth of them", () => {
  const desk = comparatorDesk("Zero crossing");
  assert.equal(desk.rf, null, "no feedback");
  const sim = spiceRun(desk.doc);
  const per = new Map();
  const ledRises = [];
  let level = sim.level(desk.out);
  let lit = sim.lit(desk.led.id);
  sim.advance(30 / desk.hz, (t) => {
    const now = sim.level(desk.out);
    if (now !== level) {
      const k = Math.round(t * 2 * desk.hz);
      per.set(k, (per.get(k) ?? 0) + 1);
      level = now;
    }
    const on = sim.lit(desk.led.id);
    if (on && !lit) ledRises.push(t);
    lit = on;
  });
  // Every crossing after the first (Run starts the sine on one).
  const counts = [...per].filter(([k]) => k > 0).map(([, n]) => n);
  assert.ok(counts.length >= 58, `${counts.length} crossings`);
  assert.ok(
    counts.every((n) => n === 1),
    `one flip each: ${counts}`,
  );
  // ÷10 of 120 flips a second: the LED at 6 Hz.
  for (const g of gaps(ledRises)) near(g, 10 / desk.hz, 1e-4, "the LED's period"); // prettier-ignore
});

test("Schmitt trigger: one flip per half cycle, where the band says", () => {
  const desk = comparatorDesk("Schmitt trigger");
  assert.ok(desk.rf, "a feedback resistor");
  const sim = spiceRun(desk.doc);
  const flips = [];
  let level = sim.level(desk.out);
  let before = sim.volts(desk.out);
  sim.advance(30 / desk.hz, (t) => {
    const now = sim.level(desk.out);
    if (now !== level) {
      // The secondary at the flip, and the output it flipped from.
      flips.push({ t, to: now, sec: sim.volts(desk.s1) - sim.volts(desk.s2), from: before, ref: sim.volts(desk.inn) }); // prettier-ignore
      level = now;
    }
    before = sim.volts(desk.out);
  });
  assert.ok(flips.length >= 59, `${flips.length} flips`);
  // Strictly alternating, one each half cycle.
  for (let i = 1; i < flips.length; i++) {
    assert.notEqual(flips[i].to, flips[i - 1].to);
    near(flips[i].t - flips[i - 1].t, 1 / (2 * desk.hz), 0.25 / desk.hz, "half a cycle apart"); // prettier-ignore
  }
  // The band is the resistors': IN+ meets the reference when
  // (S1 − S2)/R1 + (out − ref)/Rf = 0 — the 2.2 kΩ to the reference
  // carries nothing there.
  for (const f of flips.slice(2)) {
    const want = (-(f.from - f.ref) * desk.r1) / desk.rf;
    near(f.sec, want, 0.02 * Math.abs(want), `the threshold flipping ${f.to}`);
  }
  // About ±8 V on the secondary, as the caption says.
  const lows = flips.filter((f) => f.to === L).map((f) => f.sec);
  const highs = flips.filter((f) => f.to === H).map((f) => f.sec);
  assert.ok(
    lows.every((v) => v < -7 && v > -9),
    `falling at ${lows[0]}`,
  );
  assert.ok(
    highs.every((v) => v > 7 && v < 9),
    `rising at ${highs[0]}`,
  );
});

test("Step-down: 120 V~ to ±17 V, sagging about a tenth when the switch adds 10 Ω", () => {
  const doc = exampleDoc("transformer", "Step-down");
  const xfmr = only(doc, "transformer");
  const ac = only(doc, "ac");
  const sw = only(doc, "sw-slide");
  const loads = doc.components.filter((c) => c.ref === "resistor").map((c) => c.params.ohms); // prettier-ignore
  assert.deepEqual(
    loads.sort((a, b) => a - b),
    [10, 100],
  );
  const s1 = `${xfmr.id}.S1`;
  const s2 = `${xfmr.id}.S2`;
  const hz = ac.params.hz;

  // The phasor answer of the two coupled coils across a load.
  const w = transformerWindings(xfmr.params);
  const om = 2 * Math.PI * hz;
  const phasor = (load) => {
    // V = Z1·I1 + Zm·I2, 0 = Zm·I1 + Z2·I2 → |V2| = |Zm·V·RL / (Z1·Z2 − Zm²)|.
    const [a, b] = [w.primary.ohms, om * w.primary.henries];
    const [c, d] = [w.secondary.ohms + load, om * w.secondary.henries];
    const m = om * w.mutual;
    const re = a * c - b * d + m * m;
    const im = a * d + b * c;
    return (m * mainsSineOf(ac.params).peak * load) / Math.hypot(re, im);
  };

  const sim = spiceRun(doc);
  // Half the peak-to-peak over a whole cycle, read at 480 ticks a cycle:
  // the magnetising current's offset (τ = L1/R1, 0.2 s) cancels out.
  const amplitude = (from) => {
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = 1; k <= 480; k++) {
      sim.advance(from + k / (480 * hz));
      const v = sim.volts(s1) - sim.volts(s2);
      hi = Math.max(hi, v);
      lo = Math.min(lo, v);
    }
    return (hi - lo) / 2;
  };
  sim.advance(1);
  const alone = amplitude(1);
  near(alone, phasor(100), 5e-4 * alone, "across 100 Ω");
  near(alone, 16.6, 0.05, "the ±17 V the caption quotes");
  // Position 2 puts the 10 Ω beside the 100 Ω.
  sim.set(sw.id, { pos: "2" });
  sim.advance(2);
  const both = amplitude(2);
  near(
    both,
    phasor(1 / (1 / 100 + 1 / 10)),
    5e-4 * both,
    "across 100 Ω ∥ 10 Ω",
  );
  near(both / alone, 0.91, 0.01, "sagging about a tenth");
});
