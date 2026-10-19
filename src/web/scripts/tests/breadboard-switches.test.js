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

// The two switches that straddle the channel: the 6 mm tactile button
// (sw-tact, legs two columns apart, each pair across the channel one strip)
// and the 8 mm self-locking DPDT push switch (sw-dpdt, a DIP-6) — seated,
// conducting and simulated in both engines.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L } from "../sim/levels.js";
import { buildNetlist } from "../sim/netlist.js";
import { settle } from "../sim/engine.js";
import { partCoverHoles } from "../model/occupancy.js";
import { DeskDoc } from "../model/desk-doc.js";
import { exportDigital } from "../model/export/digital.js";
import { exportKicad } from "../model/export/kicad.js";
import { bench, runner } from "./timing-fixtures.js";

/** Whether two holes of bench()'s board are one net. */
const joined = (netlist, a, b) =>
  netlist.netOfPoint.get(`bb1.${a}`) === netlist.netOfPoint.get(`bb1.${b}`);

test("sw-tact seats across the channel, legs two columns apart, the column between them under its body", () => {
  const b = bench();
  const pins = b.seat("s1", "sw-tact", "e10");
  assert.deepEqual(Object.fromEntries(pins), { 1: "e10", 2: "e12", 3: "f12", 4: "f10" }); // prettier-ignore
  assert.deepEqual(partCoverHoles("sw-tact", "e10"), ["e11", "f11"]);

  // The body refuses a wire into the holes it stands over; the column's
  // other holes stay free.
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1 rail · bb2 pins · bb3 rail
  doc.addComponent({ kind: "discrete", ref: "sw-tact", board: "bb2", anchor: "e10" }); // prettier-ignore
  assert.equal(doc.canPlaceWire("bb2.e11", "bb2.a20"), false);
  assert.equal(doc.canPlaceWire("bb2.f11", "bb2.a20"), false);
  assert.equal(doc.canPlaceWire("bb2.d11", "bb2.a20"), true);
  // …and it only seats across the channel.
  assert.throws(
    () =>
    doc.addComponent({ kind: "discrete", ref: "sw-tact", board: "bb2", anchor: "a30" }), // prettier-ignore
  );
});

test("sw-tact: each column is one contact across the channel; holding it joins the two", () => {
  const b = bench();
  b.seat("s1", "sw-tact", "e10");
  const released = buildNetlist(b.doc);
  assert.ok(joined(released, "a10", "j10"), "pin 1's strip reaches pin 4's");
  assert.ok(joined(released, "a12", "j12"), "pin 2's strip reaches pin 3's");
  assert.ok(!joined(released, "a10", "a12"), "released, the columns are apart");
  const held = buildNetlist(b.doc, new Map([["s1", { pressed: true }]]));
  assert.ok(joined(held, "a10", "a12"));
  assert.ok(joined(held, "j10", "j12"));
});

test("sw-tact drives an inverter low only while it is held, reached from either side of the channel", () => {
  const b = bench();
  const s = b.seat("s1", "sw-tact", "e10");
  const u = b.seat("u1", "74LS04", "e20");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  b.gnd(s.get(4)); // ground into the row-f half…
  b.link(s.get(3), u.get(1)); // …the input off the row-f half too
  const level = (pressed) => {
    const netlist = buildNetlist(b.doc, new Map([["s1", { pressed }]]));
    const r = settle({ document: b.doc, netlist });
    return r.netLevels.get(netlist.netOfPoint.get(b.at(u.get(2))));
  };
  // An open TTL input floats high: the output is LOW until the press grounds it.
  assert.equal(level(false), L);
  assert.equal(level(true), H);
});

for (const engine of ["digital", "spice"]) {
  test(`sw-dpdt routes each common to A released and to B latched (${engine})`, () => {
    const b = bench();
    const s = b.seat("s1", "sw-dpdt", "e30");
    // Pole 1 picks + or − for one inverter; pole 2 the opposite for another.
    const u = b.seat("u1", "74LS04", "e10");
    b.vcc(u.get(14));
    b.gnd(u.get(7));
    b.vcc(s.get(1)); // 1A
    b.gnd(s.get(3)); // 1B
    b.gnd(s.get(6)); // 2A
    b.vcc(s.get(4)); // 2B
    b.link(s.get(2), u.get(1)); // COM1 → inverter 1
    b.link(s.get(5), u.get(3)); // COM2 → inverter 2
    const sim = runner(b.doc, { engine });
    sim.run(0);
    assert.equal(sim.level(u.get(2)), L, "COM1 on 1A (+)");
    assert.equal(sim.level(u.get(4)), H, "COM2 on 2A (−)");
    b.doc.components.find((c) => c.id === "s1").params.on = true;
    sim.rebuild();
    sim.run(0.01);
    assert.equal(sim.level(u.get(2)), H, "latched: COM1 on 1B (−)");
    assert.equal(sim.level(u.get(4)), L, "latched: COM2 on 2B (+)");
  });
}

test("the exports join a tactile button's legs and split a DPDT into its poles", () => {
  const b = bench();
  const s = b.seat("s1", "sw-tact", "e10");
  const d = b.seat("s2", "sw-dpdt", "e30");
  // One wire per side of the button, each into a different leg's half.
  b.vcc(s.get(4));
  b.link(s.get(2), d.get(2));
  b.gnd(d.get(1));
  const digital = exportDigital(b.doc, { tabId: "t", name: "x" });
  const xml = digital.files[0].text;
  assert.equal((xml.match(/<elementName>SwitchDT<\/elementName>/g) ?? []).length, 2); // prettier-ignore
  assert.equal((xml.match(/<elementName>Switch<\/elementName>/g) ?? []).length, 1); // prettier-ignore
  assert.ok(
    digital.report.some((e) => e.ref === "sw-tact" && e.code === "momentary"),
  );

  const kicad = exportKicad(b.doc, { tabId: "t", name: "x" });
  const sheet = kicad.files.find((f) => f.name.endsWith(".kicad_sch")).text;
  // The tactile's pins 1 and 4 share KiCad's pad 1: one stub there, and no
  // no-connect flag on a pin that is wired through its partner.
  assert.match(sheet, /SW_PUSH_6mm/);
  // Only the DPDT's four unwired throws are flagged.
  assert.equal((sheet.match(/\(no_connect/g) ?? []).length, 4);
  assert.match(sheet, /SW_Push_2P2T_Toggle_CK_PVA2xxH1xxxxxxV2/);
  assert.ok(
    kicad.report.some(
      (e) => e.ref === "sw-dpdt" && e.code === "nearestFootprint",
    ),
  );
});
