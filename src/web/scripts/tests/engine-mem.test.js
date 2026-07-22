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

// Feature 170 engine fixtures: memory chips through the pure two-phase engine.
// Circuits are built in code (board + PSU + memory + wires); the byte image is
// passed in as a pure input and reported writes are applied by the harness the
// way SimController does. Covers async ROM read, tri-state on deselect, the
// write→read round-trip, two memories sharing a data bus (Z resolves), and
// engine PURITY (the image is never mutated inside settle/tick).

import test from "node:test";
import assert from "node:assert/strict";

import { H, Z } from "../sim/levels.js";
import { settle, tick as engineTick } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { partPinHoles } from "../model/occupancy.js";
import { holesOfNode, nodeOf } from "../model/breadboard.js";

// ── Fixture builders (shared shape with engine-seq.test.js) ───────────────────

let wireSeq = 0;
const wire = (from, to) => ({ id: `w${++wireSeq}`, from, to, color: "black" });

const board = { id: "bb1", type: "pins-full", x: 0, y: 4 };
const railTop = { id: "bb2", type: "rail-full", x: 0, y: 0 };
const railBottom = { id: "bb3", type: "rail-full", x: 0, y: 18 };
const boards = [board, railTop, railBottom];

const psu = (id, x, volts = 5) => ({
  id,
  kind: "psu",
  ref: "psu",
  x,
  y: 0,
  params: { volts },
});
const chip = (id, ref, anchor) => ({
  id,
  kind: "chip",
  ref,
  board: "bb1",
  anchor,
  params: {},
});

function holesOf(ref, anchor) {
  const m = new Map();
  for (const { pin, hole } of partPinHoles(ref, anchor)) m.set(pin, hole);
  return m;
}
const mates = (hole) =>
  holesOfNode("pins-full", nodeOf("pins-full", hole)).filter((h) => h !== hole);
/** A free hole address on the strip of pin `pin`. */
const strip = (holes, pin, i = 0) => `bb1.${mates(holes.get(pin))[i]}`;

const HI = (k) => `bb2.+${k}`;
const LO = (k) => `bb3.-${k}`;

const power = (psuId, holes, vccPin, gndPin) => [
  wire(`${psuId}.+`, HI(1)),
  wire(`${psuId}.-`, LO(1)),
  wire(strip(holes, vccPin, 0), HI(2)),
  wire(strip(holes, gndPin, 0), LO(2)),
];

/** Tie each pin high/low per bit `i` of `value` (LSB first), on distinct rail holes. */
const driveBits = (holes, pins, value, k0) =>
  pins.map((pin, i) =>
    wire(strip(holes, pin, 0), (value >> i) & 1 ? HI(k0 + i) : LO(k0 + i)),
  );
const tieLow = (holes, pin, k) => wire(strip(holes, pin, 0), LO(k));
const tieHigh = (holes, pin, k) => wire(strip(holes, pin, 0), HI(k));

// The generic 8K×8 parts share one pin layout.
const ADDR = [1, 2, 3, 4, 5, 6, 7, 8, 21, 22, 23, 24, 25]; // A0…A12
const DATA = [9, 10, 11, 12, 13, 17, 18, 19]; // DQ0…DQ7
const CE = 26;
const OE = 27;
const WE = 20; // ram-8k only
const VCC = 28;
const GND = 14;

const ramp8k = () => {
  const a = new Uint8Array(8192);
  for (let i = 0; i < a.length; i++) a[i] = i & 0xff;
  return a;
};

/** A stepping harness that threads images and applies reported writes (SimController-style). */
class MemHarness {
  constructor(doc, images) {
    this.doc = doc;
    this.netlist = buildNetlist(doc);
    this.warm = new Map();
    this.state = new Map();
    this.prev = new Map();
    this.phase = new Map();
    this.images = images ?? new Map();
  }
  tick() {
    const r = engineTick({
      document: this.doc,
      netlist: this.netlist,
      warmStart: this.warm,
      state: this.state,
      prevPinLevels: this.prev,
      clockPhase: this.phase,
      images: this.images,
    });
    this.warm = r.netLevels;
    this.state = r.state;
    this.prev = r.pinLevels;
    this.last = r;
    for (const { compId, addr, value } of r.memWrites) {
      const img = this.images.get(compId);
      if (img && addr >= 0 && addr < img.length) img[addr] = value;
    }
    return r;
  }
  level(addr) {
    return this.warm.get(this.netlist.netOfPoint.get(addr));
  }
  pin(holes, pin) {
    return this.level(`bb1.${holes.get(pin)}`);
  }
  /** Read the data bus of a chip back into an integer. */
  busWord(holes, pins = DATA) {
    return pins.reduce(
      (n, pin, i) => n + (this.pin(holes, pin) === H ? 1 << i : 0),
      0,
    );
  }
}

// ── Async ROM read ────────────────────────────────────────────────────────────

test("a powered, selected rom-8k drives the addressed byte onto its data pins", () => {
  const h = holesOf("rom-8k", "e10");
  const doc = {
    boards,
    components: [psu("psu1", 80), chip("c1", "rom-8k", "e10")],
    wires: [
      ...power("psu1", h, VCC, GND),
      ...driveBits(h, ADDR, 5, 10), // address 5 → ramp byte 5
      tieLow(h, CE, 40), // CE̅ low → selected
      tieLow(h, OE, 41), // OE̅ low → output enabled
    ],
  };
  const bench = new MemHarness(doc, new Map([["c1", ramp8k()]]));
  bench.tick();
  assert.equal(bench.busWord(h), 5, "data bus presents image[5] = 5");
});

test("a rom-8k floats its data bus (high-Z) when CE̅ is deasserted", () => {
  const h = holesOf("rom-8k", "e10");
  const doc = {
    boards,
    components: [psu("psu1", 80), chip("c1", "rom-8k", "e10")],
    wires: [
      ...power("psu1", h, VCC, GND),
      ...driveBits(h, ADDR, 5, 10),
      tieHigh(h, CE, 40), // CE̅ high → deselected
      tieLow(h, OE, 41),
    ],
  };
  const bench = new MemHarness(doc, new Map([["c1", ramp8k()]]));
  bench.tick();
  for (const p of DATA) assert.equal(bench.pin(h, p), Z, `DQ pin ${p} floats`);
});

// ── SRAM write → read round-trip ──────────────────────────────────────────────

test("a ram-8k WE̅-low cycle writes the bus byte; the next read returns it", () => {
  const h = holesOf("ram-8k", "e10");
  const image = new Uint8Array(8192);
  const images = new Map([["c1", image]]);

  // Write phase: an external source drives 0xA5 on the bus at address 5, CE̅·WE̅
  // low. The RAM releases the bus (Z) so the writer wins; the engine reports the
  // write and the harness applies it.
  const writeDoc = {
    boards,
    components: [psu("psu1", 80), chip("c1", "ram-8k", "e10")],
    wires: [
      ...power("psu1", h, VCC, GND),
      ...driveBits(h, ADDR, 5, 10),
      ...driveBits(h, DATA, 0xa5, 30),
      tieLow(h, CE, 44),
      tieLow(h, WE, 45),
      tieHigh(h, OE, 46), // output disabled during the write
    ],
  };
  const writeBench = new MemHarness(writeDoc, images);
  writeBench.tick();
  assert.deepEqual(
    writeBench.last.memWrites,
    [{ compId: "c1", addr: 5, value: 0xa5 }],
    "the write is reported",
  );
  assert.equal(image[5], 0xa5, "and applied to the image");

  // Read phase (same image, no external bus driver): CE̅·OE̅ low, WE̅ high.
  const readDoc = {
    boards,
    components: [psu("psu1", 80), chip("c1", "ram-8k", "e10")],
    wires: [
      ...power("psu1", h, VCC, GND),
      ...driveBits(h, ADDR, 5, 10),
      tieLow(h, CE, 44),
      tieLow(h, OE, 45),
      tieHigh(h, WE, 46),
    ],
  };
  const readBench = new MemHarness(readDoc, images);
  readBench.tick();
  assert.equal(readBench.busWord(h), 0xa5, "read back the written byte");
});

// ── Two memories, one shared data bus ─────────────────────────────────────────

test("two memories share a data bus — the deselected one floats, no conflict", () => {
  const h1 = holesOf("ram-8k", "e10");
  const h2 = holesOf("ram-8k", "e30");
  const img1 = new Uint8Array(8192);
  img1[0] = 0x3c;
  const images = new Map([
    ["c1", img1],
    ["c2", new Uint8Array(8192)],
  ]);
  const doc = {
    boards,
    components: [
      psu("psu1", 80),
      chip("c1", "ram-8k", "e10"),
      chip("c2", "ram-8k", "e30"),
    ],
    wires: [
      ...power("psu1", h1, VCC, GND),
      ...power("psu1", h2, VCC, GND),
      // Shared data bus: DQk of c1 ↔ DQk of c2.
      ...DATA.map((p) => wire(strip(h1, p, 0), strip(h2, p, 1))),
      // Address 0 on both; c1 enabled for read, c2 deselected.
      ...driveBits(h1, ADDR, 0, 10),
      ...driveBits(h2, ADDR, 0, 10),
      tieLow(h1, CE, 44),
      tieLow(h1, OE, 45),
      tieHigh(h1, WE, 46),
      tieHigh(h2, CE, 47), // c2 deselected → its data pins float
    ],
  };
  const bench = new MemHarness(doc, images);
  bench.tick();
  assert.equal(
    bench.busWord(h1),
    0x3c,
    "c1 drives image[0] onto the shared bus",
  );
  assert.ok(
    !bench.last.warnings.some(
      (w) => w.type === "conflict" || w.type === "short",
    ),
    "no bus conflict — the idle memory tri-states",
  );
});

// ── Engine purity ─────────────────────────────────────────────────────────────

test("settle and tick never mutate the byte image (writes are reported, not applied)", () => {
  const h = holesOf("ram-8k", "e10");
  const image = new Uint8Array(8192); // all zero
  const before = Uint8Array.from(image);
  const doc = {
    boards,
    components: [psu("psu1", 80), chip("c1", "ram-8k", "e10")],
    wires: [
      ...power("psu1", h, VCC, GND),
      ...driveBits(h, ADDR, 7, 10),
      ...driveBits(h, DATA, 0xff, 30), // a full write pending
      tieLow(h, CE, 44),
      tieLow(h, WE, 45),
    ],
  };
  const netlist = buildNetlist(doc);
  const images = new Map([["c1", image]]);

  settle({ document: doc, netlist, images });
  assert.deepEqual([...image], [...before], "settle mutates nothing");

  const r = engineTick({ document: doc, netlist, images });
  assert.deepEqual([...image], [...before], "tick mutates nothing");
  assert.ok(
    r.memWrites.length > 0,
    "but tick REPORTS the write for the caller",
  );
  assert.equal(r.memWrites[0].value, 0xff);
});
