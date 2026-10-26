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

// The multimeter on the desk (components/meter-view.js, meter-probe-layer.js,
// DeskController's meter gestures): its front panel worked by a press, its
// probes dragged onto any hole — a taken one too — or laid loose, and both
// allowed while the circuit runs. Real PointerEvents on the mounted views,
// the cursor's world point read off a live object (desk-gestures.test.js).

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
import { worldOfAddress } from "../model/occupancy.js";

const { DeskController } = await import("../components/desk-controller.js");
const MeterLayer = await import("../components/meter-probe-layer.js");
const { gripOf } = MeterLayer;
const { jackOf, jackWorld } = await import("../model/meter-probes.js");

/** Put the pointer where a probe is HELD for its tip to be at `tip` (the
    top of its body: meter-probe-layer.js `gripOf`). */
function holdAt(world, doc, meterId, which, tip) {
  const meter = doc.getComponent(meterId);
  const at = gripOf(tip, jackWorld(meter, jackOf(meter.params, which)));
  world.x = at.x;
  world.y = at.y;
}

function makeDesk(deskDoc, world = { x: 0, y: 0 }) {
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
  return { viewport, surface, controller, world };
}

function fire(el, type, { client = [0, 0], mods = {} } = {}) {
  el.dispatchEvent(
    new window.PointerEvent(type, { bubbles: true, button: 0, pointerId: 3, clientX: client[0], clientY: client[1], ...mods }), // prettier-ignore
  );
}

/** A desk: a full kit, a resistor seated on it, a meter beside it. */
function desk() {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const view = makeDesk(doc, world);
  view.controller.addKitAt("full", 0, 0);
  view.controller.addComponentAt("74LS00", "bb2", "e5");
  const meter = view.controller.addBrickAt("meter", 80, 0, {});
  return { doc, ...view, meterId: meter.id };
}

const panel = (surface, meterId, selector) =>
  surface.querySelector(`[data-component-id="${meterId}"] ${selector}`);

/** Press a meter button and let it go `heldMs` later (the clock stubbed). */
function press(el, heldMs = 0) {
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

test("the dial, SELECT and the jacks are worked by a press — an edit each, no drag", () => {
  const { doc, surface, meterId } = desk();
  assert.ok(panel(surface, meterId, "svg"), "the meter is drawn");
  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  fire(panel(surface, meterId, '[data-meter-position="ohm"] circle'), "pointerdown"); // prettier-ignore
  assert.equal(doc.getComponent(meterId).params.dial, "ohm");
  // …and the meter on the desk turns with it.
  assert.ok(panel(surface, meterId, '[data-meter-position="ohm"]').classList.contains("part-meter-stop--on")); // prettier-ignore
  // A button acts on its release.
  press(panel(surface, meterId, '[data-meter-button="select"] rect'));
  assert.equal(doc.getComponent(meterId).params.sel.ohm, "cont");
  fire(panel(surface, meterId, '[data-meter-jack="ma"] circle'), "pointerdown"); // prettier-ignore
  assert.equal(doc.getComponent(meterId).params.jack, "ma");
  assert.equal(changes, 3);
  // The meter did not move.
  assert.equal(doc.getComponent(meterId).x, 80);
});

test("a probe drops onto a hole a lead is already in, and lies loose clear of every hole", () => {
  const { doc, surface, world, meterId } = desk();
  const probe = () => surface.querySelector(".meter-probe--red .meter-probe-body"); // prettier-ignore
  assert.ok(probe(), "the red probe is drawn");
  // Onto the chip's own pin 1 hole.
  const target = "bb2.e5";
  const at = worldOfAddress(doc.boards, target);
  world.x = 0;
  world.y = 0;
  fire(probe(), "pointerdown");
  holdAt(world, doc, meterId, "red", { x: at.x + 0.2, y: at.y });
  fire(probe(), "pointermove", { client: [40, 40] });
  fire(probe(), "pointerup", { client: [40, 40] });
  assert.equal(doc.getComponent(meterId).params.red.at, target);
  // Clear of every hole: it lies where it was let go.
  fire(probe(), "pointerdown");
  holdAt(world, doc, meterId, "red", { x: 60, y: 40 });
  fire(probe(), "pointermove", { client: [80, 80] });
  fire(probe(), "pointerup", { client: [80, 80] });
  assert.deepEqual(doc.getComponent(meterId).params.red, { dx: -20, dy: 40 });
});

test("a dragged probe is held by the top of its body: its tip — and the ring — down the probe from the pointer", () => {
  const { doc, surface, world, meterId } = desk();
  const { tipFromGrip } = MeterLayer;
  const probe = () => surface.querySelector(".meter-probe--red .meter-probe-body"); // prettier-ignore
  const target = worldOfAddress(doc.boards, "bb2.a20");
  fire(probe(), "pointerdown");
  // The pointer right ON the hole: the tip is not there, but a grip's length
  // down the probe — so it lands nowhere near it.
  world.x = target.x;
  world.y = target.y;
  fire(probe(), "pointermove", { client: [40, 40] });
  const ring = surface.ownerDocument.querySelector(".hole-ring");
  const meter = doc.getComponent(meterId);
  const tip = tipFromGrip(
    target,
    jackWorld(meter, jackOf(meter.params, "red")),
  );
  assert.ok(Math.hypot(tip.x - target.x, tip.y - target.y) > 2.5, "the tip is clear of the hand"); // prettier-ignore
  fire(probe(), "pointerup", { client: [40, 40] });
  assert.notEqual(doc.getComponent(meterId).params.red.at, "bb2.a20");
  // Held at the grip for that hole, it lands on it, ringed.
  fire(probe(), "pointerdown");
  holdAt(world, doc, meterId, "red", target);
  fire(probe(), "pointermove", { client: [80, 80] });
  assert.ok(ring && !ring.hidden, "the ring is up");
  fire(probe(), "pointerup", { client: [80, 80] });
  assert.equal(doc.getComponent(meterId).params.red.at, "bb2.a20");
  // gripOf and tipFromGrip are each other's inverse.
  const jack = { x: 100, y: 30 };
  const back = tipFromGrip(gripOf({ x: 12, y: 7 }, jack), jack);
  assert.ok(Math.hypot(back.x - 12, back.y - 7) < 1e-9);
});

test("while the circuit runs the meter is still worked: its dial, and its probes", () => {
  const { doc, surface, world, controller, meterId } = desk();
  controller.setEditingLocked(true);
  fire(panel(surface, meterId, '[data-meter-position="mv"] circle'), "pointerdown"); // prettier-ignore
  assert.equal(doc.getComponent(meterId).params.dial, "mv");
  const probe = surface.querySelector(".meter-probe--black .meter-probe-body");
  const at = worldOfAddress(doc.boards, "bb2.a5");
  fire(probe, "pointerdown");
  holdAt(world, doc, meterId, "black", at);
  fire(probe, "pointermove", { client: [40, 40] });
  fire(probe, "pointerup", { client: [40, 40] });
  assert.equal(doc.getComponent(meterId).params.black.at, "bb2.a5");
  // …and the meter itself is moved about the running bench (an instrument,
  // not the circuit — every part of which stays frozen).
  const body = panel(surface, meterId, ".part-meter-face");
  fire(body, "pointerdown");
  world.x += 30;
  fire(body, "pointermove", { client: [90, 90] });
  fire(body, "pointerup", { client: [90, 90] });
  assert.equal(doc.getComponent(meterId).x, 110);
});

test("the meter floats over the boards, is never selected, and is in the way of what is under it", () => {
  const { doc, surface, world, controller, meterId } = desk();
  const meter = surface.querySelector(`[data-component-id="${meterId}"]`);
  assert.ok(meter.closest(".layer-meters"), "drawn over the whole circuit");
  // Dragged onto the kit: it lands there, over the board.
  const body = panel(surface, meterId, ".part-meter-face");
  world.x = 0;
  world.y = 0;
  fire(body, "pointerdown");
  world.x = -75;
  world.y = 2;
  fire(body, "pointermove", { client: [90, 90] });
  fire(body, "pointerup", { client: [90, 90] });
  assert.deepEqual([doc.getComponent(meterId).x, doc.getComponent(meterId).y], [5, 2]); // prettier-ignore
  // Not selected by a press, a ⌘-click or Select All.
  assert.notEqual(controller.selectedId, meterId);
  fire(body, "pointerdown", { mods: { metaKey: true, ctrlKey: true } });
  fire(body, "pointerup");
  controller.selectAll();
  assert.ok(!meter.classList.contains("part--selected"));
  // A PSU put down under it is no overlap (below the kit, under the meter).
  assert.ok(doc.canPlaceBrick("psu", 10, 30));
  // The wire tool's click on the meter reaches no hole under it.
  const wires = doc.wires.length;
  controller.toggleWireTool();
  fire(body, "pointerdown");
  fire(body, "pointerup");
  assert.equal(doc.wires.length, wires);
});

test("the display's own buttons: REC, Relative Zero, Hz and the backlight change no document", () => {
  const { doc, surface, meterId, controller } = desk();
  controller.setSpiceLite({ enabled: true });
  const meter = surface.querySelector(`[data-component-id="${meterId}"]`);
  const lit = (flag) => panel(surface, meterId, `.part-meter-flag--${flag}`).classList.contains("part-meter-flag--lit"); // prettier-ignore
  const button = (id) => panel(surface, meterId, `[data-meter-button="${id}"] .part-meter-btn-cap`); // prettier-ignore
  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  // REC: every flag lit over the reading; a press shows MAX alone; held a
  // second, out of it.
  press(button("rec"));
  assert.ok(lit("max") && lit("min") && lit("avg"));
  press(button("rec"));
  assert.ok(lit("max") && !lit("min") && !lit("avg"));
  press(button("rec"), 1200);
  assert.ok(!lit("max") && !lit("min"));
  // HOLD held a second: Relative Zero, its Δ lit; a short press is HOLD.
  press(button("hold"), 1200);
  assert.ok(lit("rel") && !lit("hold"));
  press(button("hold"));
  assert.ok(lit("hold"));
  press(button("hold"));
  press(button("hold"), 1200);
  assert.ok(!lit("rel"));
  // Hz: the unit says so; again, back to volts.
  press(button("hz"));
  assert.match(panel(surface, meterId, ".part-meter-unit").textContent, /Hz$/);
  press(button("hz"));
  assert.equal(panel(surface, meterId, ".part-meter-unit").textContent, "V");
  // SELECT held a second: the backlight, not the next function.
  press(button("select"), 1200);
  assert.ok(meter.classList.contains("part-meter--backlit"));
  assert.equal(doc.getComponent(meterId).params.sel, undefined);
  press(button("select"), 1200);
  assert.ok(!meter.classList.contains("part-meter--backlit"));
  assert.equal(changes, 0);
});

test("the toolbar's Add takes out meters, side by side, up to three — each put away from its own menu", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { controller } = makeDesk(doc);
  controller.addKitAt("full", 0, 0);
  assert.equal(controller.meterCount, 0);
  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  const ids = [controller.addMeter(), controller.addMeter(), controller.addMeter()]; // prettier-ignore
  assert.ok(ids.every(Boolean));
  assert.equal(controller.addMeter(), null, "a fourth is refused");
  assert.equal(controller.meterCount, 3);
  const meters = ids.map((id) => doc.getComponent(id));
  assert.ok(meters.every((m) => m.params.size === undefined), "at full size"); // prettier-ignore
  assert.ok(meters.every((m) => m.params.skin === undefined), "Volt Hippos"); // prettier-ignore
  // None on another (each with its probes' room beside it).
  const xs = meters.map((m) => m.x).sort((a, b) => a - b);
  assert.ok(xs[1] - xs[0] >= 44 && xs[2] - xs[1] >= 44, String(xs));
  controller.putMeterAway(ids[1]);
  assert.equal(controller.meterCount, 2);
  assert.equal(doc.getComponent(ids[1]), null);
  assert.equal(changes, 4);
  controller.undo();
  assert.equal(controller.meterCount, 3, "⌘Z takes it out again");
});

test("both looks carry every hook the controller and display read — the Volt Hippo by default, its name in two shades", async () => {
  const { buildMeterSvg } = await import("../components/meter-view.js");
  const { jackWorld } = await import("../model/meter-probes.js");
  const { partDef } = await import("../catalog/index.js");
  resetDom();
  const def = partDef("meter");
  assert.equal(def.normalizeParams({ skin: "bm235" }).skin, "bm235");
  assert.equal(def.normalizeParams({ skin: "classic" }).skin, undefined);
  const look = def.properties.find((f) => f.key === "skin");
  assert.deepEqual(look.options.map((o) => [o.value, o.label]), [["volthippo", "VoltHippo"], ["bm235", "EEVBlog"]]); // prettier-ignore
  assert.equal(look.default, "volthippo");
  const params = def.normalizeParams({ dial: "mv" });
  assert.equal(params.skin, undefined, "the Volt Hippo, unstored");
  assert.equal(params.size, undefined, "full size, unstored");
  const eev = buildMeterSvg({ ...params, skin: "bm235" });
  const svg = buildMeterSvg(params);
  for (const body of [svg, eev]) {
    // Every press the controller reads, and every place the display writes.
    for (const position of [
      "autov",
      "off",
      "v",
      "ohm",
      "mv",
      "diode",
      "ma",
      "ua",
    ]) {
      // prettier-ignore
      assert.ok(body.querySelector(`[data-meter-position="${position}"]`), position); // prettier-ignore
    }
    for (const button of ["select", "range", "rec", "hold", "hz"]) {
      assert.ok(body.querySelector(`[data-meter-button="${button}"]`), button); // prettier-ignore
    }
    for (const jack of ["a", "ma", "v"]) {
      assert.ok(body.querySelector(`[data-meter-jack="${jack}"]`), jack);
    }
    for (const cls of [
      "digits",
      "unit",
      "flag--auto",
      "flag--max",
      "flag--rel",
      "sign",
      "mark",
    ]) {
      // prettier-ignore
      assert.ok(body.querySelector(`.part-meter-${cls}`), cls);
    }
    assert.ok(body.querySelector('[data-meter-position="mv"]').classList.contains("part-meter-stop--on")); // prettier-ignore
    assert.ok(body.querySelector(".part-meter-bm-band[data-meter-title]"), "the title"); // prettier-ignore
  }
  // The Volt Hippo's name in two shades, "Volt" silver and "Hippo" white,
  // and no brand but its own; its logo is the title too.
  const volt = svg.querySelector(".part-meter-bm-volt");
  const hippo = svg.querySelector(".part-meter-bm-hippo");
  assert.equal(volt.textContent, "Volt");
  assert.equal(hippo.textContent, "Hippo");
  assert.equal(volt.getAttribute("x"), hippo.getAttribute("x"));
  assert.equal([volt.getAttribute("text-anchor"), hippo.getAttribute("text-anchor")].join(), "end,start"); // prettier-ignore
  assert.ok(!svg.textContent.includes("BRYMEN"));
  assert.ok(svg.querySelector(".part-meter-bm-logo[data-meter-title]"));
  // The EEVBlog look's band is the BM235's; the boot round the face is the
  // same in both.
  assert.match(eev.textContent, /BRYMEN.*EEV.*Blog.*BM235/);
  const faceOf = (body) => body.querySelector(".part-meter-face").getAttribute("d"); // prettier-ignore
  assert.equal(faceOf(eev), faceOf(svg));
  // Its 10A jack is high on the left, in either look.
  assert.deepEqual(jackWorld({ x: 0, y: 0, params }, "a"), { x: 7.85, y: 44.45 }); // prettier-ignore
});

test("folded down it is its screen and jacks — Properties ▸ Size, with the hint", async () => {
  const { buildMeterSvg } = await import("../components/meter-view.js");
  const { jackWorld } = await import("../model/meter-probes.js");
  const { partDef } = await import("../catalog/index.js");
  const { isCompact } = await import("../catalog/meter.js");
  resetDom();
  const def = partDef("meter");
  const params = def.normalizeParams({ size: "compact" });
  assert.equal(params.size, "compact");
  assert.ok(isCompact(params));
  assert.ok(isCompact({ skin: "bm235", size: "compact" }), "either look");
  assert.equal(def.normalizeParams({ size: "full" }).size, undefined);
  assert.equal(def.normalizeParams({ compact: true }).size, undefined);
  const field = def.properties.find((f) => f.key === "size");
  assert.deepEqual(field.options.map((o) => o.value), ["full", "compact"]); // prettier-ignore
  assert.equal(field.default, "full");
  assert.match(field.note, /^Click the title/);
  const svg = buildMeterSvg(params);
  assert.equal(svg.getAttribute("viewBox"), "3 2 26 22.3");
  assert.ok(svg.querySelector(".part-meter-bm-band[data-meter-title]"));
  assert.ok(svg.querySelector(".part-meter-digits"));
  assert.equal(svg.querySelector("[data-meter-position]"), null, "no dial");
  // No dial, so no re-plugging: only the jacks in use, neither a press.
  assert.equal(svg.querySelector("[data-meter-jack]"), null);
  assert.equal(svg.querySelectorAll(".part-meter-jack").length, 2);
  assert.ok(svg.querySelector(".part-meter-jack--com"));
  assert.deepEqual(jackWorld({ x: 0, y: 0, params }, "com"), { x: 15.65, y: 17.6 }); // prettier-ignore
  // The red lead's jack keeps its own place: in µA mA, the second of four.
  const ring = buildMeterSvg({ ...params, jack: "ma" }).querySelector(".part-meter-jack--red .part-meter-jack-ring"); // prettier-ignore
  assert.equal(Number(ring.getAttribute("cx")), 3 + 10.35);
  assert.match(buildMeterSvg({ ...params, skin: "bm235" }).textContent, /BRYMEN/); // prettier-ignore
});

test("a click on the title folds the meter, the screen left where it was — and opens it out again; a drag from it moves it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { surface, controller, world } = makeDesk(doc, { x: 0, y: 0 });
  const meter = controller.addBrickAt("meter", 80, 10, {});
  const title = () => panel(surface, meter.id, ".part-meter-bm-band");
  const red = doc.getComponent(meter.id).params.red;
  press(title());
  let now = doc.getComponent(meter.id);
  assert.equal(now.params.size, "compact");
  assert.deepEqual([now.x, now.y], [83, 12], "moved by the fold's origin");
  assert.deepEqual(now.params.red, { dx: red.dx - 3, dy: red.dy - 2 }, "a loose probe stays put"); // prettier-ignore
  assert.equal(panel(surface, meter.id, "svg").getAttribute("viewBox"), "3 2 26 22.3"); // prettier-ignore
  press(title());
  now = doc.getComponent(meter.id);
  assert.equal(now.params.size, undefined);
  assert.deepEqual([now.x, now.y, now.params.red], [80, 10, red]);
  // A press on the title that TRAVELS is a drag: the meter moves, unfolded.
  fire(title(), "pointerdown");
  world.x = 10;
  fire(title(), "pointermove", { client: [40, 0] });
  fire(title(), "pointerup", { client: [40, 0] });
  world.x = 0;
  now = doc.getComponent(meter.id);
  assert.equal(now.params.size, undefined, "not folded");
  assert.equal(now.x, 90, "moved");
  // The Volt Hippo's logo is its title too; the EEVBlog look's band folds it.
  press(panel(surface, meter.id, ".part-meter-bm-logo"));
  assert.equal(doc.getComponent(meter.id).params.size, "compact");
  const eev = controller.addBrickAt("meter", 140, 10, { skin: "bm235" });
  press(panel(surface, eev.id, ".part-meter-bm-band"));
  assert.equal(doc.getComponent(eev.id).params.size, "compact");
  // The rest of the body is no title: a click there folds nothing.
  press(panel(surface, eev.id, ".part-meter-face"));
  assert.equal(doc.getComponent(eev.id).params.size, "compact");
});

test("Properties ▸ Size folds the meter and opens it out, as the title does — the hint under it", async () => {
  const { PopupManager } = await import("../popup-manager.js");
  resetDom();
  const doc = new DeskDoc(null);
  const { surface, controller } = makeDesk(doc, { x: 0, y: 0 });
  const meter = controller.addBrickAt("meter", 80, 10, {});
  const open = () => {
    PopupManager.close();
    surface.querySelector(`[data-component-id="${meter.id}"]`).dispatchEvent(
      new window.MouseEvent("contextmenu", { bubbles: true, clientX: 9, clientY: 9 }), // prettier-ignore
    );
    [...document.querySelectorAll(".popup-menu-item")]
      .find((b) => b.textContent.trim() === "Properties…")
      .click();
  };
  const row = () =>
    [...document.querySelectorAll(".properties-row")].find(
      (r) => r.querySelector(".properties-label")?.textContent === "Size",
    );
  const option = (text) =>
    [...row().querySelectorAll(".segmented-option")].find((b) => b.textContent === text); // prettier-ignore
  open();
  assert.ok(row(), "a Size row");
  assert.match(row().nextElementSibling.textContent, /^Click the title/); // prettier-ignore
  assert.ok(row().nextElementSibling.classList.contains("properties-field-note")); // prettier-ignore
  option("Compact").click();
  let now = doc.getComponent(meter.id);
  assert.equal(now.params.size, "compact");
  assert.deepEqual([now.x, now.y], [83, 12], "the screen left where it was");
  option("Full").click();
  now = doc.getComponent(meter.id);
  assert.equal(now.params.size, undefined);
  assert.deepEqual([now.x, now.y], [80, 10]);
  PopupManager.close();
});

test("a file holds no meter's place or size: it reopens beside the circuit, full size, and moving it is no unsaved change", async () => {
  const { meterForFile } = await import("../model/meter-probes.js");
  const { projectSignature } = await import("../model/project-doc.js");
  resetDom();
  const doc = new DeskDoc(null);
  const { controller } = makeDesk(doc, { x: 0, y: 0 });
  controller.addKitAt("full", 0, 0);
  const meter = controller.addBrickAt("meter", 120, 40, {
    size: "compact",
    dial: "ohm",
  });
  doc.setComponentParams(meter.id, { red: { dx: 20, dy: 30 }, black: { at: "bb2.a1" } }); // prettier-ignore
  const json = doc.toJSON();
  const filed = meterForFile(json).components.find((c) => c.id === meter.id);
  assert.equal("x" in filed || "y" in filed, false);
  assert.equal(filed.params.size, undefined);
  // A loose probe back in the full body's frame; one on a hole as it was.
  assert.deepEqual(filed.params.red, { dx: 23, dy: 32 });
  assert.deepEqual(filed.params.black, { at: "bb2.a1" });
  assert.equal(filed.params.dial, "ohm");
  assert.equal(json.components.find((c) => c.id === meter.id).x, 120, "the desk's own copy untouched"); // prettier-ignore
  // Reopened: beside the boards, level with their top, full size.
  const reopened = new DeskDoc(meterForFile(json)).toJSON();
  const back = reopened.components.find((c) => c.id === meter.id);
  const right = Math.max(...json.boards.map((b) => b.x + 64)); // a full kit is 63 wide
  assert.ok(back.x >= right, `${back.x} right of ${right}`);
  assert.equal(back.y, Math.round(Math.min(...json.boards.map((b) => b.y))));
  assert.equal(back.params.size, undefined);
  // The dirty test reads the file's form: a meter moved or folded is no change.
  const meta = (d) => ({ name: "", activeTab: "t1", nextIndex: 2, tabs: [{ id: "t1", name: "Desktop 1", doc: d }] }); // prettier-ignore
  const before = projectSignature(meta(doc.toJSON()));
  doc.moveBrick(meter.id, 200, 90);
  // …opened out as the fold does it, its loose probe left where it lay.
  doc.setComponentParams(meter.id, { size: "full", red: { dx: 23, dy: 32 } });
  assert.equal(projectSignature(meta(doc.toJSON())), before);
});

test("Properties ▸ Look: VoltHippo or EEVBlog — the one picked is what the next meter taken out wears", async () => {
  const { PopupManager } = await import("../popup-manager.js");
  resetDom();
  const doc = new DeskDoc(null);
  const { surface, controller } = makeDesk(doc, { x: 0, y: 0 });
  const id = controller.addMeter();
  const patches = [];
  window.addEventListener("chiphippo:settings-changed", (e) => patches.push(e.detail)); // prettier-ignore
  PopupManager.close();
  surface.querySelector(`[data-component-id="${id}"]`).dispatchEvent(
    new window.MouseEvent("contextmenu", { bubbles: true, clientX: 9, clientY: 9 }), // prettier-ignore
  );
  [...document.querySelectorAll(".popup-menu-item")]
    .find((b) => b.textContent.trim() === "Properties…")
    .click();
  const row = [...document.querySelectorAll(".properties-row")].find(
    (r) => r.querySelector(".properties-label")?.textContent === "Look",
  );
  const options = [...row.querySelectorAll(".segmented-option")];
  assert.deepEqual(options.map((b) => b.textContent), ["VoltHippo", "EEVBlog"]); // prettier-ignore
  options[1].click();
  assert.equal(doc.getComponent(id).params.skin, "bm235");
  assert.ok(surface.querySelector(`[data-component-id="${id}"]`).classList.contains("part-meter--bm235")); // prettier-ignore
  assert.deepEqual(patches, [{ meterLook: "bm235" }], "the app's default now");
  PopupManager.close();
  // The app hands the setting back (app.js applySettings): the next one out
  // wears it, until a Volt Hippo is picked again.
  controller.setDefaultMeterLook("bm235");
  assert.equal(doc.getComponent(controller.addMeter()).params.skin, "bm235");
  controller.setDefaultMeterLook("nonsense");
  assert.equal(doc.getComponent(controller.addMeter()).params.skin, undefined);
});

test("the full body narrows as the BM235's holster does — in below the LCD and narrow on down to its foot, boot and face", async () => {
  const { METER_BODY, bodyOutline } = await import("../model/meter-probes.js");
  for (const [name, shape] of Object.entries(METER_BODY)) {
    const pts = bodyOutline(shape);
    const mid = (shape.x0 + shape.x1) / 2;
    assert.deepEqual(pts[0], [mid, shape.y0], `${name} starts top-middle`);
    const leftAt = (y) => Math.min(...pts.filter((p) => p[0] < mid && Math.abs(p[1] - y) < 1).map((p) => p[0])); // prettier-ignore
    const run = shape.y1 - shape.y0 - 2 * shape.r;
    const yAt = (share) => shape.y0 + shape.r + run * share;
    // Full width round the LCD…
    assert.ok(Math.abs(leftAt(yAt(0.1)) - shape.x0) < 0.01, `${name} top`);
    // …in by its waist from the dial on, and still in at the foot.
    for (const share of [0.7, 0.85, 0.99]) {
      assert.ok(Math.abs(leftAt(yAt(share)) - shape.x0 - shape.waist) < 0.01, `${name} at ${share}`); // prettier-ignore
    }
    const lowest = pts.reduce((a, b) => (b[1] > a[1] ? b : a));
    assert.ok(Math.abs(lowest[1] - shape.y1) < 1e-9, `${name} foot`);
    const foot = pts.filter((p) => Math.abs(p[1] - shape.y1) < 1e-6);
    assert.ok(foot.every(([x]) => x >= shape.x0 + shape.waist + shape.r - 1e-9 && x <= shape.x1 - shape.waist - shape.r + 1e-9), `${name} foot drawn in`); // prettier-ignore
    // Never wider than it was, never narrower than its waist.
    for (const [x] of pts) {
      assert.ok(x >= shape.x0 - 1e-9 && x <= shape.x1 + 1e-9, `${name} ${x}`);
    }
    // Every point in sight of the first (a fan from it fills the shape):
    // the segment to it stays between the outline's sides at every height.
    for (const [x, y] of pts.slice(1)) {
      for (let k = 1; k < 20; k++) {
        const px = pts[0][0] + ((x - pts[0][0]) * k) / 20;
        const py = pts[0][1] + ((y - pts[0][1]) * k) / 20;
        const row = pts.filter((p) => Math.abs(p[1] - py) < 1);
        if (!row.length) continue;
        const lo = Math.min(...row.map((p) => p[0]));
        const hi = Math.max(...row.map((p) => p[0]));
        assert.ok(px >= lo - 0.1 && px <= hi + 0.1, `${name}: ${px},${py}`);
      }
    }
  }
});
