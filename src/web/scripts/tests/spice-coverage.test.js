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

// spice-coverage.test.js — every part the palette offers, and a designed
// chip, placed on a powered bench and run under Spice Lite: no part may throw
// or put a NaN into what the tick publishes (a net's voltage, a lead's
// current, a supply's reading, a lamp's verdict). A smoke test of coverage,
// not of physics — what each part does is its own suite's.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L } from "../sim/levels.js";
import { ENGINES } from "../sim/engines.js";
import { buildNetlist } from "../sim/netlist.js";
import { PALETTE_DEFS, partDef, setCustomChips } from "../catalog/index.js";
import { newCustomChip } from "../model/custom-chip.js";
import { partPinAddresses, partPinHoles } from "../model/occupancy.js";
import { bench } from "./timing-fixtures.js";

/** Where a part is tried, in order: straddling the trench, then along row
    a, then in the middle of the lower half. */
const ANCHORS = ["e10", "a10", "c10"];

/** Seat `ref` on a fresh bench and power it: its supply pins to the rails, a
    part with none its first lead to + and its last to −. */
function seated(ref) {
  const def = partDef(ref);
  const b = bench();
  if (def.kind === "clock") {
    b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: def.normalizeParams({ hz: 10 }) }); // prettier-ignore
    b.doc.wires.push(
      { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
      { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
    );
    return b.doc;
  }
  if (def.kind === "psu") return b.doc;
  if (def.kind === "load") {
    b.doc.components.push({ id: "load1", kind: "load", ref: "load", x: 20, y: 30, params: def.normalizeParams({}) }); // prettier-ignore
    b.doc.wires.push(
      { id: "wl1", from: "psu1.+", to: "load1.pos", color: "red" },
      { id: "wl2", from: "psu1.-", to: "load1.neg", color: "black" },
    );
    return b.doc;
  }
  const params = def.normalizeParams?.({}) ?? {};
  const anchor = ANCHORS.find((a) => partPinHoles(ref, a, params)?.length);
  assert.ok(anchor, `${ref} seats somewhere`);
  b.seat("u1", ref, anchor, params);
  // Every pin's hole, a bent or rigid lead's included.
  const at = new Map(
    partPinAddresses(b.doc, b.doc.components.at(-1)).map((p) => [p.pin, p.address]), // prettier-ignore
  );
  const wire = (from, address) => {
    if (!address) return;
    // A hole of the same column-half: its far row.
    const [, row, col] = /^bb1\.([a-j])(\d+)$/.exec(address) ?? [];
    if (!row) return;
    const far = "abcde".includes(row) ? (row === "a" ? "c" : "a") : row === "j" ? "h" : "j"; // prettier-ignore
    b.doc.wires.push({ id: `wp${b.doc.wires.length}`, from, to: `bb1.${far}${col}`, color: "red" }); // prettier-ignore
  };
  const supply = def.pins.filter((p) => p.role === "vcc" || p.role === "gnd");
  if (supply.length) {
    for (const p of supply) wire(p.role === "vcc" ? "psu1.+" : "psu1.-", at.get(p.n)); // prettier-ignore
  } else {
    const list = [...at.keys()].sort((a, c) => a - c);
    if (list.length >= 2) {
      wire("psu1.+", at.get(list[0]));
      wire("psu1.-", at.get(list.at(-1)));
    }
  }
  return b.doc;
}

/** Every number a tick publishes about its voltages and currents. */
function numbers(r) {
  const out = [];
  for (const v of r.nodeVolts.values()) out.push(["nodeVolts", v]);
  for (const v of r.currents.values()) out.push(["currents", v]);
  for (const [id, s] of r.supplies) {
    for (const key of ["set", "volts", "amps", "demand", "limit", "peak"]) {
      out.push([`${id}.${key}`, s[key]]);
    }
  }
  for (const [key, lamp] of r.lamps ?? []) {
    out.push([`lamp ${key}`, lamp.amps]);
    out.push([`lamp ${key} volts`, lamp.volts]);
  }
  for (const [id, tr] of r.transistors ?? []) out.push([`transistor ${id}`, tr.amps]); // prettier-ignore
  return out;
}

/** Run a desk three ticks under Spice Lite, a clock's phase flipping. */
function run(doc) {
  const netlist = buildNetlist(doc);
  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  let analog = null;
  const results = [];
  for (let i = 0; i < 3; i++) {
    const r = ENGINES.spice.tick({
      document: doc,
      netlist,
      warmStart: warm,
      state,
      prevPinLevels: prev,
      clockPhase: new Map([["clk1", i % 2 ? H : L]]),
      now: i * 1e-3,
      spice: { config: { enabled: true }, analog },
    });
    warm = r.netLevels;
    state = r.state;
    prev = r.pinLevels;
    analog = r.analog;
    results.push(r);
  }
  return results;
}

test("every palette part runs under Spice Lite with nothing but numbers", () => {
  const refs = PALETTE_DEFS.map((d) => d.id);
  assert.ok(refs.length > 100, `${refs.length} parts`);
  for (const ref of refs) {
    const doc = seated(ref);
    let results;
    assert.doesNotThrow(() => (results = run(doc)), ref);
    for (const r of results) {
      for (const [what, v] of numbers(r)) {
        assert.ok(Number.isFinite(v), `${ref}: ${what} is ${v}`);
      }
    }
    // A part with supply pins is powered by them: the bench reached it.
    const status = results.at(-1).chipStatus.get("u1")?.status;
    if (partDef(ref).pins?.some((p) => p.role === "vcc")) {
      assert.equal(status, "ok", `${ref} powered`);
    }
  }
});

test("a designed chip runs under Spice Lite with nothing but numbers", () => {
  const chip = newCustomChip([]);
  setCustomChips([chip]);
  try {
    for (const r of run(seated(chip.id))) {
      for (const [what, v] of numbers(r)) {
        assert.ok(Number.isFinite(v), `custom chip: ${what} is ${v}`);
      }
    }
  } finally {
    setCustomChips([]);
  }
});
