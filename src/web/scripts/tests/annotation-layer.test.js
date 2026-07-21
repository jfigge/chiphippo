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

// jsdom tests for the annotation overlay (components/annotation-layer.js).

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";

const { AnnotationLayer } = await import("../components/annotation-layer.js");

function mount(doc, callbacks = {}) {
  const layer = document.createElement("div");
  layer.className = "layer-annotations";
  document.body.append(layer);
  return { layer, view: new AnnotationLayer(layer, doc, callbacks) };
}

test("renders one box per annotation, kind-classed and positioned", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addAnnotation("label", 3, 4, "U1");
  doc.addAnnotation("note", 10, 12, "clock divider");
  const { layer } = mount(doc);

  const boxes = layer.querySelectorAll(".annotation");
  assert.equal(boxes.length, 2);
  const label = layer.querySelector(".annotation--label");
  assert.equal(label.querySelector(".annotation-text").textContent, "U1");
  assert.equal(label.style.left, `${3 * PX_PER_UNIT}px`);
  assert.equal(label.style.top, `${4 * PX_PER_UNIT}px`);
  assert.ok(layer.querySelector(".annotation--note"));
});

test("an empty annotation shows a faded placeholder, not blank", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addAnnotation("note", 0, 0, "");
  const { layer } = mount(doc);
  const text = layer.querySelector(".annotation-text");
  assert.ok(text.classList.contains("annotation-text--empty"));
  assert.equal(text.textContent, "Note");
});

test("re-renders on chiphippo:doc-changed", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { layer } = mount(doc);
  assert.equal(layer.querySelectorAll(".annotation").length, 0);
  doc.addAnnotation("label", 1, 1, "new");
  window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  assert.equal(layer.querySelectorAll(".annotation").length, 1);
});

test("render(shift) nudges only the matching anchored annotation", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addAnnotation("label", 5, 5, "rides", { anchor: "c1" });
  doc.addAnnotation("label", 20, 20, "stays");
  const { layer, view } = mount(doc);

  view.render({ anchorId: "c1", dx: 2, dy: 3 });
  const boxes = layer.querySelectorAll(".annotation");
  // Anchored one shifts by (dx, dy); the free one is untouched.
  assert.equal(boxes[0].style.left, `${(5 + 2) * PX_PER_UNIT}px`);
  assert.equal(boxes[0].style.top, `${(5 + 3) * PX_PER_UNIT}px`);
  assert.equal(boxes[1].style.left, `${20 * PX_PER_UNIT}px`);
  assert.ok(boxes[0].classList.contains("annotation--anchored"));
});

test("setSelected + setPosition affect the live box", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const a = doc.addAnnotation("label", 0, 0, "x");
  const { layer, view } = mount(doc);

  view.setSelected(a.id);
  assert.ok(
    layer
      .querySelector(".annotation")
      .classList.contains("annotation--selected"),
  );
  view.setPosition(a.id, 7, 8);
  const box = layer.querySelector(".annotation");
  assert.equal(box.style.left, `${7 * PX_PER_UNIT}px`);
  assert.equal(box.style.top, `${8 * PX_PER_UNIT}px`);
  view.setSelected(null);
  assert.ok(!box.classList.contains("annotation--selected"));
});

test("dblclick opens an inline editor; Enter commits via onEditCommit", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const a = doc.addAnnotation("label", 0, 0, "old");
  const commits = [];
  const { layer, view } = mount(doc, {
    onEditCommit: (id, text) => {
      commits.push([id, text]);
      doc.updateAnnotation(id, { text }); // mimic the controller's commit
      window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
    },
  });

  layer
    .querySelector(".annotation")
    .dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  const editor = layer.querySelector(".annotation-editor");
  assert.ok(editor, "editor swapped in");
  assert.equal(view.editing, true);

  editor.value = "renamed";
  editor.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  assert.deepEqual(commits, [[a.id, "renamed"]]);
  assert.equal(view.editing, false);
  // Re-rendered from the (updated) document.
  assert.equal(layer.querySelector(".annotation-text").textContent, "renamed");
});

test("Escape cancels the editor without committing", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addAnnotation("label", 0, 0, "keep");
  let committed = false;
  const { layer, view } = mount(doc, {
    onEditCommit: () => {
      committed = true;
    },
  });

  layer
    .querySelector(".annotation")
    .dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  const editor = layer.querySelector(".annotation-editor");
  editor.value = "discarded";
  editor.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.equal(committed, false);
  assert.equal(view.editing, false);
  assert.equal(layer.querySelector(".annotation-text").textContent, "keep");
});
