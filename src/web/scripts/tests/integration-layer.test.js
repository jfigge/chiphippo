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
// jsdom tests for components/integration-layer.js — the planted tags of the
// Output and Input elements. What is pinned here is what NAMES a tag (colours
// repeat): the label it prints and the tooltip it carries; that the polygon is
// the one hit target carrying the tag's id; and that a live drag moves ONE
// polygon in place rather than rebuilding the layer under the press.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { IntegrationLayer, tagPlateWidth, tagPointsAt, tagLabel, tagTitle } =
  await import("../components/integration-layer.js");
const { TAG_KEY_R, TAG_W, tagLabelPoint } =
  await import("../model/integration.js");
const { PX_PER_UNIT } = await import("../desk/desk-geometry.js");
const { DeskDoc } = await import("../model/desk-doc.js");
const { worldOfAddress } = await import("../model/occupancy.js");

function mount() {
  const win = resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const out = doc.addIntegration({ kind: "output", width: 2, name: "Lamps" });
  const inp = doc.addIntegration({ kind: "input", width: 8, name: "Keys" });
  doc.plantIntegrationTag(out.id, "1", "bb1.a5");
  doc.plantIntegrationTag(out.id, "T", "bb1.a9", 90);
  doc.plantIntegrationTag(inp.id, "4", "bb1.a20");
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const selected = [];
  const presses = [];
  const menus = [];
  const layer = new IntegrationLayer(host, doc, {
    onSelect: (id) => selected.push(id),
    onPointerDown: (id, key) => presses.push(`${id}:${key}`),
    onContextMenu: (id, key) => menus.push(`${id}:${key}`),
  });
  return { win, doc, host, layer, out, inp, selected, presses, menus };
}

const polys = (host) => [...host.querySelectorAll("polygon.integration-tag")];
const poly = (host, id) => host.querySelector(`polygon[data-tag-id="${id}"]`);
const changed = (win) =>
  win.dispatchEvent(new win.CustomEvent("chiphippo:doc-changed"));

test("one polygon per planted tag, each carrying its tag id", () => {
  const { host, out, inp } = mount();
  assert.deepEqual(
    polys(host).map((p) => p.dataset.tagId),
    [`${out.id}:1`, `${out.id}:T`, `${inp.id}:4`],
  );
});

test("the polygon's point sits in its anchor hole, at the stored rotation", () => {
  const { doc, host, out } = mount();
  const at = worldOfAddress(doc.boards, "bb1.a9");
  assert.equal(
    poly(host, `${out.id}:T`).getAttribute("points"),
    tagPointsAt(at, 90),
  );
  assert.notEqual(tagPointsAt(at, 90), tagPointsAt(at, 0));
});

test("trigger and input tags are told apart by class", () => {
  const { host, out, inp } = mount();
  assert.ok(
    poly(host, `${out.id}:T`).classList.contains("integration-tag--trigger"),
  );
  assert.ok(
    !poly(host, `${out.id}:1`).classList.contains("integration-tag--input"),
  );
  assert.ok(
    poly(host, `${inp.id}:4`).classList.contains("integration-tag--input"),
  );
});

test("each tag prints its pin number, or the trigger's edge glyph", () => {
  const { win, doc, host, out } = mount();
  const labels = () =>
    [...host.querySelectorAll(".integration-tag-label")].map(
      (n) => n.textContent,
    );
  assert.deepEqual(labels(), ["1", "↑", "4"]);
  doc.updateIntegration(out.id, { triggerEdge: "falling" });
  changed(win);
  assert.deepEqual(labels(), ["1", "↓", "4"]);
  doc.updateIntegration(out.id, { triggerEdge: "either" });
  changed(win);
  assert.deepEqual(labels(), ["1", "↕", "4"]);
});

test("each label sits on a plate in its element's colour, at the body's middle", () => {
  const { doc, host, out } = mount();
  // Tags render in document order, so the first label is out1's pin 1 (a5).
  const label = host.querySelector(".integration-tag-label");
  const plate = label.querySelector("rect.integration-tag-plate");
  assert.ok(plate, "a plate behind the number");
  assert.ok(label.querySelector("text.integration-tag-number"));
  assert.equal(
    label.style.getPropertyValue("--signal-color"),
    `var(--color-wire-${doc.getIntegration(out.id).color})`,
  );
  // ONE translate places plate and number together, upright at any rotation.
  const p = tagLabelPoint(worldOfAddress(doc.boards, "bb1.a5"), 0);
  assert.equal(
    label.getAttribute("transform"),
    `translate(${p.x * PX_PER_UNIT} ${p.y * PX_PER_UNIT})`,
  );
  // Centred on that origin, as tall as the disc.
  const r = TAG_KEY_R * PX_PER_UNIT;
  assert.equal(Number(plate.getAttribute("height")), 2 * r);
  assert.equal(Number(plate.getAttribute("y")), -r);
  assert.equal(
    Number(plate.getAttribute("x")),
    -Number(plate.getAttribute("width")) / 2,
  );
});

test("a one-character label gets a disc; a two-digit pin stretches it into a pill", () => {
  assert.equal(tagPlateWidth("7"), 2 * TAG_KEY_R, "a disc");
  assert.equal(tagPlateWidth("↕"), 2 * TAG_KEY_R);
  assert.ok(tagPlateWidth("16") > 2 * TAG_KEY_R, "wide enough for two digits");
  assert.ok(2 * TAG_KEY_R < TAG_W, "the disc leaves body showing either side");
});

test("the tooltip names the element, the pin, and which bit of which field it is", () => {
  const { host, out, inp } = mount();
  const title = (id) => poly(host, id).querySelector("title").textContent;
  assert.equal(title(`${out.id}:1`), "Lamps · pin 1 bit0");
  assert.equal(title(`${out.id}:T`), "Lamps · trigger (Rising)");
  assert.equal(title(`${inp.id}:4`), "Keys · pin 4 value[3]");
});

test("the pure helpers: tagLabel and tagTitle fall back sensibly", () => {
  assert.equal(tagLabel({ triggerEdge: "falling" }, "T"), "↓");
  assert.equal(tagLabel({}, "T"), "↑", "no edge reads as rising");
  assert.equal(tagLabel({}, "12"), "12");
  resetDom();
  // No name → the id; a pin past the last field has no role to name.
  assert.equal(
    tagTitle({ id: "out3", fields: [{ type: "bit", name: "a" }] }, "5"),
    "out3 · pin 5 ",
  );
});

test("a press and a right-click report the element and the key", () => {
  const { win, host, inp, presses, menus } = mount();
  const p = poly(host, `${inp.id}:4`);
  p.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true }));
  p.dispatchEvent(new win.MouseEvent("contextmenu", { bubbles: true }));
  assert.deepEqual(presses, [`${inp.id}:4`]);
  assert.deepEqual(menus, [`${inp.id}:4`]);
});

test("setPreview moves an existing tag IN PLACE and marks it illegal on request", () => {
  const { doc, host, layer, out } = mount();
  const id = `${out.id}:1`;
  const before = poly(host, id);
  const at = worldOfAddress(doc.boards, "bb1.a30");
  layer.setPreview(out.id, "1", { at, rot: 180, illegal: true });
  assert.equal(poly(host, id), before, "the very same node");
  assert.equal(before.getAttribute("points"), tagPointsAt(at, 180));
  assert.ok(before.classList.contains("integration-tag--illegal"));

  layer.clearPreview(out.id, "1");
  assert.equal(poly(host, id), before);
  assert.equal(
    before.getAttribute("points"),
    tagPointsAt(worldOfAddress(doc.boards, "bb1.a5"), 0),
    "back where the document has it",
  );
  assert.ok(!before.classList.contains("integration-tag--illegal"));
});

test("a tag dragged off its card is MINTED by the preview and disposed of by clearPreview", () => {
  const { doc, host, layer, out } = mount();
  const id = `${out.id}:2`;
  assert.equal(poly(host, id), null);
  layer.setPreview(out.id, "2", { at: worldOfAddress(doc.boards, "bb1.a40") });
  assert.ok(poly(host, id), "a polygon appears for the drag");
  assert.equal(host.querySelectorAll(".integration-tag-label").length, 4);
  layer.clearPreview(out.id, "2");
  assert.equal(
    poly(host, id),
    null,
    "an unplanted tag has nothing to go back to",
  );
  assert.equal(host.querySelectorAll(".integration-tag-label").length, 3);
});

test("setSelected is a class toggle that reports the ELEMENT, and survives a rebuild", () => {
  const { win, host, layer, out, inp, selected } = mount();
  const lit = () =>
    polys(host)
      .filter((p) => p.classList.contains("integration-tag--selected"))
      .map((p) => p.dataset.tagId);
  const before = poly(host, `${inp.id}:4`);
  layer.setSelected(`${inp.id}:4`);
  assert.deepEqual(lit(), [`${inp.id}:4`]);
  assert.equal(poly(host, `${inp.id}:4`), before, "no re-render");
  layer.setSelected(`${inp.id}:4`); // same again: not news
  layer.setSelected(`${out.id}:T`);
  layer.setSelected(null);
  assert.deepEqual(selected, [inp.id, out.id, null]);

  layer.setSelected(`${out.id}:1`);
  changed(win);
  assert.deepEqual(lit(), [`${out.id}:1`]);
  assert.equal(layer.selected, `${out.id}:1`);
});

test("a tag whose board has gone is not drawn", () => {
  const { win, doc, host } = mount();
  doc.removeBoard("bb1");
  changed(win);
  assert.equal(polys(host).length, 0);
});
