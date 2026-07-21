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
import { wirePath, wireSag } from "../desk/wire-path.js";
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

/** The average of a non-empty list of world-px points. */
function centroid(points) {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), {
    x: 0,
    y: 0,
  });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

export class WireLayer {
  #svg;
  #doc;
  #onSelect;
  #onContextMenu;
  #onHover;
  #onSelectBus;
  #onBusContextMenu;
  #selectedIds = new Set(); // highlighted wires (one pick, or a marquee)
  #selectedBusIds = new Set(); // highlighted bus bands
  #preview = null; // preview path elements while the wire tool is pending
  #busPreview = null; // preview band while the bus tool is pending
  #endpointDrag = null; // { wireId, end, world:{x,y} px, legal } while dragging an end
  #wholeDrag = null; // { wireId, from:{x,y} px, to:{x,y} px, legal } dragging a whole wire
  #busDrag = null; // { busId, memberIds:Set, dx, dy (px), legal } dragging a whole bus

  /**
   * @param {HTMLElement} layer - the `.layer-wires` element.
   * @param {import('../model/desk-doc.js').DeskDoc} deskDoc
   * @param {object} [callbacks]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onSelect]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onContextMenu]
   * @param {(id: string|null) => void} [callbacks.onHover] - pointer enter
   *   (wire id) / leave (null) over a wire (for the Feature 70 probe).
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onSelectBus] -
   *   click on a bundle band (Feature 130).
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onBusContextMenu]
   */
  constructor(
    layer,
    deskDoc,
    { onSelect, onContextMenu, onHover, onSelectBus, onBusContextMenu } = {},
  ) {
    this.#doc = deskDoc;
    this.#onSelect = onSelect;
    this.#onContextMenu = onContextMenu;
    this.#onHover = onHover;
    this.#onSelectBus = onSelectBus;
    this.#onBusContextMenu = onBusContextMenu;
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
      const pos = holePosition(board.type, parsed.hole, board.rot ?? 0);
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
    const busPreview = this.#busPreview;
    const drag = this.#endpointDrag;
    const whole = this.#wholeDrag;
    const busDrag = this.#busDrag;
    clear(this.#svg);

    // Snapshot the doc arrays ONCE — the getters copy on every access.
    const wires = this.#doc.wires;
    const buses = this.#doc.buses;
    const wiresById = new Map(wires.map((w) => [w.id, w]));

    // Bundle bands render FIRST (below the member wires): a click on a wire
    // still selects the wire, while the band catches clicks in the gaps.
    for (const bus of buses) {
      const band = this.#buildBand(bus, overrides, busDrag, wiresById);
      if (band) this.#svg.append(band);
    }

    for (const wire of wires) {
      let a = this.#endpointWorld(wire.from, overrides);
      let b = this.#endpointWorld(wire.to, overrides);
      // A dragged endpoint follows the cursor (world px) instead of its hole;
      // a whole-wire drag overrides BOTH ends (rigid translation); a whole-bus
      // drag rigidly offsets every member wire.
      const draggingEnd = drag && drag.wireId === wire.id;
      const draggingWhole = whole && whole.wireId === wire.id;
      const draggingBus = busDrag && busDrag.memberIds.has(wire.id);
      if (draggingEnd) {
        if (drag.end === "from") a = drag.world;
        else b = drag.world;
      } else if (draggingWhole) {
        a = whole.from;
        b = whole.to;
      } else if (draggingBus) {
        if (a) a = { x: a.x + busDrag.dx, y: a.y + busDrag.dy };
        if (b) b = { x: b.x + busDrag.dx, y: b.y + busDrag.dy };
      }
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
      // While dragging (one end or the whole wire), mute the hit stroke
      // (pointer is captured) and tint the wire red over an illegal drop,
      // mirroring the rubber band.
      if (draggingEnd || draggingWhole || draggingBus) {
        group.classList.add("wire--dragging");
        const legal = draggingEnd
          ? drag.legal
          : draggingWhole
            ? whole.legal
            : busDrag.legal;
        group.classList.toggle("wire-preview--illegal", legal === false);
      }
      group.classList.toggle("wire--selected", this.#selectedIds.has(wire.id));
      group.addEventListener("click", (e) => this.#onSelect?.(wire.id, e));
      group.addEventListener("contextmenu", (e) =>
        this.#onContextMenu?.(wire.id, e),
      );
      group.addEventListener("pointerenter", () => this.#onHover?.(wire.id));
      group.addEventListener("pointerleave", () => this.#onHover?.(null));
      this.#svg.append(group);
    }
    if (busPreview) this.#svg.append(busPreview);
    if (preview) this.#svg.append(preview);
  }

  /**
   * Build one bus's bundle band: a translucent fat curve traced along the
   * corridor its member wires share (the centroid of their `from`s to the
   * centroid of their `to`s), carrying the bus name at its midpoint. Null for
   * a bus whose members don't currently resolve (all danglers). `busDrag`
   * rigidly offsets the band when the whole bus is being dragged.
   */
  #buildBand(bus, overrides, busDrag, wiresById) {
    if (bus.members.length === 0) return null;
    const off = busDrag && busDrag.busId === bus.id ? busDrag : null;
    const froms = [];
    const tos = [];
    for (const wid of bus.members) {
      const wire = wiresById.get(wid);
      if (!wire) continue;
      let a = this.#endpointWorld(wire.from, overrides);
      let b = this.#endpointWorld(wire.to, overrides);
      if (!a || !b) continue;
      if (off) {
        a = { x: a.x + off.dx, y: a.y + off.dy };
        b = { x: b.x + off.dx, y: b.y + off.dy };
      }
      froms.push(a);
      tos.push(b);
    }
    if (froms.length === 0) return null;
    const A = centroid(froms);
    const B = centroid(tos);
    const d = wirePath(A, B);

    const g = svgEl("g", { class: "bus-band" });
    g.dataset.busId = bus.id;
    g.style.setProperty("--wire-color", `var(--color-wire-${bus.color})`);
    g.classList.toggle("bus-band--selected", this.#selectedBusIds.has(bus.id));
    if (off) g.classList.toggle("bus-band--illegal", off.legal === false);
    g.append(
      svgEl("path", { class: "bus-band-hit", d }),
      svgEl("path", { class: "bus-band-fill", d }),
    );
    const label = svgEl("text", {
      class: "bus-band-label",
      x: (A.x + B.x) / 2,
      // The quadratic's t=0.5 point hangs half the sag below the chord.
      y: (A.y + B.y) / 2 + wireSag(A, B) / 2,
    });
    label.textContent = bus.name;
    g.append(label);
    g.addEventListener("click", (e) => this.#onSelectBus?.(bus.id, e));
    g.addEventListener("contextmenu", (e) =>
      this.#onBusContextMenu?.(bus.id, e),
    );
    return g;
  }

  /**
   * Live-preview a wire with ONE endpoint dragged to an arbitrary world-px
   * point (the drag-an-endpoint gesture). The dragged wire re-renders with that
   * end following the cursor; `legal:false` tints it. Pass null to stop and
   * redraw from the document. (Board-drag `overrides` are orthogonal — this
   * moves a single endpoint, not a whole board.)
   * @param {{wireId:string, end:"from"|"to", world:{x:number,y:number}, legal?:boolean}|null} spec
   */
  setEndpointDrag(spec) {
    this.#endpointDrag = spec;
    this.render();
  }

  /**
   * Live-preview a whole wire translated rigidly (the drag-the-middle gesture):
   * BOTH endpoints move to arbitrary world-px points while length and
   * orientation are preserved. `legal:false` tints it. Pass null to stop and
   * redraw from the document.
   * @param {{wireId:string, from:{x:number,y:number}, to:{x:number,y:number}, legal?:boolean}|null} spec
   */
  setWholeDrag(spec) {
    this.#wholeDrag = spec;
    this.render();
  }

  /** Highlight one wire (null clears). Survives re-renders. */
  setSelected(id) {
    this.setSelectedMany(id == null ? [] : [id]);
  }

  /** Highlight a SET of wires (marquee selection); empty clears. */
  setSelectedMany(ids) {
    this.#selectedIds = new Set(ids);
    for (const group of this.#svg.querySelectorAll(".wire")) {
      group.classList.toggle(
        "wire--selected",
        this.#selectedIds.has(group.dataset.wireId),
      );
    }
  }

  /** Highlight one bus band (null clears). Survives re-renders. */
  setSelectedBus(id) {
    this.#selectedBusIds = new Set(id == null ? [] : [id]);
    for (const band of this.#svg.querySelectorAll(".bus-band")) {
      band.classList.toggle(
        "bus-band--selected",
        this.#selectedBusIds.has(band.dataset.busId),
      );
    }
  }

  /**
   * The bus tool's rubber-band preview: a fat translucent band from the
   * anchored start to the cursor (both world px). `legal` tints it red over an
   * illegal landing. Pass null to hide.
   * @param {{from:{x,y}, to:{x,y}, color:string, legal?:boolean}|null} spec
   */
  setBusPreview(spec) {
    if (!spec) {
      this.#busPreview?.remove();
      this.#busPreview = null;
      return;
    }
    if (!this.#busPreview) {
      this.#busPreview = svgEl("g", { class: "bus-band bus-band--preview" });
      this.#busPreview.append(svgEl("path", { class: "bus-band-fill" }));
      this.#svg.append(this.#busPreview);
    }
    this.#busPreview.style.setProperty(
      "--wire-color",
      `var(--color-wire-${spec.color})`,
    );
    this.#busPreview.classList.toggle("bus-band--illegal", !spec.legal);
    const d = wirePath(spec.from, spec.to);
    for (const path of this.#busPreview.querySelectorAll("path")) {
      path.setAttribute("d", d);
    }
  }

  /**
   * Live-preview a whole bus dragged rigidly by a world-px offset: every member
   * wire AND the band shift by (dx, dy). `legal:false` tints them. Pass null to
   * stop and redraw from the document.
   * @param {{busId:string, memberIds:Set<string>, dx:number, dy:number, legal?:boolean}|null} spec
   */
  setBusDrag(spec) {
    this.#busDrag = spec;
    this.render();
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
