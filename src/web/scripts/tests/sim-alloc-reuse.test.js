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

// The logic engine's per-tick garbage cuts (the runtime round, 2026-10-28)
// change no reading: a reused map reads exactly as the fresh one it stands
// for — the lamps' brightness map written into the one LampAverage let go,
// a chip's unchanged reading handed back itself (chip-eval.js
// `inputLevels`' `prev`), a combinational chip's outputs written into a
// spare (`evaluate`'s `out`), the warm levels array reused — and a run
// ticked through them is the run ticked without (every field, every tick,
// against the full loop, which keeps none of them across ticks; the
// differential fuzz and the busy checksums held them to the tree before).

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, Z, X } from "../sim/levels.js";
import { isLit, junctionState } from "../sim/junction.js";
import {
  LampAverage,
  lampBrightness,
  lampJunctions,
} from "../sim/lamp-average.js";
import { evaluate, inputLevels } from "../sim/chip-eval.js";
import { partDef } from "../catalog/index.js";
import { busyDocument } from "../bench/busy-circuit.js";
import { buildNetlist } from "../sim/netlist.js";
import { prepareCircuit, tick, tieMemo } from "../sim/engine.js";

const LEVELS = [H, L, Z, X, undefined];

/** Two maps the same: keys in the same order, the same values. */
const same = (a, b) => assert.deepEqual([...a], [...b]);

test("the lamps' rule is junction.js's, for every level and strong level", () => {
  const junctions = [];
  const levels = new Map();
  const strong = new Map();
  const want = [];
  let n = 0;
  for (const anode of LEVELS) {
    for (const cathode of LEVELS) {
      for (const anodeStrong of LEVELS) {
        for (const cathodeStrong of LEVELS) {
          const a = `a${n}`;
          const k = `k${n}`;
          if (anode !== undefined) levels.set(a, anode);
          if (cathode !== undefined) levels.set(k, cathode);
          if (anodeStrong !== undefined) strong.set(a, anodeStrong);
          if (cathodeStrong !== undefined) strong.set(k, cathodeStrong);
          junctions.push({ key: `j${n}`, anodeAt: a, cathodeAt: k });
          const state = junctionState({
            anode: anode ?? null,
            cathode: cathode ?? null,
            anodeStrong: anodeStrong ?? null,
            cathodeStrong: cathodeStrong ?? null,
          });
          want.push([`j${n}`, isLit(state) ? 1 : 0]);
          n++;
        }
      }
    }
  }
  junctions.push({ key: "open", anodeAt: null, cathodeAt: "k0" });
  want.push(["open", 0]);
  const netlist = { netOfPoint: new Map([...junctions].flatMap((j) => [[j.anodeAt, j.anodeAt], [j.cathodeAt, j.cathodeAt]])) }; // prettier-ignore
  const viaMap = { netLevels: levels, strongLevels: strong };
  const viaAt = { netLevels: levels, strongAt: (id) => strong.get(id) };
  same(lampBrightness(junctions, netlist, viaMap), new Map(want));
  same(lampBrightness(junctions, netlist, viaAt), new Map(want));
});

test("a brightness map written again reads as a fresh one, and only from its own junctions", () => {
  const doc = busyDocument(2);
  const netlist = buildNetlist(doc);
  const junctions = lampJunctions(doc);
  assert.ok(junctions.length > 0);
  const ctx = prepareCircuit(doc, netlist);
  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  let carry = null;
  const lamps = new LampAverage();
  const ties = tieMemo();
  for (let i = 0; i < 60; i++) {
    const r = tick({ document: doc, netlist, warmStart: warm, state, prevPinLevels: prev, clockPhase: new Map([["clk1", i % 2 ? L : H]]), context: ctx, now: i * 0.005, warm: carry, ties }); // prettier-ignore
    const spare = lamps.spare();
    const fresh = lampBrightness(junctions, netlist, r);
    const into = lampBrightness(junctions, netlist, r, spare);
    if (spare)
      assert.equal(into, spare, `tick ${i}: the spare is written into`);
    same(into, fresh);
    lamps.record(i * 0.005, into);
    warm = r.netLevels;
    state = r.state;
    prev = r.pinLevels;
    carry = r.warm;
  }
  // Another desk's junctions, or Spice Lite's lamps: a fresh map.
  const other = lampJunctions(busyDocument(1));
  const filled = lampBrightness(junctions, netlist, { netLevels: new Map() });
  assert.notEqual(lampBrightness(other, netlist, { netLevels: new Map() }, filled), filled); // prettier-ignore
  const spice = { lamps: new Map([["x", { lit: true, level: 0.5 }]]) };
  const out = lampBrightness(junctions, netlist, spice, filled);
  assert.notEqual(out, filled);
  assert.equal(out.get("x"), 0.5);
  // The spare is the map the last record let go, once.
  const avg = new LampAverage();
  const a = new Map([["k", 1]]);
  const b = new Map([["k", 0]]);
  avg.record(0, a);
  assert.equal(avg.spare(), null);
  avg.record(1, b);
  assert.equal(avg.spare(), a);
  assert.equal(avg.spare(), null);
});

test("a chip's reading is handed back itself only when every pin reads as it did", () => {
  const def = partDef("74LS161");
  const pins = (lv) => new Map(def.pins.map((p) => [p.n, lv(p.n)]));
  const first = inputLevels(
    def,
    pins(() => H),
  );
  same(
    inputLevels(
      def,
      pins(() => H),
    ),
    first,
  );
  assert.equal(
    inputLevels(
      def,
      pins(() => H),
      first,
    ),
    first,
  );
  // Z reads HIGH on a TTL part: the same reading.
  assert.equal(
    inputLevels(
      def,
      pins(() => Z),
      first,
    ),
    first,
  );
  const clk = def.pins.find((p) => p.role === "input").n;
  const moved = inputLevels(
    def,
    pins((n) => (n === clk ? L : H)),
    first,
  );
  assert.notEqual(moved, first);
  same(
    moved,
    inputLevels(
      def,
      pins((n) => (n === clk ? L : H)),
    ),
  );
  // Another def's reading, however alike, is not this one's.
  const other = partDef("74LS169");
  assert.notEqual(inputLevels(def, pins(() => H), inputLevels(other, pins(() => H))), first); // prettier-ignore
  same(inputLevels(def, pins(() => H), inputLevels(other, pins(() => H))), first); // prettier-ignore
});

test("a combinational chip's outputs written into a spare read as a fresh map", () => {
  for (const ref of ["74LS00", "74LS138", "74LS47", "74LS283", "CD4011B"]) {
    const def = partDef(ref);
    const ins = def.pins.filter((p) => p.role === "input").map((p) => p.n);
    let spare = null;
    for (let k = 0; k < 64; k++) {
      const pins = new Map(ins.map((n, j) => [n, LEVELS[(k * 7 + j * 3) % 4]]));
      const fresh = evaluate(def, pins);
      const into = evaluate(def, pins, spare ?? new Map());
      same(into, fresh);
      spare = into;
    }
  }
});

test("a busy run through every reuse is the full loop's, field by field, and mutates nothing it is handed", () => {
  const doc = busyDocument(3);
  const netlist = buildNetlist(doc);
  const ctx = prepareCircuit(doc, netlist);
  const runs = {
    inc: { warm: new Map(), state: new Map(), prev: new Map(), carry: null, ties: tieMemo() }, // prettier-ignore
    full: { warm: new Map(), state: new Map(), prev: new Map(), ties: tieMemo() }, // prettier-ignore
  };
  const ser = (v) => JSON.stringify(v, (_, x) => (x instanceof Map ? [...x] : x instanceof Set ? [...x] : x)); // prettier-ignore
  for (let i = 0; i < 200; i++) {
    const out = {};
    for (const [name, t] of Object.entries(runs)) {
      const before = ser([t.warm, t.state, t.prev]);
      const r = tick({ document: doc, netlist, warmStart: t.warm, state: t.state, prevPinLevels: t.prev, clockPhase: new Map([["clk1", i % 2 ? L : H]]), now: i * 0.005, ties: t.ties, ...(name === "inc" ? { context: ctx, warm: t.carry } : { mode: "full" }) }); // prettier-ignore
      assert.equal(ser([t.warm, t.state, t.prev]), before, `${name} tick ${i}: its inputs mutated`); // prettier-ignore
      out[name] = r;
      t.warm = r.netLevels;
      t.state = r.state;
      t.prev = r.pinLevels;
      t.carry = r.warm;
    }
    for (const f of [
      "netLevels",
      "strongLevels",
      "chipStatus",
      "warnings",
      "iterations",
      "settled",
      "state",
      "pinLevels",
      "channels",
      "wakeAt",
    ]) {
      assert.equal(ser(out.inc[f]), ser(out.full[f]), `tick ${i}: ${f}`);
    }
  }
});
