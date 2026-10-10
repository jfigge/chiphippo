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

// The analog side between ticks (spice/sample.js, features/01-display-wakes.md):
// what `sampleAnalog` reads off a tick's carried state at a moment before the
// next tick is what the engine itself says when it IS ticked there. Each
// fixture is run as SimController runs it; at 200 random moments between two
// of its ticks the engine is made to tick there too (from the earlier tick's
// state — a replay, nothing carried on), and every node it reports is held to
// the sample at the moment that tick left them at, to a nanovolt.

import test from "node:test";
import assert from "node:assert/strict";
import { ENGINES } from "../sim/engines.js";
import { FAST_WINDOW_S } from "../sim/spice/engine.js";
import { sampleAnalog, nextDisplayFrame } from "../sim/spice/sample.js";
import { driveSpice } from "../bench/drive-spice.js";
import { astable555, bench } from "./timing-fixtures.js";
import { GOLDEN_CASES } from "./spice-golden-cases.js";
import { partDef } from "../catalog/index.js";

/** A small deterministic generator (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A clock putting out `wave` at `hz` into an RC low-pass — or, with
    `coil`, into a series R–L to ground. */
function waveRc(wave, hz, { coil = false } = {}) {
  const b = bench();
  const r = b.seat("r1", "resistor", "a10", { ohms: coil ? 100 : 1e3 });
  const c = coil
    ? b.seat("l1", "inductor", "a20", { henries: 0.1 })
    : b.seat("c1", "cap-ceramic", "a20", { farads: 1e-6 });
  b.link(r.get(2), c.get(1));
  b.gnd(c.get(2));
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: partDef("clock").normalizeParams({ hz, wave }) }); // prettier-ignore
  b.doc.wires.push(
    { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
    { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
    { id: "wc3", from: "clk1.out", to: b.at(r.get(1).replace(/^a/, "c")), color: "blue" }, // prettier-ignore
  );
  return b.doc;
}

const golden = (id) => GOLDEN_CASES.find((c) => c.id === id).build().doc;

const FIXTURES = [
  { name: "a 555 astable (single curves)", doc: astable555({ ra: 1e3, rb: 10e3, c: 1e-6 }).doc, seconds: 0.1 }, // prettier-ignore
  { name: "a two-gate CD4069UB oscillator (a coupled group)", doc: golden("two-gate-cd4069ub"), seconds: 0.5 }, // prettier-ignore
  { name: "a square into a series RL (a coil's current)", doc: waveRc("square", 100, { coil: true }), seconds: 0.05 }, // prettier-ignore
  { name: "a sine into an RC (a running wave)", doc: waveRc("sine", 50), seconds: 0.1 }, // prettier-ignore
  { name: "a triangle into an RC (a running wave)", doc: waveRc("triangle", 20), seconds: 0.2 }, // prettier-ignore
  { name: "a fast 555 (a drawn cycle)", doc: astable555({ ra: 1e3, rb: 10e3, c: 10e-9 }).doc, seconds: 0.02 }, // prettier-ignore
];

const SAMPLES = 200;

for (const f of FIXTURES) {
  test(`sampleAnalog reads what a tick there reports — ${f.name}`, () => {
    const ticks = [];
    driveSpice(f.doc, {
      seconds: f.seconds,
      onTick: (now, result, input) => {
        ticks.push({ now, result, input: { ...input, clockPhase: new Map(input.clockPhase) } }); // prettier-ignore
      },
    });
    assert.ok(ticks.length > 2, "the fixture ticks");
    const random = rng(0x5eed);
    let compared = 0;
    let worst = 0;
    let worstAmps = 0;
    for (let n = 0; n < SAMPLES; n++) {
      // A moment strictly between two ticks, before the earlier one's wake
      // (the transport may tick later than that: MIN_SHOWN_S) by more than
      // the fast window (a tick there runs on into a crossing that close).
      const k = Math.floor(random() * (ticks.length - 1));
      const { result: prev, input } = ticks[k];
      const after = Math.min(ticks[k + 1].now, (prev.wakeAt ?? Infinity) - 2 * FAST_WINDOW_S); // prettier-ignore
      const from = prev.analog.time;
      if (!(after > from)) continue;
      const at = from + random() * (after - from);
      const forced = ENGINES.spice.tick({ ...input, warmStart: prev.netLevels, state: prev.state, prevPinLevels: prev.pinLevels, now: at, spice: { ...input.spice, analog: prev.analog } }); // prettier-ignore
      // A drawn cycle stands where its schedule has it at the tick's own
      // moment; a curve where the tick's settles left it.
      const when = prev.analog.cycle ? at : forced.analog.time;
      const { volts, coils } = sampleAnalog(prev.analog, when);
      // A node on its own curve agrees to a nanovolt. A tick re-anchors a
      // coupled group where it stands (its common mode balanced to
      // BALANCE_V, its slopes read numerically), so beside it a group's
      // node is allowed two nanovolts and one more per volt it stands at, and a coil's
      // current a millionth of itself: the tick's own re-linearizing, not the
      // sample's (which reads one curve exactly).
      for (const [net, v] of volts) {
        const engine = forced.nodeVolts.get(net);
        if (engine == null) continue;
        const coupled = prev.analog.nodes.get(net)?.curve?.kind != null;
        const bar = coupled ? 1e-9 * (2 + Math.abs(v)) : 1e-9;
        worst = Math.max(worst, Math.abs(engine - v) / bar);
        compared++;
      }
      for (const [id, amps] of coils) {
        const engine = forced.analog.coilAmps.get(id);
        if (engine == null) continue;
        worstAmps = Math.max(worstAmps, Math.abs(engine - amps) / Math.max(1e-6 * Math.abs(amps), 1e-15)); // prettier-ignore
        compared++;
      }
    }
    assert.ok(compared >= SAMPLES / 2, `compared ${compared} node readings`);
    assert.ok(worst <= 1, `worst node disagreement ${worst}× its bar`);
    assert.ok(worstAmps <= 1, `worst coil disagreement ${worstAmps}× its bar`);
  });
}

test("nextDisplayFrame: a node on its way, until it arrives; a wave by its period", () => {
  const moving = { t0: 0, v0: 0, vInf: 5, tau: 1e-3 };
  const nodes = new Map([["n1", { driven: null, curve: moving }]]);
  const at = nextDisplayFrame({ nodes }, 1, 0.001, { gapPercent: 1 });
  assert.equal(at, 1 + 1 / 30);
  assert.equal(nextDisplayFrame({ nodes }, 1, 0.1, { gapPercent: 1 }), null, "arrived"); // prettier-ignore
  assert.equal(nextDisplayFrame({ nodes, chatter: { at: 0, backoff: 1 } }, 1, 0.001, { gapPercent: 1 }), null, "never while chattering"); // prettier-ignore
  const wave = {
    nodes: new Map([["w", { driven: null, curve: { t0: 0, v0: 0, vInf: 0, tau: Infinity, rate: 10 } }]]), // prettier-ignore
    waves: new Map([["w", "clk1"]]),
    inputs: { clockTimes: new Map([["clk1", { half: 0.25, since: 0 }]]) },
  };
  assert.equal(nextDisplayFrame(wave, 0, 0, { gapPercent: 1 }), 0.5 / 16);
  assert.equal(nextDisplayFrame(wave, 0, 0, { gapPercent: 1, waveFrames: false }), 1 / 30); // prettier-ignore
});
