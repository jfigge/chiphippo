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
  componentPoints,
  componentsInRect,
  hoverHitAt,
  partPinsWorld,
  wiresInRect,
} from "../model/part-geometry.js";
import {
  captureCluster,
  memberForm,
  resolveCluster,
} from "../model/paste-cluster.js";
import { DeskDoc } from "../model/desk-doc.js";
import { HistoryStore } from "../model/history-store.js";
import { partDef } from "../catalog/index.js";
import { PSU_VOLTS, CLOCK_HZ, LCD_SIZES } from "../catalog/parts.js";
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
import { LcdView, buildLcdSvg } from "./lcd-view.js";
import { WireLayer } from "./wire-layer.js";
import { AnnotationLayer } from "./annotation-layer.js";
import { SimOverlay } from "./sim-overlay.js";
import { ProbeInspector } from "./probe-inspector.js";
import { WireTools } from "./wire-tools.js";
import { BusTools } from "./bus-tools.js";
import { BoardOutline } from "./board-outline.js";

/** The static SVG for a desk brick (PSU / clock / LCD) by kind. */
function brickSvg(kind, params) {
  if (kind === "psu") return buildPsuSvg(params);
  if (kind === "clock") return buildClockSvg(params);
  return buildLcdSvg(params);
}

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
  #annotationLayer; // AnnotationLayer: labels + notes (Feature 120)
  #selected = null; // { kind: "board"|"part"|"wire"|"annotation", id } | null
  #copyBuffer = null; // { ref, params } of the last Cmd+C'd component | null
  #clusterBuffer = null; // a captured multi-selection for a cluster paste | null
  // Active interaction: null, or
  //   { kind: "place", type, ghost, pos, legal }              (board)
  //   { kind: "place-chip", ref, ghost, board, anchor, legal }
  //   { kind: "place-part", ref, params, ghost, board, anchor, legal }
  //   { kind: "place-brick", ref, params, ghost, pos, legal }   (PSU / clock)
  //   { kind: "drag", id, … }                                 (board drag)
  //   { kind: "drag-part", id, … }                            (chip/discrete)
  //   { kind: "drag-brick", id, … }
  //   { kind: "place-annotation", annKind, ghost, pos, anchor } (label / note)
  //   { kind: "drag-annotation", id, … }                      (label / note)
  //   { kind: "wire", from, hover }                           (wire tool)
  #mode = null;
  #wire; // WireTools: the wire tool + endpoint/whole-wire drags (shares #mode)
  #bus; // BusTools: the bus tool + whole-bus drag (Feature 130, shares #mode)
  #busName = "D[7:0]"; // the name the bus tool reads (driven by the toolbar input)
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
  // Undo/redo (Feature 200): a bounded snapshot history the doc-changed choke
  // point feeds. `#restoring` suppresses re-recording while a restore replays.
  #history = new HistoryStore();
  #restoring = false;
  #onHistoryChange;
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
   * @param {(state: {canUndo: boolean, canRedo: boolean}) => void}
   *   [opts.onHistoryChange] - undo/redo availability changed (drives the
   *   Edit-menu enable state, Feature 200).
   */
  constructor({
    viewport,
    deskView,
    deskDoc,
    onWireStateChange,
    onBusStateChange,
    onProbeStateChange,
    onReplaceChip,
    onClockToggle,
    onOpenPinout,
    onHistoryChange,
  }) {
    this.#viewport = viewport;
    this.#deskView = deskView;
    this.#doc = deskDoc;
    this.#onReplaceChip = onReplaceChip;
    this.#onClockToggle = onClockToggle;
    this.#onOpenPinout = onOpenPinout;
    this.#onHistoryChange = onHistoryChange;

    // Layer order (established for every later stage): boards under parts
    // under wires under the interaction overlay. All are zero-size anchors —
    // children position absolutely in world px.
    const surface = deskView.surface;
    this.#layers = {
      boards: el("div", { class: "layer-boards" }),
      parts: el("div", { class: "layer-parts" }),
      wires: el("div", { class: "layer-wires" }),
      annotations: el("div", { class: "layer-annotations" }),
      overlay: el("div", { class: "layer-overlay" }),
    };
    surface.append(
      this.#layers.boards,
      this.#layers.parts,
      this.#layers.wires,
      this.#layers.annotations,
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
      onSelectBus: (id) => this.selectBus(id),
      onBusContextMenu: (id, e) => this.#bus.onContextMenu(id, e),
    });

    // Labels + notes (Feature 120): one renderer over the annotations layer,
    // between wires and the interaction overlay.
    this.#annotationLayer = new AnnotationLayer(
      this.#layers.annotations,
      deskDoc,
      {
        onPointerDown: (id, e) => this.#onAnnotationPointerDown(id, e),
        onContextMenu: (id, e) => this.#onAnnotationContextMenu(id, e),
        onEditCommit: (id, text) => this.#commitAnnotationText(id, text),
      },
    );

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
      onNameNet: (address, name, stale) => this.nameNet(address, name, stale),
      onClearNetNames: (addresses) => this.clearNetNames(addresses),
      coordinate: {
        cancelPlacement: () => this.cancelPlacement(),
        disarmWireTool: () => this.disarmWireTool(),
        disarmBusTool: () => this.disarmBusTool(),
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
      emitDocChanged: (label) => this.#emitDocChanged(label),
      hideHover: () => this.#hideHover(),
      selectWire: (id) => this.selectWire(id),
      deselect: () => this.deselect(),
      cancelPlacement: () => this.cancelPlacement(),
      disarmProbe: () => this.disarmProbe(),
      disarmBusTool: () => this.disarmBusTool(),
      clearSelectionIfWire: (id) => this.#clearSelectionIfWire(id),
      onStateChange: onWireStateChange,
    });

    // Bus subsystem (Feature 130): the bus tool + whole-bus drag + its context
    // menu. Like WireTools it shares `#mode` through this host; the bus color
    // rides the shared wire-color pick and the name comes from the toolbar
    // input (which drives `#busName` through setBusName).
    this.#bus = new BusTools({
      get mode() {
        return self.#mode;
      },
      set mode(v) {
        self.#mode = v;
      },
      get editingLocked() {
        return self.#editingLocked;
      },
      get busName() {
        return self.#busName;
      },
      get busColor() {
        return self.#wire.color;
      },
      doc: deskDoc,
      deskView,
      viewport,
      wireLayer: this.#wireLayer,
      ring: this.#ring,
      emitDocChanged: (label) => this.#emitDocChanged(label),
      hideHover: () => this.#hideHover(),
      selectBus: (id) => this.selectBus(id),
      deselect: () => this.deselect(),
      cancelPlacement: () => this.cancelPlacement(),
      disarmProbe: () => this.disarmProbe(),
      disarmWireTool: () => this.disarmWireTool(),
      clearSelectionIfBus: (id) => this.#clearSelectionIfBus(id),
      onStateChange: onBusStateChange,
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

    // Seed the undo history with the loaded document as the baseline — a fresh
    // document (New/Open reload) starts a fresh, single-entry history.
    this.#history.clear(this.#doc.snapshot());
    this.#notifyHistoryState();

    viewport.addEventListener("pointerdown", this.#onViewportPointerDown);
    viewport.addEventListener("pointermove", this.#onViewportPointerMove);
    viewport.addEventListener("pointerleave", () => this.#hideHover());
    viewport.addEventListener("click", this.#onViewportClick);
    // Right-click while probing names the net under the cursor; while wiring it
    // cancels the pending wire (Esc-equivalent).
    viewport.addEventListener("contextmenu", (e) => {
      if (this.#probe.armed) {
        e.preventDefault();
        this.#probe.onContextMenu(this.#deskView.worldFromEvent(e), e);
        return;
      }
      if (this.#wire.armed) {
        e.preventDefault();
        this.#wire.cancelPending();
        return;
      }
      if (this.#bus.armed) {
        e.preventDefault();
        this.#bus.cancelPending();
      }
    });
  }

  get selectedId() {
    return this.#selected?.id ?? null;
  }

  get placementArmed() {
    return [
      "place",
      "place-chip",
      "place-part",
      "place-brick",
      "place-annotation",
      "place-cluster",
    ].includes(this.#mode?.kind);
  }

  // ── Selection (boards, parts, and wires share one slot) ─────────────────

  #applySelection(sel, on) {
    if (!sel) return;
    if (sel.kind === "board") this.#views.get(sel.id)?.setSelected(on);
    else if (sel.kind === "part") this.#partViews.get(sel.id)?.setSelected(on);
    else if (sel.kind === "annotation") {
      this.#annotationLayer.setSelected(on ? sel.id : null);
    } else if (sel.kind === "bus") {
      this.#wireLayer.setSelectedBus(on ? sel.id : null);
    } else this.#wireLayer.setSelected(on ? sel.id : null);
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

  selectBus(id) {
    if (this.#mode) return; // busing/placing/dragging — clicks aren't selects
    this.#select(this.#doc.getBus(id) ? { kind: "bus", id } : null);
  }

  selectAnnotation(id) {
    this.#select(
      this.#doc.getAnnotation(id) ? { kind: "annotation", id } : null,
    );
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

  /** Drop the selection if it is this bus (BusTools calls this on remove). */
  #clearSelectionIfBus(id) {
    if (this.#selected?.kind === "bus" && this.#selected.id === id) {
      this.#selected = null;
      this.#wireLayer.setSelectedBus(null);
    }
  }

  // ── Placement modes (toolbar Add-board / palette picks) ─────────────────

  #enterPlacement(mode) {
    if (this.#editingLocked) return; // topology is frozen while running
    this.cancelPlacement();
    this.disarmWireTool();
    this.disarmBusTool();
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
    if (def.kind === "psu" || def.kind === "clock" || def.kind === "lcd") {
      ghost.append(brickSvg(def.kind, normalized));
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
   * Cmd+C: remember what's selected so Cmd+V can drop a fresh duplicate.
   *
   * A marquee MULTI-selection copies as a rigid CLUSTER — every selected part
   * and brick, in the exact arrangement of the source; wires are never part of
   * a paste. A single selected part keeps the simpler one-off buffer. Either
   * way the copy is a brand-new part (its arrangement, none of its run-state) —
   * see captureCluster / pasteComponent. A board, a wire, or nothing selected
   * is ignored (returns false, so the native Edit-menu copy still serves text
   * fields). The buffer deep-copies params, so later edits to the source never
   * bleed in.
   */
  copySelectedComponent() {
    if (this.#multi.size > 0) {
      const comps = [...this.#multi]
        .map((id) => this.#doc.getComponent(id))
        .filter(Boolean);
      const cluster = captureCluster(this.#doc.boards, comps);
      if (!cluster) return false;
      this.#clusterBuffer = cluster;
      this.#copyBuffer = null; // the cluster wins the next paste
      return true;
    }
    if (this.#selected?.kind !== "part") return false;
    const comp = this.#doc.getComponent(this.#selected.id);
    if (!comp) return false;
    this.#copyBuffer = {
      ref: comp.ref,
      params: comp.params ? JSON.parse(JSON.stringify(comp.params)) : {},
    };
    this.#clusterBuffer = null;
    return true;
  }

  /**
   * Cmd+V: arm a placement ghost for a duplicate of the copied component so the
   * user just clicks to drop it. The buffer persists, so repeated Cmd+V stamps
   * more copies. Returns false when nothing has been copied. Orientation carries
   * over: a flipped chip pastes flipped, and a rotatable part (LED / resistor)
   * copied in its turned two-free-ends form re-arms turned the same CARDINAL way
   * (R still re-spins it). The bend is NORMALISED back to the clean footprint
   * span — never the source's verbatim lead vector: that vector may have been
   * stretched to reach a power rail (whose holes sit on a non-uniform lattice),
   * and re-injecting it would pin the drop to that exact grid→rail geometry, so
   * the paste would refuse most rail positions. A footprint-span bend re-fits
   * freely, exactly like a fresh turned part — drag an end onto a rail after.
   */
  pasteComponent() {
    if (this.#clusterBuffer) {
      this.#armClusterPlacement(this.#clusterBuffer);
      return true;
    }
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
      // Keep the source's cardinal direction, but snap the magnitude back to a
      // clean footprint-span bend so the drop re-fits anywhere (see the method
      // doc). A raw rail-reaching vector would only re-validate where the exact
      // grid→rail displacement recurs.
      const { dx, dy } = buf.params.end;
      const turns =
        Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 2) : dy >= 0 ? 1 : 3;
      this.#mode.orient = this.#ghostOrient(buf.ref, turns);
    }
    return true;
  }

  /**
   * Arm a CLUSTER paste: one translucent ghost per copied member, wrapped in a
   * single container element (so `#enterPlacement`/`cancelPlacement` treat it
   * like any other placement ghost). The arrangement translates rigidly with
   * the cursor; each member is tinted green/red by whether it seats legally,
   * re-evaluated on every move. The buffer persists, so repeated Cmd+V stamps
   * the arrangement again.
   */
  #armClusterPlacement(cluster) {
    const box = el("div", { class: "part-ghost-cluster", hidden: true });
    const ghosts = cluster.members.map((m) => {
      const g = el("div", { class: "part-ghost" });
      g.append(this.#buildMemberGhostSvg(m));
      box.append(g);
      return g;
    });
    this.#enterPlacement({
      kind: "place-cluster",
      cluster,
      ghost: box,
      ghosts,
      results: [],
      legalCount: 0,
    });
  }

  /** The drawn SVG for one cluster member, by its placement form. */
  #buildMemberGhostSvg(m) {
    switch (memberForm(m.ref, m.params)) {
      case "chip":
        return buildChipSvg(m.ref, m.params);
      case "turned":
        return buildSpanSvg(m.ref, m.params.end.dx, m.params.end.dy, m.params);
      case "brick":
        return brickSvg(partDef(m.ref).kind, m.params);
      default:
        return buildDiscreteSvg(m.ref, m.params);
    }
  }

  #trackClusterGhost(e) {
    const m = this.#mode;
    const w = this.#deskView.worldFromEvent(e);
    // A rigid, integer-pitch shift keeps the arrangement exact and lets every
    // hole-anchored member land squarely on a hole (or over nothing → red).
    const shift = {
      dx: Math.round(w.x - m.cluster.center.x),
      dy: Math.round(w.y - m.cluster.center.y),
    };
    const results = resolveCluster(
      {
        boards: this.#doc.boards,
        components: this.#doc.components,
        wires: this.#doc.wires,
      },
      m.cluster.members,
      shift,
      (ref, x, y) => this.#doc.canPlaceBrick(ref, x, y),
    );
    m.results = results;
    m.shift = shift;
    m.legalCount = results.reduce((n, r) => n + (r.legal ? 1 : 0), 0);
    m.ghost.hidden = false;
    results.forEach((r, i) => {
      const g = m.ghosts[i];
      const tl = this.#memberGhostTopLeft(r, shift);
      g.style.left = `${tl.x * PX_PER_UNIT}px`;
      g.style.top = `${tl.y * PX_PER_UNIT}px`;
      g.classList.toggle("part-ghost--legal", r.legal);
      g.classList.toggle("part-ghost--illegal", !r.legal);
    });
  }

  /** Top-left (pitch units) of a member's ghost after the rigid shift — the
      same box maths the seated views use, translated by `shift`. */
  #memberGhostTopLeft(member, shift) {
    const ax = member.anchorWorld.x + shift.dx;
    const ay = member.anchorWorld.y + shift.dy;
    switch (member.form ?? memberForm(member.ref, member.params)) {
      case "chip": {
        const box = chipBox(partDef(member.ref).package);
        return { x: ax + box.minX, y: ay + box.minY };
      }
      case "turned": {
        const pad = spanPad(member.ref);
        const { dx, dy } = member.params.end;
        return { x: ax + Math.min(0, dx) - pad, y: ay + Math.min(0, dy) - pad };
      }
      case "brick":
        return { x: ax, y: ay };
      default: {
        const box = discreteBox(member.ref);
        return { x: ax + box.minX, y: ay + box.minY };
      }
    }
  }

  /**
   * Drop a cluster paste: seat every member with a legal placement and DISCARD
   * the rest (a red member simply isn't part of the paste). One doc-changed for
   * the whole batch; the freshly-pasted set becomes the new marquee selection so
   * it can be nudged, deleted, or copied again as a unit.
   */
  #commitClusterPaste() {
    const results = this.#mode.results;
    this.cancelPlacement(); // removes the ghost box, clears #mode
    const newIds = [];
    for (const r of results) {
      if (!r.legal) continue;
      try {
        const comp =
          r.form === "brick"
            ? this.#doc.addBrick(r.ref, r.seat.x, r.seat.y, r.params)
            : this.#doc.addComponent({
                kind: partDef(r.ref).kind,
                ref: r.ref,
                board: r.seat.board,
                anchor: r.seat.anchor,
                params: r.params,
              });
        this.#mountPart(comp);
        newIds.push(comp.id);
      } catch {
        /* validated already — skip a stray failure rather than abort the batch */
      }
    }
    if (newIds.length === 0) return;
    this.#emitDocChanged("paste");
    this.#setMultiSelection(newIds);
  }

  #trackGhost(e) {
    const kind = this.#mode.kind;
    if (kind === "place") this.#trackBoardGhost(e);
    else if (kind === "place-brick") this.#trackBrickGhost(e);
    else if (kind === "place-annotation") this.#trackAnnotationGhost(e);
    else if (kind === "place-cluster") this.#trackClusterGhost(e);
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
    this.#emitDocChanged("rotate part");
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

  // ── Bus tool (Feature 130) ───────────────────────────────────────────────
  // The bus subsystem lives in BusTools; these are the public shims app.js /
  // keyboard drive it through. The bus color rides the shared wire-color pick;
  // the name comes from the toolbar input via setBusName.

  get busToolArmed() {
    return this.#bus.armed;
  }

  /** The name the bus tool will lay next (from the toolbar input). */
  get busName() {
    return this.#busName;
  }

  /** Update the bus name the tool reads (the toolbar input's `input` event). */
  setBusName(name) {
    this.#busName = typeof name === "string" ? name : "";
  }

  armBusTool() {
    this.#bus.arm();
  }

  disarmBusTool() {
    this.#bus.disarm();
  }

  toggleBusTool() {
    this.#bus.toggle();
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

  // ── Schematic view (Feature 150) ─────────────────────────────────────────
  // The derived schematic drags symbols; each nudge (and the auto-layout reset)
  // commits through the one doc-changed seam so it lands in undo/redo and
  // persists. Purely a layout hint — the physical desk placement is untouched.

  /** Persist a schematic symbol's position nudge. */
  setSchematicPos(id, x, y) {
    try {
      this.#doc.setSchematicPos(id, x, y);
    } catch {
      return; // the component vanished mid-drag — nothing to record
    }
    this.#emitDocChanged("move symbol");
  }

  /** Clear every schematic nudge, returning the diagram to auto-layout. */
  autoLayoutSchematic() {
    if (this.#doc.clearSchematicPositions() > 0) {
      this.#emitDocChanged("auto-layout schematic");
    }
  }

  // ── Net names (Feature 120) ──────────────────────────────────────────────
  // The probe drives these; each is one commit through the doc-changed seam so
  // it lands in undo/redo. Naming is inert to the engine — the netlist just
  // resolves the binding to a net and hangs the name on it.

  /**
   * Bind `name` to the net that `address` sits on, first clearing any `stale`
   * bindings on the same net so a rename never self-conflicts.
   */
  nameNet(address, name, stale = []) {
    try {
      for (const a of stale) this.#doc.clearNetName(a);
      this.#doc.nameNet(address, name);
    } catch {
      return; // bad address/name — leave the document untouched
    }
    this.#emitDocChanged("name net");
  }

  /** Clear every net-name binding in `addresses` (one undo step). */
  clearNetNames(addresses) {
    let changed = false;
    for (const a of addresses) {
      if (this.#doc.clearNetName(a)) changed = true;
    }
    if (changed) this.#emitDocChanged("clear net name");
  }

  // ── Annotations: labels & notes (Feature 120) ────────────────────────────

  /** Arm a place-annotation ghost that drops a label / note on click. */
  armAnnotationPlacement(kind) {
    if (this.#editingLocked) return;
    const ghost = el("div", {
      class: `annotation annotation--${kind} annotation-ghost`,
      hidden: true,
    });
    ghost.append(
      el("div", {
        class: "annotation-text annotation-text--empty",
        text: kind === "note" ? "Note" : "Label",
      }),
    );
    this.#enterPlacement({
      kind: "place-annotation",
      annKind: kind,
      ghost,
      pos: null,
      anchor: null,
      legal: true,
    });
  }

  /** Place-annotation ghost: rides the cursor; anchors when over a part. */
  #trackAnnotationGhost(e) {
    const m = this.#mode;
    const w = this.#deskView.worldFromEvent(e);
    m.pos = { x: w.x, y: w.y };
    m.anchor = this.#componentAt(w);
    m.ghost.hidden = false;
    m.ghost.classList.toggle("annotation-ghost--anchored", Boolean(m.anchor));
    m.ghost.style.left = `${w.x * PX_PER_UNIT}px`;
    m.ghost.style.top = `${w.y * PX_PER_UNIT}px`;
  }

  /** The component whose (padded) pin/terminal box contains a world point. */
  #componentAt(world) {
    for (const comp of this.#doc.components) {
      const points = componentPoints(this.#doc.boards, comp);
      if (points.length === 0) continue;
      const pad = 1; // one pitch of slack — the body extends past the pins
      const xs = points.map((p) => p.x);
      const ys = points.map((p) => p.y);
      if (
        world.x >= Math.min(...xs) - pad &&
        world.x <= Math.max(...xs) + pad &&
        world.y >= Math.min(...ys) - pad &&
        world.y <= Math.max(...ys) + pad
      ) {
        return comp.id;
      }
    }
    return null;
  }

  /** Drop a label / note; when anchored it rides its part. Opens the editor. */
  addAnnotationAt(kind, x, y, anchor = null) {
    const ann = this.#doc.addAnnotation(kind, x, y, "", { anchor });
    this.#emitDocChanged("add annotation"); // AnnotationLayer renders it
    this.selectAnnotation(ann.id);
    this.#annotationLayer.beginEdit(ann.id); // drop → type the caption
    return ann;
  }

  /** Annotations whose `anchor` is `componentId` (with base positions). */
  #hasAnchored(componentId) {
    return this.#doc.annotations.some((a) => a.anchor === componentId);
  }

  /** Shift every annotation anchored to `anchorIds` by (dx, dy) in the doc. */
  #shiftAnchoredAnnotations(anchorIds, dx, dy) {
    if (dx === 0 && dy === 0) return;
    const ids = anchorIds instanceof Set ? anchorIds : new Set([anchorIds]);
    for (const a of this.#doc.annotations) {
      if (a.anchor && ids.has(a.anchor)) {
        this.#doc.updateAnnotation(a.id, { x: a.x + dx, y: a.y + dy });
      }
    }
  }

  #commitAnnotationText(id, text) {
    try {
      this.#doc.updateAnnotation(id, { text });
    } catch {
      return;
    }
    this.#emitDocChanged("edit annotation");
  }

  /** Remove an annotation (Delete key / context menu). */
  removeAnnotation(id) {
    if (this.#editingLocked) return;
    try {
      this.#doc.removeAnnotation(id);
    } catch {
      return;
    }
    if (this.#selected?.kind === "annotation" && this.#selected.id === id) {
      this.#selected = null;
    }
    this.#emitDocChanged("delete annotation");
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
      this.disarmBusTool();
      // History is frozen for the run — run-volatile effects (12 V damage, a
      // switch flipped live) never become undo steps.
      this.#history.freeze();
    } else {
      // Stop: resume recording and re-baseline the present to the live document
      // so any run-persisted change stays consistent with undo/redo.
      this.#history.unfreeze();
      this.#history.sync(this.#doc.snapshot());
    }
    this.#notifyHistoryState();
  }

  // ── Document mutations (all flow through desk-doc) ─────────────────────

  /** Add + mount + select a single strip; emits chiphippo:doc-changed. */
  addBoardAt(type, x, y) {
    const board = this.#doc.addBoard(type, x, y);
    this.#mountBoard(board);
    this.selectBoard(board.id);
    this.#emitDocChanged("add board");
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
    this.#emitDocChanged("add board");
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
    this.#emitDocChanged("add part");
    return component;
  }

  /** Drop + mount + select a desk-level brick (PSU/clock); emits doc-changed. */
  addBrickAt(ref, x, y, params = {}) {
    const brick = this.#doc.addBrick(ref, x, y, params);
    this.#mountPart(brick);
    this.selectComponent(brick.id);
    this.#emitDocChanged("add part");
    return brick;
  }

  /**
   * Remove a board — and the whole snapped SET it belongs to. Selecting any
   * strip highlights its entire group (every joined pin-board and rail), so
   * deleting matches that outline: every strip in the set goes, along with
   * every component seated on any of them and every wire touching them —
   * including wires that cross to a board OUTSIDE the set. A lone strip is a
   * set of one. With anything to cascade, asks for confirmation first.
   */
  removeBoard(id) {
    const boardIds = this.#doc.groupMembers(id).map((b) => b.id);
    if (boardIds.length === 0) return;
    // Count the cascade deduped across the set: a component seats on one
    // strip, but a wire spanning two members touches both.
    const partIds = new Set();
    const wireIds = new Set();
    for (const bid of boardIds) {
      for (const c of this.#doc.componentsOnBoard(bid)) partIds.add(c.id);
      for (const w of this.#doc.wiresTouching(bid)) wireIds.add(w.id);
    }
    if (partIds.size === 0 && wireIds.size === 0) {
      this.#doRemoveBoards(boardIds);
      return;
    }
    const many = boardIds.length > 1;
    const bits = [];
    if (partIds.size > 0)
      bits.push(`${partIds.size} part${partIds.size === 1 ? "" : "s"}`);
    if (wireIds.size > 0)
      bits.push(`${wireIds.size} wire${wireIds.size === 1 ? "" : "s"}`);
    PopupManager.confirm({
      title: many ? "Remove boards?" : "Remove board?",
      message:
        `${many ? `These ${boardIds.length} joined boards have` : `${id} has`} ` +
        `${bits.join(" and ")} attached — removing ` +
        `${many ? "them removes those" : "the board removes them"} too.`,
      confirmLabel: "Remove",
      confirmClass: "btn--danger",
      onConfirm: () => this.#doRemoveBoards(boardIds),
    });
  }

  /**
   * Remove every strip in `boardIds` in ONE doc-changed. Each strip's model
   * removal cascades its seated components and any wire touching it (whether
   * the other end lands on another member, an unselected board, or a brick),
   * so the whole set — and every wire crossing out of it — comes away.
   */
  #doRemoveBoards(boardIds) {
    for (const bid of boardIds) {
      for (const comp of this.#doc.componentsOnBoard(bid)) {
        this.#partViews.get(comp.id)?.remove();
        this.#partViews.delete(comp.id);
        if (this.#selected?.id === comp.id) this.#selected = null;
      }
      const cascadedWires = new Set(
        this.#doc.wiresTouching(bid).map((w) => w.id),
      );
      this.#doc.removeBoard(bid); // cascades seated components + attached wires
      this.#views.get(bid)?.remove();
      this.#views.delete(bid);
      if (
        this.#selected?.id === bid ||
        (this.#selected?.kind === "wire" &&
          cascadedWires.has(this.#selected.id))
      ) {
        this.#selected = null;
      }
    }
    this.#hideHover();
    this.#emitDocChanged("delete board"); // WireLayer re-renders from this
  }

  /**
   * Remove a component. A PSU with wires on its terminals confirms first
   * (they go with it).
   */
  removeComponent(id) {
    const comp = this.#doc.getComponent(id);
    // A desk-level brick (PSU / clock / LCD) takes its wired terminals with it,
    // so confirm first when any are attached.
    if (comp?.board == null) {
      const noun =
        comp.kind === "psu"
          ? "power supply"
          : comp.kind === "clock"
            ? "clock"
            : "display";
      const wires = this.#doc.wiresTouching(id).length;
      if (wires > 0) {
        PopupManager.confirm({
          title: `Remove ${noun}?`,
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
    this.#emitDocChanged("delete part");
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
    this.#emitDocChanged("toggle switch");
  }

  /** Set a PSU's voltage (context menu). A rapid re-pick coalesces into one. */
  setPsuVolts(id, volts) {
    const updated = this.#doc.setComponentParams(id, { volts });
    this.#partViews.get(id)?.updateParams(updated.params);
    this.#emitDocChanged("set voltage", { coalesce: true });
  }

  /** Set a clock's rate (context menu). A rapid re-pick coalesces into one. */
  setClockHz(id, hz) {
    const updated = this.#doc.setComponentParams(id, { hz });
    this.#partViews.get(id)?.updateParams(updated.params);
    this.#emitDocChanged("set clock rate", { coalesce: true });
  }

  /** Set an LCD's character size (context menu, 16×2 / 20×4). */
  setLcdSize(id, size) {
    const updated = this.#doc.setComponentParams(id, { size });
    this.#partViews.get(id)?.updateParams(updated.params);
    this.#emitDocChanged("set LCD size", { coalesce: true });
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
      if (this.#bus.handleEscape()) return true;
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
    if ((e.key === "b" || e.key === "B") && bareKey) {
      this.toggleBusTool();
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
      else if (kind === "bus") this.#bus.removeBus(id, true);
      else if (kind === "annotation") this.removeAnnotation(id);
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
    } else if (component.kind === "lcd") {
      view = new LcdView(this.#layers.parts, component, callbacks);
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
      // Labels anchored to a chip on any moved strip ride the board too.
      const carried = new Set();
      for (const id of ids) {
        for (const c of this.#doc.componentsOnBoard(id)) carried.add(c.id);
      }
      this.#shiftAnchoredAnnotations(carried, d.delta.dx, d.delta.dy);
      this.#applyDragDelta(d, d.delta);
      this.#emitDocChanged("move board"); // WireLayer re-renders from this
    } else {
      this.#applyDragDelta(d, { dx: 0, dy: 0 }); // illegal drop → revert
      this.#wireLayer.render();
    }
  };

  #onBoardContextMenu(id, e) {
    e.preventDefault();
    if (this.#probe.armed) return; // right-click names the net (viewport handler)
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
        hasAnchored: this.#hasAnchored(id),
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
        hasAnchored: this.#hasAnchored(id),
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
      // Labels anchored to this brick ride it live.
      if (d.hasAnchored) {
        this.#annotationLayer.render({
          anchorId: d.id,
          dx: d.pos.x - d.origin.x,
          dy: d.pos.y - d.origin.y,
        });
      }
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
    // Labels anchored to this part ride it live, by its anchor-hole delta.
    if (d.hasAnchored) {
      const shift = this.#anchorDelta(d.origin, d.seat);
      if (shift) this.#annotationLayer.render({ anchorId: d.id, ...shift });
    }
  };

  /** World (dx, dy) between a part's origin and current anchor holes, or null. */
  #anchorDelta(origin, seat) {
    const originW = this.#addressWorld(`${origin.board}.${origin.anchor}`);
    const seatW = this.#addressWorld(`${seat.board}.${seat.anchor}`);
    if (!originW || !seatW) return null;
    return { dx: seatW.x - originW.x, dy: seatW.y - originW.y };
  }

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
        this.#emitDocChanged("move part");
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
        this.#emitDocChanged("move part");
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
        if (d.hasAnchored) {
          this.#shiftAnchoredAnnotations(
            d.id,
            d.pos.x - d.origin.x,
            d.pos.y - d.origin.y,
          );
        }
        this.#emitDocChanged("move part");
      } else {
        view?.setPosition(d.origin.x, d.origin.y);
        this.#wireLayer.render();
        if (d.hasAnchored) this.#annotationLayer.render(); // snap labels back
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
      if (d.hasAnchored) {
        const shift = this.#anchorDelta(d.origin, d.seat);
        if (shift) this.#shiftAnchoredAnnotations(d.id, shift.dx, shift.dy);
      }
      this.#emitDocChanged("move part");
    } else {
      if (flipped) this.#emitDocChanged("flip chip");
      else if (d.hasAnchored) this.#annotationLayer.render(); // snap labels back
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
    if (this.#probe.armed) return; // right-click names the net (viewport handler)
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
    // LCD: the character size (16×2 / 20×4) is a live setting; removal is a
    // topology edit, dropped when editing is locked.
    if (comp?.kind === "lcd") {
      const items = LCD_SIZES.map((size) => ({
        label: `${comp.params.size === size ? "● " : ""}${size.replace("x", "×")}`,
        onSelect: () => this.setLcdSize(id, size),
      }));
      if (!this.#editingLocked) {
        items.push({
          label: "Remove display",
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

  // ── Annotation gestures (labels & notes, Feature 120) ───────────────────

  #onAnnotationPointerDown(id, e) {
    if (e.button !== 0) return;
    if (e.shiftKey) return; // shift-drag is the viewport's marquee
    // No annotation drags while placing/dragging, probing (clicks pin nets),
    // or running (topology + decoration frozen).
    if (this.#mode || this.#probe.armed || this.#editingLocked) return;
    this.#hideHover();
    this.selectAnnotation(id);
    const ann = this.#doc.getAnnotation(id);
    if (!ann) return;
    const box = e.currentTarget;
    this.#mode = {
      kind: "drag-annotation",
      id,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startWorld: this.#deskView.worldFromEvent(e),
      origin: { x: ann.x, y: ann.y },
      pos: { x: ann.x, y: ann.y },
      active: false,
    };
    this.#viewport.classList.add("desk-viewport--dragging");
    try {
      box.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort (synthetic events) */
    }
    box.addEventListener("pointermove", this.#onAnnotationPointerMove);
    box.addEventListener("pointerup", this.#onAnnotationPointerUp);
    box.addEventListener("pointercancel", this.#onAnnotationPointerUp);
  }

  #onAnnotationPointerMove = (e) => {
    const d = this.#mode;
    if (d?.kind !== "drag-annotation" || e.pointerId !== d.pointerId) return;
    if (!d.active) {
      const travel = Math.hypot(
        e.clientX - d.startClientX,
        e.clientY - d.startClientY,
      );
      if (travel < DRAG_THRESHOLD) return;
      d.active = true;
    }
    const w = this.#deskView.worldFromEvent(e);
    d.pos = {
      x: d.origin.x + (w.x - d.startWorld.x),
      y: d.origin.y + (w.y - d.startWorld.y),
    };
    this.#annotationLayer.setPosition(d.id, d.pos.x, d.pos.y);
  };

  #onAnnotationPointerUp = (e) => {
    const d = this.#mode;
    if (d?.kind !== "drag-annotation" || e.pointerId !== d.pointerId) return;
    this.#mode = null;
    this.#viewport.classList.remove("desk-viewport--dragging");
    const box = e.currentTarget;
    box.removeEventListener("pointermove", this.#onAnnotationPointerMove);
    box.removeEventListener("pointerup", this.#onAnnotationPointerUp);
    box.removeEventListener("pointercancel", this.#onAnnotationPointerUp);
    try {
      box.releasePointerCapture(d.pointerId);
    } catch {
      /* already released */
    }
    if (!d.active) return; // plain click — the press already selected it
    const cancelled = e.type === "pointercancel";
    const moved = d.pos.x !== d.origin.x || d.pos.y !== d.origin.y;
    if (!cancelled && moved) {
      this.#doc.updateAnnotation(d.id, { x: d.pos.x, y: d.pos.y });
      this.#emitDocChanged("move annotation");
    } else {
      this.#annotationLayer.render(); // snap back from the document
    }
  };

  #onAnnotationContextMenu(id, e) {
    e.preventDefault();
    // While probing, the viewport handler names the net under the cursor.
    if (this.#probe.armed || this.#mode || this.#editingLocked) return;
    this.selectAnnotation(id);
    PopupManager.menu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "Edit text…",
          onSelect: () => this.#annotationLayer.beginEdit(id),
        },
        {
          label: "Remove",
          danger: true,
          onSelect: () => this.removeAnnotation(id),
        },
      ],
    });
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
    this.#emitDocChanged("delete selection");
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
    // press near a wire cap re-routes its end; on the body, translates it; on a
    // bundle band (below the wires), it drags the whole bus.
    if (!this.#probe.armed && !this.#editingLocked) {
      const world = this.#deskView.worldFromEvent(e);
      if (this.#wire.tryBeginDrag(e, world)) return;
      if (this.#bus.tryBeginDrag(e, world)) return;
    }
    // Click on truly empty desk (the viewport itself — layers are zero-size
    // and overlay children are pointer-inert) deselects.
    if (e.target === this.#viewport) this.deselect();
  };

  #onViewportClick = (e) => {
    const m = this.#mode;
    if (
      !this.placementArmed &&
      m?.kind !== "wire" &&
      m?.kind !== "bus" &&
      !this.#probe.armed
    )
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
    if (m.kind === "bus") {
      this.#bus.commitClick(e);
      return;
    }
    if (m.kind === "place-cluster") {
      this.#trackClusterGhost(e); // shading reflects the exact click point
      if (m.legalCount === 0) return; // nothing seats here — stay armed
      this.#commitClusterPaste();
      return;
    }
    this.#trackGhost(e); // ensure the seat reflects the click point
    if (!m.legal) return; // stay armed, the tint explains why
    this.cancelPlacement();
    if (m.kind === "place") {
      this.addKitAt(m.kit, m.pos.x, m.pos.y, m.rot);
    } else if (m.kind === "place-brick") {
      this.addBrickAt(m.ref, m.pos.x, m.pos.y, m.params);
    } else if (m.kind === "place-annotation") {
      this.addAnnotationAt(m.annKind, m.pos.x, m.pos.y, m.anchor);
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
    if (m?.kind === "bus") {
      this.#bus.trackMove(e);
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

  /**
   * The single commit seam (Feature 200): every document mutation funnels
   * through here, so this is where a labelled snapshot is pushed to the undo
   * history. A `restore` replay sets `#restoring` so it doesn't re-record, and
   * history is frozen while the circuit runs. `opts.coalesce` merges a rapid
   * same-label burst (a param nudge) into one undo step.
   *
   * @param {string} [label] - a short verb for the edit ("move board", …).
   * @param {{coalesce?: boolean}} [opts]
   */
  #emitDocChanged(label = "edit", opts = {}) {
    // Boards may have moved, been torn out of a group, or been deleted —
    // re-trace the highlighter before anyone renders from the new document.
    this.#refreshBoardOutline();
    if (!this.#restoring) {
      this.#history.record(this.#doc.snapshot(), label, Date.now(), opts);
      this.#notifyHistoryState();
    }
    window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  }

  // ── Undo / redo (Feature 200) ────────────────────────────────────────────

  /** Whether an undo is currently available (false while running). */
  get canUndo() {
    return !this.#editingLocked && this.#history.canUndo;
  }

  /** Whether a redo is currently available (false while running). */
  get canRedo() {
    return !this.#editingLocked && this.#history.canRedo;
  }

  /** Restore the previous snapshot. @returns {boolean} true when it acted. */
  undo() {
    if (this.#editingLocked) return false; // history frozen during a run
    const snapshot = this.#history.undo();
    if (snapshot == null) return false;
    this.#restoreSnapshot(snapshot);
    return true;
  }

  /** Restore the next snapshot. @returns {boolean} true when it acted. */
  redo() {
    if (this.#editingLocked) return false;
    const snapshot = this.#history.redo();
    if (snapshot == null) return false;
    this.#restoreSnapshot(snapshot);
    return true;
  }

  /**
   * Swap the whole document for a history snapshot and rebuild the scene from
   * it — the same full teardown + remount New/Open would do, never a partial,
   * drift-prone re-mount. `#restoring` keeps the resulting doc-changed from
   * re-recording the restore as a fresh edit.
   */
  #restoreSnapshot(snapshot) {
    this.#restoring = true;
    try {
      this.#doc.restore(snapshot);
      this.#rebuildScene();
      // Announce so autosave, the title/dirty marker, the sim, and the probe
      // all reconcile — but not through the recording seam.
      window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
    } finally {
      this.#restoring = false;
    }
    this.#notifyHistoryState();
  }

  /**
   * Tear down every mounted view and remount the whole scene from the current
   * document — the reusable full-rebuild path (undo/redo restore). Selection is
   * dropped; wires and the board outline re-render from the shared DeskDoc.
   */
  #rebuildScene() {
    // Drop all selection state first (the views it points at are about to go).
    this.#selected = null;
    this.#multi.clear();
    this.#multiWires.clear();
    this.#wireLayer.setSelected(null);
    this.#wireLayer.setSelectedMany([]);
    this.#annotationLayer.setSelected(null);
    this.#hideHover();
    // Unmount every board and part view (keep the Map objects — collaborators
    // hold references to them).
    for (const view of this.#views.values()) view.remove();
    this.#views.clear();
    for (const view of this.#partViews.values()) view.remove();
    this.#partViews.clear();
    // Remount from the restored document.
    for (const board of this.#doc.boards) this.#mountBoard(board);
    for (const component of this.#doc.components) this.#mountPart(component);
    this.#wireLayer.render();
    this.#boardOutline.show([], false);
  }

  /** Push the current undo/redo availability to the Edit menu. */
  #notifyHistoryState() {
    this.#onHistoryChange?.({ canUndo: this.canUndo, canRedo: this.canRedo });
  }
}
