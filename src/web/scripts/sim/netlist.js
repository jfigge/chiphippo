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
 * @property {string[]} rails            rail segments present ("bb1.+", or "bb1.L+" on a split rail)
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
 * @param {{bridges?: boolean, inductors?: "wire"|"branch"}} [options]
 *   `inductors: "branch"` leaves an inductor with an inductance OUT of the
 *   union (its two leads two nets): Spice Lite's netlist, which carries the
 *   coil as a branch of its own (spice/inductors.js). Everything else — the
 *   digital engine, the exports, the schematic — sees it as the wire it is
 *   at DC (the default).
 *   `bridges: false` partitions by WIRING
 *   ALONE — board nodes and wires, with every switch, button and toggle treated
 *   as an open contact however it is actually set. The simulator always wants
 *   the default: a closed switch really does join its two pins, and that is the
 *   whole point of flipping one. What wiring-only answers is the different
 *   question "what did the BUILD connect", which is what a checker comparing an
 *   intended topology against a built one has to ask — a switch thrown to a
 *   rail merges its signal net into that rail, and calling that an accidental
 *   short would condemn the most ordinary input stage there is.
 * @returns {{ netOfPoint: Map<string,string>, nets: Map<string, NetInfo>,
 *   names: Map<string,string>, nameConflicts: Array<object>,
 *   wiringNetOfPoint: Map<string,string>, wiringNames: Map<string,string> }}
 *   — `names` maps a net id to its resolved user name; `nameConflicts` lists
 *   merge losers. Names resolve on the WIRING partition (see below):
 *   `wiringNetOfPoint` and `wiringNames` say which wiring net a point is on
 *   and what it is called, which is what "the name AT this point" means
 *   whatever the partition.
 */
export function buildNetlist(doc, partStates = new Map(), options = {}) {
  const conduct = options.bridges !== false;
  const boards = doc.boards ?? [];
  const components = doc.components ?? [];
  const wires = doc.wires ?? [];
  const boardById = new Map(boards.map((b) => [b.id, b]));
  const uf = partition(doc, partStates, conduct, options.inductors === "branch"); // prettier-ignore

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
        // The rail SEGMENT (`nodeOf`): `bb1.+` on a continuous rail, but
        // `bb1.L+` / `bb1.R+` for the two halves of a split one.
        const parsed = parseHole(board.type, point);
        if (parsed?.kind === "rail")
          railSet.add(`${owner}.${nodeOf(board.type, point)}`);
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

  // Resolve user net-name bindings (Feature 120). A name binds by ADDRESS, so
  // it follows the net through key changes — and it names a net as the BUILD
  // connected it: board nodes and wires, never a switch or a button, however
  // it is set. Resolved through the conducting partition, a name bound to a
  // switch's output spread through its closed contact onto the rail it
  // reached, and every VCC pin on the desk wore it (and naming the other
  // side, or flipping the switch, read as a merge conflict). So bindings
  // resolve on the WIRING partition — the schematic's and the exports' — and
  // two bindings landing on one WIRING net is the soft MERGE conflict: a
  // deterministic winner (name then address order) keeps the name; the loser
  // is reported, never dropped.
  const bindings = [...(doc.netNames ?? [])].sort((a, b) =>
    a.name === b.name
      ? a.address < b.address
        ? -1
        : 1
      : a.name < b.name
        ? -1
        : 1,
  );
  let wiringNetOfPoint = netOfPoint;
  if (conduct && bindings.length) {
    wiringNetOfPoint = new Map();
    for (const [, members] of partition(doc, partStates, false).groups()) {
      const id = members.reduce((min, k) => (k < min ? k : min), members[0]);
      for (const address of members) wiringNetOfPoint.set(address, id);
    }
  }
  const wiringNames = new Map(); // wiring net id → name
  const nameConflicts = []; // { netId, name, address, winner } (wiring net)
  for (const { address, name } of bindings) {
    const netId = wiringNetOfPoint.get(address);
    if (netId == null) continue; // address on no net (its board is gone)
    if (wiringNames.has(netId)) {
      nameConflicts.push({ netId, name, address, winner: wiringNames.get(netId) }); // prettier-ignore
    } else {
      wiringNames.set(netId, name);
    }
  }
  // This partition's own nets. Partitioned by wiring, they ARE the named nets.
  // Conducting, a net a closed contact has joined holds several wiring nets,
  // and it carries a name only when EVERY one of them carries that same name:
  // a switch's named output thrown onto the rail does not name the rail.
  let names = wiringNames;
  if (wiringNetOfPoint !== netOfPoint) {
    names = new Map();
    const parts = new Map(); // conducting net → its wiring nets
    for (const [address, netId] of netOfPoint) {
      if (!parts.has(netId)) parts.set(netId, new Set());
      parts.get(netId).add(wiringNetOfPoint.get(address));
    }
    for (const [netId, wiring] of parts) {
      const [first] = wiring;
      const name = wiringNames.get(first);
      if (name == null) continue;
      if ([...wiring].every((w) => wiringNames.get(w) === name)) {
        names.set(netId, name);
      }
    }
  }

  return {
    netOfPoint,
    nets,
    names,
    nameConflicts,
    wiringNetOfPoint,
    wiringNames,
  };
}

/** Whether a part is an inductor Spice Lite carries as a branch: one with an
    inductance (a blank one is a wire in every engine). */
export function isInductorBranch(def, params) {
  return Boolean(def?.inductor) && Number(params?.henries) > 0;
}

/**
 * The union-find over every point of the desk: board nodes, wires, part pins
 * and terminals — and, when `conduct`, each part's ACTIVE internal bridges.
 * @returns {UnionFind}
 */
function partition(doc, partStates, conduct, inductorBranches = false) {
  const uf = new UnionFind();
  const boards = doc.boards ?? [];
  const components = doc.components ?? [];
  const wires = doc.wires ?? [];

  // 1) Board internal nodes: union every hole to the first hole of its node.
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
    // Active internal bridges (switch/button conduction) join real holes —
    // but an inductor with an inductance is a BRANCH where the caller asks
    // for one (Spice Lite: the voltage across it is the point).
    const branch = inductorBranches && isInductorBranch(def, comp.params);
    const bridges =
      conduct && def.internalBridges && !branch
        ? def.internalBridges(comp.params, partStates.get(comp.id))
        : [];
    for (const [a, b] of bridges) {
      const aa = addressOfPin.get(a);
      const ab = addressOfPin.get(b);
      if (aa && ab) uf.union(aa, ab); // a floating end bridges nothing
    }
  }

  return uf;
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
