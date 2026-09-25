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

// signal-layer.js — the planted signal FLAGS on the desk (Feature 370).
//
// One `<polygon>` per planted flag, apex in its anchor hole, drawn in the
// signal's own colour. The layer sits ABOVE wires and annotations (a flag is
// hardware plugged into the board, drawn over the jumper running past it) and
// BELOW the overlay, which owns ghosts, rings and the drag preview.
//
// The polygon IS the hit target — the sanctioned per-item event exception
// (beside the wire hit stroke, `.part-span-hit` and `.part-button-cap`), where
// idiomatic SVG beats hand-rolled distance math. Ten arbitrary rotated
// pentagons is exactly that case.
//
// The flag carries ONE CHARACTER: the digit KEY that presses it (`1`–`9`, `0`),
// on the same coloured disc its rail button shows it on. Colours cycle and
// repeat, so the key is what ties a flag to its button. It is a single UPRIGHT
// glyph, deliberately — at rot 90/270 the body is 2 pitch wide and 4 tall, with
// nowhere for a horizontal name (the NAME lives on the button), but one
// character fits the body at every angle. A digit is not a word, so there is
// nothing here for i18n to reach. The disc + digit group sits BESIDE the
// polygon, pointer-inert, so the polygon stays the one hit target and the one
// node carrying the signal's id.

import { svgEl } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import {
  FLAG_KEY_R,
  flagKeyPoint,
  flagPolygon,
  signalKey,
} from "../model/signals.js";
import { worldOfAddress } from "../model/occupancy.js";

/** The polygon `points` attribute for a flag whose apex is at a world point. */
export function pointsAt(at, rot) {
  return flagPolygon(at, rot)
    .map((v) => `${v.x * PX_PER_UNIT},${v.y * PX_PER_UNIT}`)
    .join(" ");
}

/** The same, for a flag planted at an ADDRESS. Null when it resolves nowhere. */
export function flagPoints(boards, anchor, rot) {
  const at = worldOfAddress(boards, anchor);
  return at ? pointsAt(at, rot) : null;
}

/** Put a flag's key (disc + digit) where its body is, for a flag whose apex
    is `at`. One translate on the group, so the two cannot come apart. */
function placeKey(key, at, rot) {
  const p = flagKeyPoint(at, rot);
  key.setAttribute(
    "transform",
    `translate(${p.x * PX_PER_UNIT} ${p.y * PX_PER_UNIT})`,
  );
}

export class SignalLayer {
  #doc;
  #svg;
  #els = new Map(); // signalId → { poly: its <polygon>, key: its key <g> }
  #selected = null;
  #onPointerDown;
  #onContextMenu;
  #onSelect;

  /**
   * @param {HTMLElement} layer the `.layer-signals` element
   * @param {object} doc the DeskDoc
   * @param {object} [callbacks] `onSelect(id|null)` hears every change of the
   *   highlighted flag — the rail lights the matching button from it
   */
  constructor(layer, doc, { onPointerDown, onContextMenu, onSelect } = {}) {
    this.#doc = doc;
    this.#onPointerDown = onPointerDown;
    this.#onContextMenu = onContextMenu;
    this.#onSelect = onSelect;
    // A zero-size <svg> renders NOTHING per spec — hence the token 1×1 box
    // plus overflow: visible, the same zero-size-anchor rule the wire layer
    // and every surface layer follow.
    this.#svg = svgEl("svg", { class: "signal-svg", width: 1, height: 1 });
    layer.append(this.#svg);
    window.addEventListener("chiphippo:doc-changed", () => this.render());
    this.render();
  }

  /**
   * Rebuild every planted flag from the document.
   *
   * A live drag does NOT come through here — see `setPreview`. Rebuilding
   * mid-gesture would destroy the very `<polygon>` the press captured, and it
   * would do so on every pointermove.
   */
  render() {
    this.#svg.replaceChildren();
    this.#els.clear();
    for (const sig of this.#doc.signals) {
      if (!sig.flag?.anchor) continue;
      const at = worldOfAddress(this.#doc.boards, sig.flag.anchor);
      if (at == null) continue; // an anchor over nothing draws nothing
      const entry = this.#buildFlag(sig.id);
      if (!entry) continue;
      this.#moveTo(entry, at, sig.flag.rot ?? 0);
      this.#svg.append(entry.poly, entry.key);
      this.#els.set(sig.id, entry);
    }
  }

  /**
   * One flag: its `<polygon>`, carrying its colour and its own listeners, and
   * the `<g>` printing its key — a translucent disc in the signal's colour with
   * the digit on it. Unpositioned — `#moveTo` places both.
   */
  #buildFlag(id) {
    const sig = this.#doc.getSignal(id);
    if (!sig) return null;
    const color = `var(--color-wire-${sig.color})`;
    const poly = svgEl("polygon", {
      class: "signal-flag",
      points: "",
      "data-signal-id": id,
    });
    poly.style.setProperty("--signal-color", color);
    if (id === this.#selected) poly.classList.add("signal-flag--selected");
    poly.addEventListener("pointerdown", (e) => this.#onPointerDown?.(id, e));
    poly.addEventListener("contextmenu", (e) => this.#onContextMenu?.(id, e));
    const digit = svgEl("text", { class: "signal-flag-key-digit" });
    digit.textContent = signalKey(this.#doc.signals, id) ?? "";
    const key = svgEl(
      "g",
      { class: "signal-flag-key", "aria-hidden": "true" },
      [
        svgEl("circle", {
          class: "signal-flag-key-disc",
          r: FLAG_KEY_R * PX_PER_UNIT,
        }),
        digit,
      ],
    );
    key.style.setProperty("--signal-color", color);
    return { poly, key };
  }

  /** Draw one flag (polygon AND key) with its apex at a world point. */
  #moveTo(entry, at, rot) {
    entry.poly.setAttribute("points", pointsAt(at, rot));
    placeKey(entry.key, at, rot);
  }

  /**
   * Live-redraw ONE flag at a WORLD POINT the document does not hold yet — the
   * drag preview. It sets the polygon's `points` IN PLACE (the annotation
   * layer's `setPosition` shape), so the node the gesture captured survives the
   * whole drag.
   *
   * A free world point rather than an address, because the flag has to follow
   * the cursor across bare desk too — snapping only when there is a hole to
   * snap to. `illegal` tints it instead of hiding it: a drag that vanished, or
   * jumped home, whenever it left a target read as the app losing the grab.
   *
   * An unplaced signal has no polygon yet, so a drag off the rail MINTS one and
   * the commit (or `clearPreview`) disposes of it.
   */
  setPreview(id, { at, rot = 0, illegal = false }) {
    if (!at) {
      this.clearPreview(id);
      return;
    }
    let entry = this.#els.get(id);
    if (!entry) {
      entry = this.#buildFlag(id);
      if (!entry) return;
      this.#svg.append(entry.poly, entry.key);
      this.#els.set(id, entry);
    }
    this.#moveTo(entry, at, rot);
    entry.poly.classList.toggle("signal-flag--illegal", Boolean(illegal));
  }

  /** Put one flag back where the DOCUMENT has it (a reverted or ended drag). */
  clearPreview(id) {
    const sig = this.#doc.getSignal(id);
    const entry = this.#els.get(id);
    entry?.poly.classList.remove("signal-flag--illegal");
    if (!sig?.flag?.anchor) {
      entry?.poly.remove();
      entry?.key.remove();
      this.#els.delete(id);
      return;
    }
    const at = worldOfAddress(this.#doc.boards, sig.flag.anchor);
    if (at && entry) this.#moveTo(entry, at, sig.flag.rot ?? 0);
    else this.render();
  }

  /**
   * Highlight one flag (or none) — a CLASS TOGGLE, never a re-render.
   *
   * Load-bearing: the flag drag calls `selectSignal` on the press, before it
   * begins the pointer gesture. Rebuilding here would destroy the very
   * `<polygon>` that press is about to capture, leaving the gesture holding a
   * detached node. (The annotation layer's setSelected has always worked this
   * way, for the same reason.)
   */
  setSelected(id) {
    if (this.#selected === id) return;
    this.#selected = id;
    for (const [sigId, { poly }] of this.#els) {
      poly.classList.toggle("signal-flag--selected", sigId === id);
    }
    this.#onSelect?.(id);
  }

  /** The currently highlighted flag's signal id, or null. */
  get selected() {
    return this.#selected;
  }
}
