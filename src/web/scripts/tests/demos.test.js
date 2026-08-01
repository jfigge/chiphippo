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

// demos.test.js — the SHIPPED demo schematics in demos/ (built by
// scripts/make-demos.mjs) must load cleanly AND run: this reads each
// .chiphippo + .hex, seeds the ROM from the hex, and drives the engine to
// confirm the 65xx blink LED toggles and the LCD prints "HI". Guards the demos
// against catalog/engine drift or a stale committed file.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { normalizeDocument } from "../model/desk-doc.js";
import { partPinHoles, partPinAddresses } from "../model/occupancy.js";
import { parseIntelHex } from "../model/hex-format.js";
import { buildNetlist } from "../sim/netlist.js";
import { tick } from "../sim/engine.js";

const H = "H";
const L = "L";
const demo = (name) =>
  fileURLToPath(new URL(`../../../../demos/${name}`, import.meta.url));
const readDemo = (name) => readFileSync(demo(name), "utf8");

/** Load a demo doc + its hex ROM image; assert the loader drops nothing. */
function loadDemo(base, { romRef = "rom-8k", romSize = 8192 } = {}) {
  const doc = JSON.parse(readDemo(`${base}.chiphippo`));
  const norm = normalizeDocument(doc);
  assert.equal(norm.boards.length, doc.boards.length, `${base} boards`);
  assert.equal(
    norm.components.length,
    doc.components.length,
    `${base} components`,
  );
  assert.equal(norm.wires.length, doc.wires.length, `${base} wires`);

  const parsed = parseIntelHex(readDemo(`${base}.hex`));
  const image = new Uint8Array(romSize);
  image.set(parsed.subarray(0, image.length));
  const rom = doc.components.find((c) => c.ref === romRef);
  return { doc, images: new Map([[rom.id, image]]) };
}

/**
 * Run the engine for `cycles` full clock periods; return the last result.
 * The engine REPORTS memory writes and never applies them (that is the
 * SimController's job), so `writable` names the component ids whose image a
 * write may land in — a volatile SRAM. Anything else is dropped, exactly as
 * the app drops a write aimed at a file-backed ROM.
 */
function run(doc, images, cycles, { writable = new Set(), partStates } = {}) {
  const states = partStates ?? new Map();
  const netlist = buildNetlist(doc, states);
  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  let last = null;
  for (let i = 0; i < cycles * 2; i++) {
    last = tick({
      document: doc,
      netlist,
      warmStart: warm,
      state,
      prevPinLevels: prev,
      clockPhase: new Map([["clk1", i % 2 === 0 ? H : L]]),
      images,
      partStates: states,
    });
    warm = last.netLevels;
    state = last.state;
    prev = last.pinLevels;
    for (const w of last.memWrites) {
      if (writable.has(w.compId)) images.get(w.compId)[w.addr] = w.value;
    }
  }
  return { netlist, state, sample: last };
}

test("demo 65xx-blink: the CPU program toggles the VIA port and lights the LED", () => {
  const { doc, images } = loadDemo("65xx-blink");
  const netlist = buildNetlist(doc);

  const via = doc.components.find((c) => c.ref === "W65C22");
  const pb0Hole = partPinHoles("W65C22", via.anchor).find(
    (p) => p.pin === 10,
  ).hole;
  const pb0Net = netlist.netOfPoint.get(`${via.board}.${pb0Hole}`);
  assert.ok(pb0Net, "PB0 is on a net");

  const led = doc.components.find((c) => c.ref === "led");
  const ledPins = partPinAddresses(doc, led);
  const anodeNet = netlist.netOfPoint.get(
    ledPins.find((p) => p.pin === 1).address,
  );
  const cathodeNet = netlist.netOfPoint.get(
    ledPins.find((p) => p.pin === 2).address,
  );

  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  const seen = new Set();
  let lit = false;
  for (let i = 0; i < 400; i++) {
    const r = tick({
      document: doc,
      netlist,
      warmStart: warm,
      state,
      prevPinLevels: prev,
      clockPhase: new Map([["clk1", i % 2 === 0 ? H : L]]),
      images,
    });
    warm = r.netLevels;
    state = r.state;
    prev = r.pinLevels;
    seen.add(r.netLevels.get(pb0Net));
    if (
      r.netLevels.get(anodeNet) === H &&
      r.netLevels.get(cathodeNet) === L &&
      !(
        r.strongLevels.get(anodeNet) === H &&
        r.strongLevels.get(cathodeNet) === L
      )
    ) {
      lit = true;
    }
  }
  assert.ok(seen.has(H) && seen.has(L), "PB0 blinks");
  assert.ok(lit, "the LED lights (not over-driven)");
});

test("demo 65xx-lcd: the CPU program initialises the HD44780 and prints HI", () => {
  const { doc, images } = loadDemo("65xx-lcd");
  const { state } = run(doc, images, 300);
  // By REF, not by a hard-coded id: the module is an ordinary seated part now,
  // so its id moves with the demo's component numbering.
  const id = doc.components.find((c) => c.ref === "lcd16x2")?.id;
  const lcd = id && state.get(id);
  assert.ok(lcd, "the LCD controller ran");
  assert.equal(lcd.displayOn, true, "display turned on");
  assert.equal(
    String.fromCharCode(lcd.ddram[0], lcd.ddram[1]),
    "HI",
    "DDRAM holds the printed text",
  );
});

test("demo eater-core: the CPU runs out of ROM and keeps its stack in RAM", () => {
  const { doc, images } = loadDemo("eater-core", {
    romRef: "AT28C256",
    romSize: 32768,
  });
  const ram = doc.components.find((c) => c.ref === "HM62256");
  assert.ok(ram, "the SRAM is on the desk");
  images.set(ram.id, new Uint8Array(32768));

  run(doc, images, 450, { writable: new Set([ram.id]) });
  const bytes = images.get(ram.id);

  // The program counts to 5 in RAM at $0200 through a subroutine, so this one
  // byte proves the whole path: ROM fetch, RAM write, RAM read-back, and the
  // 74LS00 decode keeping the two memories off each other's bus.
  assert.equal(bytes[0x0200], 5, "the RAM counter reached 5");
  // JSR at $8008 pushes the address of its last operand byte, $800A. Finding it
  // on the stack page proves the stack is REALLY in the SRAM — the CPU has no
  // memory of its own to fake it with.
  assert.equal(bytes[0x01ff], 0x80, "return address high byte on the stack");
  assert.equal(bytes[0x01fe], 0x0a, "return address low byte on the stack");
});

test("demo eater-io: the CPU prints through the VIA and reads the buttons", () => {
  const load = () =>
    loadDemo("eater-io", { romRef: "AT28C256", romSize: 32768 });
  const screen = (doc, state) => {
    const id = doc.components.find((c) => c.ref === "lcd16x2")?.id;
    const lcd = id && state.get(id);
    assert.ok(lcd, "the LCD controller ran");
    assert.equal(lcd.displayOn, true, "display turned on");
    return String.fromCharCode(...lcd.ddram.subarray(0, 16)).replace(
      /\s+$/,
      "",
    );
  };
  const withRam = (doc, images) => {
    const ram = doc.components.find((c) => c.ref === "HM62256");
    images.set(ram.id, new Uint8Array(32768));
    return new Set([ram.id]);
  };

  // Untouched: the CPU brings the VIA up and prints through its two ports.
  {
    const { doc, images } = load();
    const writable = withRam(doc, images);
    const { state } = run(doc, images, 900, { writable });
    assert.equal(screen(doc, state), "Hello, world!");
  }

  // Holding SW3 must print '3'. That single character is the whole input path:
  // the pull-up holds PA2 high, the press pulls it low against that pull, the
  // VIA reads the PIN back on IRA, and the program's bit scan turns the right
  // bit into the right digit. A press is transient runtime state, so it comes
  // in as `partStates` — exactly how the app supplies a held button.
  {
    const { doc, images } = load();
    const writable = withRam(doc, images);
    const buttons = doc.components.filter((c) => c.ref === "sw-push");
    assert.equal(buttons.length, 5, "five buttons on the desk");
    const { state } = run(doc, images, 900, {
      writable,
      partStates: new Map([[buttons[2].id, { pressed: true }]]),
    });
    assert.equal(screen(doc, state), "Hello, world!3");
  }
});
