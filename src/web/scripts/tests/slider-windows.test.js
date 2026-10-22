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

// The floated slider, the app window's side (components/slider-windows.js):
// a pot's Position torn off the modal Properties card into an OS window of
// its own. Held here through the desk, against a stand-in for main's relay:
// both ways to float it, what the window is told, that its moves write
// through the card's own path and follow the document, when it closes, and
// the part it lights.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";

const { DeskController } = await import("../components/desk-controller.js");
const { PopupManager } = await import("../popup-manager.js");

/** main's relay, recorded. */
function fakeBridge() {
  const calls = [];
  return {
    calls,
    open: (compId, key, opts) => calls.push(["open", compId, key, opts]),
    close: (compId, key) => calls.push(["close", compId, key]),
    toWindow: (compId, key, msg) => calls.push(["toWindow", compId, key, msg]),
    /** The last state sent to a window. */
    state: () => calls.filter((c) => c[0] === "toWindow").at(-1)?.[3],
    of: (kind) => calls.filter((c) => c[0] === kind),
  };
}

/** A desk with one 100k pot on it. */
function potDesk() {
  resetDom();
  PopupManager.close();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const bridge = fakeBridge();
  let toggles = 0;
  const controller = new DeskController({
    viewport,
    deskView: {
      surface,
      camera: { cx: 0, cy: 0, zoom: 1 },
      worldFromEvent: () => ({ x: 0, y: 0 }),
    },
    deskDoc: doc,
    sliderBridge: bridge,
    onSliderRunToggle: () => toggles++,
  });
  const pot = controller.addComponentAt("pot", "bb1", "a20", { ohms: 1e5 });
  const partEl = () => surface.querySelector(`[data-component-id="${pot.id}"]`);
  // What main relays from the window.
  const fromWindow = (msg, key = "position") =>
    window.dispatchEvent(
      new CustomEvent("chiphippo:slider-host-inbound", {
        detail: { compId: pot.id, key, msg },
      }),
    );
  return { doc, controller, pot, partEl, bridge, fromWindow, toggles: () => toggles, surface, viewport }; // prettier-ignore
}

const rightClick = (elem) => {
  PopupManager.close();
  elem.dispatchEvent(
    new window.MouseEvent("contextmenu", { bubbles: true, clientX: 9, clientY: 9 }), // prettier-ignore
  );
};

const menuItem = (label) =>
  [...document.querySelectorAll(".popup-menu-item")].find(
    (b) => b.textContent.trim() === label,
  );

const float = (partEl) => {
  rightClick(partEl());
  menuItem("Float Position Slider").click();
};

test("the pot's menu floats its Position slider, beside Properties…", () => {
  const { controller, pot, partEl, bridge } = potDesk();
  rightClick(partEl());
  const labels = [...document.querySelectorAll(".popup-menu-item")].map((b) =>
    b.textContent.trim(),
  );
  assert.deepEqual(labels, [
    "Pin Assignment",
    "Properties…",
    "Float Position Slider",
    "Delete Component",
  ]);
  menuItem("Float Position Slider").click();
  const [[kind, compId, key, opts]] = bridge.of("open");
  assert.deepEqual([kind, compId, key], ["open", pot.id, "position"]);
  assert.equal(opts.title, "Potentiometer — Position");
  assert.equal(PopupManager.isOpen(), false, "nothing modal is up");
  // Floating it again asks main again — which focuses the one window.
  float(partEl);
  assert.equal(bridge.of("open").length, 2);

  // A part with no slider has no such item.
  controller.addComponentAt("74LS00", "bb1", "e40");
  rightClick(document.querySelector(".part-chip"));
  assert.equal(menuItem("Float Position Slider"), undefined);
  PopupManager.close();
});

test("the Properties card's Position row pops out into the same window", () => {
  const { partEl, bridge } = potDesk();
  rightClick(partEl());
  menuItem("Properties…").click();
  const button = document.querySelector(".properties-icon-action");
  assert.ok(button, "the Position row carries the pop-out icon");
  assert.equal(button.getAttribute("aria-label"), "Float this slider");
  button.click();
  assert.equal(PopupManager.isOpen(), false, "the Properties card closes");
  assert.equal(bridge.of("open").length, 1, "and the slider floats");
});

test("a window that says it is ready is told what to show", () => {
  const { partEl, bridge, fromWindow } = potDesk();
  float(partEl);
  fromWindow({ kind: "ready" });
  assert.deepEqual(bridge.state(), {
    kind: "state",
    title: "Potentiometer",
    label: "Position",
    min: 0,
    max: 100,
    step: 1,
    valuePercent: false,
    value: 50,
    ends: ["50k", "50k"],
    seq: 0,
  });
});

test("its moves write the part as the Properties slider does, and are answered", () => {
  const { doc, controller, pot, partEl, bridge, fromWindow } = potDesk();
  float(partEl);
  fromWindow({ kind: "ready" });
  fromWindow({ kind: "set", value: 15, seq: 1 });
  assert.equal(doc.getComponent(pot.id).params.position, 15);
  assert.deepEqual(bridge.state().ends, ["15k", "85k"]);
  assert.equal(bridge.state().value, 15);
  assert.equal(bridge.state().seq, 1, "the move it answers");
  // A whole drag is one undo step, coalesced; the window follows the undo.
  fromWindow({ kind: "set", value: 30, seq: 2 });
  fromWindow({ kind: "set", value: 40, seq: 3 });
  fromWindow({ kind: "set", value: "lots", seq: 4 });
  assert.equal(doc.getComponent(pot.id).params.position, 40, "a non-number is no move"); // prettier-ignore
  assert.equal(controller.undo(), true);
  assert.equal(doc.getComponent(pot.id).params.position, 50);
  assert.equal(bridge.state().value, 50);
  assert.equal(bridge.state().seq, 3);
  // Another edit with nothing new for it to say: nothing sent.
  const sent = bridge.of("toWindow").length;
  controller.addComponentAt("led", "bb1", "a40");
  assert.equal(bridge.of("toWindow").length, sent);
});

test("it follows a new Resistance and Name, and closes with its part", () => {
  const { doc, controller, pot, partEl, bridge, fromWindow } = potDesk();
  float(partEl);
  fromWindow({ kind: "ready" });
  fromWindow({ kind: "set", value: 15, seq: 1 });
  rightClick(partEl());
  menuItem("Properties…").click();
  const resistance = document.querySelector(".popup-dialog .properties-combo-input"); // prettier-ignore
  resistance.value = "10k";
  resistance.dispatchEvent(new window.Event("change", { bubbles: true }));
  const name = document.querySelector(".popup-dialog .properties-text-input");
  name.value = "Volume";
  name.dispatchEvent(new window.Event("change"));
  PopupManager.close();
  assert.deepEqual(bridge.state().ends, ["1.5k", "8.5k"]);
  assert.equal(bridge.state().title, "Volume");

  controller.removeComponent(pot.id);
  assert.equal(doc.getComponent(pot.id), null);
  assert.deepEqual(bridge.of("close"), [["close", pot.id, "position"]]);
  // Its window's last words reach no one.
  fromWindow({ kind: "set", value: 70, seq: 2 });
  assert.equal(bridge.of("close").length, 1);
});

test("another desktop coming in closes every window", () => {
  const { doc, controller, pot, partEl, bridge } = potDesk();
  float(partEl);
  controller.loadDocument(doc.toJSON());
  assert.deepEqual(bridge.of("close"), [["close", pot.id, "position"]]);
});

test("a window pointed at or focused lights its pot, through every remount a move makes", () => {
  const { partEl, fromWindow } = potDesk();
  float(partEl);
  const lit = () => partEl().classList.contains("part--float-target");
  assert.equal(lit(), false);
  fromWindow({ kind: "hover", on: true });
  assert.ok(lit());
  fromWindow({ kind: "set", value: 70, seq: 1 }); // remounts the part's view
  assert.ok(lit(), "still lit");
  fromWindow({ kind: "hover", on: false });
  assert.equal(lit(), false);
  fromWindow({ kind: "hover", on: true });
  fromWindow({ kind: "closed" });
  assert.equal(lit(), false, "a window closed puts it out");
});

test("a Space tapped in the window is handed to Run/Stop", () => {
  const { partEl, fromWindow, toggles } = potDesk();
  float(partEl);
  fromWindow({ kind: "run-toggle" });
  assert.equal(toggles(), 1);
  // Only from a window this desk floated.
  fromWindow({ kind: "run-toggle" }, "ohms");
  assert.equal(toggles(), 1);
});

test("main is told where the part, the circuit and the desk are, in client pixels", () => {
  const { partEl, bridge, surface, viewport } = potDesk();
  const at = (elem, left, top, right, bottom) => {
    elem.getBoundingClientRect = () => ({ left, top, right, bottom, width: right - left, height: bottom - top }); // prettier-ignore
  };
  at(viewport, 60, 80, 1200, 800);
  at(surface.querySelector('[data-board-id="bb1"]'), 200, 300, 900, 450);
  at(partEl(), 400, 420, 440, 440);
  float(partEl);
  assert.deepEqual(bridge.of("open")[0][3].anchor, {
    part: { left: 400, top: 420, right: 440, bottom: 440 },
    clear: { left: 200, top: 300, right: 900, bottom: 450 },
    within: { left: 60, top: 80, right: 1200, bottom: 800 },
  });
});

test("with the part out of sight, there is nothing to place by", () => {
  // jsdom lays nothing out: every box is empty, as a hidden view's is.
  const { partEl, bridge } = potDesk();
  float(partEl);
  assert.equal(bridge.of("open")[0][3].anchor, null);
});
