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

// spice/supply.js — what each bench supply is asked to deliver, and what it
// does past its current limit (features/spice-lite.md §4.6). Pure and
// DOM-free.
//
// DEMAND, per PSU, measured at its SET voltage:
//   · every chip whose VCC pin is on its + net draws its family's supply
//     current (ICC; a family-less part the 74LS figure) — POWERED OR NOT: an
//     underpowered chip still draws, and counting it either way is what keeps
//     a drooping supply from flickering chips on and off tick by tick;
//   · every resistor carries (V_high − V_low) / R, booked to the supply its
//     high end hangs from — a + rail directly, or a chip output driven HIGH
//     (whose current comes from that chip's own supply). An LED or diode in
//     series is its forward voltage (spice/params.js FORWARD_VOLTS): the net
//     between it and the resistor sits VF above its cathode, or VF below its
//     anode, and conducts only the way the junction lets it;
//   · what the LED networks draw (spice/lamps.js): every resistor that solve
//     booked is skipped here, and its own reading — which counts an LED wired
//     straight across a supply, and a chip output as the stage it is — is
//     booked instead.
//
// DROOP: within its limit a supply holds its set voltage; past it, the voltage
// falls in proportion — V = V_set · I_limit / I_demand — never a cliff. For a
// resistive load that is exactly the current limit (the load's current falls
// with the voltage), and it is what a lab supply's constant-current mode
// does. The drooped voltage feeds the engine's own power check (`psuVolts`),
// so a chip whose supply sags below its family's minimum is UNDERPOWERED by
// the rule every chip already obeys.
//
// Stated, not modelled: a resistor chain through an intermediate net, segment
// displays and LED bars (their legs are counted only through a resistor whose
// far net a level states), a chip output's VOH (a HIGH reads as its supply),
// two supplies meeting on one rail (the first PSU is booked).

import { H, L, X } from "../levels.js";
import { CHIP_STATUS } from "../engine.js";
import { partDef } from "../../catalog/index.js";
import { DEFAULT_CURRENT_LIMIT } from "../../catalog/parts.js";
import { partPinAddresses } from "../../model/occupancy.js";
import { formatAddress } from "../../model/breadboard.js";
import { FORWARD_VOLTS, partParams } from "./params.js";

/** A supply this close to its set voltage is not drooping, volts. */
export const DROOP_EPS = 1e-3;

/** The key a resistive element is booked under, by its two lead addresses —
    the same in spice/lamps.js, whose solve books the resistors around an
    LED in place of this file's reading of them. */
export function resistorKey(aAt, bAt) {
  return `${aAt}|${bAt}`;
}

/**
 * Each PSU's demand and the voltage it delivers — `measureSupplies`'s
 * supplies alone.
 * @param {object} opts - as measureSupplies
 */
export function supplyState(opts) {
  return measureSupplies(opts).supplies;
}

/** Each netlist's supply topology (`supplyTopology`). A netlist is rebuilt
    whenever the document or a switch changes (NetlistCache), so it is exactly
    as long-lived as the facts below — which is what lets a 100 Hz run read
    them once rather than walking every part's pins every tick. */
const TOPOLOGY = new WeakMap();

/**
 * The parts of a desk the supply reading needs and a run cannot change: the
 * supplies and their nets, each chip's supply pins, every lamp and diode as a
 * junction, and every resistor element as a pair of nets. Computed once per
 * netlist.
 * @param {object} doc
 * @param {{netOfPoint: Map}} netlist
 */
export function supplyTopology(doc, netlist) {
  const cached = TOPOLOGY.get(netlist);
  if (cached) return cached;
  const netOf = (address) =>
    address ? (netlist.netOfPoint.get(address) ?? null) : null;

  const psus = []; // {id, set, limit, plus, minus}
  const psuOfNet = new Map(); // + net → psuId (the first)
  let vHigh = 0;
  for (const comp of doc.components ?? []) {
    if (comp.kind !== "psu") continue;
    const set = comp.params?.volts ?? 5;
    const limit = comp.params?.currentLimit ?? DEFAULT_CURRENT_LIMIT;
    const plus = netOf(formatAddress(comp.id, "+"));
    const minus = netOf(formatAddress(comp.id, "-"));
    psus.push({ id: comp.id, set, limit, plus, minus });
    if (plus && !psuOfNet.has(plus)) psuOfNet.set(plus, comp.id);
    vHigh = Math.max(vHigh, set);
  }
  const minusNets = new Set(psus.map((p) => p.minus).filter(Boolean));

  const feeds = new Map(); // compId → {vccAt, gndAt}
  const junctions = []; // {anode, cathode, anodeAt, cathodeAt, vf}
  const resistors = []; // {a, b, aAt, bAt, ohms}
  const terminals = new Map(); // a switching part's id → pin → address
  for (const comp of doc.components ?? []) {
    const def = partDef(comp.ref);
    if (!def || comp.kind === "psu" || comp.kind === "clock") continue;
    const vcc = def.pins?.find((p) => p.role === "vcc")?.n;
    const lamp = typeof def.polarity === "function" && def.colors;
    const diode = typeof def.oneWayBridges === "function";
    const resistive = typeof def.weakBridges === "function";
    const switching = Array.isArray(def.logic?.channels);
    if (vcc == null && !lamp && !diode && !resistive && !switching) continue;
    if (comp.board == null) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const at = new Map(pins.map((p) => [p.pin, p.address]));
    const net = (pin) => netOf(at.get(pin));
    if (switching) terminals.set(comp.id, at);
    if (vcc != null) {
      const gnd = def.pins.find((p) => p.role === "gnd")?.n;
      feeds.set(comp.id, { vccAt: at.get(vcc) ?? null, gndAt: at.get(gnd) ?? null }); // prettier-ignore
    }
    const junction = (a, k, vf) => ({
      anode: net(a),
      cathode: net(k),
      anodeAt: at.get(a) ?? null,
      cathodeAt: at.get(k) ?? null,
      vf,
    });
    if (lamp) {
      const { anodePin, cathodePin } = def.polarity(comp.params);
      const vf = FORWARD_VOLTS[comp.params?.color] ?? FORWARD_VOLTS.red;
      junctions.push(junction(anodePin, cathodePin, vf));
    } else if (diode) {
      for (const [a, k] of def.oneWayBridges(comp.params)) {
        junctions.push(junction(a, k, FORWARD_VOLTS.diode));
      }
    }
    if (resistive) {
      for (const [pa, pb, own] of def.weakBridges(comp.params)) {
        const ohms = Number(own ?? comp.params?.ohms);
        const a = net(pa);
        const b = net(pb);
        if (!(ohms > 0) || !a || !b || a === b) continue;
        resistors.push({ a, b, aAt: at.get(pa), bAt: at.get(pb), ohms });
      }
    }
  }
  const topo = { psus, psuOfNet, minusNets, vHigh, feeds, junctions, resistors, terminals }; // prettier-ignore
  TOPOLOGY.set(netlist, topo);
  return topo;
}

/**
 * Each PSU's demand and the voltage it delivers, and every DRAW behind the
 * demand — where its current enters (`plusAt`, an address on the + side) and
 * returns (`minusAt`), for spice/sag.js to route through the wiring. A draw
 * a supply delivers past its limit is scaled down to what it really gets.
 * @param {object} opts
 * @param {object} opts.doc
 * @param {{netOfPoint: Map}} opts.netlist
 * @param {object} opts.ctx - sim/engine.js's context for the settle
 * @param {Map<string,string>} opts.netLevels
 * @param {Map<string,string>} opts.strongLevels
 * @param {Map<string,number>} opts.nodeVolts - Spice Lite's analog nodes
 * @param {object} opts.config - normalized spice config
 * @param {Map<string, Map<number,string>>} [opts.driven] - each chip's
 *   outputs as it last drove them (spice/engine.js's `outputs` hook)
 * @param {Map<string, Array<{a: number, b: number, on: string}>>}
 *   [opts.channels] - each switching part's channels (the tick result's)
 * @param {{draws: Array<object>, resistors: Set<string>}} [opts.lamps] -
 *   spice/lamps.js's solve: its supplies' deliveries, and the resistors
 *   they already account for
 * @returns {{supplies: Map<string, {set: number, volts: number,
 *   amps: number, demand: number, limit: number, limited: boolean}>,
 *   draws: Array<{chip: string|null, psu: string, plusAt: string|null,
 *   minusAt: string|null, amps: number}>}}
 */
export function measureSupplies({
  doc,
  netlist,
  ctx,
  netLevels,
  strongLevels,
  nodeVolts,
  config,
  driven = new Map(),
  channels = new Map(),
  lamps = null,
}) {
  const topo = supplyTopology(doc, netlist);
  const { psuOfNet, minusNets, vHigh, junctions } = topo;
  if (!topo.psus.length) return { supplies: new Map(), draws: [] };
  const supplies = new Map(
    topo.psus.map((p) => [p.id, { set: p.set, limit: p.limit, demand: 0 }]),
  );
  const draws = [];

  // A chip's supply: the PSU on its VCC pin's net. Its ICC enters at its
  // VCC pin and returns at its (first) ground pin.
  const chipSupply = new Map(); // compId → {psu, vccAt, gndAt}
  for (const c of ctx.chips) {
    if (c.passive) continue;
    const vcc = c.def.pins.find((p) => p.role === "vcc")?.n;
    const psu = psuOfNet.get(c.pinNet.get(vcc));
    const at = topo.feeds.get(c.comp.id);
    if (!psu || !at) continue;
    const feed = { psu, ...at };
    chipSupply.set(c.comp.id, feed);
    const amps = partParams(config, c.def).supplyMa / 1000;
    supplies.get(psu).demand += amps;
    draws.push({ chip: c.comp.id, psu, plusAt: feed.vccAt, minusAt: feed.gndAt, amps }); // prettier-ignore
  }
  // What each net is DRIVEN to, and where its current comes in (a HIGH: the
  // VCC pin of the chip driving it, or the + end of a switch channel joining
  // it to the rail) or goes out (a LOW: the GND pin of the chip sinking it,
  // or the − end of a channel). A chip's outputs are what it last DROVE —
  // which an underpowered chip keeps from when it was powered: a load that
  // pulls its own supply down must not vanish the moment it has (the supply
  // would recover, power the chip, droop again — a flicker every tick).
  const sourceOfNet = new Map(psuOfNet);
  const entryOfNet = new Map();
  const returnOfNet = new Map();
  const drivenLevel = new Map(); // net → H | L | X (two disagreeing)
  const onRail = (net) => psuOfNet.has(net) || minusNets.has(net);
  const drive = (net, level, psu, at) => {
    const was = drivenLevel.get(net);
    drivenLevel.set(net, was == null || was === level ? level : X);
    if (level === H && !sourceOfNet.has(net)) {
      sourceOfNet.set(net, psu);
      entryOfNet.set(net, at);
    } else if (level === L && !returnOfNet.has(net)) {
      returnOfNet.set(net, at);
    }
  };
  for (const c of ctx.chips) {
    if (c.status !== CHIP_STATUS.OK && c.status !== CHIP_STATUS.UNDERPOWERED) continue; // prettier-ignore
    const feed = chipSupply.get(c.comp.id);
    const outs = driven.get(c.comp.id);
    if (!feed || !outs) continue;
    for (const [pin, level] of outs) {
      const net = c.pinNet.get(pin);
      if (!net || onRail(net) || (level !== H && level !== L)) continue;
      drive(net, level, feed.psu, level === H ? feed.vccAt : feed.gndAt);
    }
  }
  for (const c of ctx.chips) {
    const states = channels.get(c.comp.id);
    const at = topo.terminals.get(c.comp.id);
    if (!states || !at) continue;
    for (const { a, b, on } of states) {
      if (on !== H) continue;
      for (const [rail, other, pin] of [
        [c.pinNet.get(a), c.pinNet.get(b), a],
        [c.pinNet.get(b), c.pinNet.get(a), b],
      ]) {
        if (!rail || !other || onRail(other)) continue;
        if (psuOfNet.has(rail)) drive(other, H, psuOfNet.get(rail), at.get(pin) ?? null); // prettier-ignore
        else if (minusNets.has(rail)) drive(other, L, null, at.get(pin) ?? null); // prettier-ignore
      }
    }
  }

  /** A level as volts, at the supplies' SET voltages. */
  const levelVolts = (net, level) => {
    if (level === H) {
      const psu = sourceOfNet.get(net);
      return psu ? supplies.get(psu).set : vHigh;
    }
    return level === L ? 0 : null;
  };
  /** A net's voltage when something DRIVES it — a rail, an analog node, a
      chip, a switch to a rail, a signal — or null. A level a resistor merely
      PULLS a net to is not a voltage: the junction beside it may set it
      instead. */
  const known = (net) => {
    if (net == null) return null;
    if (psuOfNet.has(net)) return supplies.get(psuOfNet.get(net)).set;
    if (minusNets.has(net)) return 0;
    if (nodeVolts.has(net)) return nodeVolts.get(net);
    return levelVolts(net, drivenLevel.get(net) ?? strongLevels.get(net));
  };

  /** A net's voltage — known, or set by a junction — and which way current
      may flow through it: "in" (it is an anode: only into it), "out" (a
      cathode: only out of it), or null (either). Also the supply behind a
      cathode net, for booking. */
  const voltsOf = (net) => {
    const v = known(net);
    if (v != null) {
      return {
        v,
        way: null,
        source: sourceOfNet.get(net),
        entryAt: entryOfNet.get(net) ?? null,
        returnAt: returnOfNet.get(net) ?? null,
      };
    }
    for (const j of junctions) {
      if (j.anode === net && j.cathode && j.cathode !== net) {
        const vc = known(j.cathode);
        if (vc != null) {
          return { v: vc + j.vf, way: "in", source: null, returnAt: minusNets.has(j.cathode) ? j.cathodeAt : (returnOfNet.get(j.cathode) ?? null) }; // prettier-ignore
        }
      }
      if (j.cathode === net && j.anode && j.anode !== net) {
        const va = known(j.anode);
        if (va != null && va - j.vf > 0) {
          return { v: va - j.vf, way: "out", source: sourceOfNet.get(j.anode), entryAt: psuOfNet.has(j.anode) ? j.anodeAt : (entryOfNet.get(j.anode) ?? null) }; // prettier-ignore
        }
      }
    }
    // Only pulled: the level it is pulled to (no current flows through the
    // resistor doing the pulling, which is what that reading says).
    const pulled = levelVolts(net, netLevels.get(net));
    return pulled == null ? null : { v: pulled, way: null, source: null };
  };

  for (const r of topo.resistors) {
    if (lamps?.resistors.has(resistorKey(r.aAt, r.bAt))) continue;
    const a = voltsOf(r.a);
    const b = voltsOf(r.b);
    if (!a || !b) continue;
    const [hi, lo, hiNet, loNet, hiAt, loAt] =
      a.v >= b.v ? [a, b, r.a, r.b, r.aAt, r.bAt] : [b, a, r.b, r.a, r.bAt, r.aAt]; // prettier-ignore
    if (hi.way === "in" || lo.way === "out") continue; // the junction blocks
    const amps = (hi.v - lo.v) / r.ohms;
    if (!(amps > 0) || !hi.source) continue;
    supplies.get(hi.source).demand += amps;
    // It enters at the resistor's own lead on a + rail, or through whatever
    // feeds its high end; it returns at its low lead on a − rail, or
    // through the junction leading there.
    draws.push({
      chip: null,
      psu: hi.source,
      plusAt: psuOfNet.has(hiNet) ? hiAt : (hi.entryAt ?? null),
      minusAt: minusNets.has(loNet) ? loAt : (lo.returnAt ?? null),
      amps,
    });
  }

  for (const d of lamps?.draws ?? []) {
    const supply = supplies.get(d.psu);
    if (!supply || !(d.amps > 0)) continue;
    supply.demand += d.amps;
    draws.push({ ...d });
  }

  const out = new Map();
  const share = new Map(); // psuId → the fraction of its demand it delivers
  for (const [id, { set, limit, demand }] of supplies) {
    share.set(id, demand > limit ? limit / demand : 1);
    const limited = demand > limit;
    const volts = limited ? (set * limit) / demand : set;
    out.set(id, {
      set,
      volts,
      amps: limited ? limit : demand,
      demand,
      limit,
      limited,
    });
  }
  for (const d of draws) d.amps *= share.get(d.psu);
  return { supplies: out, draws };
}
