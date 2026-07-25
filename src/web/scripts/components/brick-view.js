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

// brick-view.js — the shared skeleton every desk-level BRICK view (PSU, clock,
// LCD — anything with `board == null`, an `{x,y}` desk position instead of a
// board anchor) was hand-copying: the `.part` wrapper + pointer/context-menu
// wiring, desk-position placement, and the selected/dragging/illegal/remove
// lifecycle every DeskController drag gesture drives. A subclass supplies only
// its own `partClass` (e.g. "part-psu") and `updateParams(params)` (rebuild
// its own SVG) — everything else here is identical across bricks.
//
// Subclasses call `super(layer, brick, partClass, callbacks)` FIRST, then
// their own `this.updateParams(brick.params)` — never the other way around,
// since a subclass's own fields (e.g. LcdView's canvas) aren't initialized
// until `super()` returns, and `updateParams` may need them.

import { el } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";

export class BrickView {
  #el;
  #id;

  /**
   * @param {HTMLElement} layer - the `.layer-parts` element.
   * @param {{id:string,x:number,y:number}} brick
   * @param {string} partClass - the brick-specific class (e.g. "part-psu"),
   *   applied alongside the shared "part" class.
   * @param {object} [callbacks]
   * @param {(id: string, e: PointerEvent) => void} [callbacks.onPointerDown]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onContextMenu]
   */
  constructor(layer, brick, partClass, { onPointerDown, onContextMenu } = {}) {
    this.#id = brick.id;
    this.#el = el("div", {
      class: `part ${partClass}`,
      dataset: { componentId: brick.id },
    });
    this.setPosition(brick.x, brick.y);
    this.#el.addEventListener("pointerdown", (e) =>
      onPointerDown?.(this.#id, e),
    );
    this.#el.addEventListener("contextmenu", (e) =>
      onContextMenu?.(this.#id, e),
    );
    layer.append(this.#el);
  }

  get id() {
    return this.#id;
  }

  get element() {
    return this.#el;
  }

  /** Desk origin in pitch units → world px. */
  setPosition(x, y) {
    this.#el.style.left = `${x * PX_PER_UNIT}px`;
    this.#el.style.top = `${y * PX_PER_UNIT}px`;
  }

  setSelected(on) {
    this.#el.classList.toggle("part--selected", on);
  }

  setDragging(on) {
    this.#el.classList.toggle("part--dragging", on);
  }

  setIllegal(on) {
    this.#el.classList.toggle("part--illegal", on);
  }

  remove() {
    this.#el.remove();
  }
}
