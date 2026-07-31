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

// Tests for the pure desk geometry + hit-testing (model/part-geometry.js) —
// the world positions the desk controller draws and hit-tests from.

import test from "node:test";
import assert from "node:assert/strict";

import { spec } from "../model/breadboard.js";
import { applyCatalog } from "../i18n.js";
import {
  addressWorld,
  componentsInRect,
  connectionPointAt,
  deskBounds,
  hoverHitAt,
  partPinsWorld,
  wireEndNear,
  wirePointNear,
  wiresInRect,
} from "../model/part-geometry.js";

const BOARDS = [{ id: "bb1", type: "pins-full", x: 0, y: 0 }];
// 74LS00 at e5: pin 1 in hole e5 (world 5, row e). A PSU brick with + / − terminals.
const CHIP = {
  id: "c1",
  kind: "chip",
  ref: "74LS00",
  board: "bb1",
  anchor: "e5",
};
const PSU = {
  id: "psu1",
  kind: "psu",
  ref: "psu",
  x: 80,
  y: 0,
  params: { volts: 5 },
};

// Rows are MEASURED now (board-types.js): a pin-board's plastic is 35.6 mm, so
// row e sits at 8.51 rather than 8. Name the row, never its y.
const ROW = spec("pins-full").rowY;

test("partPinsWorld: pin 1 sits in its seated hole", () => {
  const pins = partPinsWorld(BOARDS, CHIP);
  const p1 = pins.find((p) => p.pin === 1);
  assert.deepEqual(
    { address: p1.address, x: p1.x, y: p1.y },
    { address: "bb1.e5", x: 5, y: ROW.e },
  );
  assert.equal(partPinsWorld(BOARDS, { ...CHIP, ref: "nope" }), null);
});

test("addressWorld: holes resolve rotation-aware; brick terminals resolve too", () => {
  assert.deepEqual(addressWorld(BOARDS, [], "bb1.a1"), { x: 1, y: ROW.a });
  // The + terminal sits at the brick origin + its offset (2, 4).
  assert.deepEqual(addressWorld(BOARDS, [PSU], "psu1.+"), { x: 82, y: 4 });
  assert.equal(addressWorld(BOARDS, [], "bb1.zz9"), null);
  assert.equal(addressWorld(BOARDS, [], "nope.a1"), null);
});

test("connectionPointAt: a hole wins; a terminal matches within the radius", () => {
  assert.deepEqual(connectionPointAt(BOARDS, [], { x: 1, y: ROW.a }), {
    address: "bb1.a1",
    x: 1,
    y: ROW.a,
  });
  // Just off the + terminal (52, 4) but within PIN_HIT_RADIUS.
  assert.equal(
    connectionPointAt(BOARDS, [PSU], { x: 82.3, y: 4 })?.address,
    "psu1.+",
  );
  assert.equal(connectionPointAt(BOARDS, [PSU], { x: 500, y: 500 }), null);
});

test("componentsInRect: a component counts only when EVERY pin is inside", () => {
  // 74LS00 at e5 spans columns 5–11 across rows e (y 8) and f (y 5).
  const all = { minX: 0, minY: 0, maxX: 20, maxY: 20 };
  const partial = { minX: 0, minY: 0, maxX: 8, maxY: 20 }; // clips cols 9–11
  assert.deepEqual(componentsInRect(BOARDS, [CHIP], all), ["c1"]);
  assert.deepEqual(componentsInRect(BOARDS, [CHIP], partial), []);
});

test("wiresInRect: a wire counts only when BOTH ends are inside", () => {
  const wires = [{ id: "w1", from: "bb1.a1", to: "bb1.a5" }]; // (1,12)…(5,12)
  const both = { minX: 0, minY: 10, maxX: 10, maxY: 14 };
  const one = { minX: 0, minY: 10, maxX: 3, maxY: 14 }; // excludes a5
  assert.deepEqual(wiresInRect(BOARDS, [], wires, both), ["w1"]);
  assert.deepEqual(wiresInRect(BOARDS, [], wires, one), []);
});

test("wireEndNear: grabs the nearest endpoint within reach, else null", () => {
  const wires = [{ id: "w1", from: "bb1.a1", to: "bb1.a20" }]; // (1,12),(20,12)
  const grab = wireEndNear(BOARDS, [], wires, { x: 1.1, y: ROW.a });
  assert.equal(grab.wireId, "w1");
  assert.equal(grab.end, "from");
  assert.equal(wireEndNear(BOARDS, [], wires, { x: 10, y: ROW.a }), null);
});

test("wirePointNear: only a ROUTED wire has waypoints to grab", () => {
  const routed = {
    id: "w1",
    from: "bb1.a1",
    to: "bb1.a20",
    layout: "routed",
    points: [
      { x: 6, y: 20 },
      { x: 15, y: 20 },
    ],
  };
  // A waypoint is a DESK coordinate, so neither boards nor components matter.
  const grab = wirePointNear([routed], { x: 15.2, y: 20.1 });
  assert.equal(grab.wireId, "w1");
  assert.equal(grab.index, 1, "the nearer of the two");
  assert.deepEqual(grab.origin, { x: 15, y: 20 });
  assert.equal(wirePointNear([routed], { x: 10, y: 20 }), null, "out of reach");

  // The same points on a DIRECT wire are not there at all — its shape is the
  // curve between its holes, which nothing can grab a middle of.
  const direct = { ...routed, layout: undefined };
  assert.equal(wirePointNear([direct], { x: 15, y: 20 }), null);
});

test("hoverHitAt: a pin outranks the hole under it; else the bare hole", () => {
  // Over pin 1 of the chip (world 5, 8 = hole e5): the pin wins, and names it.
  const onPin = hoverHitAt(BOARDS, [CHIP], { x: 5, y: ROW.e });
  assert.equal(onPin.key, "c1#1");
  assert.equal(onPin.address, "bb1.e5");
  assert.match(onPin.label, /74LS00 pin 1/);
  // Over an empty hole: the bare address.
  const onHole = hoverHitAt(BOARDS, [CHIP], { x: 1, y: ROW.a });
  assert.deepEqual(
    { key: onHole.key, address: onHole.address },
    { key: "bb1.a1", address: "bb1.a1" },
  );
  assert.equal(hoverHitAt(BOARDS, [], { x: 500, y: 500 }), null);
});

test("hoverHitAt: a brick terminal is hoverable and labelled with its voltage", () => {
  const hit = hoverHitAt(BOARDS, [PSU], { x: 82, y: 4 });
  assert.equal(hit.key, "psu1#+");
  assert.equal(hit.address, "psu1.+");
  assert.match(hit.label, /\+5 V/);
});

// ── The hover label goes through the catalog ────────────────────────────────
// It is the most-read string on the desk and it used to be built by hand, so
// it stayed English in all six other languages while everything around it
// changed. English is what every assertion above proves (no catalog is loaded,
// so `tf()` serves its own fallback); this proves the seam is really there.

const CLOCK = { id: "clk1", kind: "clock", ref: "clock", x: 80, y: 0, params: { hz: 1 } }; // prettier-ignore

test("hoverHitAt: every word of a hover label comes from the catalog", (t) => {
  // A stub catalog rather than a shipped one: this asserts that the KEYS are
  // consulted, which a real translation would prove no better and would tie
  // the test to someone's choice of wording.
  applyCatalog({
    active: "xx",
    lang: "xx",
    messages: {
      desk: {
        hover: {
          pin: "[{ref}·{pin}·{name}·{address}]",
          floating: "[nowhere]",
          psuPlus: "[+{volts}V]",
          psuMinus: "[0V]",
          clockOut: "[clk]",
          clockGnd: "[gnd]",
        },
      },
    },
  });
  // Restore the "no catalog" state the rest of the file runs in, whatever
  // happens below — module state outlives a test.
  t.after(() => applyCatalog({}));

  // A seated pin: the ref and the pin name stay as the catalog for PARTS
  // spells them; the sentence around them is the desk's own.
  assert.equal(
    hoverHitAt(BOARDS, [CHIP], { x: 5, y: ROW.e }).label,
    "[74LS00·1·1A·bb1.e5]",
  );
  // A brick terminal's note — the voltage keeps its unit, which is the same
  // in every language, but the words either side of it do not.
  assert.equal(hoverHitAt(BOARDS, [PSU], { x: 82, y: 4 }).label, "psu1.+ · [+5V]"); // prettier-ignore
  assert.equal(
    hoverHitAt(BOARDS, [PSU], { x: 86, y: 4 }).label,
    "psu1.- · [0V]",
  );
  assert.equal(hoverHitAt(BOARDS, [CLOCK], { x: 82, y: 4 }).label, "clk1.out · [clk]"); // prettier-ignore
  assert.equal(hoverHitAt(BOARDS, [CLOCK], { x: 86, y: 4 }).label, "clk1.gnd · [gnd]"); // prettier-ignore
});

test("hoverHitAt: a floating lead says so in the catalog's words", (t) => {
  applyCatalog({
    active: "xx",
    lang: "xx",
    messages: { desk: { hover: { pin: "{address}", floating: "[nowhere]" } } },
  });
  t.after(() => applyCatalog({}));

  // A resistor bent up onto a rail that has since been pulled away: pin 1 is
  // still seated, pin 2 now reaches nothing. Legal, and exactly the state the
  // word exists to name.
  const resistor = {
    id: "c9",
    kind: "discrete",
    ref: "resistor",
    board: "bb1",
    anchor: "j5",
    params: { rot: 90, end: { dx: 0, dy: -4 } },
  };
  const pins = partPinsWorld(BOARDS, resistor);
  const floating = pins.find((p) => p.address == null);
  assert.ok(floating, "pin 2 hangs off the board, so it resolves to no hole");
  assert.equal(
    hoverHitAt(BOARDS, [resistor], { x: floating.x, y: floating.y }).label,
    "[nowhere]",
  );
});

test("deskBounds: null on an empty desk", () => {
  assert.equal(deskBounds([], [], []), null);
});

test("deskBounds: frames just the board when nothing else exists", () => {
  // pins-full is 64×13 pitch units at its origin.
  assert.deepEqual(deskBounds(BOARDS, [], []), {
    minX: 0,
    minY: 0,
    maxX: 64,
    maxY: spec("pins-full").height, // 14.02 — a measured 35.6 mm
  });
});

test("deskBounds: grows past the board for a brick's terminals and a wire to it", () => {
  // The PSU sits at x 80 with terminals at +2/+6 — its "-" terminal (86, 4)
  // is the furthest point right of the board's own edge (64).
  const wires = [{ id: "w1", from: "bb1.a1", to: "psu1.+" }];
  assert.deepEqual(deskBounds(BOARDS, [PSU], wires), {
    minX: 0,
    minY: 0,
    maxX: 86,
    maxY: spec("pins-full").height, // 14.02 — a measured 35.6 mm
  });
});
