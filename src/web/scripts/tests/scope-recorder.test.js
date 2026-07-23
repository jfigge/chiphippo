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

// Feature 210: the pure logic-analyzer core — bus decode (bit order), net
// resolution through an address (survives a re-key), and the bounded ring.

import test from "node:test";
import assert from "node:assert/strict";

import { decodeBus, readNet, ScopeRecorder } from "../model/scope-recorder.js";

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
