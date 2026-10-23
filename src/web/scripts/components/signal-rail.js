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

// signal-rail.js — the external-signal buttons pinned down the desk viewport's
// right edge (Feature 370).
//
// A sibling of `.desk-surface`, not a child of it: the rail belongs to the
// SCREEN, so it neither pans nor zooms — the DeskLock / ZoomControl
// arrangement. Those two already hold that edge (padlock top, zoom cluster
// bottom), and the corner chrome is kept apart by position rather than stacked
// by `z-index`, so the rail is pinned BETWEEN them by subtracting both their
// heights. That
// is the `--desk-lock-size` convention `.project-tabs` already follows, one
// tenant further on.
//
// Each row is the signal's CARD, its home as an Output/Input's card is the
// element's (integration-rail.js): the BUTTON is its head, and under it, only
// while the signal is unplaced, the flag waits as a CHIP to drag onto a board.
// A planted flag leaves its card; unplugging it brings it back. The button
// carries the Name, and its dot carries the digit KEY that presses it — the
// same key the chip and the flag on the desk print, which is what ties them
// together now that colours repeat. Colour is one custom property per row,
// shared by flag, button and analyzer lane. Selecting a flag on the desk lights its button
// (`setSelected`, fed by the SignalLayer through the controller).
//
// Two rendering paths, deliberately different:
//   `chiphippo:doc-changed`  → full rebuild (there are at most ten rows).
//   `chiphippo:sim-state`    → CLASSES ONLY, never a rebuild. That event fires
//                              on every tick.
//
// While the circuit is stopped a button is not a press (there is nothing to
// press) but a TITLE: dragging it moves the card up or down the rail
// (rail-reorder.js) — and with it the signal's key, which is its place.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { railOrder, restLevel, signalKey } from "../model/signals.js";
import { beginRailReorder } from "./rail-reorder.js";

export class SignalRail {
  #doc;
  #root;
  #list; // the signal rows — the root also hosts the integration cards below
  #rows = new Map(); // signalId → { row, btn }
  #onPress;
  #onFlagPointerDown;
  #onContextMenu;
  #onReorder;
  #canReorder;
  #reorder = null; // cancels a reorder drag in flight
  #running = false;
  #selected = null; // the signal whose flag is selected on the desk

  /**
   * @param {HTMLElement} viewport the `.desk-viewport` element
   * @param {object} doc the DeskDoc
   * @param {object} callbacks
   * @param {(id: string, index: number) => void} [callbacks.onReorder] a
   *   button dragged to another place on the rail
   * @param {() => boolean} [callbacks.canReorder] may the rail be reordered
   *   now? (no while the circuit runs — the buttons are presses then)
   */
  constructor(
    viewport,
    doc,
    { onPress, onFlagPointerDown, onContextMenu, onReorder, canReorder } = {},
  ) {
    this.#doc = doc;
    this.#onPress = onPress;
    this.#onFlagPointerDown = onFlagPointerDown;
    this.#onContextMenu = onContextMenu;
    this.#onReorder = onReorder;
    this.#canReorder =
      canReorder ?? (() => Boolean(onReorder) && !this.#running);
    // The rows get a list of their own, so the column can carry the serial
    // integration's element cards under them (integration-rail.js) and a
    // rebuild here never touches those.
    this.#list = el("div", { class: "signal-rail-list" });
    this.#root = el("div", { class: "signal-rail" }, [this.#list]);
    viewport.append(this.#root);

    window.addEventListener("chiphippo:doc-changed", () => this.render());
    window.addEventListener("chiphippo:sim-state", (e) =>
      this.#paint(e.detail),
    );
    this.render();
  }

  /** Rebuild every row from the document, in rail order. */
  render() {
    this.#reorder?.(); // the rows it was moving are about to go
    this.#list.replaceChildren();
    this.#rows.clear();
    for (const sig of railOrder(this.#doc.signals)) {
      const row = this.#buildRow(sig);
      this.#list.append(row.row);
      this.#rows.set(sig.id, row);
    }
  }

  /** Re-apply the language to every label (nothing else changes). */
  relocalize() {
    this.render();
  }

  /**
   * Light the button of the signal whose flag is selected on the desk (null
   * clears it). A class toggle, and remembered, so a rebuild keeps it.
   */
  setSelected(id) {
    this.#selected = id ?? null;
    for (const [sigId, { btn }] of this.#rows) {
      btn.classList.toggle("signal-btn--selected", sigId === this.#selected);
    }
  }

  #buildRow(sig) {
    const key = signalKey(this.#doc.signals, sig.id);
    const name = sig.name || sig.id;
    const btn = el(
      "button",
      {
        type: "button",
        class: "signal-btn",
        // Description is the tooltip; the name is already on the face, so with
        // no description the digit is the useful thing left to say.
        title:
          sig.description ||
          (key ? t("desk.signal.digitHint", { digit: key }) : name),
        "aria-label": t("desk.signal.press", { name }),
        "aria-pressed": "false",
        oncontextmenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.#onContextMenu?.(sig.id, e);
        },
      },
      [
        // The key, on the colour dot — the same glyph the flag prints.
        el("span", {
          class: "signal-btn-dot",
          "aria-hidden": "true",
          text: key ?? "",
        }),
        el("span", { class: "signal-btn-label", text: name }),
      ],
    );
    if (sig.type === "toggle") btn.classList.add("signal-btn--toggle");
    if (sig.id === this.#selected) btn.classList.add("signal-btn--selected");

    // The flag waiting on its card, as an Output/Input's tag waits on its
    // own: a chip printing the key, gone once the flag is on the desk.
    const tags = sig.flag
      ? []
      : [
          el("div", { class: "signal-rail-tags" }, [
            el("span", {
              class: "signal-flag-chip",
              title: t("desk.signal.dragHint"),
              text: key ?? "",
              onpointerdown: (e) => this.#onFlagChipDown(sig.id, e),
            }),
          ]),
        ];

    const row = el(
      "div",
      { class: "signal-rail-row", dataset: { signalId: sig.id } },
      [btn, ...tags],
    );
    row.style.setProperty("--signal-color", `var(--color-wire-${sig.color})`);
    if (sig.flag) row.classList.add("signal-rail-row--placed");
    this.#bindPress(sig.id, btn, row);
    return { row, btn };
  }

  /**
   * The press gesture. NOT a `beginPointerGesture`: there is no move stream and
   * nothing to resolve into world coordinates, and `#dragGestureActive` derives
   * "a drag is in flight" from a `drag…` kind name — this is not a desk gesture
   * at all. What it does need is a guaranteed release, hence all three legs.
   */
  #bindPress(id, btn, row) {
    const release = () => this.#onPress?.(id, false);
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      // DeskView only pans from the BARE viewport, so panning is safe already;
      // this is for DeskController's own viewport pointer dispatcher.
      e.stopPropagation();
      if (this.#canReorder()) {
        this.#beginReorder(id, row, btn, e);
        return;
      }
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        /* best-effort — the release legs below still fire */
      }
      this.#onPress?.(id, true);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
      btn.addEventListener(type, release);
    }
  }

  /** A stopped button's press: the start of a drag up or down the rail. */
  #beginReorder(id, row, btn, e) {
    this.#reorder?.();
    const cancel = beginRailReorder(e, {
      card: row,
      list: this.#list,
      column: this.#root,
      handle: btn,
      onDrop: (from, to) => {
        this.#reorder = null;
        this.#onReorder?.(id, to);
      },
    });
    this.#reorder = () => {
      this.#reorder = null;
      cancel();
    };
  }

  #onFlagChipDown(id, e) {
    if (e.button !== 0) return;
    e.stopPropagation();
    this.#onFlagPointerDown?.(id, e);
  }

  /**
   * Paint the live levels from `chiphippo:sim-state`. Classes only — this runs
   * on every tick. While stopped every button shows its RESTING level, so a
   * toggle that did not survive the Run never looks like a bug.
   */
  #paint(detail) {
    this.#running = Boolean(detail?.running);
    const levels = detail?.signalLevels ?? new Map();
    for (const sig of this.#doc.signals) {
      const entry = this.#rows.get(sig.id);
      if (!entry) continue;
      const level = this.#running
        ? levels.get(sig.id)
        : restLevel(sig) === "high"
          ? "H"
          : "L";
      const on = level === "H";
      entry.btn.classList.toggle("signal-btn--on", on);
      entry.btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  /** Tear the rail out of the viewport (a scene rebuild). */
  remove() {
    this.#reorder?.();
    this.#root.remove();
    this.#rows.clear();
  }

  /** The rail element, for tests. */
  get element() {
    return this.#root;
  }
}
