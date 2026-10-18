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

// usb-serial.test.js — the USB-serial adapter (Feature 420): its params, its
// logic on its own, and a looped-back adapter through the real engine, ticked
// at exactly the moments its line wakes ask for, as SimController ticks it.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L } from "../sim/levels.js";
import { tick as engineTick } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { bitTime } from "../sim/uart.js";
import {
  TX_QUEUE,
  initialAdapterState,
  queueBytes,
  receivedSince,
  txBusy,
  txFree,
} from "../sim/usb-serial.js";
import {
  USB_SERIAL_DEF,
  USB_SERIAL_PINS as P,
  usbSerialParams,
  usbSerialSettings,
} from "../catalog/usb-serial.js";
import { partDef } from "../catalog/index.js";

const logic = USB_SERIAL_DEF.logic;

/** The adapter's input pins at given levels. */
const ins = ({ rxd = H, cts = H } = {}) =>
  new Map([
    [P.rxd, rxd],
    [P.cts, cts],
  ]);

test("the adapter is a seated part with the FTDI cable's header", () => {
  const def = partDef("usb-serial");
  assert.equal(def, USB_SERIAL_DEF);
  assert.equal(def.kind, "discrete");
  assert.deepEqual(
    def.pins.map((p) => p.name),
    ["GND", "CTS#", "VCC", "TXD", "RXD", "RTS#"],
  );
  // No supply pins: always powered, as the USB keeps it.
  assert.ok(!def.pins.some((p) => p.role === "vcc" || p.role === "gnd"));
});

test("its params store only what differs from 9600 8N1", () => {
  assert.deepEqual(usbSerialParams({}), {});
  assert.deepEqual(usbSerialParams({ baud: 9600, dataBits: 8, flow: "none" }), {}); // prettier-ignore
  assert.deepEqual(
    usbSerialParams({ baud: "115200", parity: "even", stopBits: 1.5, echo: "on" }), // prettier-ignore
    { baud: 115200, parity: "even", echo: "on" },
  );
  assert.equal(usbSerialParams({ baud: 2e9 }).baud, 1_000_000);
  assert.equal(usbSerialSettings({}).columns, 80);
});

test("the send queue is bounded and reports its room", () => {
  const { state, taken } = queueBytes(initialAdapterState(), [65, 66, 300]);
  assert.equal(taken, 3);
  assert.deepEqual(state.queue, [65, 66, 300 & 0xff]);
  assert.equal(txFree(state), TX_QUEUE - 3);
  assert.ok(txBusy(state));
  const full = queueBytes(state, new Array(TX_QUEUE).fill(1));
  assert.equal(full.taken, TX_QUEUE - 3);
  assert.equal(txFree(full.state), 0);
  assert.equal(queueBytes(full.state, [1]).state, full.state, "a full queue is left as it is"); // prettier-ignore
});

test("transmitting: TXD idles HIGH, then walks the frame bit edge by bit edge", () => {
  const params = { baud: 1000 };
  const bt = bitTime(1000);
  let s = queueBytes(initialAdapterState(), [0x41]).state; // 'A'
  assert.equal(logic.outputs(initialAdapterState()).get(P.txd), H);
  s = logic.step(s, ins(), null, { now: 0, params });
  assert.equal(logic.outputs(s).get(P.txd), L, "the start bit");
  assert.equal(logic.lineWakeAt(s), bt, "woken at bit 0 (a 1)");
  // A repeated step at the same moment changes nothing — the same object.
  assert.equal(logic.step(s, ins(), null, { now: 0, params }), s);
  const seen = [];
  let now = 0;
  for (let i = 0; i < 20 && logic.lineWakeAt(s) != null; i++) {
    now = logic.lineWakeAt(s);
    s = logic.step(s, ins(), null, { now, params });
    seen.push([Math.round(now / bt), logic.outputs(s).get(P.txd)]);
  }
  // 'A' LSB first: 1 0 0 0 0 0 1 0, then the stop bit at 9.
  assert.deepEqual(seen, [
    [1, H],
    [2, L],
    [7, H],
    [8, L],
    [9, H],
    [10, H], // the frame's end, where the next byte would start
  ]);
  assert.equal(s.tx, null);
  assert.equal(logic.lineWakeAt(s), null, "an idle line asks for nothing");
});

test("with RTS/CTS on, the adapter waits for CTS# LOW; with none it ignores it", () => {
  const queued = queueBytes(initialAdapterState(), [0x55]).state;
  const held = logic.step(queued, ins({ cts: H }), null, { now: 0, params: { flow: "rtscts" } }); // prettier-ignore
  assert.equal(held.tx, null, "CTS# HIGH holds it");
  assert.deepEqual(held.queue, [0x55]);
  const going = logic.step(queued, ins({ cts: L }), null, { now: 0, params: { flow: "rtscts" } }); // prettier-ignore
  assert.ok(going.tx);
  const free = logic.step(queued, ins({ cts: H }), null, {
    now: 0,
    params: {},
  });
  assert.ok(free.tx);
});

/** Drive RXD through `changes` ([time, level]), stepping the adapter at
    every change and at every wake it asks for, in time order, up to `until`. */
function receive(changes, params, until, { idle = true } = {}) {
  // The line idle (HIGH) before the frame, as it is on a bench — unless the
  // test is of a line LOW from the start.
  let s = idle
    ? logic.step(initialAdapterState(), ins({ rxd: H }), null, { now: -1, params }) // prettier-ignore
    : initialAdapterState();
  let level = H;
  let i = 0;
  for (;;) {
    const change = i < changes.length ? changes[i][0] : Infinity;
    const now = Math.min(change, logic.lineWakeAt(s) ?? Infinity);
    if (now > until) return s;
    while (i < changes.length && changes[i][0] === now) level = changes[i++][1];
    s = logic.step(s, ins({ rxd: level }), null, { now, params });
  }
}

test("receiving: a frame is decoded at the middle of its stop bit", () => {
  const bt = bitTime(1000);
  // 'Z' = 0x5A = 0101 1010 → LSB first 0 1 0 1 1 0 1 0.
  const changes = [
    [0, L],
    [2 * bt, H],
    [3 * bt, L],
    [4 * bt, H],
    [6 * bt, L],
    [7 * bt, H],
    [8 * bt, L],
    [9 * bt, H],
  ];
  const s = receive(changes, { baud: 1000 }, 12 * bt);
  assert.deepEqual(receivedSince(s, 0), [
    { seq: 1, byte: 0x5a, framingError: false, parityError: false, brk: false },
  ]);
  assert.deepEqual(receivedSince(s, 1), []);
});

test("a line LOW from the start is no frame; it is heard once it has been HIGH", () => {
  const bt = bitTime(1000);
  const low = receive([[0, L]], { baud: 1000 }, 12 * bt, { idle: false });
  assert.equal(low.seq, 0);
  const then = receive([[0, L], [3 * bt, H], [4 * bt, L], [13 * bt, H]], { baud: 1000 }, 20 * bt, { idle: false }); // prettier-ignore
  assert.deepEqual(
    receivedSince(then, 0).map((r) => r.byte),
    [0],
  );
});

test("a dip shorter than half a bit is no frame; a held-low line is a break", () => {
  const bt = bitTime(1000);
  const glitch = receive([[0, L], [bt / 4, H]], { baud: 1000 }, 12 * bt); // prettier-ignore
  assert.equal(glitch.seq, 0);
  const held = receive(
    [
      [0, H],
      [bt, L],
    ],
    { baud: 1000 },
    14 * bt,
  );
  assert.equal(held.log[0].brk, true);
  assert.equal(held.rxArmed, false, "no new frame until the line comes back HIGH"); // prettier-ignore
});

// ── Through the engine ─────────────────────────────────────────────────────

const pinBoard = { id: "bb1", type: "pins-full", x: 0, y: 4 };
const railTop = { id: "bb2", type: "rail-full", x: 0, y: 0 };
const railBottom = { id: "bb3", type: "rail-full", x: 0, y: 18 };

/** An adapter in j1–j6 with TXD looped to RXD (and, optionally, CTS# held). */
function loopDoc(params = {}, { cts = null } = {}) {
  const wires = [
    { id: "w1", from: "psu1.+", to: "bb2.+1", color: "red" },
    { id: "w2", from: "psu1.-", to: "bb3.-1", color: "black" },
    { id: "w3", from: "bb1.i1", to: "bb3.-2", color: "black" }, // GND
    { id: "w4", from: `bb1.i${P.txd}`, to: `bb1.i${P.rxd}`, color: "yellow" },
  ];
  if (cts) wires.push({ id: "w5", from: `bb1.i${P.cts}`, to: cts === H ? "bb2.+3" : "bb3.-3", color: "blue" }); // prettier-ignore
  return {
    boards: [pinBoard, railTop, railBottom],
    components: [
      {
        id: "psu1",
        kind: "psu",
        ref: "psu",
        x: 80,
        y: 0,
        params: { volts: 5 },
      },
      { id: "c1", kind: "discrete", ref: "usb-serial", board: "bb1", anchor: "j1", params }, // prettier-ignore
    ],
    wires,
  };
}

/** Run a desk as SimController would: a tick at `now`, then one at each
    moment its line wakes ask for, until the line is quiet. */
function runLine(doc, bytes, { maxTicks = 5000 } = {}) {
  const netlist = buildNetlist(doc);
  let state = new Map();
  let prev = new Map();
  let warm = new Map();
  let now = 0;
  const run = (at) => {
    const r = engineTick({ document: doc, netlist, warmStart: warm, state, prevPinLevels: prev, now: at }); // prettier-ignore
    warm = r.netLevels;
    state = r.state;
    prev = r.pinLevels;
    return r;
  };
  let r = run(now);
  state = new Map(state).set("c1", queueBytes(state.get("c1"), bytes).state);
  r = run(now);
  let ticks = 0;
  while (r.lineWakeAt != null && ticks++ < maxTicks) {
    now = r.lineWakeAt;
    r = run(now);
  }
  return { state: state.get("c1"), ticks, now, result: r };
}

test("a looped-back adapter hears every byte it sends, in every format", () => {
  const text = [..."Hello, World!\r\n"].map((c) => c.charCodeAt(0));
  for (const params of [
    {},
    { baud: 50 },
    { baud: 115200 },
    { baud: 300, dataBits: 7, parity: "even", stopBits: 2 },
    { baud: 19200, parity: "odd" },
  ]) {
    const { state, ticks } = runLine(loopDoc(params), text);
    const got = receivedSince(state, 0);
    const mask = (1 << (params.dataBits ?? 8)) - 1;
    assert.deepEqual(got.map((r) => r.byte), text.map((b) => b & mask), JSON.stringify(params)); // prettier-ignore
    assert.ok(got.every((r) => !r.framingError && !r.parityError), JSON.stringify(params)); // prettier-ignore
    // One tick per edge sent, plus one per frame received: never more than
    // ~10 a byte for 8N1.
    assert.ok(ticks <= text.length * 12, `${ticks} ticks for ${text.length} bytes`); // prettier-ignore
  }
});

test("the engine reports the line wake beside the timed wake, unclamped", () => {
  const doc = loopDoc({ baud: 115200 });
  const netlist = buildNetlist(doc);
  const first = engineTick({ document: doc, netlist, now: 0 });
  const state = new Map(first.state).set("c1", queueBytes(first.state.get("c1"), [0x55]).state); // prettier-ignore
  const r = engineTick({ document: doc, netlist, warmStart: first.netLevels, state, prevPinLevels: first.pinLevels, now: 0 }); // prettier-ignore
  assert.equal(r.wakeAt, null, "an adapter is no timed part");
  assert.ok(Math.abs(r.lineWakeAt - bitTime(115200)) < 1e-12);
});

test("CTS# held HIGH under RTS/CTS keeps the line idle", () => {
  const { state, ticks } = runLine(loopDoc({ flow: "rtscts" }, { cts: H }), [0x41]); // prettier-ignore
  assert.equal(ticks, 0);
  assert.equal(state.queue.length, 1);
  const open = runLine(loopDoc({ flow: "rtscts" }, { cts: L }), [0x41]);
  assert.deepEqual(
    receivedSince(open.state, 0).map((r) => r.byte),
    [0x41],
  );
});

test("a mismatched rate reads as framing errors or the wrong bytes", () => {
  // Send at 9600, listen at 4800: the adapter's two halves share one setting,
  // so the mismatch is staged with two adapters' worth of logic by hand.
  const bt = bitTime(9600);
  // 0x00 at 9600 is nine bits LOW — four and a half at 4800, so the slow
  // reader takes its upper data bits from the idle line.
  const sent = [0x00];
  let tx = queueBytes(initialAdapterState(), sent).state;
  let rx = logic.step(initialAdapterState(), ins(), null, { now: -1, params: { baud: 4800 } }); // prettier-ignore
  let now = 0;
  for (let i = 0; i < 100; i++) {
    tx = logic.step(tx, ins(), null, { now, params: { baud: 9600 } });
    const level = logic.outputs(tx).get(P.txd);
    rx = logic.step(rx, ins({ rxd: level }), null, { now, params: { baud: 4800 } }); // prettier-ignore
    const next = [logic.lineWakeAt(tx), logic.lineWakeAt(rx)].filter((t) => t != null); // prettier-ignore
    if (!next.length) break;
    now = Math.min(...next);
  }
  const got = receivedSince(rx, 0);
  assert.ok(got.length > 0);
  assert.ok(got.some((r) => r.byte !== 0x00 || r.framingError), "not read cleanly"); // prettier-ignore
  assert.ok(now > 0 && bt > 0);
});

// ── The adapter's example (demos/usb-serial.chiphippo) ────────────────────

test("the example: pressing the button sends the switches' byte, at 300 baud", async () => {
  const { readFileSync } = await import("node:fs");
  const shipped = JSON.parse(
    readFileSync(
      new URL("../../demos/usb-serial.json", import.meta.url),
      "utf8",
    ),
  );
  const { doc } = shipped.desktops[0];
  const clock = doc.components.find((c) => c.kind === "clock");
  const adapter = doc.components.find((c) => c.ref === "usb-serial");
  const button = doc.components.find((c) => c.ref === "sw-push");
  const half = 1 / (2 * clock.params.hz);
  const idle = buildNetlist(doc);
  const pressed = buildNetlist(doc, new Map([[button.id, { pressed: true }]]));
  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  let level = L;
  let lineWake = null;
  const warnings = new Set();
  const run = (now, netlist) => {
    const r = engineTick({ document: doc, netlist, warmStart: warm, state, prevPinLevels: prev, clockPhase: new Map([[clock.id, level]]), now }); // prettier-ignore
    warm = r.netLevels;
    state = r.state;
    prev = r.pinLevels;
    lineWake = r.lineWakeAt;
    for (const w of r.warnings) warnings.add(w.type);
  };
  // As SimController runs it: every clock edge, and every line wake between.
  let t = 0;
  let edge = 0;
  run(0, idle);
  while (t < 0.2) {
    const nextEdge = (edge + 1) * half;
    t = lineWake != null && lineWake < nextEdge ? lineWake : nextEdge;
    if (t === nextEdge) {
      edge++;
      level = level === H ? L : H;
    }
    run(t, t >= 0.05 && t < 0.08 ? pressed : idle);
  }
  assert.deepEqual([...warnings], []);
  const got = receivedSince(state.get(adapter.id), 0);
  assert.deepEqual(got.map((r) => [r.byte, r.framingError]), [[0x41, false]], "one 'A', and no power-up garbage"); // prettier-ignore
});
