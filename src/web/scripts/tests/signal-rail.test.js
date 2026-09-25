/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// jsdom tests for components/signal-rail.js — the external-signal buttons
// pinned down the desk viewport's right edge (Feature 370).
//
// Two contracts matter most here, and neither is visible from the model:
// a doc change REBUILDS the rail while a sim-state only repaints it (that
// event fires on every tick), and a button press is guaranteed to be released
// down all three legs.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { SignalRail } = await import("../components/signal-rail.js");
const { DeskDoc } = await import("../model/desk-doc.js");

function mount({ signals = 2 } = {}) {
  const win = resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const ids = [];
  for (let i = 0; i < signals; i++) {
    ids.push(doc.addSignal({ name: `S${i + 1}` }).id);
  }
  const viewport = win.document.createElement("div");
  win.document.body.append(viewport);
  const presses = [];
  const drags = [];
  const props = [];
  const rail = new SignalRail(viewport, doc, {
    onPress: (id, on) => presses.push(`${id}:${on ? "down" : "up"}`),
    onFlagPointerDown: (id) => drags.push(id),
    onContextMenu: (id) => props.push(id),
  });
  return { win, doc, rail, viewport, ids, presses, drags, props };
}

const rows = (viewport) => [...viewport.querySelectorAll(".signal-rail-row")];
const pd = (win, opts = {}) =>
  new win.PointerEvent("pointerdown", { bubbles: true, button: 0, ...opts });

test("one row per signal, in rail order, each carrying its own colour", () => {
  const { doc, viewport, ids } = mount({ signals: 3 });
  const built = rows(viewport);
  assert.equal(built.length, 3);
  assert.deepEqual(
    built.map((r) => r.dataset.signalId),
    ids,
  );
  const colors = doc.signals.map((s) => s.color);
  assert.deepEqual(
    built.map((r) => r.style.getPropertyValue("--signal-color")),
    colors.map((c) => `var(--color-wire-${c})`),
  );
  assert.deepEqual(
    built.map((r) => r.querySelector(".signal-btn-label").textContent),
    ["S1", "S2", "S3"],
  );
});

test("a planted signal hides its rail chip — the flag is in ONE place", () => {
  const { doc, viewport, ids, win } = mount();
  assert.ok(!rows(viewport)[0].classList.contains("signal-rail-row--placed"));
  doc.plantSignalFlag(ids[0], "bb1.a12", 0);
  win.dispatchEvent(new win.CustomEvent("chiphippo:doc-changed"));
  const built = rows(viewport);
  assert.ok(built[0].classList.contains("signal-rail-row--placed"));
  assert.ok(!built[1].classList.contains("signal-rail-row--placed"));
});

test("pointerdown presses and every release leg lets go", () => {
  for (const releaseType of [
    "pointerup",
    "pointercancel",
    "lostpointercapture",
  ]) {
    const { win, viewport, ids, presses } = mount({ signals: 1 });
    const btn = viewport.querySelector(".signal-btn");
    btn.dispatchEvent(pd(win, { pointerId: 1 }));
    assert.deepEqual(presses, [`${ids[0]}:down`], releaseType);
    btn.dispatchEvent(
      new win.PointerEvent(releaseType, { bubbles: true, pointerId: 1 }),
    );
    assert.deepEqual(presses, [`${ids[0]}:down`, `${ids[0]}:up`], releaseType);
  }
});

test("a non-primary press is not a press at all", () => {
  const { win, viewport, presses } = mount({ signals: 1 });
  viewport
    .querySelector(".signal-btn")
    .dispatchEvent(pd(win, { button: 2, pointerId: 1 }));
  assert.deepEqual(presses, []);
});

test("a sim-state REPAINTS, it never rebuilds — that event fires every tick", () => {
  const { win, viewport, ids } = mount({ signals: 1 });
  const before = viewport.querySelector(".signal-btn");
  win.dispatchEvent(
    new win.CustomEvent("chiphippo:sim-state", {
      detail: { running: true, signalLevels: new Map([[ids[0], "H"]]) },
    }),
  );
  const after = viewport.querySelector(".signal-btn");
  assert.equal(after, before, "the same element node, not a fresh one");
  assert.ok(after.classList.contains("signal-btn--on"));
  assert.equal(after.getAttribute("aria-pressed"), "true");

  win.dispatchEvent(
    new win.CustomEvent("chiphippo:sim-state", {
      detail: { running: true, signalLevels: new Map([[ids[0], "L"]]) },
    }),
  );
  assert.ok(!after.classList.contains("signal-btn--on"));
});

test("while STOPPED a button shows its resting level, not a stale one", () => {
  const { win, doc, viewport, ids } = mount({ signals: 1 });
  doc.updateSignal(ids[0], { rest: "high" });
  win.dispatchEvent(new win.CustomEvent("chiphippo:doc-changed"));
  // A run left it high...
  win.dispatchEvent(
    new win.CustomEvent("chiphippo:sim-state", {
      detail: { running: true, signalLevels: new Map([[ids[0], "H"]]) },
    }),
  );
  assert.ok(
    viewport.querySelector(".signal-btn").classList.contains("signal-btn--on"),
  );
  // ...and stopping puts it back to what  says, which is still high.
  win.dispatchEvent(
    new win.CustomEvent("chiphippo:sim-state", {
      detail: { running: false, signalLevels: new Map() },
    }),
  );
  assert.ok(
    viewport.querySelector(".signal-btn").classList.contains("signal-btn--on"),
    "rest high reads as on while stopped",
  );
});

test("the flag chip starts the drag; a secondary click opens its menu", () => {
  const { win, viewport, ids, drags, props } = mount({ signals: 1 });
  viewport
    .querySelector(".signal-flag-chip")
    .dispatchEvent(pd(win, { pointerId: 1 }));
  assert.deepEqual(drags, [ids[0]]);
  const menu = new win.MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  viewport.querySelector(".signal-btn").dispatchEvent(menu);
  assert.deepEqual(
    props,
    [ids[0]],
    "an UNPLACED signal has no flag to right-click, so the button is its only\n" +
      "route to Properties AND to Remove",
  );
});

test("a toggle button reads differently from a momentary one at rest", () => {
  const { win, doc, viewport, ids } = mount({ signals: 1 });
  assert.ok(
    !viewport
      .querySelector(".signal-btn")
      .classList.contains("signal-btn--toggle"),
  );
  doc.updateSignal(ids[0], { type: "toggle" });
  win.dispatchEvent(new win.CustomEvent("chiphippo:doc-changed"));
  assert.ok(
    viewport
      .querySelector(".signal-btn")
      .classList.contains("signal-btn--toggle"),
  );
});

test("each button's dot carries its KEY — 1 to 9, then 0 for the tenth", () => {
  const { viewport } = mount({ signals: 10 });
  assert.deepEqual(
    rows(viewport).map((r) => r.querySelector(".signal-btn-dot").textContent),
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  );
});

test("a selected flag lights its button, and a rebuild keeps it lit", () => {
  const { win, rail, viewport, ids } = mount({ signals: 3 });
  const lit = () =>
    rows(viewport)
      .filter((r) =>
        r
          .querySelector(".signal-btn")
          .classList.contains("signal-btn--selected"),
      )
      .map((r) => r.dataset.signalId);
  assert.deepEqual(lit(), []);
  rail.setSelected(ids[1]);
  assert.deepEqual(lit(), [ids[1]]);
  win.dispatchEvent(new win.CustomEvent("chiphippo:doc-changed"));
  assert.deepEqual(lit(), [ids[1]], "the rebuilt row is still lit");
  rail.setSelected(null);
  assert.deepEqual(lit(), []);
});
