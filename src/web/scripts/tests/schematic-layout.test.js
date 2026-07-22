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

// schematic-layout.test.js — the pure projection: deterministic layered
// placement, crossing reduction, orthogonal routing, power stubs (never
// routed), bus bundling, and nudge-driven reflow.

import test from "node:test";
import assert from "node:assert/strict";

import { layout, symbolGeometry } from "../model/schematic-layout.js";
import { symbolFor } from "../catalog/symbols.js";
import { DeskDoc } from "../model/desk-doc.js";
import { buildNetlist } from "../sim/netlist.js";

/** A synthetic net info (only the fields `layout` reads). */
function net(id, pins, { terminals = [], rails = [] } = {}) {
  return { id, pins, terminals, rails };
}
/** A synthetic netlist wrapper. */
function netlistOf(netList, names = new Map()) {
  return { nets: new Map(netList.map((n) => [n.id, n])), names };
}
const pin = (componentId, p, role) => ({ componentId, pin: p, role });

/** A doc of chips (layout only reads id, ref, board). */
function chipsDoc(ids, ref = "74LS00") {
  return { components: ids.map((id) => ({ id, ref, board: "bb1" })) };
}

test("symbolGeometry: a quad NAND has a port per functional pin", () => {
  const geo = symbolGeometry(symbolFor("74LS00"));
  assert.equal(geo.ports.length, 14); // 8 inputs + 4 outputs + VCC + GND
  assert.ok(geo.width > 0 && geo.height > 0);
  // VCC sits on top, GND on the bottom edge.
  const top = geo.ports.filter((p) => p.side === "top");
  const bottom = geo.ports.filter((p) => p.side === "bottom");
  assert.equal(top.length, 1);
  assert.equal(bottom.length, 1);
  assert.ok(top[0].ty < 0, "VCC stub exits upward");
  assert.ok(bottom[0].ty > geo.height, "GND stub exits downward");
});

test("driver→reader flows into the next column and reflows deterministically", () => {
  const doc = chipsDoc(["c1", "c2"]);
  // c1 drives net n1 from its output pin 3; c2 reads it on input pin 1.
  const nl = netlistOf([
    net("n1", [pin("c1", 3, "output"), pin("c2", 1, "input")]),
  ]);

  const a = layout(doc, nl);
  const b = layout(doc, nl);
  assert.deepEqual(a, b, "layout is deterministic");

  assert.equal(a.nodes.length, 2);
  const c1 = a.nodes.find((n) => n.id === "c1");
  const c2 = a.nodes.find((n) => n.id === "c2");
  assert.ok(c2.x > c1.x, "the reader sits one column to the right");
  assert.ok(a.nodes.every((n) => n.symbol && n.geometry));

  // The single signal net produced one routed edge (orthogonal segments).
  const edge = a.edges.find((e) => e.net === "n1");
  assert.ok(edge, "n1 is routed");
  assert.ok(edge.segments.length >= 1);
  for (const seg of edge.segments) {
    for (let i = 1; i < seg.length; i++) {
      const dx = Math.abs(seg[i].x - seg[i - 1].x);
      const dy = Math.abs(seg[i].y - seg[i - 1].y);
      assert.ok(dx < 1e-6 || dy < 1e-6, "each hop is horizontal or vertical");
    }
  }
});

test("a cross-coupled latch (a cycle) still lays out in finite columns", () => {
  const doc = chipsDoc(["c1", "c2"]);
  // c1 out → c2 in, and c2 out → c1 in — a feedback loop.
  const nl = netlistOf([
    net("n1", [pin("c1", 3, "output"), pin("c2", 1, "input")]),
    net("n2", [pin("c2", 3, "output"), pin("c1", 2, "input")]),
  ]);
  const out = layout(doc, nl);
  assert.equal(out.nodes.length, 2);
  for (const n of out.nodes) {
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
  }
});

test("barycentric ordering removes crossings in a bipartite fixture", () => {
  const doc = chipsDoc(["n1", "n2", "n3", "n4", "n5", "n6"]);
  // Column 0 = n1,n2,n3 (id order); each drives a column-1 node in REVERSE, so
  // the identity row order crosses and the barycentric pass must flip col 1.
  const nl = netlistOf([
    net("e16", [pin("n1", 3, "output"), pin("n6", 1, "input")]),
    net("e25", [pin("n2", 3, "output"), pin("n5", 1, "input")]),
    net("e34", [pin("n3", 3, "output"), pin("n4", 1, "input")]),
  ]);
  const out = layout(doc, nl);
  const y = (id) => out.nodes.find((n) => n.id === id).y;
  // Crossing-free means each connected pair ends on the SAME row (equal y);
  // the absolute order may settle to either mirror, but the pairing must align.
  assert.equal(y("n1"), y("n6"));
  assert.equal(y("n2"), y("n5"));
  assert.equal(y("n3"), y("n4"));
  assert.equal(new Set([y("n1"), y("n2"), y("n3")]).size, 3, "three rows");
});

test("power/ground nets drop rail stubs and never route", () => {
  const doc = chipsDoc(["c1", "c2"]);
  const nl = netlistOf([
    // VCC: both chips' pin 14 + a PSU + terminal.
    net("vcc", [pin("c1", 14, "vcc"), pin("c2", 14, "vcc")], {
      terminals: ["psu1.+"],
    }),
    // GND: both chips' pin 7 + a PSU − terminal.
    net("gnd", [pin("c1", 7, "gnd"), pin("c2", 7, "gnd")], {
      terminals: ["psu1.-"],
    }),
    net("sig", [pin("c1", 3, "output"), pin("c2", 1, "input")]),
  ]);
  const out = layout(doc, nl);

  const vccStubs = out.powerStubs.filter((s) => s.polarity === "VCC");
  const gndStubs = out.powerStubs.filter((s) => s.polarity === "GND");
  assert.equal(vccStubs.length, 2, "one VCC symbol per powered chip");
  assert.equal(gndStubs.length, 2, "one GND symbol per powered chip");
  // Power nets are NOT edges; only the signal net is.
  assert.ok(!out.edges.some((e) => e.netIds?.includes("vcc")));
  assert.ok(!out.edges.some((e) => e.netIds?.includes("gnd")));
  assert.ok(out.edges.some((e) => e.net === "sig"));
});

test("a bus between two chips' pin groups renders as ONE fat line", () => {
  // Two 74LS573 latches: chip A's Q octet drives chip B's D octet, bit-aligned.
  const doc = chipsDoc(["c1", "c2"], "74LS573");
  const qPins = [19, 18, 17, 16, 15, 14, 13, 12]; // Q, bit 0 first
  const dPins = [2, 3, 4, 5, 6, 7, 8, 9]; // D, bit 0 first
  const busNets = qPins.map((q, i) =>
    net(`b${i}`, [pin("c1", q, "output"), pin("c2", dPins[i], "input")]),
  );
  const nl = netlistOf(busNets);
  const out = layout(doc, nl);

  const busEdges = out.edges.filter((e) => e.bus);
  assert.equal(busEdges.length, 1, "eight bits collapse to one bus line");
  assert.equal(busEdges[0].netIds.length, 8);
  assert.equal(busEdges[0].name, "Q"); // labelled by the driving group
  // None of the eight bits is ALSO drawn as a thin ordinary edge.
  assert.ok(!out.edges.some((e) => !e.bus));
});

test("a schematicPos hint pins a symbol and reflows only its edges", () => {
  const doc = chipsDoc(["c1", "c2"]);
  const nl = netlistOf([
    net("n1", [pin("c1", 3, "output"), pin("c2", 1, "input")]),
  ]);
  const base = layout(doc, nl);
  const moved = layout(doc, nl, { c2: { x: 500, y: 300 } });

  const c1a = base.nodes.find((n) => n.id === "c1");
  const c1b = moved.nodes.find((n) => n.id === "c1");
  const c2b = moved.nodes.find((n) => n.id === "c2");
  assert.deepEqual(
    { x: c1b.x, y: c1b.y },
    { x: c1a.x, y: c1a.y },
    "c1 unmoved",
  );
  assert.deepEqual({ x: c2b.x, y: c2b.y }, { x: 500, y: 300 }, "c2 pinned");

  // The edge reflowed: at least one segment endpoint tracks c2's new position.
  const edge = moved.edges.find((e) => e.net === "n1");
  const pts = edge.segments.flat();
  assert.ok(
    pts.some((p) => Math.abs(p.y - 300) < 6),
    "the routing followed the moved symbol",
  );
});

test("a named net drops its name as a label", () => {
  const doc = chipsDoc(["c1", "c2"]);
  const nl = netlistOf(
    [net("n1", [pin("c1", 3, "output"), pin("c2", 1, "input")])],
    new Map([["n1", "CLK"]]),
  );
  const out = layout(doc, nl);
  const edge = out.edges.find((e) => e.net === "n1");
  assert.equal(edge.name, "CLK");
  assert.ok(edge.label, "a named net carries a label anchor");
});

test("end-to-end: a real seated circuit projects through buildNetlist", () => {
  // Two 74LS00s on one board, powered by a PSU, with c1's 1Y (pin 3) driving
  // c2's 1A (pin 1). Wires land in FREE holes of each pin's 5-hole node.
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // bb1
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  doc.addComponent({
    kind: "chip",
    ref: "74LS00",
    board: "bb1",
    anchor: "e25",
  });
  doc.addPsu(120, 0); // psu1

  // c1 pin3 (e7) node → free a7; c2 pin1 (e25) node → free a25.
  doc.addWire({ from: "bb1.a7", to: "bb1.a25" });
  // VCC: PSU → c1 pin14 (f5) node, then chain c1's node → c2 pin14 (f25) node
  // (a terminal holds only one lead, so the second chip taps off the first).
  doc.addWire({ from: "psu1.+", to: "bb1.j5" });
  doc.addWire({ from: "bb1.i5", to: "bb1.j25" });
  // GND: PSU → c1 pin7 (e11) node, then chain → c2 pin7 (e31) node.
  doc.addWire({ from: "psu1.-", to: "bb1.a11" });
  doc.addWire({ from: "bb1.b11", to: "bb1.a31" });

  const netlist = buildNetlist(doc.toJSON());
  const out = layout(doc.toJSON(), netlist);

  // Both chips AND the PSU brick are symbols now (Feature 150 + discretes).
  assert.equal(out.nodes.length, 3);
  const c1 = out.nodes.find((n) => n.id === "c1");
  const c2 = out.nodes.find((n) => n.id === "c2");
  const psu = out.nodes.find((n) => n.id === "psu1");
  assert.ok(c1 && c2 && psu, "chips and the PSU are all nodes");
  assert.ok(c2.x > c1.x, "the driven chip sits to the right");
  assert.ok(psu.x <= c1.x, "the supply sits at or left of the chips");

  // The 1Y→1A signal is a routed ordinary edge.
  assert.ok(
    out.edges.some((e) => !e.bus && e.segments.length),
    "the driver→reader net is routed",
  );
  // VCC/GND resolve to rail symbols (one per port on the supply net: each
  // chip's supply pin AND the PSU's own terminal), never routed.
  assert.equal(
    out.powerStubs.filter((s) => s.polarity === "VCC").length,
    3,
    "a VCC symbol at each chip's VCC pin and the PSU + terminal",
  );
  assert.equal(
    out.powerStubs.filter((s) => s.polarity === "GND").length,
    3,
    "a GND symbol at each chip's GND pin and the PSU − terminal",
  );
});

test("discretes and bricks become nodes and route to their chips", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // bb1
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" }); // c1
  doc.addComponent({
    kind: "discrete",
    ref: "led",
    board: "bb1",
    anchor: "e20",
  }); // c2
  doc.addComponent({
    kind: "discrete",
    ref: "sw-slide",
    board: "bb1",
    anchor: "e25",
  }); // c3
  doc.addPsu(140, 0); // psu1
  doc.addBrick("clock", 140, 40); // clk1

  doc.addWire({ from: "bb1.a7", to: "bb1.a20" }); // chip 1Y → LED anode
  doc.addWire({ from: "bb1.a26", to: "bb1.a5" }); // switch common → chip 1A
  doc.addWire({ from: "clk1.out", to: "bb1.a6" }); // clock out → chip 1B

  const out = layout(doc.toJSON(), buildNetlist(doc.toJSON()));

  // Chip, LED, switch, PSU, and clock are ALL symbols now.
  const refs = out.nodes.map((n) => n.ref).sort();
  assert.deepEqual(refs, ["74LS00", "clock", "led", "psu", "sw-slide"]);

  // The three connections routed as ordinary (non-bus) edges.
  const routed = out.edges.filter((e) => !e.bus && e.segments.length);
  assert.ok(routed.length >= 3, "chip↔LED, switch↔chip, clock↔chip all route");

  // The LED node carries its anode/cathode nets for live lighting; sources sit
  // left of the chip, the LED sink to its right.
  const led = out.nodes.find((n) => n.ref === "led");
  const chip = out.nodes.find((n) => n.ref === "74LS00");
  const clk = out.nodes.find((n) => n.ref === "clock");
  assert.ok(led.x > chip.x, "the LED sinks to the right of the chip");
  assert.ok(clk.x <= chip.x, "the clock source feeds from the left");
});
