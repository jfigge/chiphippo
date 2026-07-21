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

// sim-overlay.js — the live-simulation face of the desk: it takes each
// `chiphippo:sim-state` snapshot and drives what the eye sees — LEDs lighting,
// chip health badges, clock pulse lamps — and answers "what level is this
// point at?" for the probe. It renders FROM published state and never queries
// the engine, exactly as the architecture requires.
//
// It shares the controller's live `doc` and `partViews` map by reference (both
// mutate as parts mount/unmount), owns the run-volatile net levels, and holds
// no DOM of its own — the part views it drives are the ones the controller
// already mounted.

import { partDef } from "../catalog/index.js";
import { partPinAddresses } from "../model/occupancy.js";
import { H, L } from "../sim/levels.js";

export class SimOverlay {
  #doc;
  #partViews; // componentId → view (shared, live)

  #running = false;
  #levels = new Map(); // netId → level
  #strong = new Map(); // netId → level from supplies/outputs only (no pulls)
  #netlist = null; // the netlist those levels are keyed against

  /**
   * @param {import("../model/desk-doc.js").DeskDoc} doc
   * @param {Map<string, object>} partViews  shared componentId → view map
   */
  constructor(doc, partViews) {
    this.#doc = doc;
    this.#partViews = partViews;
  }

  /** Is a simulation running? (Drives whether levels mean anything.) */
  get running() {
    return this.#running;
  }

  /**
   * Apply one published sim-state snapshot: refresh badges, clock lamps, and
   * LEDs from it. Everything here renders from the payload — nothing calls the
   * engine.
   */
  apply({
    running,
    netLevels,
    strongLevels,
    chipStatus,
    netlist,
    clockLevels,
  }) {
    this.#running = running;
    this.#levels = netLevels ?? new Map();
    this.#strong = strongLevels ?? new Map();
    this.#netlist = netlist ?? null;

    // Chip status badges (cleared when not running).
    for (const view of this.#partViews.values()) view.setStatus?.(null);
    if (running) {
      for (const [id, { status }] of chipStatus ?? new Map()) {
        this.#partViews.get(id)?.setStatus?.(status);
      }
    }

    // Clock pulse lamps track their live output level.
    for (const comp of this.#doc.components) {
      if (comp.kind !== "clock") continue;
      this.#partViews
        .get(comp.id)
        ?.setLevel?.(running && clockLevels?.get(comp.id) === H);
    }

    this.#updateLeds();
  }

  /** The level of a net by id, or "Z" when it isn't driven (running only). */
  levelOfNet(netId) {
    return this.#running ? (this.#levels.get(netId) ?? "Z") : null;
  }

  /** Level (H/L/Z/X) of the net a point sits in, from the last sim-state. */
  #levelAt(address) {
    if (!this.#netlist) return null;
    const netId = this.#netlist.netOfPoint.get(address);
    return netId ? (this.#levels.get(netId) ?? null) : null;
  }

  /** The level a point would sit at from supplies/chip outputs ALONE — i.e.
      ignoring resistor pulls. A point fed only through a resistor is not
      strongly driven, which is how an LED tells a safe path from a lethal one. */
  #strongLevelAt(address) {
    if (!this.#netlist) return null;
    const netId = this.#netlist.netOfPoint.get(address);
    return netId ? (this.#strong.get(netId) ?? null) : null;
  }

  /** An LED lights when its anode net is H and its cathode net is L. */
  #updateLeds() {
    const def = partDef("led");
    for (const comp of this.#doc.components) {
      if (comp.ref !== "led") continue;
      const view = this.#partViews.get(comp.id);
      if (!view?.setLit) continue;
      if (!this.#running) {
        view.setLit(false);
        view.setBurnt?.(false);
        continue;
      }
      const { anodePin, cathodePin } = def.polarity(comp.params);
      const pins = partPinAddresses(this.#doc, comp);
      if (!pins) continue; // a rotated LED with an unresolved far end
      const at = (pin) => pins.find((p) => p.pin === pin)?.address;
      const anodeAt = at(anodePin);
      const cathodeAt = at(cathodePin);
      // A floating leg conducts nothing — the LED stays dark but keeps its
      // place, exactly as a real one does when you pull its rail away.
      if (!anodeAt || !cathodeAt) {
        view.setLit(false);
        view.setBurnt?.(false);
        continue;
      }
      const conducting =
        this.#levelAt(anodeAt) === H && this.#levelAt(cathodeAt) === L;
      // No series resistor: an LED conducting between a STRONGLY driven supply
      // (rail or chip output) and a strongly grounded net has nothing limiting
      // it. Anything fed through a resistor is only weakly pulled, so its
      // strong level is not H/L — that's the safe case.
      const unlimited =
        conducting &&
        this.#strongLevelAt(anodeAt) === H &&
        this.#strongLevelAt(cathodeAt) === L;
      view.setBurnt?.(unlimited);
      view.setLit(conducting && !unlimited);
    }
  }
}
