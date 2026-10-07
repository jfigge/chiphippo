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

// spice/lamps.js — the current through every LED on the desk, and what it
// does to the LED (features/spice-light-leds.md). Pure and DOM-free.
//
// The digital engine asks only whether an LED's legs are strongly driven (a
// supply or an output on both sides burns it; a resistor anywhere saves it).
// Spice Light asks what a bench would: how many milliamps flow. Around every
// LED it SOLVES the little network the LED sits in, by Kirchhoff's current
// law at each net:
//
//   FIXED nets hold their voltage whatever is drawn from them: a supply's +
//     (at what it delivers, droop included) and −, a clock brick or signal
//     flag (an ideal bench source, at the desk's highest supply), and an RC
//     node at its curve's voltage (the LED does not drain the capacitor —
//     stated, not modelled).
//   UNKNOWN nets are every other net the LEDs reach through BRANCHES:
//     · a resistor (any resistive element — a pot's side, an rnet9 element);
//     · an LED or a segment of a display (spice/leds.js: nothing below its
//       knee, then its dynamic resistance; a burnt one is open);
//     · an analog switch channel switched on (its on-resistance at its
//       supply, spice/output-stage.js `channelOhms`);
//     · a chip output, as the stage it is (spice/output-stage.js): a 74LS
//       HIGH is 3.6 V behind 120 Ω, a CD4000 output a MOSFET that saturates.
//     A discrete transistor switched on is a closed switch: its two nets are
//     solved as ONE.
//
// Each branch's current is a monotone, piecewise-linear function of the
// voltages at its ends, so the network has one answer, and Newton's method
// finds it: the current law at every net, linearised where the voltages
// stand, solved as one small linear system, stepped (never more than 2 V at
// once, and halved while it makes things worse), until every net balances
// to a nanoamp — warm-started from the last tick's answer, so a settled desk
// takes one step. That is the one matrix in Spice Light, and it is only as
// big as the nets around one group of LEDs: no circuit-wide solve, and no
// SPICE. A gigaohm across every junction stands in for its leakage, so a
// net nothing else holds (an LED's anode left in an empty column) rests at
// its neighbour's voltage rather than anywhere at all.
//
// An LED whose junction would pass its maximum temperature BURNS: it is
// opened, the network solved again without it (so the segments sharing one
// resistor with it take its current, as they do), until nothing more burns.
// The burnt set is the caller's to carry (spice/engine.js keeps it in its
// analog state until Stop).
//
// What the solve hands back besides the LEDs: the current through every lead
// it knows one for — each LED's and segment's, each resistor's and switch
// channel's in an LED's network, each chip output's driving one, keyed by the
// HOLE the lead is in (summed where several share one lead: a display's
// common pin, an rnet9's COM) — which is what the probe reads out; the
// voltage of every net it solved; and the current each supply delivers into
// the network — booked by
// spice/supply.js in place of its own reading of those resistors, so the
// readout on a supply brick counts an LED wired straight across it. That
// booking is a SECOND solve, `atSet`: every supply, and every chip on it, at
// its SET voltage, because that is what spice/supply.js measures demand at
// (its droop is V_set · I_limit / I_demand — demand measured at the drooped
// voltage would chase its own tail). The LEDs themselves are judged at what
// the supplies deliver, so a drooping supply dims them.
//
// Stated, not modelled: a diode or Zener in the network (spice/supply.js
// still reads those at a fixed drop), an inductor (it is a wire), a chip
// output's level as an INPUT reads it (a loaded HIGH still reads H), and a
// capacitor (open at DC).

import { H, L } from "../levels.js";
import { CHIP_STATUS } from "../engine.js";
import { partDef } from "../../catalog/index.js";
import { partPinAddresses } from "../../model/occupancy.js";
import { AMBIENT_C, ledCurrent, ledSpec, ledVerdict } from "./leds.js";
import {
  channelOhms,
  outputStage,
  stageCurrent,
  stageSlope,
} from "./output-stage.js";
import { resistorKey, supplyTopology } from "./supply.js";

/** A network whose current law holds at every net to within this has been
    solved, amps (a nanoamp). */
const TOLERANCE_A = 1e-9;

/** The most Newton steps one network takes before it keeps what it has. */
const MAX_NEWTON = 60;

/** The most a Newton step moves any net at once, volts. */
const LIMIT_V = 2;

/** How many times a step that made things worse is halved. */
const BACKTRACKS = 30;

/** A conductance from every net to ground, siemens (a teraohm) — SPICE's
    GMIN, numerical only: it keeps the Jacobian solvable when a net holds
    nothing but junctions that are off. */
const GMIN_S = 1e-12;

/** The leakage across every junction, siemens (1 GΩ) — numerical, not a
    datasheet figure: it only gives a net with nothing else on it a voltage. */
const LEAK_S = 1e-9;

/** A branch carrying less than this is not booked, amps: the leakage
    stand-in's own nanoamps are not a draw on anything. */
const BOOK_FLOOR_A = 1e-7;

/** Each netlist's lamp topology (`lampTopology`), for the reason
    spice/supply.js caches its own: a netlist lives exactly as long as the
    facts below. */
const TOPOLOGY = new WeakMap();

/** The key one junction is reported under: an LED's component id, or a
    display's id and segment (`c4#a`). */
export function junctionKey(compId, segId = null) {
  return segId == null ? compId : `${compId}#${segId}`;
}

/**
 * Every LED junction and every resistive element on a desk, by net — what a
 * run cannot change. Computed once per netlist.
 * @param {object} doc
 * @param {{netOfPoint: Map}} netlist
 */
export function lampTopology(doc, netlist) {
  const cached = TOPOLOGY.get(netlist);
  if (cached) return cached;
  const netOf = (address) =>
    address ? (netlist.netOfPoint.get(address) ?? null) : null;
  const junctions = []; // {key, comp, seg, spec, anode, cathode, anodeAt, cathodeAt}
  const resistors = []; // {key, a, b, aAt, bAt, ohms}
  const outputsAt = new Map(); // chip id → pin → the hole its lead is in
  for (const comp of doc.components ?? []) {
    const def = partDef(comp.ref);
    if (!def || comp.board == null) continue;
    const led = typeof def.polarity === "function" && Boolean(def.colors);
    const segments = Array.isArray(def.segments) ? def.segments : null;
    const resistive = typeof def.weakBridges === "function";
    const drives = Boolean(def.logic) && def.pins?.some((p) => p.role === "output" || p.role === "io"); // prettier-ignore
    if (!led && !segments && !resistive && !drives) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const at = new Map(pins.map((p) => [p.pin, p.address]));
    if (drives) outputsAt.set(comp.id, at);
    const junction = (key, seg, anodePin, cathodePin) => {
      const anodeAt = at.get(anodePin) ?? null;
      const cathodeAt = at.get(cathodePin) ?? null;
      junctions.push({
        key,
        comp: comp.id,
        seg,
        spec: ledSpec(comp.params?.color),
        anode: netOf(anodeAt),
        cathode: netOf(cathodeAt),
        anodeAt,
        cathodeAt,
      });
    };
    if (led) {
      const { anodePin, cathodePin } = def.polarity(comp.params);
      junction(junctionKey(comp.id), null, anodePin, cathodePin);
    } else if (segments) {
      for (const seg of segments) {
        junction(junctionKey(comp.id, seg.id), seg.id, seg.anodePin, seg.cathodePin); // prettier-ignore
      }
    }
    if (resistive) {
      for (const [pa, pb, own] of def.weakBridges(comp.params)) {
        const ohms = Number(own ?? comp.params?.ohms);
        const aAt = at.get(pa) ?? null;
        const bAt = at.get(pb) ?? null;
        const a = netOf(aAt);
        const b = netOf(bAt);
        if (!(ohms > 0) || !a || !b || a === b) continue;
        resistors.push({ key: resistorKey(aAt, bAt), a, b, aAt, bAt, ohms });
      }
    }
  }
  const topo = { junctions, resistors, outputsAt };
  TOPOLOGY.set(netlist, topo);
  return topo;
}

/** Nets joined into one node (a transistor switched on), the rest alone. */
function unionFind() {
  const parent = new Map();
  const find = (x) => {
    let root = x;
    while (parent.has(root) && parent.get(root) !== root)
      root = parent.get(root);
    let at = x;
    while (at !== root) {
      const next = parent.get(at) ?? root;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  return { find, union };
}

/** The empty answer: a desk with no LED on it. */
const NOTHING = Object.freeze({
  lamps: new Map(),
  burnt: [],
  currents: new Map(),
  netVolts: new Map(),
  draws: [],
  resistors: new Set(),
});

/**
 * Solve every LED's network for this settle.
 * @param {object} opts
 * @param {object} opts.doc
 * @param {{netOfPoint: Map}} opts.netlist
 * @param {object} opts.ctx - sim/engine.js's context for the settle (its
 *   supplies, chips, signals and clocks, and each chip's status and volts)
 * @param {{netLevels: Map, channels?: Map}} opts.result - the settle's
 * @param {Map<string, number>} [opts.nodeVolts] - Spice Light's RC nodes
 * @param {Map<string, Map<number, string>>} [opts.driven] - each chip's
 *   outputs as it last drove them
 * @param {Set<string>} [opts.burnt] - junction keys already burnt (open)
 * @param {Map<string, number>} [opts.warm] - the last solve's net voltages
 * @param {boolean} [opts.atSet] - every supply, and every chip on one, at
 *   its SET voltage (the booking solve); else at what each delivers
 * @param {boolean} [opts.burns] - whether a junction past its maximum
 *   temperature burns in this solve (the booking solve takes the verdict
 *   solve's burnt set as it stands)
 * @returns {{lamps: Map<string, object>, burnt: Array<object>,
 *   currents: Map<string, number>, netVolts: Map<string, number>,
 *   draws: Array<object>, resistors: Set<string>}} — each junction's verdict
 *   (spice/leds.js `ledVerdict`, plus `burnt`), the junctions that burnt in
 *   THIS solve, the current through each lead it knows (hole address → amps,
 *   a magnitude), the solved voltages, each supply's delivery into the
 *   networks (`{psu, amps, plusAt, minusAt}`, for spice/supply.js) and the
 *   resistors it booked.
 */
export function solveLamps({
  doc,
  netlist,
  ctx,
  result,
  nodeVolts = new Map(),
  driven = new Map(),
  burnt = new Set(),
  warm = new Map(),
  atSet = false,
  burns = true,
}) {
  const topo = lampTopology(doc, netlist);
  if (!topo.junctions.length || !ctx) return NOTHING;
  const sup = supplyTopology(doc, netlist);
  const setOf = new Map(); // + net → the highest supply SET on it
  for (const p of sup.psus) {
    if (p.plus) setOf.set(p.plus, Math.max(setOf.get(p.plus) ?? 0, p.set));
  }

  // ── The nets whose voltage is given ─────────────────────────────────────
  const given = new Map(); // net → volts
  let vHigh = 0;
  for (const [net, volts] of ctx.supplyPlusVolts) {
    const v = atSet && setOf.has(net) ? setOf.get(net) : Math.max(...volts);
    given.set(net, v);
    vHigh = Math.max(vHigh, v);
  }
  if (!(vHigh > 0)) vHigh = 5;
  for (const net of ctx.supplyMinus) if (!given.has(net)) given.set(net, 0);
  for (const [net, v] of nodeVolts) if (!given.has(net)) given.set(net, v);
  const ideal = (net) => {
    if (!net || given.has(net)) return;
    const level = result.netLevels?.get(net);
    if (level === H) given.set(net, vHigh);
    else if (level === L) given.set(net, 0);
  };
  for (const sig of ctx.signals ?? []) ideal(sig.net);
  for (const clk of ctx.clocks ?? []) ideal(clk.outNet);

  // ── Transistors switched on join their nets; switches are branches ──────
  const { find, union } = unionFind();
  const links = []; // {a, b, ohms, aAt, bAt}
  for (const c of ctx.chips) {
    const states = result.channels?.get(c.comp.id);
    if (!states) continue;
    const vcc = ctx.chipStatus.get(c.comp.id)?.volts ?? c.supplyVolts;
    const at = sup.terminals.get(c.comp.id);
    for (const { a, b, on } of states) {
      if (on !== H) continue;
      const na = c.pinNet.get(a);
      const nb = c.pinNet.get(b);
      if (!na || !nb || na === nb) continue;
      const ohms = channelOhms(c.def, vcc);
      if (ohms > 0) {
        links.push({ a: na, b: nb, ohms, aAt: at?.get(a) ?? null, bAt: at?.get(b) ?? null }); // prettier-ignore
      } else if (!(given.has(na) && given.has(nb))) {
        union(na, nb); // two rails through one is the engine's short
      }
    }
  }
  const nodeOf = (net) => (net ? find(net) : null);
  const fixed = new Map(); // node → volts
  const nodePsu = new Map(); // node → the PSU whose + it is
  const nodeMinus = new Set(); // nodes holding a −
  for (const [net, v] of given) {
    const node = find(net);
    if (!fixed.has(node)) fixed.set(node, v);
  }
  for (const [net, psu] of sup.psuOfNet) nodePsu.set(find(net), psu);
  for (const net of sup.minusNets) nodeMinus.add(find(net));

  // ── Chip outputs, as the stages they are ────────────────────────────────
  const drivers = new Map(); // node → [{stage, chip, psu, feed, at}]
  for (const c of ctx.chips) {
    if (c.passive) continue;
    if (c.status !== CHIP_STATUS.OK && c.status !== CHIP_STATUS.UNDERPOWERED) continue; // prettier-ignore
    const outs = driven.get(c.comp.id);
    const vccPin = c.def.pins.find((p) => p.role === "vcc")?.n;
    const vccNet = c.pinNet.get(vccPin);
    const psu = sup.psuOfNet.get(vccNet) ?? null;
    const vcc =
      atSet && setOf.has(vccNet)
        ? setOf.get(vccNet)
        : (ctx.chipStatus.get(c.comp.id)?.volts ?? c.supplyVolts);
    if (!outs || !(vcc > 0)) continue;
    const feed = sup.feeds.get(c.comp.id) ?? null;
    for (const [pin, level] of outs) {
      const node = nodeOf(c.pinNet.get(pin));
      if (!node || fixed.has(node)) continue;
      const stage = outputStage(c.def, vcc, level);
      if (!stage) continue;
      if (!drivers.has(node)) drivers.set(node, []);
      const at = topo.outputsAt.get(c.comp.id)?.get(pin) ?? null;
      drivers.get(node).push({ stage, chip: c.comp.id, psu, feed, at });
    }
  }

  const live = new Set(burnt);
  const fresh = [];
  for (let round = 0; ; round++) {
    const solved = solve();
    const burning = [];
    for (const j of topo.junctions) {
      const v = solved.verdicts.get(j.key);
      if (v?.burns && !live.has(j.key)) burning.push(j);
    }
    if (!burns || !burning.length || round > topo.junctions.length) {
      return finish(solved);
    }
    for (const j of burning) {
      const v = solved.verdicts.get(j.key);
      live.add(j.key);
      fresh.push({ key: j.key, comp: j.comp, seg: j.seg, amps: v.amps, tj: v.tj, tjMax: j.spec.tjMaxC }); // prettier-ignore
    }
  }

  /** One solve, with every junction in `live` open. */
  function solve() {
    // Branches on nodes.
    const branches = [];
    for (const r of topo.resistors) {
      const a = nodeOf(r.a);
      const b = nodeOf(r.b);
      if (a && b && a !== b) branches.push({ kind: "r", a, b, ohms: r.ohms, aAt: r.aAt, bAt: r.bAt, key: r.key }); // prettier-ignore
    }
    for (const l of links) {
      const a = nodeOf(l.a);
      const b = nodeOf(l.b);
      if (a && b && a !== b) branches.push({ kind: "r", a, b, ohms: l.ohms, aAt: l.aAt, bAt: l.bAt, key: null }); // prettier-ignore
    }
    for (const j of topo.junctions) {
      if (live.has(j.key)) continue;
      const a = nodeOf(j.anode);
      const b = nodeOf(j.cathode);
      if (a && b && a !== b) branches.push({ kind: "j", a, b, spec: j.spec, aAt: j.anodeAt, bAt: j.cathodeAt, key: j.key }); // prettier-ignore
    }
    const touching = new Map(); // node → branches
    for (const br of branches) {
      for (const node of [br.a, br.b]) {
        if (!touching.has(node)) touching.set(node, []);
        touching.get(node).push(br);
      }
    }

    // The unknown nodes the LEDs reach, and the branches among them.
    const unknown = [];
    const networks = []; // the unknown nodes, one array per network
    const seen = new Set();
    const inNetwork = new Set();
    for (const j of topo.junctions) {
      for (const start of [nodeOf(j.anode), nodeOf(j.cathode)]) {
        if (!start || fixed.has(start) || seen.has(start)) continue;
        const stack = [start];
        const network = [];
        networks.push(network);
        seen.add(start);
        while (stack.length) {
          const node = stack.pop();
          unknown.push(node);
          network.push(node);
          for (const br of touching.get(node) ?? []) {
            inNetwork.add(br);
            const other = br.a === node ? br.b : br.a;
            if (fixed.has(other) || seen.has(other)) continue;
            seen.add(other);
            stack.push(other);
          }
        }
      }
    }
    // An LED between two fixed nets is in the network with no unknown at all.
    for (const br of branches) {
      if (br.kind === "j" && fixed.has(br.a) && fixed.has(br.b)) inNetwork.add(br); // prettier-ignore
    }

    // Newton's method over each network's unknowns (below).
    const volts = new Map();
    for (const node of unknown) {
      const prior = warm.get(node);
      const level = result.netLevels?.get(node);
      volts.set(node, Number.isFinite(prior) ? prior : level === H ? vHigh : level === L ? 0 : vHigh / 2); // prettier-ignore
    }
    const vAt = (node) => fixed.get(node) ?? volts.get(node) ?? 0;
    const into = (node, v) => {
      let sum = 0;
      for (const br of touching.get(node) ?? []) {
        if (br.kind === "r") {
          sum += (vAt(br.a === node ? br.b : br.a) - v) / br.ohms;
        } else if (br.a === node) {
          const other = vAt(br.b);
          sum -= ledCurrent(br.spec, v - other) + (v - other) * LEAK_S;
        } else {
          const other = vAt(br.a);
          sum += ledCurrent(br.spec, other - v) + (other - v) * LEAK_S;
        }
      }
      for (const d of drivers.get(node) ?? []) sum += stageCurrent(d.stage, v);
      return sum;
    };
    /** ∂(current into `node`)/∂(its own voltage), and the same for each
        unknown neighbour — the network's Jacobian row. */
    const slopes = (node, row, index) => {
      const v = volts.get(node);
      let self = -GMIN_S;
      const add = (other, g) => {
        self -= g;
        const k = index.get(other);
        if (k != null) row[k] += g;
      };
      for (const br of touching.get(node) ?? []) {
        if (br.kind === "r") {
          add(br.a === node ? br.b : br.a, 1 / br.ohms);
        } else {
          const vd = br.a === node ? v - vAt(br.b) : vAt(br.a) - v;
          const g = (ledCurrent(br.spec, vd) > 0 ? 1 / br.spec.rdOhm : 0) + LEAK_S; // prettier-ignore
          add(br.a === node ? br.b : br.a, g);
        }
      }
      for (const d of drivers.get(node) ?? []) self += stageSlope(d.stage, v);
      row[index.get(node)] += self;
    };
    for (const network of networks) {
      const index = new Map(network.map((node, k) => [node, k]));
      const residual = () => network.map((node) => into(node, volts.get(node)) - GMIN_S * volts.get(node)); // prettier-ignore
      const size = (f) => Math.max(...f.map(Math.abs));
      let f = residual();
      for (let step = 0; step < MAX_NEWTON && size(f) > TOLERANCE_A; step++) {
        const jacobian = network.map(() => new Float64Array(network.length));
        network.forEach((node, k) => slopes(node, jacobian[k], index));
        const dv = gaussSolve(
          jacobian,
          f.map((x) => -x),
        );
        if (!dv) break;
        // A junction's knee is a corner the linear step can overshoot:
        // never move a net more than LIMIT_V at once, and halve the step
        // while it makes the residual worse.
        const big = Math.max(...dv.map(Math.abs));
        let t = big > LIMIT_V ? LIMIT_V / big : 1;
        const from = network.map((node) => volts.get(node));
        const before = size(f);
        for (let k = 0; ; k++) {
          network.forEach((node, i) => volts.set(node, from[i] + t * dv[i]));
          const next = residual();
          if (size(next) < before || k >= BACKTRACKS) {
            f = next;
            break;
          }
          t /= 2;
        }
        if (t * big < 1e-12) break;
      }
    }

    const verdicts = new Map();
    for (const br of branches) {
      if (br.kind !== "j") continue;
      const vd = vAt(br.a) - vAt(br.b);
      verdicts.set(br.key, ledVerdict(br.spec, ledCurrent(br.spec, vd), vd));
    }
    return { branches, inNetwork, unknown, volts, vAt, verdicts, touching };
  }

  /** The verdicts, the solved voltages and each supply's delivery. */
  function finish({ inNetwork, unknown, volts, vAt, verdicts }) {
    const lamps = new Map();
    for (const j of topo.junctions) {
      if (live.has(j.key)) {
        lamps.set(j.key, { amps: 0, volts: 0, tj: AMBIENT_C, lit: false, level: 0, overdriven: false, burns: false, reverse: false, burnt: true }); // prettier-ignore
      } else {
        const v = verdicts.get(j.key);
        lamps.set(j.key, v ? { ...v, burnt: false } : { amps: 0, volts: 0, tj: AMBIENT_C, lit: false, level: 0, overdriven: false, burns: false, reverse: false, burnt: false }); // prettier-ignore
      }
    }

    // The current through each lead, by the hole it is in: every junction
    // (nothing through one that is off or burnt), every branch of a network,
    // every output driving one. Summed signed — INTO the part — so a lead
    // several elements share carries what really flows in it, then said as a
    // magnitude.
    const into = new Map();
    const through = (address, amps) => {
      if (address) into.set(address, (into.get(address) ?? 0) + amps);
    };
    for (const j of topo.junctions) {
      const amps = lamps.get(j.key).amps;
      through(j.anodeAt, amps);
      through(j.cathodeAt, -amps);
    }

    // What each supply delivers into the networks, and where it returns.
    const sources = []; // {psu, amps, plusAt}
    const returns = []; // {amps, minusAt}
    const resistors = new Set();
    for (const br of inNetwork) {
      if (br.kind === "r" && br.key) resistors.add(br.key);
      // Current from a to b along the branch.
      const amps =
        br.kind === "r"
          ? (vAt(br.a) - vAt(br.b)) / br.ohms
          : ledCurrent(br.spec, vAt(br.a) - vAt(br.b));
      if (br.kind === "r") {
        through(br.aAt, amps);
        through(br.bAt, -amps);
      }
      if (!(Math.abs(amps) > BOOK_FLOOR_A)) continue;
      const [from, fromAt, to, toAt] =
        amps > 0 ? [br.a, br.aAt, br.b, br.bAt] : [br.b, br.bAt, br.a, br.aAt];
      const flow = Math.abs(amps);
      if (fixed.has(from) && nodePsu.has(from)) {
        sources.push({ psu: nodePsu.get(from), amps: flow, plusAt: fromAt });
      }
      if (fixed.has(to) && nodeMinus.has(to)) {
        returns.push({ amps: flow, minusAt: toAt });
      }
    }
    for (const node of unknown) {
      for (const d of drivers.get(node) ?? []) {
        const amps = stageCurrent(d.stage, volts.get(node));
        through(d.at, -amps); // what it sources leaves the chip
        if (amps > 0 && d.psu) sources.push({ psu: d.psu, amps, plusAt: d.feed?.vccAt ?? null }); // prettier-ignore
        else if (amps < 0) returns.push({ amps: -amps, minusAt: d.feed?.gndAt ?? null }); // prettier-ignore
      }
    }
    const back = returns.reduce((best, r) => (!best || r.amps > best.amps ? r : best), null); // prettier-ignore
    const draws = sources.map((s) => ({
      chip: null,
      psu: s.psu,
      plusAt: s.plusAt,
      minusAt: back?.minusAt ?? null,
      amps: s.amps,
    }));

    const currents = new Map();
    for (const [address, amps] of into) currents.set(address, Math.abs(amps));
    const netVolts = new Map();
    for (const node of unknown) netVolts.set(node, volts.get(node));
    return { lamps, burnt: fresh, currents, netVolts, draws, resistors };
  }
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
