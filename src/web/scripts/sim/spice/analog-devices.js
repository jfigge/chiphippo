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
//        Its inputs draw nothing. An OPEN-COLLECTOR unit (`amp.openCollector`
//        — the LM339 comparator's) has no top to its swing and sources
//        nothing (`sourceA` 0): it sinks to its saturation and its limit, and
//        past its crossing it lets go wherever its pull-up holds the pin.
//   "g"  a LINEAR REGULATOR (`{inp, ref, out, reg}`): OUT held `reg.vref`
//        above REF (a 78xx's GND, an LM317's ADJ) behind `reg.rOut`, never
//        higher than IN less its dropout, its current from IN, never more
//        than its limit, never sunk; its own quiescent current IN → REF (a
//        78xx) or out of ADJ (an LM317), less of it below its dropout
//        (`regulatorQuiescent`); and its feedback divider, OUT → REF
//        (`REGULATOR_DIVIDER_S`).
//   "e"  an ELECTRONIC LOAD (`{pos, neg, mode, amps, ohms, volts, watts}`):
//        constant current (`cc`) — I = V / RON until it reaches its
//        setting, then its setting —, constant resistance (`cr`), constant
//        voltage (`cv` — nothing below its setting, then whatever holds V
//        there, CV_OHMS per amp above it) or constant power (`cp` — P / V,
//        drawn as chords `CP_STEPS` to an octave of V); CV and CP never
//        past RON's line nor its 5 A ceiling (`loadLaw`). It only ever
//        sinks.
//   "v"  an ISOLATED AC SOURCE — an AC adapter's output (`{w, l, n, ohms,
//        earth, earthOhms}`): L (its S1) held at N (its S2) plus the sine on
//        `w` — a net inside it, run as the mains' L is (spice/engine.js
//        `analyze`) — behind `ohms` (the adapter's, `sourceOhms`);
//        its circuit reaches earth only at `earth`, through `earthOhms`: its
//        insulation from N (`AC_INSULATION_OHMS`) where something else
//        grounds the circuit, else the REFERENCE a circuit nothing grounds is
//        read against (`AC_REFERENCE_OHMS`, spice/voltages.js
//        `voltageTopology`). So a circuit can ground either side, or neither.
//        `w` draws nothing: it is the winding the isolation is FROM. One law,
//        linear: no corner.
//   "p"  a POWER SUPPLY ON ITS CURRENT LIMIT (`{pos, neg, set, limit}`):
//        while a PSU's demand at its set voltage is past its limit its + is
//        no rail but a net of the solve, held by this — its set voltage
//        behind `PSU_SOURCE_OHMS` (constant voltage), never more than its
//        limit out of + (constant current) — so what it delivers is where
//        its load draws exactly the limit, moment by moment (spice/engine.js
//        `measure`, which frees and re-rails it). Two pieces: CV, CC.

import { junctionTable, tableCurrent, tableSegment } from "./junction-table.js"; // prettier-ignore
import { CONDUCTS_A } from "./transistors.js";

/** The kinds this module carries. */
export const ANALOG_KINDS = new Set(["o", "a", "g", "e", "v", "p"]);

/** An isolated AC source's resistance when it states none, Ω: next to
    nothing, as the mains' L is an ideal source — enough to make it a branch
    the solve can hold L by, too little to read on any breadboard load. An
    adapter states its own (catalog/ac-parts.js `adapterOhms`). */
export const AC_SOURCE_OHMS = 0.01;

/** An isolated AC source's resistance, Ω. */
export const sourceOhms = (br) => br.ohms ?? AC_SOURCE_OHMS;

/** An isolated AC supply's insulation from earth, Ω, at its N (a
    transformer's windings' `TRANSFORMER_INSULATION_OHMS`, spice/inductors.js,
    the same figure): a nanoamp, where something else grounds its circuit. */
export const AC_INSULATION_OHMS = 1e9;

/** Where NOTHING grounds an isolated supply's circuit, the tie to earth its
    voltages are read against, Ω — where a meter's black lead would go: no
    current but leakage has anywhere else to return through it, so it reads
    as a ground does. Held by its insulation's gigohm alone, the circuit's
    every voltage was a nanoamp's worth of volts from where it was solved. */
export const AC_REFERENCE_OHMS = 1;

/** A power supply's own resistance while the solve holds its + (a "p"
    device), Ω: next to nothing, as a rail is an ideal source — a bench
    supply regulates to millivolts. */
export const PSU_SOURCE_OHMS = 0.01;

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

/** The most an electronic load sinks in any mode, amps — its CC range's
    top (catalog/bench-parts.js `LOAD_AMPS`). */
export const LOAD_MAX_A = 5;

/** A CV load's regulation: how far above its setting it stands per amp it
    sinks, Ω — 50 mV at its 5 A (an assumption; a bench load's CV holds to
    a few mV an amp). Steep, so its slope is read by hand (`loadSlope`). */
export const LOAD_CV_OHMS = 0.01;

/** A CP load's P / V as straight chords between voltages 2^(k / CP_STEPS)
    apart — every chord's end a corner, as a junction table's samples are —
    each within 0.19 % of the curve (a chord a factor r long strays by
    (1 + r)² / 4r − 1). A curve within a piece would be read by its
    tangent and run on past where it bends. */
export const LOAD_CP_STEPS = 8;

/** The CP grid's k-th voltage, volts. */
const cpVolts = (k) => 2 ** (k / LOAD_CP_STEPS);

/** The CP chord a voltage lies on: k with cpVolts(k) ≤ v < cpVolts(k + 1). */
function cpChord(v) {
  let k = Math.floor(LOAD_CP_STEPS * Math.log2(v));
  while (cpVolts(k) > v) k--;
  while (cpVolts(k + 1) <= v) k++;
  return k;
}

/** Chord k of P / V: its current at v, and its slope. */
function cpLine(watts, k) {
  const [a, b] = [cpVolts(k), cpVolts(k + 1)];
  return { at0: (watts * (a + b)) / (a * b), slope: -watts / (a * b) };
}

/** Where the CP chords meet a rising line i = g·v + c (RON's line, or the
    ceiling with g 0), volts — the chords fall, so once; `near` is where
    the curve itself meets it (the chord, above the curve, meets it later
    on that chord). */
function cpMeets(watts, near, g, c) {
  let k = cpChord(near);
  for (let n = 0; n < 4; n++, k++) {
    const { at0, slope } = cpLine(watts, k);
    const v = (at0 - c) / (g - slope);
    if (v < cpVolts(k + 1)) return Math.max(v, cpVolts(k));
  }
  return near;
}

/**
 * An electronic load's law at v = V(+) − V(−): the piece it is on — a
 * fragment naming it, the interval [lo, hi) of v it holds over, its current
 * and slope there. Every mode's current is straight within its pieces.
 * @param {{mode: string, amps: number, ohms: number, volts: number,
 *   watts: number}} br
 * @param {number} v
 * @returns {{piece: string, lo: number, hi: number, amps: number,
 *   slope: number}}
 */
export function loadLaw(br, v) {
  const on = (piece, lo, hi, slope, at0 = 0) => ({ piece, lo, hi, slope, amps: at0 + slope * v }); // prettier-ignore
  if (!(v > 0)) return on("0", -Infinity, 0, 0);
  const line = (lo, hi) => on("u", lo, hi, 1 / LOAD_RON);
  const ceiling = (amps, lo, hi) => on("c", lo, hi, 0, amps);
  if (br.mode === "cr") return on("r", 0, Infinity, br.ohms > 0 ? 1 / br.ohms : 0); // prettier-ignore
  if (br.mode === "cv") {
    // min(V / RON, max(0, (V − set) / CV_OHMS), its ceiling): nothing up to
    // its setting, then the regulating slope until it meets either.
    const set = br.volts > 0 ? br.volts : 0;
    if (v < set) return on("o", 0, set, 0);
    // Where the slope meets RON's line, and where it meets the ceiling.
    const toLine = set / (1 - LOAD_CV_OHMS / LOAD_RON);
    const toCeiling = set + LOAD_MAX_A * LOAD_CV_OHMS;
    if (v < Math.min(toLine, toCeiling)) return on("v", set, Math.min(toLine, toCeiling), 1 / LOAD_CV_OHMS, -set / LOAD_CV_OHMS); // prettier-ignore
    // Past it: the ceiling — or, set under RON's reach of it, RON's line
    // up to the ceiling first.
    const knee = LOAD_MAX_A * LOAD_RON;
    if (toCeiling <= toLine) return ceiling(LOAD_MAX_A, toCeiling, Infinity);
    return v < knee ? line(toLine, knee) : ceiling(LOAD_MAX_A, knee, Infinity);
  }
  if (br.mode === "cp") {
    const watts = br.watts > 0 ? br.watts : 0;
    if (!watts) return on("o", 0, Infinity, 0);
    // min(V / RON, its ceiling, P / V): RON's line up to where the chords
    // meet it — or to the ceiling, then the ceiling until they meet that.
    const knee = LOAD_MAX_A * LOAD_RON;
    const byLine = cpMeets(watts, Math.sqrt(watts * LOAD_RON), 1 / LOAD_RON, 0); // prettier-ignore
    let from = byLine;
    if (byLine > knee) {
      if (v < knee) return line(0, knee);
      from = cpMeets(watts, watts / LOAD_MAX_A, 0, LOAD_MAX_A);
      if (v < from) return ceiling(LOAD_MAX_A, knee, from);
    } else if (v < byLine) return line(0, byLine);
    const k = cpChord(v);
    const { at0, slope } = cpLine(watts, k);
    return on(`p${k}`, Math.max(from, cpVolts(k)), cpVolts(k + 1), slope, at0); // prettier-ignore
  }
  // Constant current: RON's line up to its setting.
  const amps = Math.max(br.amps, 0) || 0;
  const edge = amps * LOAD_RON;
  return v < edge ? line(0, edge) : ceiling(amps, edge, Infinity);
}

/** Whether a load is on the piece its setting rules (`loadLaw`) — CC at its
    current, CR, CV holding its voltage, CP its power; off it the load
    cannot do what it is set to (UNREG). */
export function loadRegulates(br, v) {
  const { piece } = loadLaw(br, v);
  const ruled = { cc: "c", cr: "r", cv: "v", cp: "p" }[br.mode] ?? "c";
  return piece[0] === ruled;
}

/** Whether a load holds its two ends to each other, as a resistor does — a
    CR load, and a CV load on its regulating slope. A current it draws
    whatever the voltage (CC, CP) holds nothing. */
function loadHolds(br, vAt) {
  if (br.mode === "cr") return true;
  return br.mode === "cv" && loadLaw(br, vAt(br.pos) - vAt(br.neg)).piece === "v"; // prettier-ignore
}

/** Every node a kind's current depends on. */
export function analogEnds(br) {
  if (br.kind === "o") return [br.a, br.k, br.c, br.e];
  if (br.kind === "a") return [br.out, br.inp, br.inn, br.vcc, br.gnd];
  if (br.kind === "g") return [br.inp, br.ref, br.out];
  if (br.kind === "v") return [br.w, br.l, br.n, br.earth];
  return [br.pos, br.neg];
}

/** The nodes a kind's current flows through. */
export function analogTerminals(br) {
  if (br.kind === "o") return [br.a, br.k, br.c, br.e];
  if (br.kind === "a") return [br.out, br.vcc, br.gnd];
  if (br.kind === "g") return [br.inp, br.ref, br.out];
  if (br.kind === "v") return [br.l, br.n, br.earth];
  return [br.pos, br.neg];
}

/** The holes each terminal's lead is in, in `analogTerminals`' order. */
export function analogHoles(br) {
  if (br.kind === "o") return [br.aAt, br.kAt, br.cAt, br.eAt];
  if (br.kind === "a") return [br.outAt, br.vccAt, br.gndAt];
  if (br.kind === "g") return [br.inpAt, br.refAt, br.outAt];
  if (br.kind === "v") return [br.lAt, br.nAt, null];
  return [br.posAt, br.negAt];
}

/** An optocoupler's ratings, one common set (the Vishay 4N35's absolute
    maxima: IF 60 mA, IC 50 mA; the PC817's are IF 50 mA, IC 50 mA): past
    them a warning, past three times them smoke. */
export const OPTO_LIMITS = Object.freeze({
  led: Object.freeze({ warnMa: 60, smokeMa: 180 }),
  out: Object.freeze({ warnMa: 50, smokeMa: 150 }),
});

/** An op-amp's output swing at its supply nodes' voltages: `[lo, hi]` —
    the band its gain is centred in. An open collector's `hi` clamps
    nothing (`topless`). */
function swing(br, vAt) {
  const lo = vAt(br.gnd) + br.amp.lowV;
  const hi = Math.max(lo, vAt(br.vcc) - br.amp.headroomV);
  return [lo, hi];
}

/** Whether an op-amp's output is an OPEN COLLECTOR: its level has no top —
    above the pin, its transistor is off, however far a pull-up lifts the pin
    (clamped to its supply, a pull-up to 12 V on a 5 V comparator would have
    been sunk at its limit while released). */
const topless = (br) => br.amp.openCollector === true;

/** What drives an op-amp's output, before its output resistance: its gain
    about the middle of its swing, clamped to it (an open collector's at its
    bottom only). */
function opAmpLevel(br, vAt) {
  const [lo, hi] = swing(br, vAt);
  const v = (lo + hi) / 2 + br.amp.gain * (vAt(br.inp) - vAt(br.inn));
  return topless(br) ? Math.max(lo, v) : Math.min(hi, Math.max(lo, v));
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
  const open = topless(br);
  if (!open) cross(a.raw - a.hi, b.raw - b.hi, dRaw - (b.hi - a.hi));
  cross(a.raw - a.lo, b.raw - b.lo, dRaw - (b.lo - a.lo));
  // Its output current reaching a limit, along the piece it starts on —
  // that piece's level carried to the step's end, never the end's own: read
  // there, an output saturated HIGH whose input the step carries past its
  // crossing was "at" its sink limit a twentieth of the way along, and each
  // step was cut there — a comparator's input crawled to a sine's crest in
  // sixty of them (the regrade, 2026-10-22).
  const pieceOf = !open && a.raw >= a.hi ? (r) => r.hi : a.raw <= a.lo ? (r) => r.lo : (r) => r.raw; // prettier-ignore
  const i0 = (pieceOf(a) - vAt(br.out)) / br.amp.rOut;
  const i1 = (pieceOf(b) - at(1)(br.out)) / br.amp.rOut;
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
  // (An open collector has no top: past its pin it is off, by its source
  // limit of nothing.)
  const over = !topless(br) && (raw > hi + eps || (raw >= hi - eps && side * (dRaw - dHi) > 0)); // prettier-ignore
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

/** A regulator's feedback divider, OUT → REF, siemens — an assumption (the
    sheets give none; a few microamps at 5 V). Sourcing only, an unloaded
    regulator had no balance at its output: every voltage at or above its
    target drew nothing, and the solve left OUT mid-bracket — 5.75–6.5 V on
    a 7805, on the probe and its reading alike. */
export const REGULATOR_DIVIDER_S = 1e-6;

/** A regulator's output current, amps INTO its output node: sourced only,
    up to its limit (its divider apart). */
export function regulatorAmps(br, vAt) {
  if (br.off) return 0;
  const i = (regulatorTarget(br, vAt) - vAt(br.out)) / br.reg.rOut;
  return Math.max(0, Math.min(br.reg.limitA, i));
}

/** The headroom, volts, IN above REF, from which a regulator draws its full
    quiescent current (`regulatorQuiescent`) — an assumption. Not its
    dropout: there the quiescent current's corner fell exactly on the one
    where it starts to source with its output still at REF, and the linear
    model read across both at once ran an unloaded output to 840 V. */
export const QUIESCENT_HEAD_V = 1;

/** A regulator's quiescent current, IN → REF, amps: its full figure once
    IN is QUIESCENT_HEAD_V above REF, and below that a straight line through
    zero — a resistance, which carries current back from REF to IN once REF
    is the higher (as the die's substrate does). A fixed current whatever
    the voltage across it had no balance with REF's net returning nowhere (a
    78xx's GND left unwired, or a rectified IN dipping under GND at a zero
    crossing): the solve left that net at quiescentA / GMIN, 5 GV a tick;
    cut off at zero instead, the net was flat to every step and landed
    megavolts away. Below the headroom this is an assumption — the sheets
    give Iq only in regulation. */
export function regulatorQuiescent(br, vAt) {
  if (br.off) return 0;
  const head = (vAt(br.inp) - vAt(br.ref)) / QUIESCENT_HEAD_V;
  return br.reg.quiescentA * Math.min(1, head);
}

/**
 * ∂(a regulator's current into `node`)/∂(the voltage on `t`), siemens, on
 * the piece the move enters (`side`): its output's law and its quiescent
 * line differentiated by hand, as an op-amp's are (`opAmpSlope`). Read a
 * microvolt apart, a 7805 a microvolt or two from where it stops sourcing
 * (a light load through 0.01 Ω) read 2 % of its 100 S — a slope no piece
 * has — and a group's linearization off it ran OUT to kilovolts.
 */
export function regulatorSlope(br, node, t, vAt, side = 1) {
  if (br.off) return 0;
  const { vref, dropoutV, rOut, limitA, quiescentA } = br.reg;
  // The target: its reference above REF, or IN less its dropout — the
  // lower, and on a tie the one the move goes lower by.
  const byRef = vAt(br.ref) + vref;
  const byIn = vAt(br.inp) - dropoutV;
  const dRef = t === br.ref ? 1 : 0;
  const dIn = t === br.inp ? 1 : 0;
  const eps = 1e-12 * Math.max(1, Math.abs(byRef), Math.abs(byIn));
  const useIn = byIn < byRef - eps || (byIn <= byRef + eps && side * (dIn - dRef) < 0); // prettier-ignore
  const dTarget = useIn ? dIn : dRef;
  const lin = ((useIn ? byIn : byRef) - vAt(br.out)) / rOut;
  const dLin = (dTarget - (t === br.out ? 1 : 0)) / rOut;
  // Sourcing between nothing and its limit — on either edge, by the way the
  // move goes.
  const ceps = 1e-12 * limitA;
  const above = lin > ceps || (lin >= -ceps && side * dLin > 0);
  const capped = lin > limitA + ceps || (lin >= limitA - ceps && side * dLin > 0); // prettier-ignore
  const di = above && !capped ? dLin : 0;
  // Its quiescent current: a line through zero up to QUIESCENT_HEAD_V of
  // headroom, flat past it.
  const head = (vAt(br.inp) - vAt(br.ref)) / QUIESCENT_HEAD_V;
  const dHead = ((t === br.inp ? 1 : 0) - (t === br.ref ? 1 : 0)) / QUIESCENT_HEAD_V; // prettier-ignore
  const below = head < 1 - 1e-12 || (head <= 1 + 1e-12 && side * dHead < 0);
  const diq = below ? quiescentA * dHead : 0;
  // Into OUT its current; out of IN that and the quiescent; into REF that;
  // and OUT → REF its divider.
  let g = 0;
  if (node === br.out) g += di;
  if (node === br.inp) g -= di + diq;
  if (node === br.ref) g += diq;
  const dDivider = ((t === br.out ? 1 : 0) - (t === br.ref ? 1 : 0)) * REGULATOR_DIVIDER_S; // prettier-ignore
  if (node === br.out) g -= dDivider;
  if (node === br.ref) g += dDivider;
  return g;
}

/** An electronic load's current, + to −, amps. */
export function loadAmps(br, vAt) {
  return loadLaw(br, vAt(br.pos) - vAt(br.neg)).amps;
}

/**
 * ∂(a load's current into `node`)/∂(the voltage on `t`), siemens, on the
 * piece the move enters (`side`) — by hand, as a regulator's is
 * (`regulatorSlope`): a CV load's 0.01 Ω read a microvolt across its
 * setting is a slope no piece has.
 */
export function loadSlope(br, node, t, vAt, side = 1) {
  const dv = (t === br.pos ? 1 : 0) - (t === br.neg ? 1 : 0);
  if (!dv || (node !== br.pos && node !== br.neg)) return 0;
  const v = vAt(br.pos) - vAt(br.neg);
  let law = loadLaw(br, v);
  // On (or a hair inside) an end of its piece, moving out through it: the
  // neighbour's slope.
  const eps = 1e-12 * Math.max(1, Math.abs(v));
  if (side * dv < 0 && v - law.lo <= eps) law = loadLaw(br, law.lo - eps);
  else if (side * dv > 0 && law.hi - v <= eps) law = loadLaw(br, law.hi);
  // Out of + and into −.
  return (node === br.pos ? -1 : 1) * law.slope * dv;
}

/** What a power supply on its limit pushes out of its + into the circuit,
    amps (back in at its −): its set voltage behind its own resistance, never
    past its limit. */
export function supplyAmps(br, vAt) {
  return Math.min(br.limit, (br.set - (vAt(br.pos) - vAt(br.neg))) / PSU_SOURCE_OHMS); // prettier-ignore
}

/** What an isolated AC supply pushes out of its L into the circuit, amps
    (back in at its N). */
export function isolatedAmps(br, vAt) {
  return (vAt(br.w) - vAt(br.l) + vAt(br.n)) / sourceOhms(br);
}

/** ∂(current an isolated AC supply puts into `node`)/∂V(`t`), siemens —
    `analogCurrents`' "v" entries, differentiated (it is linear). */
export function isolatedSlope(br, node, t) {
  const di = ((t === br.w ? 1 : 0) - (t === br.l ? 1 : 0) + (t === br.n ? 1 : 0)) / sourceOhms(br); // prettier-ignore
  let g = 0;
  if (node === br.l) g += di;
  if (node === br.n) g -= di;
  if (node === br.earth && t === br.earth) g -= 1 / br.earthOhms;
  return g;
}

/** An optocoupler's LED current and its phototransistor's, amps. */
export function optoAmps(br, vAt) {
  const vd = vAt(br.a) - vAt(br.k);
  const led = vd > 0 ? tableCurrent(br.spec.table, vd) : 0;
  const vce = vAt(br.c) - vAt(br.e);
  const sat = Math.max(0, vce - OPTO.kneeV) / OPTO.rsatOhm;
  return { led, out: vce > 0 ? Math.min(br.ctr * optoTransfer(led), sat) : 0 };
}

/** Each terminal's current INTO the network, amps: `[[node, amps], …]`, in
    `analogTerminals`' order (spice/voltages.js reads each against its hole,
    `analogHoles`, by place: a regulator's, OUT first, put OUT's current on
    IN's hole and IN's on GND's — the probe and the wire drop both). */
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
    const iq = regulatorQuiescent(br, vAt);
    const divider = br.off ? 0 : (vAt(br.out) - vAt(br.ref)) * REGULATOR_DIVIDER_S; // prettier-ignore
    return [
      [br.inp, -i - iq],
      [br.ref, iq + divider],
      [br.out, i - divider],
    ];
  }
  if (br.kind === "p") {
    const i = supplyAmps(br, vAt);
    return [
      [br.pos, i],
      [br.neg, -i],
    ];
  }
  if (br.kind === "v") {
    const i = isolatedAmps(br, vAt);
    return [
      [br.l, i],
      [br.n, -i],
      [br.earth, -vAt(br.earth) / br.earthOhms],
    ];
  }
  const i = loadAmps(br, vAt);
  return [
    [br.pos, -i],
    [br.neg, i],
  ];
}

/**
 * The piece a bench device is on (`analogPiece`) as CONSTRAINTS — each a
 * quantity straight in its node voltages (`k` + Σ coef·V(node) over
 * `terms`) and the interval [`lo`, `hi`] it must stay in for the device to
 * stay on that piece — or null where the pieces are no such thing (an
 * optocoupler's transfer). A corner search reads how far inside them the
 * device stands, continuously (spice/network.js `pieceConstraints`).
 * @param {object} br
 * @param {(node: string) => number} vAt
 * @returns {Array<{terms: Array<[string, number]>, k: number, lo: number,
 *   hi: number}>|null}
 */
export function analogConstraints(br, vAt) {
  const below = (q, at) => (q <= at ? [-Infinity, at] : [at, Infinity]);
  const out = [];
  const add = (terms, k, [lo, hi]) => out.push({ terms, k, lo, hi });
  if (br.kind === "g") {
    if (br.off) return out;
    const { vref, dropoutV, rOut, limitA } = br.reg;
    const head = vAt(br.inp) - vAt(br.ref);
    // In dropout (IN less its dropout under REF plus its reference) or not.
    const drop = head <= dropoutV + vref;
    add([[br.inp, 1], [br.ref, -1]], 0, below(head, dropoutV + vref)); // prettier-ignore
    // Its output's region: target − OUT against nothing and its limit.
    const terms = drop ? [[br.inp, 1], [br.out, -1]] : [[br.ref, 1], [br.out, -1]]; // prettier-ignore
    const k = drop ? -dropoutV : vref;
    const lead = k + vAt(terms[0][0]) - vAt(br.out);
    const edge = limitA * rOut;
    add(terms, k, !(lead > 0) ? [-Infinity, 0] : lead >= edge ? [edge, Infinity] : [0, edge]); // prettier-ignore
    // Its quiescent current's line, or its full figure.
    add([[br.inp, 1], [br.ref, -1]], 0, head < QUIESCENT_HEAD_V ? [-Infinity, QUIESCENT_HEAD_V] : [QUIESCENT_HEAD_V, Infinity]); // prettier-ignore
    return out;
  }
  if (br.kind === "a") {
    const { gain, rOut, sourceA, sinkA, lowV, headroomV } = br.amp;
    const low = vAt(br.gnd) + lowV;
    const top = vAt(br.vcc) - headroomV;
    // A swing pinched shut (its supply under its headroom) changes what
    // its pieces mean: no constraints for it.
    if (!(top > low)) return null;
    add([[br.vcc, 1], [br.gnd, -1]], -headroomV - lowV, [0, Infinity]); // prettier-ignore
    // raw = (low + top)/2 + gain·(IN+ − IN−), against each edge.
    const raw = [[br.gnd, 0.5], [br.vcc, 0.5], [br.inp, gain], [br.inn, -gain]]; // prettier-ignore
    const rawK = (lowV - headroomV) / 2;
    const rawV = rawK + 0.5 * vAt(br.gnd) + 0.5 * vAt(br.vcc) + gain * (vAt(br.inp) - vAt(br.inn)); // prettier-ignore
    const overTop = [...raw, [br.vcc, -1]];
    const overLow = [...raw, [br.gnd, -1]];
    const open = topless(br);
    let level;
    let levelK;
    if (rawV >= top && !open) {
      add(overTop, rawK + headroomV, [0, Infinity]);
      level = [[br.vcc, 1]];
      levelK = -headroomV;
    } else if (rawV <= low) {
      if (!open) add(overTop, rawK + headroomV, [-Infinity, 0]);
      add(overLow, rawK - lowV, [-Infinity, 0]);
      level = [[br.gnd, 1]];
      levelK = lowV;
    } else {
      if (!open) add(overTop, rawK + headroomV, [-Infinity, 0]);
      add(overLow, rawK - lowV, [0, Infinity]);
      level = raw;
      levelK = rawK;
    }
    // Its current against its source and sink limits.
    const lvl = levelK + level.reduce((sum, [n, c]) => sum + c * vAt(n), 0);
    const lead = lvl - vAt(br.out);
    const up = sourceA * rOut;
    const down = -sinkA * rOut;
    add([...level, [br.out, -1]], levelK, lead >= up ? [up, Infinity] : lead <= down ? [-Infinity, down] : [down, up]); // prettier-ignore
    return out;
  }
  if (br.kind === "v") return out;
  if (br.kind === "p") {
    const v = vAt(br.pos) - vAt(br.neg);
    add([[br.pos, 1], [br.neg, -1]], 0, below(v, br.set - br.limit * PSU_SOURCE_OHMS)); // prettier-ignore
    return out;
  }
  if (br.kind === "e") {
    const { lo, hi } = loadLaw(br, vAt(br.pos) - vAt(br.neg));
    add([[br.pos, 1], [br.neg, -1]], 0, [lo, hi]); // prettier-ignore
    return out;
  }
  return null;
}

/** Whether a kind conducts between its ends — what a net it alone ties to
    something is held by. */
export function analogConducts(br, vAt) {
  if (br.kind === "o") return optoAmps(br, vAt).out > CONDUCTS_A;
  if (br.kind === "a" && topless(br)) return -opAmpAmps(br, vAt) > CONDUCTS_A;
  if (br.kind === "e") return loadHolds(br, vAt);
  return true;
}

/** The nets a held node holds through this device: a phototransistor's
    collector and emitter while it conducts, an open-collector output and its
    ground while it sinks, a CR load's two ends (a CV load's while it
    regulates). An op-amp or a regulator holds its own output outright
    (`heldOutright`). */
export function analogHeldThrough(br, node, vAt) {
  if (br.kind === "o") {
    if (node !== br.c && node !== br.e) return [];
    return analogConducts(br, vAt) ? [br.c, br.e] : [];
  }
  if (br.kind === "a") {
    if (!topless(br) || (node !== br.out && node !== br.gnd)) return [];
    return analogConducts(br, vAt) ? [br.out, br.gnd] : [];
  }
  if (br.kind === "e") return loadHolds(br, vAt) ? [br.pos, br.neg] : [];
  // An isolated supply's two terminals are held by its sine and its
  // insulation, whatever else reaches them.
  if (br.kind === "v") return [br.l, br.n, br.earth];
  if (br.kind === "p") return [br.pos, br.neg];
  return [];
}

/** The nodes this branch holds outright, as a driving output does: an
    op-amp's and an on regulator's output, a supply on its limit's +, and
    where an isolated AC supply is tied to earth (its terminals through it,
    `analogHeldThrough`). An open collector holds nothing of itself: let go,
    its pin is its pull-up's, or floats with none (`analogHeldThrough`
    while it sinks). */
export function heldOutright(br) {
  if (br.kind === "v") return [br.earth];
  if (br.kind === "p") return [br.pos];
  if (br.kind === "a" && topless(br)) return [];
  return (br.kind === "a" || br.kind === "g") && !br.off ? [br.out] : [];
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
    const region = raw >= hi && !topless(br) ? "h" : raw <= lo ? "l" : "m";
    const i = (opAmpLevel(br, vAt) - vAt(br.out)) / br.amp.rOut;
    const limit = i >= br.amp.sourceA ? "+" : i <= -br.amp.sinkA ? "-" : "";
    return `${region}${limit}|`;
  }
  if (br.kind === "g") {
    if (br.off) return "0|";
    const drop = vAt(br.inp) - br.reg.dropoutV <= vAt(br.ref) + br.reg.vref;
    const i = (regulatorTarget(br, vAt) - vAt(br.out)) / br.reg.rOut;
    const region = !(i > 0) ? "0" : i >= br.reg.limitA ? "l" : "r";
    // The quiescent current's piece: its line, or its full figure.
    const quiet = vAt(br.inp) - vAt(br.ref) < QUIESCENT_HEAD_V ? "q" : "f";
    return `${drop ? "d" : "n"}${region}${quiet}|`;
  }
  if (br.kind === "v") return "v|";
  if (br.kind === "p") return (br.set - (vAt(br.pos) - vAt(br.neg))) / PSU_SOURCE_OHMS >= br.limit ? "c|" : "p|"; // prettier-ignore
  return `${loadLaw(br, vAt(br.pos) - vAt(br.neg)).piece}|`;
}
