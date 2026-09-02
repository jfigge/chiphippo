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
// idiomatic SVG beats hand-rolled distance math. Eight arbitrary rotated
// pentagons is exactly that case.
//
// The flag carries NO TEXT, and that is a decision rather than an omission: at
// rot 90/270 the body is 2 pitch wide and 4 tall, with nowhere to put a
// horizontal name; the NAME lives on the button, and the flag's identity is its
// unique COLOUR, matched to that button's dot. So there is no world-space font
// size here and nothing printed on the circuit for i18n to reach.

import { svgEl } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { flagPolygon } from "../model/signals.js";
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

export class SignalLayer {
  #doc;
  #svg;
  #els = new Map(); // signalId → its <polygon>
  #selected = null;
  #onPointerDown;
  #onContextMenu;

  /**
   * @param {HTMLElement} layer the `.layer-signals` element
   * @param {object} doc the DeskDoc
   * @param {object} [callbacks]
   */
  constructor(layer, doc, { onPointerDown, onContextMenu } = {}) {
    this.#doc = doc;
    this.#onPointerDown = onPointerDown;
    this.#onContextMenu = onContextMenu;
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
      const points = flagPoints(
        this.#doc.boards,
        sig.flag.anchor,
        sig.flag.rot ?? 0,
      );
      if (points == null) continue; // an anchor over nothing draws nothing
      const poly = this.#buildFlag(sig.id, points);
      this.#svg.append(poly);
      this.#els.set(sig.id, poly);
    }
  }

  /** One flag's `<polygon>`, carrying its colour and its own listeners. */
  #buildFlag(id, points) {
    const sig = this.#doc.getSignal(id);
    if (!sig) return null;
    const poly = svgEl("polygon", {
      class: "signal-flag",
      points,
      "data-signal-id": id,
    });
    poly.style.setProperty("--signal-color", `var(--color-wire-${sig.color})`);
    if (id === this.#selected) poly.classList.add("signal-flag--selected");
    poly.addEventListener("pointerdown", (e) => this.#onPointerDown?.(id, e));
    poly.addEventListener("contextmenu", (e) => this.#onContextMenu?.(id, e));
    return poly;
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
    let poly = this.#els.get(id);
    if (!poly) {
      poly = this.#buildFlag(id, "");
      if (!poly) return;
      this.#svg.append(poly);
      this.#els.set(id, poly);
    }
    poly.setAttribute("points", pointsAt(at, rot));
    poly.classList.toggle("signal-flag--illegal", Boolean(illegal));
  }

  /** Put one flag back where the DOCUMENT has it (a reverted or ended drag). */
  clearPreview(id) {
    const sig = this.#doc.getSignal(id);
    const poly = this.#els.get(id);
    poly?.classList.remove("signal-flag--illegal");
    if (!sig?.flag?.anchor) {
      poly?.remove();
      this.#els.delete(id);
      return;
    }
    const points = flagPoints(
      this.#doc.boards,
      sig.flag.anchor,
      sig.flag.rot ?? 0,
    );
    if (points && poly) poly.setAttribute("points", points);
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
    for (const [sigId, poly] of this.#els) {
      poly.classList.toggle("signal-flag--selected", sigId === id);
    }
  }

  /** The currently highlighted flag's signal id, or null. */
  get selected() {
    return this.#selected;
  }
}
