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

// integration-lamps.js — the Arduino serial integration's activity lamps:
// TX (an Output sent to a board), RX (an Input received from one) and LG (log
// text). One pill the zoom cluster's shape, fixed immediately to its LEFT in
// the desk viewport's bottom-right corner — not movable, not hideable.
//
// Shown only while a run is using the serial link (`setActive`), and only
// when the desk has an Output or Input to begin with — the run cannot be
// using the link otherwise. Aggregated across every element and connection.
//
// A lamp FLASHES: each report lights it for a moment, and a burst keeps it
// lit. Only DATA is reported here — acknowledgements, NAKs and retries never
// reach the renderer — so a lamp is an honest indicator: with the clock
// paused, a flickering TX/RX means the circuit and the sketch are feeding each
// other.
//
// Clicking the pill — any of its three lamps — opens a CONNECTION WINDOW:
// directly when the run uses one connection, through a small menu of them
// when it uses several. The window is where the detail the lamps deliberately
// leave out lives.

import { el } from "../dom.js";
import { t } from "../i18n.js";

/** How long one report keeps a lamp lit (ms). Long enough to see at 60 Hz. */
const FLASH_MS = 120;

const LAMPS = Object.freeze(["tx", "rx", "lg"]);

export class IntegrationLamps {
  #root;
  #lamps = new Map(); // kind → element
  #timers = new Map(); // kind → timeout
  #onOpen;

  /**
   * @param {HTMLElement} viewport the `.desk-viewport`
   * @param {{onOpen: (anchor: DOMRect) => void}} callbacks
   */
  constructor(viewport, { onOpen } = {}) {
    this.#onOpen = onOpen;
    this.#root = el("div", {
      class: "integration-lamps",
      role: "group",
      hidden: true,
    });
    for (const kind of LAMPS) {
      const lamp = el(
        "button",
        {
          class: `integration-lamp integration-lamp--${kind}`,
          type: "button",
          onClick: () => this.#onOpen?.(this.#root.getBoundingClientRect()),
        },
        [
          el("span", { class: "integration-lamp-led", "aria-hidden": "true" }),
          el("span", {
            class: "integration-lamp-label",
            text: kind.toUpperCase(),
          }),
        ],
      );
      this.#lamps.set(kind, lamp);
      this.#root.append(lamp);
    }
    this.relocalize();
    viewport.append(this.#root);
  }

  /** Show or hide the pill (a run using the serial link, or not). */
  setActive(on) {
    this.#root.hidden = !on;
    if (!on) for (const kind of LAMPS) this.#off(kind);
  }

  get active() {
    return !this.#root.hidden;
  }

  /** Light one lamp for a moment. */
  flash(kind) {
    const lamp = this.#lamps.get(kind);
    if (!lamp || this.#root.hidden) return;
    lamp.classList.add("integration-lamp--on");
    clearTimeout(this.#timers.get(kind));
    this.#timers.set(
      kind,
      setTimeout(() => this.#off(kind), FLASH_MS),
    );
  }

  #off(kind) {
    clearTimeout(this.#timers.get(kind));
    this.#timers.delete(kind);
    this.#lamps.get(kind)?.classList.remove("integration-lamp--on");
  }

  /** Re-apply the labels' tooltips in the current language. */
  relocalize() {
    this.#root.setAttribute("aria-label", t("integration.lamps.label"));
    const open = t("integration.lamps.open");
    for (const [kind, lamp] of this.#lamps) {
      // Two lines, so no language's punctuation has to join them.
      const title = `${t(`integration.lamps.${kind}`)}\n${open}`;
      lamp.title = title;
      lamp.setAttribute("aria-label", title);
    }
  }

  get element() {
    return this.#root;
  }
}
