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

// DeskController's SEAT_NEUTRAL_LABELS: the edits whose commit skips
// `pressProbesOff` because they cannot press anything into a hole or take
// anything out of one. The list is kept by hand, so this file ties it to the
// code that records each label: every label on it is recorded at exactly ONE
// place in the source (a second edit reusing a label has to be weighed before
// it rides the skip), and a REAL edit through the controller that records it
// leaves every part's `DeskDoc.seatKey` — and the whole desk's occupancy, and
// the probes resting in holes — exactly as they were. A label added to the
// list with no edit here, or one left on it after its edit is gone, fails.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
import { HistoryStore } from "../model/history-store.js";
import { buildOccupancy } from "../model/occupancy.js";

const { DeskController } = await import("../components/desk-controller.js");
const { PopupManager } = await import("../popup-manager.js");

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, "..");
const controllerSrc = fs.readFileSync(
  path.join(scripts, "components/desk-controller.js"),
  "utf8",
);

/** The Set literal named `name` in desk-controller.js, as its strings. */
function setLiteral(name) {
  const m = controllerSrc.match(
    new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`),
  );
  assert.ok(m, `${name} is a Set literal in desk-controller.js`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

const NEUTRAL = setLiteral("SEAT_NEUTRAL_LABELS");

/** Every first-party renderer source, the lists themselves taken out. */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "tests" || ent.name === "vendor") continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".js")) {
        let text = fs.readFileSync(p, "utf8");
        if (p.endsWith(path.join("components", "desk-controller.js"))) {
          text = text.replace(
            /const (SEAT_NEUTRAL_LABELS|RUN_VOLATILE_LABELS) = new Set\(\[[\s\S]*?\]\);/g,
            "",
          );
        }
        out.push({ file: path.relative(scripts, p), text });
      }
    }
  };
  walk(scripts);
  return out;
}

test("each seat-neutral label is recorded at exactly one place in the source", () => {
  const all = sources();
  for (const label of NEUTRAL) {
    const at = all.flatMap(({ file, text }) =>
      text.split("\n").flatMap((line, i) => {
        const n = line.split(`"${label}"`).length - 1;
        return Array(n).fill(`${file}:${i + 1}`);
      }),
    );
    assert.equal(
      at.length,
      1,
      `"${label}" is written at ${at.join(", ") || "no place"} — a seat-neutral label belongs to one edit`,
    );
  }
});

// ── A bench with something in every kind of hole ────────────────────────────

function fire(el, type, { client = [0, 0] } = {}) {
  el.dispatchEvent(
    new window.PointerEvent(type, { bubbles: true, button: 0, pointerId: 7, clientX: client[0], clientY: client[1] }), // prettier-ignore
  );
}

function rightClick(el) {
  el.dispatchEvent(
    new window.MouseEvent("contextmenu", { bubbles: true, clientX: 9, clientY: 9 }), // prettier-ignore
  );
}

/** Pick an item off the open context menu by its (English) text. */
function menuItem(text) {
  const item = [...document.querySelectorAll(".popup-menu-item")].find(
    (b) => b.textContent.trim() === text,
  );
  assert.ok(item, `a "${text}" menu item`);
  item.click();
}

/** The open Properties dialog's row labelled `label`. */
function propertiesRow(label) {
  const row = [...document.querySelectorAll(".properties-row")].find(
    (r) => r.querySelector(".properties-label")?.textContent === label,
  );
  assert.ok(row, `a "${label}" row`);
  return row;
}

function setText(label, value) {
  const input = propertiesRow(label).querySelector("input, textarea");
  input.value = value;
  input.dispatchEvent(new window.Event("change"));
}

/** A full kit with a chip, an LED, a wire, a data bus's tag, a net name, two
    analyzer channels, the analyzer's ground, an annotation and a meter with
    one probe on a pin and one in an empty hole — loaded through the
    controller, with a history this file can read. */
function bench() {
  while (PopupManager.isOpen()) PopupManager.close();
  resetDom();
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0);
  const chip = doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb2", anchor: "e5" }); // prettier-ignore
  doc.addComponent({ kind: "discrete", ref: "led", board: "bb2", anchor: "a20", params: { color: "red" } }); // prettier-ignore
  const wire = doc.addWire({ from: "bb2.a6", to: "bb2.a30", color: "red" });
  const data = doc.addIntegration({ kind: "data" });
  doc.plantIntegrationTag(data.id, "1", "bb2.a40");
  doc.nameNet("bb2.a1", "SENSE");
  const ch1 = doc.addScopeChannel("net", "bb2.a6");
  const ch2 = doc.addScopeChannel("net", "bb2.a20");
  doc.setScopeGround("bb2.j50");
  const note = doc.addAnnotation("label", 10, -8, "hello");
  const meter = doc.addBrick("meter", 90, 0, {});
  doc.setMeterProbe(meter.id, "red", { at: "bb2.e5" });
  doc.setMeterProbe(meter.id, "black", { at: "bb2.c45" });

  const viewport = document.createElement("section");
  viewport.className = "desk-viewport";
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const world = { x: 0, y: 0 };
  const deskView = {
    surface,
    camera: { cx: 0, cy: 0, zoom: 1 },
    worldFromEvent: () => ({ x: world.x, y: world.y }),
  };
  const controller = new DeskController({ viewport, deskView, deskDoc: doc });
  const history = new HistoryStore();
  controller.loadDocument(doc.toJSON(), { history });
  return {
    doc,
    controller,
    history,
    surface,
    world,
    ids: { chip: chip.id, wire: wire.id, data: data.id, ch1: ch1.id, ch2: ch2.id, note: note.id }, // prettier-ignore
  };
}

/** Everything an edit could press into a hole or lift out of one. */
function seats(doc) {
  const occ = buildOccupancy(doc.toJSON());
  return JSON.stringify({
    parts: doc.components.map((c) => [c.id, doc.seatKey(c.id)]),
    occupancy: [...occ].map(([a, claim]) => [a, claim.kind]).sort(),
  });
}

/** Each label → a real edit through the controller that records it (and an
    optional `setup` run first, recorded under its own label). */
const EDITS = {
  "set data pin": ({ controller, ids }) => controller.cycleDataPin(ids.data, "1"),
  "move symbol": ({ controller, ids }) => controller.setSchematicPos(ids.chip, 12, 7),
  "auto-layout schematic": {
    setup: ({ controller, ids }) => controller.setSchematicPos(ids.chip, 12, 7),
    edit: ({ controller }) => controller.autoLayoutSchematic(),
  },
  "name net": ({ controller }) => controller.nameNet("bb2.a30", "OUT"),
  "clear net name": ({ controller }) => controller.clearNetNames(["bb2.a1"]),
  "add analyzer channel": ({ controller }) => controller.addScopeChannel("net", "bb2.a40"),
  "remove analyzer channel": ({ controller, ids }) => controller.removeScopeChannel(ids.ch1),
  "reorder analyzer channel": ({ controller, ids }) => controller.moveScopeChannel(ids.ch2, 0),
  "update analyzer channel": ({ controller, ids }) => controller.updateScopeChannel(ids.ch1, { label: "A" }),
  "place analyzer ground": ({ controller }) => controller.setScopeGround("bb2.j55"),
  "remove analyzer ground": ({ controller }) => controller.setScopeGround(null),
  "add annotation": ({ controller }) => controller.addAnnotationAt("note", 30, -8),
  "edit annotation": ({ surface }) => {
    surface.querySelector(".annotation").dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })); // prettier-ignore
    const editor = surface.querySelector(".annotation-editor");
    editor.value = "renamed";
    editor.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); // prettier-ignore
  },
  "delete annotation": ({ controller, ids }) => controller.removeAnnotation(ids.note),
  "move annotation": ({ surface, world }) => {
    const box = surface.querySelector(".annotation");
    world.x = 10;
    world.y = -8;
    fire(box, "pointerdown");
    world.x = 25;
    world.y = -12;
    fire(box, "pointermove", { client: [60, 60] });
    fire(box, "pointerup", { client: [60, 60] });
  },
  "recolor wire": ({ controller, ids }) => controller.recolorWire(ids.wire, "blue"),
  "set wire properties": ({ surface, ids }) => {
    rightClick(surface.querySelector(`g.wire[data-wire-id="${ids.wire}"]`));
    menuItem("Properties…");
    setText("Name", "CLK");
  },
  "set wire layout": ({ surface, ids }) => {
    rightClick(surface.querySelector(`g.wire[data-wire-id="${ids.wire}"]`));
    menuItem("Properties…");
    [...propertiesRow("Layout Method").querySelectorAll(".segmented-option")]
      .find((b) => b.dataset.value === "routed")
      .click();
  },
  "set board properties": ({ surface }) => {
    rightClick(surface.querySelector('.board[data-board-id="bb2"]'));
    menuItem("Properties…");
    setText("Name", "main");
  },
}; // prettier-ignore

test("every seat-neutral label has an edit here, and every edit here is on the list", () => {
  assert.deepEqual(Object.keys(EDITS).sort(), [...NEUTRAL].sort());
});

for (const label of NEUTRAL) {
  test(`"${label}": the edit that records it presses nothing in and lifts nothing out`, () => {
    const b = bench();
    try {
      const entry = EDITS[label];
      const { setup, edit } = typeof entry === "function" ? { edit: entry } : entry; // prettier-ignore
      setup?.(b);
      const before = seats(b.doc);
      const probes = JSON.stringify(b.doc.getComponent(b.doc.components.at(-1).id).params); // prettier-ignore
      const size = b.history.size;
      edit(b);
      assert.equal(b.history.label, label, "the edit was recorded under it");
      assert.ok(b.history.size > size, "as a step of its own");
      assert.equal(seats(b.doc), before, "every seat and every claimed hole unchanged"); // prettier-ignore
      assert.equal(
        JSON.stringify(b.doc.getComponent(b.doc.components.at(-1).id).params),
        probes,
        "the meter's probes still in their holes",
      );
    } finally {
      while (PopupManager.isOpen()) PopupManager.close();
    }
  });
}
