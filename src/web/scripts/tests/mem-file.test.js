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

// Feature 190: the SimController's file-backed ROM lifecycle. With a stubbed
// window.chiphippo.mem, we prove a non-volatile ROM LOADS its GUID file before
// it ticks (the file's bytes drive the bus), a VOLATILE SRAM does NO file I/O
// at all, a non-volatile chip is READ-ONLY (a circuit write is dropped — even
// on the writable EEPROM), and a programmed chip whose file went missing raises
// a data-loss warning.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { H } from "../sim/levels.js";
import { partPinHoles } from "../model/occupancy.js";
import { holesOfNode, nodeOf } from "../model/breadboard.js";

const { SimController } = await import("../components/sim-controller.js");

// ── Circuit fixture ───────────────────────────────────────────────────────────

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
const memChip = (id, ref, anchor, params = {}) => ({
  id,
  kind: "chip",
  ref,
  board: "bb1",
  anchor,
  params,
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

const power = (holes, vccPin, gndPin) => [
  wire("psu1.+", HI(1)),
  wire("psu1.-", LO(1)),
  wire(strip(holes, vccPin, 0), HI(2)),
  wire(strip(holes, gndPin, 0), LO(2)),
];
const driveBits = (holes, pins, value, k0) =>
  pins.map((pin, i) =>
    wire(strip(holes, pin, 0), (value >> i) & 1 ? HI(k0 + i) : LO(k0 + i)),
  );
const tieLow = (holes, pin, k) => wire(strip(holes, pin, 0), LO(k));
const tieHigh = (holes, pin, k) => wire(strip(holes, pin, 0), HI(k));

// rom-8k (non-volatile, no WE — pure ROM).
const ROM = {
  ref: "rom-8k",
  addr: [1, 2, 3, 4, 5, 6, 7, 8, 21, 22, 23, 24, 25],
  data: [9, 10, 11, 12, 13, 17, 18, 19],
  ce: 26,
  oe: 27,
  vcc: 28,
  gnd: 14,
};
// 28C16 (non-volatile EEPROM — has WE, but read-only in this app).
const EEPROM = {
  ref: "28C16",
  addr: [8, 7, 6, 5, 4, 3, 2, 1, 19, 22, 23],
  data: [9, 10, 11, 13, 14, 15, 16, 17],
  ce: 18,
  oe: 20,
  we: 21,
  vcc: 24,
  gnd: 12,
};

// ── Stubs ─────────────────────────────────────────────────────────────────────

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

/** A window.chiphippo.mem stub: an in-memory GUID→bytes table + recorded calls. */
function installMem({ files = new Map() } = {}) {
  const calls = { create: [], load: [], write: [], program: [], delete: [] };
  window.chiphippo = {
    mem: {
      async create(guid, len) {
        calls.create.push({ guid, len });
        const existed = files.has(guid);
        if (!existed) files.set(guid, new Uint8Array(len));
        return { ok: true, created: !existed };
      },
      async load(guid, len) {
        calls.load.push({ guid, len });
        const out = new Uint8Array(len);
        const b = files.get(guid);
        if (b) out.set(b.subarray(0, Math.min(b.length, len)));
        return { ok: true, bytes: out };
      },
      async write(guid, bytes) {
        calls.write.push({ guid, bytes: [...bytes] });
        files.set(guid, Uint8Array.from(bytes));
        return { ok: true };
      },
      async program(guid) {
        calls.program.push({ guid });
        return { ok: true };
      },
      async delete(guid) {
        calls.delete.push({ guid });
        files.delete(guid);
        return { ok: true, removed: true };
      },
    },
  };
  return { calls, files };
}

const GUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** A read circuit for a memory: selected & output-enabled at `addr`. */
function readDoc(part, anchor, addr, params) {
  const h = holesOf(part.ref, anchor);
  const wires = [
    ...power(h, part.vcc, part.gnd),
    ...driveBits(h, part.addr, addr, 10),
    tieLow(h, part.ce, 40),
    tieLow(h, part.oe, 41),
  ];
  if (part.we != null) wires.push(tieHigh(h, part.we, 42)); // not writing
  return {
    doc: {
      boards,
      components: [psu("psu1", 80), memChip("c1", part.ref, anchor, params)],
      wires,
    },
    holes: h,
  };
}

function busWord(detail, holes, dataPins) {
  const { netLevels, netlist } = detail;
  return dataPins.reduce((n, pin, i) => {
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

test("a ROM loads its GUID file on Run BEFORE ticking (file bytes drive the bus)", async () => {
  resetDom();
  const romFile = new Uint8Array(8192);
  romFile[5] = 0x5a;
  const { calls } = installMem({ files: new Map([[GUID, romFile]]) });
  const { doc, holes } = readDoc(ROM, "e10", 5, { storage: { guid: GUID } });
  const sim = new SimController({
    deskDoc: fakeDoc(doc),
    notifications: fakeNotifications(),
  });
  const events = captureSimState();

  await sim.start();
  assert.deepEqual(
    calls.create,
    [{ guid: GUID, len: 8192 }],
    "ensured the file exists",
  );
  assert.deepEqual(
    calls.load,
    [{ guid: GUID, len: 8192 }],
    "loaded it, byte-sized",
  );
  assert.equal(
    busWord(events.at(-1), holes, ROM.data),
    0x5a,
    "the file byte drives the bus",
  );
  sim.stop();
});

test("a volatile SRAM does NO file I/O at all", async () => {
  resetDom();
  const { calls } = installMem();
  const h = holesOf("ram-8k", "e10");
  const doc = {
    boards,
    components: [psu("psu1", 80), memChip("c1", "ram-8k", "e10")],
    wires: power(h, 28, 14),
  };
  const sim = new SimController({
    deskDoc: fakeDoc(doc),
    notifications: fakeNotifications(),
  });

  const pending = sim.start();
  assert.equal(pending, undefined, "no ROM → Run stays synchronous");
  sim.stop();
  assert.deepEqual(calls.create, [], "never creates a file");
  assert.deepEqual(calls.load, [], "never loads");
  assert.deepEqual(calls.write, [], "never writes");
});

test("a non-volatile EEPROM is READ-ONLY — a circuit write is dropped", async () => {
  resetDom();
  const file = new Uint8Array(2048);
  file[5] = 0x11; // the programmed byte at address 5
  installMem({ files: new Map([[GUID, file]]) });

  // Write phase: drive 0xAA at addr 5 with CE·WE low — the app can't really
  // write an EEPROM, so this must be ignored.
  const h = holesOf("28C16", "e5");
  const writeDoc = {
    boards,
    components: [
      psu("psu1", 80),
      memChip("c1", "28C16", "e5", { storage: { guid: GUID } }),
    ],
    wires: [
      ...power(h, EEPROM.vcc, EEPROM.gnd),
      ...driveBits(h, EEPROM.addr, 5, 10),
      ...driveBits(h, EEPROM.data, 0xaa, 30),
      tieLow(h, EEPROM.ce, 44),
      tieLow(h, EEPROM.we, 45),
      tieHigh(h, EEPROM.oe, 46),
    ],
  };
  const sim = new SimController({
    deskDoc: fakeDoc(writeDoc),
    notifications: fakeNotifications(),
  });
  await sim.start();
  sim.stop();

  // Read phase (fresh controller, same file): the byte must still be 0x11.
  const { doc, holes } = readDoc(EEPROM, "e5", 5, { storage: { guid: GUID } });
  const sim2 = new SimController({
    deskDoc: fakeDoc(doc),
    notifications: fakeNotifications(),
  });
  const events = captureSimState();
  await sim2.start();
  assert.equal(
    busWord(events.at(-1), holes, EEPROM.data),
    0x11,
    "the write never took",
  );
  sim2.stop();
});

test("a programmed ROM whose file went missing warns of data loss", async () => {
  resetDom();
  const notifications = fakeNotifications();
  installMem(); // empty table → create() reports created:true (file was missing)
  const { doc } = readDoc(ROM, "e10", 0, {
    storage: { guid: GUID },
    programmed: true,
  });
  const sim = new SimController({ deskDoc: fakeDoc(doc), notifications });

  await sim.start();
  assert.ok(
    notifications.calls.some(
      (c) => c.variant === "danger" && /data lost/i.test(c.title),
    ),
    "a programmed chip with a recreated (noise) file is flagged",
  );
  sim.stop();
});

test("an UNprogrammed ROM whose file is created stays silent (fresh noise is expected)", async () => {
  resetDom();
  const notifications = fakeNotifications();
  installMem(); // empty → create() reports created:true, but chip isn't programmed
  const { doc } = readDoc(ROM, "e10", 0, { storage: { guid: GUID } });
  const sim = new SimController({ deskDoc: fakeDoc(doc), notifications });

  await sim.start();
  assert.ok(
    !notifications.calls.some((c) => /data lost/i.test(c.title ?? "")),
    "no loss warning for a never-programmed chip",
  );
  sim.stop();
});
