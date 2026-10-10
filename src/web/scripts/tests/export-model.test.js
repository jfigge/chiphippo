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

// export-model.test.js — the model every exporter reads (Feature 390): the
// part-level netlist, net names, designators, and the small pure pieces the
// writers share (S-expressions, stable UUIDs, sheet packing).

import test from "node:test";
import assert from "node:assert/strict";

import { buildNetlist } from "../sim/netlist.js";
import { partNets } from "../model/part-nets.js";
import { exportNetlist, safeNetName } from "../model/export/export-netlist.js";
import {
  assignDesignators,
  designatorPrefix,
} from "../model/export/designators.js";
import { formatSexpr, parseSexpr, q } from "../model/export/sexpr.js";
import { stableUuid } from "../model/export/stable-uuid.js";
import { packColumns } from "../model/export/sheet-pack.js";
import { safeFileBase } from "../model/export/file-base.js";
import { bench } from "./export-fixtures.js";

const partByRef = (model, ref) => model.parts.filter((p) => p.def.id === ref);
const netOf = (model, part, key) =>
  model.nets.get(part.ports.find((p) => p.key === key).net);

// ── part-nets ────────────────────────────────────────────────────────────────

test("partNets lists every part pin and brick terminal by net, and nothing else", () => {
  const doc = bench();
  const nl = buildNetlist(doc);
  const byNet = partNets(doc, nl);
  const members = [...byNet.values()].flat();
  assert.ok(members.every((m) => m.comp && (m.pin != null || m.terminal)));
  assert.ok(
    members.some((m) => m.terminal === "+"),
    "the PSU's terminal",
  );
  assert.ok(
    members.some((m) => m.comp.ref === "74LS00" && m.pin === 14),
    "a chip's VCC pin",
  );
});

// ── export-netlist ───────────────────────────────────────────────────────────

test("a switch is a part, not a wire: its common and throws stay separate nets", () => {
  const doc = bench();
  const model = exportNetlist(doc);
  const [s1] = partByRef(model, "sw-slide");
  const common = netOf(model, s1, "2");
  const throw1 = netOf(model, s1, "1");
  const throw2 = netOf(model, s1, "3");
  assert.notEqual(common.id, throw1.id, "position 1 is not baked in");
  assert.notEqual(common.id, throw2.id);
});

test("rails are named for their supply, and every net has a unique name", () => {
  const doc = bench();
  const model = exportNetlist(doc);
  const names = [...model.nets.values()].map((n) => n.name);
  assert.equal(new Set(names).size, names.length, "no two nets share a name");
  const [u1] = partByRef(model, "74LS00");
  assert.equal(netOf(model, u1, "14").name, "+5V");
  assert.equal(netOf(model, u1, "14").polarity, "VCC");
  assert.equal(netOf(model, u1, "7").name, "GND");
});

test("a pin alone on its net is a no-connect, and has no net", () => {
  const doc = bench();
  const model = exportNetlist(doc);
  const [u1] = partByRef(model, "74LS00");
  // Gates 2–4 are not wired.
  for (const key of ["4", "5", "6", "8", "13"]) {
    assert.equal(
      u1.ports.find((p) => p.key === key).net,
      null,
      `pin ${key} is NC`,
    );
  }
});

test("a user's net name wins, sanitized for both targets", () => {
  const doc = bench();
  const model0 = exportNetlist(doc);
  const [u1] = partByRef(model0, "74LS00");
  const { hole } = buildNetlist(doc)
    .nets.get(netOf(model0, u1, "3").id)
    .pins.find((p) => p.pin === 3);
  doc.netNames = [{ address: hole, name: "/OUT Y" }];
  const model = exportNetlist(doc);
  assert.equal(netOf(model, partByRef(model, "74LS00")[0], "3").name, "nOUT_Y");
});

test("safeNetName keeps what a label can say and marks active-low", () => {
  assert.equal(safeNetName("D[3]"), "D3");
  assert.equal(safeNetName("/CLR"), "nCLR");
  assert.equal(safeNetName("~OE"), "nOE");
  assert.equal(safeNetName("Q̄"), "nQ");
  assert.equal(safeNetName("QH'"), "QH'");
  assert.equal(safeNetName("carry out"), "carry_out");
  assert.equal(safeNetName("  "), "");
});

// ── designators ──────────────────────────────────────────────────────────────

test("designators follow schematic convention, numbered in document order", () => {
  const comps = [
    { id: "psu1", kind: "psu", ref: "psu" },
    { id: "c1", kind: "chip", ref: "74LS00" },
    { id: "c2", kind: "discrete", ref: "resistor" },
    { id: "c3", kind: "chip", ref: "74LS04" },
    { id: "c4", kind: "discrete", ref: "led" },
    { id: "c5", kind: "discrete", ref: "sw-dip8" },
    { id: "c6", kind: "discrete", ref: "seg8cc" },
    { id: "c7", kind: "discrete", ref: "rnet9" },
    { id: "c8", kind: "discrete", ref: "osc-full" },
    { id: "clk1", kind: "clock", ref: "clock" },
  ];
  const d = assignDesignators(comps);
  assert.deepEqual(
    comps.map((c) => d.get(c.id)),
    ["J1", "U1", "R1", "U2", "D1", "SW1", "DS1", "RN1", "X1", "J2"],
  );
  assert.equal(designatorPrefix({ kind: "discrete", ref: "lcd16x2" }), "DS");
});

test("a part the user named like a designator keeps it; the rest number around it", () => {
  const comps = [
    { id: "c1", kind: "chip", ref: "74LS00" },
    { id: "c2", kind: "chip", ref: "74LS04", name: "U1" },
    { id: "c3", kind: "chip", ref: "74LS08", name: "R9" }, // wrong prefix
  ];
  const d = assignDesignators(comps);
  assert.equal(d.get("c2"), "U1");
  assert.equal(d.get("c1"), "U2");
  assert.equal(d.get("c3"), "U3");
});

// ── sexpr ────────────────────────────────────────────────────────────────────

test("S-expressions quote names and not keywords, and round-trip", () => {
  const node = [
    "symbol",
    q('A "quoted" name'),
    ["at", 1.27, -2.5400000000000005, 0],
    ["pin", "input", "line", ["number", q("1")]],
  ];
  const text = formatSexpr(node);
  assert.match(
    text,
    /\(at 1\.27 -2\.54 0\)/,
    "binary tails never reach a file",
  );
  assert.match(text, /"A \\"quoted\\" name"/);
  const back = parseSexpr(text);
  assert.equal(back[0], "symbol");
  assert.equal(back[1].quoted, 'A "quoted" name');
  assert.equal(back[3][1], "input");
  assert.throws(() => parseSexpr("(a (b)"), /unbalanced/);
});

// ── stable-uuid ──────────────────────────────────────────────────────────────

test("a stable UUID is a UUID, the same for the same inputs, different otherwise", () => {
  const a = stableUuid("sym", "t1", "c1");
  assert.match(
    a,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(stableUuid("sym", "t1", "c1"), a);
  assert.notEqual(stableUuid("sym", "t1", "c2"), a);
  assert.notEqual(stableUuid("sym", "t2", "c1"), a);
});

// ── sheet-pack ───────────────────────────────────────────────────────────────

test("packing keeps the view's column order and never overlaps two parts", () => {
  const view = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 0, y: 10 }],
    ["c", { x: 20, y: 5 }],
    ["d", { x: 1, y: 30 }], // clusters with column x≈0
  ]);
  const size = { a: [10, 8], b: [14, 6], c: [9, 20], d: [5, 5], e: [7, 7] };
  const at = packColumns(
    ["a", "b", "c", "d", "e"],
    view,
    (id) => ({ w: size[id][0], h: size[id][1] }),
    { colGap: 3, rowGap: 2, snap: 1 },
  );
  assert.equal(at.get("a").x, at.get("b").x, "a and b share a column");
  assert.equal(at.get("d").x, at.get("a").x, "a near x joins that column");
  assert.ok(at.get("c").x > at.get("b").x, "c's column is to the right");
  assert.ok(at.get("b").y > at.get("a").y, "stacked in view order");
  const boxes = [...at].map(([id, p]) => ({
    id,
    x0: p.x,
    y0: p.y,
    x1: p.x + size[id][0],
    y1: p.y + size[id][1],
  }));
  for (const a of boxes) {
    for (const b of boxes) {
      if (a.id >= b.id) continue;
      const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
      assert.ok(!overlap, `${a.id} and ${b.id} overlap`);
    }
  }
});

// ── file-base ────────────────────────────────────────────────────────────────

test("a file base is safe on every platform and never empty", () => {
  assert.equal(safeFileBase("Desktop 1"), "Desktop 1");
  assert.equal(safeFileBase("a/b:c*?"), "a_b_c_");
  // Windows' device names are never a file's stem.
  assert.equal(safeFileBase("CON"), "_CON");
  assert.equal(safeFileBase("nul.v2"), "_nul.v2");
  assert.equal(safeFileBase("com1"), "_com1");
  assert.equal(safeFileBase("Console"), "Console");
  assert.equal(safeFileBase("..hidden"), "hidden");
  assert.equal(safeFileBase("-x"), "x");
  assert.equal(safeFileBase(""), "chiphippo");
  assert.equal(safeFileBase("x".repeat(90)).length, 60);
});
