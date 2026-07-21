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

// annotation-layer.js — labels & notes on the desk (Feature 120), rendered in
// the dedicated `.layer-annotations` between the wires and the interaction
// overlay (above wires, below ghosts). One renderer rebuilds only on doc
// change or an annotation drag — never on pan/zoom (transform-only, the same
// discipline as WireLayer). Each annotation is one absolutely-positioned DOM
// box in world px; empty space between them is the zero-size layer anchor, so
// the bare desk still falls through to the viewport.
//
// Pure decoration: annotations are ignored by occupancy, the netlist, and the
// engine. Position (x/y, world pitch units) is absolute; an `anchor` (a
// component id) makes it ride that part's drag via render()'s `shift`.

import { clear, el } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";

export class AnnotationLayer {
  #layer;
  #doc;
  #onPointerDown;
  #onContextMenu;
  #onEditCommit;
  #els = new Map(); // annotationId → element
  #selectedId = null;
  #editing = null; // annotationId while an inline editor is open

  /**
   * @param {HTMLElement} layer - the `.layer-annotations` element.
   * @param {import('../model/desk-doc.js').DeskDoc} deskDoc
   * @param {object} [callbacks]
   * @param {(id: string, e: PointerEvent) => void} [callbacks.onPointerDown]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onContextMenu]
   * @param {(id: string, text: string) => void} [callbacks.onEditCommit]
   */
  constructor(
    layer,
    deskDoc,
    { onPointerDown, onContextMenu, onEditCommit } = {},
  ) {
    this.#layer = layer;
    this.#doc = deskDoc;
    this.#onPointerDown = onPointerDown;
    this.#onContextMenu = onContextMenu;
    this.#onEditCommit = onEditCommit;

    window.addEventListener("chiphippo:doc-changed", () => this.render());
    this.render();
  }

  /**
   * Rebuild every annotation from the document. `shift` (an anchored-drag
   * override) nudges only the annotations whose `anchor` matches by (dx, dy)
   * world pitch units, so a label rides its chip live. Skipped while an inline
   * editor is open, so a mid-edit doc-changed can't tear the editor down.
   * @param {{anchorId: string, dx: number, dy: number}|null} [shift]
   */
  render(shift = null) {
    if (this.#editing) return;
    clear(this.#layer);
    this.#els.clear();
    for (const ann of this.#doc.annotations) {
      const box = this.#build(ann, shift);
      this.#layer.append(box);
      this.#els.set(ann.id, box);
    }
  }

  #build(ann, shift) {
    let x = ann.x;
    let y = ann.y;
    if (shift && ann.anchor === shift.anchorId) {
      x += shift.dx;
      y += shift.dy;
    }
    const box = el("div", {
      class: `annotation annotation--${ann.kind}`,
      dataset: { annId: ann.id },
    });
    if (ann.anchor) box.classList.add("annotation--anchored");
    if (ann.color) box.style.setProperty("--annotation-color", ann.color);
    box.style.left = `${x * PX_PER_UNIT}px`;
    box.style.top = `${y * PX_PER_UNIT}px`;
    box.classList.toggle("annotation--selected", ann.id === this.#selectedId);

    const text = el("div", { class: "annotation-text" });
    if (ann.text) {
      text.textContent = ann.text;
    } else {
      text.classList.add("annotation-text--empty");
      text.textContent = ann.kind === "note" ? "Note" : "Label";
    }
    box.append(text);

    box.addEventListener("pointerdown", (e) =>
      this.#onPointerDown?.(ann.id, e),
    );
    box.addEventListener("contextmenu", (e) =>
      this.#onContextMenu?.(ann.id, e),
    );
    box.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.beginEdit(ann.id);
    });
    return box;
  }

  /** Highlight one annotation (null clears). Survives re-renders. */
  setSelected(id) {
    this.#selectedId = id;
    for (const [annId, box] of this.#els) {
      box.classList.toggle("annotation--selected", annId === id);
    }
  }

  /** Live-reposition one annotation's box (world pitch units) during a drag. */
  setPosition(id, x, y) {
    const box = this.#els.get(id);
    if (!box) return;
    box.style.left = `${x * PX_PER_UNIT}px`;
    box.style.top = `${y * PX_PER_UNIT}px`;
  }

  /** True while an inline editor is open (input/textarea has focus). */
  get editing() {
    return this.#editing !== null;
  }

  /**
   * Replace an annotation's text with an inline editor (a one-line input for a
   * label, a textarea for a note). Enter or blur commits; Escape cancels.
   * Commit routes through `onEditCommit` so the document is the source of truth
   * and the re-render redraws from it.
   */
  beginEdit(id) {
    if (this.#editing) return;
    const ann = this.#doc.getAnnotation(id);
    const box = this.#els.get(id);
    if (!ann || !box) return;
    this.#editing = id;
    this.#selectedId = id;

    const editor = el(ann.kind === "note" ? "textarea" : "input", {
      class: "annotation-editor",
      value: ann.text ?? "",
    });
    clear(box);
    box.classList.add("annotation--editing");
    box.append(editor);
    editor.focus();
    editor.select?.();

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const text = editor.value;
      this.#editing = null;
      box.classList.remove("annotation--editing");
      if (commit) {
        this.#onEditCommit?.(id, text); // emits doc-changed → full re-render
      } else {
        this.render(); // cancel: redraw from the document as it stood
      }
    };
    editor.addEventListener("blur", () => finish(true));
    editor.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      } else if (e.key === "Enter" && (ann.kind !== "note" || e.metaKey)) {
        // Enter commits a label; a note keeps Enter for newlines (⌘Enter ends).
        e.preventDefault();
        finish(true);
      }
    });
  }
}
