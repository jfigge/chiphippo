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

// SimOverlay KEEPS the LED and segment verdicts it hands the desk's views
// (`ledOf` / `segmentOf`), so the 3D view can show the very same lamps
// without applying the junction rule a second time. No DOM: the overlay
// drives whatever "views" it is given, so plain objects stand in for them.

import test from "node:test";
import assert from "node:assert/strict";

import { SimOverlay } from "../components/sim-overlay.js";
import { DeskDoc } from "../model/desk-doc.js";
import { partPinAddresses } from "../model/occupancy.js";

/** A desk with one LED and one seven-segment digit, and a view per part
    that records what it was told. */
function desk() {
  const doc = new DeskDoc();
  doc.addKit("full", 0, 0);
  const board = doc.boards.find((b) => b.type === "pins-full");
  const led = doc.addComponent({
    kind: "discrete",
    ref: "led",
    board: board.id,
    anchor: "e5",
  });
  const digit = doc.addComponent({
    kind: "discrete",
    ref: "seg8cc",
    board: board.id,
    anchor: "a20",
  });
  const views = new Map();
  for (const comp of [led, digit]) {
    const seen = { segments: new Map() };
    views.set(comp.id, {
      seen,
      setLit: (on) => (seen.lit = on),
      setBurnt: (on) => (seen.burnt = on),
      setLevel: (level) => (seen.level = level),
      setSegmentLit: (id, on) => seen.segments.set(id, on),
      setSegmentLevel: (id, level) => seen.segments.set(`${id}:level`, level),
      setSegmentBurnt: () => {},
      setStatus: () => {},
      setTiming: () => {},
    });
  }
  return { doc, led, digit, views };
}

/** A sim-state where each pin's net is its own address, at `levels`. */
function simState(doc, comps, levels, strong) {
  const netOfPoint = new Map();
  for (const comp of comps) {
    for (const { address } of partPinAddresses(doc, comp)) {
      if (address) netOfPoint.set(address, address);
    }
  }
  return {
    running: true,
    netLevels: new Map(Object.entries(levels)),
    strongLevels: new Map(Object.entries(strong)),
    chipStatus: new Map(),
    netlist: { netOfPoint },
  };
}

test("an LED's verdict is kept, and is the one its view was given", () => {
  const { doc, led, digit, views } = desk();
  const overlay = new SimOverlay(doc, views);
  const [anode, cathode] = partPinAddresses(doc, led).map((p) => p.address);
  // Driven through a resistor (not strongly): lit.
  overlay.apply(
    simState(
      doc,
      [led, digit],
      { [anode]: "H", [cathode]: "L" },
      { [cathode]: "L" },
    ),
  );
  assert.deepEqual(overlay.ledOf(led.id), { lit: true, burnt: false, level: 1 }); // prettier-ignore
  assert.equal(views.get(led.id).seen.lit, true);
  // Straight across two strong nets: burnt, and never lit.
  overlay.apply(
    simState(
      doc,
      [led, digit],
      { [anode]: "H", [cathode]: "L" },
      { [anode]: "H", [cathode]: "L" },
    ),
  );
  assert.deepEqual(overlay.ledOf(led.id), { lit: false, burnt: true, level: 1 }); // prettier-ignore
  assert.equal(views.get(led.id).seen.burnt, true);
});

test("a display's segments are kept per segment", () => {
  const { doc, led, digit, views } = desk();
  const overlay = new SimOverlay(doc, views);
  const pins = partPinAddresses(doc, digit);
  const at = (n) => pins.find((p) => p.pin === n).address;
  // Segment a (pin 1) lit, the common cathode (pin 9) low.
  overlay.apply(
    simState(
      doc,
      [led, digit],
      { [at(1)]: "H", [at(9)]: "L" },
      { [at(9)]: "L" },
    ),
  );
  assert.deepEqual(overlay.segmentOf(digit.id, "a"), {
    lit: true,
    burnt: false,
    level: 1,
  });
  assert.deepEqual(overlay.segmentOf(digit.id, "b"), {
    lit: false,
    burnt: false,
    level: 1,
  });
  assert.equal(views.get(digit.id).seen.segments.get("a"), true);
  assert.equal(overlay.segmentOf(digit.id, "zz"), null);
});

test("stopped, there are no verdicts at all", () => {
  const { doc, led, digit, views } = desk();
  const overlay = new SimOverlay(doc, views);
  const [anode, cathode] = partPinAddresses(doc, led).map((p) => p.address);
  overlay.apply(
    simState(doc, [led, digit], { [anode]: "H", [cathode]: "L" }, {}),
  );
  assert.ok(overlay.ledOf(led.id));
  overlay.apply({ running: false });
  assert.equal(overlay.ledOf(led.id), null);
  assert.equal(overlay.segmentOf(digit.id, "a"), null);
  assert.equal(overlay.ledOf("nobody"), null);
});

test("under Spice Lite the LEDs are lit by their current, not the rule", () => {
  // The levels say lit-through-a-resistor; Spice Lite's lamps say how many
  // milliamps — and those win, with a brightness the views are handed.
  const { doc, led, digit, views } = desk();
  const overlay = new SimOverlay(doc, views);
  const [anode, cathode] = partPinAddresses(doc, led).map((p) => p.address);
  const state = simState(
    doc,
    [led, digit],
    { [anode]: "H", [cathode]: "L" },
    { [anode]: "H", [cathode]: "L" }, // the digital rule would burn it
  );
  overlay.apply({
    ...state,
    lamps: new Map([
      [led.id, { lit: true, burnt: false, level: 0.6312 }],
      [`${digit.id}#a`, { lit: false, burnt: true, level: 0 }],
    ]),
  });
  assert.deepEqual(overlay.ledOf(led.id), { lit: true, burnt: false, level: 0.65 }); // prettier-ignore
  assert.equal(views.get(led.id).seen.level, 0.65, "rounded to a twentieth");
  assert.deepEqual(overlay.segmentOf(digit.id, "a"), { lit: false, burnt: true, level: 0 }); // prettier-ignore
  // A segment the solve did not name is dark.
  assert.deepEqual(overlay.segmentOf(digit.id, "b"), { lit: false, burnt: false, level: 0 }); // prettier-ignore
  // Back on the digital engine (no lamps), the plain look: no level.
  overlay.apply(state);
  assert.equal(views.get(led.id).seen.level, null);
});

test("under Spice Lite an LCD's glass is lit by its backlight and driven by VDD − V0", () => {
  const doc = new DeskDoc();
  doc.addKit("full", 0, 0);
  const board = doc.boards.find((b) => b.type === "pins-full");
  const lcd = doc.addComponent({ kind: "discrete", ref: "lcd16x2", board: board.id, anchor: "a10" }); // prettier-ignore
  const seen = [];
  const views = new Map([
    [lcd.id, { renderFramebuffer: () => {}, setPanel: (p) => seen.push(p), setStatus: () => {}, setTiming: () => {} }], // prettier-ignore
  ]);
  const overlay = new SimOverlay(doc, views);
  const state = simState(doc, [lcd], {}, {});
  const pins = partPinAddresses(doc, lcd);
  const at = (n) => pins.find((p) => p.pin === n).address;
  const lamps = new Map([[`${lcd.id}#backlight`, { lit: true, level: 0.8 }]]);
  overlay.apply({ ...state, lamps, nodeVolts: new Map([[at(2), 5], [at(3), 0.5]]) }); // prettier-ignore
  assert.deepEqual(seen.at(-1), { backlight: 0.8, contrast: 1 });
  // V0 at 3.5 V leaves 1.5 V of the 3.0 the controller is specified for.
  overlay.apply({ ...state, lamps, nodeVolts: new Map([[at(2), 5], [at(3), 3.5]]) }); // prettier-ignore
  assert.deepEqual(seen.at(-1), { backlight: 0.8, contrast: 0.5 });
  // V0 left open: blank; the backlight unwired: dark.
  overlay.apply({ ...state, lamps: new Map(), nodeVolts: new Map([[at(2), 5]]) }); // prettier-ignore
  assert.deepEqual(seen.at(-1), { backlight: 0, contrast: 0 });
  // The digital engine: the cosmetic panel.
  overlay.apply(state);
  assert.equal(seen.at(-1), null);
});
