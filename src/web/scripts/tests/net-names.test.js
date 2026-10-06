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

// Tests for net names (Feature 120): the netlist resolves each `{address,name}`
// binding to its current net, holds a name through a net-key change, reports
// merge conflicts, and never perturbs the electrical partition.

import test from "node:test";
import assert from "node:assert/strict";

import { DeskDoc } from "../model/desk-doc.js";
import { buildNetlist } from "../sim/netlist.js";
import { resetDom } from "./jsdom-setup.js";

const { NetlistCache } = await import("../components/netlist-cache.js");

function fullKit() {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1 rail · bb2 pins · bb3 rail
  return doc;
}

test("a name binds by address and shows up on that net", () => {
  const doc = fullKit();
  doc.nameNet("bb1.+1", "VCC");
  const nl = buildNetlist(doc.toJSON());
  const railNet = nl.netOfPoint.get("bb1.+25");
  assert.equal(nl.names.get(railNet), "VCC"); // whole rail inherits the name
  assert.equal(nl.nameConflicts.length, 0);
});

test("a name survives a net-key change (delete the smallest-address wire)", () => {
  const doc = fullKit();
  // Span three columns; b6 shares a6's 5-hole node, so each endpoint is its
  // own free hole (one hole, one lead).
  const w1 = doc.addWire({ from: "bb2.a5", to: "bb2.a6" });
  doc.addWire({ from: "bb2.b6", to: "bb2.a7" });
  // Name by pointing at a7 — a member that stays in the net we care about.
  doc.nameNet("bb2.a7", "DATA");

  let nl = buildNetlist(doc.toJSON());
  const net1 = nl.netOfPoint.get("bb2.a7");
  assert.equal(net1, "bb2.a5"); // key = smallest member address
  assert.equal(nl.names.get(net1), "DATA");

  // Delete the wire on the smallest address: a5's column splits off, so the
  // key of the remaining net changes — but a7 is still in it.
  doc.removeWire(w1.id);
  nl = buildNetlist(doc.toJSON());
  const net2 = nl.netOfPoint.get("bb2.a7");
  assert.notEqual(net2, net1); // the key changed
  assert.equal(nl.names.get(net2), "DATA"); // the name held
  // a5 is now its own, unnamed net.
  assert.equal(nl.names.get(nl.netOfPoint.get("bb2.a5")), undefined);
});

test("a merge conflict is REPORTED, never silently dropped", () => {
  const doc = fullKit();
  doc.nameNet("bb2.a5", "VCC");
  doc.nameNet("bb2.a10", "GND");
  let nl = buildNetlist(doc.toJSON());
  assert.equal(nl.nameConflicts.length, 0); // two separate nets, no conflict

  // A wire merges the two named nets into one.
  doc.addWire({ from: "bb2.a5", to: "bb2.a10" });
  nl = buildNetlist(doc.toJSON());
  const net = nl.netOfPoint.get("bb2.a5");
  // Deterministic winner: the name that sorts first ("GND" < "VCC").
  assert.equal(nl.names.get(net), "GND");
  assert.equal(nl.nameConflicts.length, 1);
  assert.equal(nl.nameConflicts[0].winner, "GND");
  assert.equal(nl.nameConflicts[0].name, "VCC"); // the loser is named
  assert.equal(nl.nameConflicts[0].netId, net);
});

test("naming is inert: the electrical partition is byte-identical", () => {
  const doc = fullKit();
  doc.addWire({ from: "bb2.a5", to: "bb1.+1" });
  const before = buildNetlist(doc.toJSON());

  doc.nameNet("bb2.a5", "VCC");
  doc.nameNet("bb1.+1", "VCC"); // same net, redundant name — still inert
  const after = buildNetlist(doc.toJSON());

  // The partition (which point is on which net) is untouched by naming.
  assert.deepEqual(
    [...after.netOfPoint.entries()].sort(),
    [...before.netOfPoint.entries()].sort(),
  );
  // Every NetInfo is identical — names live in a separate map, not on the net.
  for (const [id, net] of after.nets) {
    assert.deepEqual(net, before.nets.get(id));
  }
});

test("a binding on a deleted board is ignored, not applied", () => {
  const doc = fullKit();
  doc.nameNet("bb2.a5", "DATA");
  doc.removeBoard("bb2");
  const nl = buildNetlist(doc.toJSON());
  // No net contains bb2.a5 anymore, so the name simply resolves to nothing.
  assert.equal([...nl.names.values()].includes("DATA"), false);
  assert.equal(nl.nameConflicts.length, 0);
});

// ── A name names what the BUILD connected, never a switch's contact ─────────
//
// A slide switch at a10…a12 whose contact 1 (a10) is wired to the + rail and
// whose common (a11) feeds whatever the circuit reads. Thrown to 1, the
// conducting netlist joins the common's net to the rail — and a name bound to
// it used to go with it: the rail and every VCC pin on the desk wore it.

/** The kit with a slide switch thrown onto the + rail. */
function switchedToRail(pos = "1") {
  const doc = fullKit();
  doc.addComponent({
    kind: "discrete",
    ref: "sw-slide",
    board: "bb2",
    anchor: "a10",
    params: { pos },
  });
  doc.addWire({ from: "bb2.b10", to: "bb1.+1" });
  doc.nameNet("bb2.c11", "IN_A"); // the common's net
  return doc;
}

test("a name bound beside a closed switch stays on its own side", () => {
  const doc = switchedToRail();
  const nl = buildNetlist(doc.toJSON());
  const joined = nl.netOfPoint.get("bb2.c11");
  assert.equal(nl.netOfPoint.get("bb1.+25"), joined, "the contact IS closed");
  // The conducting net is the rail as much as the common: it is not IN_A.
  assert.equal(nl.names.get(joined), undefined);
  // …while the name AT the common's holes is still IN_A, and the rail's none.
  assert.equal(nl.wiringNames.get(nl.wiringNetOfPoint.get("bb2.e11")), "IN_A");
  assert.equal(
    nl.wiringNames.get(nl.wiringNetOfPoint.get("bb1.+25")),
    undefined,
  );
});

test("naming both sides of a closed switch is no merge conflict", () => {
  const doc = switchedToRail();
  doc.nameNet("bb1.+5", "VCC");
  const nl = buildNetlist(doc.toJSON());
  assert.deepEqual(nl.nameConflicts, []);
  assert.equal(nl.wiringNames.get(nl.wiringNetOfPoint.get("bb1.+5")), "VCC");
  assert.equal(nl.wiringNames.get(nl.wiringNetOfPoint.get("bb2.c11")), "IN_A");
});

test("a live net carries a name only when every wired net in it does", () => {
  // Thrown to contact 2, the common (a11) joins a12's column, not the rail.
  const doc = switchedToRail("2");
  let nl = buildNetlist(doc.toJSON());
  const joined = nl.netOfPoint.get("bb2.c11");
  assert.equal(nl.netOfPoint.get("bb2.c12"), joined);
  assert.equal(nl.names.get(joined), undefined, "a12's column is unnamed");
  assert.equal(nl.names.get(nl.netOfPoint.get("bb1.+25")), undefined);
  // Named alike on both sides of the contact, the live net is that name.
  doc.nameNet("bb2.c12", "IN_A");
  nl = buildNetlist(doc.toJSON());
  assert.equal(nl.names.get(joined), "IN_A");
  assert.deepEqual(nl.nameConflicts, [], "two wired nets, one name each");
});

test("a wiring-only netlist names exactly the wired nets", () => {
  const nl = buildNetlist(switchedToRail().toJSON(), new Map(), {
    bridges: false,
  });
  assert.equal(nl.names.get(nl.netOfPoint.get("bb2.c11")), "IN_A");
  assert.equal(nl.names.get(nl.netOfPoint.get("bb1.+25")), undefined);
});

test("the cache's nameAt is the name at a point, whichever partition it holds", () => {
  resetDom();
  const doc = switchedToRail();
  for (const bridges of [true, false]) {
    const cache = new NetlistCache(doc, { bridges });
    assert.equal(cache.nameAt("bb2.a11"), "IN_A");
    assert.equal(cache.nameAt("bb1.+25"), null);
  }
});
