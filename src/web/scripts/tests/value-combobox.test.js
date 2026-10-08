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

// jsdom tests for the value combo boxes in a part's Properties card
// (components/value-combobox.js, over catalog/value-fields.js): picking one
// of the common values, typing any other, the red state a bad value leaves,
// the list narrowing as you type, a capacitor's and a transistor's Type
// swapping the part, a Zener's voltage bringing its part number, and an older
// document's value read — or kept, red — when its card opens.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";

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

const desk = (raw = null) => {
  resetDom();
  const doc = new DeskDoc(raw);
  if (!raw) doc.addBoard("pins-full", 0, 0);
  return { doc, ...makeDesk(doc) };
};

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
const box = (label) => row(label).querySelector(".properties-combo-input");
const note = (label) => row(label).querySelector(".properties-field-error");
const list = (label) => row(label).querySelector(".properties-combo-list");
const entries = (label) =>
  [...list(label).querySelectorAll(".properties-combo-option")].map(
    (o) => o.textContent,
  );
const title = () => document.querySelector(".popup-title, .popup-header h2");

/** Type into a combo and leave it (the `change` a blur fires). */
const type = (label, text) => {
  const input = box(label);
  input.value = text;
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  return input;
};
const key = (label, k) => {
  const e = new window.KeyboardEvent("keydown", {
    key: k,
    bubbles: true,
    cancelable: true,
  });
  box(label).dispatchEvent(e);
  return e;
};
const pickEntry = (label, text) =>
  [...list(label).querySelectorAll(".properties-combo-option")]
    .find((o) => o.textContent === text)
    .click();

// ── Picking and typing ──────────────────────────────────────────────────────

test("the ▾ drops every common value, the current one marked; a pick applies", () => {
  const { doc, surface, controller } = desk();
  const r = controller.addComponentAt("resistor", "bb1", "a10");
  openProperties(surface, r.id);
  assert.equal(box("Resistance").value, "10kΩ");
  assert.equal(box("Resistance").getAttribute("role"), "combobox");
  assert.equal(list("Resistance").hidden, true);
  row("Resistance").querySelector(".properties-combo-toggle").click();
  assert.equal(list("Resistance").hidden, false);
  assert.equal(box("Resistance").getAttribute("aria-expanded"), "true");
  const all = entries("Resistance");
  assert.equal(all.length, 61, "the E12 series, 10Ω to 1MΩ");
  assert.deepEqual([all[0], all.at(-1)], ["10Ω", "1MΩ"]);
  const marked = list("Resistance").querySelector(
    ".properties-combo-option--active",
  );
  assert.equal(marked.textContent, "10kΩ", "the current one");
  pickEntry("Resistance", "4.7kΩ");
  assert.equal(doc.getComponent(r.id).params.ohms, 4700);
  assert.equal(box("Resistance").value, "4.7kΩ");
  assert.equal(list("Resistance").hidden, true);
  PopupManager.close();
});

test("any other value can be typed; it is read, stored and shown tidy", () => {
  const { doc, surface, controller } = desk();
  const r = controller.addComponentAt("resistor", "bb1", "a10");
  openProperties(surface, r.id);
  type("Resistance", "100 kilo ohms");
  assert.equal(doc.getComponent(r.id).params.ohms, 1e5);
  assert.equal(box("Resistance").value, "100kΩ");
  // A non-standard value, silently: four figures kept, not rounded.
  type("Resistance", "4753");
  assert.equal(doc.getComponent(r.id).params.ohms, 4753);
  assert.equal(box("Resistance").value, "4.753kΩ");
  assert.equal(note("Resistance").hidden, true);
  // Enter reads it too.
  box("Resistance").value = "2M2";
  key("Resistance", "Enter");
  assert.equal(doc.getComponent(r.id).params.ohms, 2.2e6);
  assert.equal(box("Resistance").value, "2.2MΩ");
  PopupManager.close();
});

test("a value that does not read goes red, says why, and changes nothing", () => {
  const { doc, surface, controller } = desk();
  const r = controller.addComponentAt("resistor", "bb1", "a10", { ohms: 220 });
  openProperties(surface, r.id);
  type("Resistance", "10uF");
  assert.equal(doc.getComponent(r.id).params.ohms, 220, "unchanged");
  assert.equal(note("Resistance").hidden, false);
  assert.equal(
    note("Resistance").textContent,
    "That's a capacitance, not a resistance",
  );
  assert.equal(box("Resistance").getAttribute("aria-invalid"), "true");
  assert.equal(box("Resistance").value, "10uF", "left there to be fixed");
  type("Resistance", "1m");
  assert.equal(note("Resistance").textContent, "Out of range: 0.1Ω to 100MΩ");
  type("Resistance", "abc");
  assert.equal(note("Resistance").textContent, "Not a resistance value");
  // Fixing it clears the red and applies.
  type("Resistance", "47k");
  assert.equal(doc.getComponent(r.id).params.ohms, 47000);
  assert.equal(note("Resistance").hidden, true);
  assert.equal(box("Resistance").hasAttribute("aria-invalid"), false);
  PopupManager.close();
});

test("typing narrows the list to the entries that hold what was typed", () => {
  const { doc, surface, controller } = desk();
  const r = controller.addComponentAt("resistor", "bb1", "a10");
  openProperties(surface, r.id);
  const input = box("Resistance");
  input.value = "4";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.deepEqual(entries("Resistance"), ["47Ω", "470Ω", "4.7kΩ", "47kΩ", "470kΩ"]); // prettier-ignore
  // Half a value is not flagged while typing.
  input.value = "4.";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(note("Resistance").hidden, true);
  assert.deepEqual(entries("Resistance"), ["4.7kΩ"]);
  // ↓ marks the first, Enter takes it.
  key("Resistance", "ArrowDown");
  key("Resistance", "Enter");
  assert.equal(doc.getComponent(r.id).params.ohms, 4700);
  // Nothing matching, no list.
  input.value = "zz";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(list("Resistance").hidden, true);
  PopupManager.close();
});

test("u filters as µ, and Escape shuts the list — only the list", () => {
  const { surface, controller } = desk();
  const c = controller.addComponentAt("cap-ceramic", "bb1", "a10");
  openProperties(surface, c.id);
  const input = box("Capacitance");
  input.value = "1u";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.deepEqual(entries("Capacitance"), ["1µF"]);
  const first = key("Capacitance", "Escape");
  assert.equal(first.defaultPrevented, true, "the dialog is not closed");
  assert.equal(list("Capacitance").hidden, true);
  const second = key("Capacitance", "Escape");
  assert.equal(second.defaultPrevented, false, "now Escape is the dialog's");
  PopupManager.close();
});

// ── Swapping the type ───────────────────────────────────────────────────────

test("a capacitor's Type swaps the part; its value stays, red when out of range", () => {
  const { doc, surface, controller } = desk();
  const c = controller.addComponentAt("cap-ceramic", "bb1", "a10", {
    farads: 1e-9,
  });
  openProperties(surface, c.id);
  assert.equal(box("Capacitance").value, "1nF");
  assert.deepEqual(entries("Capacitance"), []); // shut until asked
  row("Capacitance").querySelector(".properties-combo-toggle").click();
  assert.equal(entries("Capacitance")[0], "10pF", "the ceramic list");
  row("Type")
    .querySelector('.segmented-option[data-value="cap-electrolytic"]')
    .click();
  // The part is swapped where it sits, its value untouched…
  const swapped = doc.getComponent(c.id);
  assert.equal(swapped.ref, "cap-electrolytic");
  assert.equal(swapped.anchor, "a10");
  assert.equal(swapped.params.farads, 1e-9);
  assert.ok(
    surface.querySelector(`[data-component-id="${c.id}"] .part-cap-stripe`),
    "drawn as an electrolytic",
  );
  // …and the new part's card is open: its own list, its own range — which
  // 1 nF is outside, so it says so rather than changing it.
  assert.match(title().textContent, /electrolytic/i);
  assert.equal(box("Capacitance").value, "1nF");
  assert.equal(note("Capacitance").textContent, "Out of range: 100nF to 100mF");
  assert.equal(box("Capacitance").getAttribute("aria-invalid"), "true");
  row("Capacitance").querySelector(".properties-combo-toggle").click();
  assert.equal(entries("Capacitance")[0], "1µF", "the electrolytic list");
  PopupManager.close();
});

test("a transistor's Type swaps the part, and a part number of the old type goes", () => {
  const { doc, surface, controller } = desk();
  const q = controller.addComponentAt("npn", "bb1", "a10", {
    partNumber: "2N2222A",
  });
  openProperties(surface, q.id);
  assert.equal(box("Part number").value, "2N2222A");
  row("Part number").querySelector(".properties-combo-toggle").click();
  assert.deepEqual(entries("Part number"), ["2N2222A", "2N3904", "BC547", "TIP120", "TIP31C"]); // prettier-ignore
  const select = row("Type").querySelector("select");
  select.value = "nmos";
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(doc.getComponent(q.id).ref, "nmos");
  assert.ok(!("partNumber" in doc.getComponent(q.id).params), "an NPN's part");
  assert.equal(box("Part number").value, "");
  row("Part number").querySelector(".properties-combo-toggle").click();
  assert.deepEqual(entries("Part number"), ["2N7000", "BS170", "IRF540N", "IRLZ44N"]); // prettier-ignore
  assert.ok(row("Package"), "a MOSFET has");
  // A part number on no list is the user's, and goes with the part.
  type("Part number", "irf520");
  assert.equal(doc.getComponent(q.id).params.partNumber, "IRF520");
  const again = row("Type").querySelector("select");
  again.value = "pmos";
  again.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(doc.getComponent(q.id).ref, "pmos");
  assert.equal(doc.getComponent(q.id).params.partNumber, "IRF520");
  PopupManager.close();
});

test("another type's part number is taken, with a warning", () => {
  const { doc, surface, controller } = desk();
  const q = controller.addComponentAt("npn", "bb1", "a10");
  openProperties(surface, q.id);
  type("Part number", "2n3906");
  assert.equal(doc.getComponent(q.id).params.partNumber, "2N3906");
  assert.equal(box("Part number").value, "2N3906");
  assert.equal(note("Part number").textContent, "2N3906 is a PNP transistor");
  assert.equal(box("Part number").hasAttribute("aria-invalid"), false);
  // Said again when the card is next opened.
  openProperties(surface, q.id);
  assert.equal(note("Part number").textContent, "2N3906 is a PNP transistor");
  // Not a part number at all: refused.
  type("Part number", "2N 2222");
  assert.equal(doc.getComponent(q.id).params.partNumber, "2N3906");
  assert.match(note("Part number").textContent, /Not a part number/);
  PopupManager.close();
});

test("the Type is greyed while the circuit runs", () => {
  const { surface, controller } = desk();
  const q = controller.addComponentAt("npn", "bb1", "a10");
  controller.setEditingLocked(true);
  openProperties(surface, q.id);
  assert.ok(row("Type").classList.contains("properties-row--disabled"));
  PopupManager.close();
  controller.setEditingLocked(false);
});

// ── Zener ───────────────────────────────────────────────────────────────────

test("a Zener's list pairs each voltage with its part, and a pick sets both", () => {
  const { doc, surface, controller } = desk();
  const z = controller.addComponentAt("zener", "bb1", "a10");
  openProperties(surface, z.id);
  row("Zener voltage").querySelector(".properties-combo-toggle").click();
  const all = entries("Zener voltage");
  assert.equal(all.length, 21);
  assert.equal(all[0], "2.4V (BZX55C2V4)");
  pickEntry("Zener voltage", "5.1V (1N4733A)");
  assert.equal(doc.getComponent(z.id).params.zenerVolts, 5.1);
  assert.equal(doc.getComponent(z.id).params.partNumber, "1N4733A");
  assert.equal(box("Zener voltage").value, "5.1V");
  assert.equal(row("Part number").querySelector("input").value, "1N4733A");
  // A part number from the table, typed, is its entry.
  type("Zener voltage", "1n4742");
  assert.equal(doc.getComponent(z.id).params.zenerVolts, 12);
  assert.equal(doc.getComponent(z.id).params.partNumber, "1N4742A");
  // Searching by part number narrows the list too.
  const input = box("Zener voltage");
  input.value = "4744";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.deepEqual(entries("Zener voltage"), ["15V (1N4744A)"]);
  // A voltage no entry has stands alone, the table's part number dropped.
  type("Zener voltage", "11");
  assert.equal(doc.getComponent(z.id).params.zenerVolts, 11);
  assert.ok(!("partNumber" in doc.getComponent(z.id).params));
  assert.equal(row("Part number").querySelector("input").value, "");
  PopupManager.close();
});

// ── An older document ───────────────────────────────────────────────────────

test("an older document's values are read on load — or kept, and shown red", () => {
  const { doc, surface } = desk({
    version: 11,
    boards: [{ id: "bb1", type: "pins-full", x: 0, y: 0 }],
    components: [
      {
        id: "c1",
        kind: "discrete",
        ref: "resistor",
        board: "bb1",
        anchor: "a10",
        params: { ohms: "4k7" },
      },
      {
        id: "c2",
        kind: "discrete",
        ref: "resistor",
        board: "bb1",
        anchor: "a20",
        params: { ohms: "lots" },
      },
      {
        id: "c3",
        kind: "discrete",
        ref: "cap-ceramic",
        board: "bb1",
        anchor: "a30",
        params: { farads: 470e-6 },
      },
    ],
  });
  assert.equal(doc.getComponent("c1").params.ohms, 4700, "read");
  assert.equal(doc.getComponent("c2").params.ohms, "lots", "kept, not lost");
  assert.equal(doc.getComponent("c3").params.farads, 470e-6, "kept");
  openProperties(surface, "c1");
  assert.equal(box("Resistance").value, "4.7kΩ");
  assert.equal(note("Resistance").hidden, true);
  openProperties(surface, "c2");
  assert.equal(box("Resistance").value, "lots");
  assert.equal(note("Resistance").textContent, "Not a resistance value");
  assert.equal(box("Resistance").getAttribute("aria-invalid"), "true");
  openProperties(surface, "c3");
  assert.equal(box("Capacitance").value, "470µF");
  assert.equal(note("Capacitance").textContent, "Out of range: 1pF to 100µF");
  // A good value typed in clears it.
  type("Capacitance", "47n");
  assert.equal(doc.getComponent("c3").params.farads, 47e-9);
  assert.equal(note("Capacitance").hidden, true);
  PopupManager.close();
});

// ── The nearest-value hint ──────────────────────────────────────────────────

const hintButton = (label) => row(label).querySelector(".properties-hint-btn");
const hintCard = (label) => row(label).querySelector(".properties-hint");
const hintValues = (label) =>
  [...hintCard(label).querySelectorAll(".properties-hint-value")].map(
    (b) => b.textContent,
  );

test("a value between two standard ones shows an amber (i) offering both", () => {
  const { doc, surface, controller } = desk();
  const r = controller.addComponentAt("resistor", "bb1", "a10");
  openProperties(surface, r.id);
  assert.equal(hintButton("Resistance").hidden, true, "10k is standard");
  type("Resistance", "3k");
  assert.equal(doc.getComponent(r.id).params.ohms, 3000, "taken as typed");
  assert.equal(box("Resistance").value, "3kΩ", "never snapped");
  const btn = hintButton("Resistance");
  assert.equal(btn.hidden, false);
  assert.ok(btn.classList.contains("info-btn--advisory"), "amber, not red");
  assert.equal(hintCard("Resistance").hidden, true, "closed until clicked");
  btn.click();
  assert.equal(hintCard("Resistance").hidden, false);
  assert.deepEqual(hintValues("Resistance"), ["2.7kΩ", "3.3kΩ"]);
  // A link takes that value: set, shut, and the (i) gone with the reason.
  [...hintCard("Resistance").querySelectorAll(".properties-hint-value")]
    .find((b) => b.textContent === "3.3kΩ")
    .click();
  assert.equal(doc.getComponent(r.id).params.ohms, 3300);
  assert.equal(box("Resistance").value, "3.3kΩ");
  assert.equal(hintCard("Resistance").hidden, true);
  assert.equal(hintButton("Resistance").hidden, true);
  PopupManager.close();
});

test("the hint opens on a stored value, measures E12 past the list, and shuts on Escape or a click outside", () => {
  const { surface, controller } = desk();
  const r = controller.addComponentAt("resistor", "bb1", "a10");
  openProperties(surface, r.id);
  type("Resistance", "2.5M");
  hintButton("Resistance").click();
  assert.deepEqual(hintValues("Resistance"), ["2.2MΩ", "2.7MΩ"], "E12, not the list's 1MΩ end"); // prettier-ignore
  // Escape shuts the card — and only the card.
  document.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }), // prettier-ignore
  );
  assert.equal(hintCard("Resistance").hidden, true);
  assert.ok(document.querySelector(".properties-popup"), "the card is still open"); // prettier-ignore
  hintButton("Resistance").click();
  assert.equal(hintCard("Resistance").hidden, false);
  document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true })); // prettier-ignore
  assert.equal(hintCard("Resistance").hidden, true);
  PopupManager.close();
  // Reopened, the card knows: the stored 2.5M still has its (i).
  openProperties(surface, r.id);
  assert.equal(hintButton("Resistance").hidden, false);
  PopupManager.close();
});

test("no hint while the box is red, and a capacitor's is E12 across its range", () => {
  const { surface, controller } = desk();
  const r = controller.addComponentAt("resistor", "bb1", "a10");
  openProperties(surface, r.id);
  type("Resistance", "3k");
  assert.equal(hintButton("Resistance").hidden, false);
  type("Resistance", "banana");
  assert.equal(box("Resistance").getAttribute("aria-invalid"), "true");
  assert.equal(hintButton("Resistance").hidden, true, "fix it first");
  PopupManager.close();
  const c = controller.addComponentAt("cap-ceramic", "bb1", "a20");
  openProperties(surface, c.id);
  type("Capacitance", "4.7n");
  assert.equal(hintButton("Capacitance").hidden, true, "4.7n is E12");
  type("Capacitance", "5n");
  hintButton("Capacitance").click();
  assert.deepEqual(hintValues("Capacitance"), ["4.7nF", "5.6nF"]);
  PopupManager.close();
});

test("a Zener's hint brings the neighbour's part number; an inductor's uses its list", () => {
  const { doc, surface, controller } = desk();
  const z = controller.addComponentAt("zener", "bb1", "a10");
  openProperties(surface, z.id);
  type("Zener voltage", "5V");
  assert.equal(doc.getComponent(z.id).params.zenerVolts, 5);
  hintButton("Zener voltage").click();
  assert.deepEqual(hintValues("Zener voltage"), ["4.7V", "5.1V"]);
  [...hintCard("Zener voltage").querySelectorAll(".properties-hint-value")]
    .find((b) => b.textContent === "5.1V")
    .click();
  assert.equal(doc.getComponent(z.id).params.zenerVolts, 5.1);
  assert.equal(doc.getComponent(z.id).params.partNumber, "1N4733A");
  assert.equal(row("Part number").querySelector("input").value, "1N4733A");
  PopupManager.close();
  const l = controller.addComponentAt("inductor", "bb1", "a30");
  openProperties(surface, l.id);
  type("Inductance", "4.70 µH");
  assert.equal(hintButton("Inductance").hidden, true, "a list value");
  type("Inductance", "2mH");
  hintButton("Inductance").click();
  assert.deepEqual(hintValues("Inductance"), ["1.5mH", "2.2mH"]);
  type("Inductance", "500m");
  hintButton("Inductance").click();
  assert.deepEqual(hintValues("Inductance"), ["100mH"], "past the end: the end alone"); // prettier-ignore
  PopupManager.close();
});
