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
//     current (ICC; a family-less part the 74LS figure, a timing part's
//     silicon its own sheet's — params.js `supplyMaOf`) — POWERED OR NOT: an
//     underpowered chip still draws, and counting it either way is what keeps
//     a drooping supply from flickering chips on and off tick by tick;
//   · everything else is what the voltage solve says flows
//     (spice/voltages.js `report`, its DRAWS): the current out of the + rail
//     through every resistor, LED, diode and switch channel, and out of every
//     chip output sourcing current into a load — an LED, a resistor, another
//     output it is fighting — from that chip's own supply. A 74LS input's own
//     current is inside its chip's ICC, as the sheet measures it, and is not
//     booked twice.
//
// DROOP: within its limit a supply holds its set voltage; past it, the voltage
// falls in proportion — V = V_set · I_limit / I_demand — never a cliff. For a
// resistive load that is exactly the current limit (the load's current falls
// with the voltage), and it is what a lab supply's constant-current mode
// does. The drooped voltage feeds the engine's own power check (`psuVolts`),
// so a chip whose supply sags below its family's minimum is UNDERPOWERED by
// the rule every chip already obeys.
//
// A SHORT — a supply's + wired to a − (its own, or any other: every − is
// ground here) — is a load of next to nothing: the jumper and the contacts it
// passes through, `SHORT_OHMS`. Its demand is the set voltage over that, so
// the supply sits on its current limit, drooped to a fraction of a volt, and
// every chip on it is underpowered — as a bench supply in constant-current
// mode is with its leads touching.
//
// Stated, not modelled: two supplies meeting on one rail (the first PSU is
// booked).

import { partDef } from "../../catalog/index.js";
import { DEFAULT_CURRENT_LIMIT } from "../../catalog/parts.js";
import { partPinAddresses } from "../../model/occupancy.js";
import { formatAddress } from "../../model/breadboard.js";
import { supplyMaOf } from "./params.js";
import { stackedSupplies } from "../floating-grounds.js";

/** A supply this close to its set voltage is not drooping, volts. */
export const DROOP_EPS = 1e-3;

/** What a supply shorted + to − drives, ohms: a jumper (24 AWG, a few
    centimetres — spice/sag.js) and the breadboard contacts at its ends. */
export const SHORT_OHMS = 0.1;

/** The key a resistive element is booked under, by its two lead addresses —
    the same in spice/lamps.js, whose solve books the resistors around an
    LED in place of this file's reading of them. */
export function resistorKey(aAt, bAt) {
  return `${aAt}|${bAt}`;
}

/** Each netlist's supply topology (`supplyTopology`). A netlist is rebuilt
    whenever the document or a switch changes (NetlistCache), so it is exactly
    as long-lived as the facts below — which is what lets a 100 Hz run read
    them once rather than walking every part's pins every tick. */
const TOPOLOGY = new WeakMap();

/**
 * The parts of a desk the supply reading needs and a run cannot change: the
 * supplies and their nets, each chip's supply pins, and each switching
 * part's terminals. Computed once per netlist.
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
  // A supply stacked on another (sim/floating-grounds.js): its end on the
  // other's net is that net's — its + on ground is no + rail of its own.
  const stacked = stackedSupplies(doc, netlist);
  let vHigh = 0;
  for (const comp of doc.components ?? []) {
    if (comp.kind !== "psu") continue;
    const set = comp.params?.volts ?? 5;
    const limit = comp.params?.currentLimit ?? DEFAULT_CURRENT_LIMIT;
    const plus = netOf(formatAddress(comp.id, "+"));
    const minus = netOf(formatAddress(comp.id, "-"));
    psus.push({ id: comp.id, set, limit, plus, minus });
    const sharedPlus = stacked.get(comp.id)?.shared === plus;
    if (plus && !sharedPlus && !psuOfNet.has(plus)) psuOfNet.set(plus, comp.id); // prettier-ignore
    vHigh = Math.max(vHigh, stacked.get(comp.id)?.volts ?? set);
  }
  // The nets a stacked supply's − is only as the other supply's + (a supply
  // on top of another): no ground, and no short for that + to be on.
  const liftedMinus = new Set();
  for (const st of stacked.values()) if (st.shared === st.minus) liftedMinus.add(st.minus); // prettier-ignore
  const minusNets = new Set(psus.map((p) => p.minus).filter((n) => n && !liftedMinus.has(n))); // prettier-ignore
  // Each stacked supply's own end — a rail at its stack's voltage.
  const stackRails = new Map([...stacked].map(([id, st]) => [st.rail, id]));

  const feeds = new Map(); // compId → {vccAt, gndAt}
  const terminals = new Map(); // a switching part's id → pin → address
  for (const comp of doc.components ?? []) {
    const def = partDef(comp.ref);
    if (!def || comp.kind === "psu" || comp.kind === "clock") continue;
    const vcc = def.pins?.find((p) => p.role === "vcc")?.n;
    const switching = Array.isArray(def.logic?.channels);
    if (vcc == null && !switching) continue;
    if (comp.board == null) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const at = new Map(pins.map((p) => [p.pin, p.address]));
    if (switching) terminals.set(comp.id, at);
    if (vcc != null) {
      const gnd = def.pins.find((p) => p.role === "gnd")?.n;
      feeds.set(comp.id, { vccAt: at.get(vcc) ?? null, gndAt: at.get(gnd) ?? null }); // prettier-ignore
    }
  }
  const topo = { psus, psuOfNet, minusNets, vHigh, feeds, terminals, stacked, liftedMinus, stackRails }; // prettier-ignore
  TOPOLOGY.set(netlist, topo);
  return topo;
}

/** A stacked supply's delivered volts, as the context was built with them
    (sim/engine.js's `stackedVolts`: its `psuVolts`, Spice Lite's droop). */
export function stackedVolts(ctx, id, st) {
  return ctx.stackedVolts?.get(id) ?? st.set;
}

/**
 * Where a supply past its limit sits, volts: V_set · I_limit / I_demand —
 * exact for a resistive load, whose current falls with the voltage — unless
 * at the voltage it last delivered (`at`) it drew UNDER its limit. Then the
 * load is not resistive (a regulator charging its output capacitor draws
 * its full current at the set voltage and next to nothing once its input
 * is pulled down to what its output stands at), and the proportional droop
 * pulled it to where it drew nothing, held there for good: the 7805 stood
 * at 3.98 V on a 1 A, 9 V supply. The current is then taken as straight
 * between the two (a resistive load's line is exactly that), and the supply
 * put where it meets the limit — never deeper than the proportional droop,
 * never above the set voltage. Each tick runs it again from where it sits.
 * @param {number} set
 * @param {number} limit
 * @param {number} demand - amps at the set voltage
 * @param {{volts: number, demand: number}} [at]
 */
export function droopVolts(set, limit, demand, at) {
  const proportional = (set * limit) / demand;
  if (!at || !(at.volts < set) || !(at.demand < limit) || !(demand > at.demand)) return proportional; // prettier-ignore
  const v = at.volts + ((limit - at.demand) * (set - at.volts)) / (demand - at.demand); // prettier-ignore
  return Math.min(set, Math.max(proportional, v));
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
 * @param {object} opts.config - normalized spice config
 * @param {Array<{psu: string, plusAt: string|null, minusAt: string|null,
 *   amps: number}>} [opts.draws] - what the voltage solve says each supply
 *   delivers beyond the chips' own supply current, at its SET voltage
 *   (spice/voltages.js `report`)
 * @param {Map<string, {volts: number, demand: number}>} [opts.delivered] -
 *   each supply's voltage as the tick ran on it, and its demand there: a
 *   supply past its limit is put where its demand meets the limit between
 *   that and its set voltage (`droopVolts`)
 * @param {Map<string, {volts: number, amps: number, limited: boolean}>}
 *   [opts.held] - each supply ON ITS LIMIT, whose + the voltage solve holds
 *   (spice/analog-devices.js "p"): what it delivers is the solve's, every
 *   draw on it included — none of the rest is booked to it again
 * @returns {{supplies: Map<string, {set: number, volts: number,
 *   amps: number, demand: number, limit: number, limited: boolean}>,
 *   draws: Array<{chip: string|null, psu: string, plusAt: string|null,
 *   minusAt: string|null, amps: number}>}}
 */
export function measureSupplies({
  doc,
  netlist,
  ctx,
  config,
  draws: flows = [],
  delivered = null,
  held = null,
}) {
  // prettier-ignore
  const topo = supplyTopology(doc, netlist);
  const { psuOfNet } = topo;
  if (!topo.psus.length) return { supplies: new Map(), draws: [] };
  const supplies = new Map(
    topo.psus.map((p) => [p.id, { set: p.set, limit: p.limit, demand: 0 }]),
  );
  const draws = [];

  // A chip's supply: the PSU on its VCC pin's net. Its ICC enters at its
  // VCC pin and returns at its (first) ground pin. A chip not straight
  // across the rails (its ground through something) draws through whatever
  // feeds it, which the voltage solve books.
  for (const c of ctx.chips) {
    if (c.passive) continue;
    const vcc = c.def.pins.find((p) => p.role === "vcc")?.n;
    const psu = psuOfNet.get(c.pinNet.get(vcc));
    const at = topo.feeds.get(c.comp.id);
    if (!psu || !at || held?.has(psu)) continue;
    const grounded = c.def.pins
      .filter((p) => p.role === "gnd")
      .every((p) => topo.minusNets.has(c.pinNet.get(p.n)) && !topo.stackRails.has(c.pinNet.get(p.n))); // prettier-ignore
    if (!grounded) continue;
    const volts = ctx.chipStatus.get(c.comp.id)?.volts ?? c.supplyVolts ?? 5;
    const tiedLow = (pin) => topo.minusNets.has(c.pinNet.get(pin));
    const amps = supplyMaOf(config, c.def, volts, tiedLow) / 1000;
    supplies.get(psu).demand += amps;
    draws.push({ chip: c.comp.id, psu, plusAt: at.vccAt, minusAt: at.gndAt, amps }); // prettier-ignore
  }
  for (const d of flows) {
    const supply = supplies.get(d.psu);
    if (!supply || !(d.amps > 0) || held?.has(d.psu)) continue;
    supply.demand += d.amps;
    draws.push({ ...d });
  }
  // A supply whose + is a − as well: shorted — unless it is stacked on the
  // supply whose − that is, or that − is only a supply stacked on its +.
  for (const p of topo.psus) {
    if (!p.plus || !(p.set > 0) || !topo.minusNets.has(p.plus)) continue;
    if (topo.stacked.has(p.id) || topo.liftedMinus.has(p.plus)) continue;
    const amps = p.set / SHORT_OHMS;
    supplies.get(p.id).demand += amps;
    draws.push({ chip: null, psu: p.id, plusAt: formatAddress(p.id, "+"), minusAt: formatAddress(p.id, "-"), amps }); // prettier-ignore
  }

  // A stacked supply delivers what its own end carries: below ground (a
  // − rail), every draw returning into it; on top of another (a + rail of
  // its own, booked to it by `psuOfNet` like any), and so the supply under
  // it carries that too.
  if (topo.stacked.size) {
    const netOfAt = (at) => (at ? (netlist.netOfPoint.get(at) ?? null) : null); // prettier-ignore
    for (const [id, st] of topo.stacked) {
      if (st.rail !== st.minus) continue;
      for (const d of draws) {
        if (netOfAt(d.minusAt) === st.rail) supplies.get(id).demand += d.amps;
      }
    }
    for (const [id, st] of topo.stacked) {
      if (st.rail !== st.plus) continue;
      const below = topo.psus.find((q) => q.id !== id && q.plus === st.shared);
      if (below) supplies.get(below.id).demand += supplies.get(id).demand;
    }
  }
  const out = new Map();
  const share = new Map(); // psuId → the fraction of its demand it delivers
  for (const [id, { set, limit, demand }] of supplies) {
    const h = held?.get(id);
    if (h) {
      share.set(id, 1);
      out.set(id, { set, volts: h.volts, amps: h.amps, demand: h.amps, limit, limited: h.limited }); // prettier-ignore
      continue;
    }
    share.set(id, demand > limit ? limit / demand : 1);
    const limited = demand > limit;
    const volts = limited ? droopVolts(set, limit, demand, delivered?.get(id)) : set; // prettier-ignore
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
