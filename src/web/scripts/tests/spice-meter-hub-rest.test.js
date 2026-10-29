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

// The multimeter → A round (2026-10-28): a meter's far rail (spice/voltages.js
// `meterHubs`) placed at a guess (`seedHubs`, its chips' ICC alone) is put on
// its balance at the first later tick that finds it at rest (`settleHubs`, a
// wake soon after Run or an edit — `askHubWake`), so where a chip on it
// settles is the circuit's, not its history's; and a move of the rail that
// changes only the supply of the chips off the rails re-solves the networks
// they are in, not the desk (`offRailMoves`).

import test from "node:test";
import assert from "node:assert/strict";

import { bench } from "./timing-fixtures.js";
import { partDef } from "../catalog/index.js";
import { meterSetup } from "../catalog/meter.js";
import { INVARIANCE } from "./spice-golden-cases.js";
import { busyDocument } from "../bench/busy-circuit.js";
import { driveSpice } from "../bench/drive-spice.js";
import { buildNetlist } from "../sim/netlist.js";
import { ENGINES } from "../sim/engines.js";
import { prepareCircuit } from "../sim/engine.js";
import { H, L } from "../sim/levels.js";

const meterOf = (id, params, x = 70) => ({ id, kind: "meter", ref: "meter", x, y: 0, params: partDef("meter").normalizeParams(params) }); // prettier-ignore
/** How far apart two histories of one desk may settle, volts: the golden
    rubric's invariance on a 5 V supply (a guess within a quarter of
    DROOP_EPS of its balance is left where it stands —
    spice/voltages.js `HUB_GUESS_EPS`). */
const HISTORY_V = INVARIANCE * 5;
const SHUNT = meterSetup(partDef("meter").normalizeParams({ dial: "ma", jack: "ma" })).element.ohms; // prettier-ignore

/**
 * The regrade's repro (`/tmp/chh-regrade7/meter/topo.mjs`): `n` 74LS04s fed
 * through an mA meter in their − lead (`lead` "-") or a meter in each lead
 * ("both") — or the shunts they are (`twin`) — inputs 3, 5, 9, 11, 13 on the
 * supply's −, output 2 lighting a red LED through 330 Ω, input 1 `pin1`:
 * "clock" (a 100 Hz clock brick off the supply), "open" (the clock still
 * there, on nothing), "flag" (a HIGH signal flag, no clock) or "bare" (open,
 * no clock: nothing ever ticks the desk again).
 */
function hubDesk({ lead, n, twin, pin1 }) {
  const b = bench({ volts: 5 });
  const plusFar = lead === "both";
  if (plusFar) {
    if (twin) {
      const r = b.seat("rp", "resistor", "a60", { ohms: SHUNT });
      b.vcc(r.get(1));
      b.link(r.get(2).replace(/^a/, "b"), "h60");
    } else b.doc.components.push(meterOf("dmmP", { dial: "ma", jack: "ma", red: { at: "psu1.+" }, black: { at: b.at("g60") } })); // prettier-ignore
  }
  if (twin) {
    const r = b.seat("rm", "resistor", "a56", { ohms: SHUNT });
    b.gnd(r.get(1));
    b.link(r.get(2).replace(/^a/, "b"), "h58");
  } else b.doc.components.push(meterOf("dmmM", { dial: "ma", jack: "ma", red: { at: b.at("g58") }, black: { at: "psu1.-" } }, 90)); // prettier-ignore
  const V = (h) => (plusFar ? b.link(h, "i60") : b.vcc(h));
  const G = (h) => b.link(h, "i58");
  if (pin1 === "clock" || pin1 === "open") {
    b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: partDef("clock").normalizeParams({ hz: 100 }) }); // prettier-ignore
    b.doc.wires.push({ id: "wk1", from: "psu1.+", to: "clk1.vcc", color: "red" }, { id: "wk2", from: "psu1.-", to: "clk1.gnd", color: "black" }); // prettier-ignore
  }
  for (let k = 0; k < n; k++) {
    const u = b.seat(`u${k}`, "74LS04", `e${2 + 10 * k}`);
    V(u.get(14).replace(/^f/, "j"));
    G(u.get(7).replace(/^e/, "a"));
    for (const p of [3, 5]) b.gnd(u.get(p).replace(/^e/, "a"));
    for (const p of [9, 11, 13]) b.gnd(u.get(p).replace(/^f/, "j"));
    const h1 = u.get(1).replace(/^e/, "a");
    if (pin1 === "clock")
      b.doc.wires.push({ id: `wk0${k}`, from: "clk1.out", to: b.at(h1), color: "blue" }); // prettier-ignore
    else if (pin1 === "flag") b.signal(`s${k}`, h1, "high");
    const r = b.seat(`rl${k}`, "resistor", `a${40 + 6 * k}`, { ohms: 330 });
    b.link(u.get(2).replace(/^e/, "c"), r.get(1));
    const d = b.seat(`d${k}`, "led", `f${40 + 6 * k}`, { color: "red" });
    b.link(r.get(2), d.get(1).replace(/^f/, "g"));
    G(d.get(2).replace(/^f/, "h"));
  }
  return b;
}

/** `doc` run to 45 ms (an edit to `edit` at 12 ms): u0's volts, the −
    lead's current (the meter's reading, or its twin's shunt's: the far
    net's volts over its ohms) as the run ends. */
function settled(b, edit = null) {
  const { result, netlist } = driveSpice(structuredClone(b.doc), {
    seconds: 0.045,
    end: true,
    signals: () =>
      new Map([
        ["s0", H],
        ["s1", H],
      ]),
    edits: edit ? [{ at: 0.012, doc: structuredClone(edit) }] : [],
  });
  const far = result.nodeVolts.get(netlist.netOfPoint.get(b.at("h58")));
  return {
    volts: result.chipStatus.get("u0").volts,
    amps: result.bench?.get("dmmM")?.amps ?? far / SHUNT,
  };
}

const unclocked = (b) => {
  const doc = structuredClone(b.doc);
  doc.wires = doc.wires.filter((w) => !w.id.startsWith("wk0"));
  return doc;
};

for (const lead of ["-", "both"]) {
  for (const n of [1, 2]) {
    test(`${n} 74LS04 behind ${lead === "-" ? "a − lead meter" : "a meter in each lead"}, input 1 open: fresh and edited, it settles where its resistor twin does`, () => {
      const meter = hubDesk({ lead, n, twin: false, pin1: "clock" });
      const twin = hubDesk({ lead, n, twin: true, pin1: "clock" });
      const fresh = settled({ ...meter, doc: unclocked(meter) });
      const edited = settled(meter, unclocked(meter));
      const reference = settled({ ...twin, doc: unclocked(twin) });
      // It read 4.9970 V fresh and 4.9991 V edited, its twin 4.9991 (one
      // chip; 4.9939 / 4.9981 / 4.9982 with two): the far rail held where its
      // guess, or the clocked desk before the edit, had left it.
      // Fresh, it is where its twin is (to a microvolt); edited, within 0.15 mV.
      assert.ok(Math.abs(fresh.volts - reference.volts) < 1e-5, `${fresh.volts} V against ${reference.volts}`); // prettier-ignore
      assert.ok(Math.abs(fresh.volts - edited.volts) < HISTORY_V, `${fresh.volts} V fresh, ${edited.volts} V edited`); // prettier-ignore
      assert.ok(Math.abs(edited.volts - reference.volts) < HISTORY_V, `${edited.volts} V against ${reference.volts}`); // prettier-ignore
      // …and its meter read +0.14 % (+0.29 % with two) over its twin's shunt.
      for (const [name, r] of [
        ["fresh", fresh],
        ["edited", edited],
      ]) {
        assert.ok(Math.abs(r.amps / reference.amps - 1) < INVARIANCE, `${name}: ${r.amps} A against ${reference.amps}`); // prettier-ignore
      }
    });
  }
}

test("…and on a desk nothing ticks again — input 1 on a HIGH flag, or open, no clock — as from Run", () => {
  for (const pin1 of ["flag", "bare"]) {
    const meter = settled(hubDesk({ lead: "-", n: 2, twin: false, pin1 }));
    const twin = settled(hubDesk({ lead: "-", n: 2, twin: true, pin1 }));
    assert.ok(Math.abs(meter.volts - twin.volts) < 1e-5, `${pin1}: ${meter.volts} V against ${twin.volts}`); // prettier-ignore
    assert.ok(Math.abs(meter.amps / twin.amps - 1) < INVARIANCE, `${pin1}: ${meter.amps} A against ${twin.amps}`); // prettier-ignore
  }
});

/** The busy fixture (4 slices), the mA meter in psu1's `lead` ("+", "-",
    or none). */
function busy(lead) {
  const doc = busyDocument(4);
  if (!lead) return doc;
  const term = `psu1.${lead}`;
  const feed = doc.wires.find((w) => w.from === term && new RegExp(`^bb\\d+\\.\\${lead}`).test(w.to)); // prettier-ignore
  doc.wires = doc.wires.filter((w) => w.id !== feed.id);
  const [red, black] = lead === "+" ? [term, feed.to] : [feed.to, term];
  doc.components.push(meterOf("dmm2", { dial: "ma", jack: "ma", red: { at: red }, black: { at: black } }, 40)); // prettier-ignore
  return doc;
}

/** The clusters each tick of the first 40 ms solves, in order: as
    SimController drives the desk (`real`: wakes honoured), or edge by edge. */
function solvesByTick(doc, real) {
  const out = [];
  if (real) {
    const stats = {};
    let before = 0;
    driveSpice(doc, {
      seconds: 0.04,
      stats,
      onTick() {
        out.push((stats.clusterSolves ?? 0) - before);
        before = stats.clusterSolves ?? 0;
      },
    });
    return out;
  }
  const netlist = buildNetlist(doc, new Map(), { inductors: "branch" });
  const context = prepareCircuit(doc, netlist);
  let r = null;
  for (let e = 0; e <= 8; e++) {
    const stats = {};
    r = ENGINES.spice.tick({ document: doc, netlist, warmStart: r?.netLevels ?? new Map(), state: r?.state ?? new Map(), prevPinLevels: r?.pinLevels ?? new Map(), clockPhase: new Map([["clk1", e % 2 ? H : L]]), context, now: e * 0.005, spice: { config: { enabled: true }, analog: r?.analog ?? null }, stats }); // prettier-ignore
    out.push(stats.clusterSolves);
  }
  return out;
}

test("the busy board behind a meter in either supply lead: its first clock edge re-solves the far rail's networks, not the desk", () => {
  for (const real of [true, false]) {
    const [plainRun, ...plainEdges] = solvesByTick(busy(null), real);
    for (const lead of ["+", "-"]) {
      const [run, edge, ...edges] = solvesByTick(busy(lead), real);
      assert.equal(run, plainRun, `${lead}: the Run tick`);
      // The guess, at rest since Run, is moved onto its balance at the first
      // edge's first pass, and its chips' supply with it: the rail's
      // networks solved again at each (128 cluster solves; the bare board's
      // edge is 6) — never the desk. It re-solved every cluster on the desk
      // once more after the rail moved: 282.
      assert.ok(edge < plainRun, `${lead}: ${edge} cluster solves at the first edge (${real ? "SimController" : "edge by edge"})`); // prettier-ignore
      assert.deepEqual(edges, plainEdges.slice(1), `${lead}: the edges after it`); // prettier-ignore
    }
  }
});

/**
 * The meter in a 74LS04's − lead, its inputs tied HIGH and its output 2 LOW,
 * sinking a red LED fed through `ohms` from signal flag `s0` (LOW at Run,
 * so its guess — its chips' ICC alone — is its balance to a nanovolt); or
 * the shunt it is (`twin`), or with a 100 Hz clock brick ticking the desk
 * besides (`clock`).
 */
function restDesk({ twin, clock, ohms = 2200 }) {
  const b = bench({ volts: 5 });
  if (twin) {
    const r = b.seat("rm", "resistor", "a56", { ohms: SHUNT });
    b.gnd(r.get(1));
    b.link(r.get(2).replace(/^a/, "b"), "h58");
  } else b.doc.components.push(meterOf("dmmM", { dial: "ma", jack: "ma", red: { at: b.at("g58") }, black: { at: "psu1.-" } }, 90)); // prettier-ignore
  const u = b.seat("u0", "74LS04", "e2");
  b.vcc(u.get(14).replace(/^f/, "j"));
  b.link(u.get(7).replace(/^e/, "a"), "i58");
  for (const p of [1, 3, 5]) b.vcc(u.get(p).replace(/^e/, "a"));
  for (const p of [9, 11, 13]) b.vcc(u.get(p).replace(/^f/, "j"));
  const r = b.seat("rl0", "resistor", "a40", { ohms });
  b.signal("s0", r.get(1).replace(/^a/, "b"), "low");
  const d = b.seat("d0", "led", "f40", { color: "red" });
  b.link(r.get(2), d.get(1).replace(/^f/, "g"));
  b.link(d.get(2).replace(/^f/, "h"), u.get(2).replace(/^e/, "c"));
  if (clock) {
    b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: partDef("clock").normalizeParams({ hz: 100 }) }); // prettier-ignore
    b.doc.wires.push({ id: "wk1", from: "psu1.+", to: "clk1.vcc", color: "red" }, { id: "wk2", from: "psu1.-", to: "clk1.gnd", color: "black" }); // prettier-ignore
  }
  return b;
}

test("a guess that lands within its threshold is a rail from there: a load change long after is held as any rail's, never moved at rest", () => {
  const AT = 0.05;
  for (const clock of [false, true]) {
    const run = (twin) => {
      const b = restDesk({ twin, clock });
      const ticks = [];
      const { result, netlist } = driveSpice(structuredClone(b.doc), {
        seconds: 0.2,
        end: true,
        at: [AT],
        signals: (now) => new Map([["s0", now >= AT ? H : L]]),
        onTick(now, r) {
          const v = r.analog.voltages;
          ticks.push({ now, hub: [...(v.hubVolts?.values() ?? [])], guesses: v.hubGuess?.size ?? 0 }); // prettier-ignore
        },
      });
      const far = result.nodeVolts.get(netlist.netOfPoint.get(b.at("h58")));
      return { ticks, amps: result.bench?.get("dmmM")?.amps ?? far / SHUNT, led: result.lamps.get("d0").amps }; // prettier-ignore
    };
    const meter = run(false);
    const twin = run(true);
    const before = meter.ticks.filter((t) => t.now < AT).at(-1);
    // Within HUB_GUESS_EPS at Run's end: no guess is carried on…
    assert.equal(meter.ticks[0].guesses, 0, `clock ${clock}: a guess carried past Run`); // prettier-ignore
    // …so the LED switched on at 50 ms (1.39 mA, 2.6 mV through the shunt,
    // inside HUB_EPS) leaves the rail where it stood, as a rail placed by a
    // move would: it was moved there at the next tick at rest, its chips
    // read past the DROOP_EPS hold, mid-run.
    for (const t of meter.ticks.filter((x) => x.now >= AT)) {
      assert.deepEqual(t.hub, before.hub, `clock ${clock}: the far rail moved at ${t.now} s`); // prettier-ignore
    }
    // What the meter reads is its balance there, within HUB_EPS's hold of
    // its twin's shunt (2.6 mV of the chip's 5 V: +1.1e-4).
    assert.ok(Math.abs(meter.amps / twin.amps - 1) < 2e-4, `clock ${clock}: ${meter.amps} A against ${twin.amps}`); // prettier-ignore
    assert.ok(Math.abs(meter.led / twin.led - 1) < 1e-3, `clock ${clock}: LED ${meter.led} A against ${twin.led}`); // prettier-ignore
  }
});
