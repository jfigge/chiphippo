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

// Feature 210: the pure logic-analyzer core — bus decode (bit order), net
// resolution through an address (survives a re-key), the bounded ring, and
// the volts a Spice Lite run records beside a net's level.

import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeBus,
  fullScaleOf,
  isSpiceRun,
  readNet,
  readVolts,
  ScopeRecorder,
} from "../model/scope-recorder.js";

// ── decodeBus: MSB:LSB bit order + unknown propagation ───────────────────────

test("decodeBus honors the member→bit mapping (msb first)", () => {
  // D[3:0]: member 0 is bit 3 … member 3 is bit 0. Members H,L,L,H → 1001 = 9.
  const bits = [3, 2, 1, 0];
  assert.deepEqual(decodeBus(["H", "L", "L", "H"], bits), {
    value: 9,
    known: true,
  });
  // Ascending A[0:3]: member 0 is bit 0. Same levels H,L,L,H → 1001 read low-
  // first = bit0 + bit3 = 1 + 8 = 9 as well, but flip to check ordering matters.
  assert.deepEqual(decodeBus(["H", "H", "L", "L"], [0, 1, 2, 3]), {
    value: 3,
    known: true,
  });
  assert.deepEqual(decodeBus(["H", "H", "L", "L"], [3, 2, 1, 0]), {
    value: 12,
    known: true,
  });
});

test("decodeBus reports unknown when any member is not driven", () => {
  assert.deepEqual(decodeBus(["H", "Z", "L"], [2, 1, 0]), {
    value: null,
    known: false,
  });
  assert.deepEqual(decodeBus(["H", "X", "L"], [2, 1, 0]), {
    value: null,
    known: false,
  });
  assert.deepEqual(decodeBus(["H", null, "L"], [2, 1, 0]), {
    value: null,
    known: false,
  });
});

test("decodeBus does not wrap past 31 bits", () => {
  const bits = [32, 0];
  assert.deepEqual(decodeBus(["H", "L"], bits), {
    value: 2 ** 32,
    known: true,
  });
});

// ── readNet: resolve through the address, survive a re-key ───────────────────

test("readNet resolves an address to its net level", () => {
  const detail = {
    netlist: { netOfPoint: new Map([["bb1.f12", "net7"]]) },
    netLevels: new Map([["net7", "H"]]),
  };
  assert.equal(readNet("bb1.f12", detail), "H");
  assert.equal(readNet("bb1.a1", detail), null, "off-circuit → null");
});

test("a channel bound to an address survives a net-key change", () => {
  // Same bench point, two rebuilds that key the net differently — the address
  // still resolves, so the channel keeps sampling the same signal.
  const before = {
    netlist: { netOfPoint: new Map([["bb1.f12", "netA"]]) },
    netLevels: new Map([["netA", "H"]]),
  };
  const after = {
    netlist: { netOfPoint: new Map([["bb1.f12", "netQ"]]) },
    netLevels: new Map([["netQ", "H"]]),
  };
  assert.equal(readNet("bb1.f12", before), "H");
  assert.equal(readNet("bb1.f12", after), "H", "re-keyed net still reads H");
});

// ── ScopeRecorder: contiguous ticks, one column per sample, eviction ─────────

test("each sample appends exactly one column with a monotonic tick", () => {
  const rec = new ScopeRecorder();
  assert.equal(rec.size, 0);
  assert.equal(rec.nextTick, 0);
  rec.sample(new Map([["ch1", "L"]]));
  rec.sample(new Map([["ch1", "H"]]));
  rec.sample(new Map([["ch1", "H"]]));
  assert.equal(rec.size, 3, "three samples → three columns");
  assert.equal(rec.nextTick, 3);
  assert.equal(rec.firstTick, 0);
  assert.equal(rec.lastTick, 2);
  assert.equal(rec.cellAt(0, "ch1"), "L");
  assert.equal(rec.cellAt(2, "ch1"), "H");
});

test("reset clears the ring and rewinds the tick counter", () => {
  const rec = new ScopeRecorder();
  rec.sample(new Map([["ch1", "H"]]));
  rec.reset();
  assert.equal(rec.size, 0);
  assert.equal(rec.nextTick, 0);
  assert.equal(rec.lastTick, -1);
});

test("the ring evicts the oldest column past capacity, scrolling firstTick", () => {
  const rec = new ScopeRecorder({ capacity: 4 });
  for (let i = 0; i < 6; i += 1)
    rec.sample(new Map([["ch1", i % 2 ? "H" : "L"]]));
  assert.equal(rec.size, 4, "capped at capacity");
  assert.equal(rec.nextTick, 6, "tick counter keeps climbing");
  assert.equal(rec.firstTick, 2, "the two oldest columns evicted");
  assert.equal(rec.lastTick, 5);
  assert.equal(rec.columnAt(0), null, "evicted column is gone");
  assert.equal(rec.cellAt(5, "ch1"), "H");
  assert.equal(rec.cellAt(4, "ch1"), "L");
});

test("eviction holds the ring at capacity however long the run", () => {
  // Evicting moves a head rather than shifting the array (at 8000 ticks a
  // second an 8000-long shift per tick was the analyzer's whole cost) — and
  // every reader still sees exactly the newest `capacity` columns.
  const rec = new ScopeRecorder({ capacity: 5 });
  for (let i = 0; i < 23; i += 1) rec.sample(new Map([["ch1", i]]));
  assert.equal(rec.size, 5);
  assert.equal(rec.firstTick, 18);
  assert.equal(rec.lastTick, 22);
  assert.equal(rec.cellAt(17, "ch1"), null, "evicted");
  assert.equal(rec.cellAt(18, "ch1"), 18);
  assert.equal(rec.cellAt(22, "ch1"), 22);
  assert.deepEqual(
    rec.columns().map((c) => c.tick),
    [18, 19, 20, 21, 22],
    "the columns read are the retained ones, oldest first",
  );
  rec.sample(new Map([["ch1", 23]]));
  assert.equal(rec.firstTick, 19);
  assert.equal(rec.columnAt(23).cells.get("ch1"), 23);
});

test("columns keyed by channel id tolerate a channel added mid-run", () => {
  const rec = new ScopeRecorder();
  rec.sample(new Map([["ch1", "H"]])); // ch2 not yet present
  rec.sample(
    new Map([
      ["ch1", "L"],
      ["ch2", 42],
    ]),
  ); // ch2 joins at tick 1
  assert.equal(rec.cellAt(0, "ch2"), null, "no cell before it existed");
  assert.equal(rec.cellAt(1, "ch2"), 42);
  assert.equal(rec.cellAt(1, "ch1"), "L");
});

// ── Volts (Spice Lite's nodeVolts) ──────────────────────────────────────────

test("readVolts resolves an address to its net's voltage, when one is known", () => {
  const detail = {
    netlist: {
      netOfPoint: new Map([
        ["bb1.f12", "n1"],
        ["bb1.a1", "n2"],
      ]),
    },
    nodeVolts: new Map([["n1", 3.16]]),
  };
  assert.equal(readVolts("bb1.f12", detail), 3.16);
  assert.equal(readVolts("bb1.a1", detail), null, "a net with no voltage");
  assert.equal(readVolts("bb9.z1", detail), null, "off-circuit");
  // The digital engine's broadcast carries an empty map.
  assert.equal(readVolts("bb1.f12", { ...detail, nodeVolts: new Map() }), null);
  assert.equal(readVolts("bb1.f12", { netlist: detail.netlist }), null);
});

test("fullScaleOf is the highest SET supply, never a drooped one", () => {
  const supplies = new Map([
    ["psu1", { set: 5, volts: 2.4 }],
    ["psu2", { set: 12, volts: 12 }],
  ]);
  assert.equal(fullScaleOf({ supplies }), 12);
  assert.equal(fullScaleOf({ supplies: new Map() }), 0);
  assert.equal(fullScaleOf({}), 0);
});

test("a column keeps the volts it was given, and only when it has some", () => {
  const rec = new ScopeRecorder();
  rec.sample(new Map([["ch1", "L"]]), { volts: new Map(), fullScale: 5 });
  rec.sample(new Map([["ch1", "L"]]), {
    volts: new Map([["ch1", 1.2]]),
    fullScale: 5,
  });
  assert.equal(rec.columnAt(0).volts, undefined, "an empty map is not kept");
  assert.equal(rec.voltsAt(0, "ch1"), null);
  assert.equal(rec.voltsAt(1, "ch1"), 1.2);
  assert.equal(rec.voltsAt(1, "ch2"), null);
  assert.equal(rec.voltsAt(7, "ch1"), null, "no such tick");
  assert.equal(rec.hasVolts("ch1"), true);
  assert.equal(rec.hasVolts("ch2"), false);
});

test("the full scale only rises during a run and Run starts it over", () => {
  const rec = new ScopeRecorder();
  assert.equal(rec.fullScale, 0);
  rec.sample(new Map(), { fullScale: 5 });
  rec.sample(new Map(), { fullScale: 12 });
  rec.sample(new Map(), { fullScale: 9 });
  rec.sample(new Map()); // a broadcast naming no supply
  assert.equal(rec.fullScale, 12);
  rec.reset();
  assert.equal(rec.fullScale, 0);
});

test("a run is Spice Lite's when its broadcasts carry lamps, until Run resets", () => {
  assert.equal(isSpiceRun({ lamps: new Map() }), true);
  assert.equal(isSpiceRun({ lamps: null }), false, "the digital engine");
  assert.equal(isSpiceRun({}), false);
  const rec = new ScopeRecorder();
  assert.equal(rec.spice, false);
  rec.sample(new Map(), { spice: true });
  rec.sample(new Map());
  assert.equal(rec.spice, true);
  rec.reset();
  assert.equal(rec.spice, false);
});
