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

// jsdom tests for the discretes ON THE DESK: the Part number and the optional
// Inductance / Zener voltage fields in the Properties card, a MOSFET's
// Package and an inductor's Style and size, what each part prints on (or
// beside) itself, a transistor's face in either package and the lamp it
// lights while running — ringed while a MOSFET holds — and the card's word
// on it.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
import { partDef } from "../catalog/index.js";
import { partPinHoles } from "../model/occupancy.js";
import {
  buildDiscreteSvg,
  buildSpanSvg,
  discreteBox,
} from "../components/discrete-view.js";

const { DeskController } = await import("../components/desk-controller.js");
const { PopupManager } = await import("../popup-manager.js");

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

const openProperties = (surface, id) => {
  PopupManager.close();
  surface.querySelector(`[data-component-id="${id}"]`).dispatchEvent(
    new window.MouseEvent("contextmenu", { bubbles: true, clientX: 9, clientY: 9 }), // prettier-ignore
  );
  [...document.querySelectorAll(".popup-menu-item")]
    .find((b) => b.textContent.trim() === "Properties…")
    .click();
};

/** The open card's row whose label reads `label`. */
const row = (label) =>
  [...document.querySelectorAll(".properties-row")].find(
    (r) => r.querySelector(".properties-label")?.textContent === label,
  );

/** Type into a row's box and commit it (blur/Enter). */
const type = (label, text) => {
  const input = row(label).querySelector("input");
  input.value = text;
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  return input;
};

const desk = () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  return { doc, ...makeDesk(doc) };
};

// ── Properties ──────────────────────────────────────────────────────────────

test("every discrete's card has a Part number, printed on the part", () => {
  const { doc, surface, controller } = desk();
  const d = controller.addComponentAt("diode", "bb1", "a10");
  openProperties(surface, d.id);
  assert.ok(row("Part number"), "a Part number row");
  type("Part number", "  1N4148 ");
  assert.equal(doc.getComponent(d.id).params.partNumber, "1N4148");
  const label = () =>
    surface.querySelector(`[data-component-id="${d.id}"] .part-span-label`);
  assert.equal(label().textContent, "1N4148");
  // Cleared, it is gone — from the part and from the document.
  openProperties(surface, d.id);
  type("Part number", "");
  assert.ok(!("partNumber" in doc.getComponent(d.id).params));
  assert.equal(label(), null);
});

test("an inductance is optional: typed, refused, and cleared at the field", () => {
  const { doc, surface, controller } = desk();
  const l = controller.addComponentAt("inductor", "bb1", "a10");
  const params = () => doc.getComponent(l.id).params;
  // Printed beside it: its winding (or its bands) covers the body.
  const value = () =>
    surface.querySelector(`[data-component-id="${l.id}"] .part-span-label`)
      ?.textContent ?? null;
  assert.equal(value(), null, "a bare inductor prints no value");
  openProperties(surface, l.id);
  const input = type("Inductance", "4u7");
  assert.equal(params().henries, 4.7e-6);
  assert.equal(input.value, "4.7µH", "shown back tidy");
  assert.equal(value(), "4.7µH");
  type("Part number", "IM02");
  assert.equal(value(), "IM02 4.7µH");
  type("Part number", "");
  // Refused: the value stays, the error shows.
  type("Inductance", "ten");
  assert.equal(params().henries, 4.7e-6);
  const error = row("Inductance").querySelector(".properties-field-error");
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /Not an inductance value/);
  // Blank is an answer, not a mistake: the value goes.
  type("Inductance", "  ");
  assert.equal(error.hidden, true);
  assert.ok(!("henries" in params()));
  assert.equal(value(), null);
});

test("an inductor's Winding is offered only under Spice Lite, each option its ohms", () => {
  const { doc, surface, controller } = desk();
  const l = controller.addComponentAt("inductor", "bb1", "a10");
  const params = () => doc.getComponent(l.id).params;
  // The digital engine runs an inductor as a wire: no Winding to choose.
  openProperties(surface, l.id);
  assert.equal(row("Winding"), undefined);
  controller.setSpiceLite({ enabled: true });
  openProperties(surface, l.id);
  const select = () => row("Winding").querySelector("select");
  const texts = () => [...select().options].map((o) => o.textContent);
  // With no Inductance it is a wire under Spice Lite too: greyed, no ohms.
  assert.equal(select().disabled, true);
  assert.deepEqual(texts(), ["Lowest", "Typical", "Higher", "Highest"]);
  // An Inductance gives every option its resistance — the typical 2-hole
  // coil's 0.74 Ω at 1 mH — and the texts follow the value as it is typed.
  type("Inductance", "1m");
  assert.equal(select().disabled, false);
  assert.deepEqual(texts(), ["Lowest — 0.44Ω", "Typical — 0.74Ω", "Higher — 1.2Ω", "Highest — 1.9Ω"]); // prettier-ignore
  assert.equal(select().value, "typical");
  select().value = "highest";
  select().dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(params().winding, "highest");
  // Back to Typical, it is stored no more (omit-when-default).
  select().value = "typical";
  select().dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.ok(!("winding" in params()));
  // Spice Lite off hides the row and keeps what it stores.
  select().value = "lowest";
  select().dispatchEvent(new window.Event("change", { bubbles: true }));
  controller.setSpiceLite({ enabled: false });
  openProperties(surface, l.id);
  assert.equal(row("Winding"), undefined);
  assert.equal(params().winding, "lowest");
});

test("a Zener's voltage is optional and printed beside it with its part number", () => {
  const { doc, surface, controller } = desk();
  const z = controller.addComponentAt("zener", "bb1", "a10");
  openProperties(surface, z.id);
  // A voltage the common Zeners have brings its part number, into the Part
  // number row as well as the part.
  type("Zener voltage", "5V1");
  assert.equal(doc.getComponent(z.id).params.zenerVolts, 5.1);
  assert.equal(doc.getComponent(z.id).params.partNumber, "1N4733A");
  assert.equal(row("Part number").querySelector("input").value, "1N4733A");
  const label = () =>
    surface.querySelector(`[data-component-id="${z.id}"] .part-span-label`)
      ?.textContent;
  assert.equal(label(), "1N4733A 5.1V");
  type("Part number", "BZX79-C5V1");
  assert.equal(label(), "BZX79-C5V1 5.1V");
  type("Zener voltage", "");
  assert.ok(!("zenerVolts" in doc.getComponent(z.id).params));
  assert.equal(label(), "BZX79-C5V1");
});

// ── Drawing ─────────────────────────────────────────────────────────────────

test("a diode's band is on its cathode end; a Zener's body is glass", () => {
  resetDom();
  const diode = buildSpanSvg("diode", 3, 0);
  const band = diode.querySelector(".part-diode-band");
  // Leads along +x from pin 1 (the anode): the band sits past the middle.
  assert.ok(Number(band.getAttribute("x")) > 1.5, "toward pin 2");
  assert.ok(diode.querySelector(".part-burn"), "it can burn, as an LED can");
  const zener = buildSpanSvg("zener", 3, 0);
  assert.ok(zener.querySelector(".part-diode-body--zener"));
  assert.ok(zener.querySelector(".part-diode-band--zener"));
  // The placement ghost draws the same body.
  assert.ok(buildDiscreteSvg("diode").querySelector(".part-diode-band"));
  assert.ok(buildDiscreteSvg("inductor").querySelector(".part-inductor-core"));
});

test("a label beside a part stays upright: below it across, beside it upright", () => {
  resetDom();
  const across = buildSpanSvg("diode", 3, 0, { partNumber: "1N4148" });
  const label = across.querySelector(".part-span-label");
  assert.equal(label.closest("g"), null, "never inside the rotated body");
  assert.equal(label.getAttribute("text-anchor"), "middle");
  assert.ok(Number(label.getAttribute("y")) > 0.5, "below the leads");
  const upright = buildSpanSvg("diode", 0, 3, { partNumber: "1N4148" });
  const side = upright.querySelector(".part-span-label");
  assert.equal(side.getAttribute("text-anchor"), "start");
  assert.ok(Number(side.getAttribute("x")) > 0.3, "to the right of the leads");
  // Nothing to say, nothing printed.
  assert.equal(buildSpanSvg("diode", 3, 0).querySelector(".part-span-label"), null); // prettier-ignore
});

test("a transistor's face: its part number (or type) and pin letters, turned with it", () => {
  resetDom();
  const pins = (svg) =>
    [...svg.querySelectorAll(".part-transistor-pin")].map((t) => t.textContent);
  const label = (svg) =>
    svg.querySelector(".part-transistor-label").textContent;
  assert.deepEqual(pins(buildDiscreteSvg("npn")), ["E", "B", "C"]);
  assert.deepEqual(pins(buildDiscreteSvg("nmos")), ["S", "G", "D"]);
  assert.deepEqual(pins(buildDiscreteSvg("npn", { rot: 180 })), ["C", "B", "E"]); // prettier-ignore
  assert.deepEqual(pins(buildDiscreteSvg("nmos", { rot: 180 })), ["D", "G", "S"]); // prettier-ignore
  assert.equal(label(buildDiscreteSvg("pnp")), "PNP");
  assert.equal(label(buildDiscreteSvg("pmos")), "PMOS");
  assert.equal(label(buildDiscreteSvg("npn", { partNumber: "2N2222" })), "2N2222"); // prettier-ignore
  assert.ok(buildDiscreteSvg("npn").querySelector(".part-transistor-lamp"));
  assert.ok(buildDiscreteSvg("nmos").querySelector(".part-transistor-lamp"));
});

test("a MOSFET draws as the package it is set to: a TO-220, or a TO-92", () => {
  resetDom();
  const has = (svg, cls) => Boolean(svg.querySelector(`.${cls}`));
  const to220 = buildDiscreteSvg("nmos");
  assert.ok(has(to220, "part-to220-body") && has(to220, "part-to220-tab"));
  assert.ok(!has(to220, "part-to92-body"));
  assert.ok(to220.querySelector(".part-transistor-label--to220"));
  const to92 = buildDiscreteSvg("nmos", { case: "TO-92" });
  assert.ok(has(to92, "part-to92-body") && !has(to92, "part-to220-body"));
  // A BJT is a TO-92 unless set to a TO-220 (a TIP120, a TIP31C).
  assert.ok(has(buildDiscreteSvg("npn"), "part-to92-body"));
  assert.ok(
    has(buildDiscreteSvg("npn", { case: "TO-220" }), "part-to220-body"),
  );
  // The TO-220 is the bigger part, over the same three holes: it reaches a
  // pitch past the outer holes and over the row behind, as the real one
  // does — but only the moulding over its own holes takes the pointer.
  const big = discreteBox("nmos", 0, {});
  const small = discreteBox("nmos", 0, { case: "TO-92" });
  assert.ok(big.width > small.width + 1, "wider");
  assert.ok(big.minY < small.minY, "deeper");
  assert.ok(big.minX < -0.9 && big.minX + big.width > 2.9);
  const hit = to220.querySelector(".part-transistor-hit rect");
  assert.ok(
    Number(hit.getAttribute("x")) > -0.6,
    "clear of the hole to the left",
  );
  assert.ok(
    Number(hit.getAttribute("y")) > -1 + 0.2,
    "clear of the row behind",
  );
});

test("an inductor draws as a toroid or a canned drum from above, bigger over three holes", () => {
  resetDom();
  // A toroid on edge, from above: the top of its ring, a long body centred
  // on its leads and a little longer than they are apart, wound turn after
  // turn — the turns bunched toward the ends, where the ring curves away,
  // and open over the middle, where the dark core shows between them.
  const coil = buildSpanSvg("inductor", 3, 0, { henries: 4.7e-6 });
  const core = coil.querySelector(".part-inductor-core");
  const [cx, cw] = ["x", "width"].map((a) => Number(core.getAttribute(a)));
  assert.ok(Math.abs(cx + cw / 2 - 1.5) < 1e-9, "centred on its leads");
  assert.ok(cw > 3, "a little longer than the leads are apart");
  const xs = [...coil.querySelectorAll(".part-inductor-turn")]
    .map((l) => Number(l.getAttribute("x1")))
    .sort((a, b) => a - b);
  assert.ok(xs.length > 20, "wound");
  const gaps = xs.slice(1).map((x, k) => x - xs[k]);
  const middle = gaps[Math.floor(gaps.length / 2)];
  assert.ok(gaps[0] < middle / 2, "bunched at the ends, open in the middle");
  assert.ok(
    xs.every((x) => x > cx && x < cx + cw),
    "all on the body",
  );
  // One straight lead under it, as every span part has; its value beside it.
  assert.equal(coil.querySelectorAll(".part-span-lead").length, 1);
  assert.equal(coil.querySelector(".part-span-label").textContent, "4.7µH");
  assert.equal(coil.querySelector(".part-inductor-label"), null);
  // A can: a drum seen from above, over its leads, the value on its top and
  // only the part number beside it.
  const can = buildSpanSvg("inductor", 3, 0, {
    henries: 4.7e-6,
    style: "can",
    partNumber: "RLB0913",
  });
  assert.ok(can.querySelector(".part-inductor-drum"));
  assert.ok(can.querySelector(".part-inductor-drum-top"));
  assert.equal(can.querySelector(".part-inductor-core"), null);
  assert.equal(can.querySelectorAll(".part-span-lead").length, 1, "straight");
  assert.equal(can.querySelector(".part-inductor-label").textContent, "4.7µH");
  assert.equal(can.querySelector(".part-span-label").textContent, "RLB0913");
  assert.equal(
    buildSpanSvg("inductor", 3, 0, { style: "can" }).querySelector(
      ".part-inductor-label",
    ),
    null,
    "a bare one prints nothing",
  );
  // Over three holes both are bigger, over one smaller. The body is the hit
  // target too.
  const size = (svg) => {
    const hit = svg.querySelector(".part-display-hit");
    return hit.tagName === "circle"
      ? [2 * Number(hit.getAttribute("r")), 2 * Number(hit.getAttribute("r"))]
      : [Number(hit.getAttribute("width")), Number(hit.getAttribute("height"))];
  };
  const [l2, w2] = size(buildSpanSvg("inductor", 3, 0, {}));
  const [l3, w3] = size(buildSpanSvg("inductor", 4, 0, { bodyHoles: 3 }));
  const [l1, w1] = size(buildSpanSvg("inductor", 2, 0, { bodyHoles: 1 }));
  assert.ok(l2 > 3 && l3 > 4 && w3 > w2, "toroid");
  assert.ok(l1 > 2 && l1 < l2 && w1 < w2, "the small toroid");
  const [d2] = size(buildSpanSvg("inductor", 3, 0, { style: "can" }));
  const [d3] = size(
    buildSpanSvg("inductor", 4, 0, { style: "can", bodyHoles: 3 }),
  );
  // A can sits between its leads: 3.2 across over three holes, two thirds of
  // that over two.
  assert.ok(Math.abs(d3 - 3.2) < 1e-9, "drum over three holes");
  assert.ok(Math.abs(d2 - 3.2 * 0.66) < 0.01, "drum over two holes");
  const [d1] = size(
    buildSpanSvg("inductor", 2, 0, { style: "can", bodyHoles: 1 }),
  );
  assert.ok(Math.abs(d1 - d2 * (2 / 3)) < 0.01, "two thirds again over one");
  // The placement ghost's box holds the whole body and its far lead.
  const box = discreteBox("inductor", 0, { bodyHoles: 3 });
  assert.ok(box.minY < -w3 / 2 && box.minX < 2 - l3 / 2);
  assert.ok(box.minX + box.width >= 2 + l3 / 2, "the far end");
  const canBox = discreteBox("inductor", 0, { style: "can" });
  assert.ok(canBox.minY < -d2 / 2 && canBox.minY + canBox.height > d2 / 2);
  const ghost = buildDiscreteSvg("inductor", { bodyHoles: 3 });
  assert.equal(ghost.querySelector(".part-span-lead").getAttribute("x2"), "4");
});

test("a selected span part is framed round its leads and body, not its padded box", () => {
  const { surface, controller } = desk();
  const l = controller.addComponentAt("inductor", "bb1", "a10", {
    style: "can",
  });
  const part = () => surface.querySelector(`[data-component-id="${l.id}"]`);
  assert.ok(part().classList.contains("part-discrete--span"));
  controller.selectComponent(l.id);
  assert.ok(part().classList.contains("part--selected"));
  // Leads three holes apart, a drum 2.12 across between them: the frame
  // reaches just past the lead ends and just round the drum — 0.2 out, the
  // gap and half the stroke of the outline every other part has.
  const frame = part().querySelector(".part-span-frame");
  const [w, h] = ["width", "height"].map((a) => Number(frame.getAttribute(a)));
  assert.ok(Math.abs(w - 2 * (1.5 + 0.07 + 0.2)) < 1e-9, `width ${w}`);
  assert.ok(Math.abs(h - 2 * (1.06 + 0.2)) < 1e-9, `height ${h}`);
  // It turns with the part (it is drawn in the leads' own frame).
  assert.ok(frame.closest("g[transform^='rotate']"));
  // And the stylesheet shows it in place of the element outline, only while
  // selected (red while refused).
  const css = fs
    .readFileSync(new URL("../../styles/app.css", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector) =>
    css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? ""; // prettier-ignore
  assert.match(rule(".part-span-frame"), /visibility:\s*hidden/);
  assert.match(
    rule(".part--selected .part-span-frame"),
    /visibility:\s*visible/,
  );
  assert.match(rule(".part--illegal .part-span-frame"), /--color-danger/);
  assert.match(
    rule(
      ".part-discrete--span.part--selected,\n.part-discrete--span.part--illegal",
    ),
    /outline:\s*none/,
  );
});

/** Pick a segmented option in the open card's row `label`. */
const pick = (label, value) =>
  [...row(label).querySelectorAll(".segmented-option")]
    .find((b) => b.dataset.value === String(value))
    .click();
const picked = (label) =>
  row(label).querySelector(".segmented-option--active")?.dataset.value;

test("Properties picks a MOSFET's package, and the part redraws", () => {
  const { doc, surface, controller } = desk();
  const q = controller.addComponentAt("nmos", "bb1", "a10");
  const part = () => surface.querySelector(`[data-component-id="${q.id}"]`);
  assert.ok(part().querySelector(".part-to220-body"), "a TO-220 to begin with");
  openProperties(surface, q.id);
  assert.equal(picked("Package"), "TO-220");
  pick("Package", "TO-92");
  assert.equal(doc.getComponent(q.id).params.case, "TO-92");
  assert.ok(part().querySelector(".part-to92-body"));
  assert.equal(part().querySelector(".part-to220-body"), null);
  // A BJT's row shows the TO-92 it stores nothing for, and a TO-220 sticks.
  const n = controller.addComponentAt("npn", "bb1", "a20");
  openProperties(surface, n.id);
  assert.equal(picked("Package"), "TO-92");
  assert.ok(!("case" in doc.getComponent(n.id).params));
  pick("Package", "TO-220");
  assert.equal(doc.getComponent(n.id).params.case, "TO-220");
  PopupManager.close();
});

test("a transistor's Grade is offered under Spice Lite, defaulting by its package", () => {
  const { doc, surface, controller } = desk();
  const q = controller.addComponentAt("npn", "bb1", "a10");
  const params = () => doc.getComponent(q.id).params;
  openProperties(surface, q.id);
  assert.equal(row("Grade"), undefined, "the digital engine has no use for it");
  controller.setSpiceLite({ enabled: true });
  openProperties(surface, q.id);
  const select = () => row("Grade").querySelector("select");
  assert.deepEqual(
    [...select().options].map((o) => o.textContent),
    [
      "Small signal — 2N3904",
      "General purpose — 2N2222A",
      "Darlington — TIP120",
      "Power — TIP31C",
    ],
  );
  assert.equal(select().value, "small-signal", "a TO-92's default");
  // Its package moves the default with it, stored as nothing.
  pick("Package", "TO-220");
  assert.equal(select().value, "power");
  assert.ok(!("grade" in params()));
  select().value = "darlington";
  select().dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(params().grade, "darlington");
  // A listed part brings its grade and package; a typed one neither.
  const box = row("Part number").querySelector("input");
  box.value = "2N3904";
  box.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(params().grade, "darlington", "typed: left alone");
  PopupManager.close();
  controller.setSpiceLite({ enabled: false });
});

test("a listed transistor brings its grade and package", () => {
  const def = partDef("nmos");
  const field = def.properties.find((f) => f.key === "partNumber");
  const irlz = field.options({}).find((o) => o.label === "IRLZ44N");
  assert.deepEqual(irlz.patch, { partNumber: "IRLZ44N", grade: "logic-power", case: "TO-220" }); // prettier-ignore
  const bjt = partDef("npn").properties.find((f) => f.key === "partNumber");
  assert.deepEqual(bjt.options({}).find((o) => o.label === "TIP120").patch, {
    partNumber: "TIP120",
    grade: "darlington",
    case: "TO-220",
  });
});

test("Properties sets an inductor's style and size; a size with no room is refused", () => {
  const { doc, surface, controller } = desk();
  const l = controller.addComponentAt("inductor", "bb1", "a10");
  const params = () => doc.getComponent(l.id).params;
  const part = () => surface.querySelector(`[data-component-id="${l.id}"]`);
  openProperties(surface, l.id);
  assert.equal(picked("Style"), "coil");
  assert.equal(picked("Holes between leads"), "2");
  pick("Style", "can");
  assert.equal(params().style, "can");
  assert.ok(part().querySelector(".part-inductor-drum"));
  // Three holes: pin 2 moves one hole along.
  pick("Holes between leads", 3);
  assert.equal(params().bodyHoles, 3);
  const holes = () =>
    partPinHoles("inductor", "a10", params()).map((p) => p.hole);
  assert.deepEqual(holes(), ["a10", "a14"]);
  const lead = () => part().querySelector(".part-span-lead");
  assert.equal(lead().getAttribute("x2"), "4", "drawn to its new hole");
  pick("Holes between leads", 2);
  assert.equal(params().bodyHoles, 2);
  PopupManager.close();

  // Something in a14: growing would land the lead on it, so the card says
  // no — the choice goes back, the reason shows, the part is untouched.
  controller.addComponentAt("led", "bb1", "a14");
  openProperties(surface, l.id);
  pick("Holes between leads", 3);
  assert.equal(params().bodyHoles, 2, "unchanged");
  assert.equal(
    picked("Holes between leads"),
    "2",
    "the picker shows the truth",
  );
  const error = document.querySelector(".properties-field-error--row");
  assert.ok(error, "a reason is given");
  assert.match(error.textContent, /No room/);
  // A change that goes through clears it.
  pick("Holes between leads", 2);
  assert.equal(document.querySelector(".properties-field-error--row"), null);
  PopupManager.close();

  // While the circuit runs the size is a topology edit, and greyed.
  controller.setEditingLocked(true);
  openProperties(surface, l.id);
  assert.ok(row("Holes between leads").classList.contains("properties-row--disabled")); // prettier-ignore
  assert.ok(!row("Style").classList.contains("properties-row--disabled"));
  PopupManager.close();
  controller.setEditingLocked(false);
});

// ── Running ─────────────────────────────────────────────────────────────────

const publish = (channels) =>
  window.dispatchEvent(
    new window.CustomEvent("chiphippo:sim-state", {
      detail: {
        running: true,
        netLevels: new Map(),
        strongLevels: new Map(),
        chipStatus: new Map(),
        netlist: null,
        clockLevels: new Map(),
        displayState: new Map(),
        timing: new Map(),
        channels,
      },
    }),
  );

test("running, a transistor's lamp lights while it conducts and rings while it holds", () => {
  const { surface, controller } = desk();
  const q = controller.addComponentAt("nmos", "bb1", "a10");
  const part = () => surface.querySelector(`[data-component-id="${q.id}"]`);
  const title = () =>
    part().querySelector(".part-transistor-hit > title").textContent;
  const has = (cls) => part().classList.contains(`part-discrete--${cls}`);

  publish(new Map([[q.id, [{ a: 1, b: 3, on: "H", held: false }]]]));
  assert.deepEqual([has("on"), has("held")], [true, false]);
  assert.equal(title(), "Conducting");

  publish(new Map([[q.id, [{ a: 1, b: 3, on: "H", held: true }]]]));
  assert.deepEqual([has("on"), has("held")], [true, true]);
  assert.match(title(), /holding/);

  // The card says it in words, as a warning — while it is true.
  openProperties(surface, q.id);
  const warning = () =>
    document.querySelector(".properties-warnings:not([hidden])")?.textContent ??
    "";
  assert.match(warning(), /Holding ON/);
  publish(new Map([[q.id, [{ a: 1, b: 3, on: "L", held: true }]]]));
  assert.match(warning(), /Holding OFF/);
  publish(new Map([[q.id, [{ a: 1, b: 3, on: "L", held: false }]]]));
  assert.equal(warning(), "");
  PopupManager.close();

  // Stopped, it shows nothing.
  window.dispatchEvent(
    new window.CustomEvent("chiphippo:sim-state", {
      detail: { running: false },
    }),
  );
  assert.deepEqual([has("on"), has("held")], [false, false]);
  assert.equal(title(), "");
});
