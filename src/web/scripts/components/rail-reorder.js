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

// rail-reorder.js — dragging a card up or down its rail by its title, the
// one gesture the signal buttons (signal-rail.js) and the Output/Input/Data
// cards (integration-rail.js) share.
//
// A card moves only within its OWN list: the signals' order is their keys
// (key 3 is the third button down), and a card has no place among the
// other list's. So the list as it stood when the drag began, give or take
// `ZONE_MARGIN`, is where a drop can land:
//   • over it, the card is SHOWN in the slot a release would put it in —
//     the others step aside — and that is the slot the release commits;
//   • off it, the card comes off the rail and rides the pointer, the others
//     close up without it, and a release there puts everything back.
// The zone is measured ONCE, at the press, so the card leaving the list
// (which shrinks it) cannot move the line it has to cross to come back.
//
// The preview never moves a node: each card's place is its flex `order`,
// and a riding card is `position: fixed`. Re-inserting the grabbed card
// would detach it, and a detached element loses the pointer capture — which
// the gesture plumbing (pointer-gesture.js) reads as the pointer being gone.
//
// Nothing here touches the document: the release reports `(from, to)` and
// the rail's owner commits it (one undo step); the rebuild that follows
// clears the preview. A press that never travels is not a drag at all.

import { beginPointerGesture } from "./pointer-gesture.js";

const DRAG_THRESHOLD = 4; // px, the desk's click/drag line
const ZONE_MARGIN = 12; // px around the list that still counts as over it

/**
 * Begin a press on a card's title that may become a reorder drag.
 *
 * @param {PointerEvent} e the pointerdown
 * @param {object} o
 * @param {HTMLElement} o.card the card being pressed (a child of `list`)
 * @param {HTMLElement} o.list the flex column holding the cards, in order
 * @param {HTMLElement} o.column the whole rail column — its width is the
 *   drop zone's
 * @param {HTMLElement} o.handle the pressed title; it takes the capture
 * @param {(from: number, to: number) => void} o.onDrop a real move only
 * @returns {() => void} cancel — reverts the preview; safe to call twice
 */
export function beginRailReorder(e, { card, list, column, handle, onDrop }) {
  const cards = [...list.children];
  const from = cards.indexOf(card);
  const others = cards.filter((c) => c !== card);
  const startRect = card.getBoundingClientRect();
  const listRect = list.getBoundingClientRect();
  const colRect = column.getBoundingClientRect();
  const zone = {
    left: Math.min(colRect.left, listRect.left) - ZONE_MARGIN,
    right: Math.max(colRect.right, listRect.right) + ZONE_MARGIN,
    top: listRect.top - ZONE_MARGIN,
    bottom: listRect.bottom + ZONE_MARGIN,
  };
  const grab = { x: e.clientX - startRect.left, y: e.clientY - startRect.top };
  const start = { x: e.clientX, y: e.clientY };
  let active = false;
  let ended = false;
  let slot = from; // where the card shows — null while it rides the pointer
  let origin = null; // a fixed card's containing-block offset, measured once

  const place = (index) => {
    others.forEach((c, k) => {
      c.style.order = String(k < index ? k : k + 1);
    });
    card.style.order = String(index);
  };

  const ride = (x, y) => {
    if (!card.classList.contains("rail-reorder--floating")) {
      card.style.width = `${startRect.width}px`;
      card.classList.add("rail-reorder--floating");
      if (!origin) {
        // `fixed` means the viewport unless an ancestor says otherwise —
        // measure, rather than trust, where left/top 0 actually lands.
        card.style.left = "0px";
        card.style.top = "0px";
        const r = card.getBoundingClientRect();
        origin = { x: r.left, y: r.top };
      }
    }
    card.style.left = `${x - grab.x - origin.x}px`;
    card.style.top = `${y - grab.y - origin.y}px`;
  };

  const dock = () => {
    card.classList.remove("rail-reorder--floating");
    for (const prop of ["width", "left", "top"])
      card.style.removeProperty(prop);
  };

  const update = (x, y) => {
    const over =
      x >= zone.left && x <= zone.right && y >= zone.top && y <= zone.bottom;
    if (!over) {
      slot = null;
      ride(x, y);
      return;
    }
    // Measured as laid out NOW, the grabbed card included where it shows:
    // the slot is how many of the others sit above the pointer.
    const index = others.filter((c) => {
      const r = c.getBoundingClientRect();
      return r.top + r.height / 2 < y;
    }).length;
    dock();
    if (index !== slot) place(index);
    slot = index;
  };

  const cleanup = () => {
    dock();
    card.classList.remove("rail-reorder--dragging");
    column.classList.remove("rail-reorder--active");
    for (const c of cards) c.style.removeProperty("order");
  };

  const finish = (commit) => {
    if (ended) return;
    ended = true;
    teardown();
    window.removeEventListener("keydown", onKey, true);
    const to = slot;
    cleanup();
    // The drop is the slot the last move SHOWED; riding the pointer showed
    // none, and that release puts everything back.
    if (commit && active && to !== null && to !== from) onDrop(from, to);
  };

  const onMove = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    if (!active) {
      if (
        Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD
      ) {
        return;
      }
      active = true;
      card.classList.add("rail-reorder--dragging");
      column.classList.add("rail-reorder--active");
    }
    update(ev.clientX, ev.clientY);
  };

  const onEnd = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    finish(ev.type === "pointerup");
  };

  const onKey = (ev) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(false);
  };

  const teardown = beginPointerGesture(handle, e.pointerId, { onMove, onEnd });
  window.addEventListener("keydown", onKey, true);
  return () => finish(false);
}
