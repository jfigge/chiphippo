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

// spice/sag.js — the voltage a chip loses in the jumper wires between it and
// its supply (features/spice-lite.md §4.7). Pure and DOM-free.
//
// Every wire is 24 AWG solid copper — one built-in constant, no gauge picker —
// at its real length (model/wire-length.js `wireCutMm`: the run plus the two
// stripped ends in the holes). The board itself is taken as perfect: a
// 5-hole column-half or a rail line is ONE node, with no resistance inside it.
//
// LUMPED, NOT NODAL (no matrix solve, by the spec). The wiring is a graph —
// nodes are board nodes and brick terminals, edges are wires weighted by their
// resistance — and each current a supply delivers (spice/supply.js's draws: a
// chip's ICC, a resistor's current) is routed along the LOWEST-RESISTANCE
// path from the supply's + terminal to where it is drawn, and back from where
// it returns to the supply's −. Each wire then carries the sum of the currents
// routed through it, and a chip's DROP is Σ I·R over the wires of its own two
// paths. So a chain of chips fed one from the next sags most at the far end,
// and a wire shared by many draws drops for all of them — which is the lesson.
//
// What that gives up, stated: current SPLITTING over parallel paths (a second
// feed wire is ignored, not shared — the drop is overstated there); the
// contact resistance of the breadboard springs and the strips' own copper
// (both real, and both larger than the wire's); paths through a switch,
// inductor or anything but a wire (no path → no drop); and any effect of the
// drop back on the currents.

import { boardNodeOf, parseAddress } from "../../model/breadboard.js";
import { wireCutMm } from "../../model/wire-length.js";

/** 24 AWG annealed copper at 20 °C: 84.2 mΩ/m (26.7 mΩ/ft; 0.0842 Ω/m). */
export const WIRE_OHMS_PER_M = 0.0842;

/** A wire's resistance, ohms. */
export function wireOhms(doc, wireId) {
  return (wireCutMm(doc, wireId) / 1000) * WIRE_OHMS_PER_M;
}

/** Each netlist's wiring graph (`sagTopology`). A netlist is rebuilt on
    every document change and every switch flip (NetlistCache) — exactly when
    a wire could have been added, removed or moved — so it is the right key:
    a run reads the graph, and every lowest-resistance path found in it, once
    rather than every tick. */
const TOPOLOGY = new WeakMap();

/**
 * The wiring as a graph — vertices are board nodes and brick terminals,
 * edges the wires, weighted by their resistance — and a memo of the
 * lowest-resistance paths found in it. Computed once per netlist.
 * @param {object} doc
 * @param {object} netlist
 * @returns {{vertexOf: (address: string) => string,
 *   ohmsOf: Map<string, number>,
 *   pathsFrom: (source: string) => (target: string) => string[]|null}}
 */
export function sagTopology(doc, netlist) {
  const cached = TOPOLOGY.get(netlist);
  if (cached) return cached;
  const boards = new Map((doc.boards ?? []).map((b) => [b.id, b]));
  const vertices = new Map();
  const vertexOf = (address) => {
    if (vertices.has(address)) return vertices.get(address);
    const parsed = parseAddress(address);
    const board = parsed ? boards.get(parsed.boardId) : null;
    // A brick's terminal is its own node.
    const node = board ? boardNodeOf(board, parsed.hole) : null;
    const vertex = board && node ? `${board.id}:${node}` : address;
    vertices.set(address, vertex);
    return vertex;
  };

  const edges = new Map(); // vertex → [{to, wire, ohms}]
  const ohmsOf = new Map();
  const link = (a, b, wire, ohms) => {
    if (!edges.has(a)) edges.set(a, []);
    edges.get(a).push({ to: b, wire, ohms });
  };
  for (const w of doc.wires ?? []) {
    const a = vertexOf(w.from);
    const b = vertexOf(w.to);
    if (!a || !b || a === b) continue;
    const ohms = wireOhms(doc, w.id);
    ohmsOf.set(w.id, ohms);
    link(a, b, w.id, ohms);
    link(b, a, w.id, ohms);
  }

  /** Lowest-resistance paths from one vertex: target vertex → [wire ids]. */
  const memo = new Map();
  const pathsFrom = (source) => {
    if (memo.has(source)) return memo.get(source);
    const dist = new Map([[source, 0]]);
    const via = new Map(); // vertex → {from, wire}
    const open = new Set([source]);
    while (open.size) {
      let here = null;
      for (const v of open) {
        if (here == null || dist.get(v) < dist.get(here)) here = v;
      }
      open.delete(here);
      for (const { to, wire, ohms } of edges.get(here) ?? []) {
        const d = dist.get(here) + ohms;
        if (d < (dist.get(to) ?? Number.POSITIVE_INFINITY)) {
          dist.set(to, d);
          via.set(to, { from: here, wire });
          open.add(to);
        }
      }
    }
    const paths = new Map();
    const pathTo = (target) => {
      if (paths.has(target)) return paths.get(target);
      let wires = null;
      if (dist.has(target)) {
        wires = [];
        for (let v = target; v !== source; v = via.get(v).from) {
          wires.push(via.get(v).wire);
        }
      }
      paths.set(target, wires);
      return wires;
    };
    memo.set(source, pathTo);
    return pathTo;
  };

  const topo = { vertexOf, ohmsOf, pathsFrom };
  TOPOLOGY.set(netlist, topo);
  return topo;
}

/** A supply terminal's vertex name (`psu1.+`), kept per supply. */
const TERMINAL_KEYS = new Map();
function terminalKey(psu, terminal) {
  let keys = TERMINAL_KEYS.get(psu);
  if (!keys) TERMINAL_KEYS.set(psu, (keys = { "+": `${psu}.+`, "-": `${psu}.-` })); // prettier-ignore
  return keys[terminal];
}

/** Each wire of `path` carries `amps` more. */
function addAmps(wireAmps, path, amps) {
  for (let i = 0; i < path.length; i++) {
    const wire = path[i];
    wireAmps.set(wire, (wireAmps.get(wire) ?? 0) + amps);
  }
}

/**
 * Each chip's supply drop and each wire's current.
 * @param {object} doc
 * @param {object} netlist - the key the wiring graph is cached under
 * @param {Array<{chip: string|null, psu: string, plusAt: string|null,
 *   minusAt: string|null, amps: number}>} draws - spice/supply.js
 * @returns {{drops: Map<string, number>, wireAmps: Map<string, number>}}
 */
export function supplySag(doc, netlist, draws) {
  const { vertexOf, ohmsOf, pathsFrom } = sagTopology(doc, netlist);

  // Route every draw, and add its current to each wire on its way — its +
  // path, then its − path, in that order. (Each path the memo's own array,
  // read in place: no array, spread or string built per draw — features/
  // spice-lite-speed-profile.md; the same additions in the same order.)
  const wireAmps = new Map();
  const routed = []; // chip, + path, − path, … by threes
  for (let i = 0; i < draws.length; i++) {
    const d = draws[i];
    if (!(d.amps > 0)) continue;
    const plus = d.plusAt ? pathsFrom(terminalKey(d.psu, "+"))(vertexOf(d.plusAt)) : null; // prettier-ignore
    const minus = d.minusAt ? pathsFrom(terminalKey(d.psu, "-"))(vertexOf(d.minusAt)) : null; // prettier-ignore
    if (plus) addAmps(wireAmps, plus, d.amps);
    if (minus) addAmps(wireAmps, minus, d.amps);
    if (d.chip) routed.push(d.chip, plus, minus);
  }

  // A chip's drop is the sum over the wires its supply comes through, each
  // ONCE: a chip with several draws (its ICC, and a CMOS input's band
  // current beside it) reaches its supply down the same wires, and summed
  // per draw each wire's whole current counted once for every one of them.
  const through = new Map(); // chip → its draws' wires
  for (let i = 0; i < routed.length; i += 3) {
    let set = through.get(routed[i]);
    if (!set) through.set(routed[i], (set = new Set()));
    const plus = routed[i + 1];
    const minus = routed[i + 2];
    if (plus) for (let j = 0; j < plus.length; j++) set.add(plus[j]);
    if (minus) for (let j = 0; j < minus.length; j++) set.add(minus[j]);
  }
  const drops = new Map();
  for (const [chip, wires] of through) {
    let drop = 0;
    for (const wire of wires) drop += wireAmps.get(wire) * ohmsOf.get(wire);
    drops.set(chip, drop);
  }
  return { drops, wireAmps };
}
