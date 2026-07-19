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

// discrete-view.js — the seated discrete parts (.layer-parts): slide switch
// with a visible slider position, push button whose cap depresses while
// held, and LED dome with a flat-side cathode cue. One SVG per part, rebuilt
// only when params change (never on camera moves); NO electrical logic here.
//
// The button cap is interactive VIEW state (momentary — nothing durable):
// the view owns the press gesture (capture on the cap, stopPropagation so
// the controller never starts a drag from it) and announces
// `chiphippo:part-state` for later stages. Slide toggling needs a document
// write, so the CONTROLLER owns it (plain click on the part).
//
// Local SVG coordinates are pitch units with the ORIGIN AT PIN 1's hole.

import { el } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { holePosition } from "../model/breadboard.js";
import { partDef } from "../catalog/index.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  return node;
}

/** Per-ref body boxes (pitch units, origin at pin 1's hole). */
const BOXES = Object.freeze({
  "sw-slide": Object.freeze({
    minX: -0.7,
    minY: -1.1,
    width: 3.4,
    height: 2.2,
  }),
  "sw-push": Object.freeze({ minX: -0.7, minY: -1.4, width: 3.4, height: 2.8 }),
  led: Object.freeze({ minX: -0.7, minY: -1.9, width: 2.4, height: 2.9 }),
  resistor: Object.freeze({ minX: -0.7, minY: -1.1, width: 4.4, height: 2.2 }),
});

/** Footprint box for a discrete ref (positioning + ghost sizing). */
export function discreteBox(ref) {
  const box = BOXES[ref];
  if (!box) {
    const err = new Error(`unknown discrete ref: ${ref}`);
    err.code = "INVALID_REF";
    throw err;
  }
  return box;
}

/**
 * Build a discrete part's SVG from its catalog def + params. Pure DOM
 * construction (unit-testable under jsdom).
 */
export function buildDiscreteSvg(ref, params = {}) {
  const def = partDef(ref);
  const box = discreteBox(ref);
  const normalized = def.normalizeParams(params);

  const svg = svgEl("svg", {
    class: `part-discrete-svg part-discrete-svg--${ref}`,
    viewBox: `${box.minX} ${box.minY} ${box.width} ${box.height}`,
    width: box.width * PX_PER_UNIT,
    height: box.height * PX_PER_UNIT,
    "aria-hidden": "true",
  });

  if (ref === "sw-slide") {
    // Body over the three holes, slot, and the knob at position 1 or 2.
    svg.append(
      svgEl("rect", {
        class: "part-body",
        x: -0.6,
        y: -1,
        width: 3.2,
        height: 2,
        rx: 0.2,
      }),
      svgEl("rect", {
        class: "part-slide-slot",
        x: -0.25,
        y: -0.35,
        width: 2.5,
        height: 0.7,
        rx: 0.15,
      }),
      svgEl("rect", {
        class: "part-slide-knob",
        x: normalized.pos === "2" ? 1.15 : -0.15,
        y: -0.45,
        width: 1,
        height: 0.9,
        rx: 0.15,
      }),
    );
  } else if (ref === "sw-push") {
    // Square tactile body spanning the two holes (0 and +2), round cap.
    svg.append(
      svgEl("rect", {
        class: "part-body",
        x: -0.6,
        y: -1.3,
        width: 3.2,
        height: 2.6,
        rx: 0.25,
      }),
      svgEl("circle", {
        class: "part-button-cap",
        cx: 1,
        cy: 0,
        r: 0.85,
      }),
    );
  } else if (ref === "resistor") {
    // Axial resistor: a lead to each end hole (0 and +3) with a banded body
    // between them. Purely cosmetic — value/orientation don't affect the sim.
    svg.append(
      svgEl("rect", {
        class: "part-resistor-lead",
        x: 0,
        y: -0.06,
        width: 0.6,
        height: 0.12,
      }),
      svgEl("rect", {
        class: "part-resistor-lead",
        x: 2.4,
        y: -0.06,
        width: 0.6,
        height: 0.12,
      }),
      svgEl("rect", {
        class: "part-resistor-body",
        x: 0.5,
        y: -0.5,
        width: 2,
        height: 1,
        rx: 0.4,
      }),
      ...[0.85, 1.25, 1.65].map((x) =>
        svgEl("rect", {
          class: "part-resistor-band",
          x,
          y: -0.45,
          width: 0.14,
          height: 0.9,
        }),
      ),
    );
  } else {
    // LED dome over the two holes; the flat chord marks the CATHODE side
    // (right by default — pin 2; params.flip mirrors it to the left).
    const cathodeRight = !normalized.flip;
    const flatX = cathodeRight ? 1.15 : -0.15;
    svg.append(
      svgEl("rect", {
        class: "part-led-leg",
        x: -0.12,
        y: -0.7,
        width: 0.24,
        height: 0.85,
      }),
      svgEl("rect", {
        class: "part-led-leg",
        x: 0.88,
        y: -0.7,
        width: 0.24,
        height: 0.85,
      }),
      svgEl("circle", {
        class: `part-led-dome part-led-dome--${normalized.color}`,
        cx: 0.5,
        cy: -1,
        r: 0.85,
      }),
      svgEl("rect", {
        class: "part-led-flat",
        x: flatX,
        y: -1.75,
        width: 0.14,
        height: 1.5,
      }),
    );
  }
  return svg;
}

export class DiscreteView {
  #el;
  #id;
  #ref;

  /**
   * @param {HTMLElement} layer - the `.layer-parts` element.
   * @param {{id:string,ref:string,params:object}} component
   * @param {object} [callbacks]
   * @param {(id: string, e: PointerEvent) => void} [callbacks.onPointerDown]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onContextMenu]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onDoubleClick] -
   *   opens the pin-assignments window (Feature 100 wiring aid).
   */
  constructor(
    layer,
    component,
    { onPointerDown, onContextMenu, onDoubleClick } = {},
  ) {
    this.#id = component.id;
    this.#ref = component.ref;
    this.#el = el("div", {
      class: `part part-discrete part-discrete--${component.ref}`,
      dataset: { componentId: component.id },
    });
    this.updateParams(component.params);
    this.#el.addEventListener("pointerdown", (e) =>
      onPointerDown?.(this.#id, e),
    );
    this.#el.addEventListener("contextmenu", (e) =>
      onContextMenu?.(this.#id, e),
    );
    this.#el.addEventListener("dblclick", (e) => onDoubleClick?.(this.#id, e));
    layer.append(this.#el);
  }

  get id() {
    return this.#id;
  }

  get ref() {
    return this.#ref;
  }

  get element() {
    return this.#el;
  }

  /** Rebuild the SVG for new params (slider position, LED color/flip). */
  updateParams(params) {
    this.#el.querySelector("svg")?.remove();
    this.#el.prepend(buildDiscreteSvg(this.#ref, params));
    if (this.#ref === "sw-push") this.#bindCap();
  }

  /** The momentary press gesture lives here — transient view state only. */
  #bindCap() {
    const cap = this.#el.querySelector(".part-button-cap");
    const setPressed = (on) => {
      this.#el.classList.toggle("part-discrete--pressed", on);
      window.dispatchEvent(
        new CustomEvent("chiphippo:part-state", {
          detail: { id: this.#id, ref: this.#ref, state: { pressed: on } },
        }),
      );
    };
    cap.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation(); // never starts a select/drag
      try {
        cap.setPointerCapture(e.pointerId);
      } catch {
        /* best-effort */
      }
      setPressed(true);
      const release = () => setPressed(false);
      cap.addEventListener("pointerup", release, { once: true });
      cap.addEventListener("pointercancel", release, { once: true });
    });
  }

  /** Seat the element: board origin + anchor hole + the footprint box. */
  updatePlacement(board, anchor) {
    const pos = holePosition(board.type, anchor);
    if (!pos) return;
    const box = discreteBox(this.#ref);
    this.#el.style.left = `${(board.x + pos.x + box.minX) * PX_PER_UNIT}px`;
    this.#el.style.top = `${(board.y + pos.y + box.minY) * PX_PER_UNIT}px`;
  }

  /** Light an LED (Feature 90): bright body + glow while its diode conducts. */
  setLit(on) {
    this.#el.classList.toggle("part-discrete--lit", on);
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
