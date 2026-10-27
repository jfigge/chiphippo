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

// spice-speaker.test.js — the speaker under Spice Lite: the voltage across
// it timed into the tone it plays (spice/measure.js `noteTone`, spice/
// speakers.js), held to the 555 driving it — its own measured readout, the
// same edges — at a rate the desk steps edge by edge and at rates drawn by
// their schedule; its loudness to the power its swing puts in its coil;
// silence where there is no tone; and its coil's heat — a warning past its
// 0.5 W, burnt open in smoke at twice it.

import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ENGINES } from "../sim/engines.js";
import { buildNetlist } from "../sim/netlist.js";
import { H, L } from "../sim/levels.js";
import { exampleDesktops } from "../model/example-desktops.js";
import { TONE_MIN_VPP, TONE_WINDOW_S, noteTone, toneOf } from "../sim/spice/measure.js"; // prettier-ignore
import {
  SPEAKER_HEAT_TAU_S,
  coilMeanWatts,
  noteCoil,
  speakerBurnIn,
  speakerHeatAfter,
  speakerReadIn,
  speakerTones,
  squareArea,
  toneKey,
} from "../sim/spice/speakers.js";
import { SPEAKER_FULL_W, SPEAKER_RATED_W, SPEAKER_SMOKE_W, speakerLoudness, speakerParams } from "../catalog/speaker.js"; // prettier-ignore
import { partDef } from "../catalog/index.js";
import { astable555, bench, runner } from "./timing-fixtures.js";
import { MIN_SHOWN_S } from "../sim/timing.js";
import { driveSpice } from "../bench/drive-spice.js";

/**
 * A 555 astable (RA, RB, C) whose OUT drives a speaker through `series` Ω
 * and a `coupling` capacitor (+ to the 555's side) — the example's circuit —
 * or, with `coupling` null, straight through the resistor.
 */
function toneBench({
  ra = 1e3,
  rb = 15e3,
  c = 100e-9,
  series = 47,
  coupling = 100e-6,
  impedance = 8,
  reset = true,
} = {}) {
  // prettier-ignore
  const { doc, b, u } = astable555({ ra, rb, c, reset });
  // (`series` null: no resistor, OUT straight on.)
  let from = u.get(3);
  if (series != null) {
    const r = b.seat("r3", "resistor", "a55", { ohms: series });
    b.link(r.get(1), u.get(3));
    from = r.get(2);
  }
  const sp = b.seat("ls1", "speaker", "a60", { impedance });
  if (coupling) {
    const cc = b.seat("c3", "cap-electrolytic", "a5", { farads: coupling });
    b.link(cc.get(1), from);
    b.link(sp.get(1), cc.get(2));
  } else b.link(sp.get(1), from);
  b.gnd(sp.get(2));
  return { doc, b, u };
}

/** Run a desk to `until`, ticking at every wake — no sooner than
    MIN_SHOWN_S after the last tick, as SimController does, so a tick spans
    the crossings a fast cycle is recognised by — and every frame it asks
    for; `signals(t)` the signal levels at `t`. The last result. */
function runTo(sim, until, signals = () => new Map()) {
  let r = sim.run(0, signals(0)).result;
  let t = 0;
  for (let n = 0; n < 50000; n++) {
    const next = r.wakeAt != null ? Math.max(r.wakeAt, t + MIN_SHOWN_S) : r.frameAt; // prettier-ignore
    if (next == null || next > until) break;
    t = Math.max(next, t + 1e-7);
    r = sim.run(t, signals(t)).result;
  }
  return sim.run(until, signals(until)).result;
}

const spice = (doc) => runner(doc, { engine: "spice", spice: {} });

const close = (actual, expected, rel, what) =>
  assert.ok(
    Math.abs(actual - expected) <= Math.abs(expected) * rel,
    `${what}: ${actual} vs ${expected}`,
  );

test("a speaker on a 555 plays the 555's own rate — stepped edge by edge, and drawn by its schedule", () => {
  // ~456 Hz (stepped), ~4.6 kHz and ~20 kHz (past the desk's 1 kHz, drawn).
  for (const c of [100e-9, 10e-9, 2.2e-9]) {
    const { doc } = toneBench({ c });
    const r = runTo(spice(doc), c < 5e-9 ? 0.06 : 0.2);
    const tone = r.tones.get("ls1");
    assert.ok(tone, `${c} F: it plays`);
    // Past ~2.5 kHz a tick spans whole cycles, and the 555's is drawn.
    assert.equal(r.analog.cycles.size > 0, c < 50e-9, `${c} F: drawn`);
    const rate = r.timing.get("u1").sections[0].frequency;
    close(tone.hz, rate, 1e-9, `${c} F: the 555's measured rate`);
    close(tone.hz, 1.44 / ((1e3 + 2 * 15e3) * c), 0.05, `${c} F: the sheet's rate`); // prettier-ignore
    // Its coil gets a square's power: half the swing, squared, over 8 Ω.
    close(tone.watts, (tone.vpp / 2) ** 2 / 8, 1e-12, `${c} F: watts`);
    assert.equal(tone.volume, 50);
    assert.deepEqual(r.warnings, []);
  }
});

test("a 555 straight through 100 µF into 8 Ω plays: the surge at Run is forgotten", () => {
  // No series resistor: at Run OUT's step puts 2.5 V across the coil while
  // the capacitor charges, and taken as the swing that set its middle so
  // high the ±0.4 V tone after it never crossed it — silent for the whole
  // run, for 47–220 µF alike.
  for (const coupling of [47e-6, 100e-6, 220e-6]) {
    const r = runTo(spice(toneBench({ series: null, coupling }).doc), 0.3);
    const tone = r.tones.get("ls1");
    assert.ok(tone, `${coupling} F: it plays`);
    close(tone.hz, r.timing.get("u1").sections[0].frequency, 1e-9, `${coupling} F: the 555's rate`); // prettier-ignore
    assert.ok(tone.vpp > 0.5 && tone.vpp < 2, `${coupling} F: ${tone.vpp} V p-p`); // prettier-ignore
  }
});

test("noteTone: before it has a period, a swing older than TONE_WINDOW_S is forgotten", () => {
  const tones = new Map();
  const key = toneKey("s1");
  // A surge to 2.5 V at Run, gone in 5 ms; then ±0.4 V at 500 Hz.
  for (let k = 0; k <= 50; k++) noteTone(tones, key, 2.5 * Math.exp(-k / 10), k * 1e-4); // prettier-ignore
  const at = (t) => 0.4 * Math.sin(2 * Math.PI * 500 * t);
  let heard = null;
  for (let k = 0; k <= 4000; k++) {
    const t = 0.005 + k * 1e-4;
    noteTone(tones, key, at(t), t);
    if (heard == null && toneOf(tones.get(key), t)) heard = t;
  }
  assert.ok(
    heard != null && heard < TONE_WINDOW_S + 0.01,
    `heard at ${heard} s`,
  );
  close(toneOf(tones.get(key), 0.405).hz, 500, 1e-6, "its rate");
  close(toneOf(tones.get(key), 0.405).vpp, 0.8, 0.01, "its swing");
});

test("the swing across it is the 555's step, divided between the resistor and the coil", () => {
  const { doc } = toneBench();
  const r = runTo(spice(doc), 0.3);
  const tone = r.tones.get("ls1");
  // Through 100 µF (τ = 55 Ω · 100 µF = 5.5 ms, 2.5 half-periods), the
  // speaker sees most of each edge: 8/(47 + 8) of a 3–3.5 V step, a little
  // sagged.
  assert.ok(tone.vpp > 0.4 && tone.vpp < 0.6, `${tone.vpp} V p-p`);
  // DC-coupled through 220 Ω, the whole of each step, never below 0.
  const dc = runTo(spice(toneBench({ coupling: null, series: 220 }).doc), 0.2);
  const t = dc.tones.get("ls1");
  close(t.hz, tone.hz, 1e-6, "the same rate");
  assert.ok(t.vpp > 0.08 && t.vpp < 0.14, `${t.vpp} V p-p`);
});

test("its impedance takes its share of the step, and its power from it", () => {
  const eight = runTo(spice(toneBench().doc), 0.3).tones.get("ls1");
  const thirtyTwo = runTo(spice(toneBench({ impedance: 32 }).doc), 0.3).tones.get("ls1"); // prettier-ignore
  // 32/(47 + 32) of each step against 8/(47 + 8) (the 555's own output
  // resistance aside, and the coupling's sag a little less).
  close(thirtyTwo.vpp / eight.vpp, 32 / 79 / (8 / 55), 0.06, "the divider");
  close(thirtyTwo.watts, (thirtyTwo.vpp / 2) ** 2 / 32, 1e-12, "its power");
});

test("a smooth drive is heard at its crests, not where its clock's edges fall", () => {
  // A sine clock through a coupling capacitor into the speaker: what crosses
  // it is the sine's slope, a quarter period out of step with the edges the
  // desk settles at — read only there it read nothing at 440 Hz, and a
  // fraction of its swing at 1 kHz.
  for (const [hz, farads] of [
    [440, 1e-6],
    [1000, 4.7e-6],
  ]) {
    const b = bench();
    b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: partDef("clock").normalizeParams({ hz, wave: "sine" }) }); // prettier-ignore
    b.doc.wires.push(
      { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
      { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
      { id: "wc3", from: "clk1.out", to: b.at("a5"), color: "blue" },
    );
    const sp = b.seat("ls1", "speaker", "a20", {});
    const c = b.seat("c1", "cap-electrolytic", "c5", { farads });
    b.link(c.get(2), sp.get(1));
    b.gnd(sp.get(2));
    const tone = driveSpice(b.doc, { seconds: 0.05, end: true }).result.tones.get("ls1"); // prettier-ignore
    assert.ok(tone, `${hz} Hz: heard`);
    close(tone.hz, hz, 1e-6, `${hz} Hz: its pitch`);
    // A 5 V swing high-passed at 1/(2π·8 Ω·C).
    const x = 2 * Math.PI * hz * 8 * farads;
    close(tone.vpp, (5 * x) / Math.hypot(1, x), 0.03, `${hz} Hz: its swing`);
  }
});

test("a speaker with no tone across it is silent: an oscillator held in reset, one stopped", () => {
  // RESET grounded: nothing oscillates.
  const held = toneBench({ reset: false });
  held.b.gnd(held.u.get(4));
  assert.equal(runTo(spice(held.doc), 0.1).tones.size, 0);
  // RESET on a signal: playing while it is HIGH, silent soon after it drops.
  const keyed = toneBench({ reset: false });
  keyed.b.signal("s1", keyed.u.get(4), "high");
  const sim = spice(keyed.doc);
  const level = (until) => (t) => new Map([["s1", t < until ? H : L]]);
  assert.ok(runTo(sim, 0.1, level(1)).tones.has("ls1"), "playing");
  const keyedOff = spice(keyed.doc);
  assert.equal(runTo(keyedOff, 0.2, level(0.1)).tones.size, 0, "stopped");
});

test("the logic engine has no voltages to time: no tones", () => {
  const { doc } = toneBench();
  const sim = runner(doc, { engine: "digital" });
  const r = sim.run(0.01).result;
  assert.equal(r.tones, undefined);
});

test("noteTone: a square read at its edges, its rate in true time", () => {
  const tones = new Map();
  // 100 Hz, ±0.25 V, read at each edge and twice between (a sag).
  for (let k = 0; k < 40; k++) {
    const t = k * 0.005;
    const v = k % 2 ? -0.25 : 0.25;
    noteTone(tones, "x", v, t, 2); // each shown second two true ones
    noteTone(tones, "x", v * 0.9, t + 0.002, 2);
  }
  const tone = toneOf(tones.get("x"), 0.2);
  close(tone.hz, 200, 1e-9, "shown 100 Hz is 200 Hz true");
  close(tone.vpp, 0.5, 1e-9, "the swing");
  // Long after its last rise it has stopped.
  assert.equal(toneOf(tones.get("x"), 1), null);
});

test("noteTone: too small a swing is silence, and a quieter tone is heard again", () => {
  const tones = new Map();
  for (let k = 0; k < 20; k++) noteTone(tones, "x", (k % 2) * TONE_MIN_VPP * 0.5, k * 0.001); // prettier-ignore
  assert.equal(toneOf(tones.get("x"), 0.02), null, "under TONE_MIN_VPP");
  // Loud, then — after a pause long enough to count as stopped — ten
  // times quieter about another level.
  const m = new Map();
  let t = 0;
  for (let k = 0; k < 20; k++, t += 0.001) noteTone(m, "y", k % 2 ? 0 : 2, t);
  assert.ok(toneOf(m.get("y"), t), "loud");
  t += 0.05;
  for (let k = 0; k < 40; k++, t += 0.002) noteTone(m, "y", 1 + (k % 2 ? 0 : 0.2), t); // prettier-ignore
  const quiet = toneOf(m.get("y"), t);
  assert.ok(quiet, "heard again");
  close(quiet.hz, 250, 1e-9, "its own rate");
  close(quiet.vpp, 0.2, 1e-9, "its own swing");
});

test("speakerTones: only a speaker playing, with its power and its Volume", () => {
  const tones = new Map();
  for (let k = 0; k < 10; k++) noteTone(tones, toneKey("a"), k % 2 ? -0.5 : 0.5, k * 0.001); // prettier-ignore
  const out = speakerTones(
    [
      { id: "a", impedance: 16, volume: 80 },
      { id: "b", impedance: 8, volume: 50 },
    ],
    tones,
    0.01,
  );
  assert.deepEqual([...out.keys()], ["a"]);
  const a = out.get("a");
  close(a.hz, 500, 1e-9, "hz");
  close(a.watts, 0.5 ** 2 / 16, 1e-12, "watts");
  assert.equal(a.volume, 80);
});

test("the speaker part: a resistor of its impedance to the solve, Spice Lite's alone", () => {
  const def = partDef("speaker");
  assert.equal(def.spiceOnly, true);
  assert.equal(def.speaker, true);
  assert.deepEqual(def.internalBridges(), []);
  assert.deepEqual(def.weakBridges({ impedance: 32 }), [[1, 2, 32]]);
  assert.deepEqual(speakerParams({}), { impedance: 8, volume: 50 });
  assert.deepEqual(speakerParams({ impedance: 12, volume: 140.4 }), { impedance: 8, volume: 100 }); // prettier-ignore
  // Loudness: the square root of the power against full, times the Volume.
  close(
    speakerLoudness(SPEAKER_FULL_W / 4, 100),
    0.5,
    1e-12,
    "a quarter the power",
  );
  assert.equal(speakerLoudness(SPEAKER_FULL_W * 9, 40), 0.4);
  assert.equal(speakerLoudness(0.01, 0), 0);
});

// ── The shipped examples (demos/speaker.chiphippo) ─────────────────────────

const DEMOS = fileURLToPath(new URL("../../demos/", import.meta.url));

/** One shipped speaker example desktop's document, by name. */
function exampleDoc(name) {
  const payload = JSON.parse(readFileSync(`${DEMOS}speaker.json`, "utf8"));
  const desk = exampleDesktops("speaker", payload).find((d) => d.name === `speaker ${name} example`); // prettier-ignore
  assert.ok(desk, `a ${name} desktop`);
  return structuredClone(desk.doc);
}

/** The one part of `ref` on a desk (the nth, in document order). */
const nth = (doc, ref, n = 0) => doc.components.filter((c) => c.ref === ref)[n]; // prettier-ignore

/**
 * A desk run under Spice Lite as SimController runs it: a tick at every wake
 * and frame, a param changed or a button pressed by rebuilding the netlist.
 * `until(t, each)` runs on to `t`, calling `each(result)` after every tick.
 */
function deskRun(doc) {
  const { tick } = ENGINES.spice;
  let pressed = new Map();
  const build = () => buildNetlist(doc, pressed, { inductors: "branch" });
  let netlist = build();
  let carry = { warm: new Map(), state: new Map(), prev: new Map(), analog: null }; // prettier-ignore
  let last = null;
  let now = 0;
  const run = (t) => {
    last = tick({
      document: doc,
      netlist,
      warmStart: carry.warm,
      state: carry.state,
      prevPinLevels: carry.prev,
      clockPhase: new Map(),
      clockTimes: new Map(),
      signalLevels: new Map(),
      now: t,
      spice: { config: { enabled: true }, analog: carry.analog },
    });
    carry = { warm: last.netLevels, state: last.state, prev: last.pinLevels, analog: last.analog ?? null }; // prettier-ignore
    now = t;
  };
  run(0);
  return {
    get result() {
      return last;
    },
    set(id, params) {
      const comp = doc.components.find((c) => c.id === id);
      comp.params = { ...comp.params, ...params };
      netlist = build();
      run(now);
    },
    press(id, down) {
      pressed = new Map(down ? [[id, { pressed: true }]] : []);
      netlist = build();
      run(now);
    },
    until(t, each = null) {
      for (let n = 0; n < 200000 && now < t; n++) {
        const wake = last.wakeAt != null ? Math.max(last.wakeAt, now + MIN_SHOWN_S) : null; // prettier-ignore
        const next = Math.min(t, wake ?? last.frameAt ?? t);
        run(Math.max(next, now + 1e-7));
        each?.(last);
      }
    },
  };
}

/** The 555 astable's rate from its parts, Hz: 1.44 / ((RA + 2·RB)·C). */
const rate555 = (ra, rb, c) => 1.44 / ((ra + 2 * rb) * c);

test("example Tone: the speaker plays the 555's rate from its parts, and nothing warns", () => {
  const doc = exampleDoc("Tone");
  const sim = deskRun(doc);
  sim.until(0.3);
  const speaker = nth(doc, "speaker");
  const tone = sim.result.tones.get(speaker.id);
  assert.ok(tone, "it plays");
  const [ra, rb] = [0, 1].map((n) => nth(doc, "resistor", n).params.ohms);
  const c = nth(doc, "cap-ceramic").params.farads;
  close(tone.hz, rate555(ra, rb, c), 0.03, "f = 1.44/((RA + 2RB)C)");
  close(tone.hz, sim.result.timing.get(nth(doc, "NE555").id).sections[0].frequency, 1e-9, "the 555's own readout"); // prettier-ignore
  assert.ok(tone.watts > 0.005 && tone.watts < 0.05, `${tone.watts} W: audible, and well inside 0.5 W`); // prettier-ignore
  assert.deepEqual(sim.result.warnings, []);
});

test("example Pitch: the pot's Position sets the pitch while it plays", () => {
  const doc = exampleDoc("Pitch");
  const sim = deskRun(doc);
  const pot = nth(doc, "pot");
  const ra = nth(doc, "resistor").params.ohms;
  const c = nth(doc, "cap-ceramic").params.farads;
  const speaker = nth(doc, "speaker").id;
  let t = 0.3;
  sim.until(t);
  for (const position of [30, 50, 100, 10]) {
    if (position !== pot.params.position) sim.set(pot.id, { position });
    sim.until((t += 0.3));
    const rb = (pot.params.ohms * position) / 100;
    const tone = sim.result.tones.get(speaker);
    assert.ok(tone, `${position} %: it plays`);
    close(tone.hz, rate555(ra, rb, c), 0.04, `${position} %`);
  }
  assert.deepEqual(sim.result.warnings, []);
});

test("example Key: silent until the button is held, the tone while it is, silent once let go", () => {
  const doc = exampleDoc("Key");
  const sim = deskRun(doc);
  const speaker = nth(doc, "speaker").id;
  const button = nth(doc, "sw-push").id;
  sim.until(0.2);
  assert.equal(sim.result.tones.size, 0, "held in reset");
  sim.press(button, true);
  sim.until(0.4);
  const tone = sim.result.tones.get(speaker);
  assert.ok(tone, "keyed: it plays");
  const [ra, rb] = [0, 1].map((n) => nth(doc, "resistor", n).params.ohms);
  close(tone.hz, rate555(ra, rb, nth(doc, "cap-ceramic").params.farads), 0.03, "its rate"); // prettier-ignore
  sim.press(button, false);
  sim.until(0.6);
  assert.equal(sim.result.tones.size, 0, "let go: silent");
  assert.deepEqual(sim.result.warnings, []);
});

test("example Siren: the tone steps between two pitches a fourth apart, once a second", () => {
  const doc = exampleDoc("Siren");
  const sim = deskRun(doc);
  const speaker = nth(doc, "speaker").id;
  const heard = [];
  sim.until(4, (r) => {
    const hz = r.tones.get(speaker)?.hz;
    if (hz && (!heard.length || Math.abs(heard.at(-1).hz - hz) > 1)) heard.push({ t: r.analog.time, hz }); // prettier-ignore
  });
  // What it held for more than a few periods (each step's own period, the
  // one the threshold moved in, is neither pitch), from 1.5 s on.
  const held = heard
    .map((h, i) => ({ ...h, until: heard[i + 1]?.t ?? 4 }))
    .filter((h) => h.t > 1.5 && h.until - h.t > 0.02);
  const low = Math.min(...held.map((h) => h.hz));
  const high = Math.max(...held.map((h) => h.hz));
  // Two pitches only (a step, not a glide)…
  for (const h of held) {
    assert.ok(Math.abs(h.hz - low) < 0.01 * low || Math.abs(h.hz - high) < 0.01 * high, `${h.hz} Hz is one of the two`); // prettier-ignore
  }
  // …a fourth or so apart (4/3), each held about half a second.
  assert.ok(high / low > 1.25 && high / low < 1.45, `${low} → ${high} Hz`);
  assert.ok(held.length >= 4, `${held.length} pitches held in 2.5 s`);
  for (const h of held.slice(0, -1)) {
    assert.ok(h.until - h.t > 0.35 && h.until - h.t < 0.7, `held ${h.until - h.t} s`); // prettier-ignore
  }
  assert.deepEqual(sim.result.warnings, []);
});

/** A speaker straight across a `volts` supply. */
function acrossSupply(volts, impedance = 8) {
  const b = bench({ volts });
  const s = b.seat("s1", "speaker", "a30", { impedance });
  b.vcc(s.get(1));
  b.gnd(s.get(2));
  return b.doc;
}

/** Tick `doc` at its wakes to `stop` seconds: each tick's [now, result]. */
function wakes(doc, stop) {
  const sim = runner(doc, { engine: "spice" });
  const out = [];
  let now = 0;
  for (let k = 0; k < 500 && now <= stop; k++) {
    const result = sim.run(now).result;
    out.push([now, result]);
    if (result.wakeAt == null) break;
    now = Math.max(result.wakeAt, now + MIN_SHOWN_S);
  }
  return { out, sim, now };
}

test("a coil's power is its MEAN: a square held between edges, a kick by its energy", () => {
  const sp = { id: "s1", impedance: 8 };
  // A 20 % PWM of 5 V, read at its edges (settles): 5 V for 1 ms, 0 V for
  // 4 ms — a fifth of 25/8 W, not the 3.1 W of either edge.
  const energy = new Map();
  for (const [t, v] of [[0, 5], [1e-3, 0], [5e-3, 5], [6e-3, 0]]) noteCoil(energy, "s1", v, t); // prettier-ignore
  const pwm = coilMeanWatts(energy, sp, 5, 10e-3);
  close(pwm.watts, 0.2 * (25 / 8), 1e-12, "a fifth");
  assert.equal(pwm.span, 10e-3);
  // A capacitor's kick: 12 V decaying with τ = 8 µs, read at the edge and
  // 100 µs on along its curve — its exponential's ∫v², not a straight line's.
  const tau = 8e-6;
  const v1 = 12 * Math.exp(-100e-6 / tau);
  close(squareArea(12, v1, 100e-6), (144 * tau) / 2 * (1 - (v1 / 12) ** 2), 1e-9, "½·144·τ"); // prettier-ignore
  // A moment read twice is what it settled to; a replay's earlier reading
  // books nothing.
  const e2 = new Map();
  noteCoil(e2, "s1", 0, 0);
  noteCoil(e2, "s1", 5, 0);
  noteCoil(e2, "s1", 5, 1e-3);
  noteCoil(e2, "s1", 9, 0.5e-3);
  close(coilMeanWatts(e2, sp, 5, 1e-3).watts, 25 / 8, 1e-12, "held at 5 V");
  assert.equal(
    coilMeanWatts(new Map(), sp, 5, 0),
    null,
    "nothing across any time",
  );
});

test("a coil's heat: a lag of its power, burnt at twice its rating", () => {
  assert.equal(SPEAKER_SMOKE_W, 2 * SPEAKER_RATED_W);
  // 3.125 W heats a cold coil to 1 W in τ·ln(3.125 / 2.125).
  const due = speakerBurnIn(0, 25 / 8);
  close(due, SPEAKER_HEAT_TAU_S * Math.log(3.125 / 2.125), 1e-12, "burn time");
  close(
    speakerHeatAfter(0, 25 / 8, due),
    SPEAKER_SMOKE_W,
    1e-12,
    "at its smoke",
  );
  assert.equal(
    speakerBurnIn(0, SPEAKER_SMOKE_W),
    Infinity,
    "never at exactly it",
  );
  // One warming past its rating, and no further, is read where it gets
  // there; one under it, never.
  close(speakerReadIn(0, 0.78), SPEAKER_HEAT_TAU_S * Math.log(0.78 / 0.28), 1e-12, "the warning's moment"); // prettier-ignore
  assert.equal(speakerReadIn(0, 0.4), Infinity);
});

test("straight across 5 V an 8 Ω coil warns, then burns open — once, silent, carrying nothing", () => {
  const { out, sim, now } = wakes(acrossSupply(5), 2);
  const said = (type) => out.filter(([, r]) => r.warnings.some((w) => w.type === type)); // prettier-ignore
  const burns = said("speaker-burnt");
  assert.equal(burns.length, 1, "said once");
  const [at, r] = burns[0];
  close(at, speakerBurnIn(0, 25 / 8), 1e-6, "at its heat's time");
  const w = r.warnings.find((x) => x.type === "speaker-burnt");
  close(w.watts, 25 / 8, 1e-3, "3.1 W");
  assert.equal(w.limit, SPEAKER_SMOKE_W);
  assert.ok(said("speaker-power").length > 0, "warned first");
  assert.ok(said("speaker-power").every(([t]) => t < at));
  assert.equal(r.bench.get("s1")?.burnt, true);
  // Open from then on: the supply delivers nothing, and it plays nothing.
  const after = sim.run(now + 0.5).result;
  assert.equal(after.bench.get("s1")?.burnt, true, "still burnt");
  assert.ok(after.supplies.get("psu1").amps < 1e-9, `${after.supplies.get("psu1").amps} A`); // prettier-ignore
  assert.ok(!after.warnings.some((x) => x.type.startsWith("speaker-")));
  assert.equal(after.tones.has("s1"), false);
});

test("past its rating but short of twice it, a coil warns and survives", () => {
  // 2.5 V across 8 Ω: 0.78 W — warm past 0.5 W, never at 1 W. On a desk
  // nothing else ticks it is woken where it gets warm, to say so.
  const { out } = wakes(acrossSupply(2.5), 30);
  const [first] = out[0];
  assert.equal(first, 0);
  assert.ok(!out[0][1].warnings.some((w) => w.type.startsWith("speaker-")), "cold"); // prettier-ignore
  const warned = out.find(([, r]) => r.warnings.some((w) => w.type === "speaker-power")); // prettier-ignore
  assert.ok(warned, "said on its own wake");
  close(warned[0], SPEAKER_HEAT_TAU_S * Math.log(0.78125 / 0.28125), 1e-6, "when it is warm"); // prettier-ignore
  assert.ok(!out.some(([, r]) => r.warnings.some((w) => w.type === "speaker-burnt"))); // prettier-ignore
  assert.equal(out.at(-1)[1].wakeAt, null, "and then left alone");
  // 32 Ω on 5 V: 0.78 W too.
  const thin = runner(acrossSupply(5, 32), { engine: "spice" });
  thin.run(0);
  assert.ok(!thin.run(30).result.warnings.some((w) => w.type === "speaker-burnt")); // prettier-ignore
});

test("a PWM is booked at its duty: 10 % of 5 V across 8 Ω survives, 90 % burns", () => {
  const burns = (duty) => {
    let at = null;
    const b = bench({ volts: 5 });
    b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: { hz: 200, wave: "pwm", duty } }); // prettier-ignore
    b.doc.wires.push({ id: "wv", from: "psu1.+", to: "clk1.vcc", color: "red" }); // prettier-ignore
    b.doc.wires.push({ id: "wg", from: "psu1.-", to: "clk1.gnd", color: "black" }); // prettier-ignore
    // Switched from 5 V by a logic-level MOSFET: the brick's own 50 Ω
    // (spice/output-stage.js `CLOCK_OHMS`) puts 60 mW into 8 Ω at most.
    const q = b.seat("q1", "nmos", "a10", { grade: "logic-power", case: "TO-220" }); // prettier-ignore
    const s = b.seat("s1", "speaker", "a30", {});
    b.doc.wires.push({ id: "wo", from: "clk1.out", to: b.at(q.get(2).replace(/^a/, "c")), color: "red" }); // prettier-ignore
    b.gnd(q.get(1));
    b.vcc(s.get(1));
    b.link(s.get(2), q.get(3));
    driveSpice(b.doc, { seconds: 2, onTick(now, r) { if (at == null && r.warnings.some((w) => w.type === "speaker-burnt")) at = now; } }); // prettier-ignore
    return at;
  };
  // 0.31 W: under even its rating.
  assert.equal(burns(10), null);
  // 2.8 W: τ·ln(2.81 / 1.81), give or take the edge it lands on (and the
  // MOSFET's RDS(on), 4 ms later).
  const at = burns(90);
  const want = SPEAKER_HEAT_TAU_S * Math.log((0.9 * 25 / 8) / (0.9 * 25 / 8 - 1)); // prettier-ignore
  assert.ok(at != null && Math.abs(at - want) < 0.01, `burnt at ${at}, want ${want}`); // prettier-ignore
});

test("the surge into its capacitor at power-on heats it not at all", () => {
  // 12 V through 1000 µF into 8 Ω: 18 W at the first instant, gone in a few
  // 8 ms time constants — ½CV² = 72 mJ, which raises a coil's heat (a lag of
  // τ = 1 s) by about 72 mW (booked a little high, the decay read only at
  // its wakes), nowhere near its 0.5 W rating.
  const b = bench({ volts: 12 });
  const c = b.seat("c1", "cap-electrolytic", "a20", { farads: 1e-3 });
  const s = b.seat("s1", "speaker", "a30", {});
  b.vcc(c.get(1));
  b.link(c.get(2), s.get(1));
  b.gnd(s.get(2));
  const { out } = wakes(b.doc, 2);
  for (const [t, r] of out) {
    assert.ok(!r.warnings.some((w) => w.type.startsWith("speaker-")), `at ${t}`); // prettier-ignore
    const heat = r.analog.speakerHeats?.get("s1")?.heat ?? 0;
    assert.ok(heat < 0.15, `heat ${heat} W at ${t}`);
  }
});
