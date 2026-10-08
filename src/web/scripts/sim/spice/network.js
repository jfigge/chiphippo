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
//        or Zener (spice/diodes.js): monotone and piecewise linear, with a
//        gigaohm of leakage beside it so a net nothing else holds still has
//        a voltage;
//   "q"  a bipolar transistor between its base, collector and emitter,
//   "m"  a MOSFET between its channel's two ends, its gate the voltage it
//        is told (spice/params.js BJT and MOSFET: one common set each; a
//        CD4007UB's channel its family's own on-resistance and saturation,
//        `ron`/`isat`), and
//   "s"  a chip's stage that is NOT on the rails (a chip fed through a
//        resistor or a diode, or with its ground lifted): the stage measured
//        from its own supply pin's net (`ref`) rather than from 0 V, its
//        current drawn from (or returned to) the chip's supply pin (`feed`)
//        — so what an output sources really comes in through its VCC —
//        piecewise linear like the rest, their slopes read numerically.
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

import { ledCurrent } from "./leds.js";
import { diodeCurrent, diodeSlope } from "./diodes.js";
import { stageCurrent, stageSlope } from "./output-stage.js";
import { BJT, MOSFET } from "./params.js";

/** A network whose current law holds at every net to within this has been
    solved, amps (a nanoamp). */
export const TOLERANCE_A = 1e-9;

/** The most Newton steps one network takes before it keeps what it has. */
export const MAX_NEWTON = 60;

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

/** Whether a branch is a DEVICE: more than two terminals, or a current that
    is not a function of the voltage across one pair. */
export function isDevice(br) {
  return br.kind === "q" || br.kind === "m" || br.kind === "s";
}

/** Every node a device's current depends on. */
export function deviceEnds(br) {
  if (br.kind === "q") return [br.b, br.c, br.e];
  if (br.kind === "m") return [br.a, br.b, br.g];
  return [br.out, br.ref, br.feed];
}

/** The nodes a device's current flows through (a MOSFET's gate and an
    off-rail stage's reference draw nothing). */
function deviceTerminals(br) {
  if (br.kind === "q") return [br.b, br.c, br.e];
  if (br.kind === "m") return [br.a, br.b];
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
  const on = st.sources ? v < st.volts : br.both || v > st.volts;
  return on ? -1 / st.ohms : 0;
}

/** A device's current into `node` differentiated by the voltage on `t`,
    siemens. */
function deviceSlope(br, node, t, vAt) {
  if (br.kind === "s") {
    // i flows into `out` and out of `feed`; it falls with `out` and rises
    // with `ref`.
    const g = offStageSlope(br, vAt, vAt(br.out));
    const sign = node === br.out ? 1 : node === br.feed ? -1 : 0;
    const by = (t === br.out ? g : 0) + (t === br.ref ? -g : 0);
    return sign * by;
  }
  const base = deviceInto(br, node, vAt);
  const nudged = (n) => (n === t ? vAt(n) + DEVICE_DV : vAt(n));
  return (deviceInto(br, node, nudged) - base) / DEVICE_DV;
}

/** An off-rail stage's current into its output's net at `v` volts. A LOW
    (`both`) is the transistor to the chip's own ground switched on, and
    conducts either way: an output LOW whose ground is lifted to 0.6 V is
    held there, not anywhere between that and the inputs' clamps. */
function offStageCurrent(br, vAt, v) {
  const st = stageAt(br, vAt);
  if (!br.both || v >= st.volts) return stageCurrent(st, v);
  return Math.min(st.limit, (st.volts - v) / st.ohms);
}

/**
 * A three-terminal device's currents INTO the network at each of its
 * terminals, amps, at the voltages `vAt` gives: `[[node, amps], …]`.
 *   "q" (`{b, c, e, pnp}`): the base–emitter junction past VBE, β times its
 *       current at the collector, never more than saturation lets through.
 *   "m" (`{a, b, g, p}`): a channel whose conductance rises from the
 *       threshold (against the source — the lower end for N, the higher
 *       for P) to its on-resistance (`ron`, RDS(on) by default), never more
 *       than its saturation current (`isat`, none by default); the gate
 *       draws nothing.
 *   "s" (`{out, ref, feed, stage, offset}`): a stage whose open-circuit
 *       level is `offset` volts from its reference node, pushing into `out`
 *       what it takes from `feed` (spice/output-stage.js `stageCurrent`).
 */
export function deviceCurrents(br, vAt) {
  if (br.kind === "q") {
    const s = br.pnp ? -1 : 1; // a PNP is an NPN upside down
    const vbe = s * (vAt(br.b) - vAt(br.e));
    const ib = vbe > BJT.vbeV ? (vbe - BJT.vbeV) / BJT.rbeOhm : 0;
    const vce = s * (vAt(br.c) - vAt(br.e));
    const sat = vce > BJT.vceSatV ? (vce - BJT.vceSatV) / BJT.satOhm : 0;
    const ic = Math.min(BJT.beta * ib, sat);
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
  const va = vAt(br.a);
  const vb = vAt(br.b);
  const g = mosfetConductance(br, va, vb, vAt(br.g));
  let i = g * (va - vb); // a → b through the channel
  if (Math.abs(i) > (br.isat ?? Infinity)) i = Math.sign(i) * br.isat;
  return [
    [br.a, -i],
    [br.b, i],
  ];
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
    return s * (vAt(br.b) - vAt(br.e)) > BJT.vbeV;
  }
  if (br.kind === "s") return offStageCurrent(br, vAt, vAt(br.out)) !== 0;
  return mosfetConductance(br, vAt(br.a), vAt(br.b), vAt(br.g)) > 0;
}

/** The current a device puts INTO `node`, amps. */
function deviceInto(br, node, vAt) {
  let sum = 0;
  for (const [n, amps] of deviceCurrents(br, vAt)) if (n === node) sum += amps;
  return sum;
}

/** A junction branch's current for `vd` volts across it (anode less
    cathode), amps: an LED's or a diode's. */
export function junctionCurrent(br, vd) {
  return br.diode ? diodeCurrent(br.spec, vd) : ledCurrent(br.spec, vd);
}

/** ∂(junctionCurrent)/∂vd, siemens. */
export function junctionSlope(br, vd) {
  if (br.diode) return diodeSlope(br.spec, vd);
  return ledCurrent(br.spec, vd) > 0 ? 1 / br.spec.rdOhm : 0;
}

/** Which piece of its characteristic a stage is on at `v`: off, along its
    resistance, or saturated at its limit. */
function stagePiece(st, v) {
  const d = st.sources ? st.volts - v : v - st.volts;
  if (!(d > 0)) return "0";
  return d / st.ohms >= st.limit ? "2" : "1";
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
  const vAt = (node) => fixed.get(node) ?? volts.get(node) ?? 0;
  let out = "";
  for (const [node, list] of drivers) {
    const v = vAt(node);
    for (const st of list) out += stagePiece(st, v);
  }
  for (const br of branches) {
    if (br.kind === "j") {
      const vd = vAt(br.a) - vAt(br.b);
      out += junctionSlope(br, vd) > 0 ? (vd > 0 ? "f" : "r") : "0";
    } else if (br.kind === "q") {
      const s = br.pnp ? -1 : 1;
      const vbe = s * (vAt(br.b) - vAt(br.e));
      const ib = vbe > BJT.vbeV ? (vbe - BJT.vbeV) / BJT.rbeOhm : 0;
      const vce = s * (vAt(br.c) - vAt(br.e));
      const sat = vce > BJT.vceSatV ? (vce - BJT.vceSatV) / BJT.satOhm : 0;
      out += ib > 0 ? (BJT.beta * ib <= sat ? "a" : "s") : "0";
    } else if (br.kind === "m") {
      const va = vAt(br.a);
      const vb = vAt(br.b);
      const over = br.p ? Math.max(va, vb) - vAt(br.g) : vAt(br.g) - Math.min(va, vb); // prettier-ignore
      const on = (over - MOSFET.vthV) / MOSFET.fullOnV;
      const g = mosfetConductance(br, va, vb, vAt(br.g));
      out += on > 0 ? (Math.abs(g * (va - vb)) >= (br.isat ?? Infinity) ? "3" : on >= 1 ? "2" : "1") : "0"; // prettier-ignore
    } else if (br.kind === "s") {
      const st = stageAt(br, vAt);
      const v = vAt(br.out);
      out += br.both && v < st.volts ? "r" : stagePiece(st, v);
    }
  }
  return out;
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
  const slopes = (node, row) => {
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
          const d = deviceSlope(br, node, t, vAt);
          if (t === node) self += d;
          else {
            const k = index.get(t);
            if (k != null) row[k] += d;
          }
        }
      } else if (br.kind === "r") {
        add(br.a === node ? br.b : br.a, 1 / br.ohms);
      } else {
        const vd = br.a === node ? v - vAt(br.b) : vAt(br.a) - v;
        add(br.a === node ? br.b : br.a, junctionSlope(br, vd) + LEAK_S);
      }
    }
    for (const stage of drivers.get(node) ?? []) self += stageSlope(stage, v);
    row[index.get(node)] += self;
  };
  const residual = () => nodes.map((node) => into(node, volts.get(node)));
  let f = residual();
  for (let step = 0; step < MAX_NEWTON && size(f) > tolerance; step++) {
    const jacobian = nodes.map(() => new Float64Array(nodes.length));
    nodes.forEach((node, k) => slopes(node, jacobian[k]));
    const dv = gaussSolve(
      jacobian,
      f.map((x) => -x),
    );
    if (!dv) break;
    // A junction's knee is a corner the linear step can overshoot: never
    // move a net more than LIMIT_V at once, and halve the step while it
    // makes the residual worse.
    const from = nodes.map((node) => volts.get(node));
    const before = size(f);
    const along = (dir, t0) => {
      let t = t0;
      for (let k = 0; ; k++) {
        nodes.forEach((node, i) => volts.set(node, from[i] + t * dir[i]));
        const next = residual();
        const now = size(next);
        if (now <= before || k >= BACKTRACKS) return { dir, t, next, gained: now < before }; // prettier-ignore
        t /= 2;
      }
    };
    const big = size(dv);
    let move = along(dv, big > LIMIT_V ? LIMIT_V / big : 1);
    if (!move.gained && big > LIMIT_V) {
      // Scaling the whole step to its largest net can leave every net
      // stuck: a net nothing but a saturated stage feeds has no slope, asks
      // for gigavolts, and shrinks everyone else's share to nothing. Limit
      // each net on its own instead (as SPICE limits each junction).
      const each = dv.map((x) => Math.max(-LIMIT_V, Math.min(LIMIT_V, x)));
      const tried = along(each, 1);
      if (tried.gained) move = tried;
      else nodes.forEach((node, i) => volts.set(node, from[i] + move.t * dv[i])); // prettier-ignore
    }
    // As above: a step too small to matter is not taken.
    if (move.t * size(move.dir) < MIN_STEP_V) {
      nodes.forEach((node, i) => volts.set(node, from[i]));
      break;
    }
    f = move.next;
  }
  return size(f) <= tolerance;
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
