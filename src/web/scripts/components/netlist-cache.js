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

// netlist-cache.js — a lazily-rebuilt netlist for the renderer. The netlist
// is a FULL rebuild on every topology change (union-find is sub-millisecond
// at this app's scale; incremental updates are complexity with no payoff),
// so this just memoizes it and invalidates on the two events that can change
// connectivity:
//   • chiphippo:doc-changed — boards/parts/wires/switch-position edits (a
//     slide switch's `pos` is persisted, so a flip rides this)
//   • chiphippo:part-state  — a button pressed/released (transient view state
//     with no durable param)
// It also tracks transient part state (a held button) so a pressed button
// bridges in the netlist even though nothing durable is stored for it.

import { buildNetlist } from "../sim/netlist.js";

export class NetlistCache {
  #doc;
  #partStates = new Map(); // componentId → transient state ({ pressed })
  #cached = null; // { netOfPoint, nets } or null when dirty

  /** @param {import('../model/desk-doc.js').DeskDoc} deskDoc */
  constructor(deskDoc) {
    this.#doc = deskDoc;
    window.addEventListener("chiphippo:doc-changed", () => {
      this.#cached = null;
    });
    window.addEventListener("chiphippo:part-state", (e) => {
      const { id, state } = e.detail ?? {};
      // Only a button's pressed flag is volatile; a switch's pos is in params.
      if (id && state && "pressed" in state) {
        this.#partStates.set(id, { pressed: state.pressed });
      }
      this.#cached = null;
    });
  }

  /** The current netlist, rebuilt if a change invalidated it. */
  get() {
    if (!this.#cached) {
      this.#cached = buildNetlist(this.#doc.toJSON(), this.#partStates);
    }
    return this.#cached;
  }

  /** The net id containing an address (hole or terminal), or null. */
  netOf(address) {
    return this.get().netOfPoint.get(address) ?? null;
  }

  /** The NetInfo for a net id, or null. */
  netInfo(netId) {
    return this.get().nets.get(netId) ?? null;
  }

  /** The user name bound to a net id (Feature 120), or null. */
  nameOf(netId) {
    return this.get().names?.get(netId) ?? null;
  }
}
