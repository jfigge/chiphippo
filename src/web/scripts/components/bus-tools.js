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
// netlist and engine never learn it exists. This module also owns grabbing
// the ribbon (drag the whole bus, both ends together) or one of its two end
// handles (drag just that end's leads, the other staying put — each member's
// individual wire is still its own draggable `.wire` underneath, EXCEPT
// right at its own bus's collar — see WireTools#tryBeginDrag), and the bus's
// right-click menu (rename / recolour / un-bundle / delete). Like WireTools
// it shares the controller's `#mode` through the host so the viewport
// dispatcher is unchanged.

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
import { nearestLegalOffset } from "../model/nearest-legal.js";
import { beginPointerGesture, releaseWorld } from "./pointer-gesture.js";

/** Pointer travel (px) below which a press stays a click, not a drag. */
const DRAG_THRESHOLD = 4;
/** How far (pitch units) a search stays a cheap, TIGHT near-miss lookup
    instead of the full "always find the nearest, however far" one: a
    WHOLE-BUS (rigid, both ends together) drop's only recovery margin (a
    tight near-miss, not a teleport — mirrors wire-tools.js's own
    SNAP_RADIUS for the whole-wire drag) — AND, separately, the bound every
    LIVE pointermove uses for an END-HANDLE drag's preview. An end-handle's
    search is only ever unbounded ONCE per gesture, at the moment of
    release (#onBusUp calling #resolveBusDrop with no maxRadius) — never
    on every move; see #resolveBusDrop's own comment for why. */
const SNAP_RADIUS = 2;
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

  // ── Grabbing a bundle band or an end handle (whole-bus / one-end translate) ─

  /**
   * A viewport press with no mode: try to grab an end handle (translate just
   * that end's leads, in parallel, the other end staying put) or, failing
   * that, a bundle band (translate the whole bus). Returns true when a drag
   * started. The handle check comes first — it's the smaller, more specific
   * target sitting on top of the band's own hit stroke.
   */
  tryBeginDrag(e, world) {
    const handle = e.target?.closest?.(".bus-end-handle");
    if (handle) {
      this.#beginBusDrag(handle.dataset.busId, e, world, handle.dataset.end);
      return true;
    }
    const busId = e.target?.closest?.(".bus-band")?.dataset.busId;
    if (!busId) return false;
    this.#beginBusDrag(busId, e, world, null);
    return true;
  }

  /**
   * Abort an in-flight whole-bus or end-handle drag (DeskController#
   * cancelDragGesture — Escape, or recovering a pointerup the browser
   * silently dropped). Routes a synthetic `pointercancel` through the same
   * up-handler a real one would reach, so it tears down the capture and
   * listeners and reverts without duplicating that logic here. A no-op when
   * no bus drag is current.
   */
  cancelDrag() {
    const m = this.#host.mode;
    if (m?.kind === "drag-bus") {
      this.#onBusUp({ type: "pointercancel", pointerId: m.pointerId });
    }
  }

  /**
   * @param {string} busId
   * @param {PointerEvent} e
   * @param {{x:number,y:number}} world
   * @param {"from"|"to"|null} end - null drags the whole bus (both ends);
   *   otherwise only that end's leads move, the other staying anchored.
   */
  #beginBusDrag(busId, e, world, end) {
    const doc = this.#doc();
    const bus = doc.getBus(busId);
    if (!bus || bus.members.length === 0) return;
    const members = [];
    for (const id of bus.members) {
      const wire = doc.getWire(id);
      const from0 = wire && addressWorld(doc.boards, doc.components, wire.from);
      const to0 = wire && addressWorld(doc.boards, doc.components, wire.to);
      if (!from0 || !to0) continue;
      members.push({
        id,
        from0,
        to0,
        fromAddress: wire.from,
        toAddress: wire.to,
      });
    }
    if (members.length === 0) return;
    this.#host.hideHover();
    this.#host.selectBus(busId);
    const ids = members.map((mem) => mem.id);
    const mode = {
      kind: "drag-bus",
      busId,
      end,
      members,
      memberIds: new Set(ids),
      // The document can't change until this gesture commits, so the batch
      // legality check hoists its occupancy build out of the snap search —
      // once per GESTURE instead of once per candidate offset per move.
      canBatch: doc.prepareWireBatchMove(ids),
      startWorld: world,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      active: false,
      teardown: null,
    };
    this.#host.mode = mode;
    mode.teardown = beginPointerGesture(
      this.#host.wireLayer.element,
      e.pointerId,
      { onMove: this.#onBusMove, onEnd: this.#onBusUp },
    );
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
    const world = this.#host.deskView.worldFromEvent(e);
    m.lastWorld = world; // the fallback for a release with no position of its own
    const rawDx = Math.round(world.x - m.startWorld.x);
    const rawDy = Math.round(world.y - m.startWorld.y);
    // A cheap, SNAP_RADIUS-bounded lookup for the live preview, for BOTH
    // grab kinds — see the SNAP_RADIUS comment for why the end-handle's own
    // unbounded search is reserved for the one-time #onBusUp resolve
    // instead of running here every move. What this finds is ONLY the
    // preview: the drop itself re-resolves at the release point (#onBusUp),
    // so a coalesced move stream can't decide where the bus lands.
    const found = this.#resolveBusDrop(m, rawDx, rawDy, SNAP_RADIUS);
    this.#host.wireLayer.setBusDrag({
      busId: m.busId,
      memberIds: m.memberIds,
      end: m.end,
      dx: (found ? found.dx : rawDx) * PX_PER_UNIT,
      dy: (found ? found.dy : rawDy) * PX_PER_UNIT,
      legal: Boolean(found),
    });
  };

  /**
   * The nearest legal drop at or around the rigid delta `(rawDx, rawDy)`:
   * `{ dx, dy, moves }` for the first offset at which every member's moved
   * end(s) land legally AS A BATCH, or null. Every member still shifts by
   * the SAME final delta either way, so this never snaps one lead
   * independently of the rest. `maxRadius` omitted means UNBOUNDED ("always
   * find the nearest, however far") — reserved for the one-time end-handle
   * fallback in #onBusUp; #onBusMove's own per-move call always passes
   * SNAP_RADIUS — see its comment: an unbounded search costs ~15-20ms of
   * pure search overhead on a few hundred wires, fine once on release, a
   * visible stutter on every pointermove.
   *
   * The winning offset's batch comes back with it (the caller used to
   * rebuild it), and legality goes through the gesture's PREPARED checker
   * (`DeskDoc.prepareWireBatchMove`, built once in #beginBusDrag) rather
   * than `canMoveWiresBatch` rebuilding the whole document's occupancy map
   * on every candidate.
   */
  #resolveBusDrop(m, rawDx, rawDy, maxRadius) {
    let hit = null;
    nearestLegalOffset((ddx, ddy) => {
      const dx = rawDx + ddx;
      const dy = rawDy + ddy;
      const moves = this.#busMovesAt(m, dx, dy);
      if (!moves || !m.canBatch(moves)) return false;
      hit = { dx, dy, moves };
      return true;
    }, maxRadius);
    return hit;
  }

  /**
   * The batch of `{id, from, to}` moves a bus(-end) drag would commit at
   * delta `(dx, dy)`: a whole-bus grab (`m.end` null) translates both ends
   * of every member by the same delta; an end-handle grab translates only
   * that one end, the other staying at its current (unchanged) address.
   * Null when any end that's supposed to move doesn't resolve to a real
   * point at that delta — the caller still needs the batch legality check on
   * top (members may collectively vacate holes for each other to land on, so
   * legality can't be judged member by member).
   */
  #busMovesAt(m, dx, dy) {
    const moveFrom = m.end !== "to";
    const moveTo = m.end !== "from";
    const moves = [];
    for (const mem of m.members) {
      const from = moveFrom
        ? this.#holeAtWorld(mem.from0.x + dx, mem.from0.y + dy)
        : mem.fromAddress;
      const to = moveTo
        ? this.#holeAtWorld(mem.to0.x + dx, mem.to0.y + dy)
        : mem.toAddress;
      if (!from || !to) return null;
      moves.push({ id: mem.id, from, to });
    }
    return moves;
  }

  #onBusUp = (e) => {
    const m = this.#host.mode;
    if (m?.kind !== "drag-bus" || e.pointerId !== m.pointerId) return;
    this.#host.mode = null;
    m.teardown?.();
    this.#host.viewport.classList.remove("desk-viewport--wire-dragging");
    this.#host.wireLayer.setBusDrag(null);
    if (!m.active) return; // a plain click — the bus is already selected
    if (e.type === "pointercancel") return; // aborted — never commit

    // Resolve the drop from the RELEASE point itself, not from whatever the
    // last pointermove happened to leave behind. Moves are coalesced (and on
    // a wide bus the preview could fall behind the cursor outright), so the
    // last sample can be several frames stale — and a stale sample sitting
    // somewhere illegal used to make the whole drop silently revert, which
    // is exactly what "the drop got missed" looked like.
    const { dx, dy } = this.#releaseDelta(m, e);
    // The tight near-miss margin first (the same one the preview showed),
    // then — for an END-HANDLE drag only — the ONE unbounded "always find
    // the nearest, however far" search, a single call rather than a
    // per-frame cost. A WHOLE-BUS drag (m.end null) has no such fallback: it
    // stays SNAP_RADIUS-only end to end, same as a whole-wire drag, since a
    // big rigid jump would relocate the entire bus somewhere the cursor
    // never was.
    const found =
      this.#resolveBusDrop(m, dx, dy, SNAP_RADIUS) ??
      (m.end ? this.#resolveBusDrop(m, dx, dy) : null);
    // An illegal drop (no delta seats every member's moved end in a free
    // hole) commits nothing, and the render above already reverted to the
    // document's real (unmoved) addresses.
    if (found) {
      this.#doc().moveWiresBatch(found.moves);
      this.#host.emitDocChanged(m.end ? "move bus end" : "move bus");
    }
  };

  /** The rigid delta a release asks for — see pointer-gesture.js's
      releaseWorld for why it comes from the release event and not from the
      last pointermove. */
  #releaseDelta(m, e) {
    const world = releaseWorld(
      this.#host.deskView,
      e,
      m.lastWorld ?? m.startWorld,
    );
    return {
      dx: Math.round(world.x - m.startWorld.x),
      dy: Math.round(world.y - m.startWorld.y),
    };
  }

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
          label: color[0].toUpperCase() + color.slice(1),
          swatch: `var(--color-wire-${color})`,
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
