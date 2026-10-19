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

// spice/network.js — THE one network solve in Spice Lite (features/
// spice-lite-audit.md, phase B): Kirchhoff's current law at every net of a
// network, by Newton's method. Pure and DOM-free. spice/lamps.js (every LED's
// current, after a settle) and spice/voltages.js (every net's voltage, every
// pass) both solve through it, so there is one statement of how a net's
// voltage follows from what hangs on it.
//
// A network is a set of UNKNOWN nodes (a node is a net, or nets a switched-on
// transistor joins) and the BRANCHES between them and the FIXED nodes around
// them (a supply rail, a bench source, an RC node at its curve's voltage):
//
//   "r"  a resistive element — a resistor, a pot's side, an rnet9 element, a
//        switch channel switched on (its on-resistance): I = ΔV / R;
//   "j"  a junction — an LED or a display segment (spice/leds.js) or a diode
//        or Zener (spice/diodes.js): its exponential curve as a monotone
//        piecewise-linear table (spice/junction-table.js), with a gigaohm of
//        leakage beside it so a net nothing else holds still has a voltage;
//   "q"  a bipolar transistor between its base, collector and emitter,
//   "m"  a MOSFET between its channel's two ends, its gate the voltage it
//        is told (each its grade's part, `model` — spice/transistors.js; a
//        CD4007UB's channel its family's own on-resistance and saturation,
//        `ron`/`isat`, spice/params.js MOSFET), and
//   "s"  a chip's stage that is NOT on the rails (a chip fed through a
//        resistor or a diode, or with its ground lifted): the stage measured
//        from its own supply pin's net (`ref`) rather than from 0 V, its
//        current drawn from (or returned to) the chip's supply pin (`feed`)
//        — so what an output sources really comes in through its VCC —
//        piecewise linear like the rest, their slopes read numerically;
//   "t"  a 74LS gate's phase splitter part-way on while its output is HIGH
//        (spice/output-stage.js `splitterAmps`): a current from the output
//        to the chip's GND, set by the voltage on its lowest input (`ins`,
//        read like a MOSFET's gate — they carry none of it).
//
// and the one-terminal DRIVERS on a node — a chip output as the stage it is
// (spice/output-stage.js), and a TTL input's own bias, which pushes current
// out of the pin while it is held low (spice/params.js `inputBias`). Every
// one of them is monotone in the voltage it is held at, so the network has
// one answer, and Newton's method finds it: the current law linearised where
// the voltages stand, one small dense linear system, stepped (never more than
// LIMIT_V at once, halved while it makes things worse) until every net
// balances to a nanoamp. Warm-started from the caller's last answer, a
// settled desk takes one step. GMIN from every net to ground keeps the
// Jacobian solvable when a net holds nothing but junctions that are off.

import { ledCurrent, ledSlope } from "./leds.js";
import { diodeCurrent, diodeSlope } from "./diodes.js";
import { tableSegment } from "./junction-table.js";
import {
  splitterAmps,
  splitterPiece,
  stageCurrent,
  stageDelivers,
  stagePiece,
  stageSlope,
} from "./output-stage.js";
import { BODY_DIODE, MOSFET } from "./params.js";
import {
  ANALOG_KINDS,
  analogConducts,
  analogCurrents,
  analogEnds,
  analogPiece,
  analogTerminals,
  opAmpSlope,
  opAmpStepCut,
} from "./analog-devices.js";
import {
  BREAKDOWN_OHMS,
  CONDUCTS_A,
  bjtCurrents,
  bjtPiece,
  mosfetCurrent,
  mosfetPiece,
  solveRising,
} from "./transistors.js";

/** A network whose current law holds at every net to within this has been
    solved, amps (a nanoamp). */
export const TOLERANCE_A = 1e-9;

/** The most Newton steps one network takes before it keeps what it has. */
export const MAX_NEWTON = 60;

/** How many Gauss–Seidel passes a stuck Newton step falls back to
    (`newtonSolve`'s `sweep`). */
const SWEEPS = 4;

/** The most a Newton step moves any net at once, volts. */
export const LIMIT_V = 2;

/** How many times a step that made things worse is halved. */
export const BACKTRACKS = 30;

/** A conductance from every net to ground, siemens (a teraohm) — SPICE's
    GMIN, numerical only: it keeps the Jacobian solvable when a net holds
    nothing but junctions that are off. */
export const GMIN_S = 1e-12;

/** The leakage across every junction, siemens (1 GΩ) — numerical, not a
    datasheet figure: it only gives a net with nothing else on it a voltage. */
export const LEAK_S = 1e-9;

/** A Newton step smaller than this is not taken, volts: the solve has
    stopped moving. */
const MIN_STEP_V = 1e-12;

/** A step a device's slope is read over, volts. */
const DEVICE_DV = 1e-6;

/** The rounding of a voltage, relative, with a margin: sixteen ulps. */
const ROUNDING = 16 * Number.EPSILON;

/** Whether a branch is a DEVICE: more than two terminals, or a current that
    is not a function of the voltage across one pair. */
export function isDevice(br) {
  return (
    br.kind === "q" ||
    br.kind === "m" ||
    br.kind === "s" ||
    br.kind === "t" ||
    ANALOG_KINDS.has(br.kind)
  );
}

/** Every node a device's current depends on. */
export function deviceEnds(br) {
  if (br.kind === "q") return [br.b, br.c, br.e];
  if (br.kind === "m") return [br.a, br.b, br.g];
  if (br.kind === "t") return [br.out, br.gnd, ...br.ins];
  if (ANALOG_KINDS.has(br.kind)) return analogEnds(br);
  return [br.out, br.ref, br.feed];
}

/** The nodes a device's current flows through (a MOSFET's gate and an
    off-rail stage's reference draw nothing). */
function deviceTerminals(br) {
  if (br.kind === "q") return [br.b, br.c, br.e];
  if (br.kind === "m") return [br.a, br.b];
  if (br.kind === "t") return [br.out, br.gnd];
  if (ANALOG_KINDS.has(br.kind)) return analogTerminals(br);
  return [br.out, br.feed];
}

/** An off-rail stage as the one-terminal stage it is with its reference
    where `vAt` says. */
function stageAt(br, vAt) {
  return { ...br.stage, volts: vAt(br.ref) + br.offset };
}

/** ∂(an off-rail stage's current into its output)/∂(the output's voltage),
    siemens, as the Newton step reads it: its resistance wherever it
    conducts — saturated included. A saturated stage's TRUE slope is zero,
    and a net that nothing else holds then has none at all: the step asks for
    gigavolts and goes nowhere, where the stage's own resistance points it
    at its answer (a chord, for a curve that only flattens). */
function offStageSlope(br, vAt, v) {
  const st = stageAt(br, vAt);
  const on =
    st.channel || (st.sources ? v < st.volts : br.both || v > st.volts);
  return on ? -1 / st.ohms : 0;
}

/** A device's current into `node` differentiated by the voltage on `t`,
    siemens — read a microvolt UP from where it stands, or down (`side` −1):
    a device sitting on a kink (a junction at its knee) has a slope each way,
    and a step heading the other way needs the other one. */
function deviceSlope(br, node, t, vAt, side = 1) {
  if (br.kind === "s") {
    // i flows into `out` and out of `feed`; it falls with `out` and rises
    // with `ref`.
    const g = offStageSlope(br, vAt, vAt(br.out));
    const sign = node === br.out ? 1 : node === br.feed ? -1 : 0;
    const by = (t === br.out ? g : 0) + (t === br.ref ? -g : 0);
    return sign * by;
  }
  // An op-amp's gain makes a step's read across a corner (`opAmpSlope`).
  if (br.kind === "a") return opAmpSlope(br, node, t, vAt, side);
  const base = deviceInto(br, node, vAt);
  const dv = side * DEVICE_DV;
  const nudged = (n) => (n === t ? vAt(n) + dv : vAt(n));
  return (deviceInto(br, node, nudged) - base) / dv;
}

/** An off-rail stage's current into its output's net at `v` volts. A LOW
    (`both`) is the transistor to the chip's own ground switched on, and
    conducts either way: an output LOW whose ground is lifted to 0.6 V is
    held there, not anywhere between that and the inputs' clamps. */
function offStageCurrent(br, vAt, v) {
  const st = stageAt(br, vAt);
  if (!br.both || v >= st.volts) return stageCurrent(st, v);
  return stageDelivers(st, st.volts - v);
}

/**
 * A three-terminal device's currents INTO the network at each of its
 * terminals, amps, at the voltages `vAt` gives: `[[node, amps], …]`.
 *   "q" (`{b, c, e, pnp, model}`): its grade's bipolar transistor
 *       (spice/transistors.js `bjtCurrents`) — base current, and collector
 *       current through gain, high injection, saturation and breakdown.
 *   "m" (`{a, b, g, p, model}`): its grade's channel (`mosfetCurrent`,
 *       against the source — the lower end for N, the higher for P), its
 *       body diode and breakdown; a CD4007UB's (`array`) a conductance
 *       rising from the threshold to its on-resistance (`ron`), never more
 *       than its saturation current (`isat`). The gate draws nothing.
 *   "s" (`{out, ref, feed, stage, offset}`): a stage whose open-circuit
 *       level is `offset` volts from its reference node, pushing into `out`
 *       what it takes from `feed` (spice/output-stage.js `stageCurrent`).
 *   "t" (`{out, gnd, ins}`): a 74LS splitter's current, `out` to `gnd`.
 */
export function deviceCurrents(br, vAt) {
  if (br.kind === "q") {
    const s = br.pnp ? -1 : 1; // a PNP is an NPN upside down
    const vbe = s * (vAt(br.b) - vAt(br.e));
    const vce = s * (vAt(br.c) - vAt(br.e));
    // Past VCEO it avalanches, collector to emitter, whatever its base does.
    const { ib, ic } = bjtCurrents(br.model, vbe, vce);
    // NPN: current flows IN at base and collector, OUT at the emitter.
    return [
      [br.b, -s * ib],
      [br.c, -s * ic],
      [br.e, s * (ib + ic)],
    ];
  }
  if (br.kind === "s") {
    const i = offStageCurrent(br, vAt, vAt(br.out));
    return [
      [br.out, i],
      [br.feed, -i],
    ];
  }
  if (br.kind === "t") {
    const i = splitterAmps(splitterIn(br, vAt), vAt(br.out) - vAt(br.gnd));
    return [
      [br.out, -i],
      [br.gnd, i],
    ];
  }
  if (ANALOG_KINDS.has(br.kind)) return analogCurrents(br, vAt);
  const va = vAt(br.a);
  const vb = vAt(br.b);
  let i = channelAmps(br, va, vb, vAt(br.g)); // a → b through the channel
  i += bodyAmps(br, va, vb);
  return [
    [br.a, -i],
    [br.b, i],
  ];
}

/** A 74LS splitter's input: its lowest, against the chip's GND. */
function splitterIn(br, vAt) {
  let low = Number.POSITIVE_INFINITY;
  for (const n of br.ins) low = Math.min(low, vAt(n));
  return low - vAt(br.gnd);
}

/** A device's avalanche current past `volts` (its `v` across it the way it
    blocks), amps — none below. */
function breakdownAmps(v, volts) {
  return v > volts ? (v - volts) / BREAKDOWN_OHMS : 0;
}

/** A MOSFET's channel current a → b, amps: a discrete one its grade's
    (square law from the source — the lower end for N, the higher for P —
    behind its drain resistance), a CD4007UB's its family's line. Current
    always runs from the higher end to the lower. */
function channelAmps(br, va, vb, vg) {
  if (br.array || !br.model) {
    let i = mosfetConductance(br, va, vb, vg) * (va - vb);
    if (Math.abs(i) > (br.isat ?? Infinity)) i = Math.sign(i) * br.isat;
    return i;
  }
  const hi = Math.max(va, vb);
  const lo = Math.min(va, vb);
  const vgs = br.p ? hi - vg : vg - lo;
  const id = mosfetCurrent(br.model, vgs, hi - lo);
  return va >= vb ? id : -id;
}

/** What a discrete MOSFET carries a → b (source → drain, spice/voltages.js
    `devices`) beside its channel: its body diode (source to drain for an
    N-channel part, drain to source for a P) and its drain–source avalanche.
    A CD4007UB's channels have neither here: their diodes go to the
    package's substrate. */
function bodyAmps(br, va, vb) {
  if (br.array) return 0;
  const forward = br.p ? vb - va : va - vb; // across the body diode
  const body = forward > BODY_DIODE.kneeV ? (forward - BODY_DIODE.kneeV) / BODY_DIODE.rdOhm : 0; // prettier-ignore
  const blocked = breakdownAmps(-forward, br.model.vbrV);
  // N: the diode carries a → b, the avalanche b → a; a P the reverse.
  return br.p ? blocked - body : body - blocked;
}

/** Which of its own pieces a device's diode and avalanche are on: "" while
    neither conducts, else a letter each (pieces' corners). */
function bodyPiece(br, va, vb) {
  if (br.kind === "q") return "";
  if (br.array) return "";
  const forward = br.p ? vb - va : va - vb;
  return (
    (forward > BODY_DIODE.kneeV ? "d" : "") +
    (-forward > br.model.vbrV ? "v" : "")
  );
}

/** A MOSFET's channel conductance, siemens, for its ends at `va`/`vb` and
    its gate at `vg`. */
export function mosfetConductance(br, va, vb, vg) {
  const over = br.p ? Math.max(va, vb) - vg : vg - Math.min(va, vb);
  const on = (over - MOSFET.vthV) / MOSFET.fullOnV;
  return on > 0 ? Math.min(1, on) / (br.ron ?? MOSFET.rdsOnOhm) : 0;
}

/** Whether a device conducts end to end at these voltages — what a net it
    alone ties to something is held by. */
export function deviceConducts(br, vAt) {
  if (br.kind === "q") {
    const s = br.pnp ? -1 : 1;
    const { tf, over } = bjtCurrents(
      br.model,
      s * (vAt(br.b) - vAt(br.e)),
      s * (vAt(br.c) - vAt(br.e)),
    );
    return tf > CONDUCTS_A || over > 0;
  }
  if (br.kind === "s") return offStageCurrent(br, vAt, vAt(br.out)) !== 0;
  // A splitter's microamps hold nothing.
  if (br.kind === "t") return false;
  if (ANALOG_KINDS.has(br.kind)) return analogConducts(br, vAt);
  const va = vAt(br.a);
  const vb = vAt(br.b);
  if (br.array || !br.model) return mosfetConductance(br, va, vb, vAt(br.g)) > 0; // prettier-ignore
  const vgs = br.p
    ? Math.max(va, vb) - vAt(br.g)
    : vAt(br.g) - Math.min(va, vb);
  return vgs > br.model.vtoV || bodyAmps(br, va, vb) !== 0;
}

/** The current a device puts INTO `node`, amps. */
function deviceInto(br, node, vAt) {
  let sum = 0;
  for (const [n, amps] of deviceCurrents(br, vAt)) if (n === node) sum += amps;
  return sum;
}

/** What an inductor branch ("l": `{a, b, amps}`) puts into `node`, amps: a
    current source of its current, from `a` to `b` through the coil — its
    state, which no solve moves (spice/inductors.js). */
function coilInto(br, node) {
  if (br.a === node) return br.a === br.b ? 0 : -br.amps;
  return br.b === node ? br.amps : 0;
}

/** A junction branch's current for `vd` volts across it (anode less
    cathode), amps: an LED's or a diode's. */
export function junctionCurrent(br, vd) {
  return br.diode ? diodeCurrent(br.spec, vd) : ledCurrent(br.spec, vd);
}

/** ∂(junctionCurrent)/∂vd, siemens. */
export function junctionSlope(br, vd) {
  return br.diode ? diodeSlope(br.spec, vd) : ledSlope(br.spec, vd);
}

/** Which piece of its curve a junction is on at `vd`: "0" off, "r" broken
    down backwards (a Zener), else the segment of its table
    (spice/junction-table.js) — every sample of the curve a corner. */
export function junctionPiece(br, vd) {
  if (br.diode && br.spec.zenerV > 0 && -vd > br.spec.zenerV) return "r";
  const k = tableSegment(br.spec.table, vd);
  return k < 0 ? "0" : String.fromCharCode(97 + k);
}

/**
 * Which piece of its characteristic every element of a SOLVED network is on —
 * each stage off, linear or saturated; each junction off, forward or broken
 * down; each transistor's channel or junction off or on, a bipolar one active
 * or saturated, a MOSFET part-way or fully on — as one string. Two states of
 * a network with one string are joined by straight lines in everything it
 * does: where the string changes is a CORNER.
 * @param {{drivers: Map, branches: Array, fixed: Map, volts: Map}} net
 * @returns {string}
 */
export function pieces({ drivers, branches, fixed, volts }) {
  return piecesBy(
    drivers,
    branches,
    (node) => fixed.get(node) ?? volts.get(node) ?? 0,
  );
}

/**
 * `pieces`, reading each node's voltage through `vAt` — so a caller sampling
 * a network at many states (spice/voltages.js `linearizeGroup`'s `piecesAt`,
 * a corner search's ~100 samples) overlays the few nodes that move instead
 * of copying the network's maps every sample (features/11-pieces-scratch.md).
 * @param {Map<string, object[]>} drivers
 * @param {object[]} branches
 * @param {(node: string) => number} vAt
 */
export function piecesBy(drivers, branches, vAt) {
  let out = "";
  for (const [node, list] of drivers) {
    const v = vAt(node);
    for (const st of list) out += stagePiece(st, v);
  }
  for (const br of branches) {
    if (br.kind === "j") {
      out += junctionPiece(br, vAt(br.a) - vAt(br.b));
    } else if (br.kind === "q") {
      const s = br.pnp ? -1 : 1;
      // A device's fragment varies in length: ended, so no two pieces of a
      // network read alike.
      out += `${bjtPiece(br.model, s * (vAt(br.b) - vAt(br.e)), s * (vAt(br.c) - vAt(br.e)))}|`; // prettier-ignore
    } else if (br.kind === "m") {
      const va = vAt(br.a);
      const vb = vAt(br.b);
      const over = br.p
        ? Math.max(va, vb) - vAt(br.g)
        : vAt(br.g) - Math.min(va, vb);
      if (br.array || !br.model) {
        const on = (over - MOSFET.vthV) / MOSFET.fullOnV;
        const g = mosfetConductance(br, va, vb, vAt(br.g));
        out += on > 0 ? (Math.abs(g * (va - vb)) >= (br.isat ?? Infinity) ? "3" : on >= 1 ? "2" : "1") : "0"; // prettier-ignore
      } else {
        out += mosfetPiece(br.model, over, Math.abs(va - vb));
      }
      out += bodyPiece(br, va, vb) + "|";
    } else if (ANALOG_KINDS.has(br.kind)) {
      out += analogPiece(br, vAt);
    } else if (br.kind === "t") {
      out += splitterPiece(splitterIn(br, vAt), vAt(br.out) - vAt(br.gnd));
    } else if (br.kind === "s") {
      const st = stageAt(br, vAt);
      const v = vAt(br.out);
      // A channel's pieces run both ways (its chords, its limit each way).
      out += br.both && !st.channel && v < st.volts ? "r" : stagePiece(st, v);
    }
  }
  return out;
}

/** The branch kinds `pieces` reads a piece off — kept in step with it. */
const PIECEWISE_KINDS = new Set(["j", "q", "m", "s", "t", ...ANALOG_KINDS]);

/**
 * Whether a network has anything with pieces at all (`pieces`): a stage or a
 * piecewise branch. One with none is linear everywhere — its `pieces` string
 * is the same at every voltage, so it has no corner to look for.
 * @param {{drivers: Map, branches: Array}} net
 */
export function hasPieces({ drivers, branches }) {
  for (const list of drivers.values()) if (list.length) return true;
  return branches.some((br) => PIECEWISE_KINDS.has(br.kind));
}

/**
 * Index the branches by the nodes they touch.
 * @param {Array<object>} branches
 * @returns {Map<string, Array<object>>}
 */
export function touchingOf(branches) {
  const touching = new Map();
  for (const br of branches) {
    const nodes = isDevice(br) ? deviceTerminals(br) : [br.a, br.b];
    for (const node of new Set(nodes)) {
      let list = touching.get(node);
      if (!list) touching.set(node, (list = []));
      list.push(br);
    }
  }
  return touching;
}

/**
 * Newton's method over the unknown `nodes` of ONE network, in place: `volts`
 * holds each one's starting guess and gets its answer.
 * @param {object} net
 * @param {string[]} net.nodes - the unknowns
 * @param {Map<string, Array<object>>} net.touching - node → branches
 * @param {Map<string, Array<object>>} net.drivers - node → stages
 * @param {Map<string, number>} net.fixed - node → volts, the given ones
 * @param {Map<string, number>} net.volts - node → volts, guessed then solved
 * @param {number} [net.swingDepth] - how many `swingRetry`s this solve is
 *   nested in (each holds one op-amp; past `MAX_SWING_DEPTH` none is tried)
 * @returns {boolean} whether it balanced (to `tolerance`): a network the
 *   solve could not balance stops where it stands, which a second solve from
 *   there may move on from
 */
export function newtonSolve({
  nodes,
  touching,
  drivers,
  fixed,
  volts,
  tolerance = TOLERANCE_A,
  swingDepth = 0,
}) {
  if (!nodes.length) return true;
  const vAt = (node) => fixed.get(node) ?? volts.get(node) ?? 0;
  const into = (node, v) => {
    let sum = 0;
    for (const br of touching.get(node) ?? []) {
      if (isDevice(br)) {
        sum += deviceInto(br, node, (n) => (n === node ? v : vAt(n)));
      } else if (br.kind === "r") {
        sum += (vAt(br.a === node ? br.b : br.a) - v) / br.ohms;
      } else if (br.kind === "l") {
        sum += coilInto(br, node);
      } else if (br.a === node) {
        const other = vAt(br.b);
        sum -= junctionCurrent(br, v - other) + (v - other) * LEAK_S;
      } else {
        const other = vAt(br.a);
        sum += junctionCurrent(br, other - v) + (other - v) * LEAK_S;
      }
    }
    for (const stage of drivers.get(node) ?? []) sum += stageCurrent(stage, v);
    return sum - GMIN_S * v;
  };
  const size = (f) => {
    let m = 0;
    for (const x of f) m = Math.max(m, Math.abs(x));
    return m;
  };

  // One unknown: a scalar Newton — the commonest network there is (an output
  // and the inputs it drives), and no matrix to build for it.
  if (nodes.length === 1) {
    const node = nodes[0];
    let v = volts.get(node);
    let f = into(node, v);
    for (let step = 0; step < MAX_NEWTON && Math.abs(f) > tolerance; step++) {
      let g = -GMIN_S;
      for (const br of touching.get(node) ?? []) {
        if (isDevice(br)) {
          g += deviceSlope(br, node, node, (n) => (n === node ? v : vAt(n)));
        } else if (br.kind === "r") g -= 1 / br.ohms;
        else if (br.kind === "l") continue;
        else {
          const vd = br.a === node ? v - vAt(br.b) : vAt(br.a) - v;
          g -= junctionSlope(br, vd) + LEAK_S;
        }
      }
      for (const stage of drivers.get(node) ?? []) g += stageSlope(stage, v);
      if (!(g < 0)) g = -GMIN_S;
      let dv = -f / g;
      if (Math.abs(dv) > LIMIT_V) dv = Math.sign(dv) * LIMIT_V;
      const before = Math.abs(f);
      let t = 1;
      let next;
      for (let k = 0; ; k++) {
        next = into(node, v + t * dv);
        // No worse is good enough: where every stage on the net is saturated
        // or off, the current is FLAT, and a step across the flat is progress
        // the residual cannot show.
        if (Math.abs(next) <= before || k >= BACKTRACKS) break;
        t /= 2;
      }
      // A step too small to matter is not TAKEN: the answer is then a fixed
      // point of the solve, so solving it again from where it stands — a
      // network nothing moved in, re-solved — lands exactly there.
      if (Math.abs(t * dv) < MIN_STEP_V) break;
      v += t * dv;
      f = next;
    }
    volts.set(node, v);
    return Math.abs(f) <= tolerance;
  }

  const index = new Map(nodes.map((node, k) => [node, k]));
  /** ∂(current into `node`)/∂(its own voltage), and the same for each
      unknown neighbour — the network's Jacobian row. */
  const slopes = (node, row, side) => {
    const v = volts.get(node);
    let self = -GMIN_S;
    const add = (other, g) => {
      self -= g;
      const k = index.get(other);
      if (k != null) row[k] += g;
    };
    for (const br of touching.get(node) ?? []) {
      if (isDevice(br)) {
        // ∂(current into node)/∂(each terminal's voltage).
        for (const t of new Set(deviceEnds(br))) {
          const d = deviceSlope(br, node, t, vAt, side);
          if (t === node) self += d;
          else {
            const k = index.get(t);
            if (k != null) row[k] += d;
          }
        }
      } else if (br.kind === "r") {
        add(br.a === node ? br.b : br.a, 1 / br.ohms);
      } else if (br.kind === "l") {
        continue;
      } else {
        const vd = br.a === node ? v - vAt(br.b) : vAt(br.a) - v;
        add(br.a === node ? br.b : br.a, junctionSlope(br, vd) + LEAK_S);
      }
    }
    for (const stage of drivers.get(node) ?? []) self += stageSlope(stage, v);
    row[index.get(node)] += self;
  };
  const residual = () => nodes.map((node) => into(node, volts.get(node)));
  // The op-amps among the network's devices, whose corners a step stops at.
  const opAmps = [];
  for (const list of touching.values()) {
    for (const br of list) if (br.kind === "a" && !opAmps.includes(br)) opAmps.push(br); // prettier-ignore
  }
  // How well each net's current law CAN be met: an op-amp's output in its
  // linear band answers the rounding of its inputs' voltages times its
  // transconductance (gain / rOut — 5000 S for an LM358: picoamps), far over
  // the femtoamps a coil's cluster is solved to; held to the tolerance there,
  // a network never balances and falls back to its sweeps every solve. So
  // each residual is read against the larger of the two (`err`), every other
  // net's exactly as before.
  const scale = nodes.map((node) => {
    let floor = 0;
    for (const br of opAmps) {
      if (br.out !== node) continue;
      const big = Math.max(1, Math.abs(vAt(br.vcc)), Math.abs(vAt(br.gnd)));
      floor += (br.amp.gain / br.amp.rOut) * ROUNDING * big;
    }
    return floor > tolerance ? tolerance / floor : 1;
  });
  /** A residual's size against what each net can be balanced to. */
  const err = (r) => {
    let m = 0;
    for (let i = 0; i < r.length; i++) m = Math.max(m, Math.abs(r[i]) * scale[i]); // prettier-ignore
    return m;
  };
  let f = residual();
  newton();
  // Out of balance with an op-amp in the network: retried from its output at
  // each edge of its swing (`swingRetry`) before anything slower.
  if (err(f) > tolerance && opAmps.length && swingDepth < MAX_SWING_DEPTH) swingRetry(); // prettier-ignore
  // Still out of balance after every step it had — a steep device the
  // linear steps crawl along (a Darlington guessed on, its base and
  // collector both mid-supply): a sweep from where it stopped, and the
  // steps again from there.
  if (err(f) > tolerance) {
    const swept = sweep(err(f));
    if (swept) {
      f = swept;
      newton();
    }
  }
  if (err(f) <= tolerance && gainDevices(touching) >= 2 && unstable()) {
    fallOff();
  }
  return err(f) <= tolerance;

  /**
   * Newton again from each op-amp's output stood at the near edge of its
   * swing, then the far one — near first, since inside a Schmitt trigger's
   * band BOTH are balances, and the one it was in is the one it holds. A
   * Schmitt trigger whose input has just crossed
   * a threshold has lost the state it was in: the one it snaps to is a whole
   * swing away, the band between is unstable, and every step from the corner
   * it stands on points back across it — but with the output held at an
   * edge the rest of the network is solved without it, and from there, on a
   * saturated piece whose output no longer answers its inputs, Newton is a
   * step or two from the balance, wherever it is. Kept where it balances (and
   * holds, with gain enough for a knife-edge); else the nets go back as they
   * were.
   */
  function swingRetry() {
    const from = nodes.map((node) => volts.get(node));
    const fromF = f;
    // Only an op-amp whose output is one of this solve's unknowns (one a
    // retry further out holds is not), so the cap counts those.
    const free = opAmps.filter((br) => index.has(br.out));
    for (const br of free.slice(0, MAX_SWING_RETRIES)) {
      const lo = vAt(br.gnd) + br.amp.lowV;
      const hi = Math.max(lo, vAt(br.vcc) - br.amp.headroomV);
      const near = Math.abs(volts.get(br.out) - lo) < Math.abs(volts.get(br.out) - hi) ? lo : hi; // prettier-ignore
      for (const edge of near === lo ? [lo, hi] : [hi, lo]) {
        // The rest of the network balanced with the output HELD at the
        // edge — its inputs where that output puts them — then let go.
        nodes.forEach((node, i) => volts.set(node, from[i]));
        newtonSolve({
          nodes: nodes.filter((node) => node !== br.out),
          touching,
          drivers,
          fixed: new Map([...fixed, [br.out, edge]]),
          volts,
          tolerance,
          swingDepth: swingDepth + 1,
        });
        volts.set(br.out, edge);
        f = residual();
        newton();
        if (err(f) <= tolerance && !(gainDevices(touching) >= 2 && unstable())) return; // prettier-ignore
      }
    }
    nodes.forEach((node, i) => volts.set(node, from[i]));
    f = fromF;
  }

  /** The Jacobian where the nets stand, each device read upward. */
  function jacobianHere() {
    const jacobian = nodes.map(() => new Float64Array(nodes.length));
    nodes.forEach((node, k) => slopes(node, jacobian[k], 1));
    return jacobian;
  }

  /**
   * Is the balance the nets stand at one they would fall OFF — the knife-edge
   * of a bistable pair (two transistors cross-coupled), every one of them
   * half on? Newton finds a balance, not a stable one, and from a symmetric
   * guess it lands on exactly that edge: both collectors at a volt, both
   * outputs read LOW, a flip-flop that never flips. With a capacitance on
   * every net the balance is stable only where every eigenvalue of the
   * Jacobian has a negative real part, so then the sign of its determinant
   * is (−1)ⁿ; a sign the other way is an odd number of runaway modes.
   */
  function unstable() {
    const sign = determinantSign(jacobianHere());
    return sign !== 0 && sign !== (nodes.length % 2 ? -1 : 1);
  }

  /**
   * Off the knife-edge into a balance that holds, the way the circuit itself
   * falls. With a unit capacitance on every net its dynamics run along the
   * edge's RUNAWAY mode (`runawayMode`): a nudge that way (`TIP_V`, signed so
   * the first net goes down — or, if that leaves it standing, up; the first
   * net as the logic engine's tie-break counts them, so a cold flip-flop comes
   * up the same way in both engines, sim/engine.js `solve`), then
   * backward-Euler steps of those dynamics (a conductance `g` from each net to
   * where it was) — kept short while they run away along the mode, lengthened
   * once clear of the edge — and Newton's steps from where they come to rest.
   * Kept only where that lands on a balance that holds; else the nets go back
   * to the edge. Every step is fixed, so it always falls the same way.
   */
  function fallOff() {
    const edge = nodes.map((node) => volts.get(node));
    // The first steps short beside the fastest mode there is (no eigenvalue
    // exceeds the Jacobian's largest row sum): a step as long as the runaway
    // mode is fast turns it round, and the circuit falls the wrong way.
    let g0 = GMIN_S;
    for (const row of jacobianHere()) {
      let sum = 0;
      for (const x of row) sum += Math.abs(x);
      g0 = Math.max(g0, 4 * sum);
    }
    const mode = runawayMode(jacobianHere(), g0);
    const lead = mode?.findIndex((x) => Math.abs(x) > 1e-9) ?? -1;
    if (lead < 0) return;
    for (const sign of [1, -1]) {
      // Signed so the first net it moves goes down (then up).
      const dir = mode.map((x) => (mode[lead] > 0 ? -x : x) * sign);
      const along = () =>
        nodes.reduce(
          (sum, node, i) => sum + (volts.get(node) - edge[i]) * dir[i],
          0,
        );
      nodes.forEach((node, i) => volts.set(node, edge[i] + TIP_V * dir[i]));
      let g = g0;
      let gone = along();
      for (let step = 0; step < FALL_STEPS && g < 1 / GMIN_S; step++) {
        const before = nodes.map((node) => volts.get(node));
        if (!stepBack(before, g)) break;
        let moved = 0;
        let away = 0;
        nodes.forEach((node, i) => {
          moved = Math.max(moved, Math.abs(volts.get(node) - before[i]));
          away = Math.max(away, Math.abs(volts.get(node) - edge[i]));
        });
        const now = along();
        // Near the edge a step must carry it further along the mode — a
        // step as long as the mode is fast turns it back — so one that does
        // not is taken again shorter; clear of the edge every mode left
        // decays, and longer steps get there sooner.
        if (now <= 0 || (away <= CLEAR_V && now <= gone)) {
          nodes.forEach((node, i) => volts.set(node, before[i]));
          g *= 4;
          continue;
        }
        gone = now;
        g = Math.max(away > CLEAR_V ? g / 2 : g / 1.5, GMIN_S);
        if (away > CLEAR_V && moved < REST_V) break;
      }
      f = residual();
      newton();
      if (err(f) <= tolerance && !unstable()) return;
      nodes.forEach((node, i) => volts.set(node, edge[i]));
    }
    f = residual();
  }

  /** One backward-Euler step from `before` with a conductance `g` from each
      net to where it was: whether it balanced. */
  function stepBack(before, g) {
    for (let k = 0; k < MAX_NEWTON; k++) {
      const step = nodes.map(
        (node, i) => into(node, volts.get(node)) + g * (before[i] - volts.get(node)), // prettier-ignore
      );
      if (err(step) <= tolerance) return true;
      const jacobian = jacobianHere();
      for (let i = 0; i < nodes.length; i++) jacobian[i][i] -= g;
      const dv = gaussSolve(
        jacobian,
        step.map((x) => -x),
      );
      if (!dv) return false;
      const big = size(dv);
      const t = big > LIMIT_V ? LIMIT_V / big : 1;
      nodes.forEach((node, i) => volts.set(node, volts.get(node) + t * dv[i]));
    }
    return true;
  }

  /** Newton's steps from where the nets stand, until they balance. */
  function newton() {
    for (let step = 0; step < MAX_NEWTON && err(f) > tolerance; step++) {
      const from = nodes.map((node) => volts.get(node));
      // The step, with each device's slopes read up from where it stands —
      // or, when that step gained nothing, read down (a transistor stopped a
      // microvolt under its knee: read upward it is ON, and the step that
      // slope asks for only makes things worse). Neither gaining, the upward
      // one stands (no worse is still a step across a flat).
      let move = newtonStep(1);
      if (move && !move.gained) {
        const up = nodes.map((node) => volts.get(node));
        nodes.forEach((node, i) => volts.set(node, from[i]));
        const down = newtonStep(-1);
        if (down?.gained) move = down;
        else nodes.forEach((node, i) => volts.set(node, up[i]));
      }
      if (!move?.gained) {
        // Neither step gained: the nets are coupled through a steep device
        // the linear step mispredicts — a Darlington switched off with its
        // collector on a load, whose base step throws the collector's current
        // out by amps. Balance each net on its own against the rest instead
        // (a Gauss–Seidel sweep: each net's current falls as it rises), and
        // take that if it gains; else as before.
        const after = nodes.map((node) => volts.get(node));
        nodes.forEach((node, i) => volts.set(node, from[i]));
        const swept = sweep(err(f));
        if (swept) {
          f = swept;
          continue;
        }
        nodes.forEach((node, i) => volts.set(node, after[i]));
      }
      if (!move) break;
      // As above: a step too small to matter is not taken.
      if (move.t * size(move.dir) < MIN_STEP_V) {
        nodes.forEach((node, i) => volts.set(node, from[i]));
        break;
      }
      f = move.next;
    }
  }

  /** Up to SWEEPS Gauss–Seidel passes from where the nets stand, each net
      moved to where the current into it balances with the rest held: the
      residual it leaves, or null (the nets put back) if no better than
      `before`. */
  function sweep(before) {
    const from = nodes.map((node) => volts.get(node));
    let next = null;
    for (let pass = 0; pass < SWEEPS; pass++) {
      for (const node of nodes) {
        const v0 = volts.get(node);
        volts.set(
          node,
          solveRising((v) => -into(node, v), v0 - 1, v0 + 1),
        );
      }
      next = residual();
      if (err(next) <= tolerance) break;
    }
    if (err(next) < before) return next;
    nodes.forEach((node, i) => volts.set(node, from[i]));
    return null;
  }

  /** One Newton step from where the nets stand, its device slopes read
      toward `side`: the move taken (the nets left there), or null when the
      Jacobian is singular. */
  function newtonStep(side) {
    const jacobian = nodes.map(() => new Float64Array(nodes.length));
    nodes.forEach((node, k) => slopes(node, jacobian[k], side));
    const dv = gaussSolve(
      jacobian,
      f.map((x) => -x),
    );
    if (!dv) return null;
    // A junction's knee is a corner the linear step can overshoot: never
    // move a net more than LIMIT_V at once, and halve the step while it
    // makes the residual worse.
    const from = nodes.map((node) => volts.get(node));
    const before = err(f);
    const along = (dir, t0) => {
      let t = t0;
      for (let k = 0; ; k++) {
        nodes.forEach((node, i) => volts.set(node, from[i] + t * dir[i]));
        const next = residual();
        const now = err(next);
        if (now <= before || k >= BACKTRACKS) return { dir, t, next, gained: now < before }; // prettier-ignore
        t /= 2;
      }
    };
    const big = size(dv);
    let t0 = big > LIMIT_V ? LIMIT_V / big : 1;
    // Never across an op-amp's corner in one step (`opAmpStepCut`).
    for (const br of opAmps) {
      t0 = Math.min(t0, opAmpStepCut(br, vAt, (node) => dv[index.get(node)] ?? 0)); // prettier-ignore
    }
    let move = along(dv, t0);
    if (!move.gained && big > LIMIT_V) {
      // Scaling the whole step to its largest net can leave every net
      // stuck: a net nothing but a saturated stage feeds has no slope, asks
      // for gigavolts, and shrinks everyone else's share to nothing. Limit
      // each net on its own instead (as SPICE limits each junction).
      const each = dv.map((x) => Math.max(-LIMIT_V, Math.min(LIMIT_V, x)));
      const tried = along(each, 1);
      if (tried.gained) move = tried;
      else
        nodes.forEach((node, i) => volts.set(node, from[i] + move.t * dv[i]));
    }
    return move;
  }
}

/** The most op-amps `swingRetry` stands at their swing's edges, in turn. */
const MAX_SWING_RETRIES = 4;
/** How deep `swingRetry`s nest: a retry's own solve may retry the op-amps
    it does not hold, once — two op-amps that must both snap are found, but a
    cluster of many that will not balance is not tried edge by edge in every
    order (2 × 4 attempts, each 2 × 3 more, each … — hundreds of solves). */
const MAX_SWING_DEPTH = 2;

/** How far `fallOff` nudges a balance off its knife-edge, volts. */
const TIP_V = 0.01;

/** How far from the edge a falling network counts as clear of it, volts. */
const CLEAR_V = 0.5;

/** A falling network whose step moves no net more than this is at rest,
    volts. */
const REST_V = 1e-6;

/** The most backward-Euler steps `fallOff` takes one way. */
const FALL_STEPS = 400;

/** How many transistors a network holds — the parts with GAIN, two of which
    can make a pair with two balances and a knife-edge between them — an
    op-amp counting as two: fed back to its own + input (a Schmitt trigger)
    it is such a pair by itself, its knife-edge the middle of its band. */
function gainDevices(touching) {
  const seen = new Set();
  let opAmps = 0;
  for (const list of touching.values()) {
    for (const br of list) {
      if (seen.has(br)) continue;
      if (br.kind === "q" || br.kind === "m") seen.add(br);
      else if (br.kind === "a") {
        seen.add(br);
        opAmps++;
      }
    }
  }
  return seen.size + opAmps;
}

/**
 * A balance of `residual` (x → the current INTO each coordinate, amps, which
 * falls as it rises — `newtonSolve`'s convention) moved OFF a knife-edge onto
 * one that holds, or null where `x0` already holds (or nothing better is
 * found). The same fall as `newtonSolve`'s `fallOff`, for a system the solve
 * cannot see whole: slopes read `dx` apart, a nudge down the runaway mode the
 * first coordinate's way (then up), backward-Euler steps of a unit
 * capacitance on each coordinate, then Newton's from where they rest. A
 * flasher's two capacitors, each holding its charge, are a flip-flop between
 * their plate pairs — powered up even, it stood on that edge for 0.2 s.
 * @param {(x: Float64Array) => number[]} residual
 * @param {Float64Array} x0 - a balance (`residual` ≈ 0 there)
 * @param {{dx?: number, tolerance?: number}} [opts]
 * @returns {Float64Array|null}
 */
export function fallOffBalance(
  residual,
  x0,
  { dx = 1e-6, tolerance = 1e-9 } = {},
) {
  const n = x0.length;
  const size = (f) => f.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  /** `fx`'s slopes at `x` (where it is `f`), each read `dx` up. */
  const jacobianOf = (fx, x, f) => {
    const j = Array.from({ length: n }, () => new Float64Array(n));
    for (let c = 0; c < n; c++) {
      const y = Float64Array.from(x);
      y[c] += dx;
      const fy = fx(y);
      for (let r = 0; r < n; r++) j[r][c] = (fy[r] - f[r]) / dx;
    }
    return j;
  };
  const holds = (x, f) => {
    const sign = determinantSign(jacobianOf(residual, x, f));
    return sign === 0 || sign === (n % 2 ? -1 : 1);
  };
  const f0 = residual(x0);
  if (holds(x0, f0)) return null;
  const j0 = jacobianOf(residual, x0, f0);
  let g0 = 0;
  for (const row of j0) {
    let sum = 0;
    for (const x of row) sum += Math.abs(x);
    g0 = Math.max(g0, 4 * sum);
  }
  if (!(g0 > 0)) return null;
  const mode = runawayMode(
    j0.map((row) => Float64Array.from(row)),
    g0,
  );
  const lead = mode?.findIndex((x) => Math.abs(x) > 1e-9) ?? -1;
  if (lead < 0) return null;
  // Newton's steps on `fx(x) = 0` from `x`, each halved until it gains.
  const settle = (fx, x) => {
    let f = fx(x);
    for (let k = 0; k < MAX_NEWTON && size(f) > tolerance; k++) {
      const step = gaussSolve(
        jacobianOf(fx, x, f),
        f.map((v) => -v),
      );
      if (!step) break;
      const big = size(step);
      let t = big > LIMIT_V ? LIMIT_V / big : 1;
      let next = null;
      let y = null;
      for (let h = 0; h < BACKTRACKS; h++) {
        y = x.map((v, i) => v + t * step[i]);
        next = fx(y);
        if (size(next) < size(f)) break;
        t /= 2;
      }
      if (!(size(next) < size(f))) break;
      x = y;
      f = next;
    }
    return { x, f };
  };
  for (const sign of [1, -1]) {
    const dir = mode.map((v) => (mode[lead] > 0 ? -v : v) * sign);
    const along = (x) => x.reduce((sum, v, i) => sum + (v - x0[i]) * dir[i], 0);
    let x = x0.map((v, i) => v + TIP_V * dir[i]);
    let g = g0;
    let gone = along(x);
    for (let step = 0; step < FALL_STEPS && g < 1 / GMIN_S; step++) {
      const before = x;
      const back = settle(
        (y) => residual(y).map((v, i) => v + g * (before[i] - y[i])),
        before,
      );
      const now = along(back.x);
      let away = 0;
      let moved = 0;
      back.x.forEach((v, i) => {
        away = Math.max(away, Math.abs(v - x0[i]));
        moved = Math.max(moved, Math.abs(v - before[i]));
      });
      if (now <= 0 || (away <= CLEAR_V && now <= gone)) {
        g *= 4;
        continue;
      }
      x = back.x;
      gone = now;
      g = Math.max(away > CLEAR_V ? g / 2 : g / 1.5, GMIN_S);
      if (away > CLEAR_V && moved < REST_V) break;
    }
    const end = settle(residual, x);
    if (size(end.f) <= tolerance && holds(end.x, end.f))
      return Float64Array.from(end.x);
  }
  return null;
}

/**
 * The direction a balance runs away in — the eigenvector of the Jacobian `j`
 * whose eigenvalue is positive, scaled to a largest component of 1 — or
 * null. Read off backward Euler's own step, `g(gI − J)⁻¹` (`g` beyond every
 * eigenvalue): it grows that mode (by 1/(1 − λ/g) > 1) and shrinks every
 * other, so the step taken over and over — squared, 2⁴⁰ steps in forty
 * products — leaves that mode alone in every column.
 */
export function runawayMode(j, g) {
  const n = j.length;
  let m = [];
  for (let col = 0; col < n; col++) {
    const a = j.map((row, r) =>
      Float64Array.from(row, (x, c) => (r === c ? g - x : -x)),
    );
    const x = gaussSolve(
      a,
      Array.from({ length: n }, (_, r) => (r === col ? g : 0)),
    );
    if (!x) return null;
    m.push(x);
  }
  // m[col][row]: columns; transpose to rows.
  m = Array.from({ length: n }, (_, r) =>
    Float64Array.from({ length: n }, (_, c) => m[c][r]),
  );
  for (let k = 0; k < 40; k++) {
    const sq = m.map(() => new Float64Array(n));
    let big = 0;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        let sum = 0;
        for (let i = 0; i < n; i++) sum += m[r][i] * m[i][c];
        sq[r][c] = sum;
        big = Math.max(big, Math.abs(sum));
      }
    }
    if (!(big > 0) || !Number.isFinite(big)) return null;
    for (const row of sq) for (let c = 0; c < n; c++) row[c] /= big;
    m = sq;
  }
  // The column that carries the most of it.
  let best = 0;
  let bestNorm = -1;
  for (let c = 0; c < n; c++) {
    let norm = 0;
    for (let r = 0; r < n; r++) norm = Math.max(norm, Math.abs(m[r][c]));
    if (norm > bestNorm) [best, bestNorm] = [c, norm];
  }
  if (!(bestNorm > 0)) return null;
  return Array.from({ length: n }, (_, r) => m[r][best] / bestNorm);
}

/** The sign of a square matrix's determinant (−1, 0 or 1), by elimination
    with partial pivoting. `a` is overwritten. */
export function determinantSign(a) {
  const n = a.length;
  let sign = 1;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (!(Math.abs(a[pivot][col]) > 0)) return 0;
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot], a[col]];
      sign = -sign;
    }
    if (a[col][col] < 0) sign = -sign;
    for (let r = col + 1; r < n; r++) {
      const m = a[r][col] / a[col][col];
      if (m === 0) continue;
      for (let c = col; c < n; c++) a[r][c] -= m * a[col][c];
    }
  }
  return sign;
}

/**
 * The current INTO `node` from everything that hangs on it, amps, at the
 * voltages given — what a capacitor on that node would be charged by. The
 * same sum the solve balances at every other net (leakage included), so a
 * node pinned in a solved network reads exactly what that network pushes.
 * @param {string} node
 * @param {object} net - as newtonSolve's
 */
export function currentInto(node, { touching, drivers, fixed, volts }) {
  const vAt = (n) => fixed.get(n) ?? volts.get(n) ?? 0;
  const v = vAt(node);
  let sum = 0;
  for (const br of touching.get(node) ?? []) {
    if (isDevice(br)) {
      sum += deviceInto(br, node, vAt);
    } else if (br.kind === "r") {
      sum += (vAt(br.a === node ? br.b : br.a) - v) / br.ohms;
    } else if (br.kind === "l") {
      sum += coilInto(br, node);
    } else if (br.a === node) {
      const vd = v - vAt(br.b);
      sum -= junctionCurrent(br, vd) + vd * LEAK_S;
    } else {
      const vd = vAt(br.a) - v;
      sum += junctionCurrent(br, vd) + vd * LEAK_S;
    }
  }
  for (const stage of drivers.get(node) ?? []) sum += stageCurrent(stage, v);
  return sum;
}

/**
 * Solve A·x = b by Gaussian elimination with partial pivoting — null when A
 * is singular. A is overwritten.
 * @param {Float64Array[]} a - n rows of n
 * @param {number[]} b
 * @returns {number[]|null}
 */
export function gaussSolve(a, b) {
  const n = b.length;
  const x = [...b];
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (!(Math.abs(a[pivot][col]) > 0)) return null;
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot], a[col]];
      [x[col], x[pivot]] = [x[pivot], x[col]];
    }
    for (let r = col + 1; r < n; r++) {
      const m = a[r][col] / a[col][col];
      if (m === 0) continue;
      for (let c = col; c < n; c++) a[r][c] -= m * a[col][c];
      x[r] -= m * x[col];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let sum = x[r];
    for (let c = r + 1; c < n; c++) sum -= a[r][c] * x[c];
    x[r] = sum / a[r][r];
  }
  return x;
}
