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
import { partPinHoles } from "../model/occupancy.js";
import { packageSpec } from "../model/footprints.js";
import { WIRE_COLORS } from "../model/desk-doc.js";
import { partDef } from "../catalog/index.js";
import { PSU_VOLTS, CLOCK_HZ } from "../catalog/parts.js";
import { BreadboardView, buildBoardSvg } from "./breadboard-view.js";
import { ChipView, buildChipSvg, chipBox } from "./chip-view.js";
import {
  DiscreteView,
  buildDiscreteSvg,
  discreteBox,
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
  #simLevels = new Map(); // netId → level
  #simNetlist = null; // the netlist the levels are keyed against
  #onReplaceChip;
  #onClockToggle;

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
   */
  constructor({
    viewport,
    deskView,
    deskDoc,
    onWireStateChange,
    onProbeStateChange,
    onReplaceChip,
    onClockToggle,
  }) {
    this.#viewport = viewport;
    this.#deskView = deskView;
    this.#doc = deskDoc;
    this.#onWireStateChange = onWireStateChange;
    this.#onProbeStateChange = onProbeStateChange;
    this.#onReplaceChip = onReplaceChip;
    this.#onClockToggle = onClockToggle;

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
    if (this.#selected?.id === sel?.id && this.#selected?.kind === sel?.kind) {
      return;
    }
    this.#applySelection(this.#selected, false);
    this.#selected = sel;
    this.#applySelection(this.#selected, true);
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

  /** Arm board placement: a translucent ghost tracks the cursor. */
  armPlacement(type) {
    spec(type); // validate before touching state
    const ghost = el("div", { class: "board-ghost", hidden: true });
    ghost.append(buildBoardSvg(type));
    this.#enterPlacement({
      kind: "place",
      type,
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
  }

  #trackGhost(e) {
    const kind = this.#mode.kind;
    if (kind === "place") this.#trackBoardGhost(e);
    else if (kind === "place-brick") this.#trackBrickGhost(e);
    else this.#trackSeatedGhost(e);
  }

  #trackBoardGhost(e) {
    const m = this.#mode;
    const s = spec(m.type);
    const w = this.#deskView.worldFromEvent(e);
    // Ghost centered on the cursor, snapped to the integer pitch lattice.
    const x = Math.round(w.x - s.width / 2);
    const y = Math.round(w.y - s.height / 2);
    m.pos = { x, y };
    m.legal = this.#doc.canPlace(m.type, x, y);
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
    const m = this.#mode;
    const box =
      m.kind === "place-chip"
        ? chipBox(partDef(m.ref).package)
        : discreteBox(m.ref);
    const w = this.#deskView.worldFromEvent(e);
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

  #onSimState({ running, netLevels, chipStatus, netlist, clockLevels }) {
    this.#simRunning = running;
    this.#simLevels = netLevels ?? new Map();
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
        continue;
      }
      const { anodePin, cathodePin } = def.polarity(comp.params);
      const pins = partPinHoles("led", comp.anchor);
      const hole = (pin) => pins.find((p) => p.pin === pin)?.hole;
      const anode = this.#levelAt(formatAddress(comp.board, hole(anodePin)));
      const cathode = this.#levelAt(
        formatAddress(comp.board, hole(cathodePin)),
      );
      view.setLit(anode === H && cathode === L);
    }
  }

  // ── Document mutations (all flow through desk-doc) ─────────────────────

  /** Add + mount + select a board; emits chiphippo:doc-changed. */
  addBoardAt(type, x, y) {
    const board = this.#doc.addBoard(type, x, y);
    this.#mountBoard(board);
    this.selectBoard(board.id);
    this.#emitDocChanged();
    return board;
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

  /** Flip a slide switch (click) — persists and announces the state. */
  #toggleSlideSwitch(id) {
    const comp = this.#doc.getComponent(id);
    const next = comp.params.pos === "2" ? "1" : "2";
    const updated = this.#doc.setComponentParams(id, { pos: next });
    this.#partViews.get(id)?.updateParams(updated.params);
    window.dispatchEvent(
      new CustomEvent("chiphippo:part-state", {
        detail: { id, ref: comp.ref, state: { pos: next } },
      }),
    );
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
      if (this.#selected) {
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
    const callbacks = {
      onPointerDown: (id, e) => this.#onPartPointerDown(id, e),
      onContextMenu: (id, e) => this.#onPartContextMenu(id, e),
    };
    let view;
    if (component.kind === "psu") {
      view = new PsuView(this.#layers.parts, component, callbacks);
    } else if (component.kind === "clock") {
      view = new ClockView(this.#layers.parts, component, callbacks);
    } else if (component.kind === "discrete") {
      view = new DiscreteView(this.#layers.parts, component, callbacks);
      view.updatePlacement(
        this.#doc.getBoard(component.board),
        component.anchor,
      );
    } else {
      view = new ChipView(this.#layers.parts, component, callbacks);
      view.updatePlacement(
        this.#doc.getBoard(component.board),
        component.anchor,
      );
    }
    this.#partViews.set(component.id, view);
  }

  /** Seated parts ride their board: refresh views for a board at (x, y). */
  #repositionBoardParts(boardId, x, y) {
    const board = this.#doc.getBoard(boardId);
    if (!board) return;
    for (const comp of this.#doc.componentsOnBoard(boardId)) {
      this.#partViews
        .get(comp.id)
        ?.updatePlacement({ type: board.type, x, y }, comp.anchor);
    }
  }

  // ── Board gestures ───────────────────────────────────────────────────────

  #onBoardPointerDown(id, e) {
    if (e.button !== 0) return; // middle = pan (DeskView), right = menu
    // No board drags while probing or running (topology frozen).
    if (this.#mode || this.#probeArmed || this.#editingLocked) return;
    this.#hideHover();
    this.selectBoard(id);

    const board = this.#doc.getBoard(id);
    const view = this.#views.get(id);
    this.#mode = {
      kind: "drag",
      id,
      type: board.type,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startWorld: this.#deskView.worldFromEvent(e),
      origin: { x: board.x, y: board.y },
      pos: { x: board.x, y: board.y },
      legal: true,
      active: false,
    };
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
      this.#views.get(d.id)?.setDragging(true);
    }
    const w = this.#deskView.worldFromEvent(e);
    // The board rides the pointer, snapped live to the pitch lattice.
    d.pos = {
      x: Math.round(d.origin.x + (w.x - d.startWorld.x)),
      y: Math.round(d.origin.y + (w.y - d.startWorld.y)),
    };
    d.legal = this.#doc.canPlace(d.type, d.pos.x, d.pos.y, {
      ignoreId: d.id,
    });
    const view = this.#views.get(d.id);
    view?.setPosition(d.pos.x, d.pos.y);
    view?.setIllegal(!d.legal);
    this.#repositionBoardParts(d.id, d.pos.x, d.pos.y);
    // Wires with an endpoint on this board follow it live.
    this.#wireLayer.render(new Map([[d.id, d.pos]]));
  };

  #onBoardPointerUp = (e) => {
    const d = this.#mode;
    if (d?.kind !== "drag" || e.pointerId !== d.pointerId) return;
    this.#mode = null;

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
      view.setDragging(false);
      view.setIllegal(false);
    }
    if (!d.active) return; // plain click — selection already happened

    const cancelled = e.type === "pointercancel";
    const moved = d.pos.x !== d.origin.x || d.pos.y !== d.origin.y;
    if (!cancelled && d.legal && moved) {
      this.#doc.moveBoard(d.id, d.pos.x, d.pos.y);
      this.#repositionBoardParts(d.id, d.pos.x, d.pos.y);
      this.#emitDocChanged(); // WireLayer re-renders from this
    } else {
      view?.setPosition(d.origin.x, d.origin.y); // illegal drop → revert
      this.#repositionBoardParts(d.id, d.origin.x, d.origin.y);
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

    if (comp.board == null) {
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
      (d?.kind !== "drag-part" && d?.kind !== "drag-brick") ||
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
      (d?.kind !== "drag-part" && d?.kind !== "drag-brick") ||
      e.pointerId !== d.pointerId
    ) {
      return;
    }
    this.#mode = null;

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
    if (!cancelled && d.legal && moved) {
      this.#doc.moveComponent(d.id, d.seat.board, d.seat.anchor);
      view?.updatePlacement(this.#doc.getBoard(d.seat.board), d.seat.anchor);
      this.#emitDocChanged();
    } else {
      view?.updatePlacement(
        this.#doc.getBoard(d.origin.board),
        d.origin.anchor,
      );
    }
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
    // only part action that stays live while running.
    const items = [];
    if (comp?.kind === "chip" && comp.params?.damaged === true) {
      items.push({
        label: "Replace chip",
        onSelect: () => this.#onReplaceChip?.(id),
      });
    }
    if (!this.#editingLocked) {
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

  // ── Viewport-level pointer handling ─────────────────────────────────────

  #onViewportPointerDown = (e) => {
    this.#lastDown = { x: e.clientX, y: e.clientY };
    // Click on truly empty desk (the viewport itself — layers are zero-size
    // and overlay children are pointer-inert) deselects.
    if (!this.#mode && e.button === 0 && e.target === this.#viewport) {
      this.deselect();
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
      this.addBoardAt(m.type, m.pos.x, m.pos.y);
    } else if (m.kind === "place-brick") {
      this.addBrickAt(m.ref, m.pos.x, m.pos.y, m.params);
    } else if (m.kind === "place-part") {
      this.addComponentAt(m.ref, m.board, m.anchor, m.params);
    } else {
      this.addComponentAt(m.ref, m.board, m.anchor);
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

    // Hover addressing: suppressed below the zoom floor.
    if (this.#deskView.camera.zoom < HOVER_MIN_ZOOM) {
      this.#hideHover();
      return;
    }
    const hit = this.#hitTest(this.#deskView.worldFromEvent(e));
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
      const board = this.#doc.getBoard(comp.board);
      const pins = partPinHoles(comp.ref, comp.anchor);
      if (!board || !pins) continue;
      for (const { pin, hole } of pins) {
        const pos = holePosition(board.type, hole);
        if (!pos) continue;
        const x = board.x + pos.x;
        const y = board.y + pos.y;
        if (Math.hypot(world.x - x, world.y - y) > PIN_HIT_RADIUS) continue;
        const name = def.pins.find((p) => p.n === pin)?.name ?? "?";
        const address = formatAddress(comp.board, hole);
        return {
          key: `${comp.id}#${pin}`,
          label: `${comp.ref} pin ${pin} · ${name} → ${address}`,
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
