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

import { ZOOM_MAX, ZOOM_MIN } from "../desk/desk-geometry.js";

const EPSILON = 1e-9;

export class ZoomControl {
  #outBtn;
  #readout;
  #inBtn;

  /**
   * @param {HTMLElement} container - overlay parent (the `.desk-viewport`).
   * @param {object} callbacks
   * @param {() => void} callbacks.onZoomIn
   * @param {() => void} callbacks.onZoomOut
   * @param {() => void} callbacks.onReset
   */
  constructor(container, { onZoomIn, onZoomOut, onReset }) {
    const cluster = document.createElement("div");
    cluster.className = "desk-zoom";

    this.#outBtn = this.#button("desk-zoom-btn", "−", "Zoom out");
    this.#outBtn.addEventListener("click", () => onZoomOut?.());

    this.#readout = this.#button(
      "desk-zoom-readout",
      "100%",
      "Reset zoom to 100%",
    );
    this.#readout.addEventListener("click", () => onReset?.());

    this.#inBtn = this.#button("desk-zoom-btn", "+", "Zoom in");
    this.#inBtn.addEventListener("click", () => onZoomIn?.());

    cluster.append(this.#outBtn, this.#readout, this.#inBtn);
    container.append(cluster);
  }

  /** Mirror the camera's zoom into the readout + button enablement. */
  setZoom(zoom) {
    this.#readout.textContent = `${Math.round(zoom * 100)}%`;
    this.#outBtn.disabled = zoom <= ZOOM_MIN + EPSILON;
    this.#inBtn.disabled = zoom >= ZOOM_MAX - EPSILON;
  }

  #button(className, text, label) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.textContent = text;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    return btn;
  }
}
