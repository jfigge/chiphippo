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
function loadDemo(base) {
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
  const image = new Uint8Array(8192);
  image.set(parsed.subarray(0, image.length));
  const rom = doc.components.find((c) => c.ref === "rom-8k");
  return { doc, images: new Map([[rom.id, image]]) };
}

/** Run the engine for `cycles` full clock periods; return the last result. */
function run(doc, images, cycles) {
  const netlist = buildNetlist(doc);
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
    });
    warm = last.netLevels;
    state = last.state;
    prev = last.pinLevels;
  }
  return { netlist, state, sample: last };
}

test("demo 65xx-blink: the CPU program toggles the VIA port and lights the LED", () => {
  const { doc, images } = loadDemo("65xx-blink");
  const netlist = buildNetlist(doc);

  const via = doc.components.find((c) => c.ref === "w65c22");
  const pb0Hole = partPinHoles("w65c22", via.anchor).find(
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
  const lcd = state.get("lcd1");
  assert.ok(lcd, "the LCD controller ran");
  assert.equal(lcd.displayOn, true, "display turned on");
  assert.equal(
    String.fromCharCode(lcd.ddram[0], lcd.ddram[1]),
    "HI",
    "DDRAM holds the printed text",
  );
});
