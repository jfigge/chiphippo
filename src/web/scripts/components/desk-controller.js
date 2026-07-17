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
// wires → overlay), mounts/removes BreadboardView + ChipView children, and
// runs the desk interactions — board/chip placement modes with snapping
// ghosts, select / drag / delete for both, right-click menus, and hover
// addressing for holes AND chip pins (holeAt / derived-pin math — never
// per-hole or per-pin DOM). Every document mutation flows through desk-doc
// and is announced with a global `chiphippo:doc-changed` CustomEvent.
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
  spec,
} from "../model/breadboard.js";
import { chipPinHoles } from "../model/occupancy.js";
import { packageSpec } from "../model/footprints.js";
import { WIRE_COLORS } from "../model/desk-doc.js";
import { chipDef } from "../catalog/index.js";
import { BreadboardView, buildBoardSvg } from "./breadboard-view.js";
import { ChipView, buildChipSvg, chipBox } from "./chip-view.js";
import { WireLayer } from "./wire-layer.js";

/** Pointer travel (px) below which a press stays a click, not a drag/pan. */
const DRAG_THRESHOLD = 4;

/** Hover addressing: dwell before the ring/tooltip shows, and the zoom floor
    below which holes are too small for hover to mean anything. */
const HOVER_DWELL_MS = 150;
const HOVER_MIN_ZOOM = 0.75;

/** Radius of the hover ring (pitch units — a shade over one hole). */
const RING_RADIUS = 0.45;

/** Hit radius for chip pins (pitch units, matches hole hit feel). */
const PIN_HIT_RADIUS = 0.45;

/** How far (pitch units) the cursor may sit from a trench center and still
    seat a chip ghost there — beyond it (e.g. over the rails) the ghost
    floats unseated with the danger tint. */
const SEAT_BAND = 2.5;

const CHIP_ANCHOR_RE = /^e([1-9]\d*)$/;

export class DeskController {
  #viewport;
  #deskView;
  #doc;
  #layers;
  #views = new Map(); // boardId → BreadboardView
  #chipViews = new Map(); // componentId → ChipView
  #wireLayer;
  #selected = null; // { kind: "board"|"chip"|"wire", id } | null
  // Active interaction: null, or
  //   { kind: "place", type, ghost, pos, legal }
  //   { kind: "place-chip", ref, ghost, board, anchor, legal }
  //   { kind: "drag", id, … }            (board drag)
  //   { kind: "drag-chip", id, … }
  //   { kind: "wire", from, hover }      (wire tool armed)
  #mode = null;
  #wireColorIndex = 0; // next color the wire tool commits (auto-cycles)
  #onWireStateChange;
  #lastDown = null; // last viewport pointerdown client pos (click-vs-pan)
  #hoverKey = null; // hover identity currently shown or pending
  #hoverTimer = null;
  #ring;
  #tooltip;

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.viewport - the `.desk-viewport` element.
   * @param {object} opts.deskView - DeskView (or a stub with `surface`,
   *   `camera`, and `worldFromEvent(e)`).
   * @param {import('../model/desk-doc.js').DeskDoc} opts.deskDoc
   * @param {(state: {armed: boolean, color: string}) => void}
   *   [opts.onWireStateChange] - wire-tool arm/disarm/color changes (drives
   *   the toolbar button + swatch strip).
   */
  constructor({ viewport, deskView, deskDoc, onWireStateChange }) {
    this.#viewport = viewport;
    this.#deskView = deskView;
    this.#doc = deskDoc;
    this.#onWireStateChange = onWireStateChange;

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
    });

    for (const board of this.#doc.boards) this.#mountBoard(board);
    for (const component of this.#doc.components) this.#mountChip(component);

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
    return this.#mode?.kind === "place" || this.#mode?.kind === "place-chip";
  }

  // ── Selection (boards, chips, and wires share one slot) ─────────────────

  #applySelection(sel, on) {
    if (!sel) return;
    if (sel.kind === "board") this.#views.get(sel.id)?.setSelected(on);
    else if (sel.kind === "chip") this.#chipViews.get(sel.id)?.setSelected(on);
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
    this.#select(this.#chipViews.has(id) ? { kind: "chip", id } : null);
  }

  selectWire(id) {
    if (this.#mode) return; // wiring/placing/dragging — clicks aren't selects
    this.#select(this.#doc.getWire(id) ? { kind: "wire", id } : null);
  }

  deselect() {
    this.#select(null);
  }

  // ── Placement modes (toolbar Add-board / palette chip pick) ─────────────

  /** Arm board placement: a translucent ghost tracks the cursor. */
  armPlacement(type) {
    spec(type); // validate before touching state
    this.cancelPlacement();
    this.disarmWireTool();
    this.deselect();
    this.#hideHover();
    const ghost = el("div", { class: "board-ghost", hidden: true });
    ghost.append(buildBoardSvg(type));
    this.#layers.overlay.append(ghost);
    this.#mode = { kind: "place", type, ghost, pos: null, legal: false };
    this.#viewport.classList.add("desk-viewport--placing");
  }

  /** Arm chip placement from the palette: ghost seats across a trench. */
  armChipPlacement(ref) {
    if (!chipDef(ref)) {
      const err = new Error(`unknown catalog ref: ${ref}`);
      err.code = "INVALID_REF";
      throw err;
    }
    this.cancelPlacement();
    this.disarmWireTool();
    this.deselect();
    this.#hideHover();
    const ghost = el("div", { class: "part-ghost", hidden: true });
    ghost.append(buildChipSvg(ref));
    this.#layers.overlay.append(ghost);
    this.#mode = {
      kind: "place-chip",
      ref,
      ghost,
      board: null,
      anchor: null,
      legal: false,
    };
    this.#viewport.classList.add("desk-viewport--placing");
  }

  cancelPlacement() {
    if (!this.placementArmed) return;
    this.#mode.ghost.remove();
    this.#mode = null;
    this.#viewport.classList.remove("desk-viewport--placing");
  }

  #trackGhost(e) {
    if (this.#mode.kind === "place") this.#trackBoardGhost(e);
    else this.#trackChipGhost(e);
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

  #trackChipGhost(e) {
    const m = this.#mode;
    const def = chipDef(m.ref);
    const box = chipBox(def.package);
    const w = this.#deskView.worldFromEvent(e);
    const seat = this.#chipSeatAt(w, def.package, 0);
    m.ghost.hidden = false;
    if (seat) {
      const board = this.#doc.getBoard(seat.board);
      const pos = holePosition(board.type, seat.anchor);
      m.board = seat.board;
      m.anchor = seat.anchor;
      m.legal = this.#doc.canPlaceChip(m.ref, seat.board, seat.anchor);
      m.ghost.style.left = `${(board.x + pos.x + box.minX) * PX_PER_UNIT}px`;
      m.ghost.style.top = `${(board.y + pos.y + box.minY) * PX_PER_UNIT}px`;
    } else {
      // Off-board / over the rails: the ghost floats on the cursor, illegal.
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
   * The seat (board + row-e anchor) for a chip whose CENTER rides the world
   * point, or null when the cursor is off every board or too far from a
   * trench. `grabOffsetCols` shifts the derived anchor for drags (so the
   * chip keeps its grab point under the cursor).
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
    if (this.wireToolArmed) return;
    this.cancelPlacement();
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

  /** World px of a hole address (for the rubber-band anchor). */
  #addressWorld(address) {
    const parsed = /^([^.]+)\.(.+)$/.exec(address);
    const board = this.#doc.getBoard(parsed[1]);
    const pos = holePosition(board.type, parsed[2]);
    return {
      x: (board.x + pos.x) * PX_PER_UNIT,
      y: (board.y + pos.y) * PX_PER_UNIT,
    };
  }

  /** Wire-mode pointermove: instant ring with legality + the rubber band. */
  #trackWire(e) {
    const m = this.#mode;
    const world = this.#deskView.worldFromEvent(e);
    const hit = this.#holeAtWorld(world);
    if (hit) {
      const address = formatAddress(hit.board.id, hit.hole);
      const free = this.#doc.isHoleFree(address);
      const legal = free && address !== m.from;
      m.hover = { address, legal, x: hit.x, y: hit.y };
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
      this.#wireLayer.setPreview({
        from: this.#addressWorld(m.from),
        to: hit
          ? { x: hit.x * PX_PER_UNIT, y: hit.y * PX_PER_UNIT }
          : { x: world.x * PX_PER_UNIT, y: world.y * PX_PER_UNIT },
        color: this.wireColor,
        // Danger tint only over an actual occupied/self hole — over empty
        // desk the band stays its color (a click there just does nothing).
        legal: hit ? m.hover.legal : true,
      });
    }
  }

  /** Wire-mode click: anchor on the first free hole, commit on the second. */
  #commitWireClick(e) {
    const m = this.#mode;
    this.#trackWire(e); // legality/hover at the exact click point
    if (!m.hover?.legal) return;
    if (!m.from) {
      m.from = m.hover.address;
      return;
    }
    const wire = this.#doc.addWire({
      from: m.from,
      to: m.hover.address,
      color: this.wireColor,
    });
    this.#wireColorIndex = (this.#wireColorIndex + 1) % WIRE_COLORS.length;
    this.#clearPendingWire(); // re-arm fresh — chain-friendly
    this.#emitDocChanged();
    this.#notifyWireState();
    return wire;
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
    if (this.#mode) return;
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

  // ── Document mutations (all flow through desk-doc) ─────────────────────

  /** Add + mount + select a board; emits chiphippo:doc-changed. */
  addBoardAt(type, x, y) {
    const board = this.#doc.addBoard(type, x, y);
    this.#mountBoard(board);
    this.selectBoard(board.id);
    this.#emitDocChanged();
    return board;
  }

  /** Seat + mount + select a chip; emits chiphippo:doc-changed. */
  addComponentAt(ref, boardId, anchor) {
    const component = this.#doc.addComponent({
      kind: "chip",
      ref,
      board: boardId,
      anchor,
    });
    this.#mountChip(component);
    this.selectComponent(component.id);
    this.#emitDocChanged();
    return component;
  }

  /**
   * Remove a board. With parts seated on it or wires attached, asks for
   * confirmation first (the document cascade removes them too).
   */
  removeBoard(id) {
    const parts = this.#doc.componentsOnBoard(id).length;
    const wires = this.#doc.wiresOnBoard(id).length;
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
      this.#chipViews.get(comp.id)?.remove();
      this.#chipViews.delete(comp.id);
      if (this.#selected?.id === comp.id) this.#selected = null;
    }
    const cascadedWires = new Set(this.#doc.wiresOnBoard(id).map((w) => w.id));
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

  /** Remove a chip and its view; emits chiphippo:doc-changed. */
  removeComponent(id) {
    this.#doc.removeComponent(id);
    this.#chipViews.get(id)?.remove();
    this.#chipViews.delete(id);
    if (this.#selected?.id === id) this.#selected = null;
    this.#hideHover();
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
    if (
      (e.key === "w" || e.key === "W") &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      this.toggleWireTool();
      return true;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && this.#selected) {
      const { kind, id } = this.#selected;
      if (kind === "chip") this.removeComponent(id);
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

  #mountChip(component) {
    const view = new ChipView(this.#layers.parts, component, {
      onPointerDown: (id, e) => this.#onChipPointerDown(id, e),
      onContextMenu: (id, e) => this.#onChipContextMenu(id, e),
    });
    view.updatePlacement(this.#doc.getBoard(component.board), component.anchor);
    this.#chipViews.set(component.id, view);
  }

  /** Chips ride their board: refresh their views for a board at (x, y). */
  #repositionBoardChips(boardId, x, y) {
    const board = this.#doc.getBoard(boardId);
    if (!board) return;
    for (const comp of this.#doc.componentsOnBoard(boardId)) {
      this.#chipViews
        .get(comp.id)
        ?.updatePlacement({ type: board.type, x, y }, comp.anchor);
    }
  }

  // ── Board gestures ───────────────────────────────────────────────────────

  #onBoardPointerDown(id, e) {
    if (e.button !== 0) return; // middle = pan (DeskView), right = menu
    if (this.#mode) return; // placement click handles itself
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
    this.#repositionBoardChips(d.id, d.pos.x, d.pos.y);
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
      this.#repositionBoardChips(d.id, d.pos.x, d.pos.y);
      this.#emitDocChanged(); // WireLayer re-renders from this
    } else {
      view?.setPosition(d.origin.x, d.origin.y); // illegal drop → revert
      this.#repositionBoardChips(d.id, d.origin.x, d.origin.y);
      this.#wireLayer.render();
    }
  };

  #onBoardContextMenu(id, e) {
    e.preventDefault();
    if (this.#mode) return;
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

  // ── Chip gestures ────────────────────────────────────────────────────────

  #onChipPointerDown(id, e) {
    if (e.button !== 0) return;
    if (this.#mode) return;
    this.#hideHover();
    this.selectComponent(id);

    const comp = this.#doc.getComponent(id);
    const board = this.#doc.getBoard(comp.board);
    const s = spec(board.type);
    const w = this.#deskView.worldFromEvent(e);
    const anchorCol = Number(CHIP_ANCHOR_RE.exec(comp.anchor)[1]);
    const cursorCol = w.x - board.x - s.colStartX + 1;
    const view = this.#chipViews.get(id);
    this.#mode = {
      kind: "drag-chip",
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
    try {
      view.element.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    view.element.addEventListener("pointermove", this.#onChipPointerMove);
    view.element.addEventListener("pointerup", this.#onChipPointerUp);
    view.element.addEventListener("pointercancel", this.#onChipPointerUp);
  }

  #onChipPointerMove = (e) => {
    const d = this.#mode;
    if (d?.kind !== "drag-chip" || e.pointerId !== d.pointerId) return;
    if (!d.active) {
      const travel = Math.hypot(
        e.clientX - d.startClientX,
        e.clientY - d.startClientY,
      );
      if (travel < DRAG_THRESHOLD) return;
      d.active = true;
      this.#chipViews.get(d.id)?.setDragging(true);
    }
    const view = this.#chipViews.get(d.id);
    const def = chipDef(d.ref);
    const w = this.#deskView.worldFromEvent(e);
    const seat = this.#chipSeatAt(w, def.package, d.grabOffsetCols);
    if (seat) {
      // Ride the trench, snapped; tint tells occupancy legality.
      d.seat = seat;
      d.legal = this.#doc.canPlaceChip(d.ref, seat.board, seat.anchor, {
        ignoreId: d.id,
      });
      view?.updatePlacement(this.#doc.getBoard(seat.board), seat.anchor);
    } else {
      d.legal = false; // off-board / off-trench: stay at the last seat
    }
    view?.setIllegal(!d.legal);
  };

  #onChipPointerUp = (e) => {
    const d = this.#mode;
    if (d?.kind !== "drag-chip" || e.pointerId !== d.pointerId) return;
    this.#mode = null;

    const view = this.#chipViews.get(d.id);
    if (view) {
      const chipEl = view.element;
      chipEl.removeEventListener("pointermove", this.#onChipPointerMove);
      chipEl.removeEventListener("pointerup", this.#onChipPointerUp);
      chipEl.removeEventListener("pointercancel", this.#onChipPointerUp);
      try {
        chipEl.releasePointerCapture(d.pointerId);
      } catch {
        /* already released */
      }
      view.setDragging(false);
      view.setIllegal(false);
    }
    if (!d.active) return;

    const cancelled = e.type === "pointercancel";
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

  #onChipContextMenu(id, e) {
    e.preventDefault();
    if (this.#mode) return;
    this.selectComponent(id);
    PopupManager.menu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "Remove chip",
          danger: true,
          onSelect: () => this.removeComponent(id),
        },
        { label: "Properties…", disabled: true },
      ],
    });
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
    if (!this.placementArmed && m?.kind !== "wire") return;
    // A pan that started while armed still ends in a click — suppress it.
    if (
      this.#lastDown &&
      Math.hypot(e.clientX - this.#lastDown.x, e.clientY - this.#lastDown.y) >=
        DRAG_THRESHOLD
    ) {
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
    } else {
      this.addComponentAt(m.ref, m.board, m.anchor);
    }
  };

  #onViewportPointerMove = (e) => {
    const m = this.#mode;
    if (m?.kind === "place" || m?.kind === "place-chip") {
      this.#trackGhost(e);
      return;
    }
    if (m?.kind === "wire") {
      this.#trackWire(e);
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

  // ── Hover addressing (holes + chip pins, pure math) ─────────────────────

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

  /** Chip pins take precedence (they sit above the board), then holes. */
  #hitTest(world) {
    const pinHit = this.#pinHitTest(world);
    if (pinHit) return pinHit;
    const hit = this.#holeAtWorld(world);
    if (!hit) return null;
    return {
      key: formatAddress(hit.board.id, hit.hole),
      label: formatAddress(hit.board.id, hit.hole),
      x: hit.x,
      y: hit.y,
    };
  }

  #pinHitTest(world) {
    for (const comp of this.#doc.components) {
      const board = this.#doc.getBoard(comp.board);
      const pins = chipPinHoles(comp.ref, comp.anchor);
      if (!board || !pins) continue;
      for (const { pin, hole } of pins) {
        const pos = holePosition(board.type, hole);
        if (!pos) continue;
        const x = board.x + pos.x;
        const y = board.y + pos.y;
        if (Math.hypot(world.x - x, world.y - y) > PIN_HIT_RADIUS) continue;
        const def = chipDef(comp.ref);
        const name = def.pins.find((p) => p.n === pin)?.name ?? "?";
        return {
          key: `${comp.id}#${pin}`,
          label: `${comp.ref} pin ${pin} · ${name} → ${formatAddress(comp.board, hole)}`,
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
    this.#tooltip.hidden = true;
  }

  #emitDocChanged() {
    window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  }
}
