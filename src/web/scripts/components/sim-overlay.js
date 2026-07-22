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
  #displays = new Map(); // compId → LCD framebuffer (from the sim-state payload)

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
    displayState,
  }) {
    this.#running = running;
    this.#levels = netLevels ?? new Map();
    this.#strong = strongLevels ?? new Map();
    this.#netlist = netlist ?? null;
    this.#displays = displayState ?? new Map();

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
    this.#updateDisplays();
    this.#updateLcds();
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

  /**
   * The lit / over-driven state of ONE LED junction between two point
   * addresses — shared by single LEDs and every segment of a display.
   *
   * A junction conducts when its anode net is H and its cathode net is L. With
   * no series resistor it's "unlimited": conducting between a STRONGLY driven
   * supply (rail or chip output) and a strongly grounded net has nothing
   * limiting it. Anything fed through a resistor is only weakly pulled, so its
   * strong level is not H/L — the safe case. A floating leg (null address)
   * conducts nothing, exactly as a real one does when you pull its rail away.
   */
  #junctionState(anodeAt, cathodeAt) {
    if (!anodeAt || !cathodeAt) return { conducting: false, unlimited: false };
    const conducting =
      this.#levelAt(anodeAt) === H && this.#levelAt(cathodeAt) === L;
    const unlimited =
      conducting &&
      this.#strongLevelAt(anodeAt) === H &&
      this.#strongLevelAt(cathodeAt) === L;
    return { conducting, unlimited };
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
      const { conducting, unlimited } = this.#junctionState(
        at(anodePin),
        at(cathodePin),
      );
      view.setBurnt?.(unlimited);
      view.setLit(conducting && !unlimited);
    }
  }

  /**
   * Multi-segment displays (seg8 / bar8): each segment is an LED between its
   * anode pin and the shared cathode. Light every segment with the same rule
   * the single LED uses; a segment with no current limit burns (per segment),
   * and the whole block gets the burn cue if any does.
   */
  #updateDisplays() {
    for (const comp of this.#doc.components) {
      const def = partDef(comp.ref);
      if (!def?.segments) continue;
      const view = this.#partViews.get(comp.id);
      if (!view?.setSegmentLit) continue;
      if (!this.#running) {
        view.setBurnt?.(false);
        for (const seg of def.segments) {
          view.setSegmentLit(seg.id, false);
          view.setSegmentBurnt?.(seg.id, false);
        }
        continue;
      }
      const pins = partPinAddresses(this.#doc, comp);
      const at = (pin) => pins?.find((p) => p.pin === pin)?.address;
      let anyBurnt = false;
      for (const seg of def.segments) {
        const { conducting, unlimited } = this.#junctionState(
          at(seg.anodePin),
          at(seg.cathodePin),
        );
        view.setSegmentLit(seg.id, conducting && !unlimited);
        view.setSegmentBurnt?.(seg.id, unlimited);
        if (unlimited) anyBurnt = true;
      }
      view.setBurnt?.(anyBurnt);
    }
  }

  /**
   * Character-LCD modules paint the framebuffer the SimController derived from
   * the engine state (chars + cursor). Not running → blank the screen. Unlike
   * the LED rule, this reads no net levels — the display is the chip's OWN
   * output, carried in the payload.
   */
  #updateLcds() {
    for (const comp of this.#doc.components) {
      if (comp.kind !== "lcd") continue;
      const view = this.#partViews.get(comp.id);
      if (!view?.renderFramebuffer) continue;
      view.renderFramebuffer(
        this.#running ? (this.#displays.get(comp.id) ?? null) : null,
      );
    }
  }
}
