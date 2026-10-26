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

// desk-selection.js — WHAT IS SELECTED on the desk, and the overlays that say
// so.
//
// The selection is built three ways (CLAUDE.md → "Selection"): a plain click
// picks ONE object, a rubber band drawn from the background REPLACES the
// selection with everything it wholly encloses, and a ⌘/Ctrl-click adds one
// object or takes one out (model/selection-toggle.js owns the pure rule). The
// band and the chord fill the same three sets — parts, wires, boards — so
// Delete, ⌘C's cluster/design clip and the board highlighter read one shape.
// A single pick sits beside them in its own slot, and is FOLDED IN wherever
// the answer is "everything selected", since it is what a chord most often
// extends. Option/Alt-click picks one LEAD (a wire end, a two-terminal part's
// leg) — a single pick of its own kind that REPLACES the selection — and
// Option/Alt+⌘/Ctrl-click adds one lead to the set or takes it out: a fourth
// set, `leads`, of `leadKey` strings. A lead whose owner is already selected
// (or rides a selected board) is covered by it and is never in the set too.
//
// THE PASSENGER INVARIANT. A board in the selection carries everything seated
// on it, so a part on a selected board — and a wire whose ends are all on
// selected boards — is a PASSENGER: it moves and deletes with its board but is
// not selected in its own right, and so is not lit. An object is never both:
// the moment its board joins, it drops out of the independent sets. And there
// is no selection memory — taking the board back out does not bring them back
// (undo is the way back; the controller records each change of selection).
//
// Two overlays belong here because both are pure functions of the selection:
// the BoardOutline traces the outer edge of every strip a grab would move (one
// path, so flush strips show no seam), and the lead rings mark the leads an
// Option/Alt-click picked.
//
// It is the same host-object arrangement WireTools and BusTools use — the
// shared `#mode` and the surface (doc, views, layers) come from the host.

import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { boardSize, parseAddress } from "../model/breadboard.js";
import {
  leadKey,
  parseLeadKey,
  singlePick,
  toggleSelection,
} from "../model/selection-toggle.js";
import { BoardOutline } from "./board-outline.js";
import { HoleRings } from "./hole-rings.js";

/** The single-pick kinds that name a LEAD rather than an object. */
const LEAD_KINDS = new Set(["lead", "wire-end"]);

const samePick = (a, b) =>
  a?.kind === b?.kind && a?.id === b?.id && a?.end === b?.end;

export class DeskSelection {
  #host;
  /** The single pick: `{kind, id}` or null. `kind` is one of board / part /
      wire / bus / annotation / signal / tag — only the first three can also
      be multi — or a LEAD: `{kind: "lead", id, end: "a"|"b"}` (a two-terminal
      part's leg) / `{kind: "wire-end", id, end: "from"|"to"}`. */
  #selected = null;
  #multi = new Set(); // component ids
  #multiWires = new Set(); // wire ids
  #multiBoards = new Set(); // board ids
  #multiLeads = new Set(); // leadKey strings — picked wire ends and legs
  #boardOutline;
  #leadRing;

  /**
   * @param {object} host - the controller. Supplies `doc`, the mutable `mode`,
   *   `editingLocked`, the view maps (`boardViews`, `partViews`), the shared
   *   layers (`wireLayer`, `annotationLayer`, …), `leadWorld(pick)` (where a
   *   picked lead sits), and `onSelect(sel)`, told whenever the single pick
   *   changes.
   * @param {HTMLElement} overlay - the pointer-inert overlay layer both
   *   overlays draw into.
   */
  constructor(host, overlay) {
    this.#host = host;
    this.#boardOutline = new BoardOutline(overlay);
    this.#leadRing = new HoleRings(overlay, "hole-ring--selected");
  }

  #applySelection(sel, on) {
    if (!sel) return;
    if (sel.kind === "board")
      this.#host.boardViews.get(sel.id)?.setSelected(on);
    else if (sel.kind === "part")
      this.#host.partViews.get(sel.id)?.setSelected(on);
    else if (LEAD_KINDS.has(sel.kind)) {
      this.refreshLeadRing();
    } else if (sel.kind === "annotation") {
      this.#host.annotationLayer.setSelected(on ? sel.id : null);
    } else if (sel.kind === "signal") {
      this.#host.signalLayer.setSelected(on ? sel.id : null);
    } else if (sel.kind === "tag") {
      this.#host.integrationLayer.setSelected(on ? sel.id : null);
    } else if (sel.kind === "bus") {
      this.#host.wireLayer.setSelectedBus(on ? sel.id : null);
    } else this.#host.wireLayer.setSelected(on ? sel.id : null);
  }

  select(sel) {
    // A single pick always replaces a multi-selection.
    if (sel && this.size()) this.clearMulti();
    if (samePick(this.#selected, sel)) return;
    const was = this.#selected;
    this.#selected = sel;
    this.#applySelection(was, false);
    this.#applySelection(this.#selected, true);
    this.refreshBoardOutline();
    this.refreshLeadRing();
    this.#host.onSelect?.(sel);
  }

  // ── The picked lead (Option/Alt-click) ──────────────────────────────────

  /** Pick ONE lead — a two-terminal part's leg (`end` "a" = pin 1, "b" = pin
      2) — replacing whatever was selected. Option/Alt is never additive. */
  selectLead(componentId, end) {
    if (!this.#host.partViews.has(componentId)) return;
    this.select({ kind: "lead", id: componentId, end });
  }

  /** Pick ONE wire end — the lead of a jumper, by its `from`/`to` end. */
  selectWireEnd(wireId, end) {
    if (!this.#host.doc.getWire(wireId)) return;
    this.select({ kind: "wire-end", id: wireId, end });
  }

  /** Re-ring the picked leads where they sit NOW — after a drag lands them,
      an undo, anything that can move them. Clears the rings when no lead is
      picked (a lead that no longer resolves simply isn't ringed), and while a
      group drag carries them (its own preview shows where they are going). */
  refreshLeadRing() {
    const mode = this.#host.mode;
    if (mode?.kind === "drag-cluster" && mode.active) {
      this.#leadRing.show(null);
      return;
    }
    const sel = this.#selected;
    const picks = LEAD_KINDS.has(sel?.kind)
      ? [sel]
      : [...this.#multiLeads].map(parseLeadKey);
    const at = picks.map((p) => p && this.#host.leadWorld?.(p)).filter(Boolean);
    this.#leadRing.show(at.length ? at : null);
  }

  /** Does a lead's owner still exist? */
  #leadExists(pick) {
    if (pick?.kind === "lead") return this.#host.partViews.has(pick.id);
    if (pick?.kind === "wire-end")
      return Boolean(this.#host.doc.getWire(pick.id));
    return false;
  }

  /** Is a lead COVERED by `sets` — its wire or part selected in its own
      right, or a passenger of a selected board? Then it moves (and deletes)
      with its owner already, and is not in the lead set as well. */
  #leadCovered(pick, sets) {
    if (pick.kind === "wire-end") {
      return sets.wires.has(pick.id) || this.isPassengerWire(pick.id, sets.boards); // prettier-ignore
    }
    return sets.parts.has(pick.id) || this.isPassengerPart(pick.id, sets.boards); // prettier-ignore
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
   * Re-draw the board highlighter around the OUTER edge of every strip in the
   * selection — the strips a grab would move. Positions come from `overrides`
   * mid-drag, from the document otherwise; a drag in flight outlines exactly
   * the strips it is carrying, red while the drop would be refused.
   *
   * @param {Map<string, {x:number,y:number}>|null} [overrides]
   */
  refreshBoardOutline(overrides = null) {
    const mode = this.#host.mode;
    const drag =
      mode?.kind === "drag-cluster" && mode.boardIds?.length ? mode : null;
    const ids = drag ? drag.boardIds : [...this.selectedBoards()];
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

  /** The picked leads' `leadKey` strings (the multi set only). */
  get leads() {
    return this.#multiLeads;
  }

  /** The single pick — `{kind, id}` or null. */
  get single() {
    return this.#selected;
  }

  size() {
    return (
      this.#multi.size +
      this.#multiWires.size +
      this.#multiBoards.size +
      this.#multiLeads.size
    );
  }

  /** Every board in the selection — the multi set, or a single picked
      board's whole snapped group (the set its highlighter draws). */
  selectedBoards() {
    if (this.#multiBoards.size) return new Set(this.#multiBoards);
    if (this.#selected?.kind === "board") {
      const members = this.#host.doc.groupMembers(this.#selected.id);
      return new Set(members.length ? members.map((b) => b.id) : [this.#selected.id]); // prettier-ignore
    }
    return new Set();
  }

  /**
   * Everything a grab would move, with the single pick folded in: the
   * independently selected parts and wires, the selected boards (whose
   * passengers are carried, not listed), and the leads of the multi set (as
   * picks, `{kind, id, end}`). A single picked lead, an annotation, a signal
   * or a tag moves alone and contributes nothing here.
   */
  movingSets() {
    const sets = {
      parts: new Set(this.#multi),
      wires: new Set(this.#multiWires),
      boards: this.selectedBoards(),
      leads: [...this.#multiLeads]
        .map(parseLeadKey)
        .filter((pick) => this.#leadExists(pick)),
    };
    const sel = this.#selected;
    if (sel?.kind === "part") sets.parts.add(sel.id);
    else if (sel?.kind === "wire") sets.wires.add(sel.id);
    else if (sel?.kind === "bus") {
      for (const id of this.#host.doc.getBus(sel.id)?.members ?? []) {
        sets.wires.add(id);
      }
    }
    return sets;
  }

  /** Is this component a PASSENGER of `boards` — seated on one of them? */
  isPassengerPart(id, boards = this.selectedBoards()) {
    const comp = this.#host.doc.getComponent(id);
    return comp?.board != null && boards.has(comp.board);
  }

  /** Is this wire a PASSENGER of `boards` — every end in a hole of one of
      them, so it rides along with no change to either address? */
  isPassengerWire(id, boards = this.selectedBoards()) {
    if (boards.size === 0) return false;
    const wire = this.#host.doc.getWire(id);
    if (!wire) return false;
    return [wire.from, wire.to].every((address) =>
      boards.has(parseAddress(address)?.boardId),
    );
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
    if (this.#multiLeads.size) {
      this.#multiLeads.clear();
      this.refreshLeadRing();
    }
  }

  /** Replace the multi-selection; a non-empty one clears the single pick.
      Passengers of the boards named are dropped from the part and wire sets
      — they ride their board, unlit, and are never selected twice over — and
      a lead (`leadKey`) is dropped when its owner is covered the same way. */
  setMulti(ids, wireIds = [], boardIds = [], leadKeys = []) {
    this.clearMulti();
    // What is actually still on the desk — the caller may name anything.
    const boards = [...boardIds].filter((id) => this.#host.boardViews.has(id));
    const boardSet = new Set(boards);
    const parts = [...ids].filter(
      (id) =>
        this.#host.partViews.has(id) &&
        !this.#isMeter(id) &&
        !this.isPassengerPart(id, boardSet),
    );
    const wires = [...wireIds].filter(
      (id) => this.#host.doc.getWire(id) && !this.isPassengerWire(id, boardSet),
    );
    const covering = {
      parts: new Set(parts),
      wires: new Set(wires),
      boards: boardSet,
    };
    const leads = [...leadKeys].filter((key) => {
      const pick = parseLeadKey(key);
      return this.#leadExists(pick) && !this.#leadCovered(pick, covering);
    });
    // The single pick is dropped FIRST, before anything is highlighted:
    // `#select(null)` un-highlights the part it was on, and that part is very
    // often IN the set about to be highlighted (a band drawn around the
    // selected part, or Select All). Clearing afterwards would silently undo
    // the highlight just applied to it.
    if (parts.length || wires.length || boards.length || leads.length) {
      this.select(null);
    }
    for (const id of parts) {
      this.#multi.add(id);
      this.#host.partViews.get(id).setSelected(true);
    }
    for (const id of wires) this.#multiWires.add(id);
    for (const id of boards) this.#multiBoards.add(id);
    for (const key of leads) this.#multiLeads.add(key);
    this.refreshLeadRing();
    if (this.#multiWires.size) {
      this.#host.wireLayer.setSelectedMany(this.#multiWires);
    }
    // #select(null) already re-traces the outline, but only when something WAS
    // selected — refresh unconditionally so a band's boards light up.
    this.refreshBoardOutline();
  }

  /**
   * Select the WHOLE desktop — every board, every desk-level brick, and every
   * wire — as though a band had been drawn around all of it. The parts seated
   * on the boards ride as passengers, so `⌘A` then `⌘C` copies the entire desk
   * as one design clip.
   *
   * Refused while the circuit runs, for the reason a band is: a selection
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
    if (this.#isMeter(id)) return; // never selected: it floats over the desk
    this.select(this.#host.partViews.has(id) ? { kind: "part", id } : null);
  }

  /** Whether a component is the multimeter — an instrument lying on the
      desk, no part of any selection (catalog/meter.js). */
  #isMeter(id) {
    return this.#host.doc.getComponent(id)?.kind === "meter";
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

  /** Pick one signal's flag. Like an annotation, a signal is NONE of the three
      multi sets, so the additive chord never reaches here. */
  selectSignal(id) {
    this.select(this.#host.doc.getSignal(id) ? { kind: "signal", id } : null);
  }

  /** Pick one Output/Input TAG (`<element>:<key>`). Like a signal flag, a tag
      is none of the three multi sets. */
  selectTag(id) {
    this.select({ kind: "tag", id });
  }

  deselect() {
    this.clearMulti();
    this.select(null);
  }

  // ── Additive selection (⌘/Ctrl-click, and ⌥⌘/Alt+Ctrl for a lead) ───────
  //
  // The band REPLACES a selection; this ADDS one item to it, or takes one back
  // out. Both build the same sets, so everything downstream — Delete, ⌘C's
  // cluster/design clip, the board highlighter — is untouched. The lead chord
  // fills the fourth set, which only a drag and Delete read.
  //
  // Annotations, signals and tags are deliberately absent: they are none of
  // the sets, so a chord on one leaves the selection exactly as it was. A
  // plain click still selects one.

  /** The selection as the four sets, with the single pick folded in — that
      pick is what a chord most often EXTENDS, so it has to be part of what is
      being toggled against. A selected board contributes its whole snapped
      group, which is the set its highlighter is already drawing. */
  #selectionSets() {
    const sets = {
      parts: new Set(this.#multi),
      wires: new Set(this.#multiWires),
      boards: new Set(this.#multiBoards),
      leads: new Set(this.#multiLeads),
    };
    const sel = this.#selected;
    if (sel?.kind === "part") sets.parts.add(sel.id);
    else if (sel?.kind === "wire") sets.wires.add(sel.id);
    else if (LEAD_KINDS.has(sel?.kind)) sets.leads.add(leadKey(sel));
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
   * then) and while the circuit runs, for the reason a band is: a selection
   * applied into the frozen state is one the user cannot act on.
   *
   * A part or wire riding a SELECTED board is a passenger, already carried —
   * toggling it in would select it twice over, so the chord leaves it alone.
   * A board coming IN takes its passengers out of the independent sets (in
   * `setMulti`), and going back out does not restore them.
   *
   * A LEAD whose owner is selected or a passenger is covered by it already,
   * and the chord leaves it alone too.
   *
   * @param {"parts"|"wires"|"boards"|"leads"} kind
   * @param {string[]} ids
   */
  #toggle(kind, ids) {
    if (this.#host.mode || this.#host.editingLocked) return;
    const current = this.#selectionSets();
    if (kind === "parts" && ids.every((id) => this.isPassengerPart(id, current.boards))) return; // prettier-ignore
    if (kind === "wires" && ids.every((id) => this.isPassengerWire(id, current.boards))) return; // prettier-ignore
    if (kind === "leads" && ids.every((key) => this.#leadCovered(parseLeadKey(key), current))) return; // prettier-ignore
    const next = toggleSelection(current, kind, ids);
    // A lead its owner now covers leaves BEFORE the count — or a leg picked
    // and then its part ⌘-clicked left a one-item set that is no single pick
    // (setMulti would drop the lead, leaving the part alone in a set R and
    // Properties… cannot reach).
    const covering = {
      parts: new Set(next.parts),
      wires: new Set(next.wires),
      boards: new Set(next.boards),
    };
    next.leads = next.leads.filter(
      (key) => !this.#leadCovered(parseLeadKey(key), covering),
    );
    // ONE part or wire collapses to the ordinary single pick (singlePick's own
    // note). A lone BOARD stays in the set: a single pick of a board stands
    // for its whole snapped group, and a strip a band picked out on its own
    // must not silently grow back into its kit.
    const one = singlePick(next);
    if (one && one.kind !== "board") this.select(one);
    else if (
      next.parts.length ||
      next.wires.length ||
      next.boards.length ||
      next.leads.length
    ) {
      this.setMulti(next.parts, next.wires, next.boards, next.leads);
    } else this.deselect();
  }

  /** Option/Alt+⌘/Ctrl-click a lead — `{kind: "lead"|"wire-end", id, end}`:
      in or out of the selection. */
  toggleLeadSelection(pick) {
    if (this.#leadExists(pick)) this.#toggle("leads", [leadKey(pick)]);
  }

  /** ⌘/Ctrl-click a part or brick: in or out of the selection. */
  toggleComponentSelection(id) {
    if (this.#host.partViews.has(id) && !this.#isMeter(id)) this.#toggle("parts", [id]); // prettier-ignore
  }

  /** ⌘/Ctrl-click a wire: in or out of the selection. */
  toggleWireSelection(id) {
    if (this.#host.doc.getWire(id)) this.#toggle("wires", [id]);
  }

  /** ⌘/Ctrl-click a bus: its MEMBER WIRES go in or out together — a bus is
      metadata over wires and the selection holds no bus of its own. */
  toggleBusSelection(id) {
    // Its PASSENGER members (ridden by a selected board) are never in the set,
    // so leaving them in made the all-or-nothing test always "not selected",
    // and the bus could never be clicked back out.
    const boards = this.#selectionSets().boards;
    const members = (this.#host.doc.getBus(id)?.members ?? []).filter(
      (w) => !this.isPassengerWire(w, boards),
    );
    if (members.length) this.#toggle("wires", members);
  }

  /** ⌘/Ctrl-click a board: the WHOLE snapped group goes in or out — a kit is
      one board to the hand. (A band can still take a strip on its own, which
      is how one is peeled off its rails.) */
  toggleBoardSelection(id) {
    if (!this.#host.boardViews.has(id)) return;
    const members = this.#host.doc.groupMembers(id).map((b) => b.id);
    this.#toggle("boards", members.length ? members : [id]);
  }

  // ── Undo/redo of the selection ──────────────────────────────────────────

  /** The selection as plain data — what the undo history records with each
      step, and `restore` takes back. */
  serialize() {
    return {
      single: this.#selected ? { ...this.#selected } : null,
      parts: [...this.#multi],
      wires: [...this.#multiWires],
      boards: [...this.#multiBoards],
      leads: [...this.#multiLeads],
    };
  }

  /** Put back a selection `serialize` produced (or nothing, for null). Ids
      that no longer exist simply aren't selected. */
  restore(state) {
    this.deselect();
    if (!state) return;
    if (
      state.parts?.length ||
      state.wires?.length ||
      state.boards?.length ||
      state.leads?.length
    ) {
      this.setMulti(
        state.parts ?? [],
        state.wires ?? [],
        state.boards ?? [],
        state.leads ?? [],
      );
      return;
    }
    const sel = state.single;
    if (!sel) return;
    const doc = this.#host.doc;
    const exists =
      (sel.kind === "board" && this.#host.boardViews.has(sel.id)) ||
      ((sel.kind === "part" || sel.kind === "lead") &&
        this.#host.partViews.has(sel.id)) ||
      ((sel.kind === "wire" || sel.kind === "wire-end") &&
        doc.getWire(sel.id)) ||
      (sel.kind === "bus" && doc.getBus(sel.id)) ||
      (sel.kind === "annotation" && doc.getAnnotation(sel.id)) ||
      (sel.kind === "signal" && doc.getSignal(sel.id)) ||
      sel.kind === "tag";
    if (exists) this.select({ ...sel });
  }

  /**
   * Forget the single pick WITHOUT un-highlighting it — for a caller that is
   * unmounting the very view it points at. `deselect()` would call
   * `setSelected(false)` on a view that has already gone (or, worse, on a
   * freshly mounted one that reused the id); this just drops the reference.
   */
  forget() {
    this.#selected = null;
    this.#leadRing.clear();
  }

  /**
   * Forget EVERYTHING, layers included — the whole-scene teardown
   * (`DeskController#rebuildScene`, on undo/redo and a desktop switch). Same
   * argument as `forget()` one level up: every view the selection names is
   * about to be unmounted, so the sets are dropped rather than un-highlighted,
   * and the overlays are cleared because what they were drawing is gone.
   */
  forgetAll() {
    this.#selected = null;
    this.#multi.clear();
    this.#multiWires.clear();
    this.#multiBoards.clear();
    this.#multiLeads.clear();
    this.#host.wireLayer.setSelected(null);
    this.#host.wireLayer.setSelectedMany([]);
    this.#host.annotationLayer.setSelected(null);
    this.#host.signalLayer.setSelected(null);
    this.#host.integrationLayer?.setSelected(null);
    this.#boardOutline.show([], false);
    this.#leadRing.clear();
  }

  /** Drop the selection if it is this wire, or one of its ends (WireTools
      calls this on remove). */
  clearIfWire(id) {
    for (const end of ["from", "to"]) {
      this.#multiLeads.delete(leadKey({ kind: "wire-end", id, end }));
    }
    const sel = this.#selected;
    if ((sel?.kind === "wire" || sel?.kind === "wire-end") && sel.id === id) {
      this.#selected = null;
      this.#host.wireLayer.setSelected(null);
      this.#leadRing.clear();
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
