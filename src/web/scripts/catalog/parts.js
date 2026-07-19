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

// parts.js — discrete parts + power bricks: pure data and pure functions.
// Each def carries the part's ELECTRICAL CONTRACT for later stages:
//   - `footprint.offsets` — pin column offsets along ONE grid row (any row
//     a–j; the anchor hole is pin 1's seat).
//   - `internalBridges(params, state)` — which pin pairs are electrically
//     joined right now (Feature 70's netlist consumes this).
//   - `source(params)` — a PSU's terminal potentials (Feature 90 consumes).
//   - `normalizeParams(raw)` — coerce arbitrary stored params to valid ones.
// No electrical logic lives in views, and none in the netlist yet.

export const LED_COLORS = Object.freeze(["red", "green", "yellow", "blue"]);
export const PSU_VOLTS = Object.freeze([3, 5, 12]);
/** Clock rates (Hz) plus click-to-toggle "manual"; the timer lives in the
    renderer's SimController — the def carries only the pure contract. */
export const CLOCK_HZ = Object.freeze([1, 2, 5, 10, "manual"]);

export const PART_DEFS = Object.freeze(
  [
    {
      id: "sw-slide",
      kind: "discrete",
      title: "Slide switch (SPDT)",
      blurb:
        "Single-pole double-throw slide switch — the center pin is common; " +
        "click to flip which side it bridges.",
      group: "Parts",
      footprint: Object.freeze({ offsets: Object.freeze([0, 1, 2]) }),
      pins: [
        { n: 1, name: "1", role: "contact" },
        { n: 2, name: "C", role: "common" },
        { n: 3, name: "2", role: "contact" },
      ],
      normalizeParams(raw) {
        return { pos: raw?.pos === "2" ? "2" : "1" };
      },
      // Common (pin 2) bridges to pin 1 or pin 3 depending on the slider.
      internalBridges(params) {
        return [[2, params?.pos === "2" ? 3 : 1]];
      },
    },
    {
      id: "sw-push",
      kind: "discrete",
      title: "Push button (momentary)",
      blurb:
        "Momentary SPST tactile button — bridges its two pins only while held.",
      group: "Parts",
      footprint: Object.freeze({ offsets: Object.freeze([0, 2]) }),
      pins: [
        { n: 1, name: "1", role: "contact" },
        { n: 2, name: "2", role: "contact" },
      ],
      normalizeParams() {
        return {}; // nothing durable — pressed state is transient
      },
      internalBridges(params, state) {
        return state?.pressed ? [[1, 2]] : [];
      },
    },
    {
      id: "led",
      kind: "discrete",
      title: "LED",
      blurb:
        "Light-emitting diode (idealized — no series resistor required). " +
        "Anode at the anchor hole; press F while placing to flip polarity.",
      group: "Parts",
      footprint: Object.freeze({ offsets: Object.freeze([0, 1]) }),
      pins: [
        { n: 1, name: "A", role: "anode" },
        { n: 2, name: "K", role: "cathode" },
      ],
      normalizeParams(raw) {
        return {
          color: LED_COLORS.includes(raw?.color) ? raw.color : "red",
          flip: raw?.flip === true,
        };
      },
      internalBridges() {
        return []; // a diode is a device, not a bridge — Feature 90's job
      },
      // Which physical pin is the anode/cathode after an optional flip.
      polarity(params) {
        return params?.flip
          ? { anodePin: 2, cathodePin: 1 }
          : { anodePin: 1, cathodePin: 2 };
      },
    },
    {
      id: "resistor",
      kind: "discrete",
      title: "Resistor",
      blurb:
        "Two-terminal resistor. In this logic-level sim it's a WEAK coupler: " +
        "it conducts one end's driven level to the other at a strength below " +
        "any chip output, so it behaves as a pull-up / pull-down / series " +
        "resistor. The ohms value is cosmetic (no analog current here).",
      group: "Parts",
      footprint: Object.freeze({ offsets: Object.freeze([0, 3]) }),
      pins: [
        { n: 1, name: "1", role: "lead" },
        { n: 2, name: "2", role: "lead" },
      ],
      normalizeParams(raw) {
        const ohms = Number(raw?.ohms);
        return { ohms: Number.isFinite(ohms) && ohms > 0 ? ohms : 10000 };
      },
      // A resistor is NOT a hard conductor — its two ends stay separate nets
      // (unlike a wire or a closed switch), so it declares no internal bridges.
      internalBridges() {
        return [];
      },
      // …instead the two leads are WEAKLY coupled: the simulator (resolve.js's
      // PULL tier) conducts one end's strong H/L to the other at the weakest
      // drive strength. `weakBridges` lists the coupled pin pairs (data, not a
      // code path) — a resistor could carry more, but this one bridges 1↔2.
      weakBridges() {
        return [[1, 2]];
      },
    },
    {
      id: "psu",
      kind: "psu",
      title: "Power supply",
      blurb:
        "Bench power brick (3 V / 5 V / 12 V) with addressable + and − " +
        "terminals — wire them into a board's rails.",
      group: "Power",
      // Desk outline (pitch units) and terminal pads at INTEGER offsets so
      // wired terminals land on the global 0.1-in lattice.
      size: Object.freeze({ width: 8, height: 5 }),
      terminals: [
        { id: "+", dx: 2, dy: 4 },
        { id: "-", dx: 6, dy: 4 },
      ],
      normalizeParams(raw) {
        return { volts: PSU_VOLTS.includes(raw?.volts) ? raw.volts : 5 };
      },
      // Terminal potentials for the simulator (Feature 90).
      source(params) {
        return { plus: params?.volts ?? 5, minus: 0 };
      },
    },
    {
      id: "clock",
      kind: "clock",
      title: "Clock source",
      blurb:
        "Square-wave clock (1 / 2 / 5 / 10 Hz, or manual click-to-toggle) with " +
        "an `out` terminal and a `gnd` reference — wire it to a chip's clock pin.",
      group: "Power",
      size: Object.freeze({ width: 8, height: 5 }),
      terminals: [
        { id: "out", dx: 2, dy: 4 },
        { id: "gnd", dx: 6, dy: 4 },
      ],
      normalizeParams(raw) {
        return { hz: CLOCK_HZ.includes(raw?.hz) ? raw.hz : 1 };
      },
      /** Is this clock free-running (has a rate) rather than manual? */
      isAuto(params) {
        return params?.hz !== "manual";
      },
    },
  ].map(Object.freeze),
);
