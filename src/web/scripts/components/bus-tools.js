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

// bus-tools.js — the bus TOOL (Feature 130), sibling to wire-tools.js. Arm it
// (shortcut B), click a START hole then a second point:
//   • a bare hole on another run → RUN mode: `width` wires march down the two
//     aligned runs and get bundled into a bus;
//   • a chip pin in a catalog `pinGroups` run → TAP mode: the bus fans onto
//     that group in bit order.
// A bus is metadata over the wires it lays (see model/bus-layout.js) — the
// netlist and engine never learn it exists. This module also owns grabbing a
// bundle band to drag the whole bus, and its right-click menu (rename /
// recolour / un-bundle / delete). Like WireTools it shares the controller's
// `#mode` through the host so the viewport dispatcher is unchanged.

import { PopupManager } from "../popup-manager.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { WIRE_COLORS, parseBusName } from "../model/desk-doc.js";
import { busRunAddresses, busTapAddresses } from "../model/bus-layout.js";
import { pinGroupContaining } from "../catalog/index.js";
import {
  PIN_HIT_RADIUS,
  addressWorld,
  connectionPointAt,
  partPinsWorld,
} from "../model/part-geometry.js";

/** Pointer travel (px) below which a press stays a click, not a drag. */
const DRAG_THRESHOLD = 4;
/** Radius of the shared hover ring (pitch units). */
const RING_RADIUS = 0.45;

export class BusTools {
  #host;

  /**
   * @param {object} host - shared controller surface (see the ctor in
   *   desk-controller.js): mode get/set, doc, deskView, viewport, wireLayer,
   *   ring, editingLocked, busName (from the toolbar input), busColor,
   *   emitDocChanged, hideHover, selectBus, deselect, clearSelectionIfBus,
   *   cancelPlacement, disarmProbe, disarmWireTool, onStateChange.
   */
  constructor(host) {
    this.#host = host;
  }

  // ── Bus tool (click-click) ────────────────────────────────────────────────

  get armed() {
    return this.#host.mode?.kind === "bus";
  }

  arm() {
    if (this.armed || this.#host.editingLocked) return;
    this.#host.cancelPlacement();
    this.#host.disarmProbe();
    this.#host.disarmWireTool();
    this.#host.deselect();
    this.#host.hideHover();
    this.#host.mode = { kind: "bus", from: null, hover: null, plan: null };
    this.#host.viewport.classList.add("desk-viewport--bus");
    this.#notifyState();
  }

  disarm() {
    if (!this.armed) return;
    this.#clearPending();
    this.#host.mode = null;
    this.#host.viewport.classList.remove("desk-viewport--bus");
    this.#host.ring.hidden = true;
    this.#host.ring.classList.remove("hole-ring--illegal");
    this.#notifyState();
  }

  toggle() {
    if (this.armed) this.disarm();
    else this.arm();
  }

  /** Escape while busing: first cancel a pending run, then disarm. */
  handleEscape() {
    if (!this.armed) return false;
    if (this.#host.mode.from) this.#clearPending();
    else this.disarm();
    return true;
  }

  cancelPending() {
    this.#clearPending();
  }

  #clearPending() {
    const m = this.#host.mode;
    if (m?.kind !== "bus") return;
    m.from = null;
    m.plan = null;
    this.#host.wireLayer.setBusPreview(null);
  }

  #notifyState() {
    this.#host.onStateChange?.({ armed: this.armed });
  }

  #doc() {
    return this.#host.doc;
  }

  /** The board hole under a world point, or null (terminals don't seed a run). */
  #holeAt(world) {
    const doc = this.#doc();
    const hit = connectionPointAt(doc.boards, doc.components, world);
    if (!hit) return null;
    const board = doc.getBoard(hit.address.split(".")[0]);
    return board ? hit : null; // a PSU terminal can't anchor a marching run
  }

  /** The chip pin under a world point as `{ comp, pin }`, or null. */
  #pinAt(world) {
    const doc = this.#doc();
    const boards = doc.boards;
    for (const comp of doc.components) {
      if (comp.board == null) continue;
      const pins = partPinsWorld(boards, comp);
      if (!pins) continue;
      for (const p of pins) {
        if (p.address == null) continue;
        if (Math.hypot(world.x - p.x, world.y - p.y) <= PIN_HIT_RADIUS) {
          return { comp, pin: p.pin };
        }
      }
    }
    return null;
  }

  /**
   * Resolve the current plan (the `{ from, to }` address pairs) from the
   * anchored start to whatever the cursor is over — a chip pin group (TAP) or a
   * bare hole (RUN). Returns { pairs, legal, endWorld } or null when there is
   * nothing to preview.
   */
  #resolvePlan(m, world) {
    const doc = this.#doc();
    const parsed = parseBusName(this.#host.busName);
    if (!parsed) return null; // no/junk name → nothing to lay
    const width = parsed.width;
    const pin = this.#pinAt(world);
    let pairs = null;
    let endWorld = null;
    if (pin) {
      const group = pinGroupContaining(pin.comp.ref, pin.pin);
      if (group) {
        pairs = busTapAddresses(
          doc.toJSON(),
          m.from,
          pin.comp,
          group,
          parsed.bits,
          (a) => doc.isHoleFree(a),
        );
        endWorld = this.#pinWorld(pin);
      }
    }
    if (!pairs) {
      const hole = this.#holeAt(world);
      if (hole) {
        pairs = busRunAddresses(doc.boards, m.from, hole.address, width);
        endWorld = { x: hole.x, y: hole.y };
      }
    }
    if (!pairs) return { pairs: null, legal: false, endWorld };
    return { pairs, legal: this.#planLegal(pairs), endWorld };
  }

  /** World position of a resolved chip pin. */
  #pinWorld(pin) {
    const pins = partPinsWorld(this.#doc().boards, pin.comp);
    const p = pins?.find((x) => x.pin === pin.pin);
    return p ? { x: p.x, y: p.y } : null;
  }

  /** Every pair connects two distinct free holes, and no hole is claimed twice. */
  #planLegal(pairs) {
    const doc = this.#doc();
    const claimed = new Set();
    for (const { from, to } of pairs) {
      if (!doc.canPlaceWire(from, to)) return false;
      for (const a of [from, to]) {
        if (claimed.has(a)) return false; // two leads into one hole
        claimed.add(a);
      }
    }
    return true;
  }

  #startWorld(address) {
    const doc = this.#doc();
    return addressWorld(doc.boards, doc.components, address);
  }

  /** Bus-mode pointermove: ring + legality + the rubber-band band. */
  trackMove(e) {
    const m = this.#host.mode;
    const world = this.#host.deskView.worldFromEvent(e);

    if (!m.from) {
      // Anchoring: the ring lands on a free board hole.
      const hole = this.#holeAt(world);
      const legal = Boolean(hole) && this.#doc().isHoleFree(hole.address);
      m.hover = hole ? { address: hole.address, legal } : null;
      if (hole) {
        this.#placeRing(hole.x, hole.y, legal);
      } else {
        this.#host.ring.hidden = true;
      }
      return;
    }

    const resolved = this.#resolvePlan(m, world);
    m.plan = resolved?.pairs ?? null;
    m.legal = Boolean(resolved?.legal);
    const from = this.#startWorld(m.from);
    const end = resolved?.endWorld;
    this.#host.wireLayer.setBusPreview({
      from: { x: from.x * PX_PER_UNIT, y: from.y * PX_PER_UNIT },
      to: end
        ? { x: end.x * PX_PER_UNIT, y: end.y * PX_PER_UNIT }
        : { x: world.x * PX_PER_UNIT, y: world.y * PX_PER_UNIT },
      color: this.#host.busColor,
      legal: end ? m.legal : true,
    });
    // Ring on the hovered endpoint when there is one.
    if (end) this.#placeRing(end.x, end.y, m.legal);
    else this.#host.ring.hidden = true;
  }

  #placeRing(x, y, legal) {
    const r = RING_RADIUS * PX_PER_UNIT;
    this.#host.ring.style.left = `${x * PX_PER_UNIT - r}px`;
    this.#host.ring.style.top = `${y * PX_PER_UNIT - r}px`;
    this.#host.ring.classList.toggle("hole-ring--illegal", !legal);
    this.#host.ring.hidden = false;
  }

  /** Bus-mode click: anchor on the first free hole, commit the run on the next. */
  commitClick(e) {
    const m = this.#host.mode;
    this.trackMove(e); // legality/plan at the exact click point
    if (!m.from) {
      if (m.hover?.legal) m.from = m.hover.address;
      return;
    }
    if (!m.plan || !m.legal) return; // illegal landing — the tint explains
    const color = this.#host.busColor;
    const memberIds = [];
    for (const { from, to } of m.plan) {
      memberIds.push(this.#doc().addWire({ from, to, color }).id);
    }
    this.#doc().addBus(this.#host.busName, memberIds, { color });
    this.#clearPending(); // re-arm fresh for the next bus
    this.#host.hideHover();
    this.#host.emitDocChanged("add bus");
    this.#notifyState();
  }

  // ── Grabbing a bundle band (whole-bus translate) ──────────────────────────

  /**
   * A viewport press with no mode: try to grab a bundle band and drag the whole
   * bus. Returns true when a drag started.
   */
  tryBeginDrag(e, world) {
    const busId = e.target?.closest?.(".bus-band")?.dataset.busId;
    if (!busId) return false;
    this.#beginBusDrag(busId, e, world);
    return true;
  }

  #beginBusDrag(busId, e, world) {
    const doc = this.#doc();
    const bus = doc.getBus(busId);
    if (!bus || bus.members.length === 0) return;
    const members = [];
    for (const id of bus.members) {
      const wire = doc.getWire(id);
      const from0 = wire && addressWorld(doc.boards, doc.components, wire.from);
      const to0 = wire && addressWorld(doc.boards, doc.components, wire.to);
      if (!from0 || !to0) continue;
      members.push({ id, from0, to0 });
    }
    if (members.length === 0) return;
    this.#host.hideHover();
    this.#host.selectBus(busId);
    this.#host.mode = {
      kind: "drag-bus",
      busId,
      members,
      memberIds: new Set(members.map((m) => m.id)),
      startWorld: world,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      moves: null,
      active: false,
    };
    const svg = this.#host.wireLayer.element;
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      /* best-effort */
    }
    svg.addEventListener("pointermove", this.#onBusMove);
    svg.addEventListener("pointerup", this.#onBusUp);
    svg.addEventListener("pointercancel", this.#onBusUp);
  }

  #onBusMove = (e) => {
    const m = this.#host.mode;
    if (m?.kind !== "drag-bus" || e.pointerId !== m.pointerId) return;
    if (!m.active) {
      const travel = Math.hypot(
        e.clientX - m.startClientX,
        e.clientY - m.startClientY,
      );
      if (travel < DRAG_THRESHOLD) return;
      m.active = true;
      this.#host.viewport.classList.add("desk-viewport--wire-dragging");
    }
    const doc = this.#doc();
    const world = this.#host.deskView.worldFromEvent(e);
    const dx = Math.round(world.x - m.startWorld.x);
    const dy = Math.round(world.y - m.startWorld.y);
    // Each member's both ends translate by the same integer delta, then resolve
    // to a hole; the drop is legal only when EVERY end lands and the batch is
    // collectively free (members may shuffle among the holes they vacate).
    const moves = [];
    let resolved = true;
    for (const mem of m.members) {
      const from = this.#holeAtWorld(mem.from0.x + dx, mem.from0.y + dy);
      const to = this.#holeAtWorld(mem.to0.x + dx, mem.to0.y + dy);
      if (!from || !to) {
        resolved = false;
        break;
      }
      moves.push({ id: mem.id, from, to });
    }
    const legal = resolved && doc.canMoveWiresBatch(moves);
    m.moves = legal ? moves : null;
    this.#host.wireLayer.setBusDrag({
      busId: m.busId,
      memberIds: m.memberIds,
      dx: dx * PX_PER_UNIT,
      dy: dy * PX_PER_UNIT,
      legal,
    });
  };

  #onBusUp = (e) => {
    const m = this.#host.mode;
    if (m?.kind !== "drag-bus" || e.pointerId !== m.pointerId) return;
    this.#host.mode = null;
    const svg = this.#host.wireLayer.element;
    svg.removeEventListener("pointermove", this.#onBusMove);
    svg.removeEventListener("pointerup", this.#onBusUp);
    svg.removeEventListener("pointercancel", this.#onBusUp);
    try {
      svg.releasePointerCapture(m.pointerId);
    } catch {
      /* already released */
    }
    this.#host.viewport.classList.remove("desk-viewport--wire-dragging");
    this.#host.wireLayer.setBusDrag(null);
    if (!m.active) return; // a plain click — the bus is already selected
    if (e.type !== "pointercancel" && m.moves) {
      this.#doc().moveWiresBatch(m.moves);
      this.#host.emitDocChanged("move bus");
    }
  };

  /** The board hole under a world point, as an address, or null. */
  #holeAtWorld(x, y) {
    const doc = this.#doc();
    const hit = connectionPointAt(doc.boards, doc.components, { x, y });
    if (!hit) return null;
    return doc.getBoard(hit.address.split(".")[0]) ? hit.address : null;
  }

  // ── Bus operations (context menu) ─────────────────────────────────────────

  onContextMenu(id, e) {
    e.preventDefault();
    if (this.#host.mode || this.#host.editingLocked) return;
    this.#host.selectBus(id);
    const bus = this.#doc().getBus(id);
    if (!bus) return;
    PopupManager.menu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Rename bus…", onSelect: () => this.#rename(id, bus.name) },
        {
          label: "Un-bundle (keep wires)",
          onSelect: () => this.removeBus(id, false),
        },
        {
          label: "Delete bus + wires",
          danger: true,
          onSelect: () => this.removeBus(id, true),
        },
        ...WIRE_COLORS.map((color) => ({
          label: `Color: ${color}`,
          onSelect: () => this.recolorBus(id, color),
        })),
      ],
    });
  }

  #rename(id, current) {
    PopupManager.prompt({
      title: "Rename bus",
      label: "Bus name",
      value: current,
      placeholder: "e.g. D[7:0], A[0:15]",
      onConfirm: (name) => {
        if (!parseBusName(name)) return; // junk name — leave it be
        this.#doc().updateBus(id, { name });
        this.#host.emitDocChanged("rename bus");
      },
    });
  }

  /** Recolor a bus AND its member wires (one visual family). */
  recolorBus(id, color) {
    const doc = this.#doc();
    const bus = doc.getBus(id);
    if (!bus) return;
    doc.updateBus(id, { color });
    for (const wid of bus.members) doc.recolorWire(wid, color);
    this.#host.emitDocChanged("recolor bus");
  }

  /** Remove a bus; `cascadeWires` deletes its member wires too. */
  removeBus(id, cascadeWires) {
    this.#doc().removeBus(id, { cascadeWires });
    this.#host.clearSelectionIfBus(id);
    this.#host.emitDocChanged(cascadeWires ? "delete bus" : "unbundle bus");
  }
}
