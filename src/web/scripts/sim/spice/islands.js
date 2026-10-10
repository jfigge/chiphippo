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

// spice/islands.js — a desk's ISLANDS (features/04-island-analog-
// bookkeeping.md): the parts of it that cannot see each other. Pure and
// DOM-free.
//
// Two nets are on one island when anything can carry a signal or a current
// between them: a chip (every pin of it — a chip couples all its pins), a
// resistor, a junction, a switch channel, a transistor, an off-rail chip's
// supply, a bench device (each the voltage solve's — `voltageTopology`'s
// clusters say all of these), and a capacitor (both plates). A clock brick
// or a signal flag drives the one net it is on. RAILS are never a join
// point, as in `voltageTopology`: they are stiff, so two oscillators on one
// supply are two islands.
//
// An island is named by the least of its nets (net ids are stable across a
// rebuild), and it is ANALOG when an RC node, a running wave or an inductor
// is on it — what has a cycle, a budget and a chatter back-off of its own
// (spice/engine.js). Everything that moves the desk between ticks is on one
// analog island or another; an island with none of them moves only when a
// settle moves it.

import { UnionFind } from "../union-find.js";

/** Each analysis's islands (`islandsOf`), by the voltage topology they were
    read from. */
const ISLANDS = new WeakMap(); // s → {topo, value}

/**
 * A desk's islands: `islandOf` (net → island), `chipIsland` (chip id →
 * island), `coilIsland` (inductor id → island), `nets` (island → its nets),
 * `analog` (the analog islands, in order), `analogSet`, `groupOf` (island →
 * its supply group) and `sourceIsland` (`clock:<id>`/`signal:<id>` → the
 * island its net is in).
 * @param {object} s - spice/engine.js `analyze`'s answer (`candidates`,
 *   `capPins`, `trace`)
 * @param {{chips: object[]}} ctx - sim/engine.js's context
 * @param {{clusterOf: Map, clusters: {nets: string[]}[], coils?: object[]}} topo
 * @param {{fresh?: boolean}} [opts] - `fresh`: computed again, the cache
 *   neither read nor written (`SPICE_ASSERT_ANALYSIS`)
 */
export function islandsOf(s, ctx, topo, { fresh = false } = {}) {
  const cached = fresh ? null : ISLANDS.get(s);
  if (cached?.topo === topo) return cached.value;
  const rail = (net) => Boolean(s.trace.rail(net)) || s.railVolts.has(net);
  const uf = new UnionFind();
  const add = (net) => {
    if (net != null && !rail(net)) uf.add(net);
  };
  const join = (a, b) => {
    if (a == null || b == null || rail(a) || rail(b)) return;
    uf.union(a, b);
  };
  for (const { nets } of topo.clusters) {
    for (const net of nets) add(net);
    for (let i = 1; i < nets.length; i++) join(nets[0], nets[i]);
  }
  for (const { a, b } of s.capPins.values()) {
    add(a);
    add(b);
    join(a, b);
  }
  for (const net of s.candidates.keys()) add(net);
  for (const c of ctx.chips) {
    let first = null;
    for (const net of c.pinNet.values()) {
      if (net == null || rail(net)) continue;
      add(net);
      if (first == null) first = net;
      else join(first, net);
    }
  }
  const nets = new Map(); // island → its nets
  for (const members of uf.groups().values()) {
    const name = members.reduce((min, k) => (k < min ? k : min), members[0]);
    nets.set(name, members);
  }
  const islandOf = new Map();
  for (const [name, members] of nets) {
    for (const net of members) islandOf.set(net, name);
  }
  const chipIsland = new Map();
  for (const c of ctx.chips) {
    for (const net of c.pinNet.values()) {
      const name = islandOf.get(net);
      if (name == null) continue;
      chipIsland.set(c.comp.id, name);
      break;
    }
  }
  const coilIsland = new Map();
  for (const l of topo.coils ?? []) {
    const name = islandOf.get(l.a) ?? islandOf.get(l.b);
    if (name != null) coilIsland.set(l.id, name);
  }
  const analogSet = new Set(coilIsland.values());
  for (const net of s.candidates.keys()) {
    const name = islandOf.get(net);
    if (name != null) analogSet.add(name);
  }
  const analog = [...analogSet].sort();
  // Each island's SUPPLY GROUP (features/12-island-scheduling.md): islands
  // fed by one supply share its droop and its wires' sag, so they are
  // scheduled together — two islands are one group when anything of theirs
  // reaches one supply (a rail, a clock brick's supply).
  const psuOf = (net) => topo.sup?.psuOfNet.get(net) ?? `rail:${net}`;
  const feeds = new UnionFind();
  const fed = (island, net) => {
    if (island == null || net == null || !rail(net)) return;
    feeds.union(`i:${island}`, `p:${psuOf(net)}`);
  };
  for (const cl of topo.clusters) {
    const island = islandOf.get(cl.nets.find((n) => islandOf.has(n)));
    for (const net of cl.rails ?? []) fed(island, net);
  }
  for (const c of ctx.chips) {
    const island = chipIsland.get(c.comp.id);
    for (const net of c.pinNet.values()) fed(island, net);
  }
  for (const { a, b } of s.capPins.values()) {
    fed(islandOf.get(b), a);
    fed(islandOf.get(a), b);
  }
  for (const [out, { psu }] of topo.clockPsu ?? []) {
    const island = islandOf.get(out);
    if (island != null) feeds.union(`i:${island}`, `p:${psu}`);
  }
  // The islands anything happens on — a chip, a node, a source, a part in a
  // network; a bare row of holes is an island too, but no one's concern.
  const active = new Set([...chipIsland.values(), ...analogSet]);
  for (const cl of topo.clusters) {
    if (!(cl.resistors.length || cl.junctions.length || cl.channels.length || cl.devices.length || cl.loads.length || cl.inductors.length || cl.offChips.length)) continue; // prettier-ignore
    const island = islandOf.get(cl.nets.find((n) => islandOf.has(n)));
    if (island != null) active.add(island);
  }
  for (const [net] of topo.sources ?? []) {
    const island = islandOf.get(net);
    if (island != null) active.add(island);
  }
  const groupOf = new Map();
  const members = new Map(); // group → its islands
  for (const name of active) {
    const group = feeds.find(`i:${name}`);
    groupOf.set(name, group);
    if (!members.has(group)) members.set(group, []);
    members.get(group).push(name);
  }
  // Each bench source's island (a clock's or a flag's net's).
  const sourceIsland = new Map(); // `clock:<id>` | `signal:<id>` → island
  for (const [net, list] of topo.sources ?? []) {
    for (const src of list) sourceIsland.set(`${src.kind}:${src.id}`, islandOf.get(net) ?? null); // prettier-ignore
  }
  const value = { islandOf, chipIsland, coilIsland, nets, analog, analogSet, groupOf, members, sourceIsland }; // prettier-ignore
  // (`groupOf` and `members` cover the active islands only.)
  if (!fresh) ISLANDS.set(s, { topo, value });
  return value;
}
