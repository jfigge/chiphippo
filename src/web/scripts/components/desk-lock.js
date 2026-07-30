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

// desk-lock.js — the padlock in the desk's top-right corner: click it shut and
// the mouse WHEEL stops moving the desk; click it open and the wheel pans again.
//
// It exists for a hardware reason rather than a design one. A Magic Mouse's
// touch surface reports a scroll from the lightest brush of a finger — including
// one that was only resting there while clicking — so a desk laid out carefully
// can slide out from under you between one placement and the next. Shutting the
// padlock takes that one twitchy input out of the picture and leaves every
// DELIBERATE way of moving the desk working: drag-to-pan, the zoom cluster, the
// keyboard, Fit. So it locks an INPUT, not the camera.
//
// Pure chrome, like the zoom cluster it shares a viewport with: it owns the
// button and its two icons, reports through a constructor callback, and knows
// nothing about the camera or about what the wheel would have done.

import { t } from "../i18n.js";

/** Feather's `lock` / `unlock` — one shackle-and-body pair, two shackles. The
    open one is drawn genuinely open (its shackle stops short on the right and
    lifts away), so the two states differ in silhouette and not merely in tint:
    at 20 px on a busy desk, a colour change alone is not a state. */
const BODY = '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>';
const SHACKLE_SHUT = '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>';
const SHACKLE_OPEN = '<path d="M7 11V7a5 5 0 0 1 9.9-1"/>';

const icon = (shackle) =>
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" ' +
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  BODY +
  shackle +
  "</svg>";

export class DeskLock {
  #button;
  #locked = false;
  #onChange;
  #mod;

  /**
   * @param {HTMLElement} container - overlay parent (the `.desk-viewport`).
   * @param {object} [opts]
   * @param {(locked: boolean) => void} [opts.onChange] - fired on every TOGGLE
   *   with the NEW state; not fired by `setLocked`, which is the mirror.
   * @param {string} [opts.mod] - the platform's modifier glyph (⌘ / Ctrl), for
   *   the accelerator in the label. app.js owns the shortcut, so it names it.
   */
  constructor(container, { onChange, mod } = {}) {
    this.#onChange = onChange;
    this.#mod = mod ?? "";
    this.#button = document.createElement("button");
    this.#button.className = "desk-lock";
    this.#button.type = "button";
    this.#button.addEventListener("click", () => this.toggle());
    // OPEN to begin with, every session: a lock that remembered itself would
    // greet a new session with a desk that ignores the wheel and no memory of
    // having been told to.
    this.#render();
    container.append(this.#button);
  }

  /** @returns {boolean} true when the wheel is locked out. */
  get locked() {
    return this.#locked;
  }

  /**
   * Flip it, and report — the ONE path both the click and the keyboard take, so
   * the key and the button can never disagree about the state or about who was
   * told about it.
   * @returns {boolean} the new state.
   */
  toggle() {
    this.setLocked(!this.#locked);
    this.#onChange?.(this.#locked);
    return this.#locked;
  }

  /** Set the state without reporting it — the mirror half of the callback. */
  setLocked(on) {
    this.#locked = on === true;
    this.#render();
  }

  /** Re-apply the label after a language change (app.js's relabelChrome). */
  relocalize() {
    this.#render();
  }

  /** The icon says which state it IS; the label says what a click would DO,
      which is the pair a toggle needs to be readable without being clicked. */
  #render() {
    this.#button.innerHTML = icon(this.#locked ? SHACKLE_SHUT : SHACKLE_OPEN);
    this.#button.classList.toggle("desk-lock--locked", this.#locked);
    this.#button.setAttribute("aria-pressed", String(this.#locked));
    const key = this.#locked ? "desk.unlockWheel" : "desk.lockWheel";
    const label = t(key, { mod: this.#mod });
    this.#button.title = label;
    this.#button.setAttribute("aria-label", label);
  }
}
