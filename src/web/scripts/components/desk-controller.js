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

import { el } from "../dom.js";
import { PopupManager } from "../popup-manager.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import {
  formatAddress,
  holeAt,
  holePosition,
  parseAddress,
  spec,
} from "../model/breadboard.js";
import { partPinAddresses, partPinHoles } from "../model/occupancy.js";
import { packageSpec } from "../model/footprints.js";
import { DeskDoc, WIRE_COLORS } from "../model/desk-doc.js";
import { partDef } from "../catalog/index.js";
import { PSU_VOLTS, CLOCK_HZ } from "../catalog/parts.js";
import { BreadboardView, buildBoardSvg } from "./breadboard-view.js";
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
import { summarizeNet } from "../sim/netlist.js";
import { H, L } from "../sim/levels.js";
import { NetlistCache } from "./netlist-cache.js";
import { NetHighlight } from "./net-highlight.js";

/** Pointer travel (px) below which a press stays a click, not a drag/pan. */
const DRAG_THRESHOLD = 4;

/** Hover addressing: dwell before the ring/tooltip shows, and the zoom floor
    below which holes are too small for hover to mean anything. */
const HOVER_DWELL_MS = 150;
const HOVER_MIN_ZOOM = 0.75;

/** Radius of the hover ring (pitch units — a shade over one hole). */
const RING_RADIUS = 0.45;

/** Hit radius for part pins / PSU terminals (matches hole hit feel). */
const PIN_HIT_RADIUS = 0.45;

/** How close (pitch units) the cursor must press to a wire's endpoint cap to
    grab it for a drag-the-end gesture. A shade over one hole so the cap is
    forgiving to catch, but under the ~1-pitch hole spacing so an adjacent
    endpoint isn't grabbed by mistake. */
const WIRE_END_GRAB_RADIUS = 0.6;

/** How far (pitch units) the cursor may sit from a chip's trench center and
    still seat its ghost — beyond it (e.g. over the rails) the ghost floats
    unseated with the danger tint. */
const SEAT_BAND = 2.5;

/** How far (pitch units) the cursor may sit from a grid row and still seat
    a discrete part's ghost on it. */
const ROW_BAND = 0.8;

const CHIP_ANCHOR_RE = /^e([1-9]\d*)$/;
const GRID_ANCHOR_RE = /^([a-j])([1-9]\d*)$/;

export class DeskController {
  #viewport;
  #deskView;
  #doc;
  #layers;
  #views = new Map(); // boardId → BreadboardView
  #partViews = new Map(); // componentId → ChipView | DiscreteView | PsuView
  #wireLayer;
  #selected = null; // { kind: "board"|"part"|"wire", id } | null
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
  #wireColorIndex = 0; // next color the wire tool commits (auto-cycles)
  #onWireStateChange;
  #onProbeStateChange;
  #lastDown = null; // last viewport pointerdown client pos (click-vs-pan)
  #hoverKey = null; // hover identity currently shown or pending
  #hoverTimer = null;
  #ring;
  #tooltip;
  // Connectivity inspector (Feature 70).
  #netlist;
  #highlight;
  #probeArmed = false;
  #probeAnchor = null; // pinned point address (net re-resolved from it), or null
  #netStatus;
  // Simulation (Feature 90): editing is locked while running; live net levels
  // arrive over chiphippo:sim-state and drive LEDs / chip badges / probe tint.
  #editingLocked = false;
  #simRunning = false;
  #multi = new Set(); // component ids from a marquee selection
  #multiWires = new Set(); // wire ids from the same marquee
  #marquee = null; // the rubber-band element while shift-dragging
  #simLevels = new Map(); // netId → level
  #simStrong = new Map(); // netId → level from supplies/outputs only (no pulls)
  #simNetlist = null; // the netlist the levels are keyed against
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
    this.#onWireStateChange = onWireStateChange;
    this.#onProbeStateChange = onProbeStateChange;
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

    // All wires render into one SVG in the wires layer.
    this.#wireLayer = new WireLayer(this.#layers.wires, deskDoc, {
      onSelect: (id) => this.selectWire(id),
      onContextMenu: (id, e) => this.#onWireContextMenu(id, e),
      onHover: (id) => this.#onWireHover(id),
    });

    // Connectivity inspector (Feature 70): the netlist cache rebuilds on
    // topology/part-state changes; the highlight overlay draws one net.
    this.#netlist = new NetlistCache(deskDoc);
    this.#highlight = new NetHighlight(this.#layers.overlay);
    this.#netStatus = el("div", { class: "net-status", hidden: true });
    viewport.append(this.#netStatus);
    // A pinned net follows its anchor point through edits + switch flips.
    window.addEventListener("chiphippo:doc-changed", () => {
      if (this.#probeAnchor) this.#refreshPinnedNet();
    });
    window.addEventListener("chiphippo:part-state", () => {
      if (this.#probeAnchor) this.#refreshPinnedNet();
    });
    // Live simulation state (Feature 90): LEDs, chip badges, probe tint.
    window.addEventListener("chiphippo:sim-state", (e) =>
      this.#onSimState(e.detail),
    );

    for (const board of this.#doc.boards) this.#mountBoard(board);
    for (const component of this.#doc.components) this.#mountPart(component);

    viewport.addEventListener("pointerdown", this.#onViewportPointerDown);
    viewport.addEventListener("pointermove", this.#onViewportPointerMove);
    viewport.addEventListener("pointerleave", () => this.#hideHover());
    viewport.addEventListener("click", this.#onViewportClick);
    // Right-click while wiring cancels the pending wire (Esc-equivalent).
    viewport.addEventListener("contextmenu", (e) => {
      if (this.#mode?.kind !== "wire") return;
      e.preventDefault();
      this.#clearPendingWire();
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
    const placements = DeskDoc.kitPlacements(kit, 0, 0);
    const outline = DeskDoc.kitOutline(kit);
    const ghost = el("div", { class: "board-ghost", hidden: true });
    // Absolutely positioned strips collapse the box, so size it explicitly —
    // the legal/illegal outline and tint are drawn on this element.
    ghost.style.width = `${outline.width * PX_PER_UNIT}px`;
    ghost.style.height = `${outline.height * PX_PER_UNIT}px`;
    for (const p of placements) {
      const strip = el("div", { class: "board-ghost-strip" });
      strip.style.left = `${p.x * PX_PER_UNIT}px`;
      strip.style.top = `${p.y * PX_PER_UNIT}px`;
      strip.append(buildBoardSvg(p.type));
      ghost.append(strip);
    }
    this.#enterPlacement({
      kind: "place",
      kit,
      ghost,
      pos: null,
      legal: false,
    });
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
    if (def.package) {
      this.armChipPlacement(ref);
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

  /** Arm chip placement (palette): ghost seats across a trench. */
  armChipPlacement(ref) {
    const def = partDef(ref);
    if (!def?.package) {
      const err = new Error(`unknown chip ref: ${ref}`);
      err.code = "INVALID_REF";
      throw err;
    }
    const ghost = el("div", { class: "part-ghost", hidden: true });
    ghost.append(buildChipSvg(ref));
    this.#enterPlacement({
      kind: "place-chip",
      ref,
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

  #trackGhost(e) {
    const kind = this.#mode.kind;
    if (kind === "place") this.#trackBoardGhost(e);
    else if (kind === "place-brick") this.#trackBrickGhost(e);
    else this.#trackSeatedGhost(e);
  }

  #trackBoardGhost(e) {
    const m = this.#mode;
    const { width, height } = DeskDoc.kitOutline(m.kit);
    const w = this.#deskView.worldFromEvent(e);
    // Ghost centered on the cursor, snapped to the integer pitch lattice.
    const x = Math.round(w.x - width / 2);
    const y = Math.round(w.y - height / 2);
    m.pos = { x, y };
    m.legal = this.#doc.canPlaceKit(m.kit, x, y);
    m.ghost.hidden = false;
    m.ghost.style.left = `${x * PX_PER_UNIT}px`;
    m.ghost.style.top = `${y * PX_PER_UNIT}px`;
    m.ghost.classList.toggle("board-ghost--legal", m.legal);
    m.ghost.classList.toggle("board-ghost--illegal", !m.legal);
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
    const orient = this.#ghostOrient(m.ref, m.turns);
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

  /** Seat (board + anchor) for a part under the cursor, by footprint kind. */
  #partSeatAt(world, ref, grabOffsetCols) {
    const def = partDef(ref);
    return def.package
      ? this.#chipSeatAt(world, def.package, grabOffsetCols)
      : this.#discreteSeatAt(world, ref, grabOffsetCols);
  }

  /**
   * The seat for a chip whose CENTER rides the world point (grabOffsetCols
   * 0), or whose grab column offset is preserved (drags), or null when the
   * cursor is off every board or too far from a trench.
   */
  #chipSeatAt(world, pkg, grabOffsetCols) {
    const { halfPins } = packageSpec(pkg);
    for (const board of this.#doc.boards) {
      const s = spec(board.type);
      if (
        world.x < board.x ||
        world.x > board.x + s.width ||
        world.y < board.y ||
        world.y > board.y + s.height
      ) {
        continue;
      }
      if (Math.abs(world.y - board.y - s.trench.centerY) > SEAT_BAND) {
        return null; // on the board but away from the trench (e.g. rails)
      }
      if (s.cols < halfPins) return null; // package wider than the board
      const cursorCol = world.x - board.x - s.colStartX + 1;
      const anchorCol = Math.round(
        grabOffsetCols === 0
          ? cursorCol - (halfPins - 1) / 2 // ghost: chip centered on cursor
          : cursorCol + grabOffsetCols, // drag: keep the grab point
      );
      const clamped = Math.min(s.cols - halfPins + 1, Math.max(1, anchorCol));
      return { board: board.id, anchor: `e${clamped}` };
    }
    return null;
  }

  /** The seat for a discrete part: nearest grid row under the cursor. */
  #discreteSeatAt(world, ref, grabOffsetCols) {
    const offsets = partDef(ref).footprint.offsets;
    const span = offsets[offsets.length - 1];
    for (const board of this.#doc.boards) {
      const s = spec(board.type);
      if (
        world.x < board.x ||
        world.x > board.x + s.width ||
        world.y < board.y ||
        world.y > board.y + s.height
      ) {
        continue;
      }
      let bestRow = null;
      let bestDist = ROW_BAND;
      for (const [row, rowY] of Object.entries(s.rowY)) {
        const dist = Math.abs(world.y - board.y - rowY);
        if (dist <= bestDist) {
          bestRow = row;
          bestDist = dist;
        }
      }
      if (!bestRow) return null; // rails / trench / margins
      if (s.cols < span + 1) return null;
      const cursorCol = world.x - board.x - s.colStartX + 1;
      const anchorCol = Math.round(
        grabOffsetCols === 0
          ? cursorCol - span / 2
          : cursorCol + grabOffsetCols,
      );
      const clamped = Math.min(s.cols - span, Math.max(1, anchorCol));
      return { board: board.id, anchor: `${bestRow}${clamped}` };
    }
    return null;
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
    // so the seat stays legal — the orientation rides along to the drop.
    if (m?.kind === "drag-part" && partDef(m.ref)?.package) {
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
    // Placing a chip: R flips the ghost before it lands.
    if (m?.kind === "place-chip") {
      m.params = this.#flippedParams(m.params, true);
      m.ghost.querySelector("svg")?.remove();
      m.ghost.append(buildChipSvg(m.ref, m.params));
      return true;
    }
    // Placing a rotatable part: R turns the ghost a quarter lap IN PLACE — the
    // placement stays armed, and the orientation carries into the drop.
    if (m?.kind === "place-part" && partDef(m.ref)?.rotatable) {
      m.turns = ((m.turns ?? 0) + 1) % 4;
      if (m.lastWorld) this.#trackSeatedGhostAt(m.lastWorld);
      return true;
    }
    // Not placing: rotate a selected placed part in situ (a chip flips 180°).
    if (this.#selected?.kind === "part") {
      const comp = this.#doc.getComponent(this.#selected.id);
      const def = partDef(comp?.ref);
      if (def?.rotatable || def?.package) {
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
    const board = boardOverride ?? this.#doc.getBoard(comp.board);
    const pins = board && partPinHoles(comp.ref, comp.anchor, comp.params);
    if (!pins) return null;
    const boards = this.#doc.boards.map((b) =>
      b.id === comp.board ? { ...b, ...board } : b,
    );
    const addressed = partPinAddresses({ boards }, comp);
    if (!addressed) return null;
    const anchorPos = holePosition(board.type, comp.anchor);
    if (!anchorPos) return null;
    const out = [];
    for (const [i, { pin, hole, offset }] of pins.entries()) {
      const address = addressed[i].address;
      if (offset) {
        out.push({
          pin,
          address,
          x: board.x + anchorPos.x + offset.dx,
          y: board.y + anchorPos.y + offset.dy,
        });
        continue;
      }
      // A seated pin lives in a hole of its own board — no hole, no geometry.
      const pos = holePosition(board.type, hole);
      if (!pos) return null;
      out.push({ pin, address, x: board.x + pos.x, y: board.y + pos.y });
    }
    return out;
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

  get wireToolArmed() {
    return this.#mode?.kind === "wire";
  }

  /** The color the next committed wire gets. */
  get wireColor() {
    return WIRE_COLORS[this.#wireColorIndex];
  }

  /** Pin the next wire color (the toolbar swatch strip). */
  setWireColor(color) {
    const i = WIRE_COLORS.indexOf(color);
    if (i === -1) {
      const err = new Error(`unknown wire color: ${color}`);
      err.code = "INVALID_ARG";
      throw err;
    }
    this.#wireColorIndex = i;
    this.#notifyWireState();
  }

  /** Arm click-click wiring; a second call to toggle goes through app.js. */
  armWireTool() {
    if (this.wireToolArmed || this.#editingLocked) return;
    this.cancelPlacement();
    this.disarmProbe();
    this.deselect();
    this.#hideHover();
    this.#mode = { kind: "wire", from: null, hover: null };
    this.#viewport.classList.add("desk-viewport--wiring");
    this.#notifyWireState();
  }

  disarmWireTool() {
    if (!this.wireToolArmed) return;
    this.#clearPendingWire();
    this.#mode = null;
    this.#viewport.classList.remove("desk-viewport--wiring");
    this.#ring.hidden = true;
    this.#ring.classList.remove("hole-ring--illegal");
    this.#notifyWireState();
  }

  toggleWireTool() {
    if (this.wireToolArmed) this.disarmWireTool();
    else this.armWireTool();
  }

  #clearPendingWire() {
    if (this.#mode?.kind !== "wire") return;
    this.#mode.from = null;
    this.#wireLayer.setPreview(null);
  }

  #notifyWireState() {
    this.#onWireStateChange?.({
      armed: this.wireToolArmed,
      color: this.wireColor,
    });
  }

  /**
   * World position (pitch units) of a wire point — a board hole or PSU
   * terminal — or null when the address doesn't resolve.
   */
  #addressWorld(address) {
    const parsed = parseAddress(address);
    if (!parsed) return null;
    const board = this.#doc.getBoard(parsed.boardId);
    if (board) {
      const pos = holePosition(board.type, parsed.hole);
      return pos ? { x: board.x + pos.x, y: board.y + pos.y } : null;
    }
    const comp = this.#doc.getComponent(parsed.boardId);
    const t = partDef(comp?.ref)?.terminals?.find((x) => x.id === parsed.hole);
    return t ? { x: comp.x + t.dx, y: comp.y + t.dy } : null;
  }

  /** The wireable point under a world position: board hole or PSU terminal. */
  #wirePointAt(world) {
    const hole = this.#holeAtWorld(world);
    if (hole) {
      return {
        address: formatAddress(hole.board.id, hole.hole),
        x: hole.x,
        y: hole.y,
      };
    }
    for (const comp of this.#doc.components) {
      const terminals = partDef(comp.ref)?.terminals;
      if (!terminals) continue;
      for (const t of terminals) {
        const x = comp.x + t.dx;
        const y = comp.y + t.dy;
        if (Math.hypot(world.x - x, world.y - y) > PIN_HIT_RADIUS) continue;
        return { address: formatAddress(comp.id, t.id), x, y };
      }
    }
    return null;
  }

  /** Wire-mode pointermove: instant ring with legality + the rubber band. */
  #trackWire(e) {
    const m = this.#mode;
    const world = this.#deskView.worldFromEvent(e);
    const hit = this.#wirePointAt(world);
    if (hit) {
      const free = this.#doc.isHoleFree(hit.address);
      const legal = free && hit.address !== m.from;
      m.hover = { address: hit.address, legal };
      const r = RING_RADIUS * PX_PER_UNIT;
      this.#ring.style.left = `${hit.x * PX_PER_UNIT - r}px`;
      this.#ring.style.top = `${hit.y * PX_PER_UNIT - r}px`;
      this.#ring.classList.toggle("hole-ring--illegal", !legal);
      this.#ring.hidden = false;
    } else {
      m.hover = null;
      this.#ring.hidden = true;
    }
    if (m.from) {
      const from = this.#addressWorld(m.from);
      this.#wireLayer.setPreview({
        from: { x: from.x * PX_PER_UNIT, y: from.y * PX_PER_UNIT },
        to: hit
          ? { x: hit.x * PX_PER_UNIT, y: hit.y * PX_PER_UNIT }
          : { x: world.x * PX_PER_UNIT, y: world.y * PX_PER_UNIT },
        color: this.wireColor,
        // Danger tint only over an actual occupied/self point — over empty
        // desk the band stays its color (a click there just does nothing).
        legal: hit ? m.hover.legal : true,
      });
    }
  }

  /** Wire-mode click: anchor on the first free point, commit on the second. */
  #commitWireClick(e) {
    const m = this.#mode;
    this.#trackWire(e); // legality/hover at the exact click point
    if (!m.hover?.legal) return;
    if (!m.from) {
      m.from = m.hover.address;
      return;
    }
    this.#doc.addWire({
      from: m.from,
      to: m.hover.address,
      color: this.wireColor,
    });
    this.#wireColorIndex = (this.#wireColorIndex + 1) % WIRE_COLORS.length;
    this.#clearPendingWire(); // re-arm fresh — chain-friendly
    this.#emitDocChanged();
    this.#notifyWireState();
  }

  /** Remove a wire; clears its selection. */
  removeWire(id) {
    this.#doc.removeWire(id);
    if (this.#selected?.kind === "wire" && this.#selected.id === id) {
      this.#selected = null;
      this.#wireLayer.setSelected(null);
    }
    this.#emitDocChanged();
  }

  /** Recolor a wire (context menu). */
  recolorWire(id, color) {
    this.#doc.recolorWire(id, color);
    this.#emitDocChanged();
  }

  #onWireContextMenu(id, e) {
    e.preventDefault();
    if (this.#mode || this.#editingLocked) return; // no wire edits while running
    this.selectWire(id);
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

  // ── Connectivity inspector / probe (Feature 70) ─────────────────────────

  get probeArmed() {
    return this.#probeArmed;
  }

  /** Arm probe mode: hover highlights a net, click pins it. */
  armProbe() {
    if (this.#probeArmed) return;
    this.cancelPlacement();
    this.disarmWireTool();
    this.deselect();
    this.#hideHover();
    this.#probeArmed = true;
    this.#probeAnchor = null;
    this.#viewport.classList.add("desk-viewport--probing");
    this.#onProbeStateChange?.({ armed: true });
  }

  disarmProbe() {
    if (!this.#probeArmed) return;
    this.#probeArmed = false;
    this.#probeAnchor = null;
    this.#viewport.classList.remove("desk-viewport--probing");
    this.#highlight.clear();
    this.#ring.hidden = true;
    this.#ring.classList.remove("hole-ring--illegal");
    this.#netStatus.hidden = true;
    this.#onProbeStateChange?.({ armed: false });
  }

  toggleProbe() {
    if (this.#probeArmed) this.disarmProbe();
    else this.armProbe();
  }

  /** Geometry the highlight overlay draws by (world px). */
  #highlightGeometry() {
    return {
      positionOf: (address) => {
        const w = this.#addressWorld(address);
        return w ? { x: w.x * PX_PER_UNIT, y: w.y * PX_PER_UNIT } : null;
      },
      wireEndpointsOf: (wireId) => {
        const wire = this.#doc.getWire(wireId);
        if (!wire) return null;
        const a = this.#addressWorld(wire.from);
        const b = this.#addressWorld(wire.to);
        if (!a || !b) return null;
        return {
          a: { x: a.x * PX_PER_UNIT, y: a.y * PX_PER_UNIT },
          b: { x: b.x * PX_PER_UNIT, y: b.y * PX_PER_UNIT },
        };
      },
    };
  }

  /** Show the net containing `address`, pinned or transient. */
  #showNetFor(address, pinned) {
    const netId = this.#netlist.netOf(address);
    const net = netId ? this.#netlist.netInfo(netId) : null;
    // While running, tint the highlight + lead the summary with the level.
    const level = this.#simRunning ? (this.#simLevels.get(netId) ?? "Z") : null;
    this.#highlight.show(net, this.#highlightGeometry(), pinned, level);
    if (net) {
      const summary = summarizeNet(net);
      this.#netStatus.textContent = level ? `${level} · ${summary}` : summary;
      if (level) this.#netStatus.dataset.level = level;
      else delete this.#netStatus.dataset.level;
      this.#netStatus.classList.toggle("net-status--pinned", pinned);
      this.#netStatus.hidden = false;
    } else {
      this.#netStatus.hidden = true;
    }
  }

  /** Rebuild the pinned highlight from its anchor (switch-flip demo). */
  #refreshPinnedNet() {
    if (!this.#probeAnchor) return;
    // The anchor may vanish (its board/PSU deleted) — drop the pin then.
    if (!this.#netlist.netOf(this.#probeAnchor)) {
      this.#probeAnchor = null;
      this.#highlight.clear();
      this.#netStatus.hidden = true;
      return;
    }
    this.#showNetFor(this.#probeAnchor, true);
  }

  /** Probe pointermove: highlight the hovered point's net (unless pinned). */
  #trackProbe(e) {
    if (this.#probeAnchor) return; // pinned — hover doesn't disturb it
    const hit = this.#hitTest(this.#deskView.worldFromEvent(e));
    if (!hit?.address) {
      this.#ring.hidden = true;
      this.#highlight.clear();
      this.#netStatus.hidden = true;
      return;
    }
    const r = RING_RADIUS * PX_PER_UNIT;
    this.#ring.style.left = `${hit.x * PX_PER_UNIT - r}px`;
    this.#ring.style.top = `${hit.y * PX_PER_UNIT - r}px`;
    this.#ring.hidden = false;
    this.#showNetFor(hit.address, false);
  }

  /** Probe click: pin the hovered net, or unpin if already pinned. */
  #commitProbeClick(e) {
    if (this.#probeAnchor) {
      this.#probeAnchor = null; // re-click unpins
      this.#trackProbe(e); // fall back to hover highlight at the cursor
      return;
    }
    const hit = this.#hitTest(this.#deskView.worldFromEvent(e));
    if (!hit?.address || !this.#netlist.netOf(hit.address)) return;
    this.#probeAnchor = hit.address;
    this.#showNetFor(hit.address, true);
  }

  /** A wire hovered under the probe (via the wire hit stroke). */
  #onWireHover(wireId) {
    if (!this.#probeArmed || this.#probeAnchor) return;
    const wire = wireId ? this.#doc.getWire(wireId) : null;
    if (!wire) {
      this.#highlight.clear();
      this.#netStatus.hidden = true;
      return;
    }
    this.#ring.hidden = true;
    this.#showNetFor(wire.from, false);
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

  /** Level (H/L/Z/X) of the net a point sits in, from the last sim-state. */
  #levelAt(address) {
    if (!this.#simNetlist) return null;
    const netId = this.#simNetlist.netOfPoint.get(address);
    return netId ? (this.#simLevels.get(netId) ?? null) : null;
  }

  /** The level a point would sit at from supplies/chip outputs ALONE — i.e.
      ignoring resistor pulls. A point fed only through a resistor is not
      strongly driven, which is how an LED tells a safe path from a lethal one. */
  #strongLevelAt(address) {
    if (!this.#simNetlist) return null;
    const netId = this.#simNetlist.netOfPoint.get(address);
    return netId ? (this.#simStrong.get(netId) ?? null) : null;
  }

  #onSimState({
    running,
    netLevels,
    strongLevels,
    chipStatus,
    netlist,
    clockLevels,
  }) {
    this.#simRunning = running;
    this.#simLevels = netLevels ?? new Map();
    this.#simStrong = strongLevels ?? new Map();
    this.#simNetlist = netlist ?? null;

    // Chip status badges (cleared when not running).
    for (const view of this.#partViews.values()) view.setStatus?.(null);
    if (running) {
      for (const [id, { status }] of chipStatus ?? new Map()) {
        this.#partViews.get(id)?.setStatus?.(status);
      }
    }

    // Clock pulse lamps track their live output level.
    for (const comp of this.#doc.components) {
      if (comp.kind !== "clock") continue;
      const view = this.#partViews.get(comp.id);
      view?.setLevel?.(running && clockLevels?.get(comp.id) === H);
    }

    this.#updateLeds();
    if (this.#probeAnchor) this.#refreshPinnedNet(); // re-tint a pinned net
  }

  /** An LED lights when its anode net is H and its cathode net is L. */
  #updateLeds() {
    const def = partDef("led");
    for (const comp of this.#doc.components) {
      if (comp.ref !== "led") continue;
      const view = this.#partViews.get(comp.id);
      if (!view?.setLit) continue;
      if (!this.#simRunning) {
        view.setLit(false);
        view.setBurnt?.(false);
        continue;
      }
      const { anodePin, cathodePin } = def.polarity(comp.params);
      const pins = partPinAddresses(this.#doc, comp);
      if (!pins) continue; // a rotated LED with an unresolved far end
      const at = (pin) => pins.find((p) => p.pin === pin)?.address;
      const anodeAt = at(anodePin);
      const cathodeAt = at(cathodePin);
      // A floating leg conducts nothing — the LED stays dark but keeps its
      // place, exactly as a real one does when you pull its rail away.
      if (!anodeAt || !cathodeAt) {
        view.setLit(false);
        view.setBurnt?.(false);
        continue;
      }
      const conducting =
        this.#levelAt(anodeAt) === H && this.#levelAt(cathodeAt) === L;
      // No series resistor: an LED conducting between a STRONGLY driven supply
      // (rail or chip output) and a strongly grounded net has nothing limiting
      // it. Anything fed through a resistor is only weakly pulled, so its
      // strong level is not H/L — that's the safe case.
      const unlimited =
        conducting &&
        this.#strongLevelAt(anodeAt) === H &&
        this.#strongLevelAt(cathodeAt) === L;
      view.setBurnt?.(unlimited);
      view.setLit(conducting && !unlimited);
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
  addKitAt(kit, x, y) {
    const strips = this.#doc.addKit(kit, x, y);
    for (const strip of strips) this.#mountBoard(strip);
    // A loose strip dropped flush against a board mates with it, as the real
    // dovetailed part does — it joins that board's group and they drag as one
    // unit. Assembled kits stay standoffish: Feature 120 generalises mating to
    // every strip, alongside the gesture to pull a stack apart again.
    if (strips.length === 1) this.#doc.joinMatedGroup(strips[0].id);
    const pins = strips.find((s) => spec(s.type).kind === "pins") ?? strips[0];
    this.selectBoard(pins.id);
    this.#emitDocChanged();
    return strips;
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

  /** Drop a PSU brick (back-compat name). */
  addPsuAt(x, y, params = {}) {
    return this.addBrickAt("psu", x, y, params);
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
      if (this.#probeArmed) {
        // First Esc unpins a pinned net; the next disarms the probe.
        if (this.#probeAnchor) {
          this.#probeAnchor = null;
          this.#highlight.clear();
          this.#netStatus.hidden = true;
        } else {
          this.disarmProbe();
        }
        return true;
      }
      if (this.wireToolArmed) {
        // First Esc cancels a pending wire; the next disarms the tool.
        if (this.#mode.from) this.#clearPendingWire();
        else this.disarmWireTool();
        return true;
      }
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
    const origin = { id: board.id, type: board.type, x, y };
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
    if (this.#mode || this.#probeArmed || this.#editingLocked) return;
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
    // The group rides the pointer, snapped live to the pitch lattice.
    d.delta = {
      dx: Math.round(w.x - d.startWorld.x),
      dy: Math.round(w.y - d.startWorld.y),
    };
    d.legal = this.#doc.canMoveBoardsBy(
      d.members.map((m) => m.id),
      d.delta.dx,
      d.delta.dy,
    );
    // Wires with an endpoint on any member follow it live.
    this.#wireLayer.render(this.#applyDragDelta(d, d.delta));
  };

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
      view?.setIllegal(!d.legal);
      this.#repositionBoardParts(m.id, pos.x, pos.y);
      overrides.set(m.id, pos);
    }
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
      memberView?.setIllegal(false);
      memberView?.setDragSet(false);
    }
    if (!d.active) return; // plain click — selection already happened

    const cancelled = e.type === "pointercancel";
    const moved = d.delta.dx !== 0 || d.delta.dy !== 0;
    if (!cancelled && d.legal && moved) {
      // Moving only part of a group tears the snap — desk-doc re-derives the
      // groups on both sides of the break.
      this.#doc.moveBoardsBy(
        d.members.map((m) => m.id),
        d.delta.dx,
        d.delta.dy,
      );
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
    if (this.#mode || this.#probeArmed) return; // no part drags while probing
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
      const s = spec(board.type);
      const anchorCol = Number(
        (
          CHIP_ANCHOR_RE.exec(comp.anchor) ?? GRID_ANCHOR_RE.exec(comp.anchor)
        ).slice(-1)[0],
      );
      const cursorCol = w.x - board.x - s.colStartX + 1;
      this.#mode = {
        kind: "drag-part",
        id,
        ref: comp.ref,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        grabOffsetCols: anchorCol - cursorCol,
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

  /**
   * World positions of a component's connection points: a board part's derived
   * pin holes, or a desk brick's terminals. Empty when they don't resolve (an
   * unresolvable part is never marquee-selectable).
   */
  #componentPoints(comp) {
    const def = partDef(comp.ref);
    if (!def) return [];
    if (comp.board == null) {
      return (def.terminals ?? []).map((t) => ({
        x: comp.x + t.dx,
        y: comp.y + t.dy,
      }));
    }
    // A bent lead counts by where it SITS, floating or not — the marquee
    // encloses what the user can see.
    const pins = this.#partPins(comp);
    return pins ? pins.map(({ x, y }) => ({ x, y })) : [];
  }

  /** Components whose EVERY pin/terminal lies inside the world-unit rect. */
  #componentsWithin(rect) {
    const inside = (p) =>
      p.x >= rect.minX &&
      p.x <= rect.maxX &&
      p.y >= rect.minY &&
      p.y <= rect.maxY;
    const ids = [];
    for (const comp of this.#doc.components) {
      const points = this.#componentPoints(comp);
      if (points.length > 0 && points.every(inside)) ids.push(comp.id);
    }
    return ids;
  }

  /** Wires with BOTH endpoints inside the world-unit rect. */
  #wiresWithin(rect) {
    const inside = (p) =>
      p &&
      p.x >= rect.minX &&
      p.x <= rect.maxX &&
      p.y >= rect.minY &&
      p.y <= rect.maxY;
    return this.#doc.wires
      .filter(
        (w) =>
          inside(this.#addressWorld(w.from)) &&
          inside(this.#addressWorld(w.to)),
      )
      .map((w) => w.id);
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
    if (e.shiftKey && !this.#probeArmed && !this.#editingLocked) {
      this.#beginMarquee(e);
      return;
    }
    // Not while probing (clicks pin nets) or running (topology frozen).
    if (!this.#probeArmed && !this.#editingLocked) {
      // Press near a wire's endpoint cap → grab it to drag the end elsewhere.
      const grab = this.#wireEndAtWorld(this.#deskView.worldFromEvent(e));
      if (grab) {
        this.#beginWireEndDrag(grab, e);
        return;
      }
      // Press on a wire's BODY (its hit stroke, away from both caps) → grab the
      // whole wire and translate it rigidly.
      const wireId = e.target?.closest?.(".wire")?.dataset.wireId;
      if (wireId) {
        this.#beginWholeWireDrag(wireId, e);
        return;
      }
    }
    // Click on truly empty desk (the viewport itself — layers are zero-size
    // and overlay children are pointer-inert) deselects.
    if (e.target === this.#viewport) this.deselect();
  };

  // ── Wire-endpoint dragging (grab a cap, move the end to another point) ──────

  /** The nearest wire endpoint within the grab radius of `world`, or null. */
  #wireEndAtWorld(world) {
    let best = null;
    for (const wire of this.#doc.wires) {
      for (const end of ["from", "to"]) {
        const p = this.#addressWorld(wire[end]);
        if (!p) continue;
        const dist = Math.hypot(world.x - p.x, world.y - p.y);
        if (dist > WIRE_END_GRAB_RADIUS) continue;
        if (!best || dist < best.dist) {
          best = { wireId: wire.id, end, origin: wire[end], dist };
        }
      }
    }
    return best;
  }

  #beginWireEndDrag(grab, e) {
    this.#hideHover();
    this.selectWire(grab.wireId); // select on press (mode still null here)
    this.#mode = {
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
    const svg = this.#wireLayer.element;
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort (synthetic events) */
    }
    svg.addEventListener("pointermove", this.#onWireEndPointerMove);
    svg.addEventListener("pointerup", this.#onWireEndPointerUp);
    svg.addEventListener("pointercancel", this.#onWireEndPointerUp);
  }

  #onWireEndPointerMove = (e) => {
    const m = this.#mode;
    if (m?.kind !== "drag-wire-end" || e.pointerId !== m.pointerId) return;
    if (!m.active) {
      const travel = Math.hypot(
        e.clientX - m.startClientX,
        e.clientY - m.startClientY,
      );
      if (travel < DRAG_THRESHOLD) return; // separate a click from a drag
      m.active = true;
      this.#viewport.classList.add("desk-viewport--wire-dragging");
    }
    const world = this.#deskView.worldFromEvent(e);
    const hit = this.#wirePointAt(world);
    if (hit) {
      const legal = this.#doc.canReendWire(m.wireId, m.end, hit.address);
      m.hover = { address: hit.address, legal };
      const r = RING_RADIUS * PX_PER_UNIT;
      this.#ring.style.left = `${hit.x * PX_PER_UNIT - r}px`;
      this.#ring.style.top = `${hit.y * PX_PER_UNIT - r}px`;
      this.#ring.classList.toggle("hole-ring--illegal", !legal);
      this.#ring.hidden = false;
    } else {
      m.hover = null;
      this.#ring.hidden = true;
    }
    // The dragged end snaps to a hovered point, else rides the raw cursor.
    const tip = hit ?? world;
    this.#wireLayer.setEndpointDrag({
      wireId: m.wireId,
      end: m.end,
      world: { x: tip.x * PX_PER_UNIT, y: tip.y * PX_PER_UNIT },
      legal: hit ? m.hover.legal : true,
    });
  };

  #onWireEndPointerUp = (e) => {
    const m = this.#mode;
    if (m?.kind !== "drag-wire-end" || e.pointerId !== m.pointerId) return;
    this.#mode = null;

    const svg = this.#wireLayer.element;
    svg.removeEventListener("pointermove", this.#onWireEndPointerMove);
    svg.removeEventListener("pointerup", this.#onWireEndPointerUp);
    svg.removeEventListener("pointercancel", this.#onWireEndPointerUp);
    try {
      svg.releasePointerCapture(m.pointerId);
    } catch {
      /* already released */
    }
    this.#ring.hidden = true;
    this.#ring.classList.remove("hole-ring--illegal");
    this.#viewport.classList.remove("desk-viewport--wire-dragging");
    this.#wireLayer.setEndpointDrag(null); // stop overriding; redraw from doc

    if (!m.active) return; // plain click — the wire is already selected

    const target = m.hover;
    const commit =
      e.type !== "pointercancel" &&
      target?.legal &&
      target.address !== m.origin;
    if (commit) {
      this.#doc.setWireEndpoint(m.wireId, m.end, target.address);
      this.#emitDocChanged(); // WireLayer re-renders from this
    }
  };

  // ── Whole-wire dragging (grab the body, translate both ends rigidly) ────────

  #beginWholeWireDrag(wireId, e) {
    const wire = this.#doc.getWire(wireId);
    const from0 = this.#addressWorld(wire?.from);
    const to0 = this.#addressWorld(wire?.to);
    if (!from0 || !to0) return; // defensive: unresolvable endpoints
    this.#hideHover();
    this.selectWire(wireId); // select on press (mode still null here)
    this.#mode = {
      kind: "drag-wire",
      wireId,
      from0, // origin endpoint world positions (pitch units)
      to0,
      fromOrigin: wire.from, // revert / no-op detection
      toOrigin: wire.to,
      startWorld: this.#deskView.worldFromEvent(e),
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      target: null, // { from, to } addresses once snapped over legal holes
      active: false,
    };
    // Capture on the persistent wire SVG (survives live re-renders).
    const svg = this.#wireLayer.element;
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort (synthetic events) */
    }
    svg.addEventListener("pointermove", this.#onWholeWirePointerMove);
    svg.addEventListener("pointerup", this.#onWholeWirePointerUp);
    svg.addEventListener("pointercancel", this.#onWholeWirePointerUp);
  }

  #onWholeWirePointerMove = (e) => {
    const m = this.#mode;
    if (m?.kind !== "drag-wire" || e.pointerId !== m.pointerId) return;
    if (!m.active) {
      const travel = Math.hypot(
        e.clientX - m.startClientX,
        e.clientY - m.startClientY,
      );
      if (travel < DRAG_THRESHOLD) return; // separate a click from a drag
      m.active = true;
      this.#viewport.classList.add("desk-viewport--wire-dragging");
    }
    const world = this.#deskView.worldFromEvent(e);
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
      this.#doc.canMoveWire(m.wireId, fromHit.address, toHit.address);
    m.target = legal ? { from: fromHit.address, to: toHit.address } : null;
    // Snap the rendered ends onto the resolved holes when legal, else float.
    const a = fromHit ?? fromW;
    const b = toHit ?? toW;
    this.#wireLayer.setWholeDrag({
      wireId: m.wireId,
      from: { x: a.x * PX_PER_UNIT, y: a.y * PX_PER_UNIT },
      to: { x: b.x * PX_PER_UNIT, y: b.y * PX_PER_UNIT },
      legal,
    });
  };

  #onWholeWirePointerUp = (e) => {
    const m = this.#mode;
    if (m?.kind !== "drag-wire" || e.pointerId !== m.pointerId) return;
    this.#mode = null;

    const svg = this.#wireLayer.element;
    svg.removeEventListener("pointermove", this.#onWholeWirePointerMove);
    svg.removeEventListener("pointerup", this.#onWholeWirePointerUp);
    svg.removeEventListener("pointercancel", this.#onWholeWirePointerUp);
    try {
      svg.releasePointerCapture(m.pointerId);
    } catch {
      /* already released */
    }
    this.#viewport.classList.remove("desk-viewport--wire-dragging");
    this.#wireLayer.setWholeDrag(null); // stop overriding; redraw from doc

    if (!m.active) return; // plain click — the wire is already selected

    // Commit only when BOTH ends landed on real free points (a legal, moved
    // target); an invalid release cancels the drag-drop and the wire snaps back.
    const t = m.target;
    const moved = t && (t.from !== m.fromOrigin || t.to !== m.toOrigin);
    if (e.type !== "pointercancel" && t && moved) {
      this.#doc.moveWire(m.wireId, t.from, t.to);
      this.#emitDocChanged(); // WireLayer re-renders from this
    }
  };

  #onViewportClick = (e) => {
    const m = this.#mode;
    if (!this.placementArmed && m?.kind !== "wire" && !this.#probeArmed) return;
    // A pan that started while armed still ends in a click — suppress it.
    if (
      this.#lastDown &&
      Math.hypot(e.clientX - this.#lastDown.x, e.clientY - this.#lastDown.y) >=
        DRAG_THRESHOLD
    ) {
      return;
    }
    if (this.#probeArmed) {
      this.#commitProbeClick(e);
      return;
    }
    if (m.kind === "wire") {
      this.#commitWireClick(e);
      return;
    }
    this.#trackGhost(e); // ensure the seat reflects the click point
    if (!m.legal) return; // stay armed, the tint explains why
    this.cancelPlacement();
    if (m.kind === "place") {
      this.addKitAt(m.kit, m.pos.x, m.pos.y);
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
      this.#trackWire(e);
      return;
    }
    if (this.#probeArmed) {
      this.#trackProbe(e);
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

  /** The board + hole under a world point (boards never overlap). */
  #holeAtWorld(world) {
    for (const board of this.#doc.boards) {
      const s = spec(board.type);
      if (
        world.x < board.x ||
        world.x > board.x + s.width ||
        world.y < board.y ||
        world.y > board.y + s.height
      ) {
        continue;
      }
      const hole = holeAt(board.type, world.x - board.x, world.y - board.y);
      if (!hole) return null;
      const pos = holePosition(board.type, hole);
      return { board, hole, x: board.x + pos.x, y: board.y + pos.y };
    }
    return null;
  }

  /**
   * Part pins/terminals take precedence (they sit above), then holes. Each
   * hit carries the conductive `address` it resolves to (a pin → its seated
   * hole) so the netlist probe can look up its net.
   */
  #hitTest(world) {
    const pinHit = this.#pinHitTest(world);
    if (pinHit) return pinHit;
    const hit = this.#holeAtWorld(world);
    if (!hit) return null;
    const address = formatAddress(hit.board.id, hit.hole);
    return { key: address, label: address, address, x: hit.x, y: hit.y };
  }

  #pinHitTest(world) {
    for (const comp of this.#doc.components) {
      const def = partDef(comp.ref);
      // Desk-level bricks (PSU, clock) expose terminals as connection points.
      if (comp.board == null && def?.terminals) {
        for (const t of def.terminals) {
          const x = comp.x + t.dx;
          const y = comp.y + t.dy;
          if (Math.hypot(world.x - x, world.y - y) > PIN_HIT_RADIUS) continue;
          const address = formatAddress(comp.id, t.id);
          let note = "";
          if (comp.kind === "psu") {
            note = t.id === "+" ? ` · +${comp.params.volts} V` : " · 0 V";
          } else if (comp.kind === "clock") {
            note = t.id === "out" ? " · clock out" : " · gnd";
          }
          return {
            key: `${comp.id}#${t.id}`,
            label: `${address}${note}`,
            address,
            x,
            y,
          };
        }
        continue;
      }
      const pins = this.#partPins(comp);
      if (!pins) continue;
      for (const { pin, address, x, y } of pins) {
        if (Math.hypot(world.x - x, world.y - y) > PIN_HIT_RADIUS) continue;
        const name = def.pins.find((p) => p.n === pin)?.name ?? "?";
        return {
          key: `${comp.id}#${pin}`,
          // A floating lead is still hoverable — it just has no net to name.
          label: `${comp.ref} pin ${pin} · ${name} → ${address ?? "floating"}`,
          address, // a pin resolves to the net of its seated hole
          x,
          y,
        };
      }
    }
    return null;
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
    window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  }
}
