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
// ROUTED (the wire's own "Layout Method" property): the same three strokes,
// but drawn as the straight run through the wire's waypoints instead of a
// sagging curve, plus one knob per waypoint — the grab target WireTools bends
// it by. The knobs only show on hover or selection, so an untouched routed
// wire is just a straight line. Everything else about a wire is unchanged by
// the choice, which is why nothing downstream of the `d` string knows about
// it; a BUS MEMBER is the one exception, and it goes the other way — its leads
// belong to the ribbon and win over any routing it carries.
//
// HIGHLIGHTED (setSelected/setSelectedMany): a picked wire draws LAST, over
// every wire and every ribbon body laid after it, because picking one is how
// you trace it and a run buried under a dozen later wires is exactly the run
// worth pointing at. Order is derived per render, so dropping the highlight
// drops the wire straight back into its document-order slot. That is also the
// only thing left to do with a wire while the circuit RUNS: the topology is
// frozen, so nothing here can be dragged, bent or re-routed, and app.css
// (.desk-viewport--running) puts the affordances that would say otherwise
// away — a routed wire's knobs stay hidden however it is hovered or picked,
// and its body drops the grab cursor.
//
// FADED (the toolbar's "Fade wires" toggle, setFaded): a dense board can end
// up buried under its own wiring, so every wire can be cut back to a short stub
// off each end that ramps away to nothing in between — enough to read where a
// wire lands without the run across the middle hiding the parts. The stub is
// the drawn path AND the hit stroke, so the vanished middle can't swallow a
// click meant for the chip underneath it. A SELECTED wire is exempt: picking
// one (or marquee-ing it) brings the whole run back.
//
// A BUS is the biggest thing in the way, so fading puts the ribbon itself away
// — no trunk, no hit band, no end handles — but its members keep the very leads
// they had, still aimed at the collar the ribbon would run through, and just
// fade out along them. So a faded bus still reads as a bundle: every member
// points at where the tunnel is. With no band and no handles rendered there is
// nothing to grab a bus by while faded; WireTools#nearOwnBusHandle drops its
// collar exclusion to match.
//
// Endpoints are ADDRESSES resolved through board origins at render time, so
// cross-board wires are first-class: wires re-render only when the wire list
// changes (chiphippo:doc-changed) or an endpoint's board moves (the
// controller passes live drag positions via `overrides`) — never on pan/zoom.

import { clear, svgEl } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import {
  FADE_SOLID_FRACTION,
  fadeRadius,
  fadedPolyline,
  fadedWire,
  polylinePath,
  wirePath,
  wireSag,
} from "../desk/wire-path.js";
import {
  HANDLE_HIT_RADIUS,
  centroid,
  ribbonLayout,
  ribbonSpread,
  ribbonWidth,
} from "../desk/ribbon-path.js";
import { holePosition, parseAddress } from "../model/breadboard.js";
import { partDef } from "../catalog/index.js";

/** Endpoint cap radius (world px — scales with the camera); stroke widths
    live in app.css on the .wire-* classes. */
const CAP_RADIUS = 2.4;

/** A routed wire's waypoint knob (world px) — the grab target for bending the
    run. It only SHOWS on hover/selection (app.css), so an unattended routed
    wire draws as the plain straight line it is. */
const POINT_KNOB_RADIUS = 3.5;

/** A bus end-handle's visible knob (world px); HANDLE_HIT_RADIUS (its
    invisible grab radius) is shared with WireTools' own hit-testing — see
    desk/ribbon-path.js. */
const HANDLE_KNOB_RADIUS = 4;

/** The id of the one falloff gradient every fade mask paints its circles with
    (see #fadeDefs) — it is in objectBoundingBox units, so ONE definition
    serves every circle whatever its radius. */
const FADE_GRADIENT_ID = "wire-fade-falloff";

/** Straight-line distance between two world-px points. */
const distance = (p, q) => Math.hypot(q.x - p.x, q.y - p.y);

/** Do two sets hold exactly the same members? */
function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export class WireLayer {
  #svg;
  #doc;
  #onSelect;
  #onContextMenu;
  #onHover;
  #onSelectBus;
  #onBusContextMenu;
  #faded = false; // draw every unselected wire as two fading stubs
  #selectedIds = new Set(); // highlighted wires (one pick, or a marquee)
  #selectedBusIds = new Set(); // highlighted bus bands
  #preview = null; // preview path elements while the wire tool is pending
  #busPreview = null; // preview band while the bus tool is pending
  #endpointDrag = null; // { wireId, end, world:{x,y} px, legal } while dragging an end
  #wholeDrag = null; // { wireId, from:{x,y} px, to:{x,y} px, legal } dragging a whole wire
  #pointDrag = null; // { wireId, index, insert, world:{x,y} px, merge } bending a routed wire
  #busDrag = null; // { busId, memberIds:Set, end:"from"|"to"|null, dx, dy (px), legal } dragging a bus (or one end of it)
  #partDrag = null; // { shifts: Map<wireId, {from?, to? (ADDRESS), points?:{dx,dy}}>, legal } — wires riding a part drag
  #dragShift = []; // [{ el, illegal }] a RIGID bus drag translates — see setBusDrag

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
   * A wire's two endpoints this render, as `{ a, b }` world-px (either null when
   * it doesn't resolve). The ONE place a wire's ends are located, so the main
   * loop and `#busGeometry` cannot read a wire differently — which matters for a
   * part drag whose riding wires are bus members: the leads move, and the ribbon
   * they enter is derived from these same points, so it moves with them.
   *
   * A riding end is stated as the ADDRESS it is landing on, not a cursor point,
   * so the preview resolves through exactly the path the committed wire will.
   */
  #wireEnds(wire, overrides) {
    const shift = this.#partDrag?.shifts.get(wire.id);
    return {
      a: this.#endpointWorld(shift?.from ?? wire.from, overrides),
      b: this.#endpointWorld(shift?.to ?? wire.to, overrides),
    };
  }

  /**
   * Rebuild every wire from the document (documents are small; a full
   * rebuild is simple and correct). `overrides` supplies in-flight board
   * positions during a drag so wires stay glued to their holes live, and
   * `pointRide` the routed waypoints travelling with those same boards (an
   * end is an address and rides for free; a bend is a free coordinate and has
   * to be carried — see DeskDoc.wirePointsOverBoards).
   * @param {Map<string, {x:number,y:number}>} [overrides]
   * @param {{points: Map<string, number[]>, dx:number, dy:number}} [pointRide]
   */
  render(overrides, pointRide) {
    const preview = this.#preview; // survives rebuilds (appended last)
    const busPreview = this.#busPreview;
    const drag = this.#endpointDrag;
    const whole = this.#wholeDrag;
    const busDrag = this.#busDrag;
    // A RIGID whole-bus drag (`end` null) is drawn at its BASE geometry and
    // then translated wholesale (#applyDragShift) — see setBusDrag for why.
    // So its offset must not be baked into any coordinate here; every other
    // use of `busDrag` (the illegal tint, `wire--dragging`, which handle is
    // active) still reads the real spec.
    const rigidBus = Boolean(busDrag && !busDrag.end);
    const busOffset = rigidBus ? null : busDrag;
    clear(this.#svg);
    this.#dragShift = [];
    // The fade masks (one per faded wire) live in a <defs> made on demand —
    // nothing to carry when the toggle is off, which is the usual case.
    let defs = null;

    // Snapshot the doc arrays ONCE — the getters copy on every access.
    const wires = this.#doc.wires;
    const buses = this.#doc.buses;
    const wiresById = new Map(wires.map((w) => [w.id, w]));

    // Each bus renders in THREE passes, in this order, for two independent
    // reasons — one about hit-testing priority, one purely visual:
    //   1. hit stroke (this loop, first) — below the member wires, so an
    //      individual lead's own hit stroke still wins wherever the two
    //      overlap (WireTools' endpoint grab takes priority there); the band
    //      catches clicks only in the gaps between leads.
    //   2. member wires (the main loop below) — each one's collar-side end is
    //      its own SPREAD point (#busGeometry's spreadA/spreadB), not one
    //      shared point, so the leads fan out evenly across the ribbon's own
    //      width instead of all converging to a single vertex.
    //   3. the visible ribbon body (bandCovers, appended AFTER every wire) —
    //      paints OVER the base of every lead, right where the spread points
    //      meet the collar line, so the leads read as entering a solid body
    //      instead of just touching its edge — real IDC ribbon cable.
    //   4. any SELECTED wire, lifted over everything drawn so far (`raised`).
    // Highlighting a wire is how you TRACE one, so the highlighted wire draws
    // last: on a dense board a run disappears under the dozen wires laid after
    // it, and the pick that was supposed to point it out is the very thing
    // buried. It matters most for a bus lead, which is only ~a collar setback
    // long and had the ribbon body painted over nearly all of it, but a loose
    // wire crossing under six others has the same problem. SVG has no
    // z-index, so "on top" is DOM order and a selection change has to
    // re-render (setSelectedMany). Deselecting drops every wire straight back
    // into its document-order slot, since order here is DERIVED per render,
    // never mutated in place.
    // End handles render LAST of all (topmost — a smaller, more specific
    // target should never lose to whatever's drawn on top of it), which is
    // also why `raised` goes UNDER them rather than truly last: what hid the
    // selection is the ribbon body, which is pointer-inert, so lifting a wire
    // over it costs nothing — lifting it over the handles too would hand a
    // member's hit stroke priority over the handle at the collar, the exact
    // ambiguity WireTools#nearOwnBusHandle exists to settle.
    // While FADED only the collars survive that: the leads still aim at where
    // the ribbon runs, but the band, the body and the handles are all put away
    // (`ribbons` below), so there is nothing left to paint over a lead or to
    // grab the bus by.
    const ribbons = !this.#faded;
    const wireCollars = new Map(); // wireId -> { collarA, collarB } (spread, not shared)
    const bandCovers = [];
    const endHandles = [];
    const raised = [];
    for (const bus of buses) {
      const geo = this.#busGeometry(bus, overrides, busOffset, wiresById);
      if (!geo) continue;
      bus.members.forEach((wid, i) => {
        wireCollars.set(wid, {
          collarA: geo.spreadA[i] ?? geo.collarA,
          collarB: geo.spreadB[i] ?? geo.collarB,
        });
      });
      if (!ribbons) continue; // faded: leads only
      const off = busDrag && busDrag.busId === bus.id ? busDrag : null;
      const shifts = rigidBus && off ? this.#dragShift : null;
      const bandHit = this.#buildBandHit(bus, geo);
      const bandCover = this.#buildBandCover(bus, geo, busDrag);
      const handles = [
        this.#buildEndHandle(bus, "from", geo.collarA, off),
        this.#buildEndHandle(bus, "to", geo.collarB, off),
      ];
      shifts?.push(
        { el: bandHit, illegal: null },
        { el: bandCover, illegal: "bus-band--illegal" },
        ...handles.map((el) => ({ el, illegal: null })),
      );
      this.#svg.append(bandHit);
      bandCovers.push(bandCover);
      endHandles.push(...handles);
    }

    for (const wire of wires) {
      // #wireEnds already applies a part drag's riding shift (by address).
      let { a, b } = this.#wireEnds(wire, overrides);
      // A dragged endpoint follows the cursor (world px) instead of its hole;
      // a whole-wire drag overrides BOTH ends (rigid translation); a whole-bus
      // drag rigidly offsets every member wire.
      const draggingEnd = drag && drag.wireId === wire.id;
      const draggingWhole = whole && whole.wireId === wire.id;
      const draggingBus = busDrag && busDrag.memberIds.has(wire.id);
      const ridingPart = Boolean(this.#partDrag?.shifts.has(wire.id));
      if (draggingEnd) {
        if (drag.end === "from") a = drag.world;
        else b = drag.world;
      } else if (draggingWhole) {
        a = whole.from;
        b = whole.to;
      } else if (draggingBus && busOffset) {
        // An end-handle drag offsets only the end it grabbed — the other stays
        // put. (A whole-bus drag offsets both, but rigidly, so it's applied as
        // one transform after the fact instead — see rigidBus above.)
        const moveA = !busOffset.end || busOffset.end === "from";
        const moveB = !busOffset.end || busOffset.end === "to";
        if (moveA && a) a = { x: a.x + busOffset.dx, y: a.y + busOffset.dy };
        if (moveB && b) b = { x: b.x + busOffset.dx, y: b.y + busOffset.dy };
      }
      if (!a || !b) continue; // defensive: normalize prevents danglers
      // A bus member draws as two short leads off the ribbon's collars (see
      // #busGeometry) rather than one full run — the shared trunk carries the
      // middle, so only the last stretch into each hole needs its own path.
      const collars = wireCollars.get(wire.id);
      const selected = this.#selectedIds.has(wire.id);
      const leads =
        collars &&
        `${wirePath(collars.collarA, a)} ${wirePath(collars.collarB, b)}`;
      // A ROUTED wire is the straight run through its own waypoints (plus the
      // one being dragged, live) instead of the sagging curve. A BUS MEMBER is
      // never routed however it is set: its middle belongs to the ribbon, so
      // its two leads win — which is also why the ribbon and the routing never
      // have to agree about anything.
      const route =
        !collars && wire.layout === "routed"
          ? this.#routeGeometry(wire, a, b, pointRide)
          : null;
      // Faded (setFaded), unless this wire is picked — a selected wire is
      // deliberately shown whole. A bus member keeps the very leads it already
      // had, so it still points at the ribbon; every other wire is cut back to
      // a stub off each end. Either way a mask fades each end out over a circle
      // around its own hole, sized to how much wire runs off that end.
      let d = leads || (route ? polylinePath(route.points) : wirePath(a, b));
      let fadeEnds = null;
      if (this.#faded && !selected) {
        if (collars) {
          fadeEnds = [
            { ...a, r: fadeRadius(distance(a, collars.collarA)) },
            { ...b, r: fadeRadius(distance(b, collars.collarB)) },
          ];
        } else {
          const fade = route ? fadedPolyline(route.points) : fadedWire(a, b);
          d = fade.d;
          fadeEnds = [
            { ...a, r: fade.radius },
            { ...b, r: fade.radius },
          ];
        }
      }

      const group = svgEl("g", { class: "wire" });
      if (fadeEnds) {
        defs ??= this.#fadeDefs();
        group.setAttribute(
          "mask",
          `url(#${this.#appendFadeMask(defs, wire.id, fadeEnds)})`,
        );
      }
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
      if (route) {
        group.classList.add("wire--routed");
        group.append(...this.#buildRoutePoints(route));
      }
      // While dragging (one end or the whole wire), mute the hit stroke
      // (pointer is captured) and tint the wire red over an illegal drop,
      // mirroring the rubber band.
      if (
        draggingEnd ||
        draggingWhole ||
        draggingBus ||
        ridingPart ||
        route?.dragging
      ) {
        group.classList.add("wire--dragging");
        // A waypoint drag has no legality to show: a bend lands wherever it is
        // let go (it is not a connection), so it never tints.
        const legal = draggingEnd
          ? drag.legal
          : draggingWhole
            ? whole.legal
            : ridingPart
              ? this.#partDrag.legal
              : (busDrag?.legal ?? true);
        group.classList.toggle("wire-preview--illegal", legal === false);
      }
      group.classList.toggle("wire--selected", selected);
      group.addEventListener("click", (e) => this.#onSelect?.(wire.id, e));
      group.addEventListener("contextmenu", (e) =>
        this.#onContextMenu?.(wire.id, e),
      );
      group.addEventListener("pointerenter", () => this.#onHover?.(wire.id));
      group.addEventListener("pointerleave", () => this.#onHover?.(null));
      if (draggingBus && rigidBus) {
        this.#dragShift.push({ el: group, illegal: "wire-preview--illegal" });
      }
      // A HIGHLIGHTED wire is held back and re-appended over everything else
      // (pass 4 above); every other wire keeps its document-order slot.
      if (selected) raised.push(group);
      else this.#svg.append(group);
    }
    for (const cover of bandCovers) this.#svg.append(cover);
    for (const group of raised) this.#svg.append(group);
    for (const handle of endHandles) this.#svg.append(handle);
    if (busPreview) this.#svg.append(busPreview);
    if (preview) this.#svg.append(preview);
    if (rigidBus) this.#applyDragShift(busDrag);
  }

  /**
   * One routed wire's live geometry: the full point list it draws through
   * (world px — `a`, its waypoints, `b`), which of those waypoints is being
   * dragged, and whether that drag is currently over a merge target.
   *
   * The in-flight waypoint is folded in HERE rather than written to the
   * document, so a drag previews at full speed and an abandoned one leaves
   * nothing behind: an INSERT drag shows the point that would be added, a move
   * drag shows the existing one where the cursor is.
   */
  #routeGeometry(wire, a, b, pointRide) {
    const drag = this.#pointDrag?.wireId === wire.id ? this.#pointDrag : null;
    // A wire riding a part drag by BOTH ends translates rigidly, bend and all —
    // the shift is in desk units, like the stored waypoints themselves.
    const ride = this.#partDrag?.shifts.get(wire.id)?.points;
    // A BOARD drag carries only the bends drawn over the strips it is moving,
    // so that one is per point rather than per wire (at most MAX_WIRE_POINTS
    // of them, hence the linear lookup).
    const carried = pointRide?.points.get(wire.id);
    const points = (wire.points ?? []).map((p, i) => {
      const over = carried?.includes(i);
      return {
        x: (p.x + (ride?.dx ?? 0) + (over ? pointRide.dx : 0)) * PX_PER_UNIT,
        y: (p.y + (ride?.dy ?? 0) + (over ? pointRide.dy : 0)) * PX_PER_UNIT,
      };
    });
    let active = -1;
    if (drag) {
      if (drag.insert && drag.index <= points.length) {
        points.splice(drag.index, 0, { ...drag.world });
        active = drag.index;
      } else if (!drag.insert && drag.index < points.length) {
        points[drag.index] = { ...drag.world };
        active = drag.index;
      }
    }
    return {
      points: [a, ...points, b],
      active,
      merging: Boolean(drag?.merge),
      dragging: Boolean(drag),
    };
  }

  /** The knobs on a routed wire's waypoints — one per interior point of its
      run. `--active` is the one under the cursor mid-drag (a captured pointer
      wanders off its own knob, so CSS :hover can't say it); `--merging` says
      that releasing it now drops it into whatever it is sitting on. */
  #buildRoutePoints(route) {
    return route.points.slice(1, -1).map((p, i) =>
      svgEl("circle", {
        class:
          "wire-point" +
          (i === route.active ? " wire-point--active" : "") +
          (i === route.active && route.merging ? " wire-point--merging" : ""),
        cx: p.x,
        cy: p.y,
        r: POINT_KNOB_RADIUS,
      }),
    );
  }

  /**
   * The `<defs>` every fade mask lives in, holding the ONE falloff gradient
   * they all paint with: opaque white out to FADE_SOLID_FRACTION of the way,
   * then ramping to fully transparent at the rim. It is in objectBoundingBox
   * units, so the same definition serves a circle of any radius — the fade is
   * always the same shape, just scaled.
   *
   * The stops go transparent rather than black on purpose: a mask's shapes
   * composite source-over, so two overlapping circles (a wire short enough for
   * its two ends to meet) ADD up to a union instead of the later one punching
   * a hole through the earlier.
   */
  #fadeDefs() {
    const defs = svgEl("defs");
    const gradient = svgEl("radialGradient", { id: FADE_GRADIENT_ID });
    gradient.append(
      svgEl("stop", { offset: 0, "stop-color": "#fff" }),
      svgEl("stop", { offset: FADE_SOLID_FRACTION, "stop-color": "#fff" }),
      svgEl("stop", { offset: 1, "stop-color": "#fff", "stop-opacity": 0 }),
    );
    defs.append(gradient);
    this.#svg.append(defs);
    return defs;
  }

  /**
   * Build one wire's fade mask into `defs` and return its id: one falloff
   * circle per `ends` entry ({x, y, r}), so the wire shows only within `r` of
   * that hole — in EVERY direction, which is what lets a bus member's lead
   * point off at the ribbon and still fade cleanly. It masks the whole
   * `g.wire`, so outline, core, and end caps ramp away together, and the caps
   * (right on the holes, where the mask is solid) survive.
   *
   * Ids are keyed by wire id, so a rebuild replaces its own mask rather than
   * piling up (`clear()` empties the whole svg first either way).
   */
  #appendFadeMask(defs, wireId, ends) {
    const maskId = `wire-fade-${wireId}`;
    // Only what a circle covers can show, so the mask region is just their
    // bounds (+1 for rounding) — no need to reach around the wire itself.
    const box = {
      x: Math.min(...ends.map((e) => e.x - e.r)) - 1,
      y: Math.min(...ends.map((e) => e.y - e.r)) - 1,
    };
    box.width = Math.max(...ends.map((e) => e.x + e.r)) + 1 - box.x;
    box.height = Math.max(...ends.map((e) => e.y + e.r)) + 1 - box.y;
    const mask = svgEl("mask", {
      id: maskId,
      maskUnits: "userSpaceOnUse",
      ...box,
    });
    for (const end of ends) {
      mask.append(
        svgEl("circle", {
          cx: end.x,
          cy: end.y,
          r: end.r,
          fill: `url(#${FADE_GRADIENT_ID})`,
        }),
      );
    }
    defs.append(mask);
    return maskId;
  }

  /**
   * Move a rigid whole-bus drag's already-rendered nodes to the current
   * offset — the fast path setBusDrag takes for every pointermove after the
   * first. Only the transform and the illegal tint can change between moves;
   * the geometry underneath is the bus's base position, untouched.
   */
  #applyDragShift(spec) {
    const transform = `translate(${spec.dx} ${spec.dy})`;
    for (const { el, illegal } of this.#dragShift) {
      el.setAttribute("transform", transform);
      if (illegal) el.classList.toggle(illegal, spec.legal === false);
    }
  }

  /**
   * A bus's live geometry this render: the centroid of its resolvable
   * members' `from`/`to` endpoints (`A`/`B`, honoring board-drag `overrides`
   * and a whole-bus drag offset), the ribbon's own drawn `width`, its collar
   * points (where the flat body ends), and — per member, in bit order — the
   * evenly spread attachment points across that width (`spreadA`/`spreadB`,
   * see desk/ribbon-path.js) that each member's own lead actually starts
   * from, instead of every lead converging on one shared point. Null for a
   * bus whose members don't currently resolve (all danglers).
   */
  #busGeometry(bus, overrides, busDrag, wiresById) {
    if (bus.members.length === 0) return null;
    const off = busDrag && busDrag.busId === bus.id ? busDrag : null;
    const froms = [];
    const tos = [];
    for (const wid of bus.members) {
      const wire = wiresById.get(wid);
      if (!wire) continue;
      // Through #wireEnds, so a member riding a part drag carries the ribbon
      // with it — a bus is metadata over wires, and this is where that pays.
      let { a, b } = this.#wireEnds(wire, overrides);
      if (!a || !b) continue;
      if (off) {
        if (!off.end || off.end === "from")
          a = { x: a.x + off.dx, y: a.y + off.dy };
        if (!off.end || off.end === "to")
          b = { x: b.x + off.dx, y: b.y + off.dy };
      }
      froms.push(a);
      tos.push(b);
    }
    if (froms.length === 0) return null;
    const A = centroid(froms);
    const B = centroid(tos);
    const width = ribbonWidth(bus.members.length);
    return {
      A,
      B,
      width,
      ...ribbonLayout(A, B),
      ...ribbonSpread(A, B, width, bus.members.length),
    };
  }

  /**
   * One bus's INTERACTIVE hit surface: a wide, invisible stroke spanning the
   * FULL A→B corridor (not collar-limited — flared ends included), so
   * grabbing the bus works anywhere along it. Rendered EARLY, before the
   * member wires, so an individual lead's own hit stroke still wins wherever
   * the two overlap (WireTools' endpoint grab takes priority there). The
   * VISIBLE ribbon is a separate group, #buildBandCover, rendered later.
   */
  #buildBandHit(bus, geo) {
    const g = svgEl("g", { class: "bus-band" });
    g.dataset.busId = bus.id;
    g.append(
      svgEl("path", { class: "bus-band-hit", d: wirePath(geo.A, geo.B) }),
    );
    g.addEventListener("click", (e) => this.#onSelectBus?.(bus.id, e));
    g.addEventListener("contextmenu", (e) =>
      this.#onBusContextMenu?.(bus.id, e),
    );
    return g;
  }

  /**
   * One bus's VISIBLE ribbon: the flat body between its collar points.
   * Rendered AFTER every wire (see render()) so it paints OVER the base of
   * each member's lead, right where the spread points meet the collar line —
   * real IDC ribbon cable reads as conductors entering a solid body, not
   * just touching its edge. Purely decorative (every child is
   * pointer-events:none in app.css), so it carries no listeners of its own —
   * `#buildBandHit` already owns the click/contextmenu surface. Carries the
   * bus name at its midpoint; `busDrag` tints it red while an illegal drag
   * of the whole bus, or one end, is in flight.
   */
  #buildBandCover(bus, geo, busDrag) {
    const { A, B, width, trunk } = geo;
    const off = busDrag && busDrag.busId === bus.id ? busDrag : null;

    const g = svgEl("g", { class: "bus-band" });
    g.dataset.busId = bus.id;
    g.style.setProperty("--wire-color", `var(--color-wire-${bus.color})`);
    g.style.setProperty("--ribbon-width", width);
    g.classList.toggle("bus-band--selected", this.#selectedBusIds.has(bus.id));
    if (off) g.classList.toggle("bus-band--illegal", off.legal === false);
    // A run shorter than twice the collar setback has no distinct trunk to
    // show — the flared leads alone already read fine at that length, so the
    // ribbon body is skipped, not degenerate.
    if (trunk) {
      g.append(
        svgEl("path", { class: "bus-band-outline", d: trunk }),
        svgEl("path", { class: "bus-band-fill", d: trunk }),
      );
    }
    const label = svgEl("text", {
      class: "bus-band-label",
      x: (A.x + B.x) / 2,
      // The quadratic's t=0.5 point hangs half the sag below the chord.
      y: (A.y + B.y) / 2 + wireSag(A, B) / 2,
    });
    label.textContent = bus.name;
    g.append(label);
    return g;
  }

  /**
   * One end's grab handle: an invisible widened hit circle (always live) plus
   * a small knob that only shows on hover — CSS `:hover` on the group — or
   * while THIS end is the one actively being dragged (`--active`, since a
   * captured pointer can wander off the tiny hit circle mid-drag without CSS
   * hover following it). Grabbing and dragging it moves every member's lead
   * on that end only, in parallel — see BusTools' end-drag gesture.
   */
  #buildEndHandle(bus, end, point, off) {
    const h = svgEl("g", { class: "bus-end-handle" });
    h.dataset.busId = bus.id;
    h.dataset.end = end;
    h.classList.toggle(
      "bus-end-handle--active",
      Boolean(off) && off.end === end,
    );
    h.append(
      svgEl("circle", {
        class: "bus-end-handle-hit",
        cx: point.x,
        cy: point.y,
        r: HANDLE_HIT_RADIUS,
      }),
      svgEl("circle", {
        class: "bus-end-handle-knob",
        cx: point.x,
        cy: point.y,
        r: HANDLE_KNOB_RADIUS,
      }),
    );
    return h;
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

  /**
   * Live-preview a routed wire's waypoint being dragged (the bend gesture):
   * `index` is the waypoint's own index — the one being MOVED, or, with
   * `insert`, the position a new one would take. `merge:true` shows it landing
   * on a neighbour (releasing there takes the bend back out). Pass null to
   * stop and redraw from the document.
   * @param {{wireId:string, index:number, insert?:boolean,
   *   world:{x:number,y:number}, merge?:boolean}|null} spec
   */
  setPointDrag(spec) {
    this.#pointDrag = spec;
    this.render();
  }

  /**
   * Live-preview the wires RIDING a part drag (Feature 290's Option-drag): each
   * entry restates the end(s) that move as the ADDRESS they are landing on, plus
   * a desk-unit `points` shift for a routed wire riding by both ends. One
   * `legal` covers the lot, because the drop is all-or-nothing — the same red
   * the dragged part itself shows. Pass null to stop and redraw from the
   * document.
   *
   * Unlike the single-wire channels above this one names MANY wires, which is
   * what a part carries; the ends are addresses rather than cursor points
   * because a riding end always lands in a hole (see #wireEnds). It is keyed by
   * WIRE, so a whole SELECTION of parts dragged together merges into one map
   * with nothing to change here.
   *
   * `overrides` rides along for the one thing an address can't express: a wire
   * ending on a moving BRICK's terminal (`psu1.+`) is anchored to the component
   * rather than to a hole, so it follows a position override instead of a new
   * address. A cluster can carry both at once, hence one call.
   *
   * @param {{shifts: Map<string, {from?:string, to?:string,
   *   points?:{dx:number,dy:number}}>, legal?:boolean}|null} spec
   * @param {Map<string, {x:number,y:number}>|null} [overrides] - live positions
   */
  setPartDrag(spec, overrides = null) {
    // idle → idle: nothing to redraw
    if (!spec && !this.#partDrag && !overrides) return;
    this.#partDrag = spec;
    this.render(overrides ?? undefined);
  }

  /** Are wires drawn as fading stubs? */
  get faded() {
    return this.#faded;
  }

  /**
   * Fade every wire back to a short stub off each end (true), or draw them in
   * full (false) — the toolbar's "Fade wires" toggle. A selected wire stays
   * whole either way, and a bus keeps its members' leads but loses its ribbon;
   * see the note at the top of the file.
   */
  setFaded(on) {
    const next = Boolean(on);
    if (next === this.#faded) return;
    this.#faded = next;
    this.render();
  }

  /** Highlight one wire (null clears). Survives re-renders. */
  setSelected(id) {
    this.setSelectedMany(id == null ? [] : [id]);
  }

  /** Highlight a SET of wires (marquee selection); empty clears. */
  setSelectedMany(ids) {
    const next = new Set(ids);
    if (sameSet(this.#selectedIds, next)) return;
    this.#selectedIds = next;
    // A selection change is more than a class toggle here — it is a change of
    // PAINT ORDER (render lifts every highlighted wire last, and dropping the
    // highlight puts it back in document order), and while FADED it is a
    // change of GEOMETRY too (the stub path and its mask come off, so the
    // whole run shows and the whole run is clickable again). Both are derived
    // per render, so a re-render is the only way to apply either — and one
    // per click/marquee gesture is what this costs.
    this.render();
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
   * Live-preview a bus dragged rigidly by a world-px offset: every member
   * wire AND the ribbon shift by (dx, dy) — both ends when `end` is null (the
   * whole-bus grab), or just that one end's leads (the end-handle grab, the
   * other end staying put). `legal:false` tints them. Pass null to stop and
   * redraw from the document.
   * @param {{busId:string, memberIds:Set<string>, end?:"from"|"to"|null, dx:number, dy:number, legal?:boolean}|null} spec
   */
  setBusDrag(spec) {
    const prev = this.#busDrag;
    this.#busDrag = spec;
    // A RIGID whole-bus drag (`end` null) translates its ribbon and every one
    // of its member wires by the SAME delta, and every path this layer draws
    // is translation-invariant (wireSag depends on the run, not on where it
    // sits) — so once the bus is rendered at its base geometry, each further
    // pointermove is a transform on a handful of groups instead of a full
    // rebuild of every wire in the document. That rebuild — on every move,
    // for the whole doc, listeners and all — was the dominant per-move cost
    // of a wide bus's drag, and why the live preview fell behind the cursor.
    //
    // An END-HANDLE drag moves one side only, which shifts the ribbon's
    // centroid and so reshapes every lead at BOTH ends; no transform can
    // express that, so it keeps re-rendering.
    if (
      spec &&
      prev &&
      !spec.end &&
      !prev.end &&
      spec.busId === prev.busId &&
      this.#dragShift.length > 0
    ) {
      this.#applyDragShift(spec);
      return;
    }
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
