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

// The multimeter's desk review, 2026-10-28: its display's own state (REC,
// HOLD, Relative Zero, Hz, RANGE, the backlight) is the meter's, not its
// view's — a remount (an undo or redo, a Properties change) keeps it, a
// different document starts afresh; a language change relabels it in
// place; and a meter taken out in a zoomed-in view never lands over the
// circuit.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
import { worldOfAddress } from "../model/occupancy.js";
import { applyCatalog, currentCatalog } from "../i18n.js";

const { DeskController } = await import("../components/desk-controller.js");
const { gripOf } = await import("../components/meter-probe-layer.js");
const { jackOf, jackWorld, meterSpot } =
  await import("../model/meter-probes.js");
const { PopupManager } = await import("../popup-manager.js");

function makeDesk(deskDoc, world) {
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const deskView = {
    surface,
    camera: { cx: 0, cy: 0, zoom: 1 },
    worldFromEvent: () => ({ x: world.x, y: world.y }),
  };
  const controller = new DeskController({ viewport, deskView, deskDoc });
  return { viewport, surface, controller };
}

function fire(el, type, client = [0, 0]) {
  el.dispatchEvent(
    new window.PointerEvent(type, { bubbles: true, button: 0, pointerId: 3, clientX: client[0], clientY: client[1] }), // prettier-ignore
  );
}

/** A desk under Spice Lite: a full kit, a chip on it, a meter beside it. */
function desk() {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const view = makeDesk(doc, world);
  view.controller.addKitAt("full", 0, 0);
  view.controller.addComponentAt("74LS00", "bb2", "e5");
  const meter = view.controller.addBrickAt("meter", 80, 0, {});
  view.controller.setSpiceLite({ enabled: true });
  return { doc, world, ...view, id: meter.id };
}

const panel = ({ surface, id }, sel) =>
  surface.querySelector(`[data-component-id="${id}"] ${sel}`);
const lit = (d, flag) =>
  panel(d, `.part-meter-flag--${flag}`).classList.contains("part-meter-flag--lit"); // prettier-ignore
const backlit = (d) =>
  d.surface.querySelector(`[data-component-id="${d.id}"]`).classList.contains("part-meter--backlit"); // prettier-ignore

/** Press one of the meter's buttons, let go `heldMs` later. */
function press(d, button, heldMs = 0) {
  const el = panel(d, `[data-meter-button="${button}"] .part-meter-btn-cap`);
  const real = performance.now;
  let now = real.call(performance);
  performance.now = () => now;
  try {
    fire(el, "pointerdown");
    now += heldMs;
    fire(el, "pointerup");
  } finally {
    performance.now = real;
  }
}

/** Drag a probe so its tip lands at `tip`. */
function dragProbe(d, which, tip) {
  const probe = d.surface.querySelector(`.meter-probe--${which} .meter-probe-body`); // prettier-ignore
  d.world.x = 0;
  d.world.y = 0;
  fire(probe, "pointerdown");
  const meter = d.doc.getComponent(d.id);
  const at = gripOf(tip, jackWorld(meter, jackOf(meter.params, which)));
  d.world.x = at.x;
  d.world.y = at.y;
  fire(probe, "pointermove", [40, 40]);
  fire(probe, "pointerup", [40, 40]);
}

/** Open the meter's Properties and click one segmented option. */
function setProperty(d, label, option) {
  PopupManager.close();
  d.surface.querySelector(`[data-component-id="${d.id}"]`).dispatchEvent(
    new window.MouseEvent("contextmenu", { bubbles: true, clientX: 9, clientY: 9 }), // prettier-ignore
  );
  [...document.querySelectorAll(".popup-menu-item")]
    .find((b) => b.textContent.trim() === "Properties…")
    .click();
  const row = [...document.querySelectorAll(".properties-row")].find(
    (r) => r.querySelector(".properties-label")?.textContent === label,
  );
  [...row.querySelectorAll(".segmented-option")]
    .find((b) => b.textContent === option)
    .click();
  PopupManager.close();
}

test("an undo or redo of a probe move keeps REC, HOLD and the backlight — the view is remounted, the display is the meter's", () => {
  const d = desk();
  press(d, "rec");
  press(d, "rec"); // showing MAX
  press(d, "select", 1200); // the backlight
  assert.ok(lit(d, "max") && !lit(d, "min") && backlit(d));
  dragProbe(d, "red", worldOfAddress(d.doc.boards, "bb2.a20"));
  assert.equal(d.doc.getComponent(d.id).params.red.at, "bb2.a20");
  d.controller.undo();
  assert.equal(d.doc.getComponent(d.id).params.red.at, undefined);
  assert.ok(lit(d, "max") && !lit(d, "min"), "REC, on its MAX, after ⌘Z");
  assert.ok(backlit(d), "still lit after ⌘Z");
  d.controller.redo();
  assert.ok(lit(d, "max") && !lit(d, "min"), "…and after ⇧⌘Z");
  press(d, "hold");
  assert.ok(lit(d, "hold"));
  // An undo that changes a BOARD remounts every part view.
  d.controller.addKitAt("half", 0, 40);
  d.controller.undo();
  assert.ok(lit(d, "hold") && lit(d, "max"), "after a board's undo");
  press(d, "select", 1200); // out again (no 10-minute timer left behind)
  assert.ok(!backlit(d));
});

test("Properties ▸ Sound or Look keeps the display's state; an undone dial turn clears it, as a turn does", () => {
  const d = desk();
  press(d, "hold", 1200); // Relative Zero
  press(d, "rec");
  assert.ok(lit(d, "rel") && lit(d, "max"));
  setProperty(d, "Sound", "On");
  assert.equal(d.doc.getComponent(d.id).params.sound, "on");
  assert.ok(lit(d, "rel") && lit(d, "max"), "after Sound ▸ On");
  setProperty(d, "Look", "EEVBlog");
  assert.equal(d.doc.getComponent(d.id).params.skin, "bm235");
  assert.ok(lit(d, "rel") && lit(d, "max"), "after Look ▸ EEVBlog");
  // The dial turned to mV clears them; ⌘Z back to V is another turn.
  fire(panel(d, '[data-meter-position="mv"] circle'), "pointerdown");
  assert.ok(!lit(d, "max"));
  press(d, "rec");
  d.controller.undo();
  assert.equal(d.doc.getComponent(d.id).params.dial, "v");
  assert.ok(!lit(d, "max") && !lit(d, "rel"), "the mV position's REC is not V's"); // prettier-ignore
});

test("another document on the desk starts every meter's display afresh", () => {
  const d = desk();
  press(d, "rec");
  assert.ok(lit(d, "max"));
  // A tab switch to a desktop with a meter of the same id.
  d.controller.loadDocument(d.doc.toJSON());
  assert.ok(panel(d, "svg"), "the meter is drawn");
  assert.ok(!lit(d, "max"), "REC belongs to the desk it was pressed on");
});

test("a language change relabels the meter's (i) in place", () => {
  const was = currentCatalog();
  const read = (lang) =>
    JSON.parse(readFileSync(new URL(`../../locales/${lang}.json`, import.meta.url), "utf8")); // prettier-ignore
  const en = read("en");
  const de = read("de");
  try {
    applyCatalog({ active: "en", messages: en, fallback: en });
    const d = desk();
    d.controller.setSpiceLite({ enabled: false });
    const note = () => panel(d, ".part-meter-mark > title").textContent;
    assert.equal(note(), en.desk.meter.needsSpice);
    applyCatalog({ active: "de", messages: de, fallback: en });
    window.dispatchEvent(new window.CustomEvent("chiphippo:locale-changed"));
    assert.equal(note(), de.desk.meter.needsSpice);
  } finally {
    applyCatalog(was);
  }
});

test("a meter taken out in a view too narrow for one goes right of the last, never back over the circuit", () => {
  const narrow = { x: 0, y: 0, width: 20, height: 20 };
  const first = meterSpot(narrow, 63);
  assert.deepEqual(first, { x: 67, y: 2 });
  const taken = [{ ...first, width: 32, height: 63 }];
  const second = meterSpot(narrow, 63, taken);
  assert.ok(second.x >= first.x + 32, `${second.x} right of the first`);
  const third = meterSpot(narrow, 63, [...taken, { ...second, width: 32, height: 63 }]); // prettier-ignore
  assert.ok(third.x >= second.x + 32, `${third.x} right of the second`);
  // A view with room still steps left from its right edge, as before.
  const wide = { x: 0, y: 0, width: 200, height: 80 };
  const a = meterSpot(wide, 63);
  const b = meterSpot(wide, 63, [{ ...a, width: 32, height: 63 }]);
  assert.equal(a.x, 156);
  assert.equal(b.x, 156 - 44);
});

test("a meter button whose release never comes (the window lost focus) is no press — the next click is not a long one", () => {
  const d = desk();
  const cap = panel(d, `[data-meter-button="select"] .part-meter-btn-cap`);
  const real = performance.now;
  let now = real.call(performance);
  performance.now = () => now;
  try {
    fire(cap, "pointerdown");
    window.dispatchEvent(new window.Event("blur"));
    now += 5000; // long after BUTTON_HOLD_MS
    fire(d.viewport, "pointerup"); // an unrelated click anywhere
  } finally {
    performance.now = real;
  }
  assert.equal(backlit(d), false, "no long press, no backlight");
});

test("a probe dropped over a hole under a 600-mil chip's body is refused: a red ring, and it goes back", () => {
  const d = desk();
  // A 600-mil chip seated wide (rows d/h), its body over rows e–g.
  d.controller.addComponentAt("AT28C256", "bb2", "d30");
  const before = structuredClone(d.doc.getComponent(d.id).params.red);
  const probe = d.surface.querySelector(`.meter-probe--red .meter-probe-body`);
  d.world.x = 0;
  d.world.y = 0;
  fire(probe, "pointerdown");
  const meter = d.doc.getComponent(d.id);
  const tip = worldOfAddress(d.doc.boards, "bb2.f32");
  assert.ok(
    d.doc.coveredAddresses().has("bb2.f32"),
    "the hole is under the body",
  );
  const at = gripOf(tip, jackWorld(meter, jackOf(meter.params, "red")));
  d.world.x = at.x;
  d.world.y = at.y;
  fire(probe, "pointermove", [40, 40]);
  const ring = d.viewport.querySelector(".hole-ring");
  assert.ok(ring && !ring.hidden && ring.classList.contains("hole-ring--illegal"), "a red ring"); // prettier-ignore
  fire(probe, "pointerup", [40, 40]);
  assert.deepEqual(d.doc.getComponent(d.id).params.red, before, "not moved");
});

test("a doc-changed mid probe-drag (a fuse blowing) keeps the probe where the drag has it", () => {
  const d = desk();
  const body = () => d.surface.querySelector(`.meter-probe--red .meter-probe-body`); // prettier-ignore
  d.world.x = 0;
  d.world.y = 0;
  fire(body(), "pointerdown");
  const meter = d.doc.getComponent(d.id);
  const at = gripOf(worldOfAddress(d.doc.boards, "bb2.a20"), jackWorld(meter, jackOf(meter.params, "red"))); // prettier-ignore
  d.world.x = at.x;
  d.world.y = at.y;
  fire(body(), "pointermove", [40, 40]);
  const shown = body().getAttribute("points");
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed", { detail: {} })); // prettier-ignore
  assert.equal(
    body().getAttribute("points"),
    shown,
    "still at the drag's place",
  );
  assert.ok(body().closest(".meter-probe").classList.contains("meter-probe--dragging")); // prettier-ignore
  fire(body(), "pointerup", [40, 40]);
  assert.equal(d.doc.getComponent(d.id).params.red.at, "bb2.a20");
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed", { detail: {} })); // prettier-ignore
  assert.ok(!body().closest(".meter-probe").classList.contains("meter-probe--dragging"), "no preview kept after the drop"); // prettier-ignore
});
