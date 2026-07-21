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

// wire-tools.js — everything about jumper wires the user drives: the
// click-click wire TOOL (anchor a free point, click a second to lay a wire,
// colour auto-cycling), grabbing a wire's END cap to re-route it, grabbing its
// BODY to translate it rigidly, and the per-wire context menu (remove /
// recolour). Pulled out of DeskController so "wiring" is one module.
//
// It reuses the controller's shared `#mode` (through the host) so the viewport
// pointer dispatcher's mode checks stay exactly as they were — this is a home
// for the wire behaviour, not a change to how modes arbitrate. Geometry comes
// from the pure model/part-geometry.js helpers; the host supplies the shared
// surface (doc, deskView, wire layer, hover ring) and coordination hooks.

import { PopupManager } from "../popup-manager.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { WIRE_COLORS } from "../model/desk-doc.js";
import {
  addressWorld,
  connectionPointAt,
  wireEndNear,
} from "../model/part-geometry.js";

/** Pointer travel (px) below which a press stays a click, not a drag. */
const DRAG_THRESHOLD = 4;
/** Radius of the shared hover ring (pitch units). */
const RING_RADIUS = 0.45;

export class WireTools {
  #host;
  #colorIndex = 0; // the color the next committed wire gets (auto-cycles)

  /**
   * @param {object} host - shared controller surface:
   *   { get mode, set mode, doc, deskView, viewport, wireLayer, ring,
   *     emitDocChanged, hideHover, selectWire, deselect, cancelPlacement,
   *     disarmProbe, get editingLocked, clearSelectionIfWire, onStateChange }
   */
  constructor(host) {
    this.#host = host;
  }

  // ── Wire tool (click-click) ───────────────────────────────────────────────

  get armed() {
    return this.#host.mode?.kind === "wire";
  }

  /** The color the next committed wire gets. */
  get color() {
    return WIRE_COLORS[this.#colorIndex];
  }

  /** Pin the next wire color (the toolbar swatch strip). */
  setColor(color) {
    const i = WIRE_COLORS.indexOf(color);
    if (i === -1) {
      const err = new Error(`unknown wire color: ${color}`);
      err.code = "INVALID_ARG";
      throw err;
    }
    this.#colorIndex = i;
    this.#notifyState();
  }

  /** Arm click-click wiring; a second call to toggle goes through app.js. */
  arm() {
    if (this.armed || this.#host.editingLocked) return;
    this.#host.cancelPlacement();
    this.#host.disarmProbe();
    this.#host.deselect();
    this.#host.hideHover();
    this.#host.mode = { kind: "wire", from: null, hover: null };
    this.#host.viewport.classList.add("desk-viewport--wiring");
    this.#notifyState();
  }

  disarm() {
    if (!this.armed) return;
    this.#clearPending();
    this.#host.mode = null;
    this.#host.viewport.classList.remove("desk-viewport--wiring");
    this.#host.ring.hidden = true;
    this.#host.ring.classList.remove("hole-ring--illegal");
    this.#notifyState();
  }

  toggle() {
    if (this.armed) this.disarm();
    else this.arm();
  }

  /** Escape while wiring: first cancel a pending wire, then disarm. */
  handleEscape() {
    if (!this.armed) return false;
    if (this.#host.mode.from) this.#clearPending();
    else this.disarm();
    return true;
  }

  /** Cancel a pending (anchored-but-uncommitted) wire without disarming. */
  cancelPending() {
    this.#clearPending();
  }

  #clearPending() {
    const m = this.#host.mode;
    if (m?.kind !== "wire") return;
    m.from = null;
    this.#host.wireLayer.setPreview(null);
  }

  #notifyState() {
    this.#host.onStateChange?.({ armed: this.armed, color: this.color });
  }

  #wirePointAt(world) {
    const doc = this.#host.doc;
    return connectionPointAt(doc.boards, doc.components, world);
  }

  #addressWorld(address) {
    const doc = this.#host.doc;
    return addressWorld(doc.boards, doc.components, address);
  }

  /** Wire-mode pointermove: instant ring with legality + the rubber band. */
  trackMove(e) {
    const m = this.#host.mode;
    const world = this.#host.deskView.worldFromEvent(e);
    const hit = this.#wirePointAt(world);
    if (hit) {
      const free = this.#host.doc.isHoleFree(hit.address);
      const legal = free && hit.address !== m.from;
      m.hover = { address: hit.address, legal };
      const r = RING_RADIUS * PX_PER_UNIT;
      this.#host.ring.style.left = `${hit.x * PX_PER_UNIT - r}px`;
      this.#host.ring.style.top = `${hit.y * PX_PER_UNIT - r}px`;
      this.#host.ring.classList.toggle("hole-ring--illegal", !legal);
      this.#host.ring.hidden = false;
    } else {
      m.hover = null;
      this.#host.ring.hidden = true;
    }
    if (m.from) {
      const from = this.#addressWorld(m.from);
      this.#host.wireLayer.setPreview({
        from: { x: from.x * PX_PER_UNIT, y: from.y * PX_PER_UNIT },
        to: hit
          ? { x: hit.x * PX_PER_UNIT, y: hit.y * PX_PER_UNIT }
          : { x: world.x * PX_PER_UNIT, y: world.y * PX_PER_UNIT },
        color: this.color,
        // Danger tint only over an actual occupied/self point — over empty
        // desk the band stays its color (a click there just does nothing).
        legal: hit ? m.hover.legal : true,
      });
    }
  }

  /** Wire-mode click: anchor on the first free point, commit on the second. */
  commitClick(e) {
    const m = this.#host.mode;
    this.trackMove(e); // legality/hover at the exact click point
    if (!m.hover?.legal) return;
    if (!m.from) {
      m.from = m.hover.address;
      return;
    }
    this.#host.doc.addWire({
      from: m.from,
      to: m.hover.address,
      color: this.color,
    });
    // The colour STAYS put between wires — a chain of jumpers keeps the colour
    // you picked; change it deliberately via the toolbar swatch.
    this.#clearPending(); // re-arm fresh — chain-friendly
    this.#host.emitDocChanged("add wire");
    this.#notifyState();
  }

  /** Remove a wire; clears its selection. */
  removeWire(id) {
    this.#host.doc.removeWire(id);
    this.#host.clearSelectionIfWire(id);
    this.#host.emitDocChanged("delete wire");
  }

  /** Recolor a wire (context menu). */
  recolorWire(id, color) {
    this.#host.doc.recolorWire(id, color);
    this.#host.emitDocChanged("recolor wire");
  }

  onContextMenu(id, e) {
    e.preventDefault();
    if (this.#host.mode || this.#host.editingLocked) return; // frozen while running
    this.#host.selectWire(id);
    PopupManager.menu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "Remove wire",
          danger: true,
          onSelect: () => this.removeWire(id),
        },
        ...WIRE_COLORS.map((color) => ({
          label: `Color: ${color}`,
          onSelect: () => this.recolorWire(id, color),
        })),
      ],
    });
  }

  // ── Grabbing a placed wire (endpoint re-route / whole-wire translate) ──────

  /**
   * A viewport press with no mode: try to grab a wire's end cap (re-route) or
   * its body (translate). Returns true when a drag started.
   */
  tryBeginDrag(e, world) {
    const doc = this.#host.doc;
    const grab = wireEndNear(doc.boards, doc.components, doc.wires, world);
    if (grab) {
      this.#beginEndpointDrag(grab, e);
      return true;
    }
    const wireId = e.target?.closest?.(".wire")?.dataset.wireId;
    if (wireId) {
      this.#beginWholeDrag(wireId, e);
      return true;
    }
    return false;
  }

  #beginEndpointDrag(grab, e) {
    this.#host.hideHover();
    this.#host.selectWire(grab.wireId); // select on press (mode still null here)
    this.#host.mode = {
      kind: "drag-wire-end",
      wireId: grab.wireId,
      end: grab.end,
      origin: grab.origin, // revert target
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      hover: null, // { address, legal } under the cursor
      active: false,
    };
    // Capture on the persistent wire SVG — render() clears its CHILDREN but
    // keeps the element, so capture and these listeners survive live re-renders.
    const svg = this.#host.wireLayer.element;
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort (synthetic events) */
    }
    svg.addEventListener("pointermove", this.#onEndpointMove);
    svg.addEventListener("pointerup", this.#onEndpointUp);
    svg.addEventListener("pointercancel", this.#onEndpointUp);
  }

  #onEndpointMove = (e) => {
    const m = this.#host.mode;
    if (m?.kind !== "drag-wire-end" || e.pointerId !== m.pointerId) return;
    if (!m.active) {
      const travel = Math.hypot(
        e.clientX - m.startClientX,
        e.clientY - m.startClientY,
      );
      if (travel < DRAG_THRESHOLD) return; // separate a click from a drag
      m.active = true;
      this.#host.viewport.classList.add("desk-viewport--wire-dragging");
    }
    const world = this.#host.deskView.worldFromEvent(e);
    const hit = this.#wirePointAt(world);
    if (hit) {
      const legal = this.#host.doc.canReendWire(m.wireId, m.end, hit.address);
      m.hover = { address: hit.address, legal };
      const r = RING_RADIUS * PX_PER_UNIT;
      this.#host.ring.style.left = `${hit.x * PX_PER_UNIT - r}px`;
      this.#host.ring.style.top = `${hit.y * PX_PER_UNIT - r}px`;
      this.#host.ring.classList.toggle("hole-ring--illegal", !legal);
      this.#host.ring.hidden = false;
    } else {
      m.hover = null;
      this.#host.ring.hidden = true;
    }
    // The dragged end snaps to a hovered point, else rides the raw cursor.
    const tip = hit ?? world;
    this.#host.wireLayer.setEndpointDrag({
      wireId: m.wireId,
      end: m.end,
      world: { x: tip.x * PX_PER_UNIT, y: tip.y * PX_PER_UNIT },
      legal: hit ? m.hover.legal : true,
    });
  };

  #onEndpointUp = (e) => {
    const m = this.#host.mode;
    if (m?.kind !== "drag-wire-end" || e.pointerId !== m.pointerId) return;
    this.#host.mode = null;

    const svg = this.#host.wireLayer.element;
    svg.removeEventListener("pointermove", this.#onEndpointMove);
    svg.removeEventListener("pointerup", this.#onEndpointUp);
    svg.removeEventListener("pointercancel", this.#onEndpointUp);
    try {
      svg.releasePointerCapture(m.pointerId);
    } catch {
      /* already released */
    }
    this.#host.ring.hidden = true;
    this.#host.ring.classList.remove("hole-ring--illegal");
    this.#host.viewport.classList.remove("desk-viewport--wire-dragging");
    this.#host.wireLayer.setEndpointDrag(null); // stop overriding; redraw

    if (!m.active) return; // plain click — the wire is already selected

    const target = m.hover;
    const commit =
      e.type !== "pointercancel" &&
      target?.legal &&
      target.address !== m.origin;
    if (commit) {
      this.#host.doc.setWireEndpoint(m.wireId, m.end, target.address);
      this.#host.emitDocChanged("move wire"); // WireLayer re-renders from this
    }
  };

  #beginWholeDrag(wireId, e) {
    const wire = this.#host.doc.getWire(wireId);
    const from0 = this.#addressWorld(wire?.from);
    const to0 = this.#addressWorld(wire?.to);
    if (!from0 || !to0) return; // defensive: unresolvable endpoints
    this.#host.hideHover();
    this.#host.selectWire(wireId); // select on press (mode still null here)
    this.#host.mode = {
      kind: "drag-wire",
      wireId,
      from0, // origin endpoint world positions (pitch units)
      to0,
      fromOrigin: wire.from, // revert / no-op detection
      toOrigin: wire.to,
      startWorld: this.#host.deskView.worldFromEvent(e),
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      target: null, // { from, to } addresses once snapped over legal holes
      active: false,
    };
    const svg = this.#host.wireLayer.element;
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort (synthetic events) */
    }
    svg.addEventListener("pointermove", this.#onWholeMove);
    svg.addEventListener("pointerup", this.#onWholeUp);
    svg.addEventListener("pointercancel", this.#onWholeUp);
  }

  #onWholeMove = (e) => {
    const m = this.#host.mode;
    if (m?.kind !== "drag-wire" || e.pointerId !== m.pointerId) return;
    if (!m.active) {
      const travel = Math.hypot(
        e.clientX - m.startClientX,
        e.clientY - m.startClientY,
      );
      if (travel < DRAG_THRESHOLD) return; // separate a click from a drag
      m.active = true;
      this.#host.viewport.classList.add("desk-viewport--wire-dragging");
    }
    const world = this.#host.deskView.worldFromEvent(e);
    // Rigid translation snapped to the 0.1-in lattice: ONE integer delta shifts
    // both ends together, so length and orientation never change.
    const dx = Math.round(world.x - m.startWorld.x);
    const dy = Math.round(world.y - m.startWorld.y);
    const fromW = { x: m.from0.x + dx, y: m.from0.y + dy };
    const toW = { x: m.to0.x + dx, y: m.to0.y + dy };
    // Both translated ends must land on real, free points for a legal drop.
    const fromHit = this.#wirePointAt(fromW);
    const toHit = this.#wirePointAt(toW);
    const legal =
      !!fromHit &&
      !!toHit &&
      this.#host.doc.canMoveWire(m.wireId, fromHit.address, toHit.address);
    m.target = legal ? { from: fromHit.address, to: toHit.address } : null;
    // Snap the rendered ends onto the resolved holes when legal, else float.
    const a = fromHit ?? fromW;
    const b = toHit ?? toW;
    this.#host.wireLayer.setWholeDrag({
      wireId: m.wireId,
      from: { x: a.x * PX_PER_UNIT, y: a.y * PX_PER_UNIT },
      to: { x: b.x * PX_PER_UNIT, y: b.y * PX_PER_UNIT },
      legal,
    });
  };

  #onWholeUp = (e) => {
    const m = this.#host.mode;
    if (m?.kind !== "drag-wire" || e.pointerId !== m.pointerId) return;
    this.#host.mode = null;

    const svg = this.#host.wireLayer.element;
    svg.removeEventListener("pointermove", this.#onWholeMove);
    svg.removeEventListener("pointerup", this.#onWholeUp);
    svg.removeEventListener("pointercancel", this.#onWholeUp);
    try {
      svg.releasePointerCapture(m.pointerId);
    } catch {
      /* already released */
    }
    this.#host.viewport.classList.remove("desk-viewport--wire-dragging");
    this.#host.wireLayer.setWholeDrag(null); // stop overriding; redraw from doc

    if (!m.active) return; // plain click — the wire is already selected

    // Commit only when BOTH ends landed on real free points (a legal, moved
    // target); an invalid release cancels the drag-drop and the wire snaps back.
    const t = m.target;
    const moved = t && (t.from !== m.fromOrigin || t.to !== m.toOrigin);
    if (e.type !== "pointercancel" && t && moved) {
      this.#host.doc.moveWire(m.wireId, t.from, t.to);
      this.#host.emitDocChanged("move wire"); // WireLayer re-renders from this
    }
  };
}
