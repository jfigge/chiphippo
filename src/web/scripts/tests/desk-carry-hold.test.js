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

// A committed group drop on a busy desk leaves its carry standing for a frame
// (desk-controller.js #holdCarry / #settleCarry, CARRY_HOLD). These hold it to
// changing nothing but WHEN the views are put back: the same document, the
// same one undo step, the same picture at every moment (each view's own
// position plus its carrier's transform is where the document has it), and —
// once settled, by the frame after or by anything that touches a view first —
// the very DOM a drop that never held leaves.

import test from "node:test";
import assert from "node:assert/strict";

import { spec } from "../model/breadboard.js";
import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";

const { DeskController, CARRY_HOLD } = await import("../components/desk-controller.js"); // prettier-ignore

const ROW = spec("pins-full").rowY;

function fire(el, type, client) {
  el.dispatchEvent(
    new window.PointerEvent(type, {
      bubbles: true,
      button: 0,
      pointerId: 3,
      clientX: client[0],
      clientY: client[1],
    }),
  );
}

/** A full kit with parts and wires on it, a second kit it is wired to, and
    a PSU — dragged by its centre strip and dropped somewhere legal. */
function dropKit(min, { after } = {}) {
  resetDom();
  CARRY_HOLD.min = min;
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const deskView = {
    surface,
    camera: { cx: 0, cy: 0, zoom: 1 },
    worldFromEvent: () => ({ x: world.x, y: world.y }),
  };
  const controller = new DeskController({ viewport, deskView, deskDoc: doc });
  controller.addKitAt("full", 0, 0); // bb1·bb2·bb3
  controller.addKitAt("full", 100, 0); // bb4·bb5·bb6
  controller.addComponentAt("74LS00", "bb2", "e10");
  controller.addComponentAt("74LS04", "bb2", "e30");
  controller.addComponentAt("resistor", "bb2", "a50");
  controller.addComponentAt("led", "bb5", "a20");
  doc.addWire({ from: "bb2.a12", to: "bb2.j40", color: "red" });
  doc.addWire({ from: "bb2.b14", to: "bb5.b20", color: "blue" }); // stretches
  doc.addPsu(-20, 10);
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));
  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  controller.selectBoard("bb2"); // the kit, so the press is its drag
  const el = surface.querySelector('[data-board-id="bb2"]');
  world.x = 5;
  world.y = ROW.e;
  fire(el, "pointerdown", [0, 0]);
  world.x = 15;
  world.y = ROW.e + 25.5; // clear of everything
  fire(el, "pointermove", [40, 40]);
  fire(el, "pointerup", [40, 40]);
  const justAfter = snapshotViews(surface);
  after?.({ controller, doc, surface });
  return { controller, doc, surface, changes, justAfter };
}

/** Every strip and part view: its own left/top, and where it is DRAWN — that
    plus the transform of every carrier above it — plus each layer's order. */
function snapshotViews(surface) {
  const drawn = (el) => {
    let x = parseFloat(el.style.left) || 0;
    let y = parseFloat(el.style.top) || 0;
    for (let p = el.parentElement; p && p !== surface; p = p.parentElement) {
      const m = /translate\((\S+)px, (\S+)px\)/.exec(p.style.transform ?? "");
      if (m) {
        x += Number(m[1]);
        y += Number(m[2]);
      }
    }
    return [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6];
  };
  const views = [...surface.querySelectorAll("[data-board-id], [data-component-id]")]; // prettier-ignore
  return {
    own: views.map((v) => [v.dataset.boardId ?? v.dataset.componentId, v.style.left, v.style.top]), // prettier-ignore
    drawn: views.map((v) => [v.dataset.boardId ?? v.dataset.componentId, ...drawn(v)]), // prettier-ignore
    carriers: surface.querySelectorAll(".desk-drag-carry, .desk-drag-still").length, // prettier-ignore
    lifted: surface.querySelectorAll("[class*='--lifted']").length,
    order: [...surface.children].map(
      (layer) =>
      [...layer.children].map((c) => c.dataset?.boardId ?? c.dataset?.componentId ?? c.className).join(","), // prettier-ignore
    ),
    transforms: [...surface.children].map((l) => l.style.transform).join("|"),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a held drop commits the same document, once, and draws it from the first frame", async () => {
  const plain = dropKit(Infinity);
  const plainViews = snapshotViews(plain.surface);
  const plainDoc = JSON.stringify(plain.doc.toJSON());
  assert.equal(plain.doc.getBoard("bb2").x, 10, "the drop moved the kit");

  const held = dropKit(0);
  assert.equal(
    JSON.stringify(held.doc.toJSON()),
    plainDoc,
    "the same document",
  );
  assert.equal(held.changes, 1, "one doc-changed");
  assert.equal(held.controller.canUndo, plain.controller.canUndo);
  // Drawn where the document has it, already — but still on its carrier.
  assert.ok(held.justAfter.carriers + (held.justAfter.transforms.match(/translate/g)?.length ?? 0) > 0, "held on a carrier"); // prettier-ignore
  // (In carrier order for the frame: strips never overlap, and parts are in
  // the order the drag drew them.)
  const byId = (rows) => [...rows].sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(byId(held.justAfter.drawn), byId(plainViews.drawn), "the same picture"); // prettier-ignore
  assert.equal(held.justAfter.lifted, 0, "the strips' fade is gone with the drop"); // prettier-ignore
  await tick();
  // Settled the frame after: the DOM a drop that never held leaves.
  assert.deepEqual(snapshotViews(held.surface), plainViews);
});

test("anything that touches a view first settles the held carry, in the same task", async () => {
  // An edit (its doc-changed), an undo (the rebuild) and a press each settle
  // it before they work on the views.
  for (const [name, act] of [
    ["edit", ({ controller }) => controller.nameNet("bb2.a12", "CLK")],
    ["mount", ({ controller }) => controller.addBoardAt("pins-tiny", 200, 0)],
    ["undo", ({ controller }) => controller.undo()],
  ]) {
    let at = null;
    const held = dropKit(0, {
      after: (ctx) => {
        act(ctx);
        at = snapshotViews(ctx.surface);
      },
    });
    assert.equal(at.carriers, 0, `${name}: no carrier left`);
    assert.ok(!/translate\((?!0px, 0px)/.test(at.transforms), `${name}: no layer left translated (${at.transforms})`); // prettier-ignore
    // Every view at its document position, by its own left/top.
    for (const [id, x, y] of at.drawn) {
      const own = at.own.find((o) => o[0] === id);
      const r6 = (v) => Math.round(parseFloat(v) * 1e6) / 1e6;
      assert.equal(r6(own[1]), x, `${name}: ${id} left`);
      assert.equal(r6(own[2]), y, `${name}: ${id} top`);
    }
    const board = held.doc.getBoard("bb2");
    const el = held.surface.querySelector('[data-board-id="bb2"]');
    assert.equal(el.style.left, `${board.x * PX_PER_UNIT}px`, name);
    await tick();
  }
});

test("a view unmounted while the carry is held stays gone", async () => {
  let removed = null;
  const held = dropKit(0, {
    after: ({ controller, doc, surface }) => {
      const chip = doc.components.find((c) => c.ref === "74LS04");
      removed = chip.id;
      controller.removeComponent(chip.id);
      assert.equal(surface.querySelector(`[data-component-id="${chip.id}"]`), null); // prettier-ignore
    },
  });
  await tick();
  assert.equal(held.surface.querySelector(`[data-component-id="${removed}"]`), null); // prettier-ignore
  assert.equal(snapshotViews(held.surface).carriers, 0);
});

test.after(() => {
  CARRY_HOLD.min = 200;
});
