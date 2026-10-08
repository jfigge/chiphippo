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

// jsdom tests for the typed values and the timers ON THE DESK: the Properties
// card's Resistance and Capacitance fields (refused at the field when they do
// not parse), the colour bands and printed values they draw, a timer's Timing
// row, its running readout and wiring warning, and the callback the capacitor
// note hangs off.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
import { buildSpanSvg, buildDiscreteSvg } from "../components/discrete-view.js";
import { buildChipSvg } from "../components/chip-view.js";

const { DeskController } = await import("../components/desk-controller.js");
const { PopupManager } = await import("../popup-manager.js");

function makeDesk(deskDoc, opts = {}, world = { x: 0, y: 0 }) {
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const deskView = {
    surface,
    camera: { cx: 0, cy: 0, zoom: 1 },
    worldFromEvent: () => ({ x: world.x, y: world.y }),
  };
  const controller = new DeskController({
    viewport,
    deskView,
    deskDoc,
    ...opts,
  });
  return { viewport, surface, controller };
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

/** Type into the open card's value box and commit it (blur/Enter). */
const typeValue = (text) => {
  const input = document.querySelector(".properties-combo-input");
  input.value = text;
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  return input;
};
const fieldError = () => document.querySelector(".properties-field-error");

const bandsOf = (root) =>
  [...root.querySelectorAll(".part-resistor-band")].map((b) =>
    [...b.classList]
      .find((c) => c.startsWith("part-resistor-band--"))
      ?.slice("part-resistor-band--".length),
  );

// ── The Resistance field ─────────────────────────────────────────────────────

test("a typed resistance is stored in ohms, shown tidy, and redrawn as bands", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  const r = controller.addComponentAt("resistor", "bb1", "a10");
  openProperties(surface, `[data-component-id="${r.id}"]`);

  const input = document.querySelector(".properties-combo-input");
  assert.equal(input.value, "10kΩ", "the default, printed");
  typeValue("4k7");
  assert.equal(doc.getComponent(r.id).params.ohms, 4700);
  assert.equal(input.value, "4.7kΩ", "shown back in its tidy form");
  assert.equal(fieldError().hidden, true);
  const part = surface.querySelector(`[data-component-id="${r.id}"]`);
  assert.deepEqual(bandsOf(part), ["yellow", "violet", "red", "gold"]);
});

test("text that is not a resistance is refused at the field; the value stays", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  const r = controller.addComponentAt("resistor", "bb1", "a10", { ohms: 220 });
  openProperties(surface, `[data-component-id="${r.id}"]`);
  const input = typeValue("forty-seven");
  assert.equal(doc.getComponent(r.id).params.ohms, 220, "unchanged");
  assert.equal(fieldError().hidden, false, "the error shows");
  assert.match(fieldError().textContent, /Not a resistance/);
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(input.value, "forty-seven", "left there to be fixed");
  // Fixing it clears the error and applies.
  typeValue("1M");
  assert.equal(doc.getComponent(r.id).params.ohms, 1e6);
  assert.equal(fieldError().hidden, true);
  assert.equal(input.hasAttribute("aria-invalid"), false);
});

// ── The Capacitance field ───────────────────────────────────────────────────

test("a capacitor's value is typed with a unit, stored in farads, printed on it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  const c = controller.addComponentAt("cap-electrolytic", "bb1", "a20");
  const label = () =>
    surface.querySelector(`[data-component-id="${c.id}"] .part-cap-label`)
      .textContent;
  assert.equal(label(), "10µ", "the default value is on the part");
  openProperties(surface, `[data-component-id="${c.id}"]`);
  typeValue("100"); // a plain number is farads: out of range, not guessed
  assert.equal(doc.getComponent(c.id).params.farads, 10e-6);
  assert.equal(fieldError().hidden, false);
  typeValue("4u7");
  assert.equal(doc.getComponent(c.id).params.farads, 4.7e-6);
  assert.equal(label(), "4.7µ");
});

test("an electrolytic draws its stripe; a ceramic draws none; both carry values", () => {
  resetDom();
  const electrolytic = buildSpanSvg("cap-electrolytic", 0, 3, { farads: 1e-4 });
  assert.ok(electrolytic.querySelector(".part-cap-stripe"), "polarity marked");
  assert.equal(
    electrolytic.querySelector(".part-cap-label").textContent,
    "100µ",
  );
  const ceramic = buildDiscreteSvg("cap-ceramic", { farads: 2.2e-9 });
  assert.equal(ceramic.querySelector(".part-cap-stripe"), null);
  assert.equal(ceramic.querySelector(".part-cap-label").textContent, "2.2n");
  // The label stays upright whatever angle the leads run at.
  const turned = buildSpanSvg("cap-ceramic", 0, -4, { farads: 1e-7 });
  assert.equal(turned.querySelector(".part-cap-label").closest("g"), null);
});

test("five bands for a three-figure value, on both resistor forms", () => {
  resetDom();
  const five = ["yellow", "violet", "green", "brown", "brown"];
  assert.deepEqual(bandsOf(buildDiscreteSvg("resistor", { ohms: 4750 })), five);
  assert.deepEqual(bandsOf(buildSpanSvg("resistor", 0, 3, { ohms: 4750 })), five); // prettier-ignore
});

// ── A timer's Timing row, readout and warning ───────────────────────────────

test("a timer's Properties card says what it reads its wiring as", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  const u = controller.addComponentAt("NE555", "bb1", "e10");
  openProperties(surface, `[data-component-id="${u.id}"]`);
  const rows = [...document.querySelectorAll(".properties-row")];
  const timing = rows.find(
    (r) => r.querySelector(".properties-label")?.textContent === "Timing",
  );
  assert.ok(timing, "a Timing row");
  assert.match(
    timing.querySelector(".properties-value--wrap").textContent,
    /Wiring not recognised: TRIG \(2\), THRES \(6\) and DISCH \(7\)/,
  );
  // A part that keeps no time has no such row.
  const plain = controller.addComponentAt("74LS00", "bb1", "e30");
  openProperties(surface, `[data-component-id="${plain.id}"]`);
  assert.ok(
    ![...document.querySelectorAll(".properties-label")].some(
      (l) => l.textContent === "Timing",
    ),
  );
});

/** Publish one sim-state carrying timing analyses, as SimController would. */
const publish = (timing, chipStatus = new Map()) =>
  window.dispatchEvent(
    new window.CustomEvent("chiphippo:sim-state", {
      detail: {
        running: true,
        netLevels: new Map(),
        strongLevels: new Map(),
        chipStatus,
        netlist: null,
        clockLevels: new Map(),
        displayState: new Map(),
        timing,
      },
    }),
  );

test("running, a timer prints its rate on its body — amber when drawn slower", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  const u = controller.addComponentAt("NE555", "bb1", "e10");
  const part = () => surface.querySelector(`[data-component-id="${u.id}"]`);
  const readout = () => part().querySelector(".part-chip-timing tspan");
  assert.equal(readout().textContent, "", "nothing before a run");

  const slow = {
    sections: [{ mode: "astable", frequency: 6.87, period: 1 / 6.87, duty: 0.52 }], // prettier-ignore
    problems: [],
  };
  publish(new Map([[u.id, slow]]));
  assert.equal(readout().textContent, "6.87 Hz");
  assert.equal(part().classList.contains("part-chip--capped"), false);

  const fast = {
    sections: [{ mode: "astable", frequency: 48100, period: 1 / 48100, duty: 0.67 }], // prettier-ignore
    problems: [],
  };
  publish(new Map([[u.id, fast]]));
  assert.equal(readout().textContent, "48.1 kHz", "the TRUE rate");
  assert.equal(part().classList.contains("part-chip--capped"), true);
  assert.match(
    part().querySelector(".part-chip-timing title").textContent,
    /drawn at 1 kHz/,
  );

  // Stopping clears it.
  window.dispatchEvent(
    new window.CustomEvent("chiphippo:sim-state", {
      detail: { running: false },
    }),
  );
  assert.equal(readout().textContent, "");
});

test("running, a timer that cannot read its wiring shows the triangle and says why", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  const u = controller.addComponentAt("NE555", "bb1", "e10");
  const part = () => surface.querySelector(`[data-component-id="${u.id}"]`);
  const broken = {
    sections: [{ mode: null }],
    problems: [{ code: "noCapacitor", from: "TRIG/THRES (2, 6)", to: "GND" }],
  };
  publish(
    new Map([[u.id, broken]]),
    new Map([[u.id, { status: "ok", volts: 5 }]]),
  );
  assert.equal(part().classList.contains("part-chip--timing"), true);
  assert.match(
    part().querySelector(".part-chip-status > title").textContent,
    /no timing capacitor from TRIG\/THRES \(2, 6\) to GND/,
  );
  // The Properties card lists the same fault under Warnings.
  openProperties(surface, `[data-component-id="${u.id}"]`);
  const warnings = [...document.querySelectorAll(".properties-warning-text")];
  assert.ok(
    warnings.some((w) => /^Timing not recognised/.test(w.textContent)),
    warnings.map((w) => w.textContent).join(" | "),
  );
  // A power fault speaks first on the desk.
  publish(
    new Map([[u.id, broken]]),
    new Map([[u.id, { status: "unpowered" }]]),
  );
  assert.equal(part().classList.contains("part-chip--timing"), false);
  assert.equal(part().classList.contains("part-chip--unpowered"), true);
});

test("the readout sits upright on a chip seated backwards", () => {
  resetDom();
  const svg = buildChipSvg("CD4098B", { rot: 180 });
  const readout = svg.querySelector(".part-chip-timing");
  assert.ok(readout);
  assert.equal(readout.closest(".part-chip-flipped"), null);
  assert.equal(buildChipSvg("74LS00").querySelector(".part-chip-timing"), null);
});

// ── The capacitor note's hook ───────────────────────────────────────────────

test("placing a part from the tray reports it, so the app can say its note", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const placed = [];
  const world = { x: 10, y: 12 }; // over hole a10
  const { viewport, controller } = makeDesk(
    doc,
    { onPartPlaced: (ref) => placed.push(ref) },
    world,
  );
  controller.armPartPlacement("cap-ceramic");
  viewport.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true })); // prettier-ignore
  viewport.dispatchEvent(
    new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }),
  );
  viewport.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(doc.components.length, 1, "it landed");
  assert.deepEqual(placed, ["cap-ceramic"]);
  // A part added by code (an undo, a paste, the AI) is not a placement.
  controller.addComponentAt("resistor", "bb1", "a30");
  assert.deepEqual(placed, ["cap-ceramic"]);
});
