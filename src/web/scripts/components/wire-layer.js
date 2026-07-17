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

// wire-layer.js — every jumper wire, drawn in ONE <svg> filling .layer-wires
// (above parts, below the overlay). Each wire is a sagging bezier: a darker
// outline stroke under a colored core stroke, endpoint caps over the holes,
// and — the ONE sanctioned exception to "no per-item DOM events" — a widened
// invisible hit stroke with `pointer-events: stroke` for click-select and the
// context menu (idiomatic SVG beats hand-rolled curve-distance math).
//
// Endpoints are ADDRESSES resolved through board origins at render time, so
// cross-board wires are first-class: wires re-render only when the wire list
// changes (chiphippo:doc-changed) or an endpoint's board moves (the
// controller passes live drag positions via `overrides`) — never on pan/zoom.

import { clear } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { wirePath } from "../desk/wire-path.js";
import { holePosition, parseAddress } from "../model/breadboard.js";
import { partDef } from "../catalog/index.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Endpoint cap radius (world px — scales with the camera); stroke widths
    live in app.css on the .wire-* classes. */
const CAP_RADIUS = 2.4;

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  return node;
}

export class WireLayer {
  #svg;
  #doc;
  #onSelect;
  #onContextMenu;
  #onHover;
  #selectedId = null;
  #preview = null; // preview path elements while the wire tool is pending

  /**
   * @param {HTMLElement} layer - the `.layer-wires` element.
   * @param {import('../model/desk-doc.js').DeskDoc} deskDoc
   * @param {object} [callbacks]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onSelect]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onContextMenu]
   * @param {(id: string|null) => void} [callbacks.onHover] - pointer enter
   *   (wire id) / leave (null) over a wire (for the Feature 70 probe).
   */
  constructor(layer, deskDoc, { onSelect, onContextMenu, onHover } = {}) {
    this.#doc = deskDoc;
    this.#onSelect = onSelect;
    this.#onContextMenu = onContextMenu;
    this.#onHover = onHover;
    // NOTE: width/height 0 would DISABLE svg rendering per the SVG spec (and
    // percentages resolve against the zero-size layer anchor) — so give the
    // element a token 1×1 box and let CSS overflow:visible paint the wires.
    this.#svg = svgEl("svg", { class: "wire-svg", width: 1, height: 1 });
    layer.append(this.#svg);

    // The wire list lives in the document; re-render on every announced
    // change (add/remove/recolor, board moves committed, cascades).
    window.addEventListener("chiphippo:doc-changed", () => this.render());
    this.render();
  }

  get element() {
    return this.#svg;
  }

  /**
   * World-px position of a wire endpoint — a board hole (bb1.a5) or a PSU
   * terminal (psu1.+) — honoring live drag `overrides` (ownerId → {x, y})
   * before the document's own coordinates.
   */
  #endpointWorld(address, overrides) {
    const parsed = parseAddress(address);
    if (!parsed) return null;
    const board = this.#doc.getBoard(parsed.boardId);
    if (board) {
      const pos = holePosition(board.type, parsed.hole);
      if (!pos) return null;
      const origin = overrides?.get(parsed.boardId) ?? board;
      return {
        x: (origin.x + pos.x) * PX_PER_UNIT,
        y: (origin.y + pos.y) * PX_PER_UNIT,
      };
    }
    const comp = this.#doc.getComponent(parsed.boardId);
    const terminal = partDef(comp?.ref)?.terminals?.find(
      (t) => t.id === parsed.hole,
    );
    if (!terminal) return null;
    const origin = overrides?.get(parsed.boardId) ?? comp;
    return {
      x: (origin.x + terminal.dx) * PX_PER_UNIT,
      y: (origin.y + terminal.dy) * PX_PER_UNIT,
    };
  }

  /**
   * Rebuild every wire from the document (documents are small; a full
   * rebuild is simple and correct). `overrides` supplies in-flight board
   * positions during a drag so wires stay glued to their holes live.
   * @param {Map<string, {x:number,y:number}>} [overrides]
   */
  render(overrides) {
    const preview = this.#preview; // survives rebuilds (appended last)
    clear(this.#svg);
    for (const wire of this.#doc.wires) {
      const a = this.#endpointWorld(wire.from, overrides);
      const b = this.#endpointWorld(wire.to, overrides);
      if (!a || !b) continue; // defensive: normalize prevents danglers
      const d = wirePath(a, b);

      const group = svgEl("g", { class: "wire" });
      group.dataset.wireId = wire.id;
      group.style.setProperty(
        "--wire-color",
        `var(--color-wire-${wire.color})`,
      );
      group.append(
        svgEl("path", { class: "wire-hit", d }),
        svgEl("path", { class: "wire-outline", d }),
        svgEl("path", { class: "wire-core", d }),
        svgEl("circle", { class: "wire-cap", cx: a.x, cy: a.y, r: CAP_RADIUS }),
        svgEl("circle", { class: "wire-cap", cx: b.x, cy: b.y, r: CAP_RADIUS }),
      );
      group.classList.toggle("wire--selected", wire.id === this.#selectedId);
      group.addEventListener("click", (e) => this.#onSelect?.(wire.id, e));
      group.addEventListener("contextmenu", (e) =>
        this.#onContextMenu?.(wire.id, e),
      );
      group.addEventListener("pointerenter", () => this.#onHover?.(wire.id));
      group.addEventListener("pointerleave", () => this.#onHover?.(null));
      this.#svg.append(group);
    }
    if (preview) this.#svg.append(preview);
  }

  /** Highlight one wire (null clears). Survives re-renders. */
  setSelected(id) {
    this.#selectedId = id;
    for (const group of this.#svg.querySelectorAll(".wire")) {
      group.classList.toggle(
        "wire--selected",
        group.dataset.wireId === id && id !== null,
      );
    }
  }

  /**
   * The wire tool's rubber-band: from the anchored hole to the cursor (both
   * world px). Pass null to hide. `legal` tints the band when the cursor
   * sits over a committable hole vs an occupied one.
   */
  setPreview(spec) {
    if (!spec) {
      this.#preview?.remove();
      this.#preview = null;
      return;
    }
    if (!this.#preview) {
      this.#preview = svgEl("g", { class: "wire wire-preview" });
      this.#preview.append(
        svgEl("path", { class: "wire-outline" }),
        svgEl("path", { class: "wire-core" }),
      );
      this.#svg.append(this.#preview);
    }
    const d = wirePath(spec.from, spec.to);
    this.#preview.style.setProperty(
      "--wire-color",
      `var(--color-wire-${spec.color})`,
    );
    this.#preview.classList.toggle("wire-preview--illegal", !spec.legal);
    for (const path of this.#preview.querySelectorAll("path")) {
      path.setAttribute("d", d);
    }
  }
}
