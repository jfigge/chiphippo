/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Tests for the pure netlist (sim/netlist.js) — the connectivity partition.

import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { DeskDoc } from "../model/desk-doc.js";
import { buildNetlist, summarizeNet } from "../sim/netlist.js";

/** netId of an address in a freshly built netlist. */
function netAt(doc, address, partStates) {
  return buildNetlist(doc.toJSON(), partStates).netOfPoint.get(address);
}

/** The NetInfo containing an address. */
function infoAt(doc, address, partStates) {
  const nl = buildNetlist(doc.toJSON(), partStates);
  return nl.nets.get(nl.netOfPoint.get(address));
}

function fullBoard() {
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0); // bb1
  return doc;
}

// ── Board internal nodes ─────────────────────────────────────────────────────

test("a 5-hole strip is one net; the other half is separate", () => {
  const doc = fullBoard();
  const strip = ["a5", "b5", "c5", "d5", "e5"].map((h) =>
    netAt(doc, `bb1.${h}`),
  );
  assert.equal(new Set(strip).size, 1); // a5..e5 all one net
  assert.notEqual(netAt(doc, "bb1.e5"), netAt(doc, "bb1.f5")); // trench isolates
  assert.notEqual(netAt(doc, "bb1.a5"), netAt(doc, "bb1.a6")); // adjacent columns
  const info = infoAt(doc, "bb1.a5");
  assert.equal(info.counts.holes, 5);
  assert.equal(info.id, "bb1.a5"); // smallest member address
});

test("a rail is one continuous net end-to-end", () => {
  const doc = fullBoard();
  assert.equal(netAt(doc, "bb1.t+1"), netAt(doc, "bb1.t+50"));
  const info = infoAt(doc, "bb1.t+1");
  assert.equal(info.counts.holes, 50);
  assert.deepEqual(info.rails, ["bb1.t+"]);
});

// ── Wires ────────────────────────────────────────────────────────────────────

test("a wire joins two strips into one net (and lists the wire)", () => {
  const doc = fullBoard();
  assert.notEqual(netAt(doc, "bb1.a1"), netAt(doc, "bb1.f1"));
  doc.addWire({ from: "bb1.a1", to: "bb1.f1", color: "red" });
  assert.equal(netAt(doc, "bb1.a1"), netAt(doc, "bb1.f1"));
  const info = infoAt(doc, "bb1.a1");
  assert.deepEqual(info.wires, ["w1"]);
  assert.equal(info.counts.holes, 10); // both 5-hole halves
});

test("a wire spans two boards into one cross-board net", () => {
  const doc = fullBoard();
  doc.addBoard("tiny", 0, 40); // bb2
  doc.addWire({ from: "bb1.j10", to: "bb2.a1", color: "blue" });
  const net = netAt(doc, "bb1.j10");
  assert.equal(net, netAt(doc, "bb2.a1"));
  const info = infoAt(doc, "bb1.j10");
  // Members drawn from both boards.
  assert.ok(info.holes.some((h) => h.startsWith("bb1.")));
  assert.ok(info.holes.some((h) => h.startsWith("bb2.")));
});

// ── PSU terminals ────────────────────────────────────────────────────────────

test("a PSU terminal is its own net until wired, then joins the rail", () => {
  const doc = fullBoard();
  doc.addPsu(80, 0); // psu1
  const alone = infoAt(doc, "psu1.+");
  assert.deepEqual(alone.terminals, ["psu1.+"]);
  assert.equal(alone.counts.holes, 0);

  doc.addWire({ from: "psu1.+", to: "bb1.t+3", color: "red" });
  assert.equal(netAt(doc, "psu1.+"), netAt(doc, "bb1.t+1"));
  const joined = infoAt(doc, "psu1.+");
  assert.deepEqual(joined.terminals, ["psu1.+"]);
  assert.deepEqual(joined.rails, ["bb1.t+"]);
  assert.match(summarizeNet(joined), /rail bb1\.t\+/);
  assert.match(summarizeNet(joined), /psu1\.\+/);
});

// ── Switch / button bridges (part state is a netlist input) ──────────────────

test("a slide switch bridges common↔pin1 or common↔pin3 by position", () => {
  const doc = fullBoard();
  // Pins seat at b10 (1), b11 (common), b12 (2/pin3).
  doc.addComponent({
    kind: "discrete",
    ref: "sw-slide",
    board: "bb1",
    anchor: "b10",
    params: { pos: "1" },
  });
  // pos 1: common (b11) shares the net that includes b10; b12 is elsewhere.
  assert.equal(netAt(doc, "bb1.b11"), netAt(doc, "bb1.b10"));
  assert.notEqual(netAt(doc, "bb1.b11"), netAt(doc, "bb1.b12"));

  // Flip to pos 2 (persisted param): now common bridges b12, not b10.
  doc.setComponentParams("c1", { pos: "2" });
  assert.equal(netAt(doc, "bb1.b11"), netAt(doc, "bb1.b12"));
  assert.notEqual(netAt(doc, "bb1.b11"), netAt(doc, "bb1.b10"));
});

test("a push button bridges only while pressed (transient part state)", () => {
  const doc = fullBoard();
  doc.addComponent({
    kind: "discrete",
    ref: "sw-push",
    board: "bb1",
    anchor: "b10", // pins b10, b12
  });
  // Released: the two column-strips are separate.
  assert.notEqual(netAt(doc, "bb1.b10"), netAt(doc, "bb1.b12"));
  // Pressed (state passed in, nothing persisted): bridged.
  const pressed = new Map([["c1", { pressed: true }]]);
  assert.equal(netAt(doc, "bb1.b10", pressed), netAt(doc, "bb1.b12", pressed));
});

// ── Chip pins are members, not conduits ──────────────────────────────────────

test("chip pins join their hole's net with name+role, never pin-to-pin", () => {
  const doc = fullBoard();
  doc.addComponent({ kind: "chip", ref: "7400", board: "bb1", anchor: "e5" });
  // Pin 1 (1A) seats in e5.
  const info = infoAt(doc, "bb1.e5");
  const pin = info.pins.find((p) => p.pin === 1);
  assert.deepEqual(pin, {
    componentId: "c1",
    ref: "7400",
    pin: 1,
    name: "1A",
    role: "input",
    hole: "bb1.e5",
  });
  // A chip never conducts pin-to-pin: pin 1 (e5) and pin 2 (e6) stay separate.
  assert.notEqual(netAt(doc, "bb1.e5"), netAt(doc, "bb1.e6"));
});

// ── Net-id stability ─────────────────────────────────────────────────────────

test("net ids are stable under unrelated edits", () => {
  const doc = fullBoard();
  const before = netAt(doc, "bb1.c5");
  doc.addBoard("tiny", 0, 40); // an unrelated board far away
  doc.addWire({ from: "bb1.a20", to: "bb1.f20", color: "green" });
  assert.equal(netAt(doc, "bb1.c5"), before); // same net, same id
});

// ── Performance budget ───────────────────────────────────────────────────────

test("10 boards + 500 wires builds well under 50 ms", () => {
  const boards = [];
  for (let b = 1; b <= 10; b++) {
    boards.push({ id: `bb${b}`, type: "full", x: (b - 1) * 70, y: 0 });
  }
  const wires = [];
  for (let i = 0; i < 500; i++) {
    const b1 = (i % 10) + 1;
    const b2 = ((i + 1) % 10) + 1;
    const col = (i % 60) + 1;
    wires.push({
      id: `w${i + 1}`,
      from: `bb${b1}.j${col}`,
      to: `bb${b2}.a${col}`,
      color: "red",
    });
  }
  const doc = { boards, components: [], wires };
  const t0 = performance.now();
  const nl = buildNetlist(doc);
  const ms = performance.now() - t0;
  assert.ok(nl.nets.size > 0);
  assert.ok(ms < 50, `netlist build took ${ms.toFixed(1)} ms (budget 50)`);
});
