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

// floating-grounds.js — where a FLOATING circuit's ground is. Pure and
// DOM-free.
//
// An AC adapter's output is isolated from the mains (catalog/ac-parts.js):
// nothing joins its output to earth, so the circuit it feeds has no 0 V
// of its own. On the bench that circuit's ground is wherever the meter's
// black lead goes, and the bench puts it on the DC side's return — the
// ground rail, a bridge rectifier's −. This module finds that net for each
// such circuit, by the same reading: the GALVANIC island an adapter's
// output is on (every net joined to it through anything that passes DC — a
// capacitor does not, nor a transformer across its windings, nor an
// optocoupler or a relay from its input to its output), and, if
// nothing on that island is a supply's terminal, the mains, or a bench
// signal, its ground, in order:
//
//   1. the analyzer's ground lead (`doc.scopeGround`), when it is on the
//      island — the user said where the black lead goes;
//   2. a breadboard − rail strip (the first, in net order) — where the
//      builder said ground is;
//   3. a bridge rectifier's − — where the AC became DC;
//   4. a fixed regulator's GND;
//   5. the adapter's own S2.
//
// Spice Lite holds each such net at 0 V as it holds a PSU's − (sim/engine.js
// `buildContext`), so every voltage on the island reads from it; the logic
// engine has no AC and sees an adapter as nothing, so there it changes
// nothing that runs. An island something else grounds is left alone: its
// ground is that supply's, and a second one would short it.

import { partDef } from "../catalog/index.js";
import { EARTHED_AC } from "../catalog/ac-parts.js";
import { formatAddress } from "../model/breadboard.js";
import { dataPinLevel, drivesPins } from "../model/integration.js";
import { partPinAddresses } from "../model/occupancy.js";
import { UnionFind } from "./union-find.js";

/** Each netlist's answers, by the ground lead's address. */
const MEMO = new WeakMap();

/**
 * The groups of a part's pins (or a brick's terminals) that conduct DC
 * among themselves — each its own island side. A capacitor's leads are
 * each alone; everything not named here is one group.
 * @param {object} def
 * @param {string[]} ids - its pin numbers or terminal ids, as strings
 * @returns {string[][]}
 */
export function conductingSides(def, ids) {
  if (def.capacitor) return ids.map((id) => [id]);
  if (def.kind === "transformer")
    return [
      ["P1", "P2"],
      ["S1", "S2"],
    ];
  const split = (inner) => {
    const a = inner.map(String);
    return [a, ids.filter((id) => !a.includes(id))];
  };
  if (def.optocoupler) return split([def.optocoupler.a, def.optocoupler.k]);
  if (def.coil && def.contacts) return split([def.coil.a, def.coil.b]);
  return [ids];
}

/**
 * Every floating circuit's ground: `Map<adapterId, net>` — at most one per
 * island (the first adapter on it, in desk order, names it).
 * @param {object} doc
 * @param {{netOfPoint: Map, nets: Map}} netlist
 * @returns {Map<string, string>}
 */
export function floatingGrounds(doc, netlist) {
  const components = doc?.components ?? [];
  if (!components.some((c) => c.kind === "adapter")) return new Map();
  const lead = typeof doc.scopeGround === "string" ? doc.scopeGround : "";
  let memo = MEMO.get(netlist);
  if (!memo) MEMO.set(netlist, (memo = new Map()));
  const known = memo.get(lead);
  if (known) return known;

  const netOf = (address) => (address ? (netlist.netOfPoint.get(address) ?? null) : null); // prettier-ignore
  const uf = new UnionFind();
  for (const id of netlist.nets.keys()) uf.add(id);
  const supplied = new Set(); // nets a supply, the mains or a bench signal holds
  const bridgeMinus = [];
  const regulatorGnd = [];
  for (const comp of components) {
    const def = partDef(comp.ref);
    if (!def) continue;
    // Its pins' (or terminals') nets, by id.
    const nets = new Map();
    if (comp.board == null) {
      for (const t of def.terminals ?? []) nets.set(t.id, netOf(formatAddress(comp.id, t.id))); // prettier-ignore
    } else {
      for (const { pin, address } of partPinAddresses(doc, comp) ?? []) nets.set(String(pin), netOf(address)); // prettier-ignore
    }
    for (const side of conductingSides(def, [...nets.keys()])) {
      const on = side.map((id) => nets.get(id)).filter(Boolean);
      for (let i = 1; i < on.length; i++) uf.union(on[0], on[i]);
    }
    if (comp.kind === "psu" || EARTHED_AC[comp.kind]) {
      for (const net of nets.values()) if (net) supplied.add(net);
    }
    if (def.rectifier) {
      const minus = def.pins?.find((p) => p.name === "-")?.n;
      if (minus != null && nets.get(String(minus))) bridgeMinus.push(nets.get(String(minus))); // prettier-ignore
    }
    if (def.regulator && !def.regulator.adjustable) {
      const gnd = nets.get(String(def.regulator.pins.ref));
      if (gnd) regulatorGnd.push(gnd);
    }
  }
  // A bench signal's flag, or an Input's or data bus's tag, drives its net
  // from the bench's own ground.
  for (const sig of doc.signals ?? []) {
    const net = netOf(sig?.flag?.anchor);
    if (net) supplied.add(net);
  }
  for (const element of doc.integrations ?? []) {
    if (!drivesPins(element)) continue;
    for (const [key, tag] of Object.entries(element.tags ?? {})) {
      // A data-bus pin left open (Z) holds nothing.
      if (element.kind === "data" && dataPinLevel(element, key) === "Z") continue; // prettier-ignore
      const net = key === "T" ? null : netOf(tag?.anchor);
      if (net) supplied.add(net);
    }
  }
  const groundedRoots = new Set([...supplied].map((net) => uf.find(net)));

  const out = new Map();
  const taken = new Set(); // islands already given their ground
  const leadNet = netOf(lead);
  for (const comp of components) {
    if (comp.kind !== "adapter") continue;
    const s1 = netOf(formatAddress(comp.id, "S1"));
    const s2 = netOf(formatAddress(comp.id, "S2"));
    const own = s2 ?? s1;
    if (!own) continue;
    const root = uf.find(own);
    if (groundedRoots.has(root) || taken.has(root)) continue;
    taken.add(root);
    const onIsland = (net) => net != null && uf.find(net) === root;
    let ground = onIsland(leadNet) ? leadNet : null;
    if (!ground) {
      for (const [id, net] of netlist.nets) {
        if (onIsland(id) && net.rails?.some((r) => r.endsWith("-"))) {
          ground = id;
          break;
        }
      }
    }
    ground ??= bridgeMinus.find(onIsland) ?? regulatorGnd.find(onIsland) ?? own; // prettier-ignore
    out.set(comp.id, ground);
  }
  memo.set(lead, out);
  return out;
}

/** Each netlist's stacked supplies (`stackedSupplies`), by the ground
    lead's address. */
const STACKED = new WeakMap();

/**
 * Each bench supply STACKED on another — a ± rail, or one supply on top of
 * another: its + on another supply's −, or its − on another's + — whose −
 * reaches no other supply's − (the 2026-10-26 review: two 5 V supplies
 * stacked for an LM358 were read as a short, every − being ground, and the
 * lower one held at its limit, 0.1 V). Such a supply FLOATS, as an AC
 * adapter's circuit does, and is found the same way — by walking. Supplies
 * whose − another's − shares are grounded, and so is a supply that shares
 * no terminal with another; of a stack of the rest (supplies joined only by
 * their terminals), ONE − is ground, as the bench puts the black lead: the
 * analyzer's ground lead's, else a breadboard − rail strip's, else the first
 * supply's. From the grounded supplies the walk goes along the supplies'
 * terminals, each stacked one taking the voltage the stack puts its other
 * end at. Its terminal on the other supply's net is that net's (its + on
 * ground is ground, no + rail); its other end (`rail`) is a rail of its
 * own, at `volts` (its set voltage on the stack: below ground, or above the
 * other's +). One whose ends the walk reaches at voltages its own does not
 * join (a supply wired across another backwards) is no stack, and stays the
 * short it is.
 * @param {object} doc
 * @param {{netOfPoint: Map, nets: Map}} netlist
 * @returns {Map<string, {plus: string, minus: string, set: number,
 *   shared: string, rail: string, volts: number}>} psu id → the stack, in
 *   the order the walk reached them (a stack's lower supply first)
 */
export function stackedSupplies(doc, netlist) {
  const lead = typeof doc?.scopeGround === "string" ? doc.scopeGround : "";
  let memo = STACKED.get(netlist);
  if (!memo) STACKED.set(netlist, (memo = new Map()));
  const known = memo.get(lead);
  if (known) return known;
  const out = new Map();
  memo.set(lead, out);
  const netOf = (address) => netlist.netOfPoint.get(address) ?? null;
  const psus = [];
  for (const comp of doc?.components ?? []) {
    if (comp.kind !== "psu") continue;
    const plus = netOf(formatAddress(comp.id, "+"));
    const minus = netOf(formatAddress(comp.id, "-"));
    if (!plus || !minus || plus === minus) continue;
    psus.push({ id: comp.id, set: comp.params?.volts ?? 5, plus, minus });
  }
  if (psus.length < 2) return out;
  const touches = (p, net) => p.plus === net || p.minus === net;
  const joined = (p, q) => touches(q, p.plus) || touches(q, p.minus);
  const grounded = (p) =>
    psus.some((q) => q !== p && q.minus === p.minus) ||
    !psus.some((q) => q !== p && joined(p, q));
  // Each stack nothing grounds gets its ground: the lead's, a − rail
  // strip's, the first supply's.
  const roots = new Set(psus.filter(grounded));
  const uf = new UnionFind();
  for (const p of psus) {
    uf.find(p.id);
    for (const q of psus) if (q !== p && joined(p, q)) uf.union(p.id, q.id);
  }
  const groundLead = lead ? netOf(lead) : null;
  const minusRail = (p) => netlist.nets?.get(p.minus)?.rails?.some((r) => r.endsWith("-")); // prettier-ignore
  const stacks = new Map(); // root id → its supplies, in document order
  for (const p of psus) {
    const k = uf.find(p.id);
    if (!stacks.has(k)) stacks.set(k, []);
    stacks.get(k).push(p);
  }
  for (const stack of stacks.values()) {
    if (stack.some((p) => roots.has(p))) continue;
    roots.add(
      stack.find((p) => p.minus === groundLead) ??
        stack.find(minusRail) ??
        stack[0],
    );
  }
  // The grounded supplies' nets at their SET volts; a net they put at two
  // voltages (a supply's + on another's −) is a short, and nothing stacks
  // on it.
  const volts = new Map();
  const torn = new Set();
  const place = (net, v) => {
    if (!volts.has(net)) volts.set(net, v);
    else if (Math.abs(volts.get(net) - v) > 1e-9) torn.add(net);
  };
  for (const p of roots) {
    place(p.minus, 0);
    place(p.plus, p.set);
  }
  const stacked = psus.filter((p) => !roots.has(p));
  for (let moved = true; moved;) {
    moved = false;
    for (const p of stacked) {
      if (out.has(p.id)) continue;
      const atPlus = volts.has(p.plus) && !torn.has(p.plus);
      const atMinus = volts.has(p.minus) && !torn.has(p.minus);
      // Both ends already somewhere (or neither, yet): no stack of its own.
      if (atPlus === atMinus) continue;
      const shared = atPlus ? p.plus : p.minus;
      const rail = atPlus ? p.minus : p.plus;
      const v = atPlus ? volts.get(p.plus) - p.set : volts.get(p.minus) + p.set; // prettier-ignore
      volts.set(rail, v);
      out.set(p.id, { plus: p.plus, minus: p.minus, set: p.set, shared, rail, volts: v }); // prettier-ignore
      moved = true;
    }
  }
  return out;
}
