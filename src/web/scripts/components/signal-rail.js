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

// signal-rail.js — the external-signal buttons pinned down the desk viewport's
// right edge (Feature 370).
//
// A sibling of `.desk-surface`, not a child of it: the rail belongs to the
// SCREEN, so it neither pans nor zooms — the DeskLock / ZoomControl
// arrangement. Those two already hold that edge (padlock top, zoom cluster
// bottom) and the app has no `z-index` anywhere, stacking on DOM order alone,
// so the rail is pinned BETWEEN them by subtracting both their heights. That
// is the `--desk-lock-size` convention `.project-tabs` already follows, one
// tenant further on.
//
// Each row is a flag CHIP (only while the signal is unplaced) beside a BUTTON.
// The button carries the Name; the chip is what you drag onto a board. Colour
// is one custom property per row, tying flag to button to analyzer lane.
//
// Two rendering paths, deliberately different:
//   `chiphippo:doc-changed`  → full rebuild (there are at most eight rows).
//   `chiphippo:sim-state`    → CLASSES ONLY, never a rebuild. That event fires
//                              on every tick.

import { el, svgEl } from "../dom.js";
import { t } from "../i18n.js";
import {
  FLAG_LEN,
  FLAG_W,
  flagPolygon,
  railOrder,
  restLevel,
  signalDigit,
} from "../model/signals.js";

/** The chip's flag glyph: the SAME polygon the desk draws, at chip scale. */
function chipGlyph() {
  const pad = 0.2;
  const pts = flagPolygon({ x: pad, y: FLAG_W / 2 + pad }, 0)
    .map((v) => `${v.x},${v.y}`)
    .join(" ");
  return svgEl(
    "svg",
    {
      class: "signal-flag-chip-art",
      viewBox: `0 0 ${FLAG_LEN + 2 * pad} ${FLAG_W + 2 * pad}`,
      "aria-hidden": "true",
    },
    [svgEl("polygon", { class: "signal-flag-chip-poly", points: pts })],
  );
}

export class SignalRail {
  #doc;
  #root;
  #rows = new Map(); // signalId → { row, btn }
  #onPress;
  #onFlagPointerDown;
  #onContextMenu;
  #running = false;

  /**
   * @param {HTMLElement} viewport the `.desk-viewport` element
   * @param {object} doc the DeskDoc
   * @param {object} callbacks
   */
  constructor(
    viewport,
    doc,
    { onPress, onFlagPointerDown, onContextMenu } = {},
  ) {
    this.#doc = doc;
    this.#onPress = onPress;
    this.#onFlagPointerDown = onFlagPointerDown;
    this.#onContextMenu = onContextMenu;
    this.#root = el("div", { class: "signal-rail" });
    viewport.append(this.#root);

    window.addEventListener("chiphippo:doc-changed", () => this.render());
    window.addEventListener("chiphippo:sim-state", (e) =>
      this.#paint(e.detail),
    );
    this.render();
  }

  /** Rebuild every row from the document, in rail order. */
  render() {
    this.#root.replaceChildren();
    this.#rows.clear();
    for (const sig of railOrder(this.#doc.signals)) {
      const row = this.#buildRow(sig);
      this.#root.append(row.row);
      this.#rows.set(sig.id, row);
    }
  }

  /** Re-apply the language to every label (nothing else changes). */
  relocalize() {
    this.render();
  }

  #buildRow(sig) {
    const digit = signalDigit(this.#doc.signals, sig.id);
    const name = sig.name || sig.id;
    const chip = el(
      "div",
      {
        class: "signal-flag-chip",
        title: t("desk.signal.dragHint"),
        onpointerdown: (e) => this.#onFlagChipDown(sig.id, e),
      },
      [chipGlyph()],
    );

    const btn = el(
      "button",
      {
        type: "button",
        class: "signal-btn",
        // Description is the tooltip; the name is already on the face, so with
        // no description the digit is the useful thing left to say.
        title:
          sig.description ||
          (digit ? t("desk.signal.digitHint", { digit }) : name),
        "aria-label": t("desk.signal.press", { name }),
        "aria-pressed": "false",
        oncontextmenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.#onContextMenu?.(sig.id, e);
        },
      },
      [
        el("span", { class: "signal-btn-dot", "aria-hidden": "true" }),
        el("span", { class: "signal-btn-label", text: name }),
      ],
    );
    this.#bindPress(sig.id, btn);
    if (sig.type === "toggle") btn.classList.add("signal-btn--toggle");

    const row = el(
      "div",
      { class: "signal-rail-row", dataset: { signalId: sig.id } },
      [chip, btn],
    );
    row.style.setProperty("--signal-color", `var(--color-wire-${sig.color})`);
    if (sig.flag) row.classList.add("signal-rail-row--placed");
    return { row, btn };
  }

  /**
   * The press gesture. NOT a `beginPointerGesture`: there is no move stream and
   * nothing to resolve into world coordinates, and `#dragGestureActive` derives
   * "a drag is in flight" from a `drag…` kind name — this is not a desk gesture
   * at all. What it does need is a guaranteed release, hence all three legs.
   */
  #bindPress(id, btn) {
    const release = () => this.#onPress?.(id, false);
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      // DeskView only pans from the BARE viewport, so panning is safe already;
      // this is for DeskController's own viewport pointer dispatcher.
      e.stopPropagation();
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
    this.#root.remove();
    this.#rows.clear();
  }

  /** The rail element, for tests. */
  get element() {
    return this.#root;
  }
}
