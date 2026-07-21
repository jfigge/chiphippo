/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// netlist.js — the electrical partition of the desk: every hole, PSU
// terminal, and component pin classified into a NET. Pure and DOM-free —
// Feature 90's simulator imports it unchanged; the overlay renderer draws
// what this says and contains no set arithmetic.
//
// Method (union-find over ADDRESS keys — holes + PSU terminals):
//   • union every hole sharing a board's internal node (5-hole strip / rail),
//   • union each wire's two endpoints,
//   • union the holes joined by each component's ACTIVE internalBridges
//     (switch position / button pressed — that's why part state is an input),
//   • add each PSU terminal as its own point.
// Chip pins are MEMBERS, not conduits: a pin joins the net of its seated
// hole; chips never conduct pin-to-pin here (that's the simulator's job).
//
// Pins resolve through partPinAddresses(), never by pasting comp.board onto a
// hole: a rotated part's free lead may land on a NEIGHBOURING strip, and a
// lead touching nothing at all resolves to null — a floating leg is legal, so
// it simply joins no net while the part's other lead behaves normally.
//
// Net id = the lexicographically smallest member address — deterministic
// across rebuilds, so UI/sim state can follow a net through unrelated edits.

import {
  formatAddress,
  holes,
  nodeOf,
  parseAddress,
  parseHole,
} from "../model/breadboard.js";
import { partPinAddresses } from "../model/occupancy.js";
import { partDef } from "../catalog/index.js";
import { UnionFind } from "./union-find.js";

/**
 * @typedef {object} NetInfo
 * @property {string} id                 smallest member address
 * @property {string[]} points           every member address
 * @property {string[]} holes            board tie-point addresses
 * @property {string[]} rails            rail node ids present ("bb1.t+")
 * @property {string[]} terminals        PSU terminal addresses ("psu1.+")
 * @property {Array<object>} pins        { componentId, ref, pin, name, role, hole }
 * @property {string[]} wires            wire ids with an endpoint in the net
 * @property {{holes,pins,wires,terminals}} counts
 */

/**
 * Build the netlist for a desk document plus volatile part state.
 *
 * @param {{boards:Array, components:Array, wires:Array}} doc
 * @param {Map<string, object>} [partStates] componentId → transient state
 *   (e.g. `{ pressed: true }` for a held button). Switch positions live in
 *   the persisted params, so they need no entry here.
 * @returns {{ netOfPoint: Map<string,string>, nets: Map<string, NetInfo>,
 *   names: Map<string,string>, nameConflicts: Array<object> }} — `names` maps
 *   a net id to its resolved user name; `nameConflicts` lists merge losers.
 */
export function buildNetlist(doc, partStates = new Map()) {
  const uf = new UnionFind();
  const boards = doc.boards ?? [];
  const components = doc.components ?? [];
  const wires = doc.wires ?? [];

  // 1) Board internal nodes: union every hole to the first hole of its node.
  const boardById = new Map(boards.map((b) => [b.id, b]));
  for (const board of boards) {
    const nodeFirst = new Map(); // node id → first hole address seen
    for (const hole of holes(board.type)) {
      const address = formatAddress(board.id, hole);
      uf.add(address);
      const node = nodeOf(board.type, hole);
      const key = `${board.id} ${node}`;
      if (nodeFirst.has(key)) uf.union(address, nodeFirst.get(key));
      else nodeFirst.set(key, address);
    }
  }

  // 2) Wires: union the two endpoints (holes or PSU terminals).
  for (const wire of wires) {
    uf.add(wire.from);
    uf.add(wire.to);
    uf.union(wire.from, wire.to);
  }

  // 3) Component pins/terminals + active bridges.
  for (const comp of components) {
    const def = partDef(comp.ref);
    if (!def) continue;
    // Desk-level bricks (PSU, clock) contribute their terminals as points.
    if (def.terminals && comp.board == null) {
      for (const t of def.terminals) uf.add(formatAddress(comp.id, t.id));
      continue;
    }
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const addressOfPin = new Map(pins.map((p) => [p.pin, p.address]));
    for (const { address } of pins) {
      if (address == null) continue; // a floating lead is a point of nothing
      uf.add(address);
    }
    // Active internal bridges (switch/button conduction) join real holes.
    const bridges = def.internalBridges
      ? def.internalBridges(comp.params, partStates.get(comp.id))
      : [];
    for (const [a, b] of bridges) {
      const aa = addressOfPin.get(a);
      const ab = addressOfPin.get(b);
      if (aa && ab) uf.union(aa, ab); // a floating end bridges nothing
    }
  }

  // Assemble nets from the union-find groups.
  const netOfPoint = new Map();
  const nets = new Map();
  for (const [, members] of uf.groups()) {
    const id = members.reduce((min, k) => (k < min ? k : min), members[0]);
    const info = {
      id,
      points: members,
      holes: [],
      rails: [],
      terminals: [],
      pins: [],
      wires: [],
      counts: { holes: 0, pins: 0, wires: 0, terminals: 0 },
    };
    const railSet = new Set();
    for (const address of members) {
      netOfPoint.set(address, id);
      const { boardId: owner, hole: point } = parseAddress(address) ?? {};
      const board = boardById.get(owner);
      if (board) {
        info.holes.push(address);
        const parsed = parseHole(board.type, point);
        if (parsed?.kind === "rail") railSet.add(`${owner}.${parsed.railId}`);
      } else {
        info.terminals.push(address); // PSU terminal
      }
    }
    info.rails = [...railSet].sort();
    nets.set(id, info);
  }

  // Classify chip/discrete pins into their hole's net.
  for (const comp of components) {
    if (comp.board == null) continue; // desk-level bricks have no board pins
    const def = partDef(comp.ref);
    const pins = partPinAddresses(doc, comp);
    if (!def || !pins) continue;
    for (const { pin, address } of pins) {
      if (address == null) continue; // a floating lead belongs to no net
      const netId = netOfPoint.get(address);
      const net = nets.get(netId);
      if (!net) continue;
      const decl = def.pins.find((p) => p.n === pin);
      net.pins.push({
        componentId: comp.id,
        ref: comp.ref,
        pin,
        name: decl?.name ?? String(pin),
        role: decl?.role ?? "nc",
        hole: address,
      });
    }
  }

  // Classify wires by their (single) net.
  for (const wire of wires) {
    const netId = netOfPoint.get(wire.from);
    nets.get(netId)?.wires.push(wire.id);
  }

  for (const net of nets.values()) {
    net.counts = {
      holes: net.holes.length,
      pins: net.pins.length,
      wires: net.wires.length,
      terminals: net.terminals.length,
    };
  }

  // Resolve user net-name bindings (Feature 120) to their current nets. A name
  // binds by ADDRESS, so it follows the net through key changes. Two bindings
  // landing on ONE net is a soft MERGE conflict: a deterministic winner (name
  // then address order) keeps the name; the loser is reported, never dropped.
  const names = new Map(); // netId → name
  const nameConflicts = []; // { netId, name, address, winner }
  const bindings = [...(doc.netNames ?? [])].sort((a, b) =>
    a.name === b.name
      ? a.address < b.address
        ? -1
        : 1
      : a.name < b.name
        ? -1
        : 1,
  );
  for (const { address, name } of bindings) {
    const netId = netOfPoint.get(address);
    if (netId == null) continue; // address on no net (its board is gone)
    if (names.has(netId)) {
      nameConflicts.push({ netId, name, address, winner: names.get(netId) });
    } else {
      names.set(netId, name);
    }
  }

  return { netOfPoint, nets, names, nameConflicts };
}

/**
 * A one-line human summary of a net, e.g.
 * "23 holes · 3 chip pins · 2 wires · rail bb1.t+ · psu1.+".
 */
export function summarizeNet(net) {
  if (!net) return "";
  const parts = [];
  parts.push(`${net.counts.holes} hole${net.counts.holes === 1 ? "" : "s"}`);
  if (net.counts.pins) {
    parts.push(
      `${net.counts.pins} chip pin${net.counts.pins === 1 ? "" : "s"}`,
    );
  }
  if (net.counts.wires) {
    parts.push(`${net.counts.wires} wire${net.counts.wires === 1 ? "" : "s"}`);
  }
  for (const rail of net.rails) parts.push(`rail ${rail}`);
  for (const terminal of net.terminals) parts.push(terminal);
  return parts.join(" · ");
}
