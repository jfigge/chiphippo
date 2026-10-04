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

// The potentiometer (catalog `pot`): a track between pins 1 and 3 and a
// wiper (pin 2) that taps it. From the wiper to pin 1 is Position × R and to
// pin 3 the rest; each side is a resistor, except a side with none of the
// track left, which is a WIRE — and burns an LED like one. Held here through
// the catalog, the whole engine (the LED rule, a 555's timing), the desk
// drawing and the Properties card's slider.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { partDef } from "../catalog/index.js";
import { potentiometerSplit } from "../catalog/parts.js";
import { settle } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { junctionState, isLit } from "../sim/junction.js";
import { DeskDoc } from "../model/desk-doc.js";
import { buildDiscreteSvg, discreteBox } from "../components/discrete-view.js";
import { bench, runner } from "./timing-fixtures.js";

const { DeskController } = await import("../components/desk-controller.js");
const { PopupManager } = await import("../popup-manager.js");

// ── The part ────────────────────────────────────────────────────────────────

test("three pins in a row, the wiper in the middle, a Resistance and a Position", () => {
  const def = partDef("pot");
  assert.equal(def.kind, "discrete");
  assert.equal(def.group, "Resistors");
  assert.deepEqual(def.footprint.offsets, [0, 1, 2]);
  assert.deepEqual(
    def.pins.map((p) => [p.n, p.name, p.role]),
    [
      [1, "1", "lead"],
      [2, "W", "wiper"],
      [3, "3", "lead"],
    ],
  );
  const fields = def.properties.map((f) => [f.key, f.type]);
  assert.deepEqual(fields, [
    ["ohms", "combo"],
    ["position", "range"],
  ]);
  const position = def.properties.find((f) => f.key === "position");
  assert.equal(position.min, 0);
  assert.equal(position.max, 100);
});

test("its params are a value and a whole percent, centred unless said", () => {
  const def = partDef("pot");
  assert.deepEqual(def.normalizeParams({}), { ohms: 10000, position: 50 });
  assert.deepEqual(def.normalizeParams({ ohms: 1e5, position: 10 }), {
    ohms: 1e5,
    position: 10,
  });
  assert.equal(def.normalizeParams({ position: -5 }).position, 0);
  assert.equal(def.normalizeParams({ position: 140 }).position, 100);
  assert.equal(def.normalizeParams({ position: 33.6 }).position, 34);
  assert.equal(def.normalizeParams({ position: "junk" }).position, 50);
  assert.equal(def.normalizeParams({ ohms: -1 }).ohms, 10000);
});

test("100k divides as the slider says: pin 1 gets Position × R, pin 3 the rest", () => {
  const at = (position) => potentiometerSplit({ ohms: 1e5, position });
  assert.deepEqual(at(0), { toPin1: 0, toPin3: 1e5 });
  assert.deepEqual(at(10), { toPin1: 1e4, toPin3: 9e4 });
  assert.deepEqual(at(50), { toPin1: 5e4, toPin3: 5e4 });
  assert.deepEqual(at(90), { toPin1: 9e4, toPin3: 1e4 });
  assert.deepEqual(at(100), { toPin1: 1e5, toPin3: 0 });
});

test("a side with no track left is a wire; every other side a resistor of its own value", () => {
  const def = partDef("pot");
  const both = (position) => {
    const params = def.normalizeParams({ ohms: 1e5, position });
    return {
      hard: def.internalBridges(params),
      weak: def.weakBridges(params),
    };
  };
  assert.deepEqual(both(0), { hard: [[2, 1]], weak: [[2, 3, 1e5]] });
  assert.deepEqual(both(10), {
    hard: [],
    weak: [
      [2, 1, 1e4],
      [2, 3, 9e4],
    ],
  });
  assert.deepEqual(both(100), { hard: [[2, 3]], weak: [[2, 1, 1e5]] });
});

// ── The LED rule: the end of the track is a wire ────────────────────────────

/**
 * The wiper on VCC, an LED from pin `leg` to GND (anode a20, cathode a21) —
 * the junction as the desk draws it, read the way every view reads it.
 */
function ledThroughPot(position, leg = 1) {
  const b = bench();
  const pot = b.seat("rv1", "pot", "a10", { ohms: 1e5, position });
  b.vcc(pot.get(2));
  const led = b.seat("d1", "led", "a20");
  b.link(pot.get(leg), led.get(1));
  b.gnd(led.get(2));
  const netlist = buildNetlist(b.doc);
  const result = settle({ document: b.doc, netlist });
  const net = (pin) => netlist.netOfPoint.get(b.at(led.get(pin)));
  return junctionState({
    anode: result.netLevels.get(net(1)),
    cathode: result.netLevels.get(net(2)),
    anodeStrong: result.strongLevels.get(net(1)),
    cathodeStrong: result.strongLevels.get(net(2)),
  });
}

test("at 0 % the wiper sits on pin 1: an LED fed from there burns", () => {
  const state = ledThroughPot(0, 1);
  assert.equal(state.conducting, true);
  assert.equal(state.unlimited, true, "nothing limits it — burnt");
});

test("anywhere between, the track limits it and the LED lights", () => {
  for (const position of [1, 10, 50, 90, 99]) {
    assert.ok(isLit(ledThroughPot(position, 1)), `pin 1 at ${position} %`);
    assert.ok(isLit(ledThroughPot(position, 3)), `pin 3 at ${position} %`);
  }
});

test("at 100 % it is pin 3's side that is the wire, and pin 1's the whole track", () => {
  assert.equal(ledThroughPot(100, 3).unlimited, true, "pin 3 burns it");
  assert.ok(isLit(ledThroughPot(100, 1)), "pin 1 is 100k away and lights it");
  assert.ok(isLit(ledThroughPot(0, 3)), "and at 0 %, pin 3 does");
});

// ── A timing part reads each side's own value ───────────────────────────────

test("a 555 timed through a potentiometer reads the wiper's side of the track", () => {
  // Figure 6-5's astable with RB a 100k pot used as a rheostat: wiper on
  // DISCH, pin 1 on TRIG+THRES, pin 3 left open.
  const build = (position) => {
    const b = bench();
    const u = b.seat("u1", "NE555", "e10");
    b.vcc(u.get(8));
    b.gnd(u.get(1));
    b.vcc(u.get(4));
    b.link(u.get(2), u.get(6));
    const c = b.seat("c1", "cap-electrolytic", "a30", { farads: 10e-6 });
    b.link(c.get(1), u.get(6));
    b.gnd(c.get(2));
    const rb = b.seat("rv1", "pot", "a40", { ohms: 1e5, position });
    b.link(rb.get(2), u.get(7));
    b.link(rb.get(1), u.get(6));
    const ra = b.seat("r1", "resistor", "a50", { ohms: 1e3 });
    b.link(ra.get(1), u.get(7));
    b.vcc(ra.get(2));
    return runner(b.doc).run(0).result.timing.get("u1");
  };
  const at30 = build(30);
  assert.deepEqual(at30.problems, []);
  assert.equal(at30.sections[0].mode, "astable");
  assert.equal(at30.sections[0].rb, 3e4, "30 % of 100k");
  assert.equal(at30.sections[0].ra, 1e3);
  const at80 = build(80);
  assert.equal(at80.sections[0].rb, 8e4);
  assert.ok(
    at80.sections[0].frequency < at30.sections[0].frequency,
    "more track, slower",
  );
});

// ── On the desk ─────────────────────────────────────────────────────────────

test("it is drawn as a blue block printed with its value, centred over its pins", () => {
  resetDom();
  const svg = buildDiscreteSvg("pot", { ohms: 1e5, position: 25 });
  const body = svg.querySelector(".part-pot-body");
  assert.ok(body);
  assert.equal(svg.querySelector(".part-pot-label").textContent, "100k");
  // The real part's pins run under the middle of its body, the wiper (hole
  // 1, y 0) dead centre — so they are hidden beneath it, as a switch's are.
  const num = (attr) => Number(body.getAttribute(attr));
  assert.equal(num("x") + num("width") / 2, 1, "centred on the wiper's hole");
  assert.equal(num("y") + num("height") / 2, 0, "centred on the pin row");
  assert.ok(num("x") < 0 && num("x") + num("width") > 2, "over holes 0…2");
  assert.equal(svg.querySelectorAll(".part-led-leg").length, 0, "no legs");
  assert.ok(svg.querySelector(".part-display-hit"), "the body takes the drag");
  // The box the desk positions and sizes it by holds the whole body.
  const box = discreteBox("pot");
  assert.ok(box.minX <= num("x") && box.minY <= num("y"));
  assert.ok(box.minX + box.width >= num("x") + num("width"));
  assert.ok(box.minY + box.height >= num("y") + num("height"));
});

test("the screw's slot turns with the wiper", () => {
  resetDom();
  const slot = (position) => {
    const line = buildDiscreteSvg("pot", { position }).querySelector(
      ".part-pot-slot",
    );
    const dx =
      Number(line.getAttribute("x2")) - Number(line.getAttribute("x1"));
    const dy =
      Number(line.getAttribute("y2")) - Number(line.getAttribute("y1"));
    return Math.round((Math.atan2(dx, -dy) * 180) / Math.PI);
  };
  assert.equal(slot(0), -135);
  assert.equal(slot(50), 0);
  assert.equal(slot(100), 135);
});

// ── The Properties card's slider ────────────────────────────────────────────

function makeDesk(deskDoc) {
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const deskView = {
    surface,
    camera: { cx: 0, cy: 0, zoom: 1 },
    worldFromEvent: () => ({ x: 0, y: 0 }),
  };
  const controller = new DeskController({ viewport, deskView, deskDoc });
  return { surface, controller };
}

const openProperties = (surface, selector) => {
  PopupManager.close();
  surface.querySelector(selector).dispatchEvent(
    new window.MouseEvent("contextmenu", { bubbles: true, clientX: 9, clientY: 9 }), // prettier-ignore
  );
  [...document.querySelectorAll(".popup-menu-item")]
    .find((b) => b.textContent.trim() === "Properties…")
    .click();
};

test("a slider with no ends to state reads out its percentage instead", async () => {
  resetDom();
  const { PartPropertiesDialog } =
    await import("../components/part-properties-dialog.js");
  const seen = [];
  PartPropertiesDialog.open({
    title: "Knob",
    fields: [{ key: "level", label: "Level", type: "range", min: 0, max: 200 }],
    values: { level: 50 },
    onChange: (key, value) => seen.push([key, value]),
  });
  const slider = document.querySelector(".properties-range-input");
  const readout = document.querySelector(".properties-range-value");
  assert.equal(readout.textContent, "25%", "50 of 0…200");
  assert.equal(document.querySelector(".properties-range-end"), null);
  slider.value = "150";
  slider.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(readout.textContent, "75%");
  assert.deepEqual(seen, [["level", 150]]);
  PopupManager.close();
});

test("the Position slider moves the wiper as it is dragged, its two sides read at its ends", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  const c = controller.addComponentAt("pot", "bb1", "a20", { ohms: 1e5 });
  openProperties(surface, `[data-component-id="${c.id}"]`);
  const slider = document.querySelector(".properties-range-input");
  assert.ok(slider, "the card has a slider");
  assert.equal(slider.type, "range");
  assert.equal(slider.value, "50");
  // Pin 1's side on the left of the track, pin 3's on the right — what the
  // position MEANS, in place of a percentage.
  const ends = () =>
    [".properties-range-end--start", ".properties-range-end--end"].map(
      (sel) => document.querySelector(sel).textContent,
    );
  assert.equal(document.querySelector(".properties-range-value"), null);
  assert.deepEqual(ends(), ["50k", "50k"]);
  // Every step of the drag applies — the `input` event, not a release — and
  // the ends follow it.
  const drag = (value) => {
    slider.value = String(value);
    slider.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  drag(15);
  assert.equal(doc.getComponent(c.id).params.position, 15);
  assert.deepEqual(ends(), ["15k", "85k"]);
  assert.equal(slider.getAttribute("aria-valuetext"), "15k – 85k");
  drag(0);
  assert.equal(doc.getComponent(c.id).params.position, 0);
  assert.deepEqual(ends(), ["0", "100k"], "the wire end reads 0");
  assert.equal(doc.getComponent(c.id).params.ohms, 1e5, "the value is kept");
  // A new Resistance moves the ends too, the slider untouched.
  drag(15);
  const resistance = document.querySelector(".properties-combo-input");
  resistance.value = "10k";
  resistance.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.deepEqual(ends(), ["1.5k", "8.5k"]);
  PopupManager.close();
});
