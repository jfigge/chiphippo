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
// wires → overlay), mounts/removes BreadboardView children, and runs the
// desk interactions — placement mode with a snapping ghost, board select /
// drag / delete, the right-click menu, and hover addressing (holeAt math —
// never per-hole DOM). Every document mutation flows through desk-doc and is
// announced with a global `chiphippo:doc-changed` CustomEvent (autosave).
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
import { BreadboardView, buildBoardSvg } from "./breadboard-view.js";

/** Pointer travel (px) below which a press stays a click, not a drag/pan. */
const DRAG_THRESHOLD = 4;

/** Hover addressing: dwell before the ring/tooltip shows, and the zoom floor
    below which holes are too small for hover to mean anything. */
const HOVER_DWELL_MS = 150;
const HOVER_MIN_ZOOM = 0.75;

/** Radius of the hover ring (pitch units — a shade over one hole). */
const RING_RADIUS = 0.45;

export class DeskController {
  #viewport;
  #deskView;
  #doc;
  #layers;
  #views = new Map(); // boardId → BreadboardView
  #selectedId = null;
  // Active interaction: null, or
  //   { kind: "place", type, ghost, pos, legal }
  //   { kind: "drag", id, pointerId, startClientX/Y, startWorld, origin,
  //     pos, legal, active, type }
  #mode = null;
  #lastDown = null; // last viewport pointerdown client pos (click-vs-pan)
  #hoverKey = null; // "bb1.f12" currently shown or pending
  #hoverTimer = null;
  #ring;
  #tooltip;

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.viewport - the `.desk-viewport` element.
   * @param {object} opts.deskView - DeskView (or a stub with `surface`,
   *   `camera`, and `worldFromEvent(e)`).
   * @param {import('../model/desk-doc.js').DeskDoc} opts.deskDoc
   */
  constructor({ viewport, deskView, deskDoc }) {
    this.#viewport = viewport;
    this.#deskView = deskView;
    this.#doc = deskDoc;

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

    for (const board of this.#doc.boards) this.#mountBoard(board);

    viewport.addEventListener("pointerdown", this.#onViewportPointerDown);
    viewport.addEventListener("pointermove", this.#onViewportPointerMove);
    viewport.addEventListener("pointerleave", () => this.#hideHover());
    viewport.addEventListener("click", this.#onViewportClick);
  }

  get selectedId() {
    return this.#selectedId;
  }

  get placementArmed() {
    return this.#mode?.kind === "place";
  }

  // ── Selection ───────────────────────────────────────────────────────────

  selectBoard(id) {
    if (this.#selectedId === id) return;
    this.#views.get(this.#selectedId)?.setSelected(false);
    this.#selectedId = this.#views.has(id) ? id : null;
    this.#views.get(this.#selectedId)?.setSelected(true);
  }

  deselect() {
    this.selectBoard(null);
  }

  // ── Placement mode (toolbar "Add board") ───────────────────────────────

  /** Arm placement: a translucent ghost tracks the cursor until click/Esc. */
  armPlacement(type) {
    spec(type); // validate before touching state
    this.cancelPlacement();
    this.deselect();
    this.#hideHover();
    const ghost = el("div", { class: "board-ghost", hidden: true });
    ghost.append(buildBoardSvg(type));
    this.#layers.overlay.append(ghost);
    this.#mode = { kind: "place", type, ghost, pos: null, legal: false };
    this.#viewport.classList.add("desk-viewport--placing");
  }

  cancelPlacement() {
    if (this.#mode?.kind !== "place") return;
    this.#mode.ghost.remove();
    this.#mode = null;
    this.#viewport.classList.remove("desk-viewport--placing");
  }

  #trackGhost(e) {
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

  // ── Document mutations (all flow through desk-doc) ─────────────────────

  /** Add + mount + select a board; emits chiphippo:doc-changed. */
  addBoardAt(type, x, y) {
    const board = this.#doc.addBoard(type, x, y);
    this.#mountBoard(board);
    this.selectBoard(board.id);
    this.#emitDocChanged();
    return board;
  }

  /** Remove a board and its view; emits chiphippo:doc-changed. */
  removeBoard(id) {
    this.#doc.removeBoard(id);
    this.#views.get(id)?.remove();
    this.#views.delete(id);
    if (this.#selectedId === id) this.#selectedId = null;
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
      if (this.#mode?.kind === "place") {
        this.cancelPlacement();
        return true;
      }
      if (this.#selectedId) {
        this.deselect();
        return true;
      }
      return false;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && this.#selectedId) {
      this.removeBoard(this.#selectedId);
      return true;
    }
    return false;
  }

  /** Camera moved/zoomed (app.js pass-through) — hover context is stale. */
  onViewportChange() {
    this.#hideHover();
  }

  // ── Board mounting & gestures ───────────────────────────────────────────

  #mountBoard(board) {
    const view = new BreadboardView(this.#layers.boards, board, {
      onPointerDown: (id, e) => this.#onBoardPointerDown(id, e),
      onContextMenu: (id, e) => this.#onBoardContextMenu(id, e),
    });
    this.#views.set(board.id, view);
  }

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
      this.#emitDocChanged();
    } else {
      view?.setPosition(d.origin.x, d.origin.y); // illegal drop → revert
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
    if (m?.kind !== "place") return;
    // A pan that started while armed still ends in a click — suppress it.
    if (
      this.#lastDown &&
      Math.hypot(e.clientX - this.#lastDown.x, e.clientY - this.#lastDown.y) >=
        DRAG_THRESHOLD
    ) {
      return;
    }
    this.#trackGhost(e); // ensure pos/legal reflect the click point
    if (!m.legal) return; // overlap — stay armed, tint explains why
    const { type, pos } = m;
    this.cancelPlacement();
    this.addBoardAt(type, pos.x, pos.y);
  };

  #onViewportPointerMove = (e) => {
    const m = this.#mode;
    if (m?.kind === "place") {
      this.#trackGhost(e);
      return;
    }
    if (m?.kind === "drag") return; // hover stays hidden while dragging

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
    const key = formatAddress(hit.board.id, hit.hole);
    if (key === this.#hoverKey) return; // shown or pending already
    this.#hideHover();
    this.#hoverKey = key;
    this.#hoverTimer = setTimeout(() => this.#showHover(hit), HOVER_DWELL_MS);
  };

  /** The board + hole under a world point, or null (boards never overlap). */
  #hitTest(world) {
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
      return hole ? { board, hole } : null;
    }
    return null;
  }

  #showHover({ board, hole }) {
    const pos = holePosition(board.type, hole);
    const wx = (board.x + pos.x) * PX_PER_UNIT;
    const wy = (board.y + pos.y) * PX_PER_UNIT;

    const r = RING_RADIUS * PX_PER_UNIT;
    this.#ring.style.left = `${wx - r}px`;
    this.#ring.style.top = `${wy - r}px`;
    this.#ring.hidden = false;

    this.#tooltip.textContent = formatAddress(board.id, hole);
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
