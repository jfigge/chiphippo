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

// Feature 180: the SimController's file-backed memory lifecycle. With a stubbed
// window.chiphippo.mem, we prove Run LOADS the backing file before it ticks (a
// bound ROM drives the file's bytes, not its volatile seed), RAM writes FLUSH
// (debounced — deferred until Stop/Pause), a ROM-mode binding REFUSES writes
// with a warning, and a load error BLOCKS that chip without aborting the run.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { H } from "../sim/levels.js";
import { partPinHoles } from "../model/occupancy.js";
import { holesOfNode, nodeOf } from "../model/breadboard.js";

const { SimController } = await import("../components/sim-controller.js");

// ── Circuit fixture (a powered memory driven by rail-tied address/data) ───────

let wireSeq = 0;
const wire = (from, to) => ({ id: `w${++wireSeq}`, from, to, color: "black" });
const board = { id: "bb1", type: "pins-full", x: 0, y: 4 };
const railTop = { id: "bb2", type: "rail-full", x: 0, y: 0 };
const railBottom = { id: "bb3", type: "rail-full", x: 0, y: 18 };
const boards = [board, railTop, railBottom];

const psu = (id, x) => ({
  id,
  kind: "psu",
  ref: "psu",
  x,
  y: 0,
  params: { volts: 5 },
});
const memChip = (id, ref, anchor, storage) => ({
  id,
  kind: "chip",
  ref,
  board: "bb1",
  anchor,
  params: storage ? { storage } : {},
});

const holesOf = (ref, anchor) => {
  const m = new Map();
  for (const { pin, hole } of partPinHoles(ref, anchor)) m.set(pin, hole);
  return m;
};
const mates = (hole) =>
  holesOfNode("pins-full", nodeOf("pins-full", hole)).filter((h) => h !== hole);
const strip = (holes, pin, i = 0) => `bb1.${mates(holes.get(pin))[i]}`;
const HI = (k) => `bb2.+${k}`;
const LO = (k) => `bb3.-${k}`;

const power = (psuId, holes, vccPin, gndPin) => [
  wire(`${psuId}.+`, HI(1)),
  wire(`${psuId}.-`, LO(1)),
  wire(strip(holes, vccPin, 0), HI(2)),
  wire(strip(holes, gndPin, 0), LO(2)),
];
const driveBits = (holes, pins, value, k0) =>
  pins.map((pin, i) =>
    wire(strip(holes, pin, 0), (value >> i) & 1 ? HI(k0 + i) : LO(k0 + i)),
  );
const tieLow = (holes, pin, k) => wire(strip(holes, pin, 0), LO(k));
const tieHigh = (holes, pin, k) => wire(strip(holes, pin, 0), HI(k));

const ADDR = [1, 2, 3, 4, 5, 6, 7, 8, 21, 22, 23, 24, 25];
const DATA = [9, 10, 11, 12, 13, 17, 18, 19];
const CE = 26;
const OE = 27;
const WE = 20;
const VCC = 28;
const GND = 14;

/** A read circuit: ROM/RAM selected & output-enabled at `addr`, no bus driver. */
function readDoc(ref, anchor, storage, addr) {
  const h = holesOf(ref, anchor);
  const wires = [
    ...power("psu1", h, VCC, GND),
    ...driveBits(h, ADDR, addr, 10),
    tieLow(h, CE, 40),
    tieLow(h, OE, 41),
  ];
  if (ref === "ram-8k") wires.push(tieHigh(h, WE, 42));
  return {
    doc: {
      boards,
      components: [psu("psu1", 80), memChip("c1", ref, anchor, storage)],
      wires,
    },
    holes: h,
  };
}

/** A write circuit: an external source drives `value` at `addr`, CE·WE low. */
function writeDoc(ref, anchor, storage, addr, value) {
  const h = holesOf(ref, anchor);
  return {
    doc: {
      boards,
      components: [psu("psu1", 80), memChip("c1", ref, anchor, storage)],
      wires: [
        ...power("psu1", h, VCC, GND),
        ...driveBits(h, ADDR, addr, 10),
        ...driveBits(h, DATA, value, 30),
        tieLow(h, CE, 44),
        tieLow(h, WE, 45),
        tieHigh(h, OE, 46),
      ],
    },
    holes: h,
  };
}

// ── Stubs ─────────────────────────────────────────────────────────────────────

/** A DeskDoc stand-in (the three methods SimController touches). */
function fakeDoc(raw) {
  const doc = JSON.parse(JSON.stringify(raw));
  return {
    toJSON: () => doc,
    getComponent: (id) => doc.components.find((c) => c.id === id) ?? null,
    setComponentParams(id, patch) {
      const c = doc.components.find((x) => x.id === id);
      c.params = { ...c.params, ...patch };
      return c;
    },
  };
}

function fakeNotifications() {
  const calls = [];
  return { calls, notify: (o) => calls.push(o), clear: () => {} };
}

/** A window.chiphippo.mem stub: an in-memory file table + recorded calls. */
function installMem({ files = new Map(), loadError = null } = {}) {
  const calls = { load: [], flush: [], write: [] };
  window.chiphippo = {
    mem: {
      async load(path, len) {
        calls.load.push({ path, len });
        if (loadError) return { ok: false, error: loadError };
        const out = new Uint8Array(len);
        const b = files.get(path);
        if (b) out.set(b.subarray(0, Math.min(b.length, len)));
        return { ok: true, bytes: out };
      },
      async flush(path, writes, len) {
        calls.flush.push({ path, writes: writes.map((w) => ({ ...w })), len });
        let b = files.get(path);
        if (!b) files.set(path, (b = new Uint8Array(len)));
        for (const w of writes) {
          if (w.addr >= 0 && w.addr < len) b[w.addr] = w.value & 0xff;
        }
        return { ok: true };
      },
      async write(path, bytes) {
        calls.write.push({ path, bytes: [...bytes] });
        files.set(path, Uint8Array.from(bytes));
        return { ok: true };
      },
    },
  };
  return { calls, files };
}

/** Read a chip's data bus back into an integer from a captured sim-state. */
function busWord(detail, holes) {
  const { netLevels, netlist } = detail;
  return DATA.reduce((n, pin, i) => {
    const net = netlist.netOfPoint.get(`bb1.${holes.get(pin)}`);
    return n + (netLevels.get(net) === H ? 1 << i : 0);
  }, 0);
}
function captureSimState() {
  const events = [];
  window.addEventListener("chiphippo:sim-state", (e) => events.push(e.detail));
  return events;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("Run loads a bound ROM from disk BEFORE ticking (file bytes drive, not the seed)", async () => {
  resetDom();
  const romFile = new Uint8Array(8192);
  romFile[5] = 0x5a; // the file says byte 5 is 0x5A; the rom-8k SEED would be 5
  const { calls } = installMem({ files: new Map([["/x/rom.bin", romFile]]) });
  const { doc, holes } = readDoc(
    "rom-8k",
    "e10",
    { path: "/x/rom.bin", mode: "rom" },
    5,
  );
  const sim = new SimController({
    deskDoc: fakeDoc(doc),
    notifications: fakeNotifications(),
  });
  const events = captureSimState();

  await sim.start();
  assert.deepEqual(
    calls.load,
    [{ path: "/x/rom.bin", len: 8192 }],
    "loaded once, byte-sized",
  );
  assert.equal(
    busWord(events.at(-1), holes),
    0x5a,
    "the loaded file byte drives the bus",
  );
  sim.stop();
});

test("a bound RAM flushes writes — debounced (deferred until Stop)", async () => {
  resetDom();
  const { calls, files } = installMem();
  const { doc } = writeDoc(
    "ram-8k",
    "e10",
    { path: "/x/scratch.bin", mode: "ram" },
    5,
    0xa5,
  );
  const sim = new SimController({
    deskDoc: fakeDoc(doc),
    notifications: fakeNotifications(),
  });

  await sim.start();
  assert.equal(
    calls.flush.length,
    0,
    "the write is queued, not flushed synchronously",
  );

  sim.stop(); // a Stop forces the final flush
  assert.equal(calls.flush.length, 1, "flushed once on Stop");
  assert.deepEqual(
    calls.flush[0].writes,
    [{ addr: 5, value: 0xa5 }],
    "the dirty byte",
  );
  assert.equal(
    files.get("/x/scratch.bin")[5],
    0xa5,
    "and the file now holds it",
  );
});

test("a ROM-mode binding REFUSES writes with a one-time warning", async () => {
  resetDom();
  const { calls } = installMem();
  const notifications = fakeNotifications();
  // A writable RAM chip, but bound read-only → its WE̅ pulse must be dropped.
  const { doc } = writeDoc(
    "ram-8k",
    "e10",
    { path: "/x/rom.bin", mode: "rom" },
    5,
    0xa5,
  );
  const sim = new SimController({ deskDoc: fakeDoc(doc), notifications });

  await sim.start();
  sim.stop();
  assert.equal(
    calls.flush.length,
    0,
    "nothing is ever flushed to a read-only file",
  );
  assert.ok(
    notifications.calls.some((c) => /read-only/i.test(c.title)),
    "and a read-only warning is raised",
  );
});

test("a load error BLOCKS that chip with a message but the run still starts", async () => {
  resetDom();
  installMem({ loadError: "ENOENT: no such file" });
  const notifications = fakeNotifications();
  const { doc } = readDoc(
    "rom-8k",
    "e10",
    { path: "/missing.bin", mode: "rom" },
    5,
  );
  const sim = new SimController({ deskDoc: fakeDoc(doc), notifications });

  await sim.start();
  assert.equal(sim.running, true, "the run still starts (other chips can run)");
  assert.ok(
    notifications.calls.some(
      (c) => c.variant === "danger" && /not loaded/i.test(c.title),
    ),
    "a clear load-failure message is shown",
  );
  sim.stop();
});

test("an UNBOUND memory stays volatile — no file I/O at all", async () => {
  resetDom();
  const { calls } = installMem();
  const { doc } = writeDoc("ram-8k", "e10", null, 5, 0xa5);
  const sim = new SimController({
    deskDoc: fakeDoc(doc),
    notifications: fakeNotifications(),
  });

  const pending = sim.start();
  assert.equal(pending, undefined, "no bound chip → Run stays synchronous");
  sim.stop();
  assert.deepEqual(calls.load, [], "never loads");
  assert.deepEqual(calls.flush, [], "never flushes");
});
