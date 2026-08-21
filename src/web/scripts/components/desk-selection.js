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

// desk-selection.js — WHAT IS SELECTED on the desk, and the two overlays that
// say so.
//
// The selection is built two ways and the modifier is the difference
// (model/selection-toggle.js owns the pure rule): a Shift-drag MARQUEE replaces
// it with everything a box wholly encloses, a ⌘/Ctrl-CLICK adds one item or
// takes one out. Both fill the same three sets — parts, wires, boards — so
// Delete, ⌘C's cluster/design clip and the board highlighter are untouched by
// the second existing. A single pick sits beside them in its own slot, and is
// FOLDED IN wherever the answer is "everything selected", since it is what a
// modifier-click most often extends.
//
// Two overlays belong here because both are pure functions of the selection:
// the BoardOutline traces the outer edge of every strip a grab would move (one
// path, so flush strips show no seam), and the ride-preview HoleRings answer
// "what comes with it?" BEFORE an Option-drag rather than during it.
//
// Pulled out of DeskController, which held all of it directly. It is the same
// host-object arrangement WireTools and BusTools already use — the shared
// `#mode` and the surface (doc, views, layers) come from the host, so nothing
// about how modes arbitrate changed; this is a home for the selection, not a
// change to what selecting does. The controller keeps its public surface
// (selectAll, deselect, multiSelectedIds, toggle*Selection, setRidePreview) and
// delegates each one straight here.

import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { boardSize } from "../model/breadboard.js";
import { partPinsWorld } from "../model/part-geometry.js";
import { singlePick, toggleSelection } from "../model/selection-toggle.js";
import { BoardOutline } from "./board-outline.js";
import { HoleRings } from "./hole-rings.js";

export class DeskSelection {
  #host;
  /** The single pick: `{kind, id}` or null. `kind` is one of board / part /
      wire / bus / annotation — only the first three can also be multi. */
  #selected = null;
  #multi = new Set(); // component ids
  #multiWires = new Set(); // wire ids
  #multiBoards = new Set(); // board ids
  /** Whether Option is down right now — pushed in from app.js, never read off
      an event here (see setRidePreview). */
  #optionHeld = false;
  #boardOutline;
  #rideRings;

  /**
   * @param {object} host - the controller. Supplies `doc`, the mutable `mode`,
   *   `editingLocked`, the view maps (`boardViews`, `partViews`), the shared
   *   layers (`wireLayer`, `annotationLayer`) and `addressWorld`.
   * @param {HTMLElement} overlay - the pointer-inert overlay layer both
   *   overlays draw into.
   */
  constructor(host, overlay) {
    this.#host = host;
    this.#boardOutline = new BoardOutline(overlay);
    this.#rideRings = new HoleRings(overlay);
  }

  #applySelection(sel, on) {
    if (!sel) return;
    if (sel.kind === "board")
      this.#host.boardViews.get(sel.id)?.setSelected(on);
    else if (sel.kind === "part")
      this.#host.partViews.get(sel.id)?.setSelected(on);
    else if (sel.kind === "annotation") {
      this.#host.annotationLayer.setSelected(on ? sel.id : null);
    } else if (sel.kind === "bus") {
      this.#host.wireLayer.setSelectedBus(on ? sel.id : null);
    } else this.#host.wireLayer.setSelected(on ? sel.id : null);
  }

  select(sel) {
    // A single pick always replaces a marquee selection.
    if (sel && this.size()) this.clearMulti();
    if (this.#selected?.id === sel?.id && this.#selected?.kind === sel?.kind) {
      return;
    }
    this.#applySelection(this.#selected, false);
    this.#selected = sel;
    this.#applySelection(this.#selected, true);
    this.refreshBoardOutline();
    this.refreshRidePreview(); // Option may be held over the NEW selection
  }

  // ── The Option-drag hint (Feature 290) ──────────────────────────────────

  /**
   * Option is down (or up). While it is down over a SELECTED part, every wire
   * end an Option-drag would carry is ringed, so "what comes with it?" is
   * answered BEFORE the gesture rather than discovered during it — the same
   * shape as the Fit button previewing zoom-out-full while Shift is held.
   *
   * The state is pushed in rather than read off events because a keyup is not
   * the only way it ends: app.js drops it on `blur` too, since a modifier
   * released outside the window never fires our own keyup and a ring left
   * behind would be a lie about a key nobody is holding.
   */
  setRidePreview(on) {
    const next = Boolean(on);
    if (next === this.#optionHeld) return;
    this.#optionHeld = next;
    this.refreshRidePreview();
  }

  /** Re-derive the hint from whatever is true now. Called from every transition
      that can change the answer — the selection, a doc edit, a drag starting or
      ending, the run lock — and cheap when Option isn't held, which is the
      overwhelmingly common case. */
  refreshRidePreview() {
    this.#rideRings.show(this.#ridePreviewPoints());
  }

  /** World points of everything riding what is selected, or null — each wire
      end, and each two-terminal part's LEAD, that an Option-drag would carry. A
      rider held by BOTH ends gets two rings, which is the useful part: it shows
      what travels and what stays put, so a resistor that will bend reads
      differently from one that will translate.

      A MULTI-selection rings every member's riders, since Option would carry
      them all. Only when the press would actually start a drag, though: a
      selection holding a board refuses (see #beginClusterDrag), and ringing
      riders for it would be a promise the app won't keep. Riders are deduped
      because two members can share a node. */
  #ridePreviewPoints() {
    if (!this.#optionHeld) return null;
    // A drag in flight already shows the answer by moving the riders, and the
    // topology is frozen while the circuit runs.
    if (this.#host.mode || this.#host.editingLocked) return null;
    let riding = null;
    let legs = null;
    if (this.#selected?.kind === "part") {
      riding = this.#host.doc.wiresRidingPart(this.#selected.id);
      legs = this.#host.doc.partsRidingPart(this.#selected.id);
    } else if (this.#multi.size >= 2 && this.#multiBoards.size === 0) {
      riding = this.#host.doc
        .wiresRidingCluster(this.#multi)
        .map(({ wireId, ends }) => ({ wireId, ends: ends.map((r) => r.end) }));
      legs = this.#host.doc.partsRidingCluster(this.#multi);
    }
    if (!riding) return null;
    const points = [];
    for (const { wireId, ends } of riding) {
      const wire = this.#host.doc.getWire(wireId);
      for (const end of ends) {
        const p = this.#host.addressWorld(wire?.[end]);
        if (p) points.push(p);
      }
    }
    for (const { id, pins } of legs ?? []) {
      const comp = this.#host.doc.getComponent(id);
      const world = comp && partPinsWorld(this.#host.doc.boards, comp);
      for (const { pin } of pins) {
        const at = world?.find((p) => p.pin === pin);
        if (at) points.push({ x: at.x, y: at.y });
      }
    }
    return points.length > 0 ? points : null;
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
  refreshBoardOutline(overrides = null) {
    const drag = this.#host.mode?.kind === "drag" ? this.#host.mode : null;
    let ids = [];
    if (drag) ids = drag.members.map((m) => m.id);
    else if (this.#selected?.kind === "board") {
      ids = this.#host.doc.groupMembers(this.#selected.id).map((b) => b.id);
    } else if (this.#multiBoards.size > 0) {
      // A marquee that took in boards outlines exactly those — the same
      // highlighter, so a selected design reads as one block (Feature 240).
      ids = [...this.#multiBoards];
    }
    const rects = [];
    for (const id of ids) {
      const board = this.#host.doc.getBoard(id);
      if (board) rects.push(this.#boardRect(board, overrides?.get(id)));
    }
    this.#boardOutline.show(rects, drag ? !drag.legal : false);
  }

  /** The live component / wire / board sets. READ-ONLY views: every mutation
      goes through the methods below, which keep the highlighting in step. */
  get parts() {
    return this.#multi;
  }

  get wires() {
    return this.#multiWires;
  }

  get boards() {
    return this.#multiBoards;
  }

  /** The single pick — `{kind, id}` or null. */
  get single() {
    return this.#selected;
  }

  size() {
    return this.#multi.size + this.#multiWires.size + this.#multiBoards.size;
  }

  clearMulti() {
    for (const id of this.#multi) {
      this.#host.partViews.get(id)?.setSelected(false);
    }
    this.#multi.clear();
    if (this.#multiWires.size) {
      this.#multiWires.clear();
      this.#host.wireLayer.setSelectedMany([]);
    }
    if (this.#multiBoards.size) {
      this.#multiBoards.clear();
      this.#boardOutline.show([], false);
    }
  }

  /** Replace the multi-selection; a non-empty one clears the single pick. */
  setMulti(ids, wireIds = [], boardIds = []) {
    this.clearMulti();
    // What is actually still on the desk — the caller may name anything.
    const parts = [...ids].filter((id) => this.#host.partViews.has(id));
    const wires = [...wireIds].filter((id) => this.#host.doc.getWire(id));
    const boards = [...boardIds].filter((id) => this.#host.boardViews.has(id));
    // The single pick is dropped FIRST, before anything is highlighted:
    // `#select(null)` un-highlights the part it was on, and that part is very
    // often IN the set about to be highlighted (a marquee drawn around the
    // selected part, or Select All). Clearing afterwards would silently undo
    // the highlight just applied to it.
    if (parts.length || wires.length || boards.length) this.select(null);
    for (const id of parts) {
      this.#multi.add(id);
      this.#host.partViews.get(id).setSelected(true);
    }
    for (const id of wires) this.#multiWires.add(id);
    for (const id of boards) this.#multiBoards.add(id);
    if (this.#multiWires.size) {
      this.#host.wireLayer.setSelectedMany(this.#multiWires);
    }
    // #select(null) already re-traces the outline, but only when something WAS
    // selected — refresh unconditionally so a marquee's boards light up.
    this.refreshBoardOutline();
    this.refreshRidePreview(); // Option may be held over the NEW selection
  }

  /**
   * Select the WHOLE desktop — every board, every component seated on one (and
   * every desk-level brick), and every wire — as though a marquee had been
   * drawn around all of it. That is deliberately the same set a marquee
   * captures, so `⌘A` then `⌘C` copies the entire desk as one design clip.
   *
   * Refused while the circuit runs, for the reason a marquee is: a selection
   * applied into the frozen state would be one the user cannot act on.
   *
   * @returns {boolean} whether anything was selected.
   */
  selectAll() {
    if (this.#host.editingLocked) return false;
    const components = this.#host.doc.components.map((c) => c.id);
    const wires = this.#host.doc.wires.map((w) => w.id);
    const boards = this.#host.doc.boards.map((b) => b.id);
    if (!components.length && !wires.length && !boards.length) return false;
    this.setMulti(components, wires, boards);
    return true;
  }

  selectBoard(id) {
    this.select(this.#host.boardViews.has(id) ? { kind: "board", id } : null);
  }

  selectComponent(id) {
    this.select(this.#host.partViews.has(id) ? { kind: "part", id } : null);
  }

  selectWire(id) {
    if (this.#host.mode) return; // wiring/placing/dragging — clicks aren't selects
    this.select(this.#host.doc.getWire(id) ? { kind: "wire", id } : null);
  }

  selectBus(id) {
    if (this.#host.mode) return; // busing/placing/dragging — clicks aren't selects
    this.select(this.#host.doc.getBus(id) ? { kind: "bus", id } : null);
  }

  selectAnnotation(id) {
    this.select(
      this.#host.doc.getAnnotation(id) ? { kind: "annotation", id } : null,
    );
  }

  deselect() {
    this.clearMulti();
    this.select(null);
  }

  // ── Additive selection (⌘/Ctrl-click) ───────────────────────────────────
  //
  // The marquee REPLACES a selection; this ADDS one item to it, or takes one
  // back out. Both build the same three sets, so everything downstream —
  // Delete, ⌘C's cluster/design clip, the board highlighter — is untouched.
  //
  // Annotations are deliberately absent: they are not one of those three sets
  // (a marquee cannot take one either), so a modifier-click on a label leaves
  // the selection exactly as it was rather than silently throwing it away in
  // exchange for the note. A plain click still selects one.

  /** The selection as the three sets, with the single pick folded in — that
      pick is what a modifier-click most often EXTENDS, so it has to be part of
      what is being toggled against. A selected board contributes its whole
      snapped group, which is the set its highlighter is already drawing. */
  #selectionSets() {
    const sets = {
      parts: new Set(this.#multi),
      wires: new Set(this.#multiWires),
      boards: new Set(this.#multiBoards),
    };
    const sel = this.#selected;
    if (sel?.kind === "part") sets.parts.add(sel.id);
    else if (sel?.kind === "wire") sets.wires.add(sel.id);
    else if (sel?.kind === "board") {
      for (const b of this.#host.doc.groupMembers(sel.id))
        sets.boards.add(b.id);
    }
    return sets;
  }

  /**
   * Toggle a set of ids of one kind in and out of the selection.
   *
   * Refused while a tool or a drag owns `#mode` (a click is not a select
   * then — the same guard selectWire/selectBus carry) and while the circuit
   * runs, for the reason a marquee is: a selection applied into the frozen
   * state is one the user cannot act on.
   *
   * @param {"parts"|"wires"|"boards"} kind
   * @param {string[]} ids
   */
  #toggle(kind, ids) {
    if (this.#host.mode || this.#host.editingLocked) return;
    const next = toggleSelection(this.#selectionSets(), kind, ids);
    const one = singlePick(next);
    if (one)
      this.select(one); // collapse — see singlePick's own note
    else if (next.parts.length || next.wires.length || next.boards.length) {
      this.setMulti(next.parts, next.wires, next.boards);
    } else this.deselect();
  }

  /** ⌘/Ctrl-click a part or brick: in or out of the selection. */
  toggleComponentSelection(id) {
    if (this.#host.partViews.has(id)) this.#toggle("parts", [id]);
  }

  /** ⌘/Ctrl-click a wire: in or out of the selection. */
  toggleWireSelection(id) {
    if (this.#host.doc.getWire(id)) this.#toggle("wires", [id]);
  }

  /** ⌘/Ctrl-click a bus: its MEMBER WIRES go in or out together — a bus is
      metadata over wires and the selection holds no bus of its own. */
  toggleBusSelection(id) {
    const members = this.#host.doc.getBus(id)?.members ?? [];
    if (members.length) this.#toggle("wires", members);
  }

  /** ⌘/Ctrl-click a board: the WHOLE snapped group goes in or out, which is
      the set a plain click already selects and the highlighter already
      outlines — a kit joins a design clip as the assembly it is. */
  toggleBoardSelection(id) {
    if (!this.#host.boardViews.has(id)) return;
    const members = this.#host.doc.groupMembers(id).map((b) => b.id);
    this.#toggle("boards", members.length ? members : [id]);
  }

  /**
   * Forget the single pick WITHOUT un-highlighting it — for a caller that is
   * unmounting the very view it points at. `deselect()` would call
   * `setSelected(false)` on a view that has already gone (or, worse, on a
   * freshly mounted one that reused the id); this just drops the reference.
   */
  forget() {
    this.#selected = null;
  }

  /**
   * Forget EVERYTHING, layers included — the whole-scene teardown
   * (`DeskController#rebuildScene`, on undo/redo and a desktop switch). Same
   * argument as `forget()` one level up: every view the selection names is
   * about to be unmounted, so the sets are dropped rather than un-highlighted,
   * and the two overlays are cleared because what they were drawing is gone.
   */
  forgetAll() {
    this.#selected = null;
    this.#multi.clear();
    this.#multiWires.clear();
    this.#multiBoards.clear();
    this.#host.wireLayer.setSelected(null);
    this.#host.wireLayer.setSelectedMany([]);
    this.#host.annotationLayer.setSelected(null);
    this.#boardOutline.show([], false);
    this.refreshRidePreview();
  }

  /** Drop the selection if it is this wire (WireTools calls this on remove). */
  clearIfWire(id) {
    if (this.#selected?.kind === "wire" && this.#selected.id === id) {
      this.#selected = null;
      this.#host.wireLayer.setSelected(null);
    }
  }

  /** Drop the selection if it is this bus (BusTools calls this on remove). */
  clearIfBus(id) {
    if (this.#selected?.kind === "bus" && this.#selected.id === id) {
      this.#selected = null;
      this.#host.wireLayer.setSelectedBus(null);
    }
  }
}
