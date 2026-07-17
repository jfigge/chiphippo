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

// desk-hud.js — dev-only debug overlay showing the camera (cx, cy, zoom) and
// the world coordinate under the cursor. Mounted only when the app runs under
// `make debug` / --dev (window.chiphippo.isDev); never in production.

export class DeskHud {
  #el;
  #camera;
  #cursor = null;

  /**
   * @param {HTMLElement} container - overlay parent (the `.desk-viewport`).
   * @param {import('./desk-view.js').DeskView} deskView
   */
  constructor(container, deskView) {
    this.#el = document.createElement("div");
    this.#el.className = "desk-hud";
    container.append(this.#el);

    container.addEventListener("pointermove", (e) => {
      this.#cursor = deskView.worldFromEvent(e);
      this.#render();
    });
    container.addEventListener("pointerleave", () => {
      this.#cursor = null;
      this.#render();
    });

    this.update(deskView.camera);
  }

  /** Mirror a camera change into the readout. */
  update(camera) {
    this.#camera = camera;
    this.#render();
  }

  #render() {
    const f = (n) => n.toFixed(1);
    const c = this.#camera;
    const cursor = this.#cursor
      ? `${f(this.#cursor.x)}, ${f(this.#cursor.y)}`
      : "—";
    this.#el.textContent =
      `center ${f(c.cx)}, ${f(c.cy)} · ` +
      `zoom ${Math.round(c.zoom * 100)}% · cursor ${cursor}`;
  }
}
