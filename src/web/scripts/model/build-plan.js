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

// build-plan.js — the pure derivation behind the build guide (Feature 140):
// from a plain desk document plus its netlist, produce the three artifacts a
// person needs to reproduce the circuit on a real breadboard —
//   • bom    — every part with a count (what to buy),
//   • nets   — a net-grouped, human-addressed wiring list (what connects where),
//   • steps  — an ordered assembly checklist (boards → power → chips →
//              discretes → signal wires, buses first),
// plus `warnings` for the un-buildable / suspect (floating leads, one-member
// nets, un-powered chips).
//
// DOM-free and formatting-free, exactly like the sim package: this returns a
// data object; the view (components/build-guide.js) and the exporter (Feature
// 160) FORMAT it and never re-derive it. Every derivation is a pure function of
// the document + netlist, recomputed on change — nothing is stored on the doc.
//
// Labelling is the heart of it. A bare hole address (`bb1.a5`) means nothing to
// a builder, so every connection point is resolved to the friendliest label
// available, in priority order: a component pin at the hole ("74LS00 pin 3
// (1Y)"), a pin sharing the hole's 5-hole node (a bus tap lands beside a pin,
// not on it), a PSU/clock terminal ("Power supply +"), a power rail ("+ rail
// (bb1)"), and only then the bare address. Nets lead with their user NAME
// (Feature 120) when they have one.

import { partDef } from "../catalog/index.js";
import { buildOccupancy, partPinAddresses, partPinHoles } from "./occupancy.js";
import { nodeOf, parseAddress, parseHole } from "./breadboard.js";
import { BOARD_TYPES } from "./board-types.js";
import { parseBusName } from "./desk-doc.js";

/**
 * @typedef {object} BuildPlan
 * @property {{boards:BomLine[], chips:BomLine[], discretes:BomLine[],
 *   power:BomLine[]}} bom
 * @property {NetLine[]} nets  the wiring list, buses first
 * @property {Step[]} steps    the ordered assembly checklist
 * @property {Warning[]} warnings
 *
 * @typedef {{key:string, title:string, count:number}} BomLine
 * @typedef {{netId:string, name:string|null, bus:{name:string,bit:number}|null,
 *   members:Member[], wires:string[], isSingleton:boolean}} NetLine
 * @typedef {{address:string, label:string, kind:"pin"|"terminal"|"rail"|"hole",
 *   componentId?:string, ref?:string, pin?:number}} Member
 * @typedef {{id:string, group:string, text:string, detail?:string[]}} Step
 * @typedef {{kind:string, message:string, componentId?:string, ref?:string,
 *   pin?:number, netId?:string}} Warning
 */

/**
 * Derive the whole build plan for a document + its netlist.
 *
 * @param {{boards:Array, components:Array, wires:Array, buses?:Array}} document
 *   a plain desk document (DeskDoc.toJSON()).
 * @param {{netOfPoint:Map<string,string>, nets:Map<string,object>,
 *   names:Map<string,string>}} netlist  buildNetlist()'s result.
 * @returns {BuildPlan}
 */
export function buildPlan(document, netlist) {
  const doc = {
    boards: document?.boards ?? [],
    components: document?.components ?? [],
    wires: document?.wires ?? [],
    buses: document?.buses ?? [],
  };
  const ctx = makeContext(doc, netlist);
  return {
    bom: buildBom(doc),
    nets: buildWiringList(doc, netlist, ctx),
    steps: buildSteps(doc, netlist, ctx),
    warnings: buildWarnings(doc, netlist, ctx),
  };
}

// ── Shared lookup context ───────────────────────────────────────────────────

/**
 * Pre-compute the maps every derivation shares: occupancy (hole → lead),
 * a hole → seated pin lookup keyed by NODE (so a bus tap beside a pin still
 * resolves to that pin), the wire index, and the netId → bus/bit assignment.
 */
function makeContext(doc, netlist) {
  const occupancy = buildOccupancy(doc);
  const componentById = new Map(doc.components.map((c) => [c.id, c]));
  const boardById = new Map(doc.boards.map((b) => [b.id, b]));
  const wireById = new Map(doc.wires.map((w) => [w.id, w]));

  // node key ("bb1 3") → the pin seated in that node (first wins), so a hole
  // that merely SHARES a pin's column resolves to the pin.
  const pinByNode = new Map();
  for (const [address, occ] of occupancy) {
    if (occ.kind !== "pin") continue;
    const key = nodeKeyOf(boardById, address);
    if (key && !pinByNode.has(key)) {
      pinByNode.set(key, { componentId: occ.componentId, pin: occ.pin });
    }
  }

  // netId → { name, bit } for every net a bus bit lands on (Feature 130).
  const busOfNet = new Map();
  for (const bus of doc.buses) {
    const parsed = parseBusName(bus.name);
    if (!parsed) continue;
    bus.members.forEach((wireId, i) => {
      const wire = wireById.get(wireId);
      if (!wire) return;
      const netId = netlist?.netOfPoint?.get(wire.from);
      if (netId != null) {
        busOfNet.set(netId, { name: bus.name, bit: parsed.bits[i] ?? i });
      }
    });
  }

  return { occupancy, componentById, boardById, wireById, pinByNode, busOfNet };
}

/** The node key ("<boardId> <node>") of a grid/rail hole address, or null. */
function nodeKeyOf(boardById, address) {
  const parsed = parseAddress(address);
  const board = parsed && boardById.get(parsed.boardId);
  if (!board) return null;
  const node = nodeOf(board.type, parsed.hole);
  return node ? `${parsed.boardId} ${node}` : null;
}

// ── Bill of materials ───────────────────────────────────────────────────────

/**
 * Group every board and component into counted line items. Boards count by
 * STRIP type (what is actually on the desk — Feature 110 made a breadboard a
 * kit of strips); components by catalog identity, with a variant split where it
 * matters (LEDs by colour, PSUs by voltage), so "LED (red) ×4" reads right.
 */
function buildBom(doc) {
  const boards = countBy(
    doc.boards,
    (b) => b.type,
    (b) => BOARD_TYPES[b.type]?.label ?? b.type,
  );

  const chips = [];
  const discretes = [];
  const power = [];
  const groups = { chip: chips, discrete: discretes, psu: power, clock: power };
  const tally = new Map(); // key → { bucket, key, title, count }
  for (const comp of doc.components) {
    const def = partDef(comp.ref);
    if (!def) continue;
    const bucket = groups[def.kind];
    if (!bucket) continue;
    const { key, title } = bomVariant(def, comp);
    const existing = tally.get(key);
    if (existing) existing.count += 1;
    else {
      const line = { bucket, key, title, count: 1 };
      tally.set(key, line);
      bucket.push(line);
    }
  }
  const strip = (lines) =>
    lines
      .map(({ key, title, count }) => ({ key, title, count }))
      .sort((a, b) => a.title.localeCompare(b.title));
  return {
    boards,
    chips: strip(chips),
    discretes: strip(discretes),
    power: strip(power),
  };
}

/** A component's BOM key + human title, splitting on the variant that matters. */
function bomVariant(def, comp) {
  const p = comp.params ?? {};
  if (def.kind === "psu") {
    return {
      key: `${comp.ref}:${p.volts}`,
      title: `${def.title} (${p.volts} V)`,
    };
  }
  if (def.kind === "clock") {
    const rate = p.hz === "manual" ? "manual" : `${p.hz} Hz`;
    return { key: `${comp.ref}:${p.hz}`, title: `${def.title} (${rate})` };
  }
  if (def.colors && p.color) {
    return {
      key: `${comp.ref}:${p.color}`,
      title: `${def.title} (${p.color})`,
    };
  }
  return { key: comp.ref, title: def.title };
}

/** Count `items` by a key fn into sorted `{ key, title, count }` lines. */
function countBy(items, keyOf, titleOf) {
  const tally = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const line = tally.get(key);
    if (line) line.count += 1;
    else tally.set(key, { key, title: titleOf(item), count: 1 });
  }
  return [...tally.values()].sort((a, b) => a.title.localeCompare(b.title));
}

// ── Wiring list (net-centric) ───────────────────────────────────────────────

/**
 * Every INTERESTING net as a human-addressed connection list. A net is
 * interesting when the user actually connected something to it — it carries a
 * wire, or has two or more salient members (pins / terminals / rails). Bare
 * unwired chip pins each sit on their own lone net; those are NOT connections,
 * so they are left out (else a fresh 14-pin chip would spew 14 rows).
 *
 * Buses sort first (by name, then bit); named nets next; the rest by net id.
 */
function buildWiringList(doc, netlist, ctx) {
  const lines = [];
  for (const [netId, net] of netlist?.nets ?? new Map()) {
    const members = salientMembers(doc, netlist, net);
    const wired = net.counts.wires > 0;
    if (!wired && members.length < 2) continue; // not a connection
    const bus = ctx.busOfNet.get(netId) ?? null;
    // A wired net with fewer than two salient members degrades to its bare
    // hole endpoints so it is never invisible (and gets the singleton flag).
    const shown = members.length ? members : bareEndpointMembers(doc, ctx, net);
    lines.push({
      netId,
      name: netlist.names?.get(netId) ?? null,
      bus,
      members: shown,
      wires: [...net.wires],
      isSingleton: shown.length <= 1,
    });
  }
  return lines.sort(netSort);
}

/** Deterministic wiring-list order: buses first, then names, then net id. */
function netSort(a, b) {
  const ab = a.bus ? 0 : 1;
  const bb = b.bus ? 0 : 1;
  if (ab !== bb) return ab - bb;
  if (a.bus && b.bus) {
    if (a.bus.name !== b.bus.name) return a.bus.name.localeCompare(b.bus.name);
    if (a.bus.bit !== b.bus.bit) return b.bus.bit - a.bus.bit; // msb first
  }
  const an = a.name ?? "";
  const bn = b.name ?? "";
  if (an !== bn) return an && bn ? an.localeCompare(bn) : an ? -1 : 1;
  return a.netId.localeCompare(b.netId);
}

/** A net's salient members: its component pins, PSU/clock terminals, rails. */
function salientMembers(doc, netlist, net) {
  const members = [];
  for (const pin of net.pins) members.push(pinMember(pin));
  for (const address of net.terminals) {
    members.push(terminalMember(doc, address));
  }
  for (const rail of net.rails) members.push(railMember(rail));
  return members;
}

/** The bare-hole endpoints of a net's wires (dedup) — the last-resort listing. */
function bareEndpointMembers(doc, ctx, net) {
  const seen = new Set();
  const out = [];
  for (const wireId of net.wires) {
    const wire = ctx.wireById.get(wireId);
    if (!wire) continue;
    for (const address of [wire.from, wire.to]) {
      if (seen.has(address)) continue;
      seen.add(address);
      out.push({ address, label: address, kind: "hole" });
    }
  }
  return out;
}

/** A component-pin member from a net's pin record. */
function pinMember({ componentId, ref, pin, name, hole }) {
  return {
    address: hole,
    label: pinLabel(ref, pin, name),
    kind: "pin",
    componentId,
    ref,
    pin,
  };
}

/** "74LS00 pin 3 (1Y)" — the type identity + pin number + its datasheet name. */
function pinLabel(ref, pin, name) {
  const def = partDef(ref);
  const base = def?.package ? ref : (def?.title ?? ref);
  const suffix = name && name !== String(pin) ? ` (${name})` : "";
  return `${base} pin ${pin}${suffix}`;
}

/** A PSU/clock terminal member ("Power supply +"). */
function terminalMember(doc, address) {
  const parsed = parseAddress(address);
  const comp = parsed && doc.components.find((c) => c.id === parsed.boardId);
  const def = comp && partDef(comp.ref);
  const label = def ? `${def.title} ${parsed.hole}` : address;
  return { address, label, kind: "terminal", componentId: comp?.id };
}

/** A collapsed power-rail member ("+ rail (bb1)"). */
function railMember(railKey) {
  const parsed = parseAddress(railKey);
  const label = parsed ? `${parsed.hole} rail (${parsed.boardId})` : railKey;
  return { address: railKey, label, kind: "rail" };
}

// ── Local labelling (wire endpoints) ────────────────────────────────────────

/**
 * The friendliest LOCAL label for a single hole/terminal — what physically sits
 * at (or beside) it. Used for wire endpoints, where the two ends share a net
 * and so must be told apart by their own identity, not the net's.
 */
function localLabel(doc, ctx, address) {
  const occ = ctx.occupancy.get(address);
  if (occ?.kind === "pin") {
    const comp = ctx.componentById.get(occ.componentId);
    const decl = comp && partDef(comp.ref)?.pins.find((p) => p.n === occ.pin);
    return pinLabel(comp?.ref ?? "?", occ.pin, decl?.name);
  }
  const parsed = parseAddress(address);
  if (!parsed) return address;
  const board = ctx.boardById.get(parsed.boardId);
  if (!board) {
    // A desk-level brick terminal.
    return terminalMember(doc, address).label;
  }
  const hole = parseHole(board.type, parsed.hole);
  if (hole?.kind === "rail")
    return railMember(`${parsed.boardId}.${hole.railId}`).label;
  // A grid hole: name the pin sharing its node, if any, else the bare address.
  const key = nodeKeyOf(ctx.boardById, address);
  const pin = key && ctx.pinByNode.get(key);
  if (pin) {
    const comp = ctx.componentById.get(pin.componentId);
    const decl = comp && partDef(comp.ref)?.pins.find((p) => p.n === pin.pin);
    return pinLabel(comp?.ref ?? "?", pin.pin, decl?.name);
  }
  return address;
}

// ── Assembly steps ──────────────────────────────────────────────────────────

/**
 * The ordered build checklist. Dependency-lite but the way a person works:
 * boards, then power (bricks + rail wiring), then chips, then discretes, then
 * the signal wires grouped by net (buses first). Each step has a STABLE id so a
 * future interactive mode can tick it off. Ordering only — no solver.
 */
function buildSteps(doc, netlist, ctx) {
  const steps = [];
  boardSteps(doc, steps);
  powerSteps(doc, ctx, steps);
  chipSteps(doc, steps);
  discreteSteps(doc, steps);
  wireSteps(doc, netlist, ctx, steps);
  return steps;
}

/** Place the boards — a grouped kit as one step, loose strips one each. */
function boardSteps(doc, steps) {
  const emittedGroups = new Set();
  for (const board of doc.boards) {
    if (board.group != null) {
      if (emittedGroups.has(board.group)) continue;
      emittedGroups.add(board.group);
      const strips = doc.boards.filter((b) => b.group === board.group);
      const x = Math.min(...strips.map((b) => b.x));
      const y = Math.min(...strips.map((b) => b.y));
      const parts = strips.map((b) => BOARD_TYPES[b.type]?.label ?? b.type);
      steps.push({
        id: `step:boards:${board.group}`,
        group: "boards",
        text: `Assemble a breadboard (${parts.join(" + ")}) near column ${x}, row ${y}.`,
      });
    } else {
      const label = BOARD_TYPES[board.type]?.label ?? board.type;
      steps.push({
        id: `step:boards:${board.id}`,
        group: "boards",
        text: `Place a ${label} near column ${board.x}, row ${board.y}.`,
      });
    }
  }
}

/** Seat the power bricks, then run the rail-power wiring. */
function powerSteps(doc, ctx, steps) {
  for (const comp of doc.components) {
    const def = partDef(comp.ref);
    if (def?.kind === "psu") {
      steps.push({
        id: `step:power:${comp.id}`,
        group: "power",
        text: `Set up the ${def.title} to ${comp.params?.volts ?? 5} V and place it on the desk.`,
      });
    } else if (def?.kind === "clock") {
      const rate =
        comp.params?.hz === "manual" ? "manual" : `${comp.params?.hz} Hz`;
      steps.push({
        id: `step:power:${comp.id}`,
        group: "power",
        text: `Set up the ${def.title} (${rate}) and place it on the desk.`,
      });
    }
  }
  for (const wire of doc.wires) {
    if (!isPowerWire(doc, ctx, wire)) continue;
    steps.push({
      id: `step:power:${wire.id}`,
      group: "power",
      text: `Run a ${wire.color} wire: ${localLabel(doc, ctx, wire.from)} → ${localLabel(doc, ctx, wire.to)}.`,
    });
  }
}

/** A wire distributing power: an endpoint on a brick terminal or a rail hole. */
function isPowerWire(doc, ctx, wire) {
  return [wire.from, wire.to].some((address) => {
    const parsed = parseAddress(address);
    if (!parsed) return false;
    const board = ctx.boardById.get(parsed.boardId);
    if (!board) return true; // a brick terminal (psu1.+ / clk1.out)
    return parseHole(board.type, parsed.hole)?.kind === "rail";
  });
}

/** Seat the DIP chips, spelling out orientation + straddle rows. */
function chipSteps(doc, steps) {
  for (const comp of doc.components) {
    const def = partDef(comp.ref);
    if (def?.kind !== "chip") continue;
    steps.push({
      id: `step:chips:${comp.id}`,
      group: "chips",
      text: `Seat a ${comp.ref} ${seatingPhrase(doc, comp)}.`,
    });
  }
}

/** Seat the discrete parts (both DIP-package and linear-footprint ones). */
function discreteSteps(doc, steps) {
  for (const comp of doc.components) {
    const def = partDef(comp.ref);
    if (def?.kind !== "discrete") continue;
    const color =
      def.colors && comp.params?.color ? ` (${comp.params.color})` : "";
    steps.push({
      id: `step:discretes:${comp.id}`,
      group: "discretes",
      text: `Place a ${def.title}${color} ${seatingPhrase(doc, comp)}.`,
    });
  }
}

/**
 * Where a board part sits, as a phrase. A DIP straddles the trench ("straddling
 * e5–f11, pin 1 at bb1.e5"); a linear part lists its lead holes; a floating
 * lead is called out.
 */
function seatingPhrase(doc, comp) {
  const def = partDef(comp.ref);
  const board = doc.boards.find((b) => b.id === comp.board);
  const flip = comp.params?.rot === 180 ? " (flipped 180°)" : "";
  if (def?.package && board) {
    const holeList = (partPinHoles(comp.ref, comp.anchor, comp.params) ?? [])
      .map((h) => h.hole)
      .filter(Boolean)
      .map((h) => parseHole(board.type, h))
      .filter(Boolean);
    if (holeList.length) {
      const rows = [...new Set(holeList.map((h) => h.row))].sort();
      const cols = holeList.map((h) => h.col);
      const lo = Math.min(...cols);
      const hi = Math.max(...cols);
      const a = rows[0];
      const b = rows[rows.length - 1];
      return `straddling ${a}${lo}–${b}${hi}, pin 1 at ${comp.board}.${comp.anchor}${flip}`;
    }
  }
  // A linear (or rotated) part: list its resolved lead addresses.
  const pins = partPinAddresses(doc, comp) ?? [];
  const leads = pins.map((p) => p.address ?? "floating");
  return `with leads at ${leads.join(", ")}${flip}`;
}

/** Run the signal wires: whole buses first, then remaining nets. */
function wireSteps(doc, netlist, ctx, steps) {
  // Buses — one step each, a sub-item per bit.
  for (const bus of [...doc.buses].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const detail = bus.members
      .map((wireId) => ctx.wireById.get(wireId))
      .filter(Boolean)
      .map(
        (w) =>
          `${localLabel(doc, ctx, w.from)} → ${localLabel(doc, ctx, w.to)}`,
      );
    if (!detail.length) continue;
    steps.push({
      id: `step:wires:${bus.id}`,
      group: "wires",
      text: `Lay the ${bus.name} bus (${detail.length} ${detail.length === 1 ? "wire" : "wires"}).`,
      detail,
    });
  }
  // Non-bus signal nets — one step each, a sub-item per wire.
  const busWireIds = new Set(doc.buses.flatMap((b) => b.members));
  const byNet = new Map(); // netId → [wire…]
  for (const wire of doc.wires) {
    if (busWireIds.has(wire.id)) continue; // covered by a bus step
    if (isPowerWire(doc, ctx, wire)) continue; // covered by power steps
    const netId = netlist?.netOfPoint?.get(wire.from);
    if (netId == null) continue;
    if (!byNet.has(netId)) byNet.set(netId, []);
    byNet.get(netId).push(wire);
  }
  const named = (netId) => netlist.names?.get(netId) ?? null;
  const order = [...byNet.keys()].sort((a, b) => {
    const an = named(a);
    const bn = named(b);
    if (an !== bn) return an && bn ? an.localeCompare(bn) : an ? -1 : 1;
    return a.localeCompare(b);
  });
  for (const netId of order) {
    const wires = byNet.get(netId);
    const detail = wires.map(
      (w) => `${localLabel(doc, ctx, w.from)} → ${localLabel(doc, ctx, w.to)}`,
    );
    const label = named(netId) ?? "signal";
    steps.push({
      id: `step:wires:net:${netId}`,
      group: "wires",
      text: `Wire the ${label} net (${detail.length} ${detail.length === 1 ? "wire" : "wires"}).`,
      detail,
    });
  }
}

// ── Warnings ────────────────────────────────────────────────────────────────

/**
 * Surface the un-buildable / suspect: leads that float, wired nets that reach
 * only one thing (a forgotten connection), and chips with no power. The guide
 * says so up front rather than letting someone wire a dud.
 */
function buildWarnings(doc, netlist, ctx) {
  const warnings = [];
  floatingLeadWarnings(doc, warnings);
  unpoweredChipWarnings(doc, netlist, warnings);
  singleMemberNetWarnings(doc, netlist, ctx, warnings);
  return warnings;
}

/** A board part whose lead resolves to no hole is floating (Feature 110). */
function floatingLeadWarnings(doc, warnings) {
  for (const comp of doc.components) {
    const def = partDef(comp.ref);
    if (!def || (comp.kind !== "chip" && comp.kind !== "discrete")) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const base = def.package ? comp.ref : def.title;
    for (const { pin, address } of pins) {
      if (address != null) continue;
      const name = def.pins.find((p) => p.n === pin)?.name;
      const suffix = name && name !== String(pin) ? ` (${name})` : "";
      warnings.push({
        kind: "floating-lead",
        componentId: comp.id,
        ref: comp.ref,
        pin,
        message: `${base} (${comp.id}) pin ${pin}${suffix} is floating — its lead is over no hole.`,
      });
    }
  }
}

/** A chip whose VCC or GND pin connects to nothing will not power up. */
function unpoweredChipWarnings(doc, netlist, warnings) {
  for (const comp of doc.components) {
    const def = partDef(comp.ref);
    if (def?.kind !== "chip") continue;
    const powerPins = def.pins.filter(
      (p) => p.role === "vcc" || p.role === "gnd",
    );
    if (!powerPins.length) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const addressOf = new Map(pins.map((p) => [p.pin, p.address]));
    const unconnected = [];
    for (const p of powerPins) {
      const address = addressOf.get(p.n);
      if (address == null || !isConnected(netlist, address)) {
        unconnected.push(p.name);
      }
    }
    if (unconnected.length) {
      warnings.push({
        kind: "unpowered-chip",
        componentId: comp.id,
        ref: comp.ref,
        message: `${comp.ref} (${comp.id}) has no ${unconnected.join(" / ")} connection — it will not power up.`,
      });
    }
  }
}

/** Does a pin's net reach anything beyond the pin itself (a wire / terminal / a
    second pin)? */
function isConnected(netlist, address) {
  const netId = netlist?.netOfPoint?.get(address);
  const net = netId != null ? netlist.nets.get(netId) : null;
  if (!net) return false;
  return (
    net.counts.wires > 0 || net.counts.terminals > 0 || net.counts.pins > 1
  );
}

/** A wired net that reaches only one thing is a likely-forgotten connection. */
function singleMemberNetWarnings(doc, netlist, ctx, warnings) {
  for (const line of buildWiringList(doc, netlist, ctx)) {
    if (!line.isSingleton) continue;
    const who = line.name ?? line.members[0]?.label ?? line.netId;
    warnings.push({
      kind: "single-member-net",
      netId: line.netId,
      message: `Net "${who}" connects to only one point — a likely-forgotten connection.`,
    });
  }
}
