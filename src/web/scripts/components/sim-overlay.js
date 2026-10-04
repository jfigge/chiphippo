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
import { CHIP_STATUS } from "../sim/engine.js";
import { isLit, junctionState } from "../sim/junction.js";
import { H } from "../sim/levels.js";

export class SimOverlay {
  #doc;
  #partViews; // componentId → view (shared, live)

  #running = false;
  #status = new Map(); // compId → { status } (the last badge set; empty when stopped)
  #levels = new Map(); // netId → level
  #strong = new Map(); // netId → level from supplies/outputs only (no pulls)
  #netlist = null; // the netlist those levels are keyed against
  #displays = new Map(); // compId → LCD framebuffer (from the sim-state payload)
  #timing = new Map(); // compId → a timed part's reading of its R and C
  #channels = new Map(); // compId → a channel part's channels (engine `channels`)
  #pinCache = new Map(); // compId → partPinAddresses (cleared on a topology change)

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
    pausedClocks,
    displayState,
    timing,
    channels,
  }) {
    this.#running = running;
    this.#levels = netLevels ?? new Map();
    this.#strong = strongLevels ?? new Map();
    // Pin addresses derive from the doc geometry, which changes only when the
    // topology does — and a topology change (doc-changed OR part-state) rebuilds
    // the netlist, so a new netlist reference is exactly the signal to drop the
    // per-part pin-address cache. Pure clock ticks reuse the same netlist, so
    // the cache holds across them (no getBoundingClientRect-free geometry rerun
    // per LED/segment every tick).
    if (netlist !== this.#netlist) this.#pinCache.clear();
    this.#netlist = netlist ?? null;
    this.#displays = displayState ?? new Map();

    // Chip status badges (cleared when not running). The map is KEPT as well as
    // applied: statusOf() answers "what fault is this part showing?" for the
    // Properties dialog, which has a component id and no view.
    this.#status = running ? (chipStatus ?? new Map()) : new Map();
    for (const view of this.#partViews.values()) view.setStatus?.(null);
    for (const [id, { status, volts }] of this.#status) {
      this.#partViews.get(id)?.setStatus?.(status, volts);
    }

    // Each timed part's readout and wiring verdict (sim/timing.js) — cleared
    // with everything else when the run stops.
    this.#timing = running ? (timing ?? new Map()) : new Map();
    for (const [id, view] of this.#partViews) {
      view.setTiming?.(this.#timing.get(id) ?? null);
    }

    // Clock pulse lamps track their live output level, and each clock's
    // pause button whether that clock is held on its own.
    for (const comp of this.#doc.components) {
      if (comp.kind !== "clock") continue;
      const view = this.#partViews.get(comp.id);
      view?.setLevel?.(running && clockLevels?.get(comp.id) === H);
      view?.setPaused?.(running && pausedClocks?.has(comp.id) === true);
    }

    // Each transistor's channel: whether it conducts, and whether a MOSFET
    // is holding its last state (its lamp, and its hover).
    this.#channels = running ? (channels ?? new Map()) : new Map();
    for (const comp of this.#doc.components) {
      if (!partDef(comp.ref)?.transistor) continue;
      this.#partViews
        .get(comp.id)
        ?.setChannel?.(this.#channels.get(comp.id)?.[0] ?? null);
    }

    this.#updateLeds();
    this.#updateDiodes();
    this.#updateDisplays();
    this.#updateLcds();
  }

  /** A transistor's channel on the last sim-state — `{on, held}` — or null
      (stopped, or not a transistor). The Properties card's "holding" line. */
  channelOf(id) {
    return this.#channels.get(id)?.[0] ?? null;
  }

  /**
   * The fault one part's badge is drawing — the engine's last power/health
   * status for it — or null when the sim is stopped or the part is healthy.
   * Keyed by component id rather than by view because the reader (the
   * Properties dialog's warnings section) has an id and nothing mounted.
   */
  statusOf(id) {
    const status = this.#status.get(id)?.status;
    return status && status !== CHIP_STATUS.OK ? status : null;
  }

  /** A timed part's reading of its own R and C on the last sim-state, or
      null (stopped, or not a timed part). */
  timingOf(id) {
    return this.#timing.get(id) ?? null;
  }

  /** The supply voltage that part's VCC pin saw on the last sim-state — the
      number its underpowered/damaged sentence states — or null. */
  voltsOf(id) {
    return this.#status.get(id)?.volts ?? null;
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
   * The rule itself is physics, not rendering, so it lives in the model
   * (sim/junction.js); this only resolves the two addresses into the four
   * levels that rule asks for. A leg with no address conducts nothing.
   */
  #junctionState(anodeAt, cathodeAt) {
    if (!anodeAt || !cathodeAt) return { conducting: false, unlimited: false };
    return junctionState({
      anode: this.#levelAt(anodeAt),
      cathode: this.#levelAt(cathodeAt),
      anodeStrong: this.#strongLevelAt(anodeAt),
      cathodeStrong: this.#strongLevelAt(cathodeAt),
    });
  }

  /**
   * The resolved pin addresses of a part, memoised for the life of one netlist
   * (topology). partPinAddresses walks the footprint/anchor geometry, so caching
   * it keeps a running sim from recomputing every LED/segment's holes each tick.
   */
  #pinsFor(comp) {
    let pins = this.#pinCache.get(comp.id);
    if (pins === undefined) {
      pins = partPinAddresses(this.#doc, comp) ?? null;
      this.#pinCache.set(comp.id, pins);
    }
    return pins;
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
      const pins = this.#pinsFor(comp);
      if (!pins) continue; // a rotated LED with an unresolved far end
      const at = (pin) => pins.find((p) => p.pin === pin)?.address;
      const state = this.#junctionState(at(anodePin), at(cathodePin));
      view.setBurnt?.(state.unlimited);
      view.setLit(isLit(state));
    }
  }

  /**
   * Diodes (the discretes) obey the LED's junction rule too — physics,
   * not light: one wired forward straight across two strongly driven nets has
   * nothing limiting its current, and burns. They never glow.
   */
  #updateDiodes() {
    for (const comp of this.#doc.components) {
      const def = partDef(comp.ref);
      if (typeof def?.oneWayBridges !== "function") continue;
      const view = this.#partViews.get(comp.id);
      if (!view?.setBurnt) continue;
      if (!this.#running) {
        view.setBurnt(false);
        continue;
      }
      const pins = this.#pinsFor(comp);
      const at = (pin) => pins?.find((p) => p.pin === pin)?.address;
      view.setBurnt(
        def
          .oneWayBridges(comp.params)
          .some(([a, k]) => this.#junctionState(at(a), at(k)).unlimited),
      );
    }
  }

  /**
   * Multi-segment displays (seg8cc / bar8): each segment is an LED between its
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
      const pins = this.#pinsFor(comp);
      const at = (pin) => pins?.find((p) => p.pin === pin)?.address;
      let anyBurnt = false;
      for (const seg of def.segments) {
        const state = this.#junctionState(at(seg.anodePin), at(seg.cathodePin));
        view.setSegmentLit(seg.id, isLit(state));
        view.setSegmentBurnt?.(seg.id, state.unlimited);
        if (state.unlimited) anyBurnt = true;
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
      if (!partDef(comp.ref)?.characterDisplay) continue;
      const view = this.#partViews.get(comp.id);
      if (!view?.renderFramebuffer) continue;
      view.renderFramebuffer(
        this.#running ? (this.#displays.get(comp.id) ?? null) : null,
      );
    }
  }
}
