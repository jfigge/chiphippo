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

// ac-wiring-monitor.js — warns the moment a wire puts an AC source straight
// onto a logic input (model/ac-wiring.js), before anything runs: a toast per
// input, said once while the connection stands and again if it is made anew.
// Under Spice Lite the same input then lets its smoke out when run (spice/
// params.js TTL_CLAMP / CMOS_CLAMP) — this is the warning that comes first.
// Reads the ONE shared NetlistCache, as the net-name monitor does, and only on
// a desk with an AC source on it.

import { t } from "../i18n.js";
import { acIntoLogicInputs, hasAcSource } from "../model/ac-wiring.js";

export class AcWiringMonitor {
  #netlist;
  #notifications;
  #docOf;
  #nameOf;
  /** The connections said, by key, so a standing one is not said again. */
  #said = new Set();

  /**
   * @param {import('./netlist-cache.js').NetlistCache} netlistCache
   * @param {import('./notification-stack.js').NotificationStack} notifications
   * @param {() => object} docOf - the desk's document now
   * @param {(id: string) => string} [nameOf] - a part as a sentence names it
   */
  constructor(netlistCache, notifications, docOf, nameOf = (id) => id) {
    this.#netlist = netlistCache;
    this.#notifications = notifications;
    this.#docOf = docOf;
    this.#nameOf = nameOf;
    window.addEventListener("chiphippo:doc-changed", () => this.check());
    window.addEventListener("chiphippo:part-state", () => this.check());
    // A desk loaded with one already wired is not news: what it holds is
    // baselined, and only a connection MADE after is said.
    window.addEventListener("chiphippo:desk-loaded", () => this.check(true));
  }

  /** Say each new connection of an AC source straight onto a logic input;
      forget the ones gone, so making one again says it again. With
      `quiet`, note what stands without a word. */
  check(quiet = false) {
    const doc = this.#docOf();
    if (!hasAcSource(doc)) {
      this.#said.clear();
      return;
    }
    const now = new Set();
    for (const hit of acIntoLogicInputs(doc, this.#netlist.get())) {
      const key = `ac-input:${hit.source}:${hit.chip}:${hit.pin}`;
      now.add(key);
      if (quiet || this.#said.has(key)) continue;
      this.#notifications.notify({
        key,
        variant: "warning",
        title: t("desk.acInput.title"),
        message: t("desk.acInput.message", {
          source: this.#nameOf(hit.source),
          chip: this.#nameOf(hit.chip),
          pin: hit.pin,
        }),
      });
    }
    this.#said = now;
  }
}
