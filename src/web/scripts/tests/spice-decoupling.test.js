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

// spice-decoupling.test.js — switching spikes and decoupling capacitors
// (sim/spice/engine.js, features/spice-light.md §4.8): an output that
// switches charges its load (the datasheet's test CL) for one pass; on a rail
// with no capacitor across it the spikes add onto the supply's draw and can
// pass its limit (a `supply-spike` warning); with one, the capacitor
// supplies them and the supply sees nothing.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L } from "../sim/levels.js";
import { FAMILY_DEFAULTS } from "../sim/spice/params.js";
import { bench, runner } from "./timing-fixtures.js";

const close = (actual, expected, rel, what) =>
  assert.ok(
    Math.abs(actual - expected) <= Math.abs(expected) * rel,
    `${what}: ${actual} vs ${expected}`,
  );

/** One 74LS04 whose six inputs all hang off one flag, a 51 Ω load holding
    the 100 mA supply just under its limit — and, with `cap`, a capacitor
    across the chip's supply pins (or, with `timing`, one from an input to
    GND instead). */
function sixInverters({ cap = false, timing = false } = {}) {
  const b = bench();
  const u = b.seat("u1", "74LS04", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  b.signal("in", u.get(1), "low");
  for (const [from, to] of [
    [1, 3],
    [3, 5],
    [5, 9],
    [9, 11],
    [11, 13],
  ]) {
    b.link(u.get(from), u.get(to));
  }
  const load = b.seat("r1", "resistor", "a40", { ohms: 51 });
  b.vcc(load.get(1));
  b.gnd(load.get(2));
  if (cap) {
    const c = b.seat("c1", "cap-ceramic", "a50", { farads: 100e-9 });
    b.link(c.get(1), u.get(14));
    b.gnd(c.get(2));
  }
  if (timing) {
    const c = b.seat("c1", "cap-ceramic", "a50", { farads: 100e-9 });
    b.link(c.get(1), u.get(13));
    b.gnd(c.get(2));
  }
  b.doc.components[0].params.currentLimit = 0.1;
  return b.doc;
}

/** Settle with the flag LOW, then raise it: all six outputs switch at once.
    (The first tick is power-up, when every output finds its level — itself
    a spike; the second is quiet.) */
function switchAll(doc) {
  const sim = runner(doc, { engine: "spice" });
  sim.run(0, new Map([["in", L]]));
  const quiet = sim.run(0.005, new Map([["in", L]])).result;
  const edge = sim.run(0.01, new Map([["in", H]])).result;
  return { quiet, edge };
}

const SPIKE = (FAMILY_DEFAULTS["74LS"].loadPf * 1e-12 * 5) / (FAMILY_DEFAULTS["74LS"].delayNs * 1e-9); // prettier-ignore

test("a switching output's spike is its test load charged in one gate delay", () => {
  close(SPIKE, 7.5e-3, 1e-12, "15 pF · 5 V / 10 ns");
});

test("six outputs switching together trip an undecoupled 100 mA supply", () => {
  const { quiet, edge } = switchAll(sixInverters());
  const steady = 5 / 51 + FAMILY_DEFAULTS["74LS"].supplyMa / 1000;
  const before = quiet.supplies.get("psu1");
  close(before.peak, steady, 1e-9, "no switching: the steady draw");
  assert.ok(!quiet.warnings.some((w) => w.type === "supply-spike"));

  const after = edge.supplies.get("psu1");
  close(after.peak, steady + 6 * SPIKE, 1e-9, "six spikes on top");
  const w = edge.warnings.find((x) => x.type === "supply-spike");
  assert.ok(w, "the spike passes the limit");
  assert.equal(w.psu, "psu1");
  assert.equal(w.limit, 0.1);
  // Warned, not glitched: the logic still switched cleanly.
  assert.equal(edge.chipStatus.get("u1").status, "ok");
});

test("a capacitor across the chip's supply pins supplies the spikes", () => {
  const { edge } = switchAll(sixInverters({ cap: true }));
  const steady = 5 / 51 + FAMILY_DEFAULTS["74LS"].supplyMa / 1000;
  close(
    edge.supplies.get("psu1").peak,
    steady,
    1e-9,
    "the supply sees no spike",
  );
  assert.ok(!edge.warnings.some((w) => w.type === "supply-spike"));
});

test("a timing capacitor (on a signal net) is not decoupling", () => {
  const { edge } = switchAll(sixInverters({ timing: true }));
  assert.ok(edge.warnings.some((w) => w.type === "supply-spike"));
});

test("the digital engine has no spikes", () => {
  const sim = runner(sixInverters());
  sim.run(0, new Map([["in", L]]));
  const r = sim.run(0.01, new Map([["in", H]])).result;
  assert.ok(!r.warnings.some((w) => w.type === "supply-spike"));
});
