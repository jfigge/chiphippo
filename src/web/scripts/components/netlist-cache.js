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

import { buildNetlist, isInductorBranch } from "../sim/netlist.js";
import { partDef } from "../catalog/index.js";

export class NetlistCache {
  #doc;
  #bridges;
  #partStates = new Map(); // componentId → transient state ({ pressed })
  #cached = null; // { netOfPoint, nets } or null when dirty
  #branched = null; // the same with inductors as branches (Spice Lite's)

  /**
   * @param {import('../model/desk-doc.js').DeskDoc} deskDoc
   * @param {{bridges?: boolean}} [options] `bridges: false` caches the
   *   WIRING-ONLY partition (every contact open, whatever its position) — the
   *   schematic's netlist, which must draw the input stage the build wired
   *   rather than redraw itself around whichever way a switch happens to sit.
   *   `scope`: where the changes are announced (the window; the simulation
   *   Worker's own scope there).
   */
  constructor(deskDoc, { bridges = true, scope = globalThis.window } = {}) {
    this.#doc = deskDoc;
    this.#bridges = bridges;
    scope.addEventListener("chiphippo:doc-changed", () => {
      this.#cached = null;
      this.#branched = null;
    });
    scope.addEventListener("chiphippo:part-state", (e) => {
      const { id, state } = e.detail ?? {};
      // Only a button's pressed flag is volatile; a switch's pos is in params.
      if (id && state && "pressed" in state) {
        this.#partStates.set(id, { pressed: state.pressed });
      }
      this.#cached = null;
      this.#branched = null;
    });
  }

  /** The current netlist, rebuilt if a change invalidated it — or, with
      `inductors: "branch"`, Spice Lite's, where an inductor with an
      inductance is a branch of its own (sim/netlist.js). On a desk with no
      such inductor the two are the same object. */
  get({ inductors = "wire" } = {}) {
    if (inductors === "branch") {
      if (!this.#branched) {
        const doc = this.#doc.toJSON();
        const any = (doc.components ?? []).some((c) => isInductorBranch(partDef(c.ref), c.params)); // prettier-ignore
        this.#branched = any
          ? buildNetlist(doc, this.#partStates, { bridges: this.#bridges, inductors }) // prettier-ignore
          : this.get();
      }
      return this.#branched;
    }
    if (!this.#cached) {
      this.#cached = buildNetlist(this.#doc.toJSON(), this.#partStates, {
        bridges: this.#bridges,
      });
    }
    return this.#cached;
  }

  /** The transient part states the netlist is built with (a held button),
      as `[id, state]` pairs — what another thread's cache needs to build
      the same one (components/sim-host.js). */
  partStates() {
    return [...this.#partStates];
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

  /**
   * The user name AT a point: the name of the WIRING net the point is on
   * (sim/netlist.js says why names never travel through a contact) — the
   * right question for anything pointing at one place, whichever partition
   * this cache holds.
   * @param {string} address
   */
  nameAt(address) {
    const nl = this.get();
    const netId = nl.wiringNetOfPoint?.get(address);
    return netId == null ? null : (nl.wiringNames?.get(netId) ?? null);
  }
}
