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

// spice/silicon.js — a timing part as its SILICON (features/done/
// spice-lite-2-plan.md §1). Pure and DOM-free.
//
// A part that keeps time with an external R and C (the 555, the CD4000
// multivibrators, monostables and oscillator-counters) carries TWO
// implementations. Its `logic` is the digital one: it reads its R and C off
// the wiring, recognises the circuit and schedules its output by the
// datasheet's formula. Its `silicon` is the part as its functional diagram
// draws it: comparators reading the voltages on its pins against their own
// references, the package's own resistors, a discharge transistor, the
// sequential logic behind them. Its timing is computed nowhere — it is what the
// RC network's curve does, which Spice Lite solves as it solves every node.
//
// ONLY SPICE LITE reaches the silicon, through the digital engine's one hook,
// `logicOf` (sim/engine.js): it evaluates such a part with `siliconOf(def)`,
// the def with its `logic` swapped for its silicon. Nothing else ever sees it —
// the AI verifier, the desk review, `make demos`, the exports and the
// Properties card's Timing row all read the catalog def — and no part's code
// asks which engine is running.
//
// A silicon block is the standard sequential contract — `state0`, `step`,
// `outputs` (sim/chip-eval.js), its digital core reused — plus what its pins
// are electrically, each optional:
//
//   sense      pin → `{ref?, up?, down?}`: a pin its COMPARATOR reads,
//              whatever its role. With `ref` (a pin number, or the name of a
//              net inside the package) it trips where its own voltage crosses
//              that net's — a 555's THRES against CONT; without, at `up` /
//              `down`, each `(vcc) => volts` (one point when they are the
//              same; two are a Schmitt trigger's). It reads H above, L below,
//              never the undefined band an ordinary input has. With `window`
//              it is TWO comparators on the pin, one at each point: H above
//              `up`, L below `down`, X between (neither tripped) — a
//              monostable's RX CX, discharged to its lower reference and
//              timed to its upper.
//   drives     the pins it drives that are not `output` pins (a discharge
//              transistor on DISCH or RX CX, an oscillator's R and C pins).
//   stages     pin → `(vcc, level) => stage | null`: the output stage that
//              pin drives `level` through (spice/output-stage.js's shape) —
//              an open-collector discharge is a stage that only sinks. A pin
//              without one drives through the part's own stage.
//   inputs     pin → `(vcc) => [stage]`: what the pin draws (a comparator's
//              bias current), in place of its family's input stages.
//   internals  `{nets: [name], resistors: [{a, b, ohms}]}`: the package's own
//              parts — `a`/`b` a pin number or an internal net's name (a
//              555's three-resistor divider; the CX pin a 4098 ties to VSS).
//   overRail   the pins the sheet's own RC network drives past a rail
//              through a resistor of its own (a 4060's φI behind Rs): their
//              protection diodes' current is booked, and smokes past the
//              rating, but is no warning.
//   iccMa      `(vcc) => mA`: its supply current, from its own sheet.
//   limits     pin → output limits (spice/params.js `outputLimits`'s shape),
//              or null where none applies (a discharge transistor).
//   readout    `[{pin, section}]`: the outputs whose rate or pulse its
//              readout states, measured (spice/measure.js).

/** Each def's silicon twin, made once. */
const TWINS = new WeakMap();

/**
 * The def a part is evaluated with under Spice Lite: one with a `silicon`
 * block as that silicon (its `logic` replaced), anything else as itself.
 * Made once per def, so it is always one object.
 * @param {object} def
 * @returns {object}
 */
export function siliconOf(def) {
  if (!def?.silicon) return def;
  let twin = TWINS.get(def);
  if (!twin) {
    twin = Object.freeze({ ...def, logic: def.silicon });
    TWINS.set(def, twin);
  }
  return twin;
}

/** The id of a net inside a part's package: `<compId>#<name>`. */
export const internalNet = (compId, name) => `${compId}#${name}`;

/**
 * An open-collector (or open-drain) switch to ground: on, it sinks behind
 * `ohms`; off, it is nothing at all. What drives a 555's DISCH and a
 * monostable's RX CX.
 * @param {number|((vcc: number) => number)} ohms
 * @returns {(vcc: number, level: string) => object|null}
 */
export function openDrain(ohms) {
  return (vcc, level) =>
    level === "L"
      ? {
          volts: 0,
          ohms: typeof ohms === "function" ? ohms(vcc) : ohms,
          limit: Number.POSITIVE_INFINITY,
          sources: false,
        }
      : null;
}
