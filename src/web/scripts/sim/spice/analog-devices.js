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
//        to emitter, carrying CTR × IF — the CTR falling at a small IF
//        (`OPTO_TRANSFER`) — never more than its saturation lets through
//        (`OPTO`: nothing below its knee, then RSAT ohms).
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

/**
 * What an optocoupler's phototransistor carries per unit of CTR, against its
 * LED's current — `[IF, amps]` corners, straight lines between, IF itself
 * past the last: the CTR a part is set to holds from 5 mA up and falls below
 * it. ONE curve for every part (Jason: one common set), read off both
 * sheets. Vishay 4N35 (doc. 81181) Fig. 2, non-saturated CTR normalized to
 * IF 10 mA: 0.21 at 0.5 mA, 0.36 at 1 mA, 0.76 at 5 mA, 1.33 at 30 mA.
 * Sharp PC817 (OP18002EN) Fig. 7: 25 % at 0.1 mA, 47 % at 0.2 mA, 100 % at
 * 0.5 mA, 150 % at 1 mA, 207 % at 2 mA, 275 % at 5 mA, its peak 290 % at
 * 8.5 mA, 90 % at 50 mA. Below 5 mA the two fall alike — each relative to
 * its 5 mA, 0.28 and 0.36 at 0.5 mA, 0.47 and 0.55 at 1 mA, 0.70 and 0.75 at
 * 2 mA — and the curve is their mean (the PC817's alone under 0.5 mA, where
 * the 4N35's stops): 0.09 at 0.1 mA, 0.17 at 0.2 mA, 0.32 at 0.5 mA, 0.51 at
 * 1 mA, 0.725 at 2 mA. Above it one rises and the other falls, so a common
 * curve holds the CTR set — the PC817's own test point (5 mA), and the
 * 4N35's (10 mA) on the flat. Temperature is not modelled.
 */
// prettier-ignore
export const OPTO_TRANSFER = Object.freeze(
  [
    [0, 0], [0.1e-3, 0.009e-3], [0.2e-3, 0.034e-3], [0.5e-3, 0.16e-3],
    [1e-3, 0.51e-3], [2e-3, 1.45e-3], [5e-3, 5e-3],
  ].map((c) => Object.freeze(c)),
); // prettier-ignore

/** Which of `OPTO_TRANSFER`'s chords an LED current is on (its count less
    one past the last). */
function transferSegment(led) {
  let k = 0;
  while (k < OPTO_TRANSFER.length - 1 && led >= OPTO_TRANSFER[k + 1][0]) k++;
  return k;
}

/** What a phototransistor carries per unit of CTR at an LED current `led`,
    amps (`OPTO_TRANSFER`). */
export function optoTransfer(led) {
  if (!(led > 0)) return 0;
  const k = transferSegment(led);
  if (k >= OPTO_TRANSFER.length - 1) return led;
  const [[i0, g0], [i1, g1]] = [OPTO_TRANSFER[k], OPTO_TRANSFER[k + 1]];
  return g0 + ((g1 - g0) * (led - i0)) / (i1 - i0);
}

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

/** How far past a corner `opAmpStepCut` lands a step, volts of its raw
    level: clear of the corner, so the next step reads the new piece. */
const CUT_PAST_V = 1e-6;

/**
 * The share (0–1] of a Newton step — every node moved by `step(node)` —
 * at which an op-amp's law first changes piece: its raw level (gain times
 * its inputs' difference, about the middle of its swing) crossing the top or
 * the bottom of the swing, or its output current reaching a limit — a hair
 * past it. 1 when the step crosses none. An op-amp's gain is a hundred
 * thousand, so the band between its two saturations is tens of microvolts of
 * input: a step that corrects a network by a millivolt carries it from one
 * saturation through the band to the other, the linear step's prediction is
 * nothing like where it lands, and the line search refuses the step, the
 * solve creeping by microvolts (a comparator at its crossing — the moment a
 * crossing search puts it at). Cut at the corner, the next step is made on
 * the piece it is on, as SPICE limits a junction's step.
 * @param {object} br - an "a" branch
 * @param {(node: string) => number} vAt
 * @param {(node: string) => number} step
 */
export function opAmpStepCut(br, vAt, step) {
  const at = (t) => (node) => vAt(node) + t * step(node);
  const raw = (v) => {
    const [lo, hi] = swing(br, v);
    return { lo, hi, raw: (lo + hi) / 2 + br.amp.gain * (v(br.inp) - v(br.inn)) }; // prettier-ignore
  };
  const a = raw(at(0));
  const b = raw(at(1));
  let cut = 1;
  // Where `f` (linear in the step) first changes sign along it.
  const cross = (f0, f1, slope) => {
    if (!(f0 * f1 < 0)) return;
    const t = f0 / (f0 - f1) + CUT_PAST_V / Math.max(Math.abs(slope), 1e-30);
    if (t > 0 && t < cut) cut = Math.min(1, t);
  };
  const dRaw = b.raw - a.raw;
  cross(a.raw - a.hi, b.raw - b.hi, dRaw - (b.hi - a.hi));
  cross(a.raw - a.lo, b.raw - b.lo, dRaw - (b.lo - a.lo));
  // Its output current reaching a limit, along the piece it starts on.
  const level = (r) => Math.min(r.hi, Math.max(r.lo, r.raw));
  const i0 = (level(a) - vAt(br.out)) / br.amp.rOut;
  const i1 = (level(b) - at(1)(br.out)) / br.amp.rOut;
  cross(i0 - br.amp.sourceA, i1 - br.amp.sourceA, (i1 - i0) * br.amp.rOut);
  cross(i0 + br.amp.sinkA, i1 + br.amp.sinkA, (i1 - i0) * br.amp.rOut);
  return cut;
}

/**
 * ∂(current INTO `node`)/∂(the voltage at `t`), siemens, for an op-amp —
 * analytic, never read a step apart: a step that moves its raw level by its
 * gain times a microvolt (a tenth of a volt) straddles a corner of its
 * swing whenever the band between them is crossed, and the slope read across
 * one is no slope of either piece. On a corner, `side` says which piece is
 * read: the one the voltage at `t` moving up (+1) or down (−1) enters.
 * @param {object} br - an "a" branch
 * @param {string} node
 * @param {string} t
 * @param {(node: string) => number} vAt
 * @param {number} [side]
 */
export function opAmpSlope(br, node, t, vAt, side = 1) {
  const { gain, rOut, sourceA, sinkA } = br.amp;
  const lo = vAt(br.gnd) + br.amp.lowV;
  const top = vAt(br.vcc) - br.amp.headroomV;
  const hi = Math.max(lo, top);
  const raw = (lo + hi) / 2 + gain * (vAt(br.inp) - vAt(br.inn));
  // How the raw level and each edge of the swing move with `t`.
  const dLo = t === br.gnd ? 1 : 0;
  const dHi = top >= lo ? (t === br.vcc ? 1 : 0) : dLo;
  const dRaw = (dLo + dHi) / 2 + (t === br.inp ? gain : 0) - (t === br.inn ? gain : 0); // prettier-ignore
  // The piece `t` moving `side` enters: past an edge, or on one heading out.
  const eps = 1e-12 * Math.max(1, Math.abs(hi), Math.abs(lo));
  const over = raw > hi + eps || (raw >= hi - eps && side * (dRaw - dHi) > 0);
  const under = !over && (raw < lo - eps || (raw <= lo + eps && side * (dRaw - dLo) < 0)); // prettier-ignore
  const level = over ? hi : under ? lo : raw;
  const dLevel = over ? dHi : under ? dLo : dRaw;
  const dOut = t === br.out ? 1 : 0;
  const lin = (level - vAt(br.out)) / rOut;
  const dLin = (dLevel - dOut) / rOut;
  // Past a current limit — or on one, heading past it — no slope at all.
  const ceps = 1e-12 * Math.max(sourceA, sinkA);
  const limited =
    lin > sourceA + ceps ||
    lin < -sinkA - ceps ||
    (lin >= sourceA - ceps && side * dLin > 0) ||
    (lin <= -sinkA + ceps && side * dLin < 0);
  const di = limited ? 0 : dLin;
  const i = Math.max(-sinkA, Math.min(sourceA, lin));
  // Into OUT the current itself; out of VCC what it sources, into GND what
  // it sinks — on zero current, by the way it is heading.
  const sourcing = i > 0 || (i === 0 && side * di > 0);
  const sinking = i < 0 || (i === 0 && side * di < 0);
  if (node === br.out) return di;
  if (node === br.vcc) return sourcing ? -di : 0;
  if (node === br.gnd) return sinking ? -di : 0;
  return 0;
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
  return { led, out: vce > 0 ? Math.min(br.ctr * optoTransfer(led), sat) : 0 };
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
    const out = !(vce > OPTO.kneeV) ? "0" : br.ctr * optoTransfer(led) <= sat ? "c" : "s"; // prettier-ignore
    // The LED's table segment, and its current's chord of the transfer.
    return `${String.fromCharCode(98 + k)}${led > 0 ? transferSegment(led) : ""}${out}|`; // prettier-ignore
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
