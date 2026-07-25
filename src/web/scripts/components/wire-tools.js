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
// click-click wire TOOL (anchor a free point, click a second to lay a wire;
// the colour STAYS put between wires — change it via the toolbar swatch),
// grabbing a wire's END cap to re-route it, grabbing its BODY to translate it
// rigidly, and the per-wire context menu (remove / recolour). Pulled out of
// DeskController so "wiring" is one module.
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
import { HANDLE_HIT_RADIUS, busEndHandleNear } from "../desk/ribbon-path.js";
import { nearestLegalOffset } from "../model/nearest-legal.js";
import { beginPointerGesture, releaseWorld } from "./pointer-gesture.js";

/** Pointer travel (px) below which a press stays a click, not a drag. */
const DRAG_THRESHOLD = 4;
/** Radius of the shared hover ring (pitch units). */
const RING_RADIUS = 0.45;
/** How far (pitch units) a search stays a cheap, TIGHT near-miss lookup
    instead of the full "always find the nearest, however far" one: a
    WHOLE-WIRE (rigid, both-ends-together) drop's only recovery margin (a
    big rigid jump there would read as relocating the whole wire, not
    recovering a drop that missed by a hole or two) — AND, separately, the
    bound every LIVE pointermove uses for a single END's own drag preview.
    An end's search is only ever unbounded ONCE per gesture, at the moment
    of release (#onEndpointUp calling #resolveEndpointTarget with no
    maxRadius) — never on every move. A `nearestLegalOffset` call with no
    bound genuinely walks outward ring by ring until it hits something, and
    measured on a few hundred wires that's ~15-20ms of pure search
    overhead (ring generation + hole hit-testing) on top of a live-drag
    re-render's own cost — trivial as a ONE-TIME cost on release, but a
    visible per-frame stutter if it ran on every pointermove, which is
    exactly what an earlier version of this code did. */
const SNAP_RADIUS = 2;

export class WireTools {
  #host;
  #colorIndex = 0; // the color the next committed wire gets (pinned; never cycles)

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
    this.#host.disarmBusTool?.();
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
      if (!from) {
        // The anchored hole vanished from under us (e.g. an undo/redo removed
        // its board while the wire tool stayed armed) — drop the stale anchor
        // instead of crashing on a null world point.
        this.#clearPending();
      } else {
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
          label: color[0].toUpperCase() + color.slice(1),
          swatch: `var(--color-wire-${color})`,
          onSelect: () => this.recolorWire(id, color),
        })),
      ],
    });
  }

  // ── Grabbing a placed wire (endpoint re-route / whole-wire translate) ──────

  /**
   * A viewport press with no mode: try to grab a wire's end cap (re-route) or
   * its body (translate). Returns true when a drag started.
   *
   * A bus member's cap re-routes exactly like any wire's EXCEPT right where
   * it would be confused with that bus's own end-handle: the handle's collar
   * sits at a fixed offset from the bus's CENTROID, not from any particular
   * member's hole, so almost every member's cap is nowhere near it — but the
   * one that happens to coincide (measured, not hypothetical: an 8-bit bus
   * parked a collar within a couple of screen px of one member's own cap)
   * would otherwise flip a coin between "grab the handle" and "re-route this
   * one wire" every time. `#nearOwnBusHandle` excludes ONLY that overlap, at
   * that one end — the far end of the SAME wire, and every other member,
   * drag freely. Whole-body translate stays off for every member regardless
   * (a ~16px lead has little to translate, and it was never actually the
   * source of the ambiguity — DOM z-order already puts the handle on top).
   */
  tryBeginDrag(e, world) {
    const doc = this.#host.doc;
    const grab = wireEndNear(doc.boards, doc.components, doc.wires, world);
    if (grab && !this.#nearOwnBusHandle(grab.wireId, world)) {
      this.#beginEndpointDrag(grab, e);
      return true;
    }
    const wireId = e.target?.closest?.(".wire")?.dataset.wireId;
    if (wireId && !doc.busOfWire(wireId)) {
      this.#beginWholeDrag(wireId, e);
      return true;
    }
    return false;
  }

  /**
   * Is `world` within `wireId`'s own bus's end-handle hit radius (false for
   * a non-member)? Reuses the SAME collar geometry WireLayer renders the
   * handles at (desk/ribbon-path.js), derived fresh from the bus's currently
   * resolved member endpoints rather than threading collar points through.
   */
  #nearOwnBusHandle(wireId, world) {
    // Faded wires put the whole ribbon away — band, handles and all (see
    // WireLayer's header) — so there is no handle left to lose the grab to,
    // and a member's cap re-routes like every other wire's.
    if (this.#host.wireLayer.faded) return false;
    const doc = this.#host.doc;
    const bus = doc.busOfWire(wireId);
    if (!bus) return false;
    const froms = [];
    const tos = [];
    for (const id of bus.members) {
      const wire = doc.getWire(id);
      const a = wire && this.#addressWorld(wire.from);
      const b = wire && this.#addressWorld(wire.to);
      if (a) froms.push({ x: a.x * PX_PER_UNIT, y: a.y * PX_PER_UNIT });
      if (b) tos.push({ x: b.x * PX_PER_UNIT, y: b.y * PX_PER_UNIT });
    }
    const point = { x: world.x * PX_PER_UNIT, y: world.y * PX_PER_UNIT };
    return Boolean(busEndHandleNear(froms, tos, point, HANDLE_HIT_RADIUS));
  }

  /**
   * Abort an in-flight endpoint or whole-wire drag (DeskController#
   * cancelDragGesture — Escape, or recovering a pointerup the browser
   * silently dropped). Routes a synthetic `pointercancel` through the same
   * up-handler a real one would reach, so it tears down the capture and
   * listeners and reverts without duplicating that logic here. A no-op when
   * neither drag kind is current.
   */
  cancelDrag() {
    const m = this.#host.mode;
    const fake = { type: "pointercancel", pointerId: m?.pointerId };
    if (m?.kind === "drag-wire-end") this.#onEndpointUp(fake);
    else if (m?.kind === "drag-wire") this.#onWholeUp(fake);
  }

  /**
   * Is `world` on/near ANY wire's end cap, bus member or not? A cap sits
   * directly on a board hole, so a press there lands on the board SVG
   * beneath (caps are pointer-events:none) — `#onBoardPointerDown` uses this
   * to absorb the press instead of falling through to a board drag, even for
   * a bus member whose own `tryBeginDrag` deliberately declines to grab it.
   */
  capNear(world) {
    const doc = this.#host.doc;
    return Boolean(wireEndNear(doc.boards, doc.components, doc.wires, world));
  }

  #beginEndpointDrag(grab, e) {
    this.#host.hideHover();
    this.#host.selectWire(grab.wireId); // select on press (mode still null here)
    const mode = {
      kind: "drag-wire-end",
      wireId: grab.wireId,
      end: grab.end,
      origin: grab.origin, // revert target
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      active: false,
      teardown: null,
    };
    this.#host.mode = mode;
    // Capture on the persistent wire SVG — render() clears its CHILDREN but
    // keeps the element, so the capture survives live re-renders. The release
    // does NOT ride on that capture holding, though — see pointer-gesture.js.
    mode.teardown = beginPointerGesture(
      this.#host.wireLayer.element,
      e.pointerId,
      { onMove: this.#onEndpointMove, onEnd: this.#onEndpointUp },
    );
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
    m.lastWorld = world; // the fallback for a release with no position of its own
    // A cheap, SNAP_RADIUS-bounded lookup for the live preview — see the
    // SNAP_RADIUS comment for why the unbounded search is reserved for the
    // one-time #onEndpointUp resolve instead of running here every move. What
    // this finds is ONLY the preview; the drop re-resolves at the release
    // point (#onEndpointUp).
    const resolved = this.#resolveEndpointTarget(
      m.wireId,
      m.end,
      world,
      SNAP_RADIUS,
    );
    if (resolved) {
      const r = RING_RADIUS * PX_PER_UNIT;
      this.#host.ring.style.left = `${resolved.x * PX_PER_UNIT - r}px`;
      this.#host.ring.style.top = `${resolved.y * PX_PER_UNIT - r}px`;
      this.#host.ring.classList.toggle("hole-ring--illegal", !resolved.legal);
      this.#host.ring.hidden = false;
    } else {
      this.#host.ring.hidden = true;
    }
    // The dragged end snaps to the resolved point, else rides the raw cursor.
    const tip = resolved ?? world;
    this.#host.wireLayer.setEndpointDrag({
      wireId: m.wireId,
      end: m.end,
      world: { x: tip.x * PX_PER_UNIT, y: tip.y * PX_PER_UNIT },
      legal: resolved ? resolved.legal : true,
    });
  };

  /**
   * Where a release at `world` would land `wireId`'s `end`: the exact point
   * under the cursor when it's already legal there, else the CLOSEST legal
   * hole within `maxRadius` — dragging an end always ends up somewhere
   * real, the way a magnet-snapped connector would, never just floating
   * loose because the cursor missed by a hole or two. `maxRadius` omitted
   * means UNBOUNDED ("always find the nearest, however far") — reserved
   * for the one-time call in #onEndpointUp; #onEndpointMove's own per-move
   * call always passes SNAP_RADIUS (see its comment). Returns `{ address,
   * x, y, legal }` (`legal:false` — with whatever the raw point resolves
   * to, if anything — only when nothing within `maxRadius` qualifies, so
   * the illegal tint still explains what's under the cursor) or null when
   * there's truly nothing there at all (not even a real point).
   */
  #resolveEndpointTarget(wireId, end, world, maxRadius) {
    const doc = this.#host.doc;
    const found = nearestLegalOffset((dx, dy) => {
      const cand = this.#wirePointAt({ x: world.x + dx, y: world.y + dy });
      return Boolean(cand && doc.canReendWire(wireId, end, cand.address));
    }, maxRadius);
    if (found) {
      return {
        ...this.#wirePointAt({ x: world.x + found.dx, y: world.y + found.dy }),
        legal: true,
      };
    }
    const hit = this.#wirePointAt(world);
    return hit ? { ...hit, legal: false } : null;
  }

  #onEndpointUp = (e) => {
    const m = this.#host.mode;
    if (m?.kind !== "drag-wire-end" || e.pointerId !== m.pointerId) return;
    this.#host.mode = null;

    m.teardown?.();
    this.#host.ring.hidden = true;
    this.#host.ring.classList.remove("hole-ring--illegal");
    this.#host.viewport.classList.remove("desk-viewport--wire-dragging");
    this.#host.wireLayer.setEndpointDrag(null); // stop overriding; redraw

    if (!m.active) return; // plain click — the wire is already selected
    if (e.type === "pointercancel") return; // aborted — never commit

    // Resolve at the RELEASE point, not from whatever the last pointermove
    // left in `m.hover` (see pointer-gesture.js's releaseWorld): the tight
    // near-miss margin the preview showed first, then — only when that comes
    // up empty — the ONE unbounded "always find the nearest, however far"
    // search, a single call rather than a per-frame cost.
    const world = releaseWorld(this.#host.deskView, e, m.lastWorld);
    let target = this.#resolveEndpointTarget(
      m.wireId,
      m.end,
      world,
      SNAP_RADIUS,
    );
    if (!target?.legal) {
      target = this.#resolveEndpointTarget(m.wireId, m.end, world);
    }
    if (target?.legal && target.address !== m.origin) {
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
    const mode = {
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
      active: false,
      teardown: null,
    };
    this.#host.mode = mode;
    mode.teardown = beginPointerGesture(
      this.#host.wireLayer.element,
      e.pointerId,
      { onMove: this.#onWholeMove, onEnd: this.#onWholeUp },
    );
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
    m.lastWorld = world; // the fallback for a release with no position of its own
    // Rigid translation snapped to the 0.1-in lattice: ONE integer delta shifts
    // both ends together, so length and orientation never change. When the
    // raw delta doesn't land legally, #resolveWholeDragDelta looks for the
    // closest ADJUSTED delta that does — still rigid, never snapping just
    // one end independently of the other. What this finds is ONLY the preview;
    // the drop itself re-resolves at the release point (#onWholeUp).
    const rawDx = Math.round(world.x - m.startWorld.x);
    const rawDy = Math.round(world.y - m.startWorld.y);
    const resolved = this.#resolveWholeDragDelta(m, rawDx, rawDy);
    // Snap the rendered ends onto the resolved holes when legal, else float
    // at the raw (unsnapped) delta so the drag still visibly tracks the cursor.
    const a = resolved?.fromHit ?? {
      x: m.from0.x + rawDx,
      y: m.from0.y + rawDy,
    };
    const b = resolved?.toHit ?? { x: m.to0.x + rawDx, y: m.to0.y + rawDy };
    this.#host.wireLayer.setWholeDrag({
      wireId: m.wireId,
      from: { x: a.x * PX_PER_UNIT, y: a.y * PX_PER_UNIT },
      to: { x: b.x * PX_PER_UNIT, y: b.y * PX_PER_UNIT },
      legal: Boolean(resolved),
    });
  };

  /**
   * The rigid delta a whole-wire drag would commit at, for a raw
   * (unsnapped) delta `(rawDx, rawDy)`: that exact delta when both
   * translated ends land legally, else the CLOSEST delta within
   * SNAP_RADIUS where they do — both ends always shift by the SAME
   * adjusted delta, so a near-miss recovers without ever breaking rigidity.
   * Null when nothing within range qualifies.
   */
  #resolveWholeDragDelta(m, rawDx, rawDy) {
    const doc = this.#host.doc;
    const at = (origin, dx, dy) =>
      this.#wirePointAt({ x: origin.x + dx, y: origin.y + dy });
    const found = nearestLegalOffset((ddx, ddy) => {
      const dx = rawDx + ddx;
      const dy = rawDy + ddy;
      const fromHit = at(m.from0, dx, dy);
      const toHit = at(m.to0, dx, dy);
      return Boolean(
        fromHit &&
        toHit &&
        doc.canMoveWire(m.wireId, fromHit.address, toHit.address),
      );
    }, SNAP_RADIUS);
    if (!found) return null;
    const dx = rawDx + found.dx;
    const dy = rawDy + found.dy;
    return { fromHit: at(m.from0, dx, dy), toHit: at(m.to0, dx, dy) };
  }

  #onWholeUp = (e) => {
    const m = this.#host.mode;
    if (m?.kind !== "drag-wire" || e.pointerId !== m.pointerId) return;
    this.#host.mode = null;
    m.teardown?.();
    this.#host.viewport.classList.remove("desk-viewport--wire-dragging");
    this.#host.wireLayer.setWholeDrag(null); // stop overriding; redraw from doc

    if (!m.active) return; // plain click — the wire is already selected
    if (e.type === "pointercancel") return; // aborted — never commit

    // Resolve at the RELEASE point rather than trusting the last pointermove's
    // preview — see pointer-gesture.js's releaseWorld.
    const world = releaseWorld(this.#host.deskView, e, m.lastWorld);
    const resolved = this.#resolveWholeDragDelta(
      m,
      Math.round(world.x - m.startWorld.x),
      Math.round(world.y - m.startWorld.y),
    );
    // Commit only when BOTH ends landed on real free points (a legal, moved
    // target); an invalid release cancels the drag-drop and the wire snaps back.
    const from = resolved?.fromHit.address;
    const to = resolved?.toHit.address;
    if (resolved && (from !== m.fromOrigin || to !== m.toOrigin)) {
      this.#host.doc.moveWire(m.wireId, from, to);
      this.#host.emitDocChanged("move wire"); // WireLayer re-renders from this
    }
  };
}
