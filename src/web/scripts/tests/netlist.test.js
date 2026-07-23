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

/**
 * A full breadboard kit: bb1 the top rail strip, bb2 the pin-board, bb3 the
 * bottom rail strip (the rails are boards of their own now).
 */
function fullKit() {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1 rail · bb2 pins · bb3 rail
  return doc;
}

// ── Board internal nodes ─────────────────────────────────────────────────────

test("a 5-hole strip is one net; the other half is separate", () => {
  const doc = fullKit();
  const strip = ["a5", "b5", "c5", "d5", "e5"].map((h) =>
    netAt(doc, `bb2.${h}`),
  );
  assert.equal(new Set(strip).size, 1); // a5..e5 all one net
  assert.notEqual(netAt(doc, "bb2.e5"), netAt(doc, "bb2.f5")); // trench isolates
  assert.notEqual(netAt(doc, "bb2.a5"), netAt(doc, "bb2.a6")); // adjacent columns
  const info = infoAt(doc, "bb2.a5");
  assert.equal(info.counts.holes, 5);
  assert.equal(info.id, "bb2.a5"); // smallest member address
});

test("a rail is one continuous net end-to-end", () => {
  const doc = fullKit();
  assert.equal(netAt(doc, "bb1.+1"), netAt(doc, "bb1.+50"));
  const info = infoAt(doc, "bb1.+1");
  assert.equal(info.counts.holes, 50);
  assert.deepEqual(info.rails, ["bb1.+"]);
  // The two polarities of one strip stay apart, as do the two rail strips.
  assert.notEqual(netAt(doc, "bb1.+1"), netAt(doc, "bb1.-1"));
  assert.notEqual(netAt(doc, "bb1.+1"), netAt(doc, "bb3.+1"));
});

// ── Wires ────────────────────────────────────────────────────────────────────

test("a wire joins two strips into one net (and lists the wire)", () => {
  const doc = fullKit();
  assert.notEqual(netAt(doc, "bb2.a1"), netAt(doc, "bb2.f1"));
  doc.addWire({ from: "bb2.a1", to: "bb2.f1", color: "red" });
  assert.equal(netAt(doc, "bb2.a1"), netAt(doc, "bb2.f1"));
  const info = infoAt(doc, "bb2.a1");
  assert.deepEqual(info.wires, ["w1"]);
  assert.equal(info.counts.holes, 10); // both 5-hole halves
});

test("a wire spans two boards into one cross-board net", () => {
  const doc = fullKit();
  doc.addBoard("pins-tiny", 0, 40); // bb4
  doc.addWire({ from: "bb2.j10", to: "bb4.a1", color: "blue" });
  const net = netAt(doc, "bb2.j10");
  assert.equal(net, netAt(doc, "bb4.a1"));
  const info = infoAt(doc, "bb2.j10");
  // Members drawn from both boards.
  assert.ok(info.holes.some((h) => h.startsWith("bb2.")));
  assert.ok(info.holes.some((h) => h.startsWith("bb4.")));
});

test("a wire joins a rail strip to the pin-board it sits against", () => {
  // The rails are separate strips now — a kit is only electrically one board
  // once the user jumpers a rail onto a column, exactly as in real life.
  const doc = fullKit();
  assert.notEqual(netAt(doc, "bb1.+1"), netAt(doc, "bb2.a1"));
  doc.addWire({ from: "bb1.+4", to: "bb2.a1", color: "red" });
  assert.equal(netAt(doc, "bb1.+1"), netAt(doc, "bb2.a1"));
  const info = infoAt(doc, "bb2.a1");
  assert.equal(info.counts.holes, 55); // 50 rail holes + the 5-hole strip
  assert.deepEqual(info.rails, ["bb1.+"]);
});

// ── PSU terminals ────────────────────────────────────────────────────────────

test("a PSU terminal is its own net until wired, then joins the rail", () => {
  const doc = fullKit();
  doc.addPsu(80, 0); // psu1
  const alone = infoAt(doc, "psu1.+");
  assert.deepEqual(alone.terminals, ["psu1.+"]);
  assert.equal(alone.counts.holes, 0);

  doc.addWire({ from: "psu1.+", to: "bb1.+3", color: "red" });
  assert.equal(netAt(doc, "psu1.+"), netAt(doc, "bb1.+1"));
  const joined = infoAt(doc, "psu1.+");
  assert.deepEqual(joined.terminals, ["psu1.+"]);
  assert.deepEqual(joined.rails, ["bb1.+"]);
  assert.match(summarizeNet(joined), /rail bb1\.\+/);
  assert.match(summarizeNet(joined), /psu1\.\+/);
});

// ── Switch / button bridges (part state is a netlist input) ──────────────────

test("a slide switch bridges common↔pin1 or common↔pin3 by position", () => {
  const doc = fullKit();
  // Pins seat at b10 (1), b11 (common), b12 (2/pin3).
  doc.addComponent({
    kind: "discrete",
    ref: "sw-slide",
    board: "bb2",
    anchor: "b10",
    params: { pos: "1" },
  });
  // pos 1: common (b11) shares the net that includes b10; b12 is elsewhere.
  assert.equal(netAt(doc, "bb2.b11"), netAt(doc, "bb2.b10"));
  assert.notEqual(netAt(doc, "bb2.b11"), netAt(doc, "bb2.b12"));

  // Flip to pos 2 (persisted param): now common bridges b12, not b10.
  doc.setComponentParams("c1", { pos: "2" });
  assert.equal(netAt(doc, "bb2.b11"), netAt(doc, "bb2.b12"));
  assert.notEqual(netAt(doc, "bb2.b11"), netAt(doc, "bb2.b10"));
});

test("a push button bridges only while pressed (transient part state)", () => {
  const doc = fullKit();
  doc.addComponent({
    kind: "discrete",
    ref: "sw-push",
    board: "bb2",
    anchor: "b10", // pins b10, b12
  });
  // Released: the two column-strips are separate.
  assert.notEqual(netAt(doc, "bb2.b10"), netAt(doc, "bb2.b12"));
  // Pressed (state passed in, nothing persisted): bridged.
  const pressed = new Map([["c1", { pressed: true }]]);
  assert.equal(netAt(doc, "bb2.b10", pressed), netAt(doc, "bb2.b12", pressed));
});

test("a toggle button bridges while on (persisted part state)", () => {
  const doc = fullKit();
  doc.addComponent({
    kind: "discrete",
    ref: "sw-toggle",
    board: "bb2",
    anchor: "b10", // pins b10, b12
  });
  // Off: the two column-strips are separate.
  assert.notEqual(netAt(doc, "bb2.b10"), netAt(doc, "bb2.b12"));
  // Click on (persisted param): bridged, and stays bridged across rebuilds.
  doc.setComponentParams("c1", { on: true });
  assert.equal(netAt(doc, "bb2.b10"), netAt(doc, "bb2.b12"));
  // Click again: back off.
  doc.setComponentParams("c1", { on: false });
  assert.notEqual(netAt(doc, "bb2.b10"), netAt(doc, "bb2.b12"));
});

// ── Chip pins are members, not conduits ──────────────────────────────────────

test("chip pins join their hole's net with name+role, never pin-to-pin", () => {
  const doc = fullKit();
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb2", anchor: "e5" });
  // Pin 1 (1A) seats in e5.
  const info = infoAt(doc, "bb2.e5");
  const pin = info.pins.find((p) => p.pin === 1);
  assert.deepEqual(pin, {
    componentId: "c1",
    ref: "74LS00",
    pin: 1,
    name: "1A",
    role: "input",
    hole: "bb2.e5",
  });
  // A chip never conducts pin-to-pin: pin 1 (e5) and pin 2 (e6) stay separate.
  assert.notEqual(netAt(doc, "bb2.e5"), netAt(doc, "bb2.e6"));
});

test("a 180°-flipped chip labels each hole with its ROTATED pin", () => {
  // A flipped DIP occupies the SAME holes — only the numbering turns half a
  // lap. The netlist must carry the rotated numbering through, or every probe
  // readout and net summary names the wrong pin of the chip under the user's
  // cursor. (It used to drop comp.params on the floor and report pin 1 here.)
  const doc = fullKit();
  doc.addComponent({
    kind: "chip",
    ref: "74LS00",
    board: "bb2",
    anchor: "e5",
    params: { rot: 180 },
  });
  // Unflipped this is pin 1 (1A, an input); flipped it is pin 8 (3Y, output).
  const flipped = infoAt(doc, "bb2.e5").pins.find((p) => p.hole === "bb2.e5");
  assert.deepEqual(flipped, {
    componentId: "c1",
    ref: "74LS00",
    pin: 8,
    name: "3Y",
    role: "output",
    hole: "bb2.e5",
  });
  // …and pin 1 now sits at the opposite corner of the footprint.
  const one = infoAt(doc, "bb2.f11").pins.find((p) => p.pin === 1);
  assert.deepEqual(one, {
    componentId: "c1",
    ref: "74LS00",
    pin: 1,
    name: "1A",
    role: "input",
    hole: "bb2.f11",
  });
});

// ── A rotated part's free lead: cross-strip, and floating ────────────────────

/**
 * A resistor seated on the pin-board with its far lead bent DOWN onto the
 * bottom rail strip: anchor `bb2.a10` (world 10,15), lead at +3 pitches of y
 * → `bb3.-7` (world 10,18) — rail hole 7 shares column 10's x. Its ends are a
 * {dx, dy} bend, not a hole id. The bend is also exactly the resistor's
 * minSpan, so it is the tightest legal reach from row a to the `-` rail.
 */
function railBentResistor() {
  const doc = fullKit(); // bb1 rail · bb2 pins · bb3 rail
  doc.addComponent({
    kind: "discrete",
    ref: "resistor",
    board: "bb2",
    anchor: "a10",
    params: { rot: 90, end: { dx: 0, dy: 3 } },
  });
  return doc;
}

test("a rotated part's free lead joins the net of the strip it bends onto", () => {
  const doc = railBentResistor();
  // The lead landed on the bottom rail — one continuous net end to end, and
  // the pin is a member of it even though the part is seated on bb2.
  assert.equal(netAt(doc, "bb3.-7"), netAt(doc, "bb3.-1"));
  const rail = infoAt(doc, "bb3.-7");
  assert.deepEqual(rail.rails, ["bb3.-"]);
  assert.deepEqual(rail.pins, [
    {
      componentId: "c1",
      ref: "resistor",
      pin: 2,
      name: "2",
      role: "lead",
      hole: "bb3.-7",
    },
  ]);
  // The anchored lead stays in its own column strip: a resistor declares no
  // internalBridges, so its two ends are still two nets (the weak coupling is
  // the simulator's business, never the partition's).
  const column = infoAt(doc, "bb2.a10");
  assert.deepEqual(
    column.pins.map((p) => p.pin),
    [1],
  );
  assert.notEqual(netAt(doc, "bb2.a10"), netAt(doc, "bb3.-7"));
});

test("pulling the rail out from under a lead floats it; the part survives", () => {
  const doc = railBentResistor();
  doc.removeBoard("bb3"); // the strip the free lead was bent onto
  // The part is seated on bb2, so it stays put — a floating leg is a legal
  // state, not a reason to delete the resistor.
  assert.deepEqual(doc.getComponent("c1"), {
    id: "c1",
    kind: "discrete",
    ref: "resistor",
    board: "bb2",
    anchor: "a10",
    params: { ohms: 10000, rot: 90, end: { dx: 0, dy: 3 } },
  });
  // Its anchored lead still belongs to its column's net…
  assert.deepEqual(
    infoAt(doc, "bb2.a10").pins.map((p) => p.pin),
    [1],
  );
  // …while the free lead is a member of NO net anywhere on the desk.
  const nl = buildNetlist(doc.toJSON());
  const mine = [...nl.nets.values()]
    .flatMap((net) => net.pins)
    .filter((p) => p.componentId === "c1");
  assert.deepEqual(
    mine.map((p) => p.pin),
    [1],
  );
});

// ── Net-id stability ─────────────────────────────────────────────────────────

test("net ids are stable under unrelated edits", () => {
  const doc = fullKit();
  const before = netAt(doc, "bb2.c5");
  doc.addBoard("pins-tiny", 0, 40); // an unrelated board far away
  doc.addWire({ from: "bb2.a20", to: "bb2.f20", color: "green" });
  assert.equal(netAt(doc, "bb2.c5"), before); // same net, same id
});

// ── Performance budget ───────────────────────────────────────────────────────

test("10 breadboards + 500 wires builds well under 50 ms", () => {
  // Ten full kits — 30 strips, 8300 tie points — wired pin-board to pin-board.
  const boards = [];
  const pinBoards = [];
  let seq = 0;
  for (let b = 0; b < 10; b++) {
    const x = b * 70;
    const group = `g${b + 1}`;
    boards.push({ id: `bb${++seq}`, type: "rail-full", x, y: 0, group });
    const pins = `bb${++seq}`;
    pinBoards.push(pins);
    boards.push({ id: pins, type: "pins-full", x, y: 4, group });
    boards.push({ id: `bb${++seq}`, type: "rail-full", x, y: 18, group });
  }
  const wires = [];
  for (let i = 0; i < 500; i++) {
    const col = (i % 60) + 1;
    wires.push({
      id: `w${i + 1}`,
      from: `${pinBoards[i % 10]}.j${col}`,
      to: `${pinBoards[(i + 1) % 10]}.a${col}`,
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
