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
// Stated, not modelled: two supplies meeting on one rail (the first PSU is
// booked).

import { partDef } from "../../catalog/index.js";
import { DEFAULT_CURRENT_LIMIT } from "../../catalog/parts.js";
import { partPinAddresses } from "../../model/occupancy.js";
import { formatAddress } from "../../model/breadboard.js";
import { supplyMaOf } from "./params.js";

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
  const topo = { psus, psuOfNet, minusNets, vHigh, feeds, terminals };
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
 * @param {object} opts.config - normalized spice config
 * @param {Array<{psu: string, plusAt: string|null, minusAt: string|null,
 *   amps: number}>} [opts.draws] - what the voltage solve says each supply
 *   delivers beyond the chips' own supply current, at its SET voltage
 *   (spice/voltages.js `report`)
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
    if (!psu || !at) continue;
    const grounded = c.def.pins
      .filter((p) => p.role === "gnd")
      .every((p) => topo.minusNets.has(c.pinNet.get(p.n)));
    if (!grounded) continue;
    const volts = ctx.chipStatus.get(c.comp.id)?.volts ?? c.supplyVolts ?? 5;
    const amps = supplyMaOf(config, c.def, volts) / 1000;
    supplies.get(psu).demand += amps;
    draws.push({ chip: c.comp.id, psu, plusAt: at.vccAt, minusAt: at.gndAt, amps }); // prettier-ignore
  }
  for (const d of flows) {
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
