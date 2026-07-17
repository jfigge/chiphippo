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

// sim-controller.js — the renderer's run-state owner. It bridges the pure
// engine (sim/engine.js) to the UI: on Run it settles the circuit and
// re-settles on every input event (switch flip, button, PSU voltage change),
// warm-starting from the previous stable state; it publishes the result as a
// `chiphippo:sim-state` CustomEvent that every live view renders from (views
// never query the engine). It persists 12 V damage through desk-doc and
// routes short/conflict/oscillation/smoke warnings to the notification stack.
//
// Topology is FROZEN while running (the app locks editing tools); switch
// bridges are part state, not topology, so the netlist still rebuilds on them.

import { settle } from "../sim/engine.js";
import { NetlistCache } from "./netlist-cache.js";

export class SimController {
  #doc;
  #netlist;
  #notifications;
  #onRunStateChange;
  #running = false;
  #warm = new Map(); // previous stable net levels (warm start)
  #suppress = false; // ignore our own damage-persist writes

  /**
   * @param {object} opts
   * @param {import('../model/desk-doc.js').DeskDoc} opts.deskDoc
   * @param {import('./notification-stack.js').NotificationStack} [opts.notifications]
   * @param {(running: boolean) => void} [opts.onRunStateChange]
   */
  constructor({ deskDoc, notifications, onRunStateChange }) {
    this.#doc = deskDoc;
    this.#netlist = new NetlistCache(deskDoc);
    this.#notifications = notifications;
    this.#onRunStateChange = onRunStateChange;
    // While running, any topology/part-state change re-settles the circuit.
    window.addEventListener("chiphippo:part-state", this.#onInput);
    window.addEventListener("chiphippo:doc-changed", this.#onInput);
  }

  get running() {
    return this.#running;
  }

  /** Enter Run: cold-settle and lock editing. */
  start() {
    if (this.#running) return;
    this.#running = true;
    this.#warm = new Map();
    this.#onRunStateChange?.(true);
    this.settleNow();
  }

  /** Return to editing: clear live state, keep damage. */
  stop() {
    if (!this.#running) return;
    this.#running = false;
    this.#warm = new Map();
    this.#notifications?.clear();
    this.#onRunStateChange?.(false);
    this.#publish(null, null); // views clear from a not-running sim-state
  }

  toggle() {
    if (this.#running) this.stop();
    else this.start();
  }

  #onInput = () => {
    if (this.#running && !this.#suppress) this.settleNow();
  };

  /** Settle now and publish (also the test seam). */
  settleNow() {
    if (!this.#running) return;
    this.#suppress = true;
    try {
      const netlist = this.#netlist.get();
      const result = settle({
        document: this.#doc.toJSON(),
        netlist,
        warmStart: this.#warm,
      });
      this.#warm = result.netLevels;
      this.#persistDamage(result.chipStatus);
      this.#publish(result, netlist);
      this.#report(result.warnings);
    } finally {
      this.#suppress = false;
    }
  }

  /** Persist a 12 V kill into params.damaged (inert until "Replace chip"). */
  #persistDamage(chipStatus) {
    let changed = false;
    for (const [id, { status }] of chipStatus) {
      if (status !== "damaged") continue;
      if (this.#doc.getComponent(id)?.params?.damaged === true) continue;
      this.#doc.setComponentParams(id, { damaged: true });
      changed = true;
    }
    // Autosave + view refresh — suppressed so it doesn't re-enter settle.
    if (changed) {
      window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
    }
  }

  #publish(result, netlist) {
    window.dispatchEvent(
      new CustomEvent("chiphippo:sim-state", {
        detail: {
          running: this.#running,
          netLevels: result?.netLevels ?? new Map(),
          chipStatus: result?.chipStatus ?? new Map(),
          warnings: result?.warnings ?? [],
          netlist: netlist ?? null,
        },
      }),
    );
  }

  #refName(id) {
    const comp = this.#doc.getComponent(id);
    return comp ? `${comp.ref} (${id})` : id;
  }

  #report(warnings) {
    if (!this.#notifications) return;
    for (const w of warnings) {
      if (w.type === "short") {
        this.#notifications.notify({
          key: `short:${w.net}`,
          variant: "danger",
          title: "Short circuit",
          message: `Opposing supplies meet on one net (${w.net}).`,
        });
      } else if (w.type === "conflict") {
        this.#notifications.notify({
          key: `conflict:${w.net}`,
          variant: "warning",
          title: "Driver conflict",
          message: `Two outputs are fighting on one net (${w.net}).`,
        });
      } else if (w.type === "oscillation") {
        this.#notifications.notify({
          key: "oscillation",
          variant: "warning",
          title: "Oscillation",
          message: `The circuit won't settle (${w.nets.length} unstable nets).`,
        });
      } else if (w.type === "underpowered") {
        this.#notifications.notify({
          key: `under:${w.chip}`,
          variant: "warning",
          title: "Underpowered",
          message: `${this.#refName(w.chip)} is at 3 V — running inert.`,
        });
      } else if (w.type === "damaged") {
        this.#notifications.notify({
          key: `smoke:${w.chip}`,
          variant: "danger",
          title: "Magic smoke!",
          message: `${this.#refName(w.chip)} was damaged by 12 V. Replace it to continue.`,
        });
      }
    }
  }

  /** Reset a damaged chip (context-menu "Replace chip"). */
  replaceChip(id) {
    this.#doc.setComponentParams(id, { damaged: false });
    window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  }
}
