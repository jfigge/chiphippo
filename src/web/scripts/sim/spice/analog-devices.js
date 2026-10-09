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

// spice/analog-devices.js — the bench parts' DEVICES in the voltage solve
// (spice/network.js), beside its transistors: each a current law over the
// voltages of its terminals, piecewise linear, its pieces its corners. Pure
// and DOM-free.
//
//   "o"  an OPTOCOUPLER (`{a, k, c, e, ctr, spec}`): its infrared LED, anode
//        to cathode, the junction table `spec`; its phototransistor, collector
//        to emitter, carrying CTR × IF — never more than its saturation lets
//        through (`OPTO`: nothing below its knee, then RSAT ohms).
//   "a"  an OP-AMP unit (`{out, inp, inn, vcc, gnd, amp}`): open-loop gain
//        `amp.gain` about the middle of its output swing, the swing clamped
//        to its supply less its headroom, behind its output resistance and
//        its short-circuit currents — the source from VCC, the sink to GND.
//        Its inputs draw nothing.
//   "g"  a LINEAR REGULATOR (`{inp, ref, out, reg}`): OUT held `reg.vref`
//        above REF (a 78xx's GND, an LM317's ADJ) behind `reg.rOut`, never
//        higher than IN less its dropout, its current from IN, never more
//        than its limit, never sunk; its own quiescent current IN → REF (a
//        78xx) or out of ADJ (an LM317).
//   "e"  an ELECTRONIC LOAD (`{pos, neg, mode, amps, ohms}`): constant
//        current (`cc`) — I = V / RON until it reaches its setting, then its
//        setting — or constant resistance (`cr`); it only ever sinks.

import { junctionTable, tableCurrent, tableSegment } from "./junction-table.js"; // prettier-ignore
import { CONDUCTS_A } from "./transistors.js";

/** The kinds this module carries. */
export const ANALOG_KINDS = new Set(["o", "a", "g", "e"]);

/** An optocoupler's infrared emitter, one for every part (Jason: one common
    set): a GaAs LED fitted to the Vishay 4N35's VF 1.3 V typ at 50 mA and
    the Sharp PC817's 1.2 V typ at 20 mA — n 1.7, Rs 1.5 Ω, Is 6.2e-14 A
    (1.15 V at 10 mA). */
const IR_CURVE = Object.freeze({ isA: 6.2e-14, n: 1.7, rsOhm: 1.5, ikfA: 0 });
export const IR_SPEC = Object.freeze({
  kind: "ir",
  ...IR_CURVE,
  table: junctionTable(IR_CURVE),
});

/** A phototransistor's saturation: it carries nothing below KNEE_V across
    it, then RSAT_OHMS — 0.12 V at 2 mA, 0.2 V at 10 mA (the 4N35's VCE(sat)
    0.3 V max at 2 mA, IF 10 mA). */
export const OPTO = Object.freeze({ kneeV: 0.1, rsatOhm: 10 });

/** An electronic load's resistance when it cannot hold its current, Ω: the
    least voltage it regulates at (a bench load's ~0.5 V at 1 A). */
export const LOAD_RON = 0.5;

/** Every node a kind's current depends on. */
export function analogEnds(br) {
  if (br.kind === "o") return [br.a, br.k, br.c, br.e];
  if (br.kind === "a") return [br.out, br.inp, br.inn, br.vcc, br.gnd];
  if (br.kind === "g") return [br.inp, br.ref, br.out];
  return [br.pos, br.neg];
}

/** The nodes a kind's current flows through. */
export function analogTerminals(br) {
  if (br.kind === "o") return [br.a, br.k, br.c, br.e];
  if (br.kind === "a") return [br.out, br.vcc, br.gnd];
  if (br.kind === "g") return [br.inp, br.ref, br.out];
  return [br.pos, br.neg];
}

/** The holes each terminal's lead is in, in `analogTerminals`' order. */
export function analogHoles(br) {
  if (br.kind === "o") return [br.aAt, br.kAt, br.cAt, br.eAt];
  if (br.kind === "a") return [br.outAt, br.vccAt, br.gndAt];
  if (br.kind === "g") return [br.inpAt, br.refAt, br.outAt];
  return [br.posAt, br.negAt];
}

/** An optocoupler's ratings, one common set (the Vishay 4N35's absolute
    maxima: IF 60 mA, IC 50 mA; the PC817's are IF 50 mA, IC 50 mA): past
    them a warning, past three times them smoke. */
export const OPTO_LIMITS = Object.freeze({
  led: Object.freeze({ warnMa: 60, smokeMa: 180 }),
  out: Object.freeze({ warnMa: 50, smokeMa: 150 }),
});

/** An op-amp's output swing at its supply nodes' voltages: `[lo, hi]`. */
function swing(br, vAt) {
  const lo = vAt(br.gnd) + br.amp.lowV;
  const hi = Math.max(lo, vAt(br.vcc) - br.amp.headroomV);
  return [lo, hi];
}

/** What drives an op-amp's output, before its output resistance: its gain
    about the middle of its swing, clamped to it. */
function opAmpLevel(br, vAt) {
  const [lo, hi] = swing(br, vAt);
  const v = (lo + hi) / 2 + br.amp.gain * (vAt(br.inp) - vAt(br.inn));
  return Math.min(hi, Math.max(lo, v));
}

/** An op-amp's output current, amps INTO its output node. */
function opAmpAmps(br, vAt) {
  const i = (opAmpLevel(br, vAt) - vAt(br.out)) / br.amp.rOut;
  return Math.max(-br.amp.sinkA, Math.min(br.amp.sourceA, i));
}

/** Where a regulator holds its output: its reference above REF, or IN less
    its dropout, whichever is lower. */
export function regulatorTarget(br, vAt) {
  return Math.min(vAt(br.ref) + br.reg.vref, vAt(br.inp) - br.reg.dropoutV);
}

/** A regulator's output current, amps INTO its output node: sourced only,
    up to its limit. */
function regulatorAmps(br, vAt) {
  if (br.off) return 0;
  const i = (regulatorTarget(br, vAt) - vAt(br.out)) / br.reg.rOut;
  return Math.max(0, Math.min(br.reg.limitA, i));
}

/** An electronic load's current, + to −, amps. */
export function loadAmps(br, vAt) {
  const v = vAt(br.pos) - vAt(br.neg);
  if (!(v > 0)) return 0;
  if (br.mode === "cr") return br.ohms > 0 ? v / br.ohms : 0;
  return Math.min(br.amps, v / LOAD_RON);
}

/** An optocoupler's LED current and its phototransistor's, amps. */
export function optoAmps(br, vAt) {
  const vd = vAt(br.a) - vAt(br.k);
  const led = vd > 0 ? tableCurrent(br.spec.table, vd) : 0;
  const vce = vAt(br.c) - vAt(br.e);
  const sat = Math.max(0, vce - OPTO.kneeV) / OPTO.rsatOhm;
  return { led, out: vce > 0 ? Math.min(br.ctr * led, sat) : 0 };
}

/** Each terminal's current INTO the network, amps: `[[node, amps], …]`. */
export function analogCurrents(br, vAt) {
  if (br.kind === "o") {
    const { led, out } = optoAmps(br, vAt);
    return [
      [br.a, -led],
      [br.k, led],
      [br.c, -out],
      [br.e, out],
    ];
  }
  if (br.kind === "a") {
    const i = opAmpAmps(br, vAt);
    return [
      [br.out, i],
      [br.vcc, -Math.max(0, i)],
      [br.gnd, Math.max(0, -i)],
    ];
  }
  if (br.kind === "g") {
    const i = regulatorAmps(br, vAt);
    const iq = br.off ? 0 : br.reg.quiescentA;
    return [
      [br.out, i],
      [br.inp, -i - iq],
      [br.ref, iq],
    ];
  }
  const i = loadAmps(br, vAt);
  return [
    [br.pos, -i],
    [br.neg, i],
  ];
}

/** Whether a kind conducts between its ends — what a net it alone ties to
    something is held by. */
export function analogConducts(br, vAt) {
  if (br.kind === "o") return optoAmps(br, vAt).out > CONDUCTS_A;
  if (br.kind === "e") return br.mode === "cr";
  return true;
}

/** The nets a held node holds through this device: a phototransistor's
    collector and emitter while it conducts, a CR load's two ends. An op-amp
    or a regulator holds its own output outright (`holdsOut`). */
export function analogHeldThrough(br, node, vAt) {
  if (br.kind === "o") {
    if (node !== br.c && node !== br.e) return [];
    return analogConducts(br, vAt) ? [br.c, br.e] : [];
  }
  if (br.kind === "e" && br.mode === "cr") return [br.pos, br.neg];
  return [];
}

/** Whether this branch holds its output node outright, as a driving output
    does: an op-amp and a regulator that is on. */
export function holdsOut(br) {
  return (br.kind === "a" || br.kind === "g") && !br.off;
}

/** Which piece a kind is on, one fragment ending in `|`. */
export function analogPiece(br, vAt) {
  if (br.kind === "o") {
    const vd = vAt(br.a) - vAt(br.k);
    const k = vd > 0 ? tableSegment(br.spec.table, vd) : -1;
    const vce = vAt(br.c) - vAt(br.e);
    const led = vd > 0 ? tableCurrent(br.spec.table, vd) : 0;
    const sat = Math.max(0, vce - OPTO.kneeV) / OPTO.rsatOhm;
    const out = !(vce > OPTO.kneeV) ? "0" : br.ctr * led <= sat ? "c" : "s";
    return `${String.fromCharCode(98 + k)}${out}|`;
  }
  if (br.kind === "a") {
    const [lo, hi] = swing(br, vAt);
    const raw = (lo + hi) / 2 + br.amp.gain * (vAt(br.inp) - vAt(br.inn));
    const region = raw >= hi ? "h" : raw <= lo ? "l" : "m";
    const i = (Math.min(hi, Math.max(lo, raw)) - vAt(br.out)) / br.amp.rOut;
    const limit = i >= br.amp.sourceA ? "+" : i <= -br.amp.sinkA ? "-" : "";
    return `${region}${limit}|`;
  }
  if (br.kind === "g") {
    if (br.off) return "0|";
    const drop = vAt(br.inp) - br.reg.dropoutV <= vAt(br.ref) + br.reg.vref;
    const i = (regulatorTarget(br, vAt) - vAt(br.out)) / br.reg.rOut;
    const region = !(i > 0) ? "0" : i >= br.reg.limitA ? "l" : "r";
    return `${drop ? "d" : "n"}${region}|`;
  }
  const v = vAt(br.pos) - vAt(br.neg);
  if (!(v > 0)) return "0|";
  if (br.mode === "cr") return "r|";
  return `${v / LOAD_RON >= br.amps ? "c" : "u"}|`;
}
