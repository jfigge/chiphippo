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

// spice-sag.test.js — what a chip loses in the jumper wires to its supply
// (sim/spice/sag.js, features/spice-light.md §4.7): 24 AWG copper at each
// wire's real length, every draw routed along its lowest-resistance path, and
// a chip fed through another's wiring sagging by the current they share.

import test from "node:test";
import assert from "node:assert/strict";

import { FAMILY_DEFAULTS } from "../sim/spice/params.js";
import {
  WIRE_OHMS_PER_M,
  sagTopology,
  supplySag,
  wireOhms,
} from "../sim/spice/sag.js";
import { buildNetlist } from "../sim/netlist.js";
import { wireCutMm } from "../model/wire-length.js";
import { bench, runner } from "./timing-fixtures.js";

const close = (actual, expected, rel, what) =>
  assert.ok(
    Math.abs(actual - expected) <= Math.abs(expected) * rel,
    `${what}: ${actual} vs ${expected}`,
  );

test("a wire's resistance is 24 AWG copper at its cut length", () => {
  assert.equal(WIRE_OHMS_PER_M, 0.0842);
  const b = bench();
  const u = b.seat("u1", "74LS04", "e10");
  b.vcc(u.get(14));
  const id = b.doc.wires[0].id;
  close(
    wireOhms(b.doc, id),
    (wireCutMm(b.doc, id) / 1000) * 0.0842,
    1e-12,
    "R",
  );
  assert.ok(wireOhms(b.doc, id) > 0);
});

/** Two 74LS04s, the second fed THROUGH the first's VCC node by a jumper, and
    a 2 Ω load (2.5 A) hung on the far end — on a 5 A supply. */
function chain({ signal = false } = {}) {
  const b = bench();
  const u1 = b.seat("u1", "74LS04", "e10");
  const u2 = b.seat("u2", "74LS04", "e40");
  b.vcc(u1.get(14)); // the feed
  b.link(u1.get(14), u2.get(14)); // the chain
  b.gnd(u1.get(7));
  b.gnd(u2.get(7));
  const r = b.seat("r1", "resistor", "a55", { ohms: 2 });
  b.link(r.get(1), u2.get(14));
  b.gnd(r.get(2));
  b.doc.components[0].params.currentLimit = 5;
  // The first inverter's 1Y driving the second's 1A — one signal between two
  // chips on ONE supply that sag by different amounts.
  if (signal) b.link(u1.get(2), u2.get(1));
  const [feed, link, g1, g2] = b.doc.wires.map((w) => w.id);
  return { doc: b.doc, feed, link, g1, g2, vccFar: u2.get(14) };
}

test("the far chip sags by the current its wires share", () => {
  const { doc, feed, link, g1, g2 } = chain();
  const R = (id) => wireOhms(doc, id);
  const icc = FAMILY_DEFAULTS["74LS"].supplyMa / 1000;
  const load = 5 / 2;
  const r = runner(doc, { engine: "spice" }).run(0).result;

  // The feed carries everything; the chain both the far chip and the load.
  const far = (2 * icc + load) * R(feed) + (icc + load) * R(link) + icc * R(g2);
  const near = (2 * icc + load) * R(feed) + icc * R(g1);
  close(r.sag.get("u2").drop, far, 1e-9, "far chip");
  close(r.sag.get("u1").drop, near, 1e-9, "near chip");
  assert.ok(r.sag.get("u2").drop > r.sag.get("u1").drop);
  // The engine saw it: the far chip's supply is 5 V less its drop.
  close(r.chipStatus.get("u2").volts, 5 - far, 1e-9, "the far chip's supply");
  close(r.sag.get("u2").volts, 5 - far, 1e-9, "reported");
});

test("a drop under a millivolt is not applied", () => {
  const b = bench();
  const u = b.seat("u1", "74LS04", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  const r = runner(b.doc, { engine: "spice" }).run(0).result;
  assert.equal(r.sag.size, 0);
  assert.equal(r.chipStatus.get("u1").volts, 5);
});

test("routing: a draw follows the wires to it, and no path means no drop", () => {
  const { doc, feed, link, vccFar } = chain();
  const draws = [
    { chip: "x", psu: "psu1", plusAt: `bb1.${vccFar}`, minusAt: null, amps: 1 },
    { chip: "y", psu: "psu1", plusAt: "bb1.a63", minusAt: null, amps: 1 },
  ];
  const { drops, wireAmps } = supplySag(doc, buildNetlist(doc), draws);
  assert.equal(wireAmps.get(feed), 1);
  assert.equal(wireAmps.get(link), 1);
  close(drops.get("x"), wireOhms(doc, feed) + wireOhms(doc, link), 1e-12, "1 A through both"); // prettier-ignore
  assert.equal(drops.get("y"), 0, "an unwired node: nothing to drop across");
});

test("a chip sagging in its wires is still on its supply: no mixed-supply warning", () => {
  const { doc } = chain({ signal: true });
  const r = runner(doc, { engine: "spice" }).run(0).result;
  // The two chips really do see different voltages ...
  assert.ok(
    Math.abs(r.chipStatus.get("u1").volts - r.chipStatus.get("u2").volts) >
      1e-3,
  );
  // ... but a wire's drop is not a second supply, so 1Y → 1A is not a
  // boundary between supplies.
  assert.deepEqual(
    r.warnings.filter((w) => w.type === "mixed-supply"),
    [],
  );
});

test("the wiring graph is read once per netlist", () => {
  const { doc } = chain();
  const netlist = buildNetlist(doc);
  const topo = sagTopology(doc, netlist);
  assert.equal(sagTopology(doc, netlist), topo, "the same netlist: cached");
  assert.equal(
    topo.pathsFrom("psu1.+"),
    topo.pathsFrom("psu1.+"),
    "and each source's paths with it",
  );
  assert.notEqual(
    sagTopology(doc, buildNetlist(doc)),
    topo,
    "a rebuilt netlist (an edit, a switch) reads the wiring again",
  );
});
