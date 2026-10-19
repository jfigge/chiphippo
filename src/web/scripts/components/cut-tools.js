/*
 * Copyright 2026 Jason Figge
 *
 * This file is part of Chip Hippo.
 *
 * Chip Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * Chip Hippo is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Chip Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

// cut-tools.js — the Cut Track tool: a veroboard's copper is cut, and a cut is
// put back, one click at a hole (`DeskDoc.toggleCut` — a cut is a spot-face AT
// a hole, breadboard.js). The tool is the wire tool's shape: it owns the
// controller's shared `#mode` through a host while armed (`kind: "cut"`), the
// shared hover ring marks the hole a click would act on — the hover colour on
// copper, `--restore` on a hole already cut, `--illegal` on anything that is
// not a veroboard's — and every click is one document edit, so it is one undo
// step and the netlist, both engines and the probe re-derive from it like any
// other edit (`#emitDocChanged`).
//
// Topology is an EDIT, so the tool refuses to arm while the circuit runs and
// Run puts it away (DeskController.setEditingLocked), as it does the wire and
// bus tools.

import { holePosition, isCuttable } from "../model/breadboard.js";
import { holeAtWorld } from "../model/occupancy.js";
import { aimRing } from "./hole-rings.js";

export class CutTools {
  #host;

  /**
   * @param {object} host - shared controller surface:
   *   { get mode, set mode, get editingLocked, refuseEdit, doc, deskView,
   *     viewport, ring, emitDocChanged, hideHover, deselect, cancelPlacement,
   *     disarmProbe, disarmWireTool, disarmBusTool, get hasVeroboard,
   *     setBoardCuts, onStateChange }
   */
  constructor(host) {
    this.#host = host;
  }

  get armed() {
    return this.#host.mode?.kind === "cut";
  }

  arm() {
    // Nothing to cut without a veroboard (K too: the toolbar hides the tool).
    if (this.armed || this.#host.hasVeroboard === false) return;
    if (this.#host.editingLocked) {
      this.#host.refuseEdit?.();
      return;
    }
    this.#host.cancelPlacement();
    this.#host.disarmProbe();
    this.#host.disarmWireTool();
    this.#host.disarmBusTool();
    this.#host.deselect();
    this.#host.hideHover();
    this.#host.mode = { kind: "cut", hover: null };
    this.#host.viewport.classList.add("desk-viewport--cutting");
    this.#notifyState();
  }

  disarm() {
    if (!this.armed) return;
    this.#host.mode = null;
    this.#host.viewport.classList.remove("desk-viewport--cutting");
    this.#clearRing();
    this.#notifyState();
  }

  toggle() {
    if (this.armed) this.disarm();
    else this.arm();
  }

  /** Escape while cutting puts the tool away (there is nothing pending). */
  handleEscape() {
    if (!this.armed) return false;
    this.disarm();
    return true;
  }

  #notifyState() {
    this.#host.onStateChange?.({ armed: this.armed });
  }

  #clearRing() {
    const ring = this.#host.ring;
    ring.hidden = true;
    ring.classList.remove("hole-ring--illegal", "hole-ring--restore");
  }

  /**
   * The hole under a world point and what a click there would do:
   * `{board, hole, x, y, cut}` — `cut` true when it would cut, false when it
   * would restore — or `{…, cut: null}` over a hole that cannot be cut, or
   * null over bare desk.
   */
  #targetAt(world) {
    const hit = holeAtWorld(this.#host.doc.boards, world.x, world.y);
    if (!hit) return null;
    const { board, hole } = hit;
    const pos = holePosition(board.type, hole, board.rot ?? 0);
    const at = { board, hole, x: board.x + pos.x, y: board.y + pos.y };
    if (!isCuttable(board.type, hole)) return { ...at, cut: null };
    return { ...at, cut: !(board.cuts ?? []).includes(hole) };
  }

  /** Cut-mode pointermove: ring the hole a click would act on. */
  trackMove(e) {
    const m = this.#host.mode;
    const target = this.#targetAt(this.#host.deskView.worldFromEvent(e));
    m.hover = target;
    const ring = this.#host.ring;
    if (!target) {
      this.#clearRing();
      return;
    }
    aimRing(ring, target, target.cut !== null);
    ring.classList.toggle("hole-ring--restore", target.cut === false);
  }

  /** Cut-mode click: cut the copper at the hole, or restore a cut there. */
  commitClick(e) {
    if (this.#host.editingLocked) {
      this.#host.refuseEdit?.();
      return;
    }
    this.trackMove(e);
    const target = this.#host.mode.hover;
    if (target?.cut == null) return;
    const { cut } = this.#host.doc.toggleCut(target.board.id, target.hole);
    this.#host.setBoardCuts(target.board.id);
    this.#host.emitDocChanged(cut ? "cut track" : "restore track");
    this.trackMove(e); // the ring now offers the opposite
  }
}
