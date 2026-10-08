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

// Inductors under Spice Lite (features/done/spice-lite-3-plan.md, Phase 3): a
// branch of the voltage solve whose current is its state, its winding's
// resistance its Winding grade's, and — switched off with nowhere for its
// current to go — a kick into the switching transistor's breakdown. The
// digital engine still runs it as a wire. The ngspice references are
// spice-golden.test.js's "inductors" area; these hold the mechanics.

import test from "node:test";
import assert from "node:assert/strict";
import { H, L } from "../sim/levels.js";
import { buildNetlist } from "../sim/netlist.js";
import { partDef } from "../catalog/index.js";
import {
  DEFAULT_WINDING,
  INDUCTOR_WINDINGS,
  WINDING_FACTOR,
  inductorOhms,
} from "../catalog/discretes.js";
import { BJT_GRADES } from "../sim/spice/transistors.js";
import { bench, runner } from "./timing-fixtures.js";

/** +5 V → `ohms` → an inductor → GND. */
function rlStep({ henries = 0.1, ohms = 100 } = {}) {
  const b = bench();
  const r = b.seat("r1", "resistor", "a20", { ohms });
  const l = b.seat("l1", "inductor", "a30", henries ? { henries } : {});
  b.vcc(r.get(1));
  b.link(r.get(2), l.get(1));
  b.gnd(l.get(2));
  return { b, r, l };
}

/** A relay coil (100 mH can) switched by a 2N3904-like NPN off signal s1,
    with or without a flyback diode across it. */
function relay(flyback) {
  const b = bench();
  const q = b.seat("q1", "npn", "a30");
  b.gnd(q.get(1));
  const rb = b.seat("rb", "resistor", "a40", { ohms: 1e3 });
  b.link(rb.get(2), q.get(2));
  b.signal("s1", rb.get(1), "low");
  const coil = b.seat("l1", "inductor", "a50", { henries: 0.1, style: "can" });
  b.vcc(coil.get(1));
  b.link(coil.get(2), q.get(3));
  if (flyback) {
    const d = b.seat("d1", "diode", "a10");
    b.link(d.get(1), q.get(3));
    b.vcc(d.get(2));
  }
  return { b, q, coil };
}

/** Run a desk from `from` to `until`, ticking at its own wakes between and
    at `until` itself. */
function runTo(sim, from, until, levels) {
  let r = sim.run(from, levels).result;
  const seen = [r];
  for (let i = 0; i < 5000 && r.wakeAt != null && r.wakeAt < until; i++) {
    r = sim.run(r.wakeAt, levels).result;
    seen.push(r);
  }
  r = sim.run(until, levels).result;
  seen.push(r);
  return { r, seen };
}

test("only Spice Lite's netlist carries an inductor as a branch; a bare one is a wire in both", () => {
  const { b, r, l } = rlStep();
  const at = (pin) => b.at(pin);
  const wire = buildNetlist(b.doc, new Map());
  const branch = buildNetlist(b.doc, new Map(), { inductors: "branch" });
  assert.equal(
    wire.netOfPoint.get(at(l.get(1))),
    wire.netOfPoint.get(at(l.get(2))),
    "the digital engine's: one net",
  );
  assert.notEqual(
    branch.netOfPoint.get(at(l.get(1))),
    branch.netOfPoint.get(at(l.get(2))),
    "Spice Lite's: two",
  );
  // No Inductance: a wire, whichever netlist.
  const bare = rlStep({ henries: null });
  const bareNet = buildNetlist(bare.b.doc, new Map(), { inductors: "branch" });
  assert.equal(
    bareNet.netOfPoint.get(bare.b.at(bare.l.get(1))),
    bareNet.netOfPoint.get(bare.b.at(bare.l.get(2))),
  );
  assert.ok(r, "the resistor seated");
});

test("an inductor's current rises along L/R, its winding's resistance in R", () => {
  const { b } = rlStep();
  const sim = runner(b.doc, { engine: "spice" });
  const rw = inductorOhms(b.doc.components.find((c) => c.id === "l1").params);
  const tau = 0.1 / (100 + rw);
  const final = 5 / (100 + rw);
  for (const t of [0, tau / 2, tau, 2 * tau, 5 * tau]) {
    const amps = sim.run(t).result.analog.coilAmps.get("l1");
    const want = final * (1 - Math.exp(-t / tau));
    assert.ok(
      Math.abs(amps - want) <= 0.01 * final,
      `at ${t}: ${amps} A, want ${want}`,
    );
  }
});

test("a winding grade scales its body's typical resistance; Typical is stored as nothing", () => {
  const params = (winding) => ({ henries: 1e-3, style: "coil", bodyHoles: 2, ...(winding ? { winding } : {}) }); // prettier-ignore
  const typical = inductorOhms(params());
  assert.ok(Math.abs(typical - 0.74) < 1e-9, "the 2-hole toroid's fit at 1 mH");
  for (const w of INDUCTOR_WINDINGS) {
    assert.ok(
      Math.abs(inductorOhms(params(w)) - typical * WINDING_FACTOR[w]) < 1e-12,
    );
  }
  // More inductance, more resistance — but not in proportion (finer wire).
  const tenfold = inductorOhms({ ...params(), henries: 1e-2 });
  assert.ok(tenfold > typical * 5 && tenfold < typical * 10);
  assert.equal(inductorOhms({ style: "coil" }), null, "no inductance: a wire");
  const def = partDef("inductor");
  assert.ok(!("winding" in def.normalizeParams(params(DEFAULT_WINDING))));
  assert.ok(!("winding" in def.normalizeParams(params("bogus"))));
  assert.equal(def.normalizeParams(params("highest")).winding, "highest");
});

test("a relay coil switched off decays through its flyback diode, with no kick", () => {
  const { b, q } = relay(true);
  const sim = runner(b.doc, { engine: "spice" });
  const on = new Map([["s1", H]]);
  const off = new Map([["s1", L]]);
  const { r: held } = runTo(sim, 0, 0.02, on);
  const i0 = held.analog.coilAmps.get("l1");
  assert.ok(i0 > 0.03, `the coil carries its current: ${i0} A`);
  const { r, seen } = runTo(sim, 0.02, 0.03, off);
  const col = sim.netlist.netOfPoint.get(b.at(q.get(3)));
  const peak = Math.max(...seen.map((x) => x.nodeVolts.get(col) ?? 0));
  assert.ok(peak < 6, `clamped a diode drop over the rail: ${peak} V`);
  assert.ok(Math.abs(r.analog.coilAmps.get("l1")) < 1e-3 * i0, "decayed");
  for (const x of seen) {
    assert.ok(!x.warnings.some((w) => w.type === "inductive-kick"));
  }
});

test("with no flyback diode, the coil kicks the transistor into breakdown, and says so", () => {
  const { b } = relay(false);
  const sim = runner(b.doc, { engine: "spice" });
  const on = new Map([["s1", H]]);
  const off = new Map([["s1", L]]);
  const { r: held } = runTo(sim, 0, 0.02, on);
  const i0 = held.analog.coilAmps.get("l1");
  const { seen } = runTo(sim, 0.02, 0.03, off);
  const kicks = seen.flatMap((x) => x.warnings.filter((w) => w.type === "inductive-kick")); // prettier-ignore
  assert.ok(kicks.length > 0, "an inductive-kick warning");
  const kick = kicks[0];
  assert.equal(kick.comp, "q1", "on the transistor that switched it");
  assert.ok(kick.volts > BJT_GRADES.npn["small-signal"].vceoV, `past its breakdown: ${kick.volts} V`); // prettier-ignore
  const energy = 0.5 * 0.1 * i0 * i0;
  assert.ok(
    Math.abs(kick.joules - energy) <= 0.05 * energy,
    `½LI²: ${kick.joules} J vs ${energy}`,
  );
});
