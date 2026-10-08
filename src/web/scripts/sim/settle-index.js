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

// settle-index.js — who depends on what, for the incremental settle
// (sim/incremental.js). Pure and DOM-free, and a function of the document and
// netlist ALONE: no chip's power status, no Spice Lite hook, goes into it —
// which is what lets a context built afresh under hooks (sim/engine.js
// `contextFor`) take the index of one prepared earlier from the same objects.
// Chips are named by their INDEX in the context's `chips`, which every
// context of one document lists in the same order.
//
//   readers       net → the chips whose OUTPUTS can change when it does:
//                 what each kind's evaluation actually reads — a
//                 combinational part its logic units' inputs and enables, a
//                 sequential part or a memory its input and io pins
//                 (`inputLevels`), an oscillator can nothing at all.
//   contributors  net → the chips with a pin on it (a net's driver list is
//                 rebuilt from theirs), plus `sources`, the clock bricks and
//                 signals driving it, in the order the drivers are added.
//   controlNets   the nets an analog switch's or transistor's channel reads
//                 its control from — the only nets that move a channel.
//   components    the STATIC coupling components: nets joined by any
//                 resistor, any diode or any channel that COULD conduct, a
//                 rail never a union point (it resolves to its supply
//                 whatever reaches it, so it couples nothing). A net's
//                 resolution depends on nothing outside its component but
//                 rails, so a pass re-resolves only the components whose
//                 drivers or joins changed (settle-pass.js `resolveAll`'s
//                 `scope`). A net in no component is a LONE net: its level is
//                 its own drivers' (`resolveLone`).
//   fixed         the components no driver can ever reach (no chip pin, no
//                 clock, no signal, no channel on any member — every LED
//                 series resistor's far net on a generated desk): resolved
//                 once, here, for good. With nothing driving them, the LED
//                 rule's resolution is the plain one, so it holds under any
//                 hooks.

import { Z } from "./levels.js";
import { resolveNet } from "./resolve.js";
import { UnionFind } from "./union-find.js";
import { resolveAll } from "./settle-pass.js";

/** Append chip index `i` to `map`'s list for `net`, once. */
function push(map, net, i) {
  if (!net) return;
  let list = map.get(net);
  if (!list) map.set(net, (list = []));
  if (list[list.length - 1] !== i) list.push(i);
}

/** The pins a chip's evaluation reads (see the file header). */
function readPins(c) {
  if (c.memory || c.sequential) {
    const sense = c.def.logic?.sense ?? null;
    return c.def.pins
      .filter((p) => p.role === "input" || p.role === "io" || sense?.[p.n])
      .map((p) => p.n);
  }
  if (c.oscillator) return [];
  const pins = [];
  for (const unit of c.def.logic?.units ?? []) {
    pins.push(...(unit.inputs ?? []));
    if (unit.enable != null) pins.push(unit.enable);
  }
  return pins;
}

/**
 * Build the index of a context's fixed lists.
 * @param {{netIds: string[], supplyPlusVolts: Map, supplyMinus: Set,
 *   resistors: Array, diodes: Array, chips: Array, clocks: Array,
 *   signals: Array}} ctx
 */
export function settleIndex(ctx) {
  const { netIds, supplyPlusVolts, supplyMinus, resistors, diodes, chips } =
    ctx;
  const netIndex = new Map(netIds.map((id, i) => [id, i]));
  const isRail = (id) => supplyPlusVolts.has(id) || supplyMinus.has(id);

  // Each rail's resolution, which nothing on it can move.
  const railRes = new Map();
  for (const id of netIds) {
    if (!isRail(id)) continue;
    railRes.set(
      id,
      resolveNet({
        supplyPlus: supplyPlusVolts.has(id),
        supplyMinus: supplyMinus.has(id),
      }),
    );
  }

  const readers = new Map();
  const contributors = new Map();
  const controlNets = new Set();
  const driven = new Set(); // nets a chip pin, a clock or a signal is on
  const channelPairs = []; // [netA, netB] of every channel, on or off
  chips.forEach((c, i) => {
    for (const net of c.pinNet.values()) if (net) driven.add(net);
    if (c.analogSwitch) {
      for (const ch of c.def.logic.channels) {
        for (const pin of ch.inputs) {
          const net = c.pinNet.get(pin);
          if (net) controlNets.add(net);
        }
        channelPairs.push([c.pinNet.get(ch.a), c.pinNet.get(ch.b)]);
      }
      return;
    }
    for (const net of c.pinNet.values()) push(contributors, net, i);
    for (const pin of readPins(c)) push(readers, c.pinNet.get(pin), i);
  });
  const sources = new Map(); // net → [{clock}|{signal}], in driver order
  const addSource = (net, src) => {
    if (!net) return;
    driven.add(net);
    if (!sources.has(net)) sources.set(net, []);
    sources.get(net).push(src);
  };
  for (const clk of ctx.clocks) addSource(clk.outNet, { clock: clk.id });
  for (const sig of ctx.signals) addSource(sig.net, { signal: sig.id });

  // The static components. An edge with a rail end attaches the other end
  // (it is coupled to something) without joining it to anything.
  const uf = new UnionFind();
  const edge = (a, b) => {
    const okA = a && !isRail(a);
    const okB = b && !isRail(b);
    if (okA) uf.add(a);
    if (okB) uf.add(b);
    if (okA && okB && a !== b) uf.union(a, b);
  };
  for (const r of resistors) edge(r.netA, r.netB);
  for (const d of diodes) edge(d.anode, d.cathode);
  for (const [a, b] of channelPairs) edge(a, b);

  const compOf = new Map();
  const comps = [];
  for (const members of uf.groups().values()) {
    const k = comps.length;
    for (const id of members) compOf.set(id, k);
    comps.push({
      nets: members.sort((x, y) => netIndex.get(x) - netIndex.get(y)),
      rails: new Set(),
      resistors: [],
      diodes: [],
      channel: false,
    });
  }
  /** The component an edge belongs to: its first non-rail end's. */
  const owner = (a, b) => {
    for (const id of [a, b]) if (id && !isRail(id)) return comps[compOf.get(id)]; // prettier-ignore
    return null;
  };
  const railsOf = (comp, ...ends) => {
    for (const id of ends) if (id && isRail(id)) comp.rails.add(id);
  };
  for (const r of resistors) {
    const comp = owner(r.netA, r.netB);
    if (!comp) continue;
    comp.resistors.push(r);
    railsOf(comp, r.netA, r.netB);
  }
  for (const d of diodes) {
    const comp = owner(d.anode, d.cathode);
    if (!comp) continue;
    comp.diodes.push(d);
    railsOf(comp, d.anode, d.cathode);
  }
  for (const [a, b] of channelPairs) {
    const comp = owner(a, b);
    if (!comp) continue;
    comp.channel = true;
    railsOf(comp, a, b);
  }
  const channelComps = [];
  comps.forEach((comp, k) => {
    // A scope is the component's nets plus the rails beside them: what its
    // resolution reads, all of it (settle-pass.js `resolveAll`).
    comp.scope = {
      netIds: [...comp.nets, ...comp.rails],
      resistors: comp.resistors,
      diodes: comp.diodes,
    };
    comp.fixed = !comp.channel && comp.nets.every((id) => !driven.has(id));
    if (comp.channel) channelComps.push(k);
  });

  // The components no driver reaches, resolved once and for all.
  const fixed = new Map(); // net → {level, warning, strong}
  const still = comps.filter((comp) => comp.fixed);
  if (still.length) {
    const scope = mergeScopes(still);
    const r = resolveAll(ctx, new Map(), null, null, false, scope);
    const said = new Map(r.netWarnings.map((w) => [w.net, w.type]));
    for (const comp of still) {
      for (const id of comp.nets) {
        fixed.set(id, {
          level: r.next.get(id),
          warning: said.get(id),
          strong: r.strong.get(id),
        });
      }
    }
  }

  // What the incremental settle's cache starts each tick from — levels and
  // strong levels by net INDEX (netIds order), warnings by net — with the
  // rails and the fixed components already resolved.
  const start = { level: [], strong: [], warn: new Map() };
  for (const id of netIds) {
    const res = railRes.get(id);
    const f = res ? { level: res.level, warning: res.warning, strong: res.level } : fixed.get(id); // prettier-ignore
    start.level.push(f ? f.level : Z);
    start.strong.push(f ? f.strong : Z);
    if (f?.warning) start.warn.set(id, f.warning);
  }
  for (const comp of comps) comp.idx = comp.nets.map((id) => netIndex.get(id));
  const lone = netIds.filter((id) => !compOf.has(id) && !railRes.has(id));

  return {
    netIndex,
    railRes,
    start,
    readers,
    contributors,
    sources,
    controlNets,
    compOf,
    comps,
    channelComps,
    fixed,
    // The lone nets: in no component and no rail (and their indices).
    lone,
    loneIdx: lone.map((id) => netIndex.get(id)),
    // The nets a diode's anode is on (indices) — where `uncertain` is read.
    anodes: [...new Set(diodes.map((d) => netIndex.get(d.anode)))],
    // Whether any channel can join anything — even two rails, which belong
    // to no component but still short.
    hasChannels: chips.some((c) => c.analogSwitch),
  };
}

/**
 * One scope covering several components: their nets (each component's in
 * netIds order, so a group's members are met in the order a whole-desk
 * resolve meets them), every rail beside any of them once, and their
 * resistors and diodes.
 */
export function mergeScopes(comps) {
  if (comps.length === 1) return comps[0].scope;
  const netIds = [];
  const rails = new Set();
  const resistors = [];
  const diodes = [];
  for (const comp of comps) {
    netIds.push(...comp.nets);
    for (const id of comp.rails) rails.add(id);
    resistors.push(...comp.resistors);
    diodes.push(...comp.diodes);
  }
  netIds.push(...rails);
  return { netIds, resistors, diodes };
}
