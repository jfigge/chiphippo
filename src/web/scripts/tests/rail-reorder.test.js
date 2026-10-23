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
// Tests for reordering the signal rail by dragging a card's title —
// components/rail-reorder.js, as the signal buttons and the Output/Input/Data
// cards use it — and the DeskDoc moves a drop commits.
//
// jsdom lays nothing out, so each card is given a rect: a column of 40 px
// cards, 50 px apart, at x 100–200. A flex `order` moves nothing here, which
// is fine — what is under test is the slot the gesture SHOWS and commits.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { SignalRail } = await import("../components/signal-rail.js");
const { IntegrationRail } = await import("../components/integration-rail.js");
const { DeskDoc } = await import("../model/desk-doc.js");
const { signalKey } = await import("../model/signals.js");

const rect = (left, top, width, height) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
});

/** Give a list of cards (and the list and column) a fixed layout. */
function layOut(column, list, cards) {
  cards.forEach((c, k) => {
    c.getBoundingClientRect = () => rect(100, 10 + 50 * k, 100, 40);
  });
  list.getBoundingClientRect = () => rect(100, 10, 100, 50 * cards.length);
  column.getBoundingClientRect = () => rect(100, 0, 100, 600);
}

function mountSignals({ count = 4, running = false } = {}) {
  const win = resetDom();
  const doc = new DeskDoc(null);
  const ids = [];
  for (let i = 0; i < count; i++) {
    ids.push(doc.addSignal({ name: `S${i + 1}` }).id);
  }
  const viewport = win.document.createElement("div");
  win.document.body.append(viewport);
  const moves = [];
  const presses = [];
  const rail = new SignalRail(viewport, doc, {
    onPress: (id, on) => presses.push(`${id}:${on}`),
    onReorder: (id, index) => {
      moves.push([id, index]);
      doc.moveSignal(id, index);
      win.dispatchEvent(new win.CustomEvent("chiphippo:doc-changed"));
    },
    canReorder: () => !running,
  });
  const layout = () => {
    const rows = [...viewport.querySelectorAll(".signal-rail-row")];
    layOut(rail.element, viewport.querySelector(".signal-rail-list"), rows);
    return rows;
  };
  return { win, doc, rail, ids, moves, presses, layout };
}

const ptr = (win, type, x, y) =>
  win.document.body.dispatchEvent(
    new win.PointerEvent(type, {
      bubbles: true,
      button: 0,
      pointerId: 1,
      clientX: x,
      clientY: y,
    }),
  );

/** Press a card's title at (x, y). */
const press = (win, handle, x, y) =>
  handle.dispatchEvent(
    new win.PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      pointerId: 1,
      clientX: x,
      clientY: y,
    }),
  );

const orders = (rows) => rows.map((r) => r.style.order);

// ── The document ────────────────────────────────────────────────────────────

test("moveSignal moves a signal to its new place, and its key with it", () => {
  const doc = new DeskDoc(null);
  const ids = ["a", "b", "c"].map((n) => doc.addSignal({ name: n }).id);
  assert.equal(doc.moveSignal(ids[0], 2), true);
  assert.deepEqual(
    doc.signals.map((s) => s.id),
    [ids[1], ids[2], ids[0]],
  );
  assert.equal(signalKey(doc.signals, ids[0]), "3", "the key IS the place");
  assert.equal(doc.moveSignal(ids[0], 2), false, "already there");
  assert.throws(() => doc.moveSignal("nope", 0), { code: "NOT_FOUND" });
  assert.throws(() => doc.moveSignal(ids[0], 3), { code: "INVALID_ARG" });
  assert.throws(() => doc.moveSignal(ids[0], -1), { code: "INVALID_ARG" });
});

test("moveIntegration reorders the cards and leaves wire order alone", async () => {
  const { elementIndex } = await import("../model/integration.js");
  const doc = new DeskDoc(null);
  const a = doc.addIntegration({ kind: "output", width: 1, connection: "c" });
  const b = doc.addIntegration({ kind: "output", width: 1, connection: "c" });
  assert.equal(doc.moveIntegration(b.id, 0), true);
  assert.deepEqual(
    doc.integrations.map((e) => e.id),
    [b.id, a.id],
  );
  const wire = (e) => elementIndex(doc.integrations, e);
  assert.deepEqual([wire(a), wire(b)], [0, 1], "a sketch numbers by id");
});

// ── The gesture ─────────────────────────────────────────────────────────────

test("a drag down the list shows the card in its slot, and the drop commits it", () => {
  const { win, doc, ids, moves, presses, layout } = mountSignals();
  const rows = layout();
  press(win, rows[0].querySelector(".signal-btn"), 150, 20);
  assert.deepEqual(presses, [], "stopped, a button is a title, not a press");
  ptr(win, "pointermove", 150, 22); // inside the click threshold
  assert.ok(!rows[0].classList.contains("rail-reorder--dragging"));
  ptr(win, "pointermove", 150, 140); // past the 2nd and 3rd cards' middles
  assert.ok(rows[0].classList.contains("rail-reorder--dragging"));
  assert.ok(!rows[0].classList.contains("rail-reorder--floating"));
  assert.deepEqual(orders(rows), ["2", "0", "1", "3"], "shown third");
  ptr(win, "pointerup", 150, 140);
  assert.deepEqual(moves, [[ids[0], 2]]);
  assert.deepEqual(
    doc.signals.map((s) => s.id),
    [ids[1], ids[2], ids[0], ids[3]],
  );
});

test("off the list the card rides the pointer, and a release there puts it back", () => {
  const { win, moves, layout } = mountSignals();
  const rows = layout();
  press(win, rows[1].querySelector(".signal-btn"), 150, 70);
  ptr(win, "pointermove", 150, 140);
  assert.equal(rows[1].style.order, "2");
  ptr(win, "pointermove", 20, 140); // left of the column
  assert.ok(rows[1].classList.contains("rail-reorder--floating"));
  assert.ok(rows[1].style.left && rows[1].style.top, "pinned to the pointer");
  ptr(win, "pointermove", 150, 400); // below the list
  assert.ok(rows[1].classList.contains("rail-reorder--floating"));
  ptr(win, "pointerup", 150, 400);
  assert.deepEqual(moves, [], "nothing moved");
  for (const r of rows) {
    assert.equal(r.style.order, "");
    assert.ok(!r.classList.contains("rail-reorder--floating"));
    assert.ok(!r.classList.contains("rail-reorder--dragging"));
    assert.equal(r.style.left, "");
  }
});

test("back over the list it docks again, in the slot under the pointer", () => {
  const { win, ids, moves, layout } = mountSignals();
  const rows = layout();
  press(win, rows[3].querySelector(".signal-btn"), 150, 170);
  ptr(win, "pointermove", 20, 170);
  assert.ok(rows[3].classList.contains("rail-reorder--floating"));
  ptr(win, "pointermove", 150, 15); // above the first card's middle
  assert.ok(!rows[3].classList.contains("rail-reorder--floating"));
  assert.equal(rows[3].style.order, "0");
  ptr(win, "pointerup", 150, 15);
  assert.deepEqual(moves, [[ids[3], 0]]);
});

test("a click, a drop where it started and Escape all move nothing", () => {
  const { win, moves, layout } = mountSignals();
  let rows = layout();
  press(win, rows[0].querySelector(".signal-btn"), 150, 20);
  ptr(win, "pointerup", 150, 20);
  press(win, rows[0].querySelector(".signal-btn"), 150, 20);
  ptr(win, "pointermove", 150, 30);
  ptr(win, "pointerup", 150, 30);
  rows = layout();
  press(win, rows[0].querySelector(".signal-btn"), 150, 20);
  ptr(win, "pointermove", 150, 140);
  win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(rows[0].style.order, "");
  ptr(win, "pointerup", 150, 140);
  assert.deepEqual(moves, []);
});

test("while running the button is a press, never a drag", () => {
  const { win, moves, presses, ids, layout } = mountSignals({ running: true });
  const rows = layout();
  press(win, rows[0].querySelector(".signal-btn"), 150, 20);
  ptr(win, "pointermove", 150, 140);
  assert.ok(!rows[0].classList.contains("rail-reorder--dragging"));
  ptr(win, "pointerup", 150, 140);
  assert.deepEqual(presses[0], `${ids[0]}:true`);
  assert.deepEqual(moves, []);
});

test("a rebuild mid-drag ends the drag, with nothing committed", () => {
  const { win, moves, layout } = mountSignals();
  const rows = layout();
  press(win, rows[0].querySelector(".signal-btn"), 150, 20);
  ptr(win, "pointermove", 150, 140);
  win.dispatchEvent(new win.CustomEvent("chiphippo:doc-changed"));
  ptr(win, "pointerup", 150, 140);
  assert.deepEqual(moves, []);
});

test("an Output/Input card drags by its head among the cards", () => {
  const win = resetDom();
  const doc = new DeskDoc(null);
  const a = doc.addIntegration({ kind: "output", width: 1, name: "A" });
  const b = doc.addIntegration({ kind: "input", width: 1, name: "B" });
  const c = doc.addIntegration({ kind: "data", name: "C" });
  const column = win.document.createElement("div");
  win.document.body.append(column);
  const moves = [];
  const rail = new IntegrationRail(column, doc, {
    onReorder: (id, index) => moves.push([id, index]),
    canReorder: () => true,
  });
  const cards = [...column.querySelectorAll(".integration-card")];
  layOut(column, rail.element, cards);
  press(win, cards[2].querySelector(".integration-card-head"), 150, 115);
  ptr(win, "pointermove", 150, 60); // above B's middle, below A's
  assert.deepEqual(orders(cards), ["0", "2", "1"]);
  ptr(win, "pointerup", 150, 60);
  assert.deepEqual(moves, [[c.id, 1]]);
  assert.ok(a && b);
});
