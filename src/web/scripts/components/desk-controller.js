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

// desk-controller.js — the single owner of everything ON the desk: it holds
// the in-memory DeskDoc, creates the four surface layers (boards → parts →
// wires → overlay), mounts/removes the board/part/PSU views + the wire
// layer, and runs the desk interactions — placement modes with snapping
// ghosts (boards, chips, discretes, PSU bricks), the click-click wire tool,
// select / drag / delete for everything, right-click menus, and hover
// addressing for holes, part pins, and PSU terminals (holeAt / derived-pin
// math — never per-hole or per-pin DOM). Every document mutation flows
// through desk-doc and is announced with a `chiphippo:doc-changed`
// CustomEvent; interactive part state (switch flips) also announces
// `chiphippo:part-state`.
//
// Views report gestures through constructor callbacks (house rule); the
// camera stays DeskView's job — this class only reads worldFromEvent/camera.

import { clear, el } from "../dom.js";
import { PopupManager } from "../popup-manager.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import {
  ROTATIONS,
  boardSize,
  columnAt,
  holePosition,
  parseHole,
  spec,
} from "../model/breadboard.js";
import { holeAtWorld } from "../model/occupancy.js";
import { partSeatAt } from "../model/seating.js";
import {
  addressWorld,
  componentsInRect,
  hoverHitAt,
  partPinsWorld,
  wiresInRect,
} from "../model/part-geometry.js";
import { DeskDoc } from "../model/desk-doc.js";
import { partDef } from "../catalog/index.js";
import { PSU_VOLTS, CLOCK_HZ } from "../catalog/parts.js";
import {
  BreadboardView,
  applyBoardRotation,
  buildBoardSvg,
} from "./breadboard-view.js";
import { ChipView, buildChipSvg, chipBox } from "./chip-view.js";
import {
  DiscreteView,
  buildDiscreteSvg,
  buildSpanSvg,
  discreteBox,
  spanPad,
} from "./discrete-view.js";
import { PsuView, buildPsuSvg } from "./psu-view.js";
import { ClockView, buildClockSvg } from "./clock-view.js";
import { WireLayer } from "./wire-layer.js";
import { SimOverlay } from "./sim-overlay.js";
import { ProbeInspector } from "./probe-inspector.js";
import { WireTools } from "./wire-tools.js";
import { BoardOutline } from "./board-outline.js";

/** Pointer travel (px) below which a press stays a click, not a drag/pan. */
const DRAG_THRESHOLD = 4;

/** Hover addressing: dwell before the ring/tooltip shows, and the zoom floor
    below which holes are too small for hover to mean anything. */
const HOVER_DWELL_MS = 150;
const HOVER_MIN_ZOOM = 0.75;

/** Radius of the hover ring (pitch units — a shade over one hole). */
const RING_RADIUS = 0.45;

/** How close (pitch units) the cursor must press to a wire's endpoint cap to
    grab it for a drag-the-end gesture. A shade over one hole so the cap is
    forgiving to catch, but under the ~1-pitch hole spacing so an adjacent
    endpoint isn't grabbed by mistake. */
const WIRE_END_GRAB_RADIUS = 0.6;

export class DeskController {
  #viewport;
  #deskView;
  #doc;
  #layers;
  #views = new Map(); // boardId → BreadboardView
  #partViews = new Map(); // componentId → ChipView | DiscreteView | PsuView
  #wireLayer;
  #selected = null; // { kind: "board"|"part"|"wire", id } | null
  #copyBuffer = null; // { ref, params } of the last Cmd+C'd component | null
  // Active interaction: null, or
  //   { kind: "place", type, ghost, pos, legal }              (board)
  //   { kind: "place-chip", ref, ghost, board, anchor, legal }
  //   { kind: "place-part", ref, params, ghost, board, anchor, legal }
  //   { kind: "place-brick", ref, params, ghost, pos, legal }   (PSU / clock)
  //   { kind: "drag", id, … }                                 (board drag)
  //   { kind: "drag-part", id, … }                            (chip/discrete)
  //   { kind: "drag-brick", id, … }
  //   { kind: "wire", from, hover }                           (wire tool)
  #mode = null;
  #wire; // WireTools: the wire tool + endpoint/whole-wire drags (shares #mode)
  #lastDown = null; // last viewport pointerdown client pos (click-vs-pan)
  #hoverKey = null; // hover identity currently shown or pending
  #hoverTimer = null;
  #ring;
  #tooltip;
  #boardOutline; // the selection highlighter around a whole snapped set
  #probe; // ProbeInspector: netlist highlight + net-status readout
  // Simulation (Feature 90): editing is locked while running; live net levels
  // arrive over chiphippo:sim-state and drive LEDs / chip badges / probe tint.
  #editingLocked = false;
  #multi = new Set(); // component ids from a marquee selection
  #multiWires = new Set(); // wire ids from the same marquee
  #marquee = null; // the rubber-band element while shift-dragging
  #simOverlay; // live LEDs / badges / clock lamps + net-level lookups
  #onReplaceChip;
  #onClockToggle;
  #onOpenPinout;

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.viewport - the `.desk-viewport` element.
   * @param {object} opts.deskView - DeskView (or a stub with `surface`,
   *   `camera`, and `worldFromEvent(e)`).
   * @param {import('../model/desk-doc.js').DeskDoc} opts.deskDoc
   * @param {(state: {armed: boolean, color: string}) => void}
   *   [opts.onWireStateChange] - wire-tool arm/disarm/color changes (drives
   *   the toolbar button + swatch strip).
   * @param {(state: {armed: boolean}) => void} [opts.onProbeStateChange] -
   *   probe-tool arm/disarm (drives the toolbar probe button).
   * @param {(id: string) => void} [opts.onReplaceChip] - the chip context
   *   menu's "Replace chip" (resets Feature 90 damage).
   * @param {(id: string) => void} [opts.onClockToggle] - a manual clock's
   *   click-to-toggle while running (Feature 100).
   * @param {(ref: string) => void} [opts.onOpenPinout] - double-clicking a chip
   *   requests its pin-assignments window (main opens a native OS window).
   */
  constructor({
    viewport,
    deskView,
    deskDoc,
    onWireStateChange,
    onProbeStateChange,
    onReplaceChip,
    onClockToggle,
    onOpenPinout,
  }) {
    this.#viewport = viewport;
    this.#deskView = deskView;
    this.#doc = deskDoc;
    this.#onReplaceChip = onReplaceChip;
    this.#onClockToggle = onClockToggle;
    this.#onOpenPinout = onOpenPinout;

    // Layer order (established for every later stage): boards under parts
    // under wires under the interaction overlay. All are zero-size anchors —
    // children position absolutely in world px.
    const surface = deskView.surface;
    this.#layers = {
      boards: el("div", { class: "layer-boards" }),
      parts: el("div", { class: "layer-parts" }),
      wires: el("div", { class: "layer-wires" }),
      overlay: el("div", { class: "layer-overlay" }),
    };
    surface.append(
      this.#layers.boards,
      this.#layers.parts,
      this.#layers.wires,
      this.#layers.overlay,
    );

    // Hover ring + address tooltip live in the overlay (inert to pointers).
    this.#ring = el("div", { class: "hole-ring", hidden: true });
    this.#tooltip = el("div", { class: "desk-tooltip", hidden: true });
    this.#layers.overlay.append(this.#ring, this.#tooltip);

    // Board selection is drawn as ONE path around the whole snapped set.
    this.#boardOutline = new BoardOutline(this.#layers.overlay);

    // All wires render into one SVG in the wires layer.
    this.#wireLayer = new WireLayer(this.#layers.wires, deskDoc, {
      onSelect: (id) => this.selectWire(id),
      onContextMenu: (id, e) => this.#wire.onContextMenu(id, e),
      onHover: (id) => this.#probe.onWireHover(id),
    });

    // Live simulation state (Feature 90): LEDs, chip badges, clock lamps —
    // and the net-level lookups the probe tints with. Renders from published
    // state, never the engine.
    this.#simOverlay = new SimOverlay(this.#doc, this.#partViews);

    // Connectivity inspector (Feature 70): owns its netlist cache + net
    // highlight; borrows the shared hover ring and the controller's geometry.
    this.#probe = new ProbeInspector({
      doc: deskDoc,
      overlay: this.#layers.overlay,
      viewport,
      ring: this.#ring,
      simOverlay: this.#simOverlay,
      hitTest: (world) => this.#hitTest(world),
      addressWorld: (address) => this.#addressWorld(address),
      onStateChange: onProbeStateChange,
      coordinate: {
        cancelPlacement: () => this.cancelPlacement(),
        disarmWireTool: () => this.disarmWireTool(),
        deselect: () => this.deselect(),
        hideHover: () => this.#hideHover(),
      },
    });

    // Wire subsystem (Feature 50): the click-click tool + endpoint/whole-wire
    // drags. It shares the controller's `#mode` through this host so the
    // viewport dispatcher's mode checks are unchanged.
    const self = this;
    this.#wire = new WireTools({
      get mode() {
        return self.#mode;
      },
      set mode(v) {
        self.#mode = v;
      },
      get editingLocked() {
        return self.#editingLocked;
      },
      doc: deskDoc,
      deskView,
      viewport,
      wireLayer: this.#wireLayer,
      ring: this.#ring,
      emitDocChanged: () => this.#emitDocChanged(),
      hideHover: () => this.#hideHover(),
      selectWire: (id) => this.selectWire(id),
      deselect: () => this.deselect(),
      cancelPlacement: () => this.cancelPlacement(),
      disarmProbe: () => this.disarmProbe(),
      clearSelectionIfWire: (id) => this.#clearSelectionIfWire(id),
      onStateChange: onWireStateChange,
    });

    // A pinned net follows its anchor through edits, switch flips, and each
    // sim tick (the probe self-guards when nothing is pinned).
    window.addEventListener("chiphippo:doc-changed", () =>
      this.#probe.refreshPinned(),
    );
    window.addEventListener("chiphippo:part-state", () =>
      this.#probe.refreshPinned(),
    );
    window.addEventListener("chiphippo:sim-state", (e) => {
      this.#simOverlay.apply(e.detail);
      this.#probe.refreshPinned(); // re-tint a pinned net
    });

    for (const board of this.#doc.boards) this.#mountBoard(board);
    for (const component of this.#doc.components) this.#mountPart(component);

    viewport.addEventListener("pointerdown", this.#onViewportPointerDown);
    viewport.addEventListener("pointermove", this.#onViewportPointerMove);
    viewport.addEventListener("pointerleave", () => this.#hideHover());
    viewport.addEventListener("click", this.#onViewportClick);
    // Right-click while wiring cancels the pending wire (Esc-equivalent).
    viewport.addEventListener("contextmenu", (e) => {
      if (!this.#wire.armed) return;
      e.preventDefault();
      this.#wire.cancelPending();
    });
  }

  get selectedId() {
    return this.#selected?.id ?? null;
  }

  get placementArmed() {
    return ["place", "place-chip", "place-part", "place-brick"].includes(
      this.#mode?.kind,
    );
  }

  // ── Selection (boards, parts, and wires share one slot) ─────────────────

  #applySelection(sel, on) {
    if (!sel) return;
    if (sel.kind === "board") this.#views.get(sel.id)?.setSelected(on);
    else if (sel.kind === "part") this.#partViews.get(sel.id)?.setSelected(on);
    else this.#wireLayer.setSelected(on ? sel.id : null);
  }

  #select(sel) {
    // A single pick always replaces a marquee selection.
    if (sel && this.#multiSize()) this.#clearMultiSelection();
    if (this.#selected?.id === sel?.id && this.#selected?.kind === sel?.kind) {
      return;
    }
    this.#applySelection(this.#selected, false);
    this.#selected = sel;
    this.#applySelection(this.#selected, true);
    this.#refreshBoardOutline();
  }

  /** A board's world-px box, at an overridden position while dragging. */
  #boardRect(board, pos) {
    const size = boardSize(board.type, board.rot ?? 0);
    return {
      x: (pos?.x ?? board.x) * PX_PER_UNIT,
      y: (pos?.y ?? board.y) * PX_PER_UNIT,
      width: size.width * PX_PER_UNIT,
      height: size.height * PX_PER_UNIT,
    };
  }

  /**
   * Re-draw the board highlighter around the OUTER edge of every strip the
   * grab would move — the whole snapped group, or the one-way chain an Option
   * grab tore off — never the single strip that was clicked. Positions come
   * from `overrides` mid-drag, from the document otherwise.
   *
   * @param {Map<string, {x:number,y:number}>|null} [overrides]
   */
  #refreshBoardOutline(overrides = null) {
    const drag = this.#mode?.kind === "drag" ? this.#mode : null;
    let ids = [];
    if (drag) ids = drag.members.map((m) => m.id);
    else if (this.#selected?.kind === "board") {
      ids = this.#doc.groupMembers(this.#selected.id).map((b) => b.id);
    }
    const rects = [];
    for (const id of ids) {
      const board = this.#doc.getBoard(id);
      if (board) rects.push(this.#boardRect(board, overrides?.get(id)));
    }
    this.#boardOutline.show(rects, drag ? !drag.legal : false);
  }

  /** The component ids currently marquee-selected (empty when none). */
  get multiSelectedIds() {
    return [...this.#multi];
  }

  /** The wire ids currently marquee-selected (empty when none). */
  get multiSelectedWireIds() {
    return [...this.#multiWires];
  }

  #multiSize() {
    return this.#multi.size + this.#multiWires.size;
  }

  #clearMultiSelection() {
    for (const id of this.#multi) {
      this.#partViews.get(id)?.setSelected(false);
    }
    this.#multi.clear();
    if (this.#multiWires.size) {
      this.#multiWires.clear();
      this.#wireLayer.setSelectedMany([]);
    }
  }

  /** Replace the marquee selection; a non-empty one clears the single pick. */
  #setMultiSelection(ids, wireIds = []) {
    this.#clearMultiSelection();
    for (const id of ids) {
      if (!this.#partViews.has(id)) continue;
      this.#multi.add(id);
      this.#partViews.get(id).setSelected(true);
    }
    for (const id of wireIds) {
      if (this.#doc.getWire(id)) this.#multiWires.add(id);
    }
    if (this.#multiWires.size) {
      this.#wireLayer.setSelectedMany(this.#multiWires);
    }
    if (this.#multiSize()) this.#select(null);
  }

  selectBoard(id) {
    this.#select(this.#views.has(id) ? { kind: "board", id } : null);
  }

  selectComponent(id) {
    this.#select(this.#partViews.has(id) ? { kind: "part", id } : null);
  }

  selectWire(id) {
    if (this.#mode) return; // wiring/placing/dragging — clicks aren't selects
    this.#select(this.#doc.getWire(id) ? { kind: "wire", id } : null);
  }

  deselect() {
    this.#clearMultiSelection();
    this.#select(null);
  }

  /** Drop the selection if it is this wire (WireTools calls this on remove). */
  #clearSelectionIfWire(id) {
    if (this.#selected?.kind === "wire" && this.#selected.id === id) {
      this.#selected = null;
      this.#wireLayer.setSelected(null);
    }
  }

  // ── Placement modes (toolbar Add-board / palette picks) ─────────────────

  #enterPlacement(mode) {
    if (this.#editingLocked) return; // topology is frozen while running
    this.cancelPlacement();
    this.disarmWireTool();
    this.disarmProbe();
    this.deselect();
    this.#hideHover();
    this.#mode = mode;
    this.#layers.overlay.append(mode.ghost);
    this.#viewport.classList.add("desk-viewport--placing");
  }

  /**
   * Arm breadboard placement: a translucent ghost of the whole kit — every
   * strip at its preset offset — tracks the cursor.
   */
  armPlacement(kit) {
    // Throws INVALID_TYPE on junk, before any state is touched.
    DeskDoc.kitPlacements(kit, 0, 0);
    const mode = {
      kind: "place",
      kit,
      ghost: el("div", { class: "board-ghost", hidden: true }),
      pos: null,
      legal: false,
      rot: 0,
    };
    this.#renderBoardGhost(mode);
    this.#enterPlacement(mode);
  }

  /**
   * (Re)build the kit ghost at its current rotation — one strip element per
   * strip, each turned exactly as the placed view will be, so what the user
   * sees before the click is what lands after it.
   */
  #renderBoardGhost(m) {
    clear(m.ghost);
    const outline = DeskDoc.kitOutline(m.kit, m.rot);
    // Absolutely positioned strips collapse the box, so size it explicitly —
    // the legal/illegal outline and tint are drawn on this element.
    m.ghost.style.width = `${outline.width * PX_PER_UNIT}px`;
    m.ghost.style.height = `${outline.height * PX_PER_UNIT}px`;
    for (const p of DeskDoc.kitPlacements(m.kit, 0, 0, m.rot)) {
      const strip = el("div", { class: "board-ghost-strip" });
      strip.style.left = `${p.x * PX_PER_UNIT}px`;
      strip.style.top = `${p.y * PX_PER_UNIT}px`;
      strip.append(buildBoardSvg(p.type));
      applyBoardRotation(strip, p.type, p.rot);
      m.ghost.append(strip);
    }
  }

  /**
   * Arm placement for ANY palette pick: chips seat across a trench,
   * discretes along any grid row, PSU bricks on the open desk.
   */
  armPartPlacement(ref, params = {}) {
    const def = partDef(ref);
    if (!def) {
      const err = new Error(`unknown catalog ref: ${ref}`);
      err.code = "INVALID_REF";
      throw err;
    }
    // Only true chips render + flip as a slab; a display that happens to seat in
    // a DIP footprint (the isolated bar array) still places as a discrete — its
    // trench-straddling geometry comes from `def.package` in seating/occupancy.
    if (def.kind === "chip") {
      this.armChipPlacement(ref, params);
      return;
    }
    const normalized = def.normalizeParams ? def.normalizeParams(params) : {};
    const ghost = el("div", { class: "part-ghost", hidden: true });
    if (def.kind === "psu" || def.kind === "clock") {
      ghost.append(
        def.kind === "psu"
          ? buildPsuSvg(normalized)
          : buildClockSvg(normalized),
      );
      this.#enterPlacement({
        kind: "place-brick",
        ref,
        params: normalized,
        ghost,
        pos: null,
        legal: false,
      });
    } else {
      ghost.append(buildDiscreteSvg(ref, normalized));
      this.#enterPlacement({
        kind: "place-part",
        ref,
        params: normalized,
        ghost,
        board: null,
        anchor: null,
        legal: false,
      });
    }
  }

  /**
   * Arm chip placement (palette or a Cmd+V duplicate): ghost seats across a
   * trench. `params` carries the copied chip's orientation so a pasted chip
   * lands flipped exactly as its source; the palette passes none.
   */
  armChipPlacement(ref, params = {}) {
    const def = partDef(ref);
    if (!def?.package) {
      const err = new Error(`unknown chip ref: ${ref}`);
      err.code = "INVALID_REF";
      throw err;
    }
    const ghost = el("div", { class: "part-ghost", hidden: true });
    ghost.append(buildChipSvg(ref, params));
    this.#enterPlacement({
      kind: "place-chip",
      ref,
      params,
      ghost,
      board: null,
      anchor: null,
      legal: false,
    });
  }

  cancelPlacement() {
    if (!this.placementArmed) return;
    this.#mode.ghost.remove();
    this.#mode = null;
    this.#viewport.classList.remove("desk-viewport--placing");
    // The two-click resistor uses the hover ring — clear it too (no-op else).
    this.#ring.hidden = true;
    this.#ring.classList.remove("hole-ring--illegal");
  }

  /**
   * Cmd+C: remember the one selected component (chip / discrete / PSU / clock
   * brick) so Cmd+V can drop a fresh duplicate. Only a single selected part
   * copies — a board, a wire, or a multi-selection is ignored (returns false so
   * the native Edit-menu copy still serves text fields). The buffer keeps a
   * deep copy of the params, so later edits to the source never bleed in.
   */
  copySelectedComponent() {
    if (this.#selected?.kind !== "part") return false;
    const comp = this.#doc.getComponent(this.#selected.id);
    if (!comp) return false;
    this.#copyBuffer = {
      ref: comp.ref,
      params: comp.params ? JSON.parse(JSON.stringify(comp.params)) : {},
    };
    return true;
  }

  /**
   * Cmd+V: arm a placement ghost for a duplicate of the copied component so the
   * user just clicks to drop it. The buffer persists, so repeated Cmd+V stamps
   * more copies. Returns false when nothing has been copied. Orientation carries
   * over: a flipped chip pastes flipped, and a rotatable part (LED / resistor)
   * copied in its turned two-free-ends form re-arms with the SAME lead vector —
   * so the drop lands rotated exactly as the source (R still re-spins it).
   */
  pasteComponent() {
    const buf = this.#copyBuffer;
    if (!buf) return false;
    // A fresh duplicate starts pristine — never inherit run-state (12 V) damage.
    const params = { ...buf.params };
    delete params.damaged;
    const def = partDef(buf.ref);
    // Arm rotatable parts in the footprint form first (a safe ghost build); the
    // turned geometry is a live two-free-ends ghost, seeded below.
    const turned = def?.rotatable && buf.params?.rot === 90 && buf.params.end;
    if (def?.rotatable) {
      params.rot = 0;
      params.end = null;
    }
    this.armPartPlacement(buf.ref, params);
    if (turned && this.#mode?.kind === "place-part") {
      this.#mode.turns = 1; // truthy → the turned two-free-ends tracking
      this.#mode.orient = { dx: buf.params.end.dx, dy: buf.params.end.dy };
    }
    return true;
  }

  #trackGhost(e) {
    const kind = this.#mode.kind;
    if (kind === "place") this.#trackBoardGhost(e);
    else if (kind === "place-brick") this.#trackBrickGhost(e);
    else this.#trackSeatedGhost(e);
  }

  #trackBoardGhost(e) {
    const m = this.#mode;
    m.lastEvent = e; // R re-tracks from here, so the ghost spins in place
    const { width, height } = DeskDoc.kitOutline(m.kit, m.rot);
    const w = this.#deskView.worldFromEvent(e);
    // Ghost centered on the cursor, snapped to the integer pitch lattice and
    // then pulled flush onto any board it can dovetail with — so the ghost
    // shows the mate BEFORE the click, not as a surprise after it.
    const { x, y } = this.#pullGhostToMate(
      m.kit,
      Math.round(w.x - width / 2),
      Math.round(w.y - height / 2),
      m.rot,
    );
    m.pos = { x, y };
    m.legal = this.#doc.canPlaceKit(m.kit, x, y, m.rot);
    m.ghost.hidden = false;
    m.ghost.style.left = `${x * PX_PER_UNIT}px`;
    m.ghost.style.top = `${y * PX_PER_UNIT}px`;
    m.ghost.classList.toggle("board-ghost--legal", m.legal);
    m.ghost.classList.toggle("board-ghost--illegal", !m.legal);
  }

  /** `#pullToMate` for a kit that is not on the desk yet. */
  #pullGhostToMate(kit, x, y, rot = 0) {
    const pull = this.#doc.snapKitAt(kit, x, y, rot);
    if (pull.dx === 0 && pull.dy === 0) return { x, y };
    const snapped = { x: x + pull.dx, y: y + pull.dy };
    return this.#doc.canPlaceKit(kit, snapped.x, snapped.y, rot)
      ? snapped
      : { x, y };
  }

  #trackBrickGhost(e) {
    const m = this.#mode;
    const { width, height } = partDef(m.ref).size;
    const w = this.#deskView.worldFromEvent(e);
    const x = Math.round(w.x - width / 2);
    const y = Math.round(w.y - height / 2);
    m.pos = { x, y };
    m.legal = this.#doc.canPlaceBrick(m.ref, x, y);
    m.ghost.hidden = false;
    m.ghost.style.left = `${x * PX_PER_UNIT}px`;
    m.ghost.style.top = `${y * PX_PER_UNIT}px`;
    m.ghost.classList.toggle("part-ghost--legal", m.legal);
    m.ghost.classList.toggle("part-ghost--illegal", !m.legal);
  }

  /** Chip + discrete ghosts: seat under the cursor or float, tinted. */
  #trackSeatedGhost(e) {
    this.#trackSeatedGhostAt(this.#deskView.worldFromEvent(e));
  }

  /** As above but from a world point, so R can redraw at the last cursor spot. */
  #trackSeatedGhostAt(w) {
    const m = this.#mode;
    m.lastWorld = w;
    // A rotatable part turned off its footprint places by two derived ends.
    if (m.turns) {
      this.#trackTurnedGhost(w);
      return;
    }
    const box =
      m.kind === "place-chip"
        ? chipBox(partDef(m.ref).package)
        : discreteBox(m.ref);
    const seat = this.#partSeatAt(w, m.ref, 0);
    m.ghost.hidden = false;
    if (seat) {
      const board = this.#doc.getBoard(seat.board);
      const pos = holePosition(board.type, seat.anchor);
      m.board = seat.board;
      m.anchor = seat.anchor;
      m.legal = this.#doc.canPlacePart(m.ref, seat.board, seat.anchor);
      m.ghost.style.left = `${(board.x + pos.x + box.minX) * PX_PER_UNIT}px`;
      m.ghost.style.top = `${(board.y + pos.y + box.minY) * PX_PER_UNIT}px`;
    } else {
      // Off-board / off-row: the ghost floats on the cursor, illegal.
      m.board = null;
      m.anchor = null;
      m.legal = false;
      m.ghost.style.left = `${(w.x - box.width / 2) * PX_PER_UNIT}px`;
      m.ghost.style.top = `${(w.y - box.height / 2) * PX_PER_UNIT}px`;
    }
    m.ghost.classList.toggle("part-ghost--legal", m.legal);
    m.ghost.classList.toggle("part-ghost--illegal", !m.legal);
  }

  /**
   * Ghost for a rotatable part turned off its footprint: pin 1 rides the hole
   * under the cursor and pin 2's lead bends one orientation vector away, so it
   * places in the same two-free-ends form a drag would produce. The bend is an
   * offset, so the ghost may reach a neighbouring strip's rail.
   */
  #trackTurnedGhost(w) {
    const m = this.#mode;
    // A Cmd+V paste re-arms in the copied lead vector exactly (`m.orient`); a
    // palette pick spun with R rides the four cardinal turns instead.
    const orient = m.orient ?? this.#ghostOrient(m.ref, m.turns);
    const hit = this.#holeAtWorld(w);
    const p1 = hit ? { x: hit.x, y: hit.y } : w;
    const end = { dx: orient.dx, dy: orient.dy };
    m.board = hit ? hit.board.id : null;
    m.anchor = hit ? hit.hole : null;
    m.end = end;
    m.legal =
      Boolean(hit) &&
      this.#doc.canPlacePart(m.ref, hit.board.id, hit.hole, {
        params: { ...m.params, rot: 90, end },
      });

    m.ghost.querySelector("svg")?.remove();
    m.ghost.append(buildSpanSvg(m.ref, orient.dx, orient.dy, m.params));
    const pad = spanPad(m.ref);
    m.ghost.style.left = `${(p1.x + Math.min(0, orient.dx) - pad) * PX_PER_UNIT}px`;
    m.ghost.style.top = `${(p1.y + Math.min(0, orient.dy) - pad) * PX_PER_UNIT}px`;
    m.ghost.hidden = false;
    m.ghost.classList.toggle("part-ghost--legal", m.legal);
    m.ghost.classList.toggle("part-ghost--illegal", !m.legal);
  }

  /** Seat (board + anchor) for a part under the cursor — see model/seating.js. */
  #partSeatAt(world, ref, grabOffsetCols) {
    return partSeatAt(this.#doc.boards, ref, world, grabOffsetCols);
  }

  // ── Rotation while placing / dragging ───────────────────────────────────

  /**
   * The end-to-end vector of a rotatable part's ghost after `turns` quarter
   * turns: 0 is the horizontal footprint, 1–3 swing it a quarter lap each.
   */
  #ghostOrient(ref, turns) {
    const offsets = partDef(ref).footprint.offsets;
    const span = offsets[offsets.length - 1];
    const table = [
      { dx: span, dy: 0 },
      { dx: 0, dy: span },
      { dx: -span, dy: 0 },
      { dx: 0, dy: -span },
    ];
    return table[turns % 4];
  }

  /** R spins the ghost/part in hand, and rotates a selected placed one. */
  #toggleResistorRotation() {
    const m = this.#mode;
    // Mid-drag: spin the end-to-end vector 90° about pin 1 and redraw at the
    // cursor's last position — free rotation while positioning.
    if (m?.kind === "drag-resistor") {
      // Negating a zero component yields -0, which would ride into the stored
      // bend and break value comparisons — fold it back.
      const dx = -m.orient.dy;
      m.orient = { dx: dx === 0 ? 0 : dx, dy: m.orient.dx };
      // A rotation counts as a real gesture even without pointer travel, so the
      // release commits (or reverts) instead of being treated as a plain click.
      if (!m.active) {
        m.active = true;
        this.#partViews.get(m.id)?.setDragging(true);
      }
      this.#trackResistorDrag();
      return true;
    }
    // Mid-drag of a chip: flip the slab in hand. Its footprint maps onto itself,
    // so the seat stays legal — the orientation rides along to the drop. Only
    // chips flip; a DIP-footprint display (bar array) is fixed anode-side-down.
    if (m?.kind === "drag-part" && partDef(m.ref)?.kind === "chip") {
      m.flip = !m.flip;
      if (!m.active) {
        m.active = true; // a flip alone still commits on release
        this.#partViews.get(m.id)?.setDragging(true);
      }
      const comp = this.#doc.getComponent(m.id);
      this.#partViews
        .get(m.id)
        ?.updateParams(this.#flippedParams(comp?.params, m.flip));
      return true;
    }
    // ANY other gesture in flight — dragging a non-rotatable part, a board, a
    // brick, a wire or one of its ends, rubber-banding, or wiring — swallows R
    // as a no-op. Falling through would rotate the part BEHIND the drag,
    // remounting its element and stranding the gesture mid-flight.
    if (m && !this.placementArmed) return false;
    // Placing a rail: R stands it on end (a quarter lap per press) so it can
    // run down the side of a board as a signal bus. Assembled kits hold a
    // pin-board and never turn.
    if (m?.kind === "place" && DeskDoc.canRotateKit(m.kit)) {
      m.rot = ROTATIONS[(ROTATIONS.indexOf(m.rot) + 1) % ROTATIONS.length];
      this.#renderBoardGhost(m);
      if (m.lastEvent) this.#trackBoardGhost(m.lastEvent);
      return true;
    }
    // Placing a chip: R flips the ghost before it lands.
    if (m?.kind === "place-chip") {
      m.params = this.#flippedParams(m.params, true);
      m.ghost.querySelector("svg")?.remove();
      m.ghost.append(buildChipSvg(m.ref, m.params));
      return true;
    }
    // Placing a rotatable part: R turns the ghost a quarter lap IN PLACE — the
    // placement stays armed, and the orientation carries into the drop. A pasted
    // ghost carries an explicit lead vector (m.orient), so spin THAT 90°
    // (pin 1 fixed); a palette pick rides the four cardinal turns.
    if (m?.kind === "place-part" && partDef(m.ref)?.rotatable) {
      if (m.orient) {
        // Fold -0 back to 0 so it never rides into the stored bend.
        const dx = -m.orient.dy;
        m.orient = { dx: dx === 0 ? 0 : dx, dy: m.orient.dx };
      } else {
        m.turns = ((m.turns ?? 0) + 1) % 4;
      }
      if (m.lastWorld) this.#trackSeatedGhostAt(m.lastWorld);
      return true;
    }
    // Not placing: rotate a selected placed part in situ (a chip flips 180°).
    if (this.#selected?.kind === "part") {
      const comp = this.#doc.getComponent(this.#selected.id);
      const def = partDef(comp?.ref);
      if (def?.rotatable || def?.kind === "chip") {
        this.rotateComponent(this.#selected.id);
        return true;
      }
    }
    return false;
  }

  /** Params with the 180° flag toggled (or set) — chips only. */
  #flippedParams(params, toggle) {
    if (!toggle) return { ...params };
    return { ...params, rot: params?.rot === 180 ? 0 : 180 };
  }

  /**
   * The drag state for a placed resistor: it translates RIGIDLY (both ends
   * together, snapped to the 0.1-in lattice) and can be rotated freely mid-drag
   * with R. Returns null when its pins don't resolve (then a press just
   * selects). Works for both forms — the horizontal footprint and the two-end
   * span — since pin holes are always derived.
   */
  #resistorDragMode(comp, ends, e, world) {
    return {
      kind: "drag-resistor",
      id: comp.id,
      ref: comp.ref,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startWorld: world,
      lastWorld: world, // re-rendered from this when R rotates mid-drag
      p1: { x: ends.a.x, y: ends.a.y }, // pin 1 at grab time
      orient: { dx: ends.b.x - ends.a.x, dy: ends.b.y - ends.a.y },
      origin: { board: comp.board, anchor: comp.anchor, params: comp.params },
      holes: null, // { boardId, one, two } while both ends land legally
      legal: false,
      active: false,
    };
  }

  /**
   * A board part's pins as `{ pin, address, x, y }`: the desk address each
   * lead resolves to and where it sits in the world.
   *
   * A rotated part's far lead is a `{dx, dy}` BEND, so its world position is
   * always derivable — but the hole it touches depends on what lies under it,
   * and `address` is null when that is bare desk (a FLOATING lead: legal, and
   * exactly what a part is left with when its rail is pulled away). Null
   * overall only when the part itself doesn't resolve.
   *
   * `boardOverride` substitutes a moved origin for the part's own board, so a
   * live board drag re-renders against the position under the cursor.
   */
  #partPins(comp, boardOverride = null) {
    // A live board drag substitutes a moved origin for the part's own board;
    // otherwise the document's boards are the truth. The world geometry itself
    // lives in model/part-geometry.js.
    const boards = boardOverride
      ? this.#doc.boards.map((b) =>
          b.id === comp.board ? { ...b, ...boardOverride } : b,
        )
      : this.#doc.boards;
    return partPinsWorld(boards, comp);
  }

  /**
   * A resistor's two ends as world points, derived from whichever form it's
   * stored in. Null when its pins don't resolve.
   */
  #resistorEndPoints(comp) {
    const pins = this.#partPins(comp);
    if (!pins || pins.length < 2) return null;
    return {
      boardId: comp.board,
      anchor: comp.anchor,
      a: { x: pins[0].x, y: pins[0].y },
      b: { x: pins[1].x, y: pins[1].y },
    };
  }

  /** Which end (if either) a press grabs — "a", "b", or null for the body. */
  #resistorEndAt(ends, world) {
    let best = null;
    let bestDist = WIRE_END_GRAB_RADIUS;
    for (const key of ["a", "b"]) {
      const p = ends[key];
      const dist = Math.hypot(world.x - p.x, world.y - p.y);
      if (dist <= bestDist) {
        best = key;
        bestDist = dist;
      }
    }
    return best;
  }

  /** Drag ONE end of a resistor to any free hole (wire-endpoint style); the
      other end stays put, so the span and angle are free to change. */
  #resistorEndDragMode(comp, ends, grabbed, e, world) {
    return {
      kind: "drag-resistor-end",
      id: comp.id,
      ref: comp.ref,
      boardId: comp.board,
      anchor: comp.anchor, // pin 1's seat, kept while only pin 2 moves
      moving: grabbed, // "a" (pin 1) or "b" (pin 2)
      fixed: ends[grabbed === "a" ? "b" : "a"],
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      lastWorld: world,
      origin: { board: comp.board, anchor: comp.anchor, params: comp.params },
      target: null, // { anchor, end } while the drop is legal
      legal: false,
      active: false,
    };
  }

  /** Live single-end drag: the moving lead snaps to a hole, the other stays. */
  #trackResistorEndDrag() {
    const d = this.#mode;
    const hit = this.#holeAtWorld(d.lastWorld);
    d.target = null;
    let legal = false;
    if (hit) {
      // Pin 1 SEATS in a hole; pin 2 is a bend measured from it. So dragging
      // pin 1 re-seats the part (onto another strip if that's where it landed)
      // while dragging pin 2 only re-bends the lead — either way the pair is
      // rewritten as one anchor plus one offset.
      const movingA = d.moving === "a";
      const boardId = movingA ? hit.board.id : d.boardId;
      const anchor = movingA ? hit.hole : d.anchor;
      const from = movingA ? hit : d.fixed;
      const to = movingA ? d.fixed : hit;
      const end = {
        dx: Math.round(to.x - from.x),
        dy: Math.round(to.y - from.y),
      };
      // canPlacePart enforces free + distinct + the minimum lead span.
      legal = this.#doc.canPlacePart(d.ref, boardId, anchor, {
        ignoreId: d.id,
        params: { rot: 90, end },
      });
      if (legal) d.target = { boardId, anchor, end };
    }
    d.legal = legal;
    // The moving end rides the snapped hole, else the raw cursor.
    const tip = hit ? { x: hit.x, y: hit.y } : d.lastWorld;
    const view = this.#partViews.get(d.id);
    view?.updateSpanWorld(
      d.moving === "a" ? tip : d.fixed,
      d.moving === "a" ? d.fixed : tip,
    );
    view?.setIllegal(!legal);
  }

  /** Live resistor drag: rigid lattice-snapped translation, both ends checked.
      Pin 1 seats in whatever hole it lands on; the lead keeps its bend, so the
      far end may reach a NEIGHBOURING strip's rail. */
  #trackResistorDrag() {
    const d = this.#mode;
    // ONE integer delta moves both ends, so length and angle never change.
    const dx = Math.round(d.lastWorld.x - d.startWorld.x);
    const dy = Math.round(d.lastWorld.y - d.startWorld.y);
    const p1 = { x: d.p1.x + dx, y: d.p1.y + dy };
    const p2 = { x: p1.x + d.orient.dx, y: p1.y + d.orient.dy };
    const a = this.#holeAtWorld(p1);
    const end = {
      dx: Math.round(d.orient.dx),
      dy: Math.round(d.orient.dy),
    };
    // canPlacePart resolves the bent lead against the whole desk, so it is the
    // one authority on whether the far end found a free hole.
    const legal =
      Boolean(a) &&
      this.#doc.canPlacePart(d.ref, a.board.id, a.hole, {
        ignoreId: d.id,
        params: { rot: 90, end },
      });
    d.holes = legal ? { boardId: a.board.id, anchor: a.hole, end } : null;
    d.legal = legal;
    const view = this.#partViews.get(d.id);
    view?.updateSpanWorld(p1, p2);
    view?.setIllegal(!legal);
  }

  /** Rebuild a part's view from the document — the horizontal SVG and the
      two-end span differ, so a shape change needs a fresh mount. Also the
      canonical "snap back to where it was" after an illegal drop. */
  #remountPart(id) {
    const comp = this.#doc.getComponent(id);
    if (!comp) return;
    const selected =
      this.#selected?.kind === "part" && this.#selected.id === id;
    this.#partViews.get(id)?.remove();
    this.#partViews.delete(id);
    this.#mountPart(comp);
    if (selected) this.#partViews.get(id)?.setSelected(true);
  }

  /** Rotate a placed rotatable part (resistor) 90° in place. No-op if it can't
      fit (nothing free at either rotated position). */
  rotateComponent(id) {
    try {
      this.#doc.rotateComponent(id);
    } catch {
      return; // nowhere free to rotate into — leave it as-is
    }
    this.#remountPart(id);
    this.#emitDocChanged();
  }

  // ── Wire tool (Feature 50) ───────────────────────────────────────────────
  // The wire subsystem lives in WireTools; these are the public shims app.js /
  // keyboard drive it through. It shares `#mode` via the host in the ctor.

  get wireToolArmed() {
    return this.#wire.armed;
  }

  /** The color the next committed wire gets. */
  get wireColor() {
    return this.#wire.color;
  }

  /** Pin the next wire color (the toolbar swatch strip). */
  setWireColor(color) {
    this.#wire.setColor(color);
  }

  armWireTool() {
    this.#wire.arm();
  }

  disarmWireTool() {
    this.#wire.disarm();
  }

  toggleWireTool() {
    this.#wire.toggle();
  }

  /** Remove a wire; clears its selection. */
  removeWire(id) {
    this.#wire.removeWire(id);
  }

  /** Recolor a wire (context menu). */
  recolorWire(id, color) {
    this.#wire.recolorWire(id, color);
  }

  /** Shared address→world resolver (the probe's highlight geometry). */
  #addressWorld(address) {
    return addressWorld(this.#doc.boards, this.#doc.components, address);
  }

  // ── Connectivity inspector / probe (Feature 70) ─────────────────────────
  // The probe subsystem lives in ProbeInspector; these are the public shims
  // app.js/keyboard drive it through.

  get probeArmed() {
    return this.#probe.armed;
  }

  /** Arm probe mode: hover highlights a net, click pins it. */
  armProbe() {
    this.#probe.arm();
  }

  disarmProbe() {
    this.#probe.disarm();
  }

  toggleProbe() {
    this.#probe.toggle();
  }

  // ── Simulation live state (Feature 90) ───────────────────────────────────

  /** Freeze/unfreeze editing while the circuit runs (app.js drives this). */
  setEditingLocked(locked) {
    this.#editingLocked = locked;
    this.#viewport.classList.toggle("desk-viewport--running", locked);
    if (locked) {
      // Cancel any armed tool the run supersedes (probe stays allowed).
      this.cancelPlacement();
      this.disarmWireTool();
    }
  }

  // ── Document mutations (all flow through desk-doc) ─────────────────────

  /** Add + mount + select a single strip; emits chiphippo:doc-changed. */
  addBoardAt(type, x, y) {
    const board = this.#doc.addBoard(type, x, y);
    this.#mountBoard(board);
    this.selectBoard(board.id);
    this.#emitDocChanged();
    return board;
  }

  /**
   * Add + mount a whole breadboard kit, selecting its pin-board (the strip
   * users think of as "the board"). Emits chiphippo:doc-changed once.
   *
   * @returns {Array<object>} the new strips, in kit order.
   */
  addKitAt(kit, x, y, rot = 0) {
    const strips = this.#doc.addKit(kit, x, y, rot);
    for (const strip of strips) this.#mountBoard(strip);
    // Anything dropped flush against a board mates with it, as the real
    // dovetailed part does — the strips join that board's group and drag as
    // one unit from here on. A whole kit mates the same way a lone strip
    // does; placing and dropping follow the ONE rule.
    this.#mateStrips(strips.map((s) => s.id));
    const pins = strips.find((s) => spec(s.type).kind === "pins") ?? strips[0];
    this.selectBoard(pins.id);
    this.#emitDocChanged();
    return strips;
  }

  /**
   * Offer every strip in `ids` to the mating rule. Strips of the same set
   * already share a group, so the joins compose: whatever any of them
   * dovetails with ends up in one unit.
   */
  #mateStrips(ids) {
    for (const id of ids) this.#doc.joinMatedGroup(id);
  }

  /** Seat + mount + select a board part; emits chiphippo:doc-changed. */
  addComponentAt(ref, boardId, anchor, params = {}) {
    const component = this.#doc.addComponent({
      kind: partDef(ref).kind,
      ref,
      board: boardId,
      anchor,
      params,
    });
    this.#mountPart(component);
    this.selectComponent(component.id);
    this.#emitDocChanged();
    return component;
  }

  /** Drop + mount + select a desk-level brick (PSU/clock); emits doc-changed. */
  addBrickAt(ref, x, y, params = {}) {
    const brick = this.#doc.addBrick(ref, x, y, params);
    this.#mountPart(brick);
    this.selectComponent(brick.id);
    this.#emitDocChanged();
    return brick;
  }

  /**
   * Remove a board. With parts seated on it or wires attached, asks for
   * confirmation first (the document cascade removes them too).
   */
  removeBoard(id) {
    const parts = this.#doc.componentsOnBoard(id).length;
    const wires = this.#doc.wiresTouching(id).length;
    if (parts === 0 && wires === 0) {
      this.#doRemoveBoard(id);
      return;
    }
    const bits = [];
    if (parts > 0) bits.push(`${parts} part${parts === 1 ? "" : "s"}`);
    if (wires > 0) bits.push(`${wires} wire${wires === 1 ? "" : "s"}`);
    PopupManager.confirm({
      title: "Remove board?",
      message:
        `${id} has ${bits.join(" and ")} attached — ` +
        `removing the board removes them too.`,
      confirmLabel: "Remove",
      confirmClass: "btn--danger",
      onConfirm: () => this.#doRemoveBoard(id),
    });
  }

  #doRemoveBoard(id) {
    for (const comp of this.#doc.componentsOnBoard(id)) {
      this.#partViews.get(comp.id)?.remove();
      this.#partViews.delete(comp.id);
      if (this.#selected?.id === comp.id) this.#selected = null;
    }
    const cascadedWires = new Set(this.#doc.wiresTouching(id).map((w) => w.id));
    this.#doc.removeBoard(id); // cascades seated components + attached wires
    this.#views.get(id)?.remove();
    this.#views.delete(id);
    if (
      this.#selected?.id === id ||
      (this.#selected?.kind === "wire" && cascadedWires.has(this.#selected.id))
    ) {
      this.#selected = null;
    }
    this.#hideHover();
    this.#emitDocChanged(); // WireLayer re-renders from this
  }

  /**
   * Remove a component. A PSU with wires on its terminals confirms first
   * (they go with it).
   */
  removeComponent(id) {
    const comp = this.#doc.getComponent(id);
    if (comp?.kind === "psu") {
      const wires = this.#doc.wiresTouching(id).length;
      if (wires > 0) {
        PopupManager.confirm({
          title: "Remove power supply?",
          message:
            `${id} has ${wires} wire${wires === 1 ? "" : "s"} attached — ` +
            `removing it removes them too.`,
          confirmLabel: "Remove",
          confirmClass: "btn--danger",
          onConfirm: () => this.#doRemoveComponent(id),
        });
        return;
      }
    }
    this.#doRemoveComponent(id);
  }

  #doRemoveComponent(id) {
    const cascadedWires = new Set(this.#doc.wiresTouching(id).map((w) => w.id));
    this.#doc.removeComponent(id); // a PSU cascades its attached wires
    this.#partViews.get(id)?.remove();
    this.#partViews.delete(id);
    if (
      this.#selected?.id === id ||
      (this.#selected?.kind === "wire" && cascadedWires.has(this.#selected.id))
    ) {
      this.#selected = null;
    }
    this.#hideHover();
    this.#emitDocChanged();
  }

  /** Flip a slide switch (click) — persists `pos`; doc-changed re-settles. */
  #toggleSlideSwitch(id) {
    const comp = this.#doc.getComponent(id);
    const next = comp.params.pos === "2" ? "1" : "2";
    const updated = this.#doc.setComponentParams(id, { pos: next });
    this.#partViews.get(id)?.updateParams(updated.params);
    // `pos` lives in params, so the flip rides `doc-changed` alone — which
    // already invalidates the netlist, re-ticks the sim, and refreshes the
    // pinned net. Emitting `part-state` too would double-tick (part-state is
    // reserved for transient view state with no durable param — a held button).
    this.#emitDocChanged();
  }

  /** Set a PSU's voltage (context menu). */
  setPsuVolts(id, volts) {
    const updated = this.#doc.setComponentParams(id, { volts });
    this.#partViews.get(id)?.updateParams(updated.params);
    this.#emitDocChanged();
  }

  /** Set a clock's rate (context menu). */
  setClockHz(id, hz) {
    const updated = this.#doc.setComponentParams(id, { hz });
    this.#partViews.get(id)?.updateParams(updated.params);
    this.#emitDocChanged();
  }

  // ── Central keyboard hooks (wired by app.js) ────────────────────────────

  /** @returns {boolean} true when the key was consumed. */
  handleKeyDown(e) {
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) {
      return false;
    }
    if (e.key === "Escape") {
      // First Esc unpins a pinned net; the next disarms the probe. Then the
      // wire tool (cancel a pending wire, else disarm).
      if (this.#probe.handleEscape()) return true;
      if (this.#wire.handleEscape()) return true;
      if (this.placementArmed) {
        this.cancelPlacement();
        return true;
      }
      if (this.#selected || this.#multiSize() > 0) {
        this.deselect();
        return true;
      }
      return false;
    }
    const bareKey = !e.metaKey && !e.ctrlKey && !e.altKey;
    // Probe stays available while running; edit shortcuts are locked out.
    if ((e.key === "i" || e.key === "I") && bareKey) {
      this.toggleProbe();
      return true;
    }
    if (this.#editingLocked) return false;
    // Cmd/Ctrl+C copies the one selected component; Cmd/Ctrl+V arms a fresh
    // duplicate as a placement ghost. Consume the key only when there is
    // something to act on, so the native Edit-menu copy/paste still serves text
    // fields (this handler already returned above when a text input is focused).
    const accel = (e.metaKey || e.ctrlKey) && !e.altKey;
    if (accel && (e.key === "c" || e.key === "C")) {
      return this.copySelectedComponent();
    }
    if (accel && (e.key === "v" || e.key === "V")) {
      return this.pasteComponent();
    }
    if ((e.key === "w" || e.key === "W") && bareKey) {
      this.toggleWireTool();
      return true;
    }
    // F flips LED polarity while its placement ghost is armed.
    if (
      (e.key === "f" || e.key === "F") &&
      this.#mode?.kind === "place-part" &&
      this.#mode.ref === "led"
    ) {
      const m = this.#mode;
      m.params = { ...m.params, flip: !m.params.flip };
      m.ghost.querySelector("svg")?.remove();
      m.ghost.append(buildDiscreteSvg(m.ref, m.params));
      return true;
    }
    // R rotates a resistor: toggles its placement between horizontal and the
    // vertical two-click form, and rotates a selected placed resistor 90°.
    if ((e.key === "r" || e.key === "R") && bareKey) {
      if (this.#toggleResistorRotation()) return true;
    }
    if (
      (e.key === "Delete" || e.key === "Backspace") &&
      this.#multiSize() > 0
    ) {
      this.removeSelectedComponents();
      return true;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && this.#selected) {
      const { kind, id } = this.#selected;
      if (kind === "part") this.removeComponent(id);
      else if (kind === "wire") this.removeWire(id);
      else this.removeBoard(id);
      return true;
    }
    return false;
  }

  /** Camera moved/zoomed (app.js pass-through) — hover context is stale. */
  onViewportChange() {
    this.#hideHover();
  }

  // ── Mounting ─────────────────────────────────────────────────────────────

  #mountBoard(board) {
    const view = new BreadboardView(this.#layers.boards, board, {
      onPointerDown: (id, e) => this.#onBoardPointerDown(id, e),
      onContextMenu: (id, e) => this.#onBoardContextMenu(id, e),
    });
    this.#views.set(board.id, view);
  }

  #mountPart(component) {
    // Every part double-clicks to open its pin/terminal-assignments window.
    const callbacks = {
      onPointerDown: (id, e) => this.#onPartPointerDown(id, e),
      onContextMenu: (id, e) => this.#onPartContextMenu(id, e),
      onDoubleClick: (id) => this.#onPartDoubleClick(id),
    };
    let view;
    if (component.kind === "psu") {
      view = new PsuView(this.#layers.parts, component, callbacks);
    } else if (component.kind === "clock") {
      view = new ClockView(this.#layers.parts, component, callbacks);
    } else if (component.kind === "discrete") {
      view = new DiscreteView(this.#layers.parts, component, callbacks);
      this.#placePartView(view, component, this.#doc.getBoard(component.board));
    } else {
      view = new ChipView(this.#layers.parts, component, callbacks);
      view.updatePlacement(
        this.#doc.getBoard(component.board),
        component.anchor,
      );
    }
    this.#partViews.set(component.id, view);
  }

  /** Position a part view: a rotated resistor spans its two ends, every other
      part (chip/discrete) seats at its anchor. `board` may be an override
      origin (live board drag). */
  #placePartView(view, comp, board) {
    if (!board) return;
    // Every rotatable part draws as a span between its two derived ends — body
    // centred on the pair and rotated to the lead angle, whichever form it's
    // stored in (footprint or two free ends). The span is pure geometry, so a
    // part whose far strip was pulled away keeps its exact position; only the
    // floating cue marks the connection it lost.
    if (partDef(comp.ref)?.rotatable) {
      const pins = this.#partPins(comp, board);
      if (pins?.length >= 2) {
        view.updateSpanWorld(pins[0], pins[1]);
        view.setFloating?.(pins.some((p) => p.address == null));
        return;
      }
    }
    view.updatePlacement(board, comp.anchor);
  }

  /**
   * Double-clicking any part opens its pin/terminal-assignments window
   * (read-only). The row count sizes the window: a DIP wraps to pins/2, a
   * discrete lists every pin, a brick lists every terminal.
   */
  #onPartDoubleClick(id) {
    const comp = this.#doc.getComponent(id);
    const def = comp && partDef(comp.ref);
    if (!def) return;
    let rows;
    if (def.package) rows = Math.ceil(def.pins.length / 2);
    else if (def.footprint) rows = def.pins.length;
    else if (def.terminals) rows = def.terminals.length;
    else return; // nothing to show
    this.#onOpenPinout?.(comp.ref, rows);
  }

  /** Seated parts ride their board: refresh views for a board at (x, y). */
  #repositionBoardParts(boardId, x, y) {
    const board = this.#doc.getBoard(boardId);
    if (!board) return;
    // A drag moves a strip, never turns it — but the override stands in for
    // the whole board downstream, so it carries the angle too.
    const origin = {
      id: board.id,
      type: board.type,
      x,
      y,
      rot: board.rot ?? 0,
    };
    for (const comp of this.#doc.componentsOnBoard(boardId)) {
      const view = this.#partViews.get(comp.id);
      if (view) this.#placePartView(view, comp, origin);
    }
  }

  // ── Board gestures ───────────────────────────────────────────────────────

  #onBoardPointerDown(id, e) {
    if (e.button !== 0) return; // middle = pan (DeskView), right = menu
    // Shift alone is the viewport's marquee; with Option it selects a chain.
    if (e.shiftKey && !e.altKey) return;
    // No board drags while probing or running (topology frozen).
    if (this.#mode || this.#probe.armed || this.#editingLocked) return;
    this.#hideHover();
    this.selectBoard(id);

    const view = this.#views.get(id);
    // Plain grab = the whole snapped unit. Option grabs the run from here
    // ONE WAY — down/right, or up/left with Shift — and dragging it tears it
    // off whatever it leaves behind.
    const members = e.altKey
      ? this.#doc.matedChain(id, e.shiftKey ? "backward" : "forward")
      : this.#doc.groupMembers(id);
    // The set lights up on mouse-down, before any travel, so it is clear what
    // is about to move (and what is about to be left behind).
    for (const b of members) this.#views.get(b.id)?.setDragSet(true);
    // Strips dragging as one rigid unit means the drag tracks a delta plus
    // every member's origin, not one board's position.
    this.#mode = {
      kind: "drag",
      id,
      members: members.map((b) => ({ id: b.id, ox: b.x, oy: b.y })),
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startWorld: this.#deskView.worldFromEvent(e),
      delta: { dx: 0, dy: 0 },
      legal: true,
      active: false,
    };
    // …and the highlighter re-traces that set, so an Option grab shows the
    // torn-off run's edge rather than the whole group's.
    this.#refreshBoardOutline();
    // Closed hand from the moment the board is grabbed (before any drag).
    this.#viewport.classList.add("desk-viewport--dragging");
    try {
      view.element.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort (synthetic events) */
    }
    view.element.addEventListener("pointermove", this.#onBoardPointerMove);
    view.element.addEventListener("pointerup", this.#onBoardPointerUp);
    view.element.addEventListener("pointercancel", this.#onBoardPointerUp);
  }

  #onBoardPointerMove = (e) => {
    const d = this.#mode;
    if (d?.kind !== "drag" || e.pointerId !== d.pointerId) return;
    if (!d.active) {
      const travel = Math.hypot(
        e.clientX - d.startClientX,
        e.clientY - d.startClientY,
      );
      if (travel < DRAG_THRESHOLD) return;
      d.active = true;
      for (const m of d.members) this.#views.get(m.id)?.setDragging(true);
    }
    const w = this.#deskView.worldFromEvent(e);
    // The group rides the pointer, snapped live to the pitch lattice, then
    // pulled the last pitch or two onto a strip it can dovetail with.
    const ids = d.members.map((m) => m.id);
    d.delta = this.#pullToMate(ids, {
      dx: Math.round(w.x - d.startWorld.x),
      dy: Math.round(w.y - d.startWorld.y),
    });
    d.legal = this.#doc.canMoveBoardsBy(ids, d.delta.dx, d.delta.dy);
    // Wires with an endpoint on any member follow it live.
    this.#wireLayer.render(this.#applyDragDelta(d, d.delta));
  };

  /**
   * Magnetic mating: a set dragged within a pitch or two of an edge it can
   * dovetail with is pulled the rest of the way, so dropping two boards side
   * by side joins them without pixel-perfect aim. The pull is abandoned if it
   * would land the set on top of something — a snap must never be the reason
   * a legal drop turns illegal.
   */
  #pullToMate(ids, delta) {
    const pull = this.#doc.snapBoardsBy(ids, delta.dx, delta.dy);
    if (pull.dx === 0 && pull.dy === 0) return delta;
    const snapped = { dx: delta.dx + pull.dx, dy: delta.dy + pull.dy };
    return this.#doc.canMoveBoardsBy(ids, snapped.dx, snapped.dy)
      ? snapped
      : delta;
  }

  /**
   * Move every dragged strip's view (and its seated parts) by a delta from
   * the drag origins. Returns the board → position overrides for WireLayer.
   */
  #applyDragDelta(d, { dx, dy }) {
    const overrides = new Map();
    for (const m of d.members) {
      const pos = { x: m.ox + dx, y: m.oy + dy };
      const view = this.#views.get(m.id);
      view?.setPosition(pos.x, pos.y);
      this.#repositionBoardParts(m.id, pos.x, pos.y);
      overrides.set(m.id, pos);
    }
    // The highlighter rides the set and reddens on an illegal drop — one
    // shape for the whole unit, so no seams appear between flush strips.
    this.#refreshBoardOutline(overrides);
    return overrides;
  }

  #onBoardPointerUp = (e) => {
    const d = this.#mode;
    if (d?.kind !== "drag" || e.pointerId !== d.pointerId) return;
    this.#mode = null;
    this.#viewport.classList.remove("desk-viewport--dragging");

    const view = this.#views.get(d.id);
    if (view) {
      const boardEl = view.element;
      boardEl.removeEventListener("pointermove", this.#onBoardPointerMove);
      boardEl.removeEventListener("pointerup", this.#onBoardPointerUp);
      boardEl.removeEventListener("pointercancel", this.#onBoardPointerUp);
      try {
        boardEl.releasePointerCapture(d.pointerId);
      } catch {
        /* already released */
      }
    }
    for (const m of d.members) {
      const memberView = this.#views.get(m.id);
      memberView?.setDragging(false);
      memberView?.setDragSet(false);
    }
    if (!d.active) return; // plain click — selection already happened

    const cancelled = e.type === "pointercancel";
    const moved = d.delta.dx !== 0 || d.delta.dy !== 0;
    if (!cancelled && d.legal && moved) {
      // Moving only part of a group tears the snap — desk-doc re-derives the
      // groups on both sides of the break.
      const ids = d.members.map((m) => m.id);
      this.#doc.moveBoardsBy(ids, d.delta.dx, d.delta.dy);
      // Landing flush against a strip it dovetails with mates the two, as
      // dropping the real parts side by side does. Every dropped strip is
      // offered, so a kit that touches on more than one edge joins them all.
      this.#mateStrips(ids);
      this.#applyDragDelta(d, d.delta);
      this.#emitDocChanged(); // WireLayer re-renders from this
    } else {
      this.#applyDragDelta(d, { dx: 0, dy: 0 }); // illegal drop → revert
      this.#wireLayer.render();
    }
  };

  #onBoardContextMenu(id, e) {
    e.preventDefault();
    if (this.#mode || this.#editingLocked) return; // no board edits while running
    this.selectBoard(id);
    PopupManager.menu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "Remove board",
          danger: true,
          onSelect: () => this.removeBoard(id),
        },
        { label: "Properties…", disabled: true },
      ],
    });
  }

  // ── Part gestures (chips, discretes, PSUs) ──────────────────────────────

  #onPartPointerDown(id, e) {
    if (e.button !== 0) return;
    if (e.shiftKey) return; // shift-drag is the viewport's marquee
    if (this.#mode || this.#probe.armed) return; // no part drags while probing
    // While running, only slide switches stay interactive (click to flip);
    // every other part is frozen in place.
    if (this.#editingLocked) {
      // While running, only live interactions remain: a slide switch flips,
      // and a manual clock toggles one edge.
      const comp = this.#doc.getComponent(id);
      if (comp?.ref === "sw-slide") {
        e.stopPropagation();
        this.#toggleSlideSwitch(id);
      } else if (comp?.kind === "clock" && comp.params?.hz === "manual") {
        e.stopPropagation();
        this.#onClockToggle?.(id);
      }
      return;
    }
    this.#hideHover();
    this.selectComponent(id);

    const comp = this.#doc.getComponent(id);
    const view = this.#partViews.get(id);
    const w = this.#deskView.worldFromEvent(e);

    // A resistor drags RIGIDLY by its two ends (either may be a rail), and
    // rotates freely mid-drag with R — never through the footprint reseat.
    if (partDef(comp.ref)?.rotatable) {
      const ends = this.#resistorEndPoints(comp);
      if (!ends) {
        e.stopPropagation();
        return; // unresolvable pins — the press just selected it
      }
      // Near a lead → drag that end alone (any hole, any angle); on the body →
      // translate the whole resistor rigidly.
      const grabbed = this.#resistorEndAt(ends, w);
      this.#mode = grabbed
        ? this.#resistorEndDragMode(comp, ends, grabbed, e, w)
        : this.#resistorDragMode(comp, ends, e, w);
    } else if (comp.board == null) {
      // A desk-level brick (PSU, clock) drags freely on the desk.
      this.#mode = {
        kind: "drag-brick",
        ref: comp.ref,
        id,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startWorld: w,
        origin: { x: comp.x, y: comp.y },
        pos: { x: comp.x, y: comp.y },
        legal: true,
        active: false,
      };
    } else {
      const board = this.#doc.getBoard(comp.board);
      // A grid anchor is the ONE thing a footprint drag needs: the column the
      // part is pinned at, so the grab point stays under the finger. A part
      // whose anchor doesn't parse (only reachable from a hand-edited file)
      // is left where it is — the press just selects it.
      const seat = parseHole(board.type, comp.anchor);
      if (seat?.kind !== "grid") {
        e.stopPropagation();
        return;
      }
      const cursorCol = columnAt(board.type, w.x - board.x);
      this.#mode = {
        kind: "drag-part",
        id,
        ref: comp.ref,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        grabOffsetCols: seat.col - cursorCol,
        origin: { board: comp.board, anchor: comp.anchor },
        seat: { board: comp.board, anchor: comp.anchor },
        legal: true,
        active: false,
      };
    }
    // Closed hand from the moment the part is grabbed (before any drag).
    this.#viewport.classList.add("desk-viewport--dragging");
    try {
      view.element.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    view.element.addEventListener("pointermove", this.#onPartPointerMove);
    view.element.addEventListener("pointerup", this.#onPartPointerUp);
    view.element.addEventListener("pointercancel", this.#onPartPointerUp);
  }

  #onPartPointerMove = (e) => {
    const d = this.#mode;
    if (
      (d?.kind !== "drag-part" &&
        d?.kind !== "drag-brick" &&
        d?.kind !== "drag-resistor" &&
        d?.kind !== "drag-resistor-end") ||
      e.pointerId !== d.pointerId
    ) {
      return;
    }
    if (!d.active) {
      const travel = Math.hypot(
        e.clientX - d.startClientX,
        e.clientY - d.startClientY,
      );
      if (travel < DRAG_THRESHOLD) return;
      d.active = true;
      this.#partViews.get(d.id)?.setDragging(true);
    }
    const view = this.#partViews.get(d.id);
    const w = this.#deskView.worldFromEvent(e);

    if (d.kind === "drag-resistor") {
      d.lastWorld = w;
      this.#trackResistorDrag();
      return;
    }
    if (d.kind === "drag-resistor-end") {
      d.lastWorld = w;
      this.#trackResistorEndDrag();
      return;
    }

    if (d.kind === "drag-brick") {
      d.pos = {
        x: Math.round(d.origin.x + (w.x - d.startWorld.x)),
        y: Math.round(d.origin.y + (w.y - d.startWorld.y)),
      };
      d.legal = this.#doc.canPlaceBrick(d.ref, d.pos.x, d.pos.y, {
        ignoreId: d.id,
      });
      view?.setPosition(d.pos.x, d.pos.y);
      view?.setIllegal(!d.legal);
      // Wires on this PSU's terminals follow it live.
      this.#wireLayer.render(new Map([[d.id, d.pos]]));
      return;
    }

    const seat = this.#partSeatAt(w, d.ref, d.grabOffsetCols);
    if (seat) {
      // Ride the lattice, snapped; tint tells occupancy legality.
      d.seat = seat;
      d.legal = this.#doc.canPlacePart(d.ref, seat.board, seat.anchor, {
        ignoreId: d.id,
      });
      view?.updatePlacement(this.#doc.getBoard(seat.board), seat.anchor);
    } else {
      d.legal = false; // off-board / off-row: stay at the last seat
    }
    view?.setIllegal(!d.legal);
  };

  #onPartPointerUp = (e) => {
    const d = this.#mode;
    if (
      (d?.kind !== "drag-part" &&
        d?.kind !== "drag-brick" &&
        d?.kind !== "drag-resistor" &&
        d?.kind !== "drag-resistor-end") ||
      e.pointerId !== d.pointerId
    ) {
      return;
    }
    this.#mode = null;
    this.#viewport.classList.remove("desk-viewport--dragging");

    const view = this.#partViews.get(d.id);
    if (view) {
      const partEl = view.element;
      partEl.removeEventListener("pointermove", this.#onPartPointerMove);
      partEl.removeEventListener("pointerup", this.#onPartPointerUp);
      partEl.removeEventListener("pointercancel", this.#onPartPointerUp);
      try {
        partEl.releasePointerCapture(d.pointerId);
      } catch {
        /* already released */
      }
      view.setDragging(false);
      view.setIllegal(false);
    }

    const cancelled = e.type === "pointercancel";
    if (d.kind === "drag-resistor-end") {
      if (!d.active) return; // plain click — the press already selected it
      if (!cancelled && d.legal && d.target) {
        this.#doc.movePartEnds(
          d.id,
          d.target.boardId,
          d.target.anchor,
          d.target.end,
        );
        this.#emitDocChanged();
      }
      // Redraw from the document — an illegal drop wrote nothing, so the lead
      // springs back to where it was.
      this.#remountPart(d.id);
      return;
    }

    if (d.kind === "drag-resistor") {
      if (!d.active) return; // plain click — the press already selected it
      if (!cancelled && d.legal && d.holes) {
        this.#doc.movePartEnds(
          d.id,
          d.holes.boardId,
          d.holes.anchor,
          d.holes.end,
        );
        this.#emitDocChanged();
      }
      // Commit or not, redraw from the document — an illegal drop leaves the
      // document untouched, so this snaps the resistor back to its origin.
      this.#remountPart(d.id);
      return;
    }

    if (d.kind === "drag-brick") {
      if (!d.active) return;
      const moved = d.pos.x !== d.origin.x || d.pos.y !== d.origin.y;
      if (!cancelled && d.legal && moved) {
        this.#doc.moveBrick(d.id, d.pos.x, d.pos.y);
        this.#emitDocChanged();
      } else {
        view?.setPosition(d.origin.x, d.origin.y);
        this.#wireLayer.render();
      }
      return;
    }

    if (!d.active) {
      // Plain click: a slide switch flips (always interactive).
      const comp = this.#doc.getComponent(d.id);
      if (comp?.ref === "sw-slide") this.#toggleSlideSwitch(d.id);
      return;
    }
    const moved =
      d.seat.board !== d.origin.board || d.seat.anchor !== d.origin.anchor;
    // A chip flipped mid-drag commits its half-lap even if it lands back where
    // it started (the footprint maps onto itself, so it's always legal).
    const flipped = !cancelled && d.flip === true;
    if (flipped) this.#doc.rotateComponent(d.id);
    if (!cancelled && d.legal && moved) {
      this.#doc.moveComponent(d.id, d.seat.board, d.seat.anchor);
      view?.updatePlacement(this.#doc.getBoard(d.seat.board), d.seat.anchor);
      this.#emitDocChanged();
    } else {
      if (flipped) this.#emitDocChanged();
      view?.updatePlacement(
        this.#doc.getBoard(d.origin.board),
        d.origin.anchor,
      );
    }
    // Sync the drawn orientation to the document (undoes a cancelled preview).
    if (d.flip) view?.updateParams(this.#doc.getComponent(d.id)?.params ?? {});
  };

  #onPartContextMenu(id, e) {
    e.preventDefault();
    if (this.#mode) return;
    this.selectComponent(id);
    const comp = this.#doc.getComponent(id);
    // PSU: voltage is a live input — the picker stays available while running;
    // removal is a topology edit, so it's dropped when editing is locked.
    if (comp?.kind === "psu") {
      const items = PSU_VOLTS.map((volts) => ({
        label: `${comp.params.volts === volts ? "● " : ""}${volts} V`,
        onSelect: () => this.setPsuVolts(id, volts),
      }));
      if (!this.#editingLocked) {
        items.push({
          label: "Remove power supply",
          danger: true,
          onSelect: () => this.removeComponent(id),
        });
      }
      PopupManager.menu({ x: e.clientX, y: e.clientY, items });
      return;
    }
    // Clock: rate is a live setting (stays available while running); removal
    // is a topology edit, dropped when editing is locked.
    if (comp?.kind === "clock") {
      const items = CLOCK_HZ.map((hz) => ({
        label: `${comp.params.hz === hz ? "● " : ""}${hz === "manual" ? "Manual" : `${hz} Hz`}`,
        onSelect: () => this.setClockHz(id, hz),
      }));
      if (!this.#editingLocked) {
        items.push({
          label: "Remove clock",
          danger: true,
          onSelect: () => this.removeComponent(id),
        });
      }
      PopupManager.menu({ x: e.clientX, y: e.clientY, items });
      return;
    }
    // A damaged chip offers "Replace chip" (resets Feature 90 damage) — the
    // only part action that stays live while running. (The pinout is a
    // double-click, not a menu item — see #onPartDoubleClick.)
    const items = [];
    if (comp?.kind === "chip" && comp.params?.damaged === true) {
      items.push({
        label: "Replace chip",
        onSelect: () => this.#onReplaceChip?.(id),
      });
    }
    if (!this.#editingLocked) {
      if (partDef(comp?.ref)?.rotatable) {
        items.push({
          label: "Rotate 90°",
          onSelect: () => this.rotateComponent(id),
        });
      }
      items.push({
        label: comp?.kind === "chip" ? "Remove chip" : "Remove part",
        danger: true,
        onSelect: () => this.removeComponent(id),
      });
      items.push({ label: "Properties…", disabled: true });
    }
    if (items.length === 0) return; // nothing actionable (frozen non-chip)
    PopupManager.menu({ x: e.clientX, y: e.clientY, items });
  }

  // ── Marquee selection (shift-drag anywhere) ─────────────────────────────

  /** Components whose EVERY pin/terminal lies inside the world-unit rect. */
  #componentsWithin(rect) {
    return componentsInRect(this.#doc.boards, this.#doc.components, rect);
  }

  /** Wires with BOTH endpoints inside the world-unit rect. */
  #wiresWithin(rect) {
    return wiresInRect(
      this.#doc.boards,
      this.#doc.components,
      this.#doc.wires,
      rect,
    );
  }

  #beginMarquee(e) {
    this.#hideHover();
    this.#viewport.classList.add("desk-viewport--selecting"); // crosshair
    const world = this.#deskView.worldFromEvent(e);
    this.#marquee = el("div", { class: "marquee" });
    this.#layers.overlay.append(this.#marquee);
    this.#mode = {
      kind: "marquee",
      pointerId: e.pointerId,
      startWorld: world,
      rect: { minX: world.x, minY: world.y, maxX: world.x, maxY: world.y },
    };
    try {
      this.#viewport.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort (synthetic events) */
    }
    this.#viewport.addEventListener("pointermove", this.#onMarqueePointerMove);
    this.#viewport.addEventListener("pointerup", this.#onMarqueePointerUp);
    this.#viewport.addEventListener("pointercancel", this.#onMarqueePointerUp);
  }

  #onMarqueePointerMove = (e) => {
    const m = this.#mode;
    if (m?.kind !== "marquee" || e.pointerId !== m.pointerId) return;
    const w = this.#deskView.worldFromEvent(e);
    m.rect = {
      minX: Math.min(m.startWorld.x, w.x),
      minY: Math.min(m.startWorld.y, w.y),
      maxX: Math.max(m.startWorld.x, w.x),
      maxY: Math.max(m.startWorld.y, w.y),
    };
    const box = this.#marquee;
    if (!box) return;
    box.style.left = `${m.rect.minX * PX_PER_UNIT}px`;
    box.style.top = `${m.rect.minY * PX_PER_UNIT}px`;
    box.style.width = `${(m.rect.maxX - m.rect.minX) * PX_PER_UNIT}px`;
    box.style.height = `${(m.rect.maxY - m.rect.minY) * PX_PER_UNIT}px`;
  };

  #onMarqueePointerUp = (e) => {
    const m = this.#mode;
    if (m?.kind !== "marquee" || e.pointerId !== m.pointerId) return;
    this.#mode = null;
    this.#viewport.removeEventListener(
      "pointermove",
      this.#onMarqueePointerMove,
    );
    this.#viewport.removeEventListener("pointerup", this.#onMarqueePointerUp);
    this.#viewport.removeEventListener(
      "pointercancel",
      this.#onMarqueePointerUp,
    );
    try {
      this.#viewport.releasePointerCapture(m.pointerId);
    } catch {
      /* already released */
    }
    this.#marquee?.remove();
    this.#marquee = null;
    this.#viewport.classList.remove("desk-viewport--selecting");
    if (e.type === "pointercancel") return;
    this.#setMultiSelection(
      this.#componentsWithin(m.rect),
      this.#wiresWithin(m.rect),
    );
  };

  /**
   * Delete every marquee-selected component in ONE step (a single
   * doc-changed). Bricks cascade their attached wires, so that's confirmed
   * once for the whole batch rather than per part.
   */
  removeSelectedComponents() {
    const ids = [...this.#multi];
    const wireIds = [...this.#multiWires];
    if (ids.length + wireIds.length === 0 || this.#editingLocked) return;
    // Bricks cascade their attached wires. Wires the marquee already picked are
    // going anyway, so only the EXTRA ones need confirming.
    const cascaded = new Set();
    for (const id of ids) {
      for (const w of this.#doc.wiresTouching(id)) {
        if (!this.#multiWires.has(w.id)) cascaded.add(w.id);
      }
    }
    if (cascaded.size === 0) {
      this.#doRemoveSelected(ids, wireIds);
      return;
    }
    const what = [
      ids.length && `${ids.length} part${ids.length === 1 ? "" : "s"}`,
      wireIds.length &&
        `${wireIds.length} wire${wireIds.length === 1 ? "" : "s"}`,
    ]
      .filter(Boolean)
      .join(" and ");
    const extra = `${cascaded.size} more wire${cascaded.size === 1 ? "" : "s"}`;
    PopupManager.confirm({
      title: `Remove ${what}?`,
      message: `${extra} attached to them will be removed too.`,
      confirmLabel: "Remove",
      confirmClass: "btn--danger",
      onConfirm: () => this.#doRemoveSelected(ids, wireIds),
    });
  }

  #doRemoveSelected(ids, wireIds = []) {
    this.#clearMultiSelection();
    for (const id of ids) {
      if (!this.#doc.getComponent(id)) continue; // already cascaded away
      this.#doc.removeComponent(id);
      this.#partViews.get(id)?.remove();
      this.#partViews.delete(id);
    }
    for (const id of wireIds) {
      if (this.#doc.getWire(id)) this.#doc.removeWire(id); // may have cascaded
    }
    this.#hideHover();
    this.#emitDocChanged();
  }

  // ── Viewport-level pointer handling ─────────────────────────────────────

  #onViewportPointerDown = (e) => {
    this.#lastDown = { x: e.clientX, y: e.clientY };
    if (this.#mode || e.button !== 0) return; // busy (tool/drag) or non-left
    // Shift-drag anywhere rubber-bands a multi-selection (never a pan — DeskView
    // skips shift-left too). Not while probing or running.
    if (e.shiftKey && !this.#probe.armed && !this.#editingLocked) {
      this.#beginMarquee(e);
      return;
    }
    // Not while probing (clicks pin nets) or running (topology frozen). A
    // press near a wire cap re-routes its end; on the body, translates it.
    if (!this.#probe.armed && !this.#editingLocked) {
      if (this.#wire.tryBeginDrag(e, this.#deskView.worldFromEvent(e))) return;
    }
    // Click on truly empty desk (the viewport itself — layers are zero-size
    // and overlay children are pointer-inert) deselects.
    if (e.target === this.#viewport) this.deselect();
  };

  #onViewportClick = (e) => {
    const m = this.#mode;
    if (!this.placementArmed && m?.kind !== "wire" && !this.#probe.armed)
      return;
    // A pan that started while armed still ends in a click — suppress it.
    if (
      this.#lastDown &&
      Math.hypot(e.clientX - this.#lastDown.x, e.clientY - this.#lastDown.y) >=
        DRAG_THRESHOLD
    ) {
      return;
    }
    if (this.#probe.armed) {
      this.#probe.commitClick(this.#deskView.worldFromEvent(e));
      return;
    }
    if (m.kind === "wire") {
      this.#wire.commitClick(e);
      return;
    }
    this.#trackGhost(e); // ensure the seat reflects the click point
    if (!m.legal) return; // stay armed, the tint explains why
    this.cancelPlacement();
    if (m.kind === "place") {
      this.addKitAt(m.kit, m.pos.x, m.pos.y, m.rot);
    } else if (m.kind === "place-brick") {
      this.addBrickAt(m.ref, m.pos.x, m.pos.y, m.params);
    } else if (m.kind === "place-part") {
      this.addComponentAt(
        m.ref,
        m.board,
        m.anchor,
        m.turns ? { ...m.params, rot: 90, end: m.end } : m.params,
      );
    } else {
      this.addComponentAt(m.ref, m.board, m.anchor, m.params);
    }
  };

  #onViewportPointerMove = (e) => {
    const m = this.#mode;
    if (this.placementArmed) {
      this.#trackGhost(e);
      return;
    }
    if (m?.kind === "wire") {
      this.#wire.trackMove(e);
      return;
    }
    if (this.#probe.armed) {
      this.#probe.trackMove(this.#deskView.worldFromEvent(e));
      return;
    }
    if (m) return; // dragging — hover stays hidden

    const world = this.#deskView.worldFromEvent(e);
    // Hover addressing: suppressed below the zoom floor.
    if (this.#deskView.camera.zoom < HOVER_MIN_ZOOM) {
      this.#hideHover();
      return;
    }
    const hit = this.#hitTest(world);
    if (!hit) {
      this.#hideHover();
      return;
    }
    if (hit.key === this.#hoverKey) return; // shown or pending already
    this.#hideHover();
    this.#hoverKey = hit.key;
    this.#hoverTimer = setTimeout(() => this.#showHover(hit), HOVER_DWELL_MS);
  };

  // ── Hover addressing (holes, part pins, PSU terminals — pure math) ──────

  /** The board + hole under a world point — see occupancy.js holeAtWorld(),
      the one authority (this used to be a second, subtly different scan). */
  #holeAtWorld(world) {
    return holeAtWorld(this.#doc.boards, world.x, world.y);
  }

  /**
   * What the pointer is over — a part pin/terminal (they sit above) or a bare
   * hole — as `{ key, label, address, x, y }`. See model/part-geometry.js.
   */
  #hitTest(world) {
    return hoverHitAt(this.#doc.boards, this.#doc.components, world);
  }

  #showHover({ label, x, y }) {
    const wx = x * PX_PER_UNIT;
    const wy = y * PX_PER_UNIT;

    const r = RING_RADIUS * PX_PER_UNIT;
    this.#ring.style.left = `${wx - r}px`;
    this.#ring.style.top = `${wy - r}px`;
    this.#ring.hidden = false;

    this.#tooltip.textContent = label;
    this.#tooltip.style.left = `${wx}px`;
    this.#tooltip.style.top = `${wy}px`;
    // Counter-scale so the label reads the same at every zoom.
    this.#tooltip.style.setProperty(
      "--inv-zoom",
      String(1 / this.#deskView.camera.zoom),
    );
    this.#tooltip.hidden = false;
  }

  #hideHover() {
    clearTimeout(this.#hoverTimer);
    this.#hoverTimer = null;
    this.#hoverKey = null;
    this.#ring.hidden = true;
    this.#ring.classList.remove("hole-ring--illegal");
    this.#tooltip.hidden = true;
  }

  #emitDocChanged() {
    // Boards may have moved, been torn out of a group, or been deleted —
    // re-trace the highlighter before anyone renders from the new document.
    this.#refreshBoardOutline();
    window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  }
}
