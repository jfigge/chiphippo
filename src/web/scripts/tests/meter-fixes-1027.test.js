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

// The multimeter's fixes from the 2026-10-27 regrade: a resting desk's
// display after an edge, the shunt's burden in a supply's lead, AC and DC
// through a fuse alike, and the stopped bench's first tick sliced.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { bench, runner } from "./timing-fixtures.js";
import { partDef } from "../catalog/index.js";
import { coldFuse, fuseAmps, fuseBlown, heatFuse } from "../sim/meter-fuse.js";

const { SimController } = await import("../components/sim-controller.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const meterOf = (id, params) => ({ id, kind: "meter", ref: "meter", x: 70, y: 0, params: partDef("meter").normalizeParams(params) }); // prettier-ignore
const quiet = { notify() {}, dismiss() {} };

/** A DeskDoc stand-in over a plain document (meter-sim.test.js's). */
function fakeDoc(raw) {
  const doc = JSON.parse(JSON.stringify(raw));
  return {
    toJSON: () => doc,
    get scopeChannels() {
      return doc.scopeChannels ?? [];
    },
    getComponent: (id) => doc.components.find((c) => c.id === id) ?? null,
    getSignal: (id) => doc.signals?.find((s) => s.id === id) ?? null,
    setComponentParams(id, patch) {
      const c = doc.components.find((x) => x.id === id);
      c.params = partDef(c.ref).normalizeParams({ ...c.params, ...patch });
      return c;
    },
  };
}

/** Run `raw` under Spice Lite; `shown` collects [wall ms, dmm1's window]. */
function startRun(raw) {
  resetDom();
  const sim = new SimController({ deskDoc: fakeDoc(raw), notifications: quiet }); // prettier-ignore
  sim.setSpiceLite({ enabled: true });
  const shown = [];
  const t0 = performance.now();
  let last = null;
  const onState = (e) => {
    const w = e.detail.meters?.get("dmm1");
    if (w && w !== last) shown.push([performance.now() - t0, (last = w)]);
  };
  window.addEventListener("chiphippo:sim-state", onState);
  sim.start();
  const end = () => {
    sim.stop();
    window.removeEventListener("chiphippo:sim-state", onState);
  };
  return { sim, shown, t0, end };
}

test("a held signal shows its new level within one 200 ms update, the desk at rest", async () => {
  const b = bench({ volts: 5 });
  const r = b.seat("r1", "resistor", "a10", { ohms: 10000 });
  b.gnd(r.get(2));
  b.signal("sg1", "b10", "low");
  b.doc.components.push(meterOf("dmm1", { dial: "v", red: { at: b.at("d10") }, black: { at: "psu1.-" } })); // prettier-ignore
  const { sim, shown, t0, end } = startRun(b.doc);
  await sleep(450);
  const pressed = performance.now() - t0;
  sim.pressSignal("sg1", true);
  await sleep(450);
  end();
  const after = shown.filter(([at]) => at >= pressed);
  // (Before the fix the window taken at the press — the level before it —
  // stood until the release.)
  assert.ok(after.some(([at, w]) => at - pressed < 330 && Math.abs(w.mean - 5) < 0.01), JSON.stringify(after.map(([at, w]) => [Math.round(at - pressed), w.mean]))); // prettier-ignore
  assert.ok(Math.abs(after.at(-1)[1].mean - 5) < 0.01, "and stays there");
});

test("a 1 Hz clock's level shows within one update of each edge", async () => {
  const b = bench({ volts: 5 });
  const r = b.seat("r1", "resistor", "a10", { ohms: 1000 });
  b.gnd(r.get(2));
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: partDef("clock").normalizeParams({ hz: 1, wave: "square" }) }); // prettier-ignore
  b.doc.wires.push({ id: "wc1", from: "clk1.out", to: b.at("c10"), color: "red" }, { id: "wc2", from: "clk1.gnd", to: "psu1.-", color: "black" }, { id: "wc3", from: "clk1.vcc", to: "psu1.+", color: "red" }); // prettier-ignore
  b.doc.components.push(meterOf("dmm1", { dial: "v", red: { at: b.at("b10") }, black: { at: "psu1.-" } })); // prettier-ignore
  const { shown, end } = startRun(b.doc);
  await sleep(1300);
  end();
  // Each half-cycle (0.5 s of wall time from 0, ±a batch) is shown at its
  // own level before it ends: 0 V from 0, 5 V from 0.5, 0 V from 1.0 —
  // the HIGH through the brick's 50 Ω into 1 kΩ (spice/output-stage.js
  // `CLOCK_OHMS`).
  const levelIn = (from, to) =>
    shown.filter(([at]) => at > from && at < to).map(([, w]) => w.mean);
  for (const [from, level] of [
    [500, (5 * 1000) / 1050],
    [1000, 0],
  ]) {
    const seen = levelIn(from, from + 380);
    assert.ok(seen.some((v) => Math.abs(v - level) < 0.01), `${level} V after ${from} ms: ${seen}`); // prettier-ignore
  }
});

/** A meter's reading on a Spice Lite tick at `t`: its own element's, off
    the solve — a meter in a supply's lead is its shunt there too. */
function readAt(doc, t, id = "dmm1") {
  const run = runner(doc, { engine: "spice" });
  for (const at of [0, t]) run.run(at);
  return { ...run.result.bench?.get(id), run };
}

test("an ammeter in a supply's lead drops its shunt's volts: µA in series with 5 V / 1 kΩ reads 4.545 mA", () => {
  for (const [dial, ohms, shunt] of [
    ["ua", 1000, 100],
    ["ma", 100, 1.9],
  ]) {
    const b = bench({ volts: 5 });
    const r = b.seat("r1", "resistor", "a20", { ohms });
    b.gnd(r.get(2));
    b.doc.components.push(meterOf("dmm1", { dial, jack: "ma", red: { at: "psu1.+" }, black: { at: b.at("c20") } })); // prettier-ignore
    const m = readAt(b.doc, 0.01);
    const want = 5 / (ohms + shunt);
    assert.ok(Math.abs(m.amps - want) < 1e-4 * want, `${dial}: ${m.amps} for ${want}`); // prettier-ignore
  }
  // …and an LED's current is what the shunt leaves it (the solve's, no
  // formula): less than with a wire in its place.
  const led = (meter) => {
    const b = bench({ volts: 5 });
    const r = b.seat("r1", "resistor", "a20", { ohms: 330 });
    const d = b.seat("d1", "led", "b24");
    b.link(r.get(2).replace(/^a/, "e"), d.get(1).replace(/^b/, "d"));
    b.gnd(d.get(2).replace(/^b/, "e"));
    if (meter)
      b.doc.components.push(meterOf("dmm1", { dial: "ua", jack: "ma", red: { at: "psu1.+" }, black: { at: b.at("c20") } })); // prettier-ignore
    else b.vcc("c20");
    const m = readAt(b.doc, 0.01);
    return { amps: meter ? m.amps : m.run.result.lamps.get("d1").amps, led: m.run.result.lamps.get("d1") }; // prettier-ignore
  };
  const wired = led(false);
  const metered = led(true);
  // 330 Ω and the µA shunt's 100 Ω across what the LED leaves — 7.3 mA,
  // where scaling the wired 9.4 mA by the shunt's drop said 7.9.
  const want = (5 - metered.led.volts) / 430;
  assert.ok(Math.abs(metered.amps - want) < 1e-3 * want, `${metered.amps} for ${want}`); // prettier-ignore
  assert.ok(Math.abs(metered.led.amps - metered.amps) < 1e-6, "the LED's own current"); // prettier-ignore
  assert.ok(metered.amps < wired.amps * 0.8, `${metered.amps} through the meter, ${wired.amps} wired`); // prettier-ignore
});

/**
 * A supply's + lead (or, `minus`, its −) metered at `dial` — or, `twin`, a
 * plain resistor of the shunt's ohms in its place — feeding `build(b, far)`
 * (`far` a hole on the net past it). Ticked at `ts`; each tick's
 * `{amps, far, result}`, `amps` the meter's reading or the resistor's
 * current.
 */
function leadRun(dial, minus, twin, build, ts = [0, 0.01, 0.05]) {
  const b = bench({ volts: 5 });
  const far = "c5";
  build(b, far);
  const shunt = { ua: 100, ma: 1.9, a: 0.04 }[dial];
  if (twin) {
    const r = b.seat("rm", "resistor", "a58", { ohms: shunt });
    b[minus ? "gnd" : "vcc"](r.get(2).replace(/^a/, "c"));
    b.link(r.get(1).replace(/^a/, "c"), "e5");
  } else {
    const [red, black] = minus ? [b.at("d5"), "psu1.-"] : ["psu1.+", b.at("d5")]; // prettier-ignore
    b.doc.components.push(meterOf("dmm1", { dial, jack: dial === "a" ? "a" : "ma", red: { at: red }, black: { at: black } })); // prettier-ignore
  }
  const run = runner(b.doc, { engine: "spice" });
  return ts.map((t) => {
    const { result } = run.run(t);
    const v = result.nodeVolts.get(run.netlist.netOfPoint.get(b.at("a5")));
    const amps = twin ? (minus ? v : 5 - v) / shunt : result.bench.get("dmm1").amps; // prettier-ignore
    return { amps, far: v, result };
  });
}

/** A 74LS04 fed from `far` (its + side, or its ground — `minus`), its
    input on its own ground and its output HIGH into 330 Ω and a red LED
    `l1` to that ground. */
const ls04Led = (minus) => (b, far) => {
  const u = b.seat("u1", "74LS04", "e20");
  const vcc = u.get(14).replace(/^f/, "j");
  const gnd = u.get(7).replace(/^e/, "a");
  b.link(minus ? gnd : vcc, far);
  b[minus ? "vcc" : "gnd"](minus ? vcc : gnd);
  // (Each tied in its ground pin's own column: a node holds five leads.)
  b.link(u.get(1).replace(/^e/, "b"), minus ? gnd.replace(/^a/, "b") : "j50"); // prettier-ignore
  if (!minus) b.gnd("f50");
  const r = b.seat("r1", "resistor", "a40", { ohms: 330 });
  b.link(u.get(2).replace(/^e/, "c"), r.get(1));
  const l = b.seat("l1", "led", "a45", { color: "red" });
  b.link(r.get(2), l.get(1));
  b.link(l.get(2), minus ? gnd.replace(/^a/, "c") : "j51");
  if (!minus) b.gnd("f51");
};

test("a meter in a supply's lead is its shunt, and what lies past it is fed through it: as its resistor twin, every tick", () => {
  // µA in the + lead → a 74LS04 (HIGH) → 330 Ω + red LED, and the same in
  // the − lead, the chip measured from its lifted ground (the regrade: from
  // 0 V, −16 % on µA). The same desk with a 100 Ω resistor in the meter's
  // place reads the same: the meter decides nothing of its own — it read
  // 1.600 and 5.955 mA by turns, and joined, kept a browned-out chip
  // driving that its resistor twin turned off.
  for (const minus of [false, true]) {
    const metered = leadRun("ua", minus, false, ls04Led(minus), [0, 0.001, 0.005, 0.01, 0.05, 0.1]); // prettier-ignore
    const twin = leadRun("ua", minus, true, ls04Led(minus), [0, 0.001, 0.005, 0.01, 0.05, 0.1]); // prettier-ignore
    const seen = new Set();
    metered.forEach((m, i) => {
      const t = twin[i];
      seen.add(m.amps.toFixed(7));
      assert.ok(Math.abs(m.amps / t.amps - 1) < 1e-3, `${minus ? "−" : "+"} lead tick ${i}: ${m.amps} A, its twin ${t.amps}`); // prettier-ignore
      assert.ok(Math.abs(m.far - t.far) < 6e-3, `the net past it at ${m.far} V, its twin's ${t.far}`); // prettier-ignore
      const led = (r) => r.result.lamps.get("l1").amps;
      assert.ok(Math.abs(led(m) / led(t) - 1) < 2e-3, `its LED ${led(m)} A, its twin's ${led(t)}`); // prettier-ignore
      assert.equal(m.result.chipStatus.get("u1").status, t.result.chipStatus.get("u1").status); // prettier-ignore
    });
    assert.equal(seen.size, 1, [...seen].join(" / "));
  }
});

test("a meter in each lead of one supply: both carry the one current, the + one too", () => {
  // The regrade's HIGH: the + meter read 0 and dropped nothing.
  const b = bench({ volts: 5 });
  const u = b.seat("u1", "74LS00", "e40");
  const rl = b.seat("rl", "resistor", "a20", { ohms: 1000 });
  b.link(u.get(14).replace(/^f/, "j"), "c5");
  b.link(rl.get(1), "b5");
  b.link(u.get(7).replace(/^e/, "a"), "c8");
  b.link(rl.get(2), "b8");
  b.doc.components.push(meterOf("dmm1", { dial: "ua", jack: "ma", red: { at: "psu1.+" }, black: { at: b.at("d5") } })); // prettier-ignore
  b.doc.components.push(meterOf("dmm2", { dial: "ma", jack: "ma", red: { at: b.at("d8") }, black: { at: "psu1.-" } })); // prettier-ignore
  const run = runner(b.doc, { engine: "spice" });
  for (const t of [0, 0.01, 0.05]) run.run(t);
  const v = (hole) => run.result.nodeVolts.get(run.netlist.netOfPoint.get(b.at(hole))); // prettier-ignore
  const [p, m] = ["dmm1", "dmm2"].map((id) => run.result.bench.get(id).amps);
  assert.ok(Math.abs(p / m - 1) < 1e-4, `+ ${p} A, − ${m} A`);
  // The drops, each its own shunt's (ngspice: 4.4182 V and 0.011053 V —
  // the golden `meter-both-leads-ua-ma-1k`).
  assert.ok(Math.abs(5 - v("a5") - 100 * p) < 1e-3, `+ rail ${v("a5")} V`);
  assert.ok(Math.abs(v("a8") - 1.9 * m) < 1e-4, `− rail ${v("a8")} V`);
  assert.ok(Math.abs(v("a5") - 4.4182) < 2e-3 && Math.abs(v("a8") - 0.011053) < 1e-4); // prettier-ignore
});

test("a meter's drop is the net past it alone: the supply's side keeps its volts, two meters in series each their own", () => {
  // psu1 → µA → column 5 → mA → column 8 (a 74LS00 and 4.7 kΩ), a 330/330
  // divider straight across psu1 (lowered with the shunts it read 2.370).
  const b = bench({ volts: 5 });
  const u = b.seat("u1", "74LS00", "e40");
  const rl = b.seat("rl", "resistor", "a20", { ohms: 4700 });
  b.link(u.get(14).replace(/^f/, "j"), "c8");
  b.gnd(u.get(7).replace(/^e/, "a"));
  b.link(rl.get(1), "b8");
  b.gnd(rl.get(2));
  const s1 = b.seat("s1", "resistor", "f20", { ohms: 330 });
  const s2 = b.seat("s2", "resistor", "f30", { ohms: 330 });
  b.vcc(s1.get(1));
  b.link(s1.get(2), s2.get(1));
  b.gnd(s2.get(2));
  b.doc.components.push(meterOf("dmm1", { dial: "ua", jack: "ma", red: { at: "psu1.+" }, black: { at: b.at("d5") } })); // prettier-ignore
  b.doc.components.push(meterOf("dmm2", { dial: "ma", jack: "ma", red: { at: b.at("e5") }, black: { at: b.at("d8") } })); // prettier-ignore
  const run = runner(b.doc, { engine: "spice" });
  for (const t of [0, 0.01, 0.05]) run.run(t);
  const v = (hole) => run.result.nodeVolts.get(run.netlist.netOfPoint.get(b.at(hole))); // prettier-ignore
  const [a, c] = ["dmm1", "dmm2"].map((id) => run.result.bench.get(id).amps);
  assert.ok(Math.abs(a / c - 1) < 1e-4, `${a} A and ${c} A in series`);
  assert.ok(Math.abs(5 - v("a5") - 100 * a) < 1e-3, `past µA ${v("a5")} V`);
  assert.ok(Math.abs(v("a5") - v("a8") - 1.9 * c) < 1e-3, `past mA ${v("a8")} V`); // prettier-ignore
  assert.ok(Math.abs(v(s1.get(2)) - 2.5) < 1e-9, "the divider on the supply's side"); // prettier-ignore
  assert.equal(run.result.supplies.get("psu1").volts, 5);
});

test("a busy board past a meter in either lead reads the supply's own current, and runs at its own speed", () => {
  // Every chip off the rails past the shunt: each net its outputs drive is
  // still solved alone (spice/voltages.js `hubStage`), and a 74LS input's
  // bias is inside its chip's ICC either side of the meter — drawn from
  // the supply pin, the board read 40 mA where the supply delivers 25.
  const doc = (lead) => {
    const b = bench({ volts: 5 });
    for (let k = 0; k < 4; k++) {
      const u = b.seat(`u${k}`, "74LS04", `e${10 + 10 * k}`);
      const vcc = u.get(14).replace(/^f/, "j");
      const gnd = u.get(7).replace(/^e/, "a");
      if (lead === "+") b.link(vcc, "c5");
      else b.vcc(vcc);
      if (lead === "-") b.link(gnd, "c8");
      else b.gnd(gnd);
      // (Each tied in its ground pin's own column.)
      b.link(u.get(1).replace(/^e/, "b"), gnd.replace(/^a/, "b"));
      const r = b.seat(`r${k}`, "resistor", `a${44 + 5 * k}`, { ohms: 1000 });
      b.link(u.get(2).replace(/^e/, "c"), r.get(1));
      b.link(r.get(2), gnd.replace(/^a/, "c"));
    }
    if (lead === "+") b.doc.components.push(meterOf("dmm1", { dial: "ma", jack: "ma", red: { at: "psu1.+" }, black: { at: b.at("d5") } })); // prettier-ignore
    if (lead === "-") b.doc.components.push(meterOf("dmm1", { dial: "ma", jack: "ma", red: { at: b.at("d8") }, black: { at: "psu1.-" } })); // prettier-ignore
    return b.doc;
  };
  const plain = runner(doc("none"), { engine: "spice" }).run(0.01).result;
  for (const lead of ["+", "-"]) {
    const run = runner(doc(lead), { engine: "spice" });
    run.run(0);
    const { result } = run.run(0.01);
    const amps = result.bench.get("dmm1").amps;
    const want = plain.supplies.get("psu1").amps;
    assert.ok(Math.abs(amps / want - 1) < 0.01, `${lead} lead: ${amps} A, the supply alone ${want}`); // prettier-ignore
    assert.ok(Math.abs(result.supplies.get("psu1").amps / amps - 1) < 0.01, "the supply delivers what the meter reads"); // prettier-ignore
  }
});

test("a meter whose far net a second supply feeds through a resistor reads the current back", () => {
  // psu1 (limited to 0.1 A by a 10 Ω load on its side) → the meter → a
  // 74LS00's VCC and 100 Ω to ground; psu2 feeds the same net through
  // 100 Ω. Joined, the meter read psu1's own draws only: +9.35 mA, where
  // ~32 mA flowed back into psu1 (the regrade, 2026-10-27).
  const b = bench({ volts: 5 });
  b.doc.components[0].params.currentLimit = 0.1;
  b.doc.components.push({ id: "psu2", kind: "psu", ref: "psu", x: 20, y: 30, params: { volts: 5 } }); // prettier-ignore
  const heavy = b.seat("rh", "resistor", "a40", { ohms: 10 });
  b.vcc(heavy.get(1));
  b.gnd(heavy.get(2));
  const rl = b.seat("rl", "resistor", "a10", { ohms: 100 });
  b.gnd(rl.get(2));
  const rf = b.seat("rf", "resistor", "f10", { ohms: 100 });
  b.tie("psu2.+", rf.get(2));
  b.tie("psu2.-", "j60");
  b.gnd("f60");
  b.link("a60", "j60");
  b.link("b10", "g10");
  const u = b.seat("u1", "74LS00", "e25");
  b.link(u.get(14).replace(/^f/, "j"), "h10");
  b.gnd(u.get(7).replace(/^e/, "a"));
  b.doc.components.push(meterOf("dmm1", { dial: "ma", jack: "a", red: { at: "psu1.+" }, black: { at: b.at("c10") } })); // prettier-ignore
  const run = runner(b.doc, { engine: "spice" });
  for (const t of [0, 0.01, 0.05, 0.1, 0.2, 0.3]) run.run(t);
  const m = run.result.bench.get("dmm1");
  const far = run.result.nodeVolts.get(run.netlist.netOfPoint.get(b.at("b10"))); // prettier-ignore
  // What rl takes less what rf brings, and the chip's own current.
  const resistive = far / 100 - (5 - far) / 100;
  assert.ok(m.amps < 0, `${m.amps} A: back into psu1`);
  assert.ok(Math.abs(m.amps - resistive) < 2e-3, `${m.amps} A against ${resistive} A and the chip's ICC`); // prettier-ignore
});

test("a fuse judges AC and DC alike, by the RMS: 0.41 A blows either way, 0.399 A neither", () => {
  const fuse = { amps: 0.4 };
  const blows = (current, until = 2, dt = 1e-4, ramp = true) => {
    const f = coldFuse(0);
    for (let t = 0; t <= until; t += dt) {
      heatFuse(f, fuse, t, Math.abs(current(t)), ramp);
      if (fuseBlown(f, t)) return { at: t, amps: fuseAmps(f, t) };
    }
    return null;
  };
  const sine = (rms, hz) => (t) => rms * Math.SQRT2 * Math.sin(2 * Math.PI * hz * t); // prettier-ignore
  for (const hz of [50, 60]) {
    // (Judged on the heat alone, its ripple dipped 0.41 A RMS under the
    // rating every half cycle, and it never blew.)
    const hot = blows(sine(0.41, hz));
    assert.ok(hot, `0.41 A RMS at ${hz} Hz blows`);
    assert.ok(Math.abs(hot.amps - 0.41) < 0.01, `the toast's RMS ${hot.amps}`); // prettier-ignore
    assert.equal(blows(sine(0.399, hz)), null, `0.399 A RMS at ${hz} Hz`);
    // The toast's figure is never a peak (0.92 A RMS peaks at 1.3).
    assert.ok(Math.abs(blows(sine(0.92, hz)).amps - 0.92) < 0.06);
  }
  const dc = blows(() => 0.41);
  assert.ok(Math.abs(dc.at - 0.0404) < 1e-3, `DC 0.41 A at ${dc.at}`);
  assert.ok(Math.abs(dc.amps - 0.41) < 1e-9);
  assert.equal(
    blows(() => 0.399),
    null,
  );
  // A step from a warm 0.1 A to 1.25 A: ~11 ms, and 1.25 A quoted — a
  // step as the ticks book one, held to it and stepped (a ramp across one
  // sample is a ramp, and its stretch begins at its foot).
  const step = blows((t) => (t < 0.5 ? 0.1 : 1.25), 2, 1e-4, false);
  assert.ok(Math.abs(step.at - 0.511) < 1e-3, `${step.at}`);
  assert.ok(Math.abs(step.amps - 1.25) < 1e-9);
});

test("a blown fuse's toast quotes the RMS over whole half-cycles, the record begun past the zero crossing", () => {
  const fuse = { amps: 0.4 };
  // As SimController feeds it: a cool fuse is forgotten, so the record
  // begins at the first sample with a current (two-thirds of a millisecond
  // past the zero crossing), then ramps between samples — magnitudes, or
  // signed (a ramp through zero split at the crossing).
  const quote = (rms, hz, signed) => {
    const i = (t) => rms * Math.SQRT2 * Math.sin(2 * Math.PI * hz * t);
    const dt = 1 / hz / 50;
    const f = coldFuse(0.000663);
    for (let t = 0.000663; t < 0.2; t += dt) {
      heatFuse(f, fuse, t, signed ? i(t) : Math.abs(i(t)), true);
      if (fuseBlown(f, t)) return fuseAmps(f, t);
    }
    return null;
  };
  for (const hz of [50, 60]) {
    for (const rms of [0.6, 0.92, 2]) {
      for (const signed of [false, true]) {
        const q = quote(rms, hz, signed);
        // (Quoted over the overload from the first instant past the
        // rating, 0.6 A RMS read 0.653.)
        assert.ok(Math.abs(q / rms - 1) < 0.01, `${rms} A RMS at ${hz} Hz quoted ${q}`); // prettier-ignore
      }
    }
  }
});

test("a stopped bench's first tick is a task of its own, each meter's in turn", async () => {
  resetDom();
  const { MeterBench } = await import("../components/meter-bench.js");
  const b = bench({ volts: 5 });
  const r = b.seat("r1", "resistor", "a10", { ohms: 1000 });
  const ends = [r.get(1), r.get(2)].map((h) => ({ at: b.at(h.replace(/^a/, "c")) })); // prettier-ignore
  for (const [i, dial] of ["ohm", "ohm", "diode"].entries()) b.doc.components.push(meterOf(`dmm${i + 1}`, { dial, red: ends[0], black: ends[1] })); // prettier-ignore
  const doc = b.doc;
  const views = new Map(["dmm1", "dmm2", "dmm3"].map((id) => [id, { shown: [], setOffline(r) { this.shown.push(r); } }])); // prettier-ignore
  // Every timer queued and run by hand, one task at a time.
  const queue = [];
  const real = [globalThis.setTimeout, globalThis.clearTimeout];
  globalThis.setTimeout = window.setTimeout = (fn, ms) => queue.push({ fn, ms }); // prettier-ignore
  globalThis.clearTimeout = window.clearTimeout = (id) => { if (queue[id - 1]) queue[id - 1].fn = () => {}; }; // prettier-ignore
  try {
    const meters = new MeterBench({ toJSON: () => doc, getComponent: (id) => doc.components.find((c) => c.id === id) }, views); // prettier-ignore
    window.dispatchEvent(new CustomEvent("chiphippo:sim-state", { detail: { running: false } })); // prettier-ignore
    meters.setSpiceLite(true, { enabled: true });
    const start = queue.findLast((q) => q.ms > 0);
    start.fn(); // #start: the benches built, none ticked
    for (const v of views.values()) assert.equal(v.shown.filter(Boolean).length, 0, "no reading in #start's task"); // prettier-ignore
    for (let n = 0; n < 50; n++) {
      const next = queue.find((q) => q.ms === 0 && !q.ran);
      if (!next) break;
      next.ran = true;
      next.fn();
    }
    for (const [id, v] of views) assert.ok(v.shown.some((s) => s?.volts > 0), `${id} reads`); // prettier-ignore
  } finally {
    [globalThis.setTimeout, globalThis.clearTimeout] = real;
    [window.setTimeout, window.clearTimeout] = real;
  }
});
