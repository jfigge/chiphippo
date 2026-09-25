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
// jsdom tests for components/signal-layer.js — the planted flags. What is
// pinned here is the KEY each flag prints (colours repeat, so it is what ties
// a flag to its button) and the one selection report the rail lights from.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { SignalLayer } = await import("../components/signal-layer.js");
const { DeskDoc } = await import("../model/desk-doc.js");
const { PX_PER_UNIT } = await import("../desk/desk-geometry.js");
const { FLAG_KEY_R, flagKeyPoint } = await import("../model/signals.js");

function mount({ signals = 2, planted = signals } = {}) {
  const win = resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const ids = [];
  for (let i = 0; i < signals; i++) {
    const { id } = doc.addSignal({});
    ids.push(id);
    if (i < planted) doc.plantSignalFlag(id, `bb1.a${2 + i * 5}`, 0);
  }
  const layer = win.document.createElement("div");
  win.document.body.append(layer);
  const selected = [];
  const signalLayer = new SignalLayer(layer, doc, {
    onSelect: (id) => selected.push(id),
  });
  return { win, doc, layer, signalLayer, ids, selected };
}

const keys = (layer) =>
  [...layer.querySelectorAll(".signal-flag-key")].map((n) => n.textContent);

test("every planted flag prints its key, and the tenth prints 0", () => {
  const { layer } = mount({ signals: 10 });
  assert.deepEqual(keys(layer), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]); // prettier-ignore
});

test("the key follows the RAIL position, not the id", () => {
  const { win, doc, layer, ids } = mount({ signals: 3 });
  doc.removeSignal(ids[0]);
  win.dispatchEvent(new win.CustomEvent("chiphippo:doc-changed"));
  assert.deepEqual(keys(layer), ["1", "2"], "the rest move up a key");
});

test("the polygon stays the one node carrying the signal's id", () => {
  const { layer, ids } = mount({ signals: 1 });
  const tagged = [...layer.querySelectorAll(`[data-signal-id="${ids[0]}"]`)];
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0].tagName.toLowerCase(), "polygon");
  const key = layer.querySelector(".signal-flag-key");
  assert.equal(key.hasAttribute("data-signal-id"), false);
  assert.equal(key.getAttribute("aria-hidden"), "true");
});

test("a drag preview carries the key with the flag, in place", () => {
  const { layer, signalLayer, ids } = mount({ signals: 1 });
  const key = layer.querySelector(".signal-flag-key");
  signalLayer.setPreview(ids[0], { at: { x: 30, y: 12 }, rot: 90 });
  const p = flagKeyPoint({ x: 30, y: 12 }, 90);
  assert.equal(layer.querySelector(".signal-flag-key"), key, "the same node");
  assert.equal(
    key.getAttribute("transform"),
    `translate(${p.x * PX_PER_UNIT} ${p.y * PX_PER_UNIT})`,
    "disc and digit ride ONE translate, so they cannot come apart",
  );
});

test("the key sits on a disc in the signal's own colour", () => {
  const { doc, layer, ids } = mount({ signals: 1 });
  const key = layer.querySelector(".signal-flag-key");
  const disc = key.querySelector("circle.signal-flag-key-disc");
  assert.ok(disc, "the rail dot's disc, drawn on the flag");
  assert.equal(Number(disc.getAttribute("r")), FLAG_KEY_R * PX_PER_UNIT);
  assert.equal(
    key.style.getPropertyValue("--signal-color"),
    `var(--color-wire-${doc.getSignal(ids[0]).color})`,
  );
  assert.equal(key.querySelector(".signal-flag-key-digit").textContent, "1");
});

test("an UNPLACED flag dragged off the rail mints a key, and gives it back", () => {
  const { layer, signalLayer, ids } = mount({ signals: 1, planted: 0 });
  assert.deepEqual(keys(layer), []);
  signalLayer.setPreview(ids[0], { at: { x: 5, y: 5 } });
  assert.deepEqual(keys(layer), ["1"]);
  signalLayer.clearPreview(ids[0]);
  assert.deepEqual(keys(layer), [], "no flag, so no key");
  assert.equal(layer.querySelectorAll(".signal-flag").length, 0);
});

test("setSelected reports each CHANGE of highlighted flag, once", () => {
  const { signalLayer, ids, selected } = mount({ signals: 2 });
  signalLayer.setSelected(ids[0]);
  signalLayer.setSelected(ids[0]); // no change, no report
  signalLayer.setSelected(ids[1]);
  signalLayer.setSelected(null);
  assert.deepEqual(selected, [ids[0], ids[1], null]);
});
