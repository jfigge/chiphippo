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

// zoom-control.js — the desk's bottom-right zoom cluster: −, a percentage
// readout that clicks back to 100%, and +. Pure chrome: it reports intents to
// its creator via constructor callbacks and mirrors state via setZoom().

import { t } from "../i18n.js";
import { ZOOM_MAX, ZOOM_MIN } from "../desk/desk-geometry.js";

const EPSILON = 1e-9;

export class ZoomControl {
  #outBtn;
  #readout;
  #inBtn;

  /**
   * @param {HTMLElement} container - overlay parent (the `.desk-viewport`).
   * @param {object} callbacks
   * @param {(opts?: {fine: boolean}) => void} callbacks.onZoomIn
   * @param {(opts?: {fine: boolean}) => void} callbacks.onZoomOut
   * @param {() => void} callbacks.onReset
   */
  constructor(container, { onZoomIn, onZoomOut, onReset }) {
    const cluster = document.createElement("div");
    cluster.className = "desk-zoom";

    // The three GLYPHS (− / % / +) are the same in every language; only the
    // labels behind them are translated, which `relocalize()` re-applies.
    //
    // OPTION is the FINE step (one percentage point) — reported as a plain
    // option so the cluster still hands its creator an intent, never a DOM
    // event. It is deliberately silent: the labels say nothing about it.
    //
    // SHIFT CANNOT BE THE MODIFIER HERE, however conventional it is for a fine
    // adjustment. This cluster sits INSIDE `.desk-viewport`, and the desk's own
    // `#onViewportPointerDown` rubber-bands a marquee on any shift-press there
    // without looking at the target — it captures the pointer on the viewport,
    // so the release retargets and no `click` is ever generated. A shift-click
    // on these buttons delivers a `pointerdown` and nothing else. Option is
    // also already the app's "this gesture takes something different with it"
    // modifier (the torn-off board run, the wiring that rides a part).
    this.#outBtn = this.#button("desk-zoom-btn", "−", "zoom.out");
    this.#outBtn.addEventListener("click", (e) =>
      onZoomOut?.({ fine: e.altKey }),
    );

    this.#readout = this.#button("desk-zoom-readout", "100%", "zoom.reset");
    this.#readout.addEventListener("click", () => onReset?.());

    this.#inBtn = this.#button("desk-zoom-btn", "+", "zoom.in");
    this.#inBtn.addEventListener("click", (e) =>
      onZoomIn?.({ fine: e.altKey }),
    );

    cluster.append(this.#outBtn, this.#readout, this.#inBtn);
    container.append(cluster);
  }

  /** Mirror the camera's zoom into the readout + button enablement. */
  setZoom(zoom) {
    this.#readout.textContent = `${Math.round(zoom * 100)}%`;
    this.#outBtn.disabled = zoom <= ZOOM_MIN + EPSILON;
    this.#inBtn.disabled = zoom >= ZOOM_MAX - EPSILON;
  }

  /** Re-apply the button labels after a language change (see app.js). */
  relocalize() {
    for (const btn of [this.#outBtn, this.#readout, this.#inBtn]) {
      const label = t(btn.dataset.labelKey);
      btn.title = label;
      btn.setAttribute("aria-label", label);
    }
  }

  /**
   * @param {string} className
   * @param {string} text     the glyph (untranslated)
   * @param {string} labelKey the catalog key for its title/aria-label, KEPT on
   *   the element so `relocalize()` can resolve it again in the new language.
   */
  #button(className, text, labelKey) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.textContent = text;
    btn.dataset.labelKey = labelKey;
    btn.title = t(labelKey);
    btn.setAttribute("aria-label", t(labelKey));
    return btn;
  }
}
