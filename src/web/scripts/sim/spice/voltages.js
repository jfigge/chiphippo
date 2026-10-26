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

// spice/voltages.js — every net's VOLTAGE, every pass, and what each input
// reads from it (features/done/spice-lite-audit.md, phase B). Pure and DOM-free.
//
// The digital engine settles a desk by strength: a supply beats an output, an
// output beats a pull, and a net's level is whichever wins. Spice Lite asks
// what a voltmeter would: every pass, after the digital engine has resolved
// the levels, each net the pass touched is SOLVED — Kirchhoff's current law
// round the little network it sits in (spice/network.js) — and every input
// on it reads that voltage through its own thresholds:
//
//   FIXED  a supply rail at what it delivers; a clock brick or a signal flag
//          driving H or L (an ideal bench source, spice/lamps.js
//          `sourceVolts`); an RC node at its curve's voltage (spice/engine.js
//          owns the curve — the capacitor is a source for the pass).
//   DRIVERS  each chip output driving H or L, as the stage it is (spice/
//          output-stage.js: a 74LS output its swept gate's curve, a CD4000
//          output a MOSFET that saturates) — for a chip NOT across the rails
//          (fed through a resistor, its ground on a diode), a stage measured
//          from its own supply pins, its current through them (spice/
//          network.js "s") — and each powered input's own:
//          a 74LS input's bias (it pushes current OUT of a pin held low,
//          which is why a 74LS input pulled down through 10 kΩ sits in its
//          undefined band), a CD4000 input's protection diodes (they carry
//          current only once the pin is held past a rail) — spice/params.js
//          `inputStages`.
//   BRANCHES  every resistive element (a resistor, a pot's side, an rnet9's
//          element — a speaker's coil, open once burnt); every LED,
//          segment, diode and Zener (a burnt one is open); an analog
//          switch channel switched on (its on-resistance, its control read
//          off its own voltage); and every transistor — a
//          discrete BJT or MOSFET, a CD4007UB's six — as the DEVICE it is
//          (spice/network.js: a BJT's gain and saturation, a MOSFET's
//          threshold against its source and its gate's charge).
//
// The nets are grouped once per netlist into CLUSTERS — the nets those
// branches could ever join, rails never a join point (a rail is fixed). A
// pass re-solves only the clusters something moved in: a driver changed
// level, a channel switched, a source or an RC node moved, or the chips'
// power changed (every cluster). A cluster of one net with nothing but
// drivers on it — the commonest there is, an output and the inputs it feeds —
// is one scalar Newton.
//
// READINGS. A net is AUTHORITATIVE when something holds it: a fixed net, an
// output driving, or a resistive path (resistors, channels — never a
// junction, which may be off) to one. Every input on an authoritative net
// reads its voltage: HIGH at or above its VIH, LOW at or below its VIL, and
// UNKNOWN in between — or, for a Schmitt input, the reading it had until the
// voltage leaves its hysteresis (spice/params.js `inputThresholds`). A net
// nothing holds is left to the digital engine's level and the family's own
// reader (a floating 74LS input reads HIGH, a CMOS one unknown). Where the
// digital engine can only say X — two outputs fighting, two pulls dividing —
// the voltage says what the readers see: a 74LS LOW beats a 74LS HIGH at
// about 0.75 V, so the inputs on it read LOW (the `conflict` is still said).
// The level a net is SHOWN at is its readers' agreement (X when they
// differ), or the digital engine's where nothing reads it — so on a desk
// whose voltages say what its levels say, Spice Lite shows and does exactly
// what the digital engine does (tests/engine-parity.test.js).

import { H, L, X, Z } from "../levels.js";
import { CHIP_STATUS } from "../chip-status.js";
import { channelStates, initialState } from "../chip-eval.js";
import { UnionFind } from "../union-find.js";
import { ASSERT_ANALYSIS } from "../assert-modes.js";
import { lampTopology, sourceVolts } from "./lamps.js";
import {
  currentInto,
  deviceConducts,
  deviceCurrents,
  gaussSolve,
  isDevice,
  junctionCurrent,
  networkSlopes,
  newtonSolve,
  pieces,
  piecesBy,
  pieceConstraints,
  branchMargin,
  branchPiece,
  pieceList,
  hasPieces,
  touchingOf,
  GMIN_S,
  TOLERANCE_A,
} from "./network.js";
import { supplyTopology } from "./supply.js";
import {
  channelOhms,
  outputStage,
  stageCurrent,
  stageKinks,
  stageSlope,
  SPLITTER_SAT_V,
  splitterAmps,
  splitterUnits,
} from "./output-stage.js";
import {
  CMOS_BAND_MA,
  CMOS_CLAMP,
  KICK_LIMITS,
  SWITCH_LIMITS,
  TRANSISTOR_LIMITS,
  TTL_INPUT_MAX_V,
  TTL_CLAMP,
  inputThresholds,
  pinInputStages,
  pinOutputLimits,
  stageStrength,
  supplyMaOf,
  limitsAt,
} from "./params.js";
import { familyOf } from "../../catalog/families.js";
import {
  transistorCase,
  transistorCustom,
  transistorGrade,
} from "../../catalog/discretes.js";
import { ARRAY_MODELS, BREAKDOWN_OHMS, CONDUCTS_A } from "./transistors.js";
import {
  AC_REFERENCE_OHMS,
  ANALOG_KINDS,
  analogEnds,
  analogHeldThrough,
  analogHoles,
  heldOutright,
  supplyAmps,
  loadAmps,
  meterAmps,
  loadRegulates,
  optoAmps,
  OPTO_LIMITS,
  regulatorAmps,
} from "./analog-devices.js";
import { DIODE_SPEC } from "./diodes.js";
import { transistorModelFor } from "./transistor-figures.js";
import { formatAddress } from "../../model/breadboard.js";
import { internalNet } from "./silicon.js";
import { inductorTopology, transformerResistors } from "./inductors.js";
import { acSupplies } from "./ac-supplies.js";
import { benchDevices } from "./bench-parts.js";

/** Pin roles that READ a net. */
const READS = new Set(["input", "io"]);

/** Pin roles that DRIVE one. */
const DRIVES = new Set(["output", "io"]);

/** Each context's plan (`makePlan`, not at set volts), by the setting. */
const PLANS = new WeakMap();

/** Each netlist's clusters (`voltageTopology`), by the supplies on their
    limit (`freeSupplies`). */
const TOPOLOGY = new WeakMap();

/** No supply on its limit. */
const NO_FREE = new Set();

/**
 * The supplies of `free` (PSU ids) whose + the solve can hold itself: one
 * whose + and − are both wired, no other supply's + on the same net (another
 * holding it, it is still a rail), and nothing on its + that the logic
 * engine powers off the rail — a chip's VCC, a clock brick's: their power is
 * read off the rail's voltage (spice/supply.js `droopVolts` keeps those, and
 * the chips' "as they last drove" load that holds a droop steady). So it is
 * a supply feeding regulators and analog parts — the one a droop booked at
 * the set voltage cannot place (a regulator draws its whole limit there for
 * any output short of its own). Each `{id, plus, minus, set, limit}`
 * (spice/supply.js `supplyTopology`'s).
 */
export function freeSupplies(doc, netlist, free) {
  if (!free?.size) return [];
  const { psus, feeds } = supplyTopology(doc, netlist);
  const netOf = (address) => (address ? (netlist.netOfPoint.get(address) ?? null) : null); // prettier-ignore
  const powered = new Set();
  for (const { vccAt } of feeds.values()) powered.add(netOf(vccAt));
  for (const c of doc.components ?? []) {
    if (c.kind === "clock") powered.add(netOf(formatAddress(c.id, "vcc")));
  }
  return psus.filter(
    (p) =>
      free.has(p.id) &&
      p.plus &&
      p.minus &&
      p.plus !== p.minus &&
      !powered.has(p.plus) &&
      psus.every((q) => q === p || (q.plus !== p.plus && q.minus !== p.plus)),
  );
}

/** Where a gate's users name the rails' own report (`railFlows`) rather
    than a cluster: a MOSFET with both channel ends on rails. */
const RAIL = -1;

/** A current under this is not booked to a supply, amps: the leakage
    stand-ins' own nanoamps are not a draw on anything. */
const BOOK_FLOOR_A = 1e-7;

/**
 * The parts of a desk the voltage solve needs and a run cannot change: every
 * net's cluster, every cluster's branches, and every net's readers, drivers
 * and bench sources — with the HOLE each lead is in, which the current report
 * is keyed by. Computed once per netlist, from the first context built on it
 * — and once more for each set of supplies on their LIMIT (`free`, PSU ids):
 * the + of one is no rail but a net of the solve, held by its "p" device
 * (spice/analog-devices.js), so everything on it is one network with it.
 * @param {object} doc
 * @param {{netOfPoint: Map}} netlist
 * @param {object} ctx - sim/engine.js's context
 * @param {Set<string>} [free]
 */
export function voltageTopology(doc, netlist, ctx, free = NO_FREE) {
  const freed = freeSupplies(doc, netlist, free);
  const freeKey = freed.map((p) => p.id).join(",");
  let byFree = TOPOLOGY.get(netlist);
  if (!byFree) TOPOLOGY.set(netlist, (byFree = new Map()));
  const cached = byFree.get(freeKey);
  if (cached) return cached;
  const lamp = lampTopology(doc, netlist);
  const sup = supplyTopology(doc, netlist);
  const freeNets = new Set(freed.map((p) => p.plus));
  const rails = new Set([...ctx.supplyPlusVolts.keys(), ...ctx.supplyMinus].filter((net) => !freeNets.has(net))); // prettier-ignore
  const uf = new UnionFind();
  const join = (a, b) => {
    if (!a || !b || a === b || rails.has(a) || rails.has(b)) return;
    uf.union(a, b);
  };
  for (const r of lamp.resistors) join(r.a, r.b);
  for (const j of lamp.junctions) join(j.anode, j.cathode);
  // An inductor is a branch of its network (spice/inductors.js) — on Spice
  // Lite's netlist, where its two leads are two nets.
  const coils = inductorTopology(doc, netlist);
  for (const l of coils) join(l.a, l.b);
  // An analog switch's channels are switched resistances; a transistor —
  // a discrete one, or one of a CD4007UB's six MOSFETs — is a DEVICE: a
  // bipolar one between its base, collector and emitter (all one cluster:
  // its base current flows), a MOSFET between its channel's ends, its gate
  // a voltage it is told from wherever that net is solved.
  const channels = []; // {key, comp, i, a, b, aAt, bAt}
  const devices = []; // {key, comp, kind, …nets, …At}
  for (const c of ctx.chips) {
    if (!c.analogSwitch) continue;
    const at = sup.terminals.get(c.comp.id);
    const net = (pin) => c.pinNet.get(pin) ?? null;
    const where = (pin) => at?.get(pin) ?? null;
    const type = c.def.transistor?.type;
    // An optocoupler is its LED and phototransistor (`benchDevices`, below).
    if (c.def.optocoupler) continue;
    if (c.def.bipolarArray) {
      // An array of NPNs on one die (a ULN2003A): each channel its own
      // transistor of the array's model (spice/transistors.js ARRAY_MODELS),
      // its base the internal net behind its input's resistor (`internals`),
      // booked as the chip's output it is (`deviceFlow`).
      const model = ARRAY_MODELS[c.def.bipolarArray];
      c.def.logic.channels.forEach((ch, i) => {
        const cc = net(ch.a);
        const e = net(ch.b);
        const b = internalNet(c.comp.id, ch.base);
        if (!cc || !e || cc === e) return;
        devices.push({ key: `${c.comp.id}#${i}`, comp: c.comp.id, kind: "q", pnp: false, b, c: cc, e, bAt: null, cAt: where(ch.a), eAt: where(ch.b), model, outPin: ch.a }); // prettier-ignore
        join(b, cc);
        join(b, e);
        join(cc, e);
      });
      continue;
    }
    if (type === "npn" || type === "pnp") {
      const [e, b, cc] = [net(1), net(2), net(3)];
      if (b && cc && e) {
        // Its grade's figures (spice/transistors.js), or its custom ones
        // (spice/transistor-figures.js).
        const model = transistorModelFor(type, transistorGrade(c.def, c.comp.params), transistorCustom(c.def, c.comp.params)); // prettier-ignore
        devices.push({ key: c.comp.id, comp: c.comp.id, kind: "q", pnp: type === "pnp", b, c: cc, e, bAt: where(2), cAt: where(3), eAt: where(1), model }); // prettier-ignore
        // Every pair, not just through the base: a base on a rail (an
        // emitter follower off +5 V) joins nothing, and its collector and
        // emitter are still one network.
        join(b, cc);
        join(b, e);
        join(cc, e);
      }
      continue;
    }
    if (type === "nmos" || type === "pmos" || c.def.transistorArray) {
      c.def.logic.channels.forEach((ch, i) => {
        const a = net(ch.a);
        const b = net(ch.b);
        const g = net(ch.inputs[0]);
        if (!a || !b || a === b) return;
        // A P-channel part conducts with its gate LOW.
        const p = type ? type === "pmos" : ch.on([L]) === H;
        // A discrete MOSFET is its own part (its key, its lamp); a CD4007UB's
        // six are its channels.
        const key = type ? c.comp.id : `${c.comp.id}#${i}`;
        // A discrete one is its grade's part (spice/transistors.js); a
        // CD4007UB's are its family's output transistors (`deviceBranch`).
        const model = type ? transistorModelFor(type, transistorGrade(c.def, c.comp.params), transistorCustom(c.def, c.comp.params)) : null; // prettier-ignore
        devices.push({ key, comp: c.comp.id, kind: "m", p, a, b, g, aAt: where(ch.a), bAt: where(ch.b), aPin: ch.a, bPin: ch.b, array: !type, model }); // prettier-ignore
        join(a, b);
      });
      continue;
    }
    c.def.logic.channels.forEach((ch, i) => {
      const a = net(ch.a);
      const b = net(ch.b);
      if (!a || !b || a === b) return;
      channels.push({ key: `${c.comp.id}#${i}`, comp: c.comp.id, i, a, b, aAt: where(ch.a), bAt: where(ch.b) }); // prettier-ignore
      join(a, b);
    });
  }

  // A 74LS gate whose inputs reach its phase splitter straight (spice/
  // output-stage.js `splitterUnits`): each unit's splitter, part-way on
  // while its output is HIGH, a DEVICE from the output to GND that reads its
  // inputs as a MOSFET reads its gate — so nothing joins them: they carry
  // none of its current.
  for (const c of ctx.chips) {
    if (c.passive) continue;
    const units = splitterUnits(c.def);
    if (!units.length) continue;
    const gndPin = c.def.pins.find((p) => p.role === "gnd")?.n;
    const gnd = c.pinNet.get(gndPin) ?? null;
    if (!gnd) continue;
    const at = sup.terminals.get(c.comp.id);
    units.forEach((u, i) => {
      const out = c.pinNet.get(u.output) ?? null;
      const ins = u.inputs.map((n) => c.pinNet.get(n) ?? null).filter(Boolean);
      if (!out || out === gnd || !ins.length) return;
      devices.push({ key: `${c.comp.id}#t${i}`, comp: c.comp.id, kind: "t", out, gnd, ins, outPin: u.output, outAt: at?.get(u.output) ?? null, gndAt: at?.get(gndPin) ?? null }); // prettier-ignore
    });
  }

  // The bench parts (spice/bench-parts.js): an optocoupler's LED and
  // phototransistor, an op-amp's units, a regulator, an electronic load, an
  // isolated AC supply (its sine's net inside it, `sourceNets`) —
  // each DEVICE one network with every net it reads.
  const sourceNets = []; // an isolated AC supply's sine, inside it
  // A supply on its limit: its + held by the solve (spice/analog-devices.js
  // "p"), one network with all it feeds.
  for (const p of freed) {
    devices.push({ key: p.id, comp: p.id, kind: "p", chip: false, nodes: ["pos", "neg"], pos: p.plus, neg: p.minus, posAt: formatAddress(p.id, "+"), negAt: formatAddress(p.id, "-"), set: p.set, limit: p.limit }); // prettier-ignore
    join(p.plus, p.minus);
  }
  for (const dev of benchDevices(doc, netlist)) {
    // (An isolated supply's own copy: its `earth` is settled below.)
    devices.push(dev.kind === "v" ? { ...dev } : dev);
    if (dev.kind === "v") sourceNets.push(dev.w);
    const ends = analogEnds(dev);
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) join(ends[i], ends[j]);
    }
  }

  // A chip NOT straight across the rails draws its supply current through
  // whatever feeds it — a LOAD between its supply pins' nets, solved like any
  // branch (its value is its family's ICC, spice/params.js; `makePlan`).
  const plus = new Set([...ctx.supplyPlusVolts.keys()].filter((net) => !freeNets.has(net))); // prettier-ignore
  const loads = []; // {comp, a, b, aAt, bAt}
  const offRail = new Map(); // comp → {vccNet, gndNet}: its stages are "s" branches
  for (const c of ctx.chips) {
    if (c.passive) continue;
    const vccPin = c.def.pins.find((p) => p.role === "vcc")?.n;
    const gndPins = c.def.pins.filter((p) => p.role === "gnd").map((p) => p.n);
    const a = c.pinNet.get(vccPin) ?? null;
    const b = gndPins.length ? (c.pinNet.get(gndPins[0]) ?? null) : null;
    const railFed = plus.has(a) && gndPins.every((n) => ctx.supplyMinus.has(c.pinNet.get(n))); // prettier-ignore
    if (railFed || !a || !b || a === b) continue;
    const feed = sup.feeds.get(c.comp.id);
    loads.push({ comp: c.comp.id, a, b, aAt: feed?.vccAt ?? null, bAt: feed?.gndAt ?? null }); // prettier-ignore
    join(a, b);
    // …and its outputs and inputs are stages measured from those pins, with
    // their current through them (spice/network.js "s"): one network with
    // its supply. A chip across two RAILS that are not a supply's + and −
    // (VCC on a 12 V rail, GND on a 5 V one) has both ends fixed, so there is
    // no network to join: each of its pins' own networks carries its stages
    // (`split`), measured from those two rails all the same.
    const split = rails.has(a) && rails.has(b);
    offRail.set(c.comp.id, { vccNet: a, gndNet: b, split, home: null });
    if (split) continue;
    for (const p of c.def.pins) {
      if (p.role === "vcc" || p.role === "gnd") continue;
      const net = c.pinNet.get(p.n);
      join(net, rails.has(a) ? b : a);
    }
  }

  // A timing part's own parts, inside its package (spice/silicon.js
  // `internals`): nets no wire reaches — a 555's divider tap — and the
  // resistors between them and its pins, solved like any resistor.
  const innerNets = [];
  const inner = []; // {a, b, ohms, aAt, bAt}
  const innerJunctions = []; // as lamp junctions
  for (const c of ctx.chips) {
    const parts = c.def.logic?.internals;
    if (!parts) continue;
    for (const name of parts.nets ?? []) innerNets.push(internalNet(c.comp.id, name)); // prettier-ignore
    const at = lamp.outputsAt.get(c.comp.id);
    const end = (x) =>
      typeof x === "number"
        ? { net: c.pinNet.get(x) ?? null, at: at?.get(x) ?? null }
        : { net: internalNet(c.comp.id, x), at: null };
    for (const r of parts.resistors ?? []) {
      const a = end(r.a);
      const b = end(r.b);
      if (!a.net || !b.net || a.net === b.net) continue;
      inner.push({ a: a.net, b: b.net, ohms: r.ohms, aAt: a.at, bAt: b.at });
      join(a.net, b.net);
    }
    // …and its diodes (a ULN2003A's clamps): the common junction
    // (spice/diodes.js), solved like any diode, never judged for burning —
    // and only where both ends reach something: a clamp to a COM left open
    // clamps nothing, and a net nothing else holds is no place to solve one.
    const wired = (net) => {
      const info = typeof net === "string" ? netlist.nets?.get(net) : null;
      return !info || info.counts.pins > 1 || info.counts.wires > 0 || info.counts.terminals > 0 || info.rails.length > 0; // prettier-ignore
    };
    (parts.junctions ?? []).forEach((d, i) => {
      const a = end(d.anode);
      const k = end(d.cathode);
      if (!wired(a.net) || !wired(k.net)) return;
      innerJunctions.push({ key: `${c.comp.id}#d${i}`, comp: c.comp.id, seg: null, diode: true, spec: DIODE_SPEC, anode: a.net, cathode: k.net, anodeAt: a.at, cathodeAt: k.at }); // prettier-ignore
      join(a.net, k.net);
    });
  }
  // A transformer's shunts and the insulation between its windings
  // (spice/inductors.js), solved like any resistor: what keeps an open
  // winding's current, and a floating secondary's voltage, defined.
  for (const r of transformerResistors(doc, netlist)) {
    inner.push(r);
    join(r.a, r.b);
  }

  // A MOSFET whose gate is on a network that MOVES between events — a
  // capacitor's, an inductor's, a clock brick's or an AC source's — is one
  // network with it, as an op-amp is with its inputs: told its gate only at
  // a settle, a gate charging through a resistor turned nothing on until
  // something else woke the desk, and a wave on it ran its channel as a
  // square (the grade, 2026-10-23). Joined, the gate is a net of the group
  // the moving network runs as (spice/engine.js `runGroup`), its channel's
  // pieces that group's corners and its drain read by crossings. A gate
  // whose net only ever steps (a chip's output) stays a voltage it is told.
  // To closure: a drain that now moves moves the gates it drives.
  const moving = [
    ...ctx.netIds.filter((net) => ctx.trace?.hasCapacitor(net)),
    ...coils.flatMap((l) => [l.a, l.b]),
    ...(doc.components ?? []).filter((c) => c.kind === "clock").map((c) => netlist.netOfPoint.get(formatAddress(c.id, "out"))), // prettier-ignore
    ...acSupplies(doc, netlist).flatMap((ac) => [ac.line, ac.source]),
    ...sourceNets,
  ].filter((net) => net && !rails.has(net));
  for (let grew = true; grew;) {
    grew = false;
    const roots = new Set(moving.map((net) => uf.find(net)));
    for (const dev of devices) {
      if (dev.kind !== "m" || !dev.g || rails.has(dev.g)) continue;
      const end = rails.has(dev.a) ? dev.b : dev.a;
      if (rails.has(end) || !roots.has(uf.find(dev.g))) continue;
      if (uf.find(dev.g) === uf.find(end)) continue;
      join(dev.g, end);
      grew = true;
    }
  }

  const clusters = [];
  const clusterOf = new Map(); // net → cluster index
  const byRoot = new Map();
  for (const net of [...ctx.netIds, ...innerNets, ...sourceNets]) {
    if (rails.has(net)) continue;
    const root = uf.find(net);
    let k = byRoot.get(root);
    if (k == null) {
      k = clusters.length;
      byRoot.set(root, k);
      clusters.push({ nets: [], resistors: [], junctions: [], channels: [], devices: [], loads: [], offChips: [], inductors: [], rails: new Set() }); // prettier-ignore
    }
    clusters[k].nets.push(net);
    clusterOf.set(net, k);
  }
  const home = (a, b) => clusterOf.get(a) ?? clusterOf.get(b);
  const touchRails = (cl, ...nets) => {
    for (const net of nets) if (rails.has(net)) cl.rails.add(net);
  };
  // A branch with both ends on rails has nothing to solve, but it carries
  // current all the same: a resistor or an LED straight across a supply.
  const railBranches = []; // {kind, a, b, ohms|spec, aAt, bAt, key?}
  for (const r of [...lamp.resistors, ...inner]) {
    const k = home(r.a, r.b);
    if (k == null) {
      railBranches.push({ kind: "r", a: r.a, b: r.b, ohms: r.ohms, aAt: r.aAt, bAt: r.bAt, key: r.key }); // prettier-ignore
      continue;
    }
    clusters[k].resistors.push(r);
    touchRails(clusters[k], r.a, r.b);
  }
  for (const j of [...lamp.junctions, ...innerJunctions]) {
    if (!j.anode || !j.cathode || j.anode === j.cathode) continue;
    const k = home(j.anode, j.cathode);
    if (k == null) {
      railBranches.push({ kind: "j", a: j.anode, b: j.cathode, spec: j.spec, diode: j.diode, aAt: j.anodeAt, bAt: j.cathodeAt, key: j.key }); // prettier-ignore
      continue;
    }
    clusters[k].junctions.push(j);
    touchRails(clusters[k], j.anode, j.cathode);
  }
  // An inductor straight across two rails has no network: its voltage is
  // theirs (`railCoils`).
  const railCoils = [];
  for (const l of coils) {
    const k = home(l.a, l.b);
    if (k == null) {
      railCoils.push(l);
      continue;
    }
    clusters[k].inductors.push(l);
    touchRails(clusters[k], l.a, l.b);
  }
  for (const ch of channels) {
    const k = home(ch.a, ch.b);
    if (k == null) {
      // Switched on, straight across two rails: a short through its
      // on-resistance (`railFlows`).
      railBranches.push({ kind: "ch", ch, a: ch.a, b: ch.b, aAt: ch.aAt, bAt: ch.bAt }); // prettier-ignore
      continue;
    }
    clusters[k].channels.push(ch);
    touchRails(clusters[k], ch.a, ch.b);
  }
  for (const load of loads) {
    const k = home(load.a, load.b);
    if (k == null) {
      // A chip across two rails: its supply current flows between them.
      railBranches.push({ kind: "load", comp: load.comp, a: load.a, b: load.b, aAt: load.aAt, bAt: load.bAt }); // prettier-ignore
      continue;
    }
    clusters[k].loads.push(load);
    touchRails(clusters[k], load.a, load.b);
  }
  for (const [comp, own] of offRail) {
    const c = ctx.chips.find((x) => x.comp.id === comp);
    if (!own.split) {
      const k = home(own.vccNet, own.gndNet);
      if (k == null) continue;
      own.home = k;
      clusters[k].offChips.push(comp);
      touchRails(clusters[k], ...c.pinNet.values());
      continue;
    }
    // Every network one of its pins is in; a pin on a rail is its first's
    // (`home`) to carry.
    for (const p of c.def.pins) {
      const k = clusterOf.get(c.pinNet.get(p.n));
      if (k == null || clusters[k].offChips.includes(comp)) continue;
      own.home ??= k;
      clusters[k].offChips.push(comp);
      touchRails(clusters[k], own.vccNet, own.gndNet);
    }
    if (own.home != null) touchRails(clusters[own.home], ...c.pinNet.values());
  }
  // A MOSFET's cluster depends on its gate's voltage, solved elsewhere: a
  // gate that moves re-solves it. And a gate is a capacitance — left
  // floating it keeps its voltage (`gates`). A 74LS splitter's inputs are
  // read the same way (`gateUsers`), but are no capacitance: a TTL input
  // left floating keeps nothing.
  const gateUsers = new Map(); // gate net → the clusters its MOSFETs are in
  const gates = new Set();
  const railDevices = []; // every terminal on a rail: `railFlows` books them
  for (const dev of devices) {
    const ends = dev.kind === "q" ? [dev.b, dev.c, dev.e] : dev.kind === "t" ? [dev.out, dev.gnd] : ANALOG_KINDS.has(dev.kind) ? analogEnds(dev) : [dev.a, dev.b]; // prettier-ignore
    const k = ends.map((n) => clusterOf.get(n)).find((x) => x != null);
    if (k == null) railDevices.push(dev);
    else {
      clusters[k].devices.push(dev);
      touchRails(clusters[k], ...ends);
    }
    const read = dev.kind === "m" && dev.g ? [dev.g] : dev.kind === "t" ? dev.ins : []; // prettier-ignore
    if (dev.kind === "m" && dev.g) gates.add(dev.g);
    for (const g of read) {
      if (!gateUsers.has(g)) gateUsers.set(g, new Set());
      // A rail device's gate re-reports the rails (`RAIL`).
      gateUsers.get(g).add(k ?? RAIL);
    }
  }

  // An isolated AC supply's circuit reaches earth only through its
  // insulation. Where nothing else grounds that circuit (no rail touches its
  // network) it is READ against a reference instead (spice/analog-devices.js
  // "v" `earth`, `AC_REFERENCE_OHMS`) where a meter's black lead would go —
  // a − rail strip on it (the first, in net order), else its N. On N, a
  // bridge rectifier's DC side would swing a whole peak against it every
  // half-cycle; and held by a gigohm alone, every voltage on it was noise.
  for (const cl of clusters) {
    if (cl.rails.size) continue;
    for (const dev of cl.devices) {
      if (dev.kind !== "v") continue;
      const minus = cl.nets.find((net) => netlist.nets?.get(net)?.rails?.some((r) => r.endsWith("-"))); // prettier-ignore
      dev.earth = minus ?? dev.n;
      dev.earthOhms = AC_REFERENCE_OHMS;
    }
  }

  // The order clusters are solved in: a MOSFET's gate's own cluster before
  // the clusters its channel is in, so a pass solves each of those once,
  // with its gate where this pass leaves it — and the same in every mode
  // (a network solved from a stale gate and again lands a few bits off one
  // solved once, which is all the carried solve and the full one differ by).
  // A ring of gates is broken by index.
  const after = new Map(); // cluster → the clusters its gates drive
  const waiting = new Array(clusters.length).fill(0);
  for (const [gate, users] of gateUsers) {
    const from = clusterOf.get(gate);
    if (from == null) continue;
    for (const k of users) {
      if (k === RAIL || k === from) continue;
      if (!after.has(from)) after.set(from, new Set());
      if (after.get(from).has(k)) continue;
      after.get(from).add(k);
      waiting[k]++;
    }
  }
  const order = [];
  const placed = new Array(clusters.length).fill(false);
  while (order.length < clusters.length) {
    let progressed = false;
    for (let k = 0; k < clusters.length; k++) {
      if (placed[k] || waiting[k] > 0) continue;
      placed[k] = true;
      progressed = true;
      order.push(k);
      for (const next of after.get(k) ?? []) waiting[next]--;
    }
    if (progressed) continue;
    // A ring: take its lowest index and carry on.
    const k = placed.indexOf(false);
    placed[k] = true;
    order.push(k);
    for (const next of after.get(k) ?? []) waiting[next]--;
  }
  const rank = new Array(clusters.length);
  order.forEach((k, i) => (rank[k] = i));

  // Who reads and who drives each net. A transistor's base or gate is not a
  // logic input (it is part of the device), and an analog switch's channel
  // terminals carry a level across rather than reading it. A timing part's
  // silicon reads the pins its comparators sense and drives the ones it
  // names (`sense`, `drives`), whatever their roles; a comparator whose trip
  // point is another net's voltage is read again when that net moves
  // (`senseRefs`).
  const readers = new Map(); // net → [{comp, pin, at}]
  const drivers = new Map(); // net → [{comp, pin, at}]
  const senseRefs = new Map(); // a comparator's reference net → its own nets
  const push = (map, net, entry) => {
    let list = map.get(net);
    if (!list) map.set(net, (list = []));
    list.push(entry);
  };
  for (const c of ctx.chips) {
    if (c.passive) continue;
    const at = lamp.outputsAt.get(c.comp.id);
    const sense = c.def.logic?.sense ?? null;
    const drives = c.def.logic?.drives ?? null;
    // An op-amp's outputs are its units' devices (`benchDevices`), never a
    // logic stage.
    const analogOuts = new Set(c.def.opAmps?.units.map((u) => u.out) ?? []);
    for (const p of c.def.pins) {
      const net = c.pinNet.get(p.n);
      if (!net) continue;
      if (
        (READS.has(p.role) && !(c.analogSwitch && p.role === "io")) ||
        sense?.[p.n]
      ) {
        // prettier-ignore
        push(readers, net, { comp: c.comp.id, pin: p.n, at: at?.get(p.n) ?? null });
      }
      if (
        ((DRIVES.has(p.role) && !c.analogSwitch) || drives?.includes(p.n)) &&
        !analogOuts.has(p.n)
      ) {
        // prettier-ignore
        push(drivers, net, { comp: c.comp.id, pin: p.n, at: at?.get(p.n) ?? null }); // prettier-ignore
      }
      const ref = sense?.[p.n]?.ref;
      if (ref != null) {
        const refNet = typeof ref === "number" ? (c.pinNet.get(ref) ?? null) : internalNet(c.comp.id, ref); // prettier-ignore
        if (refNet) {
          if (!senseRefs.has(refNet)) senseRefs.set(refNet, new Set());
          senseRefs.get(refNet).add(net);
        }
      }
    }
  }
  // Every bench source on each net — two flags on one net, a clock and a
  // flag: the net is held only while they agree (`fixedOf`), and a change
  // to any of them moves it.
  const sources = new Map(); // net → [{kind, id}]
  for (const clk of ctx.clocks) {
    if (clk.outNet) push(sources, clk.outNet, { kind: "clock", id: clk.id });
  }
  for (const sig of ctx.signals) {
    if (sig.net) push(sources, sig.net, { kind: "signal", id: sig.id });
  }
  // An off-rail chip's own pins, for its "s" stages (`network`).
  for (const [map, key] of [
    [drivers, "drivers"],
    [readers, "readers"],
  ]) {
    for (const [net, list] of map) {
      for (const x of list) {
        const own = offRail.get(x.comp);
        if (own) (own[key] ??= []).push({ ...x, net });
      }
    }
  }
  // A clock brick's current comes out of the supply on its `vcc` terminal
  // (and returns through its `gnd`), as an instrument's does.
  const clockPsu = new Map(); // out net → {psu, plusAt, minusAt}
  for (const clk of ctx.clocks) {
    if (!clk.outNet || clockPsu.has(clk.outNet)) continue;
    const plusAt = formatAddress(clk.id, "vcc");
    const psu = sup.psuOfNet.get(netlist.netOfPoint.get(plusAt) ?? null);
    if (psu) clockPsu.set(clk.outNet, { psu, plusAt, minusAt: formatAddress(clk.id, "gnd") }); // prettier-ignore
  }

  // The outputs and inputs on a rail itself (an output wired to ground, an
  // input tied high): nothing to solve, but current flows and stress shows.
  const railDrivers = [];
  const railReaders = [];
  for (const net of rails) {
    for (const d of drivers.get(net) ?? []) if (!offRail.has(d.comp)) railDrivers.push({ d, net }); // prettier-ignore
    for (const r of readers.get(net) ?? []) if (!offRail.has(r.comp)) railReaders.push({ r, net }); // prettier-ignore
  }

  // Where a transistor sits, the digital engine's own switch moves levels
  // that nothing the solve watches moves — so those nets' shown levels are
  // checked against it every pass.
  const watch = [];
  for (const cl of clusters) {
    if (!cl.devices.length) continue;
    for (const net of cl.nets) if (readers.has(net)) watch.push(net);
  }

  // Every discrete transistor's control is read off the solve
  // (`selfControl`) — whether the device conducts there — never at its
  // net's digital level. Read that way a transistor that feeds its own base
  // (diode-connected, a mirror's reference, the second of a Darlington of
  // two) switched itself on and off every pass, its channel joining its base
  // to its emitter's LOW; and a flip-flop of two switched each other the
  // same way (2026-10-14). A desk whose voltages agree with its levels reads
  // the same either way: engine-parity holds.
  const selfControlled = new Map(); // comp → its device
  for (const d of devices) {
    if (d.key !== d.comp || d.array || d.outPin != null) continue;
    selfControlled.set(d.comp, d);
  }

  const topo = { rails, clusters, clusterOf, order, rank, channels, devices, gates, gateUsers, railBranches, railDevices, railDrivers, railReaders, readers, drivers, senseRefs, sources, clockPsu, offRail, sup, watch, coils, railCoils, selfControlled, freeNets, freeKey }; // prettier-ignore
  byFree.set(freeKey, topo);
  return topo;
}

/** Each report entry's own share of a report (`shareOf`). */
const SHARES = new WeakMap();

/**
 * What one cluster's report entry adds to a report, as the report states it:
 * its junctions' `{amps, volts}`, its outputs' loads and its supply draws —
 * each paired with where the cluster's current returns. Built once per entry:
 * an entry is kept while its cluster is not re-solved (`reported`), and so is
 * this, rather than rebuilt by every report that reads it.
 */
function shareOf(e) {
  let share = SHARES.get(e);
  if (share) return share;
  const draws = [...e.extra];
  if (e.sources.length) {
    const back = e.returns.reduce((best, r) => (!best || r.amps > best.amps ? r : best), null); // prettier-ignore
    // What flows back INTO a supply's + (a coil freewheeling round its
    // flyback diode: out through its resistor, home through the diode) is
    // none of its delivery — booked gross, a PWM motor's supply read its
    // coil's whole current through every off-phase (the regrade,
    // 2026-10-23). Each of its sources scaled to the net.
    const net = new Map();
    for (const s of e.sources) net.set(s.psu, (net.get(s.psu) ?? 0) + s.amps);
    const gross = new Map(net);
    for (const s of e.sinks ?? []) if (net.has(s.psu)) net.set(s.psu, net.get(s.psu) - s.amps); // prettier-ignore
    for (const s of e.sources) {
      const share = Math.max(0, net.get(s.psu)) / gross.get(s.psu);
      if (!(share > 0)) continue;
      draws.push({ chip: null, psu: s.psu, plusAt: s.plusAt ?? null, minusAt: back?.minusAt ?? null, amps: s.amps * share }); // prettier-ignore
    }
  }
  share = {
    junctions: e.junctions.map(([key, amps, vd]) => [key, { amps, volts: vd }]), // prettier-ignore
    outputs: e.outputs.map(([comp, pin, amps, watts, limits]) => ({ comp, pin, amps, watts, limits })), // prettier-ignore
    switches: e.switches.map(([comp, key, amps, limits]) => ({ comp, key, amps, limits: limits ?? SWITCH_LIMITS })), // prettier-ignore
    devices: e.devices.map(([comp, amps, watts, limits, led]) => ({ comp, amps, watts, limits, ...(led ? { led: true } : {}) })), // prettier-ignore
    brownouts: e.brownouts.map(([comp, pin, net, level, volts, inputs, misread]) => ({ comp, pin, net, level, volts, inputs, misread })), // prettier-ignore
    draws,
  };
  SHARES.set(e, share);
  return share;
}

/** The key one reader PIN's reading is kept under: `<compId>#<pin>`. */
export const readerKey = (comp, pin) => `${comp}#${pin}`;

/** The part a reader key belongs to. */
const compOfKey = (key) => key.slice(0, key.lastIndexOf("#"));

/** An input's reading of `v` volts through thresholds `th`, given what it
    read before (a Schmitt input holds it inside its hysteresis). */
function readingOf(th, v, before) {
  if (th.schmitt) {
    if (v >= th.up) return H;
    if (v <= th.down) return L;
    return before === H || before === L ? before : v >= (th.up + th.down) / 2 ? H : L; // prettier-ignore
  }
  if (v >= th.vih) return H;
  if (v <= th.vil) return L;
  return X;
}

/**
 * Solve one net held by nothing but drivers: the voltage at which what they
 * push in balances what they draw out. Each stage's current falls as the net
 * rises, so the answer lies between the lowest stage's open-circuit level and
 * the highest's, and is found by Newton's method kept inside that bracket —
 * bisecting where a stage is saturated or off and its slope says nothing.
 * @param {Array<object>} stages - spice/output-stage.js stages
 * @param {number} guess - where to start (the last answer)
 */
export function solveDrivers(stages, guess) {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const st of stages) {
    lo = Math.min(lo, st.volts);
    hi = Math.max(hi, st.volts);
  }
  if (!(hi > lo)) return lo;
  const sum = (x) => {
    let total = 0;
    for (const st of stages) total += stageCurrent(st, x);
    return total;
  };
  let v = Math.min(hi, Math.max(lo, Number.isFinite(guess) ? guess : (lo + hi) / 2)); // prettier-ignore
  for (let step = 0; step < 100; step++) {
    const f = sum(v);
    if (Math.abs(f) <= TOLERANCE_A) break;
    // Below the answer the stages push current in; above it they draw it.
    if (f > 0) lo = v;
    else hi = v;
    let g = 0;
    for (const st of stages) g += stageSlope(st, v);
    let next = g < 0 ? v - f / g : NaN;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    if (Math.abs(next - v) < 1e-12) break;
    v = next;
  }
  return v;
}

const EMPTY = new Map();

const NONE = Object.freeze([]);

/** How many times one pass re-solves the clusters a MOSFET gate that moved
    switches. */
const GATE_ROUNDS = 8;

/** How far an RC node is nudged to read its network's slope, volts. */
const LINEARIZE_V = 1e-3;

/** Whether a voltage cluster's op-amps can swing of themselves
    (`fedBack`), by cluster. */
const FED_BACK = new WeakMap();

/** How closely a corner search places a corner, volts. */
const CORNER_V = 1e-7;

/** The branch kinds curved within a piece (`linearizeGroup`'s `pure`). */
const CURVED_KINDS = new Set(["q", "m", "o"]);

/** …and with them, the kinds whose slopes are read numerically, a microvolt
    apart (spice/network.js `deviceSlope`) — a limited supply, a load, a 74LS
    splitter: a network with one is read by secants (`tangent` is not). */
const SECANT_KINDS = new Set([...CURVED_KINDS, "p", "e", "t"]);

/** A group's nudge that crosses a corner is read again this much shorter
    (`linearizeGroup`), at most `SECANT_SHRINKS` times: 1 mV → 1 µV → 1 nV. */
const SECANT_SHRINK = 1e-3;
const SECANT_SHRINKS = 2;

/** How closely a network is balanced to read that slope, amps. */
const LINEARIZE_A = 1e-15;

/** How closely a network with an inductor in it is balanced, amps
    (`network`): a net only a coil holds sits at its current over its
    leakage, and balanced to a picoamp a relay's collector rested a volt short
    of its supply with 5 pA in the coil. */
const COIL_TOLERANCE_A = 1e-14;

/** The least an inductor's current is nudged by to read its slope, amps. */
const LINEARIZE_I = 1e-12;

/**
 * The chips' power, thresholds and stages, the rails and the bench sources,
 * as one context says — or, `atSet`, every supply at its SET voltage and
 * every chip on one at it too (the reading supply demand is measured at,
 * spice/supply.js), a chip its supply has dropped out of range still driving
 * what it last drove (else the load that pulled the supply down would vanish
 * with it, and the supply flicker back).
 */
function makePlan(
  ctx,
  config,
  sup,
  atSet,
  offRail = EMPTY,
  clockPsu = EMPTY,
  freeNets = NO_FREE,
) {
  // prettier-ignore
  const setOf = new Map(); // + net → the highest supply SET on it
  if (atSet) {
    for (const p of sup.psus) {
      if (p.plus) setOf.set(p.plus, Math.max(setOf.get(p.plus) ?? 0, p.set));
    }
  }
  const chips = new Map();
  const parts = [];
  for (const c of ctx.chips) {
    const ok = c.status === CHIP_STATUS.OK;
    const vccPin = c.def.pins.find((p) => p.role === "vcc")?.n;
    const vccNet = c.pinNet.get(vccPin) ?? null;
    const delivered = ctx.chipStatus.get(c.comp.id)?.volts ?? c.supplyVolts ?? 0; // prettier-ignore
    const vcc = atSet && setOf.has(vccNet) ? setOf.get(vccNet) : delivered;
    parts.push(`${c.comp.id}:${c.status}:${vcc}`);
    // A chip fed off the rails that its own load has pulled out of range
    // drives on too, in the solve: its stages ARE that load (a 74LS04 fed
    // through 47 Ω, lighting an LED, sits at 4.6 V — underpowered, and
    // still lighting it), and letting go of them would bring its supply back
    // in range, and the chip on again, every other settle.
    const sagging = c.status === CHIP_STATUS.UNDERPOWERED && (atSet || offRail.has(c.comp.id)); // prettier-ignore
    const drives = ok || sagging;
    const feed = sup.feeds.get(c.comp.id) ?? null;
    const tiedLow = (pin) => sup.minusNets.has(c.pinNet.get(pin));
    const icc = supplyMaOf(config, c.def, 5, tiedLow) / 1000;
    const entry = {
      c,
      ok,
      drives,
      // Its supply current as a load across its pins: ICC at 5 V.
      loadOhms: icc > 0 ? 5 / icc : Number.POSITIVE_INFINITY,
      psu: sup.psuOfNet.get(vccNet) ?? null,
      vccAt: feed?.vccAt ?? null,
      gndAt: feed?.gndAt ?? null,
      stageFor: () => null,
      limitsFor: () => null,
      inputsFor: () => NONE,
      senseFor: () => null,
      overRail: c.def.logic?.overRail ?? NONE,
      // A chip not across the rails: the nets its supply pins are on, its
      // stages measured from them (`network`'s "s" branches) and its inputs
      // reading against its own ground.
      off: offRail.get(c.comp.id) ?? null,
      vcc,
    };
    if (drives && vcc > 0) {
      const strengthH = stageStrength(config, c.def, H);
      const strengthL = stageStrength(config, c.def, L);
      entry.high = outputStage(c.def, vcc, H, strengthH);
      entry.low = outputStage(c.def, vcc, L, strengthL);
      // A MOSFET output's drain–body diodes (a CD4000 part's, a MOS part's
      // — not a bipolar totem pole, nor a stage the part states itself):
      // where an inductor's current goes when the output it was flowing
      // through lets go (features/done/spice-lite-3-plan.md, Phase 3).
      entry.outputClamps =
        !c.def.outputStage && (familyOf(c.def) === "CD4000" || !familyOf(c.def))
          ? [
              { volts: -CMOS_CLAMP.overV, ohms: CMOS_CLAMP.ohms, limit: Number.POSITIVE_INFINITY, sources: true, clamp: true }, // prettier-ignore
              { volts: vcc + CMOS_CLAMP.overV, ohms: CMOS_CLAMP.ohms, limit: Number.POSITIVE_INFINITY, sources: false, clamp: true }, // prettier-ignore
            ]
          : NONE;
      // A pin the silicon states its own stage for drives through that
      // (a discharge transistor); every other through the part's. The
      // silicon is told the family's strength on that side too: a stage it
      // builds FROM the family's (the 4047's RC COMMON pull-up) follows it,
      // one it states outright (its own ohms) ignores it.
      const own = c.def.logic?.stages ?? null;
      entry.stageFor = (pin, level) => {
        if (own?.[pin]) {
          return own[pin](vcc, level, level === H ? strengthH : strengthL);
        }
        return level === H ? entry.high : level === L ? entry.low : null;
      };
      entry.limitsFor = (pin) =>
        limitsAt(pinOutputLimits(c.def, pin), vcc, entry.stageFor(pin, L));
    }
    if (ok) {
      entry.th = { ...inputThresholds(config, c.def, vcc), schmitt: Boolean(c.def.schmitt) }; // prettier-ignore
      const stages = new Map(); // pin → its input stages
      // An analog switch's controls, and a CD4007UB's gates, are CMOS inputs
      // like any other (their protection diodes) — a switch powered off the
      // rails' included, its stages measured from its own supply pins as any
      // off-rail chip's are; its channel terminals are no input, and a
      // discrete transistor has no input stage at all.
      const controls = c.analogSwitch
        ? new Set(c.def.pins.filter((p) => p.role === "input").map((p) => p.n))
        : null;
      entry.inputsFor = (pin) => {
        if (c.passive || (controls && !controls.has(pin))) return NONE;
        let list = stages.get(pin);
        if (!list) stages.set(pin, (list = pinInputStages(c.def, vcc, pin, config))); // prettier-ignore
        return list;
      };
      // A comparator's trip points: `ref` the net whose voltage it is
      // compared with (or null), `up`/`down` volts — above the reference, or
      // absolute.
      const sense = c.def.logic?.sense ?? null;
      entry.senseFor = (pin) => {
        const s = sense?.[pin];
        if (!s) return null;
        const ref = s.ref == null ? null : typeof s.ref === "number" ? (c.pinNet.get(s.ref) ?? null) : internalNet(c.comp.id, s.ref); // prettier-ignore
        const up = s.up ? s.up(vcc) : 0;
        const down = s.down ? s.down(vcc) : up;
        return { ref, up, down, hasRef: s.ref != null, window: Boolean(s.window) }; // prettier-ignore
      };
      entry.family = familyOf(c.def);
      entry.vcc = vcc;
      // A relay's contacts are its own figure; a switch's channel its
      // family's at its supply.
      entry.channelOhms = c.def.contacts ? c.def.contacts.ohms : c.analogSwitch ? channelOhms(c.def, vcc) : 0; // prettier-ignore
    }
    chips.set(c.comp.id, entry);
  }
  const railVolts = new Map();
  let vHigh = 0;
  for (const [net, list] of ctx.supplyPlusVolts) {
    // (The + of a supply on its limit is the solve's to hold.)
    if (freeNets.has(net)) continue;
    const v = setOf.get(net) ?? Math.max(...list);
    railVolts.set(net, v);
    vHigh = Math.max(vHigh, v);
    parts.push(`${net}=${v}`);
  }
  for (const net of ctx.supplyMinus) if (!railVolts.has(net)) railVolts.set(net, 0); // prettier-ignore
  if (!(vHigh > 0)) vHigh = 5;
  // A flag no chip reads (into an LED and its resistor, a transistor's
  // base) is a source at the lowest supply SET on the desk — the rule a flag
  // a chip reads follows, so an idle 12 V PSU in the corner does not make a
  // 5 V circuit's flag a 12 V source; the SET, not what a supply delivers,
  // since the flag is ideal and must not sag with what it switches.
  const sourceHigh = sourceVolts(ctx);
  let lowestSet = null;
  for (const psu of sup.psus) {
    if (psu.plus && psu.set > 0 && (lowestSet == null || psu.set < lowestSet)) lowestSet = psu.set; // prettier-ignore
  }
  // At SET, a clock brick's HIGH is its supply's SET too: what it delivers
  // droops with what the clock itself sources, and booking that at the
  // drooped HIGH flipped a limited supply between two answers every tick
  // (1.73 V and 5 V, a clock into an LED on a 10 mA PSU).
  if (atSet) {
    for (const [net, { psu }] of clockPsu) {
      const plus = sup.psus.find((x) => x.id === psu)?.plus;
      if (sourceHigh.get(net) != null && setOf.has(plus)) sourceHigh.set(net, setOf.get(plus)); // prettier-ignore
    }
  }
  for (const [net, v] of sourceHigh) {
    if (v == null && lowestSet != null) sourceHigh.set(net, lowestSet);
    parts.push(`${net}^${sourceHigh.get(net)}`);
  }
  return { chips, railVolts, vHigh, sourceHigh, signature: parts.join("|") };
}

/** The collections a voltage side carries from tick to tick
    (`createVoltages`' copy-on-write). */
const CARRIED = ["volts", "readings", "shown", "auth", "used", "channelOn", "sourceUsed", "fixedUsed", "coilUsed", "reported", "stale", "setReported", "setStale", "unsettled", "setUnsettled", "loose", "setVolts", "disagree", "shownMoved"]; // prettier-ignore

/** How many elements two reads of one network's pieces agree on
    (spice/network.js `pieceList`, `linearizeGroup`). */
function sharedPieces(a, b) {
  if (a.length !== b.length) return -1;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) n++;
  return n;
}

/** A fixed regulator's GND taking under this, amps, while its OUT stands
    `OPEN_GND_V` below it, has nothing DC behind it: its quiescent current
    is milliamps whenever it has headroom. */
const OPEN_GND_A = 1e-6;
const OPEN_GND_V = 0.5;

/**
 * The voltage side of one Spice Lite tick. `prior` is what the last tick's
 * `snapshot()` returned (null at Run): the solved voltages and the readings
 * carry from tick to tick, as the levels do, so a tick's first pass reads
 * what its warm start says — and re-solves only what moved since, exactly as
 * a pass within a tick does: everything a cluster's solve reads is carried
 * with it and compared on the way in (the outputs `used`, the channels, the
 * bench sources, the RC nodes, the burnt junctions, the plan's signature,
 * the owned readers). A new netlist or a new setting starts afresh.
 * `full` solves every cluster at the tick's start all the same — the
 * reference tests/engine-incremental.test.js holds the carried solve to,
 * field by field, as it holds the incremental settle to the full one.
 * @param {object} opts
 * @param {object} opts.doc
 * @param {{netOfPoint: Map}} opts.netlist
 * @param {object} opts.config - normalized spice config
 * @param {object|null} opts.prior
 * @param {Map<string,string>} [opts.clockPhase]
 * @param {Map<string,string>} [opts.signalLevels]
 * @param {boolean} [opts.full]
 * @param {object} [opts.stats] - counters to add to (tests and the bench):
 *   `clusterSolves`, the clusters solved; `bookings`, those booked at SET
 * @param {Set<string>} [opts.free] - the supplies on their limit, PSU ids
 *   (`voltageTopology`): a change of them starts afresh, as a new netlist does
 */
export function createVoltages({
  doc,
  netlist,
  config,
  prior = null,
  free = NO_FREE,
  full = false,
  stats = null,
  clockPhase: clocksAt = EMPTY,
  signalLevels: signalsAt = EMPTY,
}) {
  // What the bench sources hold — the tick's own, or, while a late tick
  // replays its history, the last tick's (`sources`).
  let clockPhase = clocksAt;
  let signalLevels = signalsAt;
  // The setting is read at Run and never changes during one, but a plan's
  // thresholds and loads are built from it, so a different one is a fresh
  // start rather than a signature to keep in step with it.
  const configKey = JSON.stringify(config);
  const freeKey = [...free].sort().join(",");
  const fresh = prior?.netlist !== netlist || prior.configKey !== configKey || (prior.freeKey ?? "") !== freeKey; // prettier-ignore
  // Carried from the last tick by REFERENCE and copied on this tick's first
  // write to each (`own`): the last tick's snapshot is never written, so the
  // engine stays a pure function of its inputs, and a tick that leaves a map
  // alone never pays for its copy (it was every carried map, every tick: a
  // tenth of what a tick allocated — features/spice-perf, after 11). An
  // inner readings map is replaced, never edited, so the outer copy is all
  // a write needs.
  let volts = fresh ? new Map() : prior.volts;
  let readings = fresh ? new Map() : prior.readings; // net → Map<comp, level>
  let shown = fresh ? new Map() : prior.shown; // net → the readers' level
  let auth = fresh ? new Set() : prior.auth;
  let used = fresh ? new Map() : prior.used; // comp → the outputs last solved with
  let channelOn = fresh ? new Map() : prior.channelOn; // channel key → H|L|X
  let sourceUsed = fresh ? new Map() : prior.sourceUsed; // net → level
  let fixedUsed = fresh ? new Map() : prior.fixedUsed; // RC net → volts
  let coilUsed = fresh ? new Map() : prior.coilUsed; // inductor → amps
  let reported = fresh ? new Map() : prior.reported; // cluster → its currents
  let stale = fresh ? new Set() : prior.stale; // clusters solved since reported
  // …and the same for the booking at SET (`report({atSet})`), with the plan
  // signature it was booked under.
  let setReported = fresh ? new Map() : prior.setReported;
  let setStale = fresh ? new Set() : prior.setStale;
  let setSignature = fresh ? null : prior.setSignature;
  // The clusters whose last solve could not balance (and the same at SET):
  // where they stopped is no answer to carry, and a solve from there may move
  // on — so each tick solves them again, as a full solve does.
  let unsettled = fresh ? new Set() : prior.unsettled;
  let setUnsettled = fresh ? new Set() : prior.setUnsettled;
  // Where each net NOTHING holds last solved — a floating anode, a lead held
  // only through a junction's leakage. Its voltage is the solver's noise (a
  // nanoamp of tolerance over a nanosiemens of leakage is a volt), so it is
  // never a reading; but it is the next solve's starting guess, so solving
  // an unchanged network again lands where it already stands rather than on
  // fresh noise from mid-supply.
  let loose = fresh ? new Map() : prior.loose;
  // …and on a fresh side, where the last side left each net, as no more
  // than a starting guess: from mid-supply, a circuit with two balances —
  // an op-amp Schmitt with no capacitor, held HIGH in its band — fell LOW
  // at any edit, however unrelated (the fourth regrade, 2026-10-22).
  const seeds = fresh ? (prior?.volts ?? EMPTY) : EMPTY;
  let signature = fresh ? null : prior.signature;
  // What the networks ARE — their chips' power, the junctions burnt, the
  // regulators shut down, the outputs, the channels, the bench sources, the
  // gates — as against where their RC nodes and coils stand (`epoch`),
  // stated afresh only after one of them changed: a group's curve made
  // under one statement runs on exactly while it holds (spice/engine.js
  // `runGroup`). Stated, not counted, so the incremental settle and the
  // full one agree on it whatever each re-solved. (A fresh side — a new
  // netlist, setting or supply set — says so, so nothing made before it
  // matches.)
  let shape = null;
  // This run of the voltage side, carried by reference from tick to tick
  // and new on a fresh start: what spice/engine.js keys the linearizations
  // it keeps by (`lineage`), so two runs never share them.
  const lineage = fresh ? {} : prior.lineage;
  let burntUsed = fresh ? new Set() : prior.burntUsed;
  let thermalUsed = fresh ? new Set() : (prior.thermalUsed ?? new Set());
  let setVolts = fresh ? new Map() : prior.setVolts; // the booking solve's warm start

  let topo = null;
  let ctxNow = null;
  const solvedAs = new Map(); // cluster → the network its last solve was, this tick
  // Where each cluster's network last stood when a group was linearized on
  // it, this tick (`linearizeGroup`): the next linearization's start. A
  // group runs corner to corner, so its next one stands where the last
  // ended; started from where the tick began instead, an NPN switch on a
  // sine climbed from OFF to saturated afresh at every corner of a cycle,
  // twenty-odd damped steps up its exponential each time (2026-10-23). By
  // the cluster itself, which a new topology does not share; and never
  // cleared within the tick, or the full settle and the carried one (whose
  // `all` differs) would start the same solve from different places.
  const linearizedAt = new Map();
  let lastReport = null; // {plan, answer}: the last report, while nothing moved
  let plan = null; // the chips' power, thresholds and stages, per context
  let all = fresh || full; // every cluster is to be solved
  const dirty = new Set(unsettled); // cluster indices
  let newly = false; // a cluster first found out of balance this tick
  let disagree = fresh ? new Map() : prior.disagree;
  // Nets whose shown level changed since a pass last compared it with the
  // digital one (`passOverrides`): a net re-read outside a pass — the
  // tick's last solve, a capacitor's network — was never compared, and
  // showed L for a whole run where its gate read X.
  let shownMoved = fresh ? new Set() : (prior.shownMoved ?? new Set());
  const copied = new Set(fresh ? CARRIED : []);
  /** A carried collection this tick may write: copied first, once. */
  const own = {
    volts: () => { if (!copied.has("volts")) { copied.add("volts"); volts = new Map(volts); } return volts; }, // prettier-ignore
    readings: () => { if (!copied.has("readings")) { copied.add("readings"); readings = new Map(readings); } return readings; }, // prettier-ignore
    shown: () => { if (!copied.has("shown")) { copied.add("shown"); shown = new Map(shown); } return shown; }, // prettier-ignore
    auth: () => { if (!copied.has("auth")) { copied.add("auth"); auth = new Set(auth); } return auth; }, // prettier-ignore
    used: () => { if (!copied.has("used")) { copied.add("used"); used = new Map(used); } return used; }, // prettier-ignore
    channelOn: () => { if (!copied.has("channelOn")) { copied.add("channelOn"); channelOn = new Map(channelOn); } return channelOn; }, // prettier-ignore
    sourceUsed: () => { if (!copied.has("sourceUsed")) { copied.add("sourceUsed"); sourceUsed = new Map(sourceUsed); } return sourceUsed; }, // prettier-ignore
    fixedUsed: () => { if (!copied.has("fixedUsed")) { copied.add("fixedUsed"); fixedUsed = new Map(fixedUsed); } return fixedUsed; }, // prettier-ignore
    coilUsed: () => { if (!copied.has("coilUsed")) { copied.add("coilUsed"); coilUsed = new Map(coilUsed); } return coilUsed; }, // prettier-ignore
    reported: () => { if (!copied.has("reported")) { copied.add("reported"); reported = new Map(reported); } return reported; }, // prettier-ignore
    stale: () => { if (!copied.has("stale")) { copied.add("stale"); stale = new Set(stale); } return stale; }, // prettier-ignore
    setReported: () => { if (!copied.has("setReported")) { copied.add("setReported"); setReported = new Map(setReported); } return setReported; }, // prettier-ignore
    setStale: () => { if (!copied.has("setStale")) { copied.add("setStale"); setStale = new Set(setStale); } return setStale; }, // prettier-ignore
    unsettled: () => { if (!copied.has("unsettled")) { copied.add("unsettled"); unsettled = new Set(unsettled); } return unsettled; }, // prettier-ignore
    setUnsettled: () => { if (!copied.has("setUnsettled")) { copied.add("setUnsettled"); setUnsettled = new Set(setUnsettled); } return setUnsettled; }, // prettier-ignore
    loose: () => { if (!copied.has("loose")) { copied.add("loose"); loose = new Map(loose); } return loose; }, // prettier-ignore
    setVolts: () => { if (!copied.has("setVolts")) { copied.add("setVolts"); setVolts = new Map(setVolts); } return setVolts; }, // prettier-ignore
    disagree: () => { if (!copied.has("disagree")) { copied.add("disagree"); disagree = new Map(disagree); } return disagree; }, // prettier-ignore
    shownMoved: () => { if (!copied.has("shownMoved")) { copied.add("shownMoved"); shownMoved = new Set(shownMoved); } return shownMoved; }, // prettier-ignore
  }; // net → shown ≠ digital
  let reread = new Set();
  let moved = false;
  let candidates = EMPTY; // the RC nodes' nets: their readings are spice/engine.js's
  let owned = fresh ? new Set() : prior.owned; // reader keys spice/engine.js reads by their crossings
  let rcVolts = EMPTY; // RC node net → volts, for this settle
  let coilAmps = EMPTY; // inductor → amps, for this settle
  let burnt = burntUsed;
  let thermal = thermalUsed; // regulators shut down hot (spice/engine.js)
  // Something only the rails' own report reads moved (a channel or a MOSFET
  // straight across two rails): the next report is read afresh.
  let railMoved = false;

  const markNet = (net, other = null) => {
    const k = topo?.clusterOf.get(net) ?? topo?.clusterOf.get(other);
    if (k != null) dirty.add(k);
  };
  for (const k of setUnsettled) if (!setStale.has(k)) own.setStale().add(k);

  /** Read the chips' power off a new context; any change re-solves all. */
  function context(ctx) {
    topo = voltageTopology(doc, netlist, ctx, free);
    ctxNow = ctx;
    // A plan is a pure function of its context and the setting: a context
    // reused (sim/engine.js `contextFor`) keeps its plan
    // (features/09-cache-tick-analysis.md).
    const memo = PLANS.get(ctx);
    if (memo?.configKey === configKey && memo.topo === topo) {
      plan = memo.plan;
      if (ASSERT_ANALYSIS) {
        const fresh = makePlan(ctx, config, topo.sup, false, topo.offRail, EMPTY, topo.freeNets); // prettier-ignore
        if (fresh.signature !== plan.signature) throw new Error("SPICE_ASSERT_ANALYSIS: a cached plan differs from one made afresh"); // prettier-ignore
      }
    } else {
      plan = makePlan(ctx, config, topo.sup, false, topo.offRail, EMPTY, topo.freeNets); // prettier-ignore
      PLANS.set(ctx, { configKey, topo, plan });
    }
    if (plan.signature !== signature) {
      signature = plan.signature;
      all = true;
      shape = null;
    }
  }

  /** Where the RC nodes' own reads put the nets of their networks now
      (spice/engine.js `guessAt`): the first guess of the cluster solves
      about to run, which a node that moved since the last solve made from
      where that one left them, a few Newton steps from here. Used once. */
  let guessed = null;
  function guessNets(map) {
    guessed = map;
  }

  /** The nets spice/engine.js keeps as RC nodes, and their voltages for the
      settle about to run — a node that moved re-solves its cluster. */
  function setNodes(nets, voltsOfNode) {
    candidates = nets;
    rcVolts = voltsOfNode;
    for (const [net, v] of voltsOfNode) {
      if (fixedUsed.get(net) !== v) markNet(net);
    }
    for (const net of fixedUsed.keys()) if (!voltsOfNode.has(net)) markNet(net);
  }

  /** Each inductor's current for the settle about to run, amps
      (spice/inductors.js) — a coil whose current moved re-solves its
      cluster. */
  function setCoils(amps) {
    coilAmps = amps;
    for (const l of topo?.coils ?? []) {
      if ((coilUsed.get(l.id) ?? 0) !== (amps.get(l.id) ?? 0))
        markNet(l.a, l.b);
    }
  }

  /** The junctions burnt so far (open). */
  function setBurnt(set) {
    if (set.size !== burnt.size || [...set].some((k) => !burnt.has(k))) shape = null; // prettier-ignore
    if (set.size !== burntUsed.size || [...set].some((k) => !burntUsed.has(k))) all = true; // prettier-ignore
    burnt = set;
  }

  /** The regulators shut down hot (spice/engine.js `thermal`): off until
      they have cooled. */
  function setThermal(set) {
    if (set.size !== thermal.size || [...set].some((k) => !thermal.has(k))) shape = null; // prettier-ignore
    if (set.size !== thermalUsed.size || [...set].some((k) => !thermalUsed.has(k))) all = true; // prettier-ignore
    thermal = set;
  }

  /** A chip's outputs as this pass let them through. */
  function outputs(c, out) {
    const was = used.get(c.comp.id);
    if (was === out) return;
    own.used().set(c.comp.id, out);
    if (!was || was.size !== out.size || [...out].some(([pin, level]) => was.get(pin) !== level)) shape = null; // prettier-ignore
    if (!topo || all) return;
    // An output's own net's cluster — or, for a chip off the rails, its
    // supply's (its stages are branches there, whatever net they drive); an
    // output on a rail moves only the rails' own report.
    const off = topo.offRail.get(c.comp.id);
    const touch = (pin) => {
      const net = c.pinNet.get(pin);
      if (off && !off.split) markNet(off.vccNet, off.gndNet);
      else if (topo.clusterOf.has(net)) markNet(net);
      else if (off?.home != null) dirty.add(off.home);
      else if (net) railMoved = true;
    };
    for (const [pin, level] of out) {
      if (was?.get(pin) !== level) touch(pin);
    }
    for (const pin of was?.keys() ?? []) {
      if (!out.has(pin)) touch(pin);
    }
  }

  /** What one bench source drives now. */
  const levelOf = (src) =>
    src.kind === "clock" ? clockPhase.get(src.id) : signalLevels.get(src.id);

  /** What the bench sources on one net hold it at: the level every one
      driving agrees on, X where two disagree (ideal sources fighting have no
      voltage — the digital engine's conflict stands), or nothing while none
      drives. */
  function sourceLevel(list) {
    let level = null;
    for (const src of list) {
      const own = levelOf(src);
      if (own !== H && own !== L) continue;
      if (level == null) level = own;
      else if (level !== own) return X;
    }
    return level;
  }

  /** A fixed net's volts this pass, or null: a source driving, an RC node
      (unless `free` — the node being linearized). */
  function fixedOf(net, free = false, p = plan, nodes = rcVolts) {
    // A bench source holds its net whatever a capacitor on it held a moment
    // ago — it is ideal; an RC node is held where its curve has it.
    const list = topo.sources.get(net);
    if (list) {
      // A clock putting out a wave (spice/waves.js) holds its net where the
      // wave is now — spice/engine.js runs it, as a node.
      if (candidates.get(net)?.wave != null) {
        const v = nodes.get(net);
        if (v != null) return v;
      }
      const level = sourceLevel(list);
      if (level === H) return p.sourceHigh.get(net) ?? p.vHigh;
      if (level === L) return 0;
    }
    const rc = free ? null : nodes.get(net);
    return rc ?? null;
  }

  /** A MOSFET gate's voltage: its rail's, or what its net was last solved
      at — kept while it floats, the charge on its capacitance. */
  function gateVolts(net, p = plan) {
    if (p.railVolts.has(net)) return p.railVolts.get(net);
    return volts.get(net) ?? 0;
  }

  /** A gate moved: re-solve the clusters its MOSFETs are in, and re-read
      the rails' own report where one sits across them. */
  function gateMoved(net) {
    shape = null;
    for (const k of topo.gateUsers.get(net) ?? []) {
      if (k === RAIL) railMoved = true;
      else dirty.add(k);
    }
  }

  /** A net nothing holds forgets its voltage — unless it is a MOSFET's gate,
      whose capacitance keeps it. A gate that moved re-solves the clusters
      its MOSFETs are in — and so does one let go or taken hold of at the
      same voltage: its MOSFETs' report says whether they run on its charge
      (`deviceFlow`'s `held`), and a report is re-read only where a cluster
      was re-solved. */
  function settleNet(net, v) {
    const was = volts.get(net);
    const gate = topo.gates.has(net);
    // A net a device reads (a gate, a splitter's input) re-solves its users.
    const read = gate || topo.gateUsers.has(net);
    const wasHeld = read && auth.has(net);
    if (v == null) {
      own.auth().delete(net);
      if (!gate) own.volts().delete(net);
      if (wasHeld) gateMoved(net);
      return;
    }
    own.auth().add(net);
    own.volts().set(net, v);
    if (read && (!wasHeld || !(Math.abs((was ?? 0) - v) <= 1e-9))) {
      gateMoved(net);
    }
  }

  /** The stage a chip's pin drives, or null. */
  function stageAt(d, p = plan) {
    const chip = p.chips.get(d.comp);
    if (!chip?.drives) return null;
    const level = used.get(d.comp)?.get(d.pin);
    return level === H || level === L ? chip.stageFor(d.pin, level) : null;
  }

  /**
   * One transistor as a branch of the network solve, or null while it is no
   * transistor (a CD4007UB unpowered: its substrate is its supply; a
   * discrete one needs none). A MOSFET's gate is `nodeOf` its net where the
   * network solves it (`solved`), else a voltage told to it (`fix`) — its
   * rail's or wherever its net was solved. A CD4007UB's channel is its
   * family's MOSFET, not a discrete power part's: the B-series output
   * transistor's on-resistance and saturation current at its supply
   * (spice/output-stage.js, as every CD4000 output is).
   */
  function deviceBranch(dev, p, nodeOf, fix, solved) {
    if (ANALOG_KINDS.has(dev.kind)) return analogBranch(dev, p, nodeOf);
    if (dev.kind === "t") {
      // A 74LS splitter: there only while its output drives HIGH, its
      // inputs read where they are solved, as a MOSFET's gate is.
      const chip = p.chips.get(dev.comp);
      if (!chip?.drives || used.get(dev.comp)?.get(dev.outPin) !== H) return null; // prettier-ignore
      const ins = dev.ins.map((net) => {
        const node = nodeOf(net);
        if (!solved(net)) fix(node, gateVolts(net, p));
        return node;
      });
      return { ...dev, out: nodeOf(dev.out), gnd: nodeOf(dev.gnd), ins };
    }
    const chip = p.chips.get(dev.comp);
    if (!chip?.ok) return null;
    if (dev.kind === "q") {
      return { ...dev, b: nodeOf(dev.b), c: nodeOf(dev.c), e: nodeOf(dev.e) };
    }
    let g = dev.g ? nodeOf(dev.g) : null;
    if (g == null) {
      g = `${dev.key}#gate`;
      fix(g, 0);
    } else if (!solved(dev.g)) {
      fix(g, gateVolts(dev.g, p));
    }
    const br = { ...dev, a: nodeOf(dev.a), b: nodeOf(dev.b), g };
    if (dev.array) {
      // A P-channel is the family's HIGH (source) transistor, an N-channel
      // its LOW (sink) one — the same figures, each side's own strength.
      const side = dev.p ? H : L;
      const st = outputStage(chip.c.def, chip.vcc, L, stageStrength(config, chip.c.def, side)); // prettier-ignore
      if (st) Object.assign(br, { ron: st.ohms, isat: st.limit });
    }
    return br;
  }

  /** A bench part as the branch it is in one network (spice/analog-
      devices.js), its nets as that network's nodes: a chip's (an
      optocoupler, an op-amp) only while it is powered and well; a
      regulator off while it is shut down hot (`thermal`). */
  function analogBranch(dev, p, nodeOf) {
    if (dev.chip && !p.chips.get(dev.comp)?.ok) return null;
    const br = { ...dev };
    for (const key of dev.nodes) br[key] = nodeOf(dev[key]);
    if (dev.kind === "g" && thermal.has(dev.comp)) br.off = true;
    return br;
  }

  /**
   * One cluster as a network to solve (spice/network.js's shape), with the
   * nets it holds fixed, solved. `free` is a net whose own RC curve is NOT
   * applied (the node being linearized), `pin` one held at a voltage of the
   * caller's choosing; `p` the plan (the booking solve's, at SET), `guess`
   * where its unknowns start, `nodes` the RC nodes' voltages (this settle's,
   * unless the caller is reading what a node's moving does).
   */
  function network(k, opts = {}) {
    return solveShape(networkShape(k, opts), opts.pin?.volts);
  }

  /** A cluster's network pinned at `net` — `v` → it solved with `net` held
      at `v` volts (`network`'s `pin`): built once, solved again for each
      voltage a caller samples it at (a corner search, a slope read — the
      networks' branches, drivers and maps were rebuilt every sample:
      allocation, features/spice-perf after 11). */
  function pinnedAt(k, net) {
    const shape = networkShape(k, { free: net, pin: { net, volts: 0 } });
    // Each voltage solved once: `linearize` reads the node where it stands
    // and a nudge on three and four times over (its current, its swing, the
    // corner inside the nudge, the far search's start) — a third of an
    // op-amp oscillator's solves were repeats. Nothing a solve reads moves
    // between them (a swing taken makes a new one).
    const solved = new Map();
    return (v) => {
      let nw = solved.get(v);
      if (!nw) solved.set(v, (nw = solveShape(shape, v)));
      return nw;
    };
  }

  /** `network` but its solve: everything a solve of the cluster reads,
      with the pinned node (if any) at a placeholder (`solveShape` puts the
      voltage in). */
  function networkShape(
    k,
    { free = null, pin = null, p = plan, guess: warm = volts, nodes = rcVolts, amps = coilAmps, exact = false } = {}, // prettier-ignore
  ) {
    const cl = topo.clusters[k];
    const given = givenOf(cl, free, p, nodes);
    let uf = null;
    const links = [];
    for (const ch of cl.channels) {
      if (channelOn.get(ch.key) !== H) continue;
      const chip = p.chips.get(ch.comp);
      if (!chip?.ok) continue;
      if (chip.channelOhms > 0) links.push({ ...ch, ohms: chip.channelOhms });
      else if (!(given.has(ch.a) && given.has(ch.b))) {
        uf ??= new UnionFind();
        uf.union(ch.a, ch.b);
      }
    }
    const nodeOf = uf ? (net) => uf.find(net) : (net) => net;
    const fixed = fixedFrom(given, nodeOf);
    // The node being linearized: driven outright by what it is joined to,
    // or pinned where the caller says.
    const driven = free != null && fixed.has(nodeOf(free)) ? fixed.get(nodeOf(free)) : null; // prettier-ignore
    const pinNode = pin && driven == null ? nodeOf(pin.net) : null;
    if (pinNode != null) fixed.set(pinNode, pin.volts);
    const branches = [];
    for (const r of cl.resistors) {
      // A speaker's coil burnt open (spice/speakers.js) is no branch.
      if (r.key != null && burnt.has(r.key)) continue;
      const a = nodeOf(r.a);
      const b = nodeOf(r.b);
      if (a !== b) branches.push({ kind: "r", a, b, ohms: r.ohms, aAt: r.aAt, bAt: r.bAt }); // prettier-ignore
    }
    for (const l of links) {
      const a = nodeOf(l.a);
      const b = nodeOf(l.b);
      if (a !== b) branches.push({ kind: "r", a, b, ohms: l.ohms, aAt: l.aAt, bAt: l.bAt, channel: l.key, comp: l.comp }); // prettier-ignore
    }
    for (const j of cl.junctions) {
      if (burnt.has(j.key)) continue;
      const a = nodeOf(j.anode);
      const b = nodeOf(j.cathode);
      if (a !== b) branches.push({ kind: "j", a, b, spec: j.spec, diode: j.diode, aAt: j.anodeAt, bAt: j.cathodeAt, key: j.key }); // prettier-ignore
    }
    for (const load of cl.loads) {
      const a = nodeOf(load.a);
      const b = nodeOf(load.b);
      const ohms = p.chips.get(load.comp)?.loadOhms;
      if (a !== b && Number.isFinite(ohms)) branches.push({ kind: "r", a, b, ohms, aAt: load.aAt, bAt: load.bAt }); // prettier-ignore
    }
    for (const dev of cl.devices) {
      const br = deviceBranch(dev, p, nodeOf, (g, v) => fixed.set(g, v), (net) => cl.nets.includes(net)); // prettier-ignore
      if (br) branches.push(br);
    }
    // Each inductor: a current source of its current (spice/inductors.js).
    for (const l of cl.inductors) {
      branches.push({ kind: "l", key: l.id, a: nodeOf(l.a), b: nodeOf(l.b), amps: amps.get(l.id) ?? 0, aAt: l.aAt, bAt: l.bAt }); // prettier-ignore
    }
    // A chip not across the rails: its stages measured from its own supply
    // pins' nets, their current through those pins (spice/network.js "s").
    const offOuts = [];
    for (const comp of cl.offChips) {
      const chip = p.chips.get(comp);
      const own = topo.offRail.get(comp);
      if (!chip || !own) continue;
      const vccNode = nodeOf(own.vccNet);
      const gndNode = nodeOf(own.gndNet);
      // A pin in this network — or on a rail, its home network's.
      const mine = (net) =>
        topo.clusterOf.get(net) === k || (topo.rails.has(net) && own.home === k); // prettier-ignore
      for (const d of own.drivers ?? []) {
        if (!mine(d.net)) continue;
        const st = stageAt(d, p);
        if (!st) continue;
        // A HIGH is its supply pin less the stage's drop; a LOW its ground
        // plus the stage's own.
        const ref = st.sources ? vccNode : gndNode;
        const offset = st.volts - (st.sources ? chip.vcc : 0);
        const out = nodeOf(d.net);
        branches.push({ kind: "s", key: `${comp}#${d.pin}`, comp, out, ref, feed: ref, stage: st, offset, both: !st.sources, d, outAt: d.at, feedAt: st.sources ? chip.vccAt : chip.gndAt }); // prettier-ignore
        offOuts.push(out);
      }
      if (!chip.ok) continue;
      for (const r of own.readers ?? []) {
        if (!mine(r.net)) continue;
        for (const st of chip.inputsFor(r.pin)) {
          // Measured from its ground; a 74LS input's bias and the upper
          // clamp diode draw from its supply pin, the lower clamp from its
          // ground.
          const feed = st.clamp === Boolean(st.sources) ? gndNode : vccNode;
          branches.push({ kind: "s", key: `${comp}#${r.pin}#in`, comp, out: nodeOf(r.net), ref: gndNode, feed, stage: st, offset: st.volts, outAt: r.at, feedAt: feed === vccNode ? chip.vccAt : chip.gndAt }); // prettier-ignore
        }
      }
    }
    const drivers = new Map(); // node → [stage]
    const outs = new Map(); // node → [{stage, d}] — the chips' outputs alone
    const holds = new Set(fixed.keys()); // nodes something holds
    const add = (map, node, x) => {
      let list = map.get(node);
      if (!list) map.set(node, (list = []));
      list.push(x);
    };
    for (const node of offOuts) holds.add(node);
    // An op-amp's output, and a regulator's that is on, as an output's;
    // an isolated AC supply's tie to earth.
    for (const br of branches) for (const node of heldOutright(br)) holds.add(node); // prettier-ignore
    for (const net of cl.nets) {
      const node = nodeOf(net);
      for (const d of topo.drivers.get(net) ?? []) {
        if (topo.offRail.has(d.comp)) continue; // an "s" branch, above
        // Only where an inductor can push an output past its rails.
        if (cl.inductors.length) {
          for (const clamp of p.chips.get(d.comp)?.outputClamps ?? NONE) add(drivers, node, clamp); // prettier-ignore
        }
        const st = stageAt(d, p);
        if (!st) continue;
        add(drivers, node, st);
        add(outs, node, { stage: st, d });
        holds.add(node);
      }
      for (const r of topo.readers.get(net) ?? []) {
        if (topo.offRail.has(r.comp)) continue;
        const chip = p.chips.get(r.comp);
        if (chip?.ok) for (const st of chip.inputsFor(r.pin)) add(drivers, node, st); // prettier-ignore
      }
    }
    const touching = touchingOf(branches);
    const unknown = [];
    const seen = new Set();
    for (const net of cl.nets) {
      const node = nodeOf(net);
      if (fixed.has(node) || seen.has(node)) continue;
      seen.add(node);
      unknown.push(node);
    }
    // A network solved to read a slope off is solved to the last bit: its
    // currents are differenced a millivolt apart. So is one with an
    // inductor in it: a coil is a current source, and a net it alone holds
    // (a relay's collector once its transistor is off) answers its current
    // through nothing but leakage — a nanoamp there is volts.
    const tolerance = pin || exact ? LINEARIZE_A : cl.inductors.length ? COIL_TOLERANCE_A : undefined; // prettier-ignore
    return { cl, nodeOf, unknown, touching, drivers, outs, branches, fixed, driven, holds, pinNode, tolerance, warm, p }; // prettier-ignore
  }

  /** What a cluster's network is held at, strongest first: a rail, then a
      bench source, then an RC node at its curve (`nodes`) — so where a
      switched-on channel joins them, the rail is what the joined nets are
      held at. net → volts. */
  function givenOf(cl, free, p, nodes) {
    const given = new Map();
    for (const net of cl.rails) given.set(net, p.railVolts.get(net) ?? 0);
    for (const net of cl.nets) {
      if (topo.sources.has(net)) {
        const f = fixedOf(net, net === free, p, nodes);
        if (f != null) given.set(net, f);
      }
    }
    for (const net of cl.nets) {
      if (given.has(net)) continue;
      const f = fixedOf(net, net === free, p, nodes);
      if (f != null) given.set(net, f);
    }
    return given;
  }

  /** `given` by node (the first held net of a joined set is its volts). */
  function fixedFrom(given, nodeOf) {
    const fixed = new Map();
    for (const [net, v] of given) {
      const node = nodeOf(net);
      if (!fixed.has(node)) fixed.set(node, v);
    }
    return fixed;
  }

  /**
   * The current each of `nets` takes in, read again and again with only the
   * RC nodes moving (`at`) — a common mode's balance (spice/engine.js
   * `balance`, `balanceTogether`), dozens of residuals for one answer. Each
   * cluster's network is BUILT once (`networkShape`: its branches, drivers,
   * joins) and only its held voltages are put in afresh each read; built
   * afresh every read, two MOSFETs switching each other (an astable on
   * 2N7000s) spent 83 % of a run there, seconds a switch (the regrade,
   * 2026-10-23). Same answers as `currentsAt`, read for read.
   * @param {string[]} nets
   * @param {Map<string, number>} [amps]
   * @returns {(at: Map<string, number>) => Float64Array}
   */
  function currentsReader(nets, amps = coilAmps) {
    const byCluster = new Map();
    nets.forEach((net, i) => {
      const k = topo?.clusterOf.get(net);
      if (k == null) return;
      if (!byCluster.has(k)) byCluster.set(k, []);
      byCluster.get(k).push([net, i]);
    });
    const shapes = new Map(); // cluster → {shape, fixed, movers}
    // A held voltage that is an RC node's own (not a rail's, not a bench
    // source's level): the one thing a read puts in afresh.
    const moves = (net) =>
      !topo.rails.has(net) && (!topo.sources.has(net) || candidates.get(net)?.wave != null); // prettier-ignore
    return (at) => {
      const out = new Float64Array(nets.length);
      for (const [k, list] of byCluster) {
        let memo = shapes.get(k);
        let nw = null;
        if (memo) {
          const fixed = new Map(memo.fixed);
          for (const [node, net] of memo.movers) {
            const v = at.get(net);
            if (v == null) {
              fixed.clear();
              break;
            }
            fixed.set(node, v);
          }
          // (A node let go of since — built afresh below.)
          if (fixed.size) nw = solveShape({ ...memo.shape, fixed });
        }
        if (!nw) {
          const shape = networkShape(k, { nodes: at, amps, exact: true });
          const given = givenOf(topo.clusters[k], null, plan, at);
          const movers = [];
          const owned = new Set();
          for (const net of given.keys()) {
            const node = shape.nodeOf(net);
            if (owned.has(node)) continue;
            owned.add(node);
            if (moves(net)) movers.push([node, net]);
          }
          shapes.set(k, { shape, fixed: shape.fixed, movers });
          nw = solveShape(shape);
        }
        for (const [net, i] of list) out[i] = currentInto(nw.nodeOf(net), nw);
      }
      return out;
    };
  }

  /** Solve a network's shape (`networkShape`), its pinned node at `pinV`. */
  function solveShape(shape, pinV) {
    const { cl, nodeOf, unknown, touching, drivers, outs, branches, driven, holds, pinNode, tolerance, warm, p } = shape; // prettier-ignore
    let fixed = shape.fixed;
    if (pinNode != null && fixed.get(pinNode) !== pinV) {
      fixed = new Map(fixed);
      fixed.set(pinNode, pinV);
    }
    const guess = new Map();
    for (const node of unknown) guess.set(node, warm.get(node) ?? loose.get(node) ?? seeds.get(node) ?? p.vHigh / 2); // prettier-ignore
    const nw = { cl, nodeOf, nodes: unknown, touching, drivers, outs, branches, fixed, volts: guess, driven }; // prettier-ignore
    if (tolerance !== undefined) nw.tolerance = tolerance;
    nw.balanced = holds.size && unknown.length ? newtonSolve(nw) : true;
    // What is held: anything a resistive path reaches from a held node —
    // through a transistor only while it conducts, as it now stands, and
    // through a junction likewise (a rectifier's output is held by nothing
    // else; a floating anode, conducting nothing, stays unheld).
    const vAt = (node) => fixed.get(node) ?? guess.get(node) ?? 0;
    const held = new Set(holds);
    const stack = [...holds];
    while (stack.length) {
      const node = stack.pop();
      for (const br of touching.get(node) ?? []) {
        let others;
        if (br.kind === "r" || br.kind === "l")
          others = [br.a === node ? br.b : br.a]; // prettier-ignore
        else if (br.kind === "q")
          others = deviceConducts(br, vAt) ? [br.b, br.c, br.e] : []; // prettier-ignore
        else if (br.kind === "m" && node !== br.g)
          others = deviceConducts(br, vAt) ? [br.a, br.b] : []; // prettier-ignore
        else if (br.kind === "j")
          others = Math.abs(junctionCurrent(br, vAt(br.a) - vAt(br.b))) > CONDUCTS_A ? [br.a === node ? br.b : br.a] : []; // prettier-ignore
        else if (ANALOG_KINDS.has(br.kind))
          others = analogHeldThrough(br, node, vAt);
        else continue;
        for (const other of others) {
          if (held.has(other)) continue;
          held.add(other);
          stack.push(other);
        }
      }
    }
    nw.held = held;
    return nw;
  }

  /** Whether a cluster is one net with nothing but drivers on it — a 74LS
      splitter from it to a rail, reading inputs on other nets, being one
      more (`splitterStage`). */
  const isLone = (cl) =>
    cl.nets.length === 1 &&
    !cl.resistors.length &&
    !cl.junctions.length &&
    !cl.channels.length &&
    cl.devices.every(
      (dev) =>
        dev.kind === "t" &&
        topo.rails.has(dev.gnd) &&
        !dev.ins.includes(cl.nets[0]),
    ) && // prettier-ignore
    !cl.loads.length &&
    !cl.inductors.length &&
    !cl.offChips.length;

  /** A lone net's 74LS splitter (a "t" device, spice/network.js) as the
      one-way sink it is there — its inputs on other nets, solved first, so
      its current hangs on this net's voltage alone — or null while its
      output is not HIGH, or its inputs lift nothing. */
  function splitterStage(dev, p) {
    const chip = p.chips.get(dev.comp);
    if (!chip?.drives || used.get(dev.comp)?.get(dev.outPin) !== H) return null;
    const gnd = p.railVolts.get(dev.gnd) ?? 0;
    let low = Number.POSITIVE_INFINITY;
    for (const net of dev.ins) low = Math.min(low, gateVolts(net, p));
    const amps = splitterAmps(low - gnd, SPLITTER_SAT_V);
    if (!(amps > 0)) return null;
    return { volts: gnd, ohms: SPLITTER_SAT_V / amps, limit: amps, sources: false, channel: false, corners: [[0, 0], [SPLITTER_SAT_V, amps]] }; // prettier-ignore
  }

  /** One lone net's stages (its outputs', its splitters' and its 74LS
      inputs' own). */
  function loneStages(net, p) {
    const outs = [];
    for (const d of topo.drivers.get(net) ?? []) {
      const st = stageAt(d, p);
      if (st) outs.push({ stage: st, d });
    }
    const stages = outs.map((o) => o.stage);
    const splits = [];
    if (outs.length) {
      for (const dev of topo.clusters[topo.clusterOf.get(net)].devices) {
        const stage = splitterStage(dev, p);
        if (stage) splits.push({ stage, dev });
      }
      stages.push(...splits.map((x) => x.stage));
      for (const r of topo.readers.get(net) ?? []) {
        const chip = p.chips.get(r.comp);
        if (chip?.ok) stages.push(...chip.inputsFor(r.pin));
      }
    }
    return { outs, stages, splits };
  }

  /** Solve one cluster; returns its nets. */
  function solveCluster(k) {
    const cl = topo.clusters[k];
    own.stale().add(k);
    own.setStale().add(k);
    if (stats) stats.clusterSolves = (stats.clusterSolves ?? 0) + 1;
    if (isLone(cl)) {
      const net = cl.nets[0];
      const f = fixedOf(net);
      if (f != null) {
        settleNet(net, f);
        return cl.nets;
      }
      const { stages } = loneStages(net, plan);
      // From the first output's own level, never from where the net last
      // stood: the stages may balance over a whole range — a 74LS HIGH's
      // 4.51 V and a CMOS input's clamp, which carries nothing from there to
      // its VDD + 0.5 V — and the answer must be the same however the net
      // got there (a carried solve and a fresh one alike).
      settleNet(net, stages.length ? solveDrivers(stages, stages[0].volts) : null); // prettier-ignore
      return cl.nets;
    }
    const first = guessed;
    let nw = network(k, first ? { guess: { get: (node) => first.get(node) ?? volts.get(node) } } : {}); // prettier-ignore
    // Out of balance: solved once more from where it stopped — a stall from
    // one start (a P-MOSFET's gate off a CMOS HIGH, read from 1 V) is a
    // step or two from the answer from the next, and published it stood
    // until something else ticked the desk. Still out, it is said so
    // (`unsettled`), and the tick asks to be woken soon (`newlyUnsettled`).
    if (!nw.balanced) {
      const again = network(k, { guess: nw.volts });
      if (again.balanced) nw = again;
    }
    if (nw.balanced) own.unsettled().delete(k);
    else {
      if (!unsettled.has(k)) newly = true;
      own.unsettled().add(k);
    }
    solvedAs.set(k, nw);
    for (const net of cl.nets) {
      const node = nw.nodeOf(net);
      const held = nw.held.has(node);
      settleNet(net, held ? (nw.fixed.get(node) ?? nw.volts.get(node)) : null); // prettier-ignore
      if (held || !nw.volts.has(node)) own.loose().delete(node);
      else own.loose().set(node, nw.volts.get(node));
    }
    return cl.nets;
  }

  /**
   * An RC node, linearized where it stands (`v0` volts) — for spice/engine.js
   * to run its curve along: `{driven}` when a source or a closed transistor
   * holds it outright; else the current its network pushes into it there
   * (`amps`, its capacitors open), how fast that falls as it rises
   * (`siemens`), and the voltages ahead of it where that slope changes
   * (`kinks`: a stage's open-circuit level, its chords' ends and where it saturates, a
   * junction's knee against a fixed far side) — where the curve must be
   * linearized again. Null for a net no cluster holds (a rail).
   * @param {string} net
   * @param {number} v0
   */
  function linearize(net, v0) {
    const k = topo?.clusterOf.get(net);
    if (k == null) return null;
    // Its network's shape, unsolved: what holds it, its branches, drivers
    // and fixed nets are known before anything is solved — and the free
    // solve that read them was one of every seven an op-amp oscillator's
    // tick made (the fourth regrade, 2026-10-22).
    const free = networkShape(k, { free: net });
    if (free.driven != null) return { driven: free.driven };
    const node = free.nodeOf(net);
    let solveAt = pinnedAt(k, net);
    const at = (v) => currentInto(node, solveAt(v));
    let amps = at(v0);
    // The slope of the segment the node is heading into.
    let dv = amps < 0 ? -LINEARIZE_V : LINEARIZE_V;
    const ahead = solveAt(v0 + dv);
    // An op-amp with positive feedback (a Schmitt trigger, a relaxation
    // oscillator's) whose output a nudge ahead stands on the far side of its
    // swing: the node stands at its threshold, and the swing happens HERE —
    // its old balance gone the moment the node moves on. Read across it, the
    // slope was the swing over a millivolt: a balance a fraction of a
    // millivolt ahead, microseconds away, that the node then sat on for good
    // (the regrade, 2026-10-22: an LM358 relaxation oscillator stopped after
    // two crossings). The cluster takes the far side now (`adoptSwing`), and
    // the node is read from there.
    if (swungAcross(solveAt(v0), ahead)) {
      adoptSwing(k, network(k, { free: net, pin: { net, volts: v0 }, guess: voltsOf(ahead) })); // prettier-ignore
      solveAt = pinnedAt(k, net);
      amps = at(v0);
      dv = amps < 0 ? -LINEARIZE_V : LINEARIZE_V;
    }
    const siemens = (amps - at(v0 + dv)) / dv;
    const kinks = [];
    // An op-amp's linear region is a fraction of a millivolt wide at its
    // inputs (its gain): the node can cross the whole of it inside the
    // nudge, and the search below starts past the nudge. A corner there —
    // the output reaching its swing's edge — is found inside it (the
    // regrade, 2026-10-22: a comparator on a capacitor stood mid-swing from
    // its crossing to the next unrelated event, its LED lit). So is a
    // supply on its limit's: a hundredth of an ohm puts its constant-voltage
    // piece a millivolt deep at its limit, and a capacitor across it fell
    // through that inside the nudge, its corner unseen, and stood there at
    // the set voltage, overloaded, for good.
    if (free.branches.some((br) => br.kind === "a" || br.kind === "p")) {
      const near = v0 + dv * 1e-3;
      const start = pieces(solveAt(near));
      if (pieces(solveAt(v0 + dv)) !== start) {
        let lo = near;
        let hi = v0 + dv;
        for (let i = 0; i < 48 && Math.abs(hi - lo) > 1e-9; i++) {
          const mid = (lo + hi) / 2;
          if (pieces(solveAt(mid)) === start) lo = mid;
          else hi = mid;
        }
        kinks.push(hi);
      }
    }
    for (const st of free.drivers.get(node) ?? [])
      kinks.push(...stageKinks(st));
    for (const br of free.touching.get(node) ?? []) {
      if (br.kind !== "j") continue;
      const other = br.a === node ? br.b : br.a;
      const far = free.fixed.get(other);
      if (far == null) continue;
      // Every sample of its curve (spice/junction-table.js) is a corner —
      // anode on the node: at far + v; cathode: at far − v.
      for (const v of br.spec.table.v) kinks.push(br.a === node ? far + v : far - v); // prettier-ignore
      if (br.diode && br.spec.zenerV > 0) {
        kinks.push(br.a === node ? far - br.spec.zenerV : far + br.spec.zenerV);
      }
    }
    // A corner further off in its network — a protection diode a resistor
    // away, a stage on the far side of one — is where the network's pieces
    // change as the node moves: searched toward where it is headed, as far
    // as its own nearest corner (or where it would settle).
    if (free.unknown.length > 1 || free.branches.some(isDevice)) {
      // prettier-ignore
      const dir = amps < 0 ? -1 : 1;
      let end = siemens > 1e-8 ? v0 + amps / siemens : v0 + dir * (plan.vHigh + 1); // prettier-ignore
      for (const kv of kinks) if ((kv - v0) * dir > 0 && (kv - end) * dir < 0) end = kv; // prettier-ignore
      const corner = farCorner(k, net, v0 + dir * LINEARIZE_V, end, solveAt);
      if (corner != null) kinks.push(corner);
    }
    return { driven: null, amps, siemens, kinks };
  }

  /** Did an op-amp's output change sides of its swing between two solves
      of one cluster — past half of it, from one edge toward the other? */
  function swungAcross(a, b) {
    for (const br of a.branches) {
      if (br.kind !== "a" || br.off) continue;
      const vA = (nw, n) => nw.fixed.get(n) ?? nw.volts.get(n) ?? 0;
      const lo = vA(a, br.gnd) + br.amp.lowV;
      const hi = vA(a, br.vcc) - br.amp.headroomV;
      if (!(hi > lo)) continue;
      if (Math.abs(vA(b, br.out) - vA(a, br.out)) > (hi - lo) / 2) return true;
    }
    return false;
  }

  /** A solved network's voltages by net, as a solve's guess takes them. */
  function voltsOf(nw) {
    const out = new Map();
    for (const net of nw.cl.nets) {
      const node = nw.nodeOf(net);
      const v = nw.fixed.get(node) ?? nw.volts.get(node);
      if (v != null) out.set(net, v);
    }
    return out;
  }

  /** A cluster's nets take `nw` (solved where they stand, from a guess on
      the far side of an op-amp's swing): the state the next solve starts
      from, as `solveCluster` leaves one. */
  function adoptSwing(k, nw) {
    if (!nw.balanced) return;
    own.stale().add(k);
    own.setStale().add(k);
    solvedAs.set(k, nw);
    for (const net of topo.clusters[k].nets) {
      const node = nw.nodeOf(net);
      const held = nw.held.has(node);
      settleNet(net, held ? (nw.fixed.get(node) ?? nw.volts.get(node)) : null); // prettier-ignore
      if (held || !nw.volts.has(node)) own.loose().delete(node);
      else own.loose().set(node, nw.volts.get(node));
    }
  }

  /** The voltage a source holds an RC node at outright (a bench source, a
      switch closed onto a rail), or null where none does — a node free to
      run along its capacitors' charge. Read off the network's SHAPE: what
      holds a node outright (a rail, a source, a 0-Ω union) is known before
      anything is solved — solving the network to ask was half the time of
      a rectifier's tick, asked of every node at every corner. */
  function heldAt(net) {
    const k = topo?.clusterOf.get(net);
    if (k == null) return null;
    // With no channel on in its cluster nothing joins it to anything at
    // 0 Ω, and only a source ON it holds it — what the shape would say,
    // without building one (asked of every node at every corner).
    const cl = topo.clusters[k];
    if (!cl.channels.some((ch) => channelOn.get(ch.key) === H)) return fixedOf(net, true); // prettier-ignore
    return networkShape(k, { free: net }).driven;
  }

  /** Every transistor an inductor's network has driven into breakdown
      (spice/params.js BREAKDOWN), as the solve stands: `[{comp, volts,
      amps, cluster}]` — `volts` across it the way it blocks. */
  function kicks() {
    const out = [];
    for (const [k, cl] of topo?.clusters.entries() ?? []) {
      if (!cl.inductors.length || !cl.devices.length) continue;
      const nw = network(k);
      const vAt = (n) => nw.fixed.get(n) ?? nw.volts.get(n) ?? 0;
      for (const br of nw.branches) {
        let v = null;
        let limit = null;
        if (br.kind === "q") {
          v = (br.pnp ? -1 : 1) * (vAt(br.c) - vAt(br.e));
          limit = br.model.vceoV;
        } else if (br.kind === "m" && !br.array) {
          v = br.p ? vAt(br.a) - vAt(br.b) : vAt(br.b) - vAt(br.a);
          limit = br.model.vbrV;
        }
        if (!(v != null && v > limit)) continue;
        // What its package absorbs in one kick (KICK_LIMITS), by its case.
        const c = plan?.chips.get(br.comp)?.c;
        const pkg = transistorCase(c?.def, c?.comp.params);
        const energy = KICK_LIMITS[br.kind === "q" && pkg === "TO-92" ? "bjt" : pkg] ?? null; // prettier-ignore
        out.push({ comp: br.comp, volts: v, amps: (v - limit) / BREAKDOWN_OHMS, cluster: k, energy }); // prettier-ignore
      }
    }
    return out;
  }

  /** The currents the networks push into RC nodes `nets` with every RC
      node where `at` has it and every inductor at `amps` (their capacitors
      open), amps — what a lone capacitor's plates are balanced by
      (spice/engine.js `runGroup`). */
  function currentsAt(nets, at, amps = coilAmps) {
    const out = new Float64Array(nets.length);
    const byCluster = new Map();
    nets.forEach((net, i) => {
      const k = topo?.clusterOf.get(net);
      if (k == null) return;
      if (!byCluster.has(k)) byCluster.set(k, []);
      byCluster.get(k).push([net, i]);
    });
    for (const [k, list] of byCluster) {
      const nw = network(k, { nodes: at, amps, exact: true });
      for (const [net, i] of list) out[i] = currentInto(nw.nodeOf(net), nw);
    }
    return out;
  }

  /** Each cluster a group's states sit in, and which of them: RC nodes by
      their place in `free`, inductors by theirs in `coils` (an inductor
      across two rails is in none). */
  function statesByCluster(free, coils) {
    const byCluster = new Map();
    const place = (k, kind, i) => {
      if (k == null) return;
      if (!byCluster.has(k)) byCluster.set(k, { nodes: [], coils: [] });
      byCluster.get(k)[kind].push(i);
    };
    free.forEach((net, i) => place(topo?.clusterOf.get(net), "nodes", i));
    coils.forEach((l, j) => place(topo?.clusterOf.get(l.a) ?? topo?.clusterOf.get(l.b), "coils", j)); // prettier-ignore
    return byCluster;
  }

  /** A cluster's network with its states (`own`) moved TOGETHER, each the way
      it heads in proportion to how fast it goes, the fastest a nudge — the
      pieces they enter as one (`linearizeGroup`'s `entered`) — or null for a
      lone state or a group at rest. */
  function jointNetwork(
    k,
    own,
    free,
    coils,
    at,
    amps,
    dirs,
    rates,
    guess,
    alone = false,
  ) {
    // prettier-ignore
    if (!alone && own.nodes.length + own.coils.length < 2) return null;
    const rate = (key) => {
      const r = rates?.get(key);
      return Number.isFinite(r) && r !== 0 ? r : (dirs?.get(key) ?? 0);
    };
    let fastV = 0;
    for (const i of own.nodes) fastV = Math.max(fastV, Math.abs(rate(free[i]))); // prettier-ignore
    let fastI = 0;
    for (const j of own.coils) fastI = Math.max(fastI, Math.abs(rate(coils[j].id))); // prettier-ignore
    if (!(fastV > 0) && !(fastI > 0)) return null;
    const nodes = new Map(at);
    const flows = new Map(amps);
    for (const i of own.nodes) {
      const r = rate(free[i]);
      if (r) nodes.set(free[i], (at.get(free[i]) ?? 0) + (LINEARIZE_V * r) / fastV); // prettier-ignore
    }
    for (const j of own.coils) {
      const r = rate(coils[j].id);
      const i0 = amps.get(coils[j].id) ?? 0;
      if (r) flows.set(coils[j].id, i0 + (Math.max(LINEARIZE_I, Math.abs(i0) * 1e-6) * r) / fastI); // prettier-ignore
    }
    return network(k, { nodes, amps: flows, exact: true, ...(guess ? { guess } : {}) }); // prettier-ignore
  }

  /**
   * A group's clusters with an op-amp in them, solved where their states
   * stand and a nudge on the way they head (`jointNetwork`): an output that
   * swings across between the two is a Schmitt trigger at its threshold, and
   * the swing is taken now (`adoptSwing`), as `linearize` takes a lone
   * node's. The group's model is read across it either way, so its states
   * ran on as if it had swung — but nothing kept the swing: a triangle
   * generator's square output, solved at the next frame from where it
   * stood, sat inside its band on the side it had left, and every frame
   * showed it LOW while its triangle turned (the regrade, 2026-10-22).
   */
  function adoptGroupSwing(free, coils, at, amps, dirs, rates) {
    for (const [k, own] of statesByCluster(free, coils)) {
      if (!fedBack(topo.clusters[k])) continue;
      const base = network(k, { nodes: at, amps, exact: true });
      // Swung already where the states stand (the corner reached), from
      // where the last solve left it…
      if (
        swungAcross({ branches: base.branches, fixed: base.fixed, volts }, base)
      ) {
        // prettier-ignore
        adoptSwing(k, base);
        continue;
      }
      // …or a nudge on.
      const ahead = jointNetwork(k, own, free, coils, at, amps, dirs, rates, base.volts, true); // prettier-ignore
      if (ahead && swungAcross(base, ahead)) {
        adoptSwing(k, network(k, { nodes: at, amps, exact: true, guess: voltsOf(ahead) })); // prettier-ignore
      }
    }
  }

  /**
   * Whether an op-amp in cluster `cl` can swing of itself: its output
   * reaching its own + input — through the cluster's resistors, junctions,
   * channels and loads, or another op-amp's inputs to its output, never
   * through a rail. A follower, an amplifier, a comparator on a divider are
   * no such thing, and a group of theirs is read without looking for a
   * swing (`adoptGroupSwing`'s two solves were a fifth of a 1 kHz sine's
   * follower's tick).
   */
  function fedBack(cl) {
    let yes = FED_BACK.get(cl);
    if (yes !== undefined) return yes;
    yes = false;
    const amps = cl.devices.filter((dev) => dev.kind === "a");
    if (amps.length) {
      const next = new Map();
      const link = (a, b) => {
        if (!next.has(a)) next.set(a, []);
        next.get(a).push(b);
      };
      for (const r of cl.resistors) (link(r.a, r.b), link(r.b, r.a));
      for (const j of cl.junctions) link(j.anode, j.cathode), link(j.cathode, j.anode); // prettier-ignore
      for (const ch of cl.channels) (link(ch.a, ch.b), link(ch.b, ch.a));
      for (const l of cl.loads) (link(l.a, l.b), link(l.b, l.a));
      for (const dev of amps) (link(dev.inp, dev.out), link(dev.inn, dev.out));
      for (const dev of amps) {
        const seen = new Set([dev.out]);
        const stack = [dev.out];
        while (stack.length && !yes) {
          const net = stack.pop();
          for (const to of next.get(net) ?? []) {
            if (to === dev.inp) yes = true;
            if (seen.has(to) || topo.rails.has(to)) continue;
            seen.add(to);
            stack.push(to);
          }
        }
        if (yes) break;
      }
    }
    FED_BACK.set(cl, yes);
    return yes;
  }

  /** What a group's linearization would be read on, without reading it: the
      pieces its states enter together in each of its clusters
      (`jointNetwork`) — or null where one of them has a lone state or is at
      rest, whose read is its own (spice/engine.js keeps the linearization a
      group was read on under this, and reads it again only for pieces it
      has not seen). */
  function groupKey(free, coils, at, amps, dirs, rates) {
    let key = "";
    for (const [k, own] of statesByCluster(free, coils)) {
      const joint = jointNetwork(k, own, free, coils, at, amps, dirs, rates, null); // prettier-ignore
      if (!joint) return null;
      key += `${k}:${pieces(joint)}/`;
    }
    return key;
  }

  /**
   * The STATES that move together (spice/dynamics.js) — RC nodes `free`,
   * none held by a source, and inductors `coils` (spice/inductors.js) —
   * linearized together where `at` (net → volts, every RC node) and `amps`
   * (inductor → amps) have them. For each RC node, the current its network
   * pushes into it; for each inductor, its winding's own equation, V(1) −
   * V(2) − R·i: together g(s) = i0 − Y·s over s = [v…, i…] (Y read off the
   * solve, each state nudged in turn the way `dirs` says, as `affine`
   * nudges them). And `piecesAt(s)`, the networks' pieces (spice/network.js
   * `pieces`) with the states at `s` — every other net carried along the
   * same affine map, exact until a piece changes, which is what it is asked
   * to tell. A node no network holds draws nothing but the solve's own GMIN.
   * `linear` says no network has pieces at all, so `piecesAt` never changes.
   * A state in `sources` (a running wave, spice/waves.js) moves by its own
   * generator: what its network draws from it is read by nothing, so the
   * stages hanging on it (a 74LS input's knee) are no corner — counted, a
   * wave into four inputs woke the desk three times a period for nothing.
   * @param {string[]} free
   * @param {Array<{id: string, a: string, b: string, ohms: number}>} coils
   * @param {Map<string, number>} at
   * @param {Map<string, number>} amps
   * @param {Map<string, number>} [dirs] - net or inductor id → ±1
   * @param {Iterable<string>} [sources] - states that are sources
   * @param {Map<string, number>} [rates] - net or inductor id → how fast it
   *   is moving (where it heads TOGETHER with the others: `entered`)
   * @param {boolean} [exact] - read where the states enter pieces together
   *   off the network's own slopes (`tangent`); false, every state by its
   *   own secant — a group sliding along a corner (spice/engine.js)
   * @param {boolean} [here] - read off the slopes where the states stand,
   *   on the pieces they stand on (no joint nudge): a group a corner has
   *   just carried a hair past an edge, the pieces it enters known
   *   (spice/engine.js `runGroup`'s `known`)
   */
  function linearizeGroup(
    free,
    coils,
    at,
    amps,
    dirs,
    sources = [],
    rates = null,
    exact = true,
    here = false,
  ) {
    const nc = free.length;
    const n = nc + coils.length;
    const y = Array.from({ length: n }, () => new Float64Array(n));
    const g = new Float64Array(n);
    const s0 = new Float64Array(n);
    free.forEach((net, i) => (s0[i] = at.get(net) ?? 0));
    coils.forEach((l, j) => (s0[nc + j] = amps.get(l.id) ?? 0));
    // Each state's cluster (an inductor's: its network's, or none across two
    // rails).
    const byCluster = new Map();
    const place = (k, kind, i) => {
      if (k == null) return;
      if (!byCluster.has(k)) byCluster.set(k, { nodes: [], coils: [] });
      byCluster.get(k)[kind].push(i);
    };
    free.forEach((net, i) => place(topo?.clusterOf.get(net), "nodes", i));
    coils.forEach((l, j) => {
      const k = topo?.clusterOf.get(l.a) ?? topo?.clusterOf.get(l.b);
      if (k == null) {
        // Across two rails: its voltage is theirs, whatever it carries.
        const rail = (net) => plan?.railVolts.get(net) ?? 0;
        g[nc + j] = rail(l.a) - rail(l.b) - l.ohms * s0[nc + j];
        y[nc + j][nc + j] = l.ohms;
      } else place(k, "coils", j);
    });
    const models = [];
    let pure = true;
    const read = (nw, id) => nw.fixed.get(id) ?? nw.volts.get(id) ?? 0;
    /** Cluster `k`'s states (`own`) linearized at the solved network `at0`
        (inside the pieces they enter) off its Jacobian: the unknowns'
        sensitivities du/ds = −J⁻¹·∂F/∂s, and each state's current (or a
        coil's winding voltage) differentiated through them. */
    const tangent = (k, own, at0) => {
      const states = [...own.nodes, ...own.coils.map((j) => nc + j)];
      const stateNode = (i) => (i < nc ? at0.nodeOf(free[i]) : null);
      // The states as they stand there.
      for (const i of own.nodes) s0[i] = read(at0, stateNode(i));
      for (const j of own.coils) {
        const br = at0.branches.find((b) => b.kind === "l" && b.key === coils[j].id); // prettier-ignore
        if (br) s0[nc + j] = br.amps;
      }
      const unknown = at0.nodes;
      const m = unknown.length;
      const index = new Map(unknown.map((u, r) => [u, r]));
      const rows = new Map();
      const slopesAt = (node) => {
        let sl = rows.get(node);
        if (!sl) rows.set(node, (sl = networkSlopes(at0, node)));
        return sl;
      };
      const byState = (sl, i) => (i < nc ? (sl.nodes.get(stateNode(i)) ?? 0) : (sl.coils.get(coils[i - nc].id) ?? 0)); // prettier-ignore
      const jac = unknown.map((u, r) => {
        const row = new Float64Array(m);
        for (const [t, d] of slopesAt(u).nodes) {
          const c = index.get(t);
          if (c != null) row[c] += d;
        }
        row[r] -= GMIN_S;
        return row;
      });
      const du = new Map();
      for (const i of states) {
        const rhs = unknown.map((u) => -byState(slopesAt(u), i));
        du.set(i, (m && gaussSolve(jac.map((row) => Float64Array.from(row)), rhs)) || new Array(m).fill(0)); // prettier-ignore
      }
      const dV = (node, i) => {
        const r = index.get(node);
        if (r != null) return du.get(i)[r];
        return i < nc && node === stateNode(i) ? 1 : 0;
      };
      const vals = [];
      for (const i of own.nodes) vals.push([i, currentInto(stateNode(i), at0)]); // prettier-ignore
      for (const j of own.coils) {
        const l = coils[j];
        vals.push([nc + j, read(at0, at0.nodeOf(l.a)) - read(at0, at0.nodeOf(l.b))]); // prettier-ignore
      }
      for (const [r, v] of vals) g[r] = v;
      for (const j of own.coils) g[nc + j] -= coils[j].ohms * s0[nc + j];
      for (const r of states) {
        for (const i of states) {
          let d;
          if (r < nc) {
            const sl = slopesAt(stateNode(r));
            d = byState(sl, i);
            const dui = du.get(i);
            for (const [t, gs] of sl.nodes) {
              const c = index.get(t);
              if (c != null) d += gs * dui[c];
            }
          } else {
            const l = coils[r - nc];
            d = dV(at0.nodeOf(l.a), i) - dV(at0.nodeOf(l.b), i);
          }
          y[r][i] = -d;
        }
      }
      for (const j of own.coils) y[nc + j][nc + j] += coils[j].ohms;
      const ids = [...new Set([...at0.fixed.keys(), ...at0.volts.keys()])];
      const volts0 = new Map(ids.map((id) => [id, read(at0, id)]));
      const sens = new Map(ids.map((id) => {
        const row = new Float64Array(n);
        for (const i of states) row[i] = dV(id, i);
        return [id, row];
      })); // prettier-ignore
      const fromSource = new Set([...sources].map((net) => at0.nodeOf(net)));
      const drivers = fromSource.size
        ? new Map([...at0.drivers].filter(([node]) => !fromSource.has(node)))
        : at0.drivers;
      models.push({ base: at0, drivers, ids, volts0, sens });
    };
    for (const [k, own] of byCluster) {
      // (Not where an op-amp is: its solve reads which edge of its swing it
      // CAME in at, and that is where the side stands, not a corner ago.)
      const cl = topo.clusters[k];
      const resume = !cl.devices.some((dev) => dev.kind === "a");
      const base = network(k, { nodes: at, amps, exact: true, guess: (resume && linearizedAt.get(cl)) || volts }); // prettier-ignore
      if (resume && base.balanced) linearizedAt.set(cl, base.volts);
      // A transistor (its Gummel–Poon or square law) or an optocoupler's
      // transfer is curved within its pieces: its slopes are the point's,
      // not the piece's, and no read of them is kept.
      const curved = base.branches.some((br) => CURVED_KINDS.has(br.kind));
      if (curved) pure = false;
      const out = (nw) => {
        const vals = [];
        for (const i of own.nodes) vals.push([i, currentInto(nw.nodeOf(free[i]), nw)]); // prettier-ignore
        for (const j of own.coils) {
          const l = coils[j];
          vals.push([nc + j, read(nw, nw.nodeOf(l.a)) - read(nw, nw.nodeOf(l.b))]); // prettier-ignore
        }
        return vals;
      };
      const g0 = out(base);
      for (const [i, v] of g0) g[i] = v;
      for (const j of own.coils) g[nc + j] -= coils[j].ohms * s0[nc + j];
      const ids = [...new Set([...base.fixed.keys(), ...base.volts.keys()])];
      const volts0 = new Map(ids.map((id) => [id, read(base, id)]));
      const sens = new Map(ids.map((id) => [id, new Float64Array(n)]));
      const states = [...own.nodes, ...own.coils.map((j) => nc + j)];
      const coilDv = (j, up) => (up ? 1 : -1) * Math.max(LINEARIZE_I, Math.abs(s0[nc + j]) * 1e-6); // prettier-ignore
      // The pieces the states carry the network into TOGETHER, each the way
      // it heads (`entered`): a state whose own nudge lands further from
      // them than the other way's (fewer branches in the same piece) is read
      // the other way. Each read alone the way it heads, a regulator's OUT
      // tracking its target within microvolts read the regulator OFF while
      // its moving IN read it ON — a model no piece holds (OUT driven by IN
      // with nothing to stop it, or OUT's capacitor charged from nowhere),
      // whose corner the pieces never showed: OUT ran on to kilovolts. A
      // lone state's own nudge IS the joint one, so it reads as it always
      // did.
      const secants = base.branches.some((br) => SECANT_KINDS.has(br.kind));
      if (here && exact && !secants) {
        tangent(k, own, base);
        continue;
      }
      const joint = jointNetwork(k, own, free, coils, at, amps, dirs, rates, base.volts); // prettier-ignore
      const entered = joint && pieces(joint);
      // Where the states enter pieces together, every element there a
      // straight line, the linearization is read off the network's own
      // slopes at a point INSIDE those pieces — where they already stand, or
      // the joint nudge's point at a corner — exactly (`tangent`), in one
      // solve per state of a small linear system where the secants took a
      // full network solve each, and read the solve's tolerance with it.
      if (exact && joint && !secants) {
        tangent(k, own, entered === pieces(base) ? base : joint);
        continue;
      }
      // Read from a corner, a state's secant spans what is left of the old
      // piece between it and the corner (a bisection's worth): exact only
      // for the moment, so no such read is kept — only one taken inside the
      // pieces it is of.
      if (entered !== pieces(base)) pure = false;
      for (const i of states) {
        const coil = i >= nc ? coils[i - nc] : null;
        const key = coil ? coil.id : free[i];
        const up = (dirs?.get(key) ?? 1) >= 0;
        let nw;
        let dv;
        if (coil) {
          dv = coilDv(i - nc, up);
          const nudged = new Map(amps);
          nudged.set(coil.id, s0[i] + dv);
          nw = network(k, { nodes: at, amps: nudged, exact: true, guess: base.volts }); // prettier-ignore
        } else {
          const read = (step) => {
            const nudged = new Map(at);
            nudged.set(free[i], s0[i] + step);
            return network(k, { nodes: nudged, amps, exact: true, guess: base.volts }); // prettier-ignore
          };
          dv = up ? LINEARIZE_V : -LINEARIZE_V;
          nw = read(dv);
          if (entered != null && pieces(nw) !== entered) {
            const other = read(-dv);
            const along = pieceList(joint);
            if (
              sharedPieces(pieceList(other), along) >
              sharedPieces(pieceList(nw), along)
            ) {
              nw = other;
              dv = -dv;
            }
          }
          // A nudge that crossed a corner its state does not stand on reads
          // a slope no piece has — half the network on one side of it, half
          // on the other. A lightly loaded regulator's OUT stands 1.7 µV
          // short of where it stops sourcing (its 0.01 Ω times 0.17 mA):
          // nudged a millivolt, OUT read it off while GND read it on, OUT
          // was held still as GND swung, and the few millivolts it ended
          // off its target were amps through 0.01 Ω — "running hot, 15 W" —
          // and a corner it flipped across every few nanoseconds. So a
          // nudge that leaves the base's pieces (and is not the joint
          // nudge's) is read again a thousandth as far: still across, the
          // state stands ON the corner and enters that piece (kept); back
          // in the base's pieces, the corner lay between, and the short
          // read is the slope of the piece it stands in.
          const base0 = pieces(base);
          let crossed = pieces(nw);
          for (
            let shrink = 0;
            shrink < SECANT_SHRINKS && crossed !== base0 && crossed !== entered;
            shrink++
          ) {
            // prettier-ignore
            const short = read(dv * SECANT_SHRINK);
            const there = pieces(short);
            if (there === crossed) break;
            nw = short;
            dv *= SECANT_SHRINK;
            crossed = there;
          }
        }
        // Every state read on the pieces they enter together: the model of
        // those pieces alone (`pure`) — what spice/engine.js may keep.
        if (entered == null || pieces(nw) !== entered) pure = false;
        for (const [r, v] of out(nw)) {
          const was = g0.find(([x]) => x === r)[1];
          y[r][i] = -(v - was) / dv;
        }
        for (const id of ids) sens.get(id)[i] = (read(nw, id) - volts0.get(id)) / dv; // prettier-ignore
      }
      for (const j of own.coils) y[nc + j][nc + j] += coils[j].ohms;
      const fromSource = new Set([...sources].map((net) => base.nodeOf(net)));
      const drivers = fromSource.size
        ? new Map([...base.drivers].filter(([node]) => !fromSource.has(node)))
        : base.drivers;
      models.push({ base, drivers, ids, volts0, sens });
    }
    for (let i = 0; i < nc; i++) y[i][i] += GMIN_S;
    // g = g(s0) − Y·(s − s0), so i0 = g(s0) + Y·s0.
    const i0 = Float64Array.from(g, (x, i) => {
      let sum = x;
      for (let j = 0; j < n; j++) sum += y[i][j] * s0[j];
      return sum;
    });
    // Each network at state `st`: its moving nodes (`ids`) carried along the
    // solve's affine map, overlaid on the network as solved — one scratch map
    // per network, reused every sample (features/11-pieces-scratch.md).
    // (Each network's moving nodes, their voltages and their sensitivities
    // as arrays, and the states' moves once per sample: a corner search
    // samples this a few dozen times at every corner.)
    const scratch = models.map(({ base, ids, volts0, sens }) => {
      const over = new Map();
      return {
        over,
        ids,
        v0: ids.map((id) => volts0.get(id)),
        sv: ids.map((id) => sens.get(id)),
        vAt: (node) => {
          const v = over.get(node);
          return v !== undefined ? v : (base.fixed.get(node) ?? base.volts.get(node) ?? 0); // prettier-ignore
        },
      };
    });
    const ds = new Float64Array(n);
    // Network `m`'s moving nodes where the states' moves (`ds`) put them.
    const carry = (m) => {
      const { over, ids, v0, sv } = scratch[m];
      for (let k = 0; k < ids.length; k++) {
        let x = v0[k];
        const row = sv[k];
        for (let j = 0; j < n; j++) x += row[j] * ds[j];
        over.set(ids[k], x);
      }
    };
    const piecesAt = (st) => {
      for (let j = 0; j < n; j++) ds[j] = st[j] - s0[j];
      let out = "";
      for (let m = 0; m < models.length; m++) {
        const { base, drivers } = models[m];
        const { vAt } = scratch[m];
        carry(m);
        out += `${piecesBy(drivers, base.branches, vAt)}|`;
      }
      return out;
    };
    const linear = !models.some(({ base, drivers }) =>
      hasPieces({ drivers, branches: base.branches }),
    );
    /**
     * The pieces the networks stand on at `st0`, as constraints carried
     * along the states (spice/network.js `pieceConstraints`): `margin(st)`,
     * how far inside every one of them the states at `st` stand — negative
     * once one is left, continuous, a sum per constraint — or null where a
     * network's pieces are no such thing. An element with no such
     * quantity (a Darlington, a MOSFET, an off-rail stage — network.js
     * `rest`) is watched by its piece: off it, the margin is −1 (a plain transistor saturated behind its base resistance by its distance inside it, `branchMargin`). Given the
     * states' `rates` (spice/dynamics.js `curveRates`), `clear()` straight
     * after a `margin` read says how long after that moment NO constraint
     * can be left: each one's distance over the most its quantity can move a
     * second from then on (Σ over the modes of |its rate along each|·e^(k·dt),
     * which never grows while no mode does) — the search steps over that
     * stretch without reading it. Null where a mode grows, or anything is
     * watched by its piece alone.
     * @param {Float64Array} st0
     * @param {{modes: number[][], rates: number[][], decay: Float64Array} | null} [rates]
     */
    const constraints = (st0, rates = null, at = null) => {
      const set = (at != null && keptConstraints.get(at)) || constraintSet(st0);
      if (at != null && !set.watched.length) keptConstraints.set(at, set);
      const { q0, lo, hi, along, watched, start } = set;
      const below = new Float64Array(q0.length);
      const above = new Float64Array(q0.length);
      const margin = (st) => {
        let least = Number.POSITIVE_INFINITY;
        for (let c = 0; c < q0.length; c++) {
          let q = q0[c];
          const g = along[c];
          for (let j = 0; j < n; j++) q += g[j] * (st[j] - start[j]);
          below[c] = q - lo[c];
          above[c] = hi[c] - q;
          const d = Math.min(below[c], above[c]);
          if (d < least) least = d;
        }
        if (!watched.length) return least;
        for (let j = 0; j < n; j++) ds[j] = st[j] - s0[j];
        for (const [m, rest, was] of watched) {
          carry(m);
          const { vAt } = scratch[m];
          for (let b = 0; b < rest.length; b++) {
            const w = was[b];
            if (typeof w === "function") least = Math.min(least, w(vAt));
            else if (branchPiece(rest[b], vAt) !== w) return -1;
          }
        }
        return least;
      };
      const clear = rates && !watched.length ? clearance(rates, along, below, above) : null; // prettier-ignore
      // The quantity furthest past its edges at `st` alone — by how far
      // inside them it stands, read anywhere: what a search closes on
      // once it has bracketed a corner (null where an element is watched).
      const past = (st) => {
        if (watched.length) return null;
        margin(st);
        let worst = -1;
        for (let c = 0; c < q0.length; c++) {
          if (worst < 0 || Math.min(below[c], above[c]) < Math.min(below[worst], above[worst])) worst = c; // prettier-ignore
        }
        if (worst < 0) return null;
        const g = along[worst];
        const up = above[worst] < below[worst];
        return (at) => {
          let q = q0[worst];
          for (let j = 0; j < n; j++) q += g[j] * (at[j] - start[j]);
          return up ? hi[worst] - q : q - lo[worst];
        };
      };
      return { margin, clear, past };
    };
    // Each set of pieces' constraints, kept by the pieces (`piecesAt`'s
    // statement) a caller says the states start on: every quantity is
    // straight in the states, so the set read from one start is the set
    // from any on those pieces — a group comes round the same few dozen
    // every cycle (spice/engine.js `groupCorner`). Not where an element is
    // watched by its piece (`rest`): what it was is the start's own.
    const keptConstraints = new Map();
    const constraintSet = (st0) => {
      piecesAt(st0); // every moving node where `st0` has it (`over`)
      const q0 = [];
      const lo = [];
      const hi = [];
      const along = [];
      const watched = []; // [model, branches, their pieces at st0]
      for (let m = 0; m < models.length; m++) {
        const { base, drivers } = models[m];
        const { ids, sv, vAt } = scratch[m];
        const { list, rest } = pieceConstraints(drivers, base.branches, vAt);
        // Each watched branch by its distance inside its piece where that
        // can be said (`branchMargin`), else by its piece.
        if (rest.length) watched.push([m, rest, rest.map((br) => branchMargin(br, vAt) ?? branchPiece(br, vAt))]); // prettier-ignore
        const place = new Map(ids.map((id, k) => [id, k]));
        for (const c of list) {
          let q = c.k;
          const g = new Float64Array(n);
          for (const [node, coef] of c.terms) {
            q += coef * vAt(node);
            const k = place.get(node);
            if (k == null) continue;
            const row = sv[k];
            for (let j = 0; j < n; j++) g[j] += coef * row[j];
          }
          q0.push(q);
          lo.push(c.lo);
          hi.push(c.hi);
          along.push(g);
        }
      }
      return { q0, lo, hi, along, watched, start: Float64Array.from(st0) };
    };
    // The pieces it was read on, as `piecesAt` states them — where the read
    // stood (`s0`), inside them: what a group arriving at a corner along
    // another read's curves finds it under (spice/engine.js `runGroup`).
    let own = null;
    const entered = () => (own ??= piecesAt(s0));
    // Whether an op-amp stands on another piece at `b` than at `a`.
    const ampPieces = (st) => {
      for (let j = 0; j < n; j++) ds[j] = st[j] - s0[j];
      let out = "";
      for (let m = 0; m < models.length; m++) {
        carry(m);
        for (const br of models[m].base.branches) {
          if (br.kind === "a") out += `${branchPiece(br, scratch[m].vAt)}|`;
        }
      }
      return out;
    };
    const swings = (a, b) => ampPieces(a) !== ampPieces(b);
    // A net of its networks as `affine` states it — `c0 + Σ coef·state`,
    // each RC node, wave or coil (`coil:<id>`) a term — off the read's own
    // map, exact on its pieces: no solve a state. Null for a net it does
    // not cover, or that its read held through nothing.
    const statement = (net) => {
      for (const { base, sens, volts0 } of models) {
        if (!base.cl.nets.includes(net)) continue;
        const node = base.nodeOf(net);
        const row = sens.get(node);
        if (!row || !base.held.has(node)) return null;
        let c0 = volts0.get(node);
        const terms = new Map();
        for (let i = 0; i < n; i++) {
          if (!(Math.abs(row[i]) > 1e-9)) continue;
          terms.set(i < nc ? free[i] : `coil:${coils[i - nc].id}`, row[i]);
          c0 -= row[i] * s0[i];
        }
        return { c0, terms };
      }
      return null;
    };
    // Every net of its networks where its map puts it with the states at
    // `st`, into `out` (net → volts).
    const voltsAt = (st, out) => {
      for (let j = 0; j < n; j++) ds[j] = st[j] - s0[j];
      for (let m = 0; m < models.length; m++) {
        carry(m);
        for (const [id, v] of scratch[m].over) out.set(id, v);
      }
      return out;
    };
    return { y, i0, piecesAt, constraints, linear, pure, entered, swings, statement, voltsAt }; // prettier-ignore
  }

  /** The first voltage between `from` and `to` of an RC node where anything
      in its network changes piece (spice/network.js `pieces`), by bisection —
      or null where nothing does. */
  /** The corner `farCorner` last found, by cluster, net, way and the
      pieces it was searched from — this tick's. */
  const cornerMemo = new Map();
  function farCorner(k, net, from, to, solveAt = pinnedAt(k, net)) {
    if (!(Math.abs(to - from) > LINEARIZE_V)) return null;
    const piecesAt = (v) => pieces(solveAt(v));
    const base = solveAt(from);
    const start = pieces(base);
    if (piecesAt(to) === start) return null;
    // On its pieces the network is straight in the node's voltage, and so
    // is every quantity they are decided by (`pieceConstraints`): the first
    // to leave its interval says where the corner is, from one solve more —
    // kept where the solves either side of it agree, a bisection's
    // precision apart. Searched by bisection alone, a corner took some
    // thirty solves, four a crossing: an LM358 relaxation oscillator at
    // 700 Hz ran at a third of true time (the regrade, 2026-10-22).
    // (Else it still bounds the search: an op-amp's corner is rounded, and
    // its own falls a millivolt or two short of the straight one.) And the
    // corner this tick last found from these pieces this way is tried
    // likewise: a node is linearized again at every corner and settle on
    // its way, and each time searched toward the same one.
    const dir = Math.sign(to - from);
    const memoKey = `${k}|${net}|${dir}|${start}`;
    let lo = from;
    let hi = to;
    // (Each guess made only when it is reached: the straight one costs a
    // solve, which a remembered corner that holds never needs.)
    for (const guessOf of [
      () => cornerMemo.get(memoKey),
      () => straightCorner(base, solveAt, from, to, start),
    ]) {
      const guess = guessOf();
      if (guess == null) continue;
      const before = guess - (dir * CORNER_V) / 2;
      const after = guess + (dir * CORNER_V) / 2;
      if (!((before - lo) * dir > 0 && (hi - after) * dir > 0)) continue;
      if (piecesAt(after) === start) lo = after;
      else if (piecesAt(before) === start) {
        cornerMemo.set(memoKey, guess);
        return after;
      } else hi = before;
    }
    for (let i = 0; i < 48 && Math.abs(hi - lo) > CORNER_V; i++) {
      const mid = (lo + hi) / 2;
      if (piecesAt(mid) === start) lo = mid;
      else hi = mid;
    }
    cornerMemo.set(memoKey, hi - (dir * CORNER_V) / 2);
    return hi;
  }

  /** Where a pinned network solved at `from` (`base`, standing on pieces
      `start`) first leaves them on its way to `to`, read straight off its
      constraints' quantities a nudge apart — or null where some element is
      watched by its piece alone, or the nudge already changed a piece. */
  function straightCorner(base, solveAt, from, to, start) {
    const vAt = (nw) => (node) => nw.fixed.get(node) ?? nw.volts.get(node) ?? 0; // prettier-ignore
    const { list, rest } = pieceConstraints(base.drivers, base.branches, vAt(base)); // prettier-ignore
    if (rest.length || !list.length) return null;
    const dv = Math.sign(to - from) * LINEARIZE_V;
    const next = solveAt(from + dv);
    if (pieces(next) !== start) return null;
    const qOf = (c, at) => c.terms.reduce((q, [node, coef]) => q + coef * at(node), c.k); // prettier-ignore
    const [at0, at1] = [vAt(base), vAt(next)];
    let least = Number.POSITIVE_INFINITY;
    for (const c of list) {
      const q = qOf(c, at0);
      const rate = (qOf(c, at1) - q) / LINEARIZE_V;
      const room = rate > 0 ? c.hi - q : rate < 0 ? c.lo - q : Number.NaN;
      const steps = room / rate;
      if (steps >= 0 && steps < least) least = steps;
    }
    if (!(least > CORNER_V && least < Math.abs(to - from))) return null;
    return from + Math.sign(to - from) * least;
  }

  /**
   * How every net in `watch` follows the RC nodes in its network, as long as
   * that network stays on its present pieces (between corners it is linear):
   * net → `{c0, terms}`, V(net) = c0 + Σ coef · V(node) over `terms`' node →
   * coef — read off the solve with the nodes at `at` (net → volts) and with
   * each in turn a millivolt further the way it is heading (`dirs`, net →
   * ±1; up where it says nothing), so a node standing ON a corner is stated
   * by the piece it is entering. A net in no RC node's network answers its
   * voltage (`c0`, no terms); a net nothing holds, null. What
   * spice/engine.js times a reading off a node by, when the pin reads it
   * through a resistor or against a reference that moves with one.
   * An inductor in the network is a state too (spice/inductors.js): it is
   * nudged like a node, and its term is keyed `coil:<id>`.
   * @param {Iterable<string>} watch
   * @param {Map<string, number>} at
   * @param {Map<string, number>} [dirs]
   * @param {Map<string, number>} [amps] - inductor → amps
   */
  function affine(watch, at, dirs, amps = coilAmps) {
    const out = new Map();
    const byCluster = new Map();
    for (const net of watch) {
      const k = topo?.clusterOf.get(net);
      const nodesIn = k == null ? null : topo.clusters[k].nets.filter((n) => at.has(n)); // prettier-ignore
      if (
        !nodesIn?.length &&
        !(k != null && topo.clusters[k].inductors.length)
      ) {
        const v = voltOfNet(net);
        out.set(net, v == null ? null : { c0: v, terms: EMPTY });
        continue;
      }
      if (!byCluster.has(k)) byCluster.set(k, { nodesIn, nets: [] });
      byCluster.get(k).nets.push(net);
    }
    for (const [k, { nodesIn, nets }] of byCluster) {
      const read = (nw, net) => {
        const node = nw.nodeOf(net);
        if (!nw.held.has(node)) return null;
        return nw.fixed.get(node) ?? nw.volts.get(node) ?? null;
      };
      const base = network(k, { nodes: at, amps, exact: true });
      const v0 = new Map(nets.map((n) => [n, read(base, n)]));
      const terms = new Map(nets.map((n) => [n, new Map()]));
      const stateAt = new Map(); // term key → the state's value now
      const nudge = (key, dv, nw) => {
        for (const n of nets) {
          const v1 = read(nw, n);
          const coef = v0.get(n) == null || v1 == null ? 0 : (v1 - v0.get(n)) / dv; // prettier-ignore
          if (Math.abs(coef) > 1e-9) terms.get(n).set(key, coef);
        }
      };
      for (const m of nodesIn) {
        const dv = (dirs?.get(m) ?? 1) < 0 ? -LINEARIZE_V : LINEARIZE_V;
        const nudged = new Map(at);
        nudged.set(m, at.get(m) + dv);
        stateAt.set(m, at.get(m));
        nudge(m, dv, network(k, { nodes: nudged, amps, exact: true, guess: base.volts })); // prettier-ignore
      }
      for (const l of topo.clusters[k].inductors) {
        const key = `coil:${l.id}`;
        const i0 = amps.get(l.id) ?? 0;
        const di = ((dirs?.get(key) ?? 1) < 0 ? -1 : 1) * Math.max(LINEARIZE_I, Math.abs(i0) * 1e-6); // prettier-ignore
        const nudged = new Map(amps);
        nudged.set(l.id, i0 + di);
        stateAt.set(key, i0);
        nudge(key, di, network(k, { nodes: at, amps: nudged, exact: true, guess: base.volts })); // prettier-ignore
      }
      for (const n of nets) {
        if (v0.get(n) == null) {
          out.set(n, null);
          continue;
        }
        let c0 = v0.get(n);
        for (const [m, coef] of terms.get(n)) c0 -= coef * stateAt.get(m);
        out.set(n, { c0, terms: terms.get(n) });
      }
    }
    return out;
  }

  /** What one reader pin reads at `v` volts, given what it read before — an
      ordinary input through its family's band (spice/params.js
      `inputThresholds`, a Schmitt's hysteresis held), a comparator against
      its own trip points (`senseFor`: H above, L below, never the band; its
      reading held between two different points — or, a window's two
      comparators, X between them). Null where a comparator's
      reference has no voltage. */
  function readingAt(chip, pin, v, before) {
    const sense = chip.senseFor(pin);
    // A chip off the rails reads against its own ground.
    const ground = chip.off ? (voltOfNet(chip.off.gndNet) ?? 0) : 0;
    if (!sense) return readingOf(chip.th, v - ground, before);
    let d = v - ground;
    if (sense.hasRef) {
      const ref = sense.ref == null ? null : voltOfNet(sense.ref);
      if (ref == null) return null;
      d = v - ref;
    }
    if (d >= sense.up) return H;
    if (d <= sense.down) return L;
    if (sense.window) return X;
    return before === H || before === L ? before : d >= (sense.up + sense.down) / 2 ? H : L; // prettier-ignore
  }

  /** A held net's (or a rail's) voltage, or null. */
  function voltOfNet(net) {
    if (plan?.railVolts.has(net)) return plan.railVolts.get(net);
    return auth.has(net) ? (volts.get(net) ?? null) : null;
  }

  /** The current, amps, an RC node's network pushes into it with the node
      held at `v` (its capacitors open), or null for a net no network holds. */
  function current(net, v) {
    const k = topo?.clusterOf.get(net);
    if (k == null) return null;
    const nw = network(k, { free: net, pin: { net, volts: v } });
    return currentInto(nw.nodeOf(net), nw);
  }

  /** Re-read every input on `net`; note who now reads something new. A
      reader spice/engine.js reads itself (`owned`: on or against an RC
      node's network, by its crossings) is left to it. */
  function readNet(net, v) {
    const list = topo.readers.get(net);
    if (!list || candidates.has(net)) return;
    const old = readings.get(net);
    if (v == null) {
      if (old) {
        own.readings().delete(net);
        for (const key of old.keys()) reread.add(compOfKey(key));
        moved = true;
      }
      unshow(net);
      return;
    }
    let next = null;
    let level = null;
    for (const r of list) {
      const key = readerKey(r.comp, r.pin);
      if (owned.has(key)) continue;
      const chip = plan.chips.get(r.comp);
      if (!chip?.ok) continue;
      if (next?.has(key)) continue;
      const reading = readingAt(chip, r.pin, v, old?.get(key));
      if (reading == null) continue;
      if (!next) next = new Map();
      next.set(key, reading);
      level = level == null || level === reading ? reading : X;
    }
    if (!next) {
      if (old) {
        own.readings().delete(net);
        for (const key of old.keys()) reread.add(compOfKey(key));
        moved = true;
      }
      unshow(net);
      return;
    }
    let changed = !old || old.size !== next.size;
    if (!changed) {
      for (const [key, reading] of next) {
        if (old.get(key) !== reading) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      own.readings().set(net, next);
      for (const [key, reading] of next) {
        if (old?.get(key) !== reading) reread.add(compOfKey(key));
      }
      for (const key of old?.keys() ?? []) if (!next.has(key)) reread.add(compOfKey(key)); // prettier-ignore
      moved = true;
    }
    if (shown.get(net) !== level) {
      own.shown().set(net, level);
      own.shownMoved().add(net);
    }
  }

  /** `net` shows nothing now. */
  function unshow(net) {
    if (!shown.has(net)) return;
    own.shown().delete(net);
    own.shownMoved().add(net);
  }

  /** The level a discrete transistor's base or gate reads (`selfControl`):
      its on-level while the solve has it conducting, the other while it has
      it off — or null where a net of it has no voltage. */
  function selfLevel(dev) {
    let known = true;
    const vAt = (net) => {
      const v = voltOfNet(net);
      if (v == null) known = false;
      return v ?? 0;
    };
    const on = deviceConducts(dev, vAt, true);
    if (!known) return null;
    const onLevel = (dev.kind === "q" ? dev.pnp : dev.p) ? L : H;
    return on ? onLevel : onLevel === H ? L : H;
  }

  /** Solve every cluster something moved in (all, after a change of power);
      returns the nets solved, each re-read. */
  function solveDirty() {
    // A self-controlled transistor whose reading the solve turns is read
    // again, as an input whose reading changed is.
    const selfWas = new Map();
    for (const [comp, dev] of topo.selfControlled) selfWas.set(comp, selfLevel(dev)); // prettier-ignore
    const nets = solveDirtyClusters();
    guessed = null;
    for (const [comp, dev] of topo.selfControlled) {
      if (selfLevel(dev) === selfWas.get(comp)) continue;
      reread.add(comp);
      moved = true;
    }
    return nets;
  }

  /** Record the RC nodes' volts and the coils' currents the networks were
      just solved with — what a node on a paused island is told it still
      stands at next tick (`nodeVoltUsed`), and what a move is judged
      against (`setNodes`, `setCoils`). After EVERY solve, a pass's or not:
      recorded by passes alone, a node a `resolve` had moved since was told
      its older value, which the carried settle took for no change while the
      full one solved its network again — the two parted (a mains brick's
      L, its island paused beside an AC adapter's, 2026-10-21).
      (Written only where they moved: a write copies the carried map.) */
  function noteUsed() {
    for (const [net, v] of rcVolts) if (!Object.is(fixedUsed.get(net), v) || !fixedUsed.has(net)) own.fixedUsed().set(net, v); // prettier-ignore
    for (const net of [...fixedUsed.keys()]) if (!rcVolts.has(net)) own.fixedUsed().delete(net); // prettier-ignore
    for (const l of topo.coils) {
      const a = coilAmps.get(l.id) ?? 0;
      if (!Object.is(coilUsed.get(l.id), a) || !coilUsed.has(l.id)) own.coilUsed().set(l.id, a); // prettier-ignore
    }
  }

  function solveDirtyClusters() {
    const nets = [];
    // Solving every cluster is the first of the gate rounds below, as a
    // carried solve's first round is the clusters it carries in (`dirty`) —
    // so a network the solve cannot balance is solved as many times either
    // way.
    let first = 0;
    if (all) {
      first = 1;
      all = false;
      dirty.clear();
      own.stale().clear();
      own.reported().clear();
      own.setStale().clear();
      own.setReported().clear();
      solvedAs.clear();
      for (const k of topo.order) nets.push(...solveCluster(k));
      // A rail holds its voltage whatever is drawn from it.
      for (const net of topo.rails) {
        own.volts().set(net, plan.railVolts.get(net) ?? 0);
        own.auth().add(net);
        nets.push(net);
      }
      burntUsed = new Set(burnt);
      thermalUsed = new Set(thermal);
    }
    // A MOSFET's gate solved in one cluster re-solves the cluster its channel
    // is in — a few rounds, for a gate driven through another MOSFET.
    for (let round = first; dirty.size && round < GATE_ROUNDS; round++) {
      const ks = [...dirty].sort((a, b) => topo.rank[a] - topo.rank[b]);
      dirty.clear();
      for (const k of ks) nets.push(...solveCluster(k));
    }
    // A comparator whose reference moved is read again with its own net.
    const read = new Set(nets);
    for (const net of nets) {
      for (const own of topo.senseRefs.get(net) ?? []) read.add(own);
    }
    for (const net of read) readNet(net, voltOfNet(net));
    return nets;
  }

  /**
   * One pass: re-solve what moved and re-read every input on it. `next` is
   * the levels the digital engine resolved; `start` the levels the pass
   * began from; `state` the parts' own; `read` how a chip reads a pin
   * (spice/engine.js's `input` hook — an analog switch's control is read
   * through it, exactly as the digital engine's channels read it that same
   * pass, or the two would join different nets: the digital one moving
   * levels on a network this solve never sees move, its `disagree` left
   * stale). Returns `next`, or a copy showing the readers' level wherever it
   * is not the digital one (`passOverrides` returns just those, or null).
   */
  function pass(next, info) {
    const over = passOverrides(next, info);
    if (!over) return next;
    const out = new Map(next);
    for (const [net, level] of over) out.set(net, level);
    return out;
  }

  /** `pass`, saying only the nets it shows otherwise than `next` (a Map, in
      `disagree`'s order), or null where it shows `next` as it is. `next`
      need only answer `get`. */
  function passOverrides(next, { start, state, read = null }) {
    moved = false;
    // The channels, from the pass's starting levels.
    let statesOf = null; // comp → its channels' states, this pass
    for (const ch of topo.channels) {
      const chip = plan.chips.get(ch.comp);
      let on = L;
      if (chip?.ok) {
        statesOf ??= new Map();
        let states = statesOf.get(ch.comp);
        if (!states) {
          // Its controls read their own voltage, through its thresholds,
          // like any input; a pin the solve says nothing of, its level.
          const c = chip.c;
          const pinLevels = new Map();
          for (const [pin, net] of c.pinNet) {
            const level = net ? (start.get(net) ?? Z) : Z;
            pinLevels.set(pin, !net ? Z : read ? read(c, pin, net, level) : (readings.get(net)?.get(readerKey(c.comp.id, pin)) ?? level)); // prettier-ignore
          }
          const own = state?.get(c.comp.id) ?? initialState(c.def);
          states = channelStates(c.def, pinLevels, own);
          statesOf.set(ch.comp, states);
        }
        on = states[ch.i].on;
      }
      if (channelOn.get(ch.key) !== on) {
        own.channelOn().set(ch.key, on);
        shape = null;
        markNet(ch.a); // one end may be a rail, which is in no cluster
        markNet(ch.b);
        // …or both, and only the rails' own report reads it.
        if (topo.clusterOf.get(ch.a) == null && topo.clusterOf.get(ch.b) == null) railMoved = true; // prettier-ignore
      }
    }
    // The bench sources.
    for (const [net, list] of topo.sources) {
      // Every source's own level, so a change to any one of them is seen.
      const level = list.length === 1 ? levelOf(list[0]) : list.map(levelOf).join(","); // prettier-ignore
      if (sourceUsed.get(net) !== level) {
        own.sourceUsed().set(net, level);
        shape = null;
        markNet(net);
      }
    }
    const nets = solveDirty();
    noteUsed();

    const compared = topo.watch.length || shownMoved.size ? new Set([...nets, ...topo.watch, ...shownMoved]) : nets; // prettier-ignore
    if (shownMoved.size) {
      shownMoved = new Set();
      copied.add("shownMoved");
    }
    for (const net of compared) {
      const level = shown.get(net);
      const digital = next.get(net);
      if (level != null && digital !== Z && level !== digital) {
        own.disagree().set(net, level);
      } else {
        own.disagree().delete(net);
      }
    }
    if (!disagree.size) return null;
    let out = null;
    for (const [net, level] of disagree) {
      const digital = next.get(net);
      if (digital === Z || digital == null) {
        own.disagree().delete(net);
        continue;
      }
      if (digital === level) continue;
      out ??= new Map();
      out.set(net, level);
    }
    return out;
  }

  // ── What flows ─────────────────────────────────────────────────────────

  /** An empty report entry. */
  const blank = () => ({ leads: [], sources: [], sinks: [], returns: [], junctions: [], outputs: [], stress: [], extra: [], transistors: [], switches: [], devices: [], brownouts: [], analog: [] }); // prettier-ignore

  /** One chip output's current at `v` volts on its net, into `entry`: the
      lead it flows through, the supply it comes from (sourcing) or where it
      goes (sinking), and the output's own load against its family's limits. */
  function stageFlow(entry, p, { stage, d }, v) {
    const amps = stageCurrent(stage, v);
    if (d.at) entry.leads.push([d.at, -amps]); // what it sources leaves the chip
    const chip = p.chips.get(d.comp);
    if (amps > BOOK_FLOOR_A && chip?.psu) entry.sources.push({ psu: chip.psu, amps, plusAt: chip.vccAt }); // prettier-ignore
    else if (amps < -BOOK_FLOOR_A) entry.returns.push({ amps: -amps, minusAt: chip?.gndAt ?? null }); // prettier-ignore
    const limits = chip?.limitsFor(d.pin) ?? null;
    if (Math.abs(amps) > BOOK_FLOOR_A && limits) {
      // The voltage across the output transistor: from its open-circuit
      // level (the rail it switches) to the pin.
      entry.outputs.push([d.comp, d.pin, Math.abs(amps), Math.abs(amps * (stage.volts - v)), limits]); // prettier-ignore
    }
    return amps;
  }

  /** An output held to what it SUSTAINS (a monostable's discharge transistor
      — spice/params.js `limitsAt`) on an RC node: fixed at its curve, so
      `stageFlow` never sees it. Its load is its current with the node where
      its curve is heading (`headingOf`: its capacitors open) — never the
      instant a capacitor empties through it, which its sheet bounds by Cx,
      not by a rating. Off an RC node `stageFlow` books it, and there the
      instant IS what it sustains. */
  function sustainedFlow(entry, k, cl, nw, vAt) {
    for (const [node, list] of nw.outs) {
      if (!nw.fixed.has(node)) continue;
      for (const o of list) {
        const limits = plan.chips.get(o.d.comp)?.limitsFor(o.d.pin) ?? null;
        if (!limits?.sustained) continue;
        const net = cl.nets.find((n) => nw.nodeOf(n) === node);
        if (net == null) continue;
        const v = headingOf(k, net, vAt(node));
        const amps = Math.abs(stageCurrent(o.stage, v));
        if (amps > BOOK_FLOOR_A) entry.outputs.push([o.d.comp, o.d.pin, amps, Math.abs(amps * (o.stage.volts - v)), limits]); // prettier-ignore
      }
    }
  }

  /** Where an RC node's curve is heading — V∞, its capacitors open: what
      holds it outright, else where its network stops pushing current into
      it (Newton's method along `linearize`'s slope; a few steps, for a
      network with a knee in it). */
  function headingOf(k, net, v0) {
    const free = network(k, { free: net });
    if (free.driven != null) return free.driven;
    const node = free.nodeOf(net);
    const solveAt = pinnedAt(k, net);
    const into = (v) => currentInto(node, solveAt(v));
    let v = v0;
    for (let i = 0; i < 6; i++) {
      const amps = into(v);
      const dv = amps < 0 ? -LINEARIZE_V : LINEARIZE_V;
      const siemens = (amps - into(v + dv)) / dv;
      if (!(siemens > 1e-12)) break;
      const step = amps / siemens;
      v += step;
      if (Math.abs(step) < 1e-6) break;
    }
    return v;
  }

  /** What every input on `net` (at `v` volts) suffers: a 74LS input past its
      absolute maximum, a CD4000 or MOS input past a rail (its protection
      diode's current — on a silicon `overRail` pin, only past the rating),
      and a CD4000 input in its undefined band (both its input transistors
      part-way on: `CMOS_BAND_MA` from its own supply) — not a comparator's
      (a silicon `sense` pin), whose input draws what its own stages say, nor
      a CD4007UB's gate, which is a bare MOSFET's: what its channels conduct
      is the network solve's own (`deviceBranch`). */
  function inputFlow(entry, p, net, at, vNet = null, only = null) {
    for (const r of topo.readers.get(net) ?? []) {
      if (only && !only.includes(r.comp)) continue;
      const chip = p.chips.get(r.comp);
      if (!chip?.ok) continue;
      // A chip off the rails is stressed against its own ground — read in
      // its own network's flows (`flows`), where that ground has a voltage.
      if (chip.off && !vNet) continue;
      const v = chip.off ? at - vNet(chip.off.gndNet) : at;
      // The current its own stages carry through the pin (an off-rail chip's
      // are "s" branches, `stageBranchFlow`): a 74LS input's bias out of it,
      // a CMOS input's clamp — what the probe reads there. Its draw is
      // inside its chip's ICC, and booked as none.
      if (!chip.off && r.at && p === plan) {
        let into = 0;
        for (const st of chip.inputsFor(r.pin)) into += stageCurrent(st, v);
        if (into) entry.leads.push([r.at, -into]);
      }
      if (chip.family === "74LS") {
        if (v > TTL_INPUT_MAX_V) entry.stress.push({ comp: r.comp, pin: r.pin, volts: v, family: "74LS" }); // prettier-ignore
        // Below its ground, its clamp diode carries the pin (spice/params.js
        // TTL_CLAMP): past the sheet's test current a warning, past its
        // smoke figure brown smoke.
        let clamp = 0;
        for (const st of chip.inputsFor(r.pin)) if (st.clamp) clamp += Math.abs(stageCurrent(st, v)); // prettier-ignore
        if (clamp * 1000 > TTL_CLAMP.warnMa) {
          entry.stress.push({ comp: r.comp, pin: r.pin, volts: v, family: "74LS", amps: clamp, smoke: clamp * 1000 > TTL_CLAMP.smokeMa }); // prettier-ignore
        }
        continue;
      }
      // A CD4000 input, or a family-less (MOS) part's: its protection diodes.
      let clamp = 0;
      for (const st of chip.inputsFor(r.pin)) if (st.clamp) clamp += Math.abs(stageCurrent(st, v)); // prettier-ignore
      const smoke = clamp * 1000 > CMOS_CLAMP.smokeMa;
      if (clamp > BOOK_FLOOR_A && (smoke || !chip.overRail.includes(r.pin))) {
        entry.stress.push({ comp: r.comp, pin: r.pin, volts: v, family: chip.family ?? "MOS", amps: clamp, smoke }); // prettier-ignore
      }
      if (
        chip.family === "CD4000" &&
        !chip.c.def.transistorArray &&
        v > chip.th.vil &&
        v < chip.th.vih &&
        chip.psu &&
        !chip.senseFor(r.pin)
      ) {
        // prettier-ignore
        entry.extra.push({ chip: r.comp, psu: chip.psu, plusAt: chip.vccAt, minusAt: chip.gndAt, amps: CMOS_BAND_MA / 1000 }); // prettier-ignore
      }
    }
  }

  /**
   * Whether the outputs driving `net` hold it at a level its inputs read: a
   * BROWNOUT is a net its drivers all drive one way (`drivers`: `{d,
   * sources, open}`, `open` the level each would stand at with nothing on
   * it) that the load on it holds where an input on it no longer reads that
   * level — though it would at the drivers' own unloaded voltage (a 74LS
   * HIGH that never reaches a 12 V CMOS input's VIH is a level mismatch, not
   * a load the output cannot hold). Recorded per driving pin: `[comp, pin,
   * net, level, volts, inputs, misread]`. The supply's own booking (`p` at
   * SET) is no reading anyone sees, and says nothing here.
   */
  function loadCheck(entry, p, net, v, drivers) {
    if (p !== plan || !drivers.length || candidates.has(net)) return;
    const high = drivers[0].sources;
    if (drivers.some((x) => x.sources !== high)) return;
    const level = high ? H : L;
    let open = drivers[0].open;
    for (const x of drivers) open = high ? Math.max(open, x.open) : Math.min(open, x.open); // prettier-ignore
    const old = readings.get(net);
    let inputs = 0;
    let misread = 0;
    for (const r of topo.readers.get(net) ?? []) {
      if (drivers.some((x) => x.d.comp === r.comp && x.d.pin === r.pin)) continue; // prettier-ignore
      const key = readerKey(r.comp, r.pin);
      const chip = p.chips.get(r.comp);
      if (owned.has(key) || !chip?.ok || chip.senseFor(r.pin)) continue;
      inputs++;
      const now = readingAt(chip, r.pin, v, old?.get(key));
      if (now == null || now === level) continue;
      if (readingAt(chip, r.pin, open, undefined) !== level) continue;
      misread++;
    }
    if (!misread) return;
    for (const x of drivers) entry.brownouts.push([x.d.comp, x.d.pin, net, level, v, inputs, misread]); // prettier-ignore
  }

  /**
   * One cluster's currents, from a solved network or a lone net's voltage:
   * the signed current INTO the part through each lead it knows a hole for;
   * what each supply delivers into it (`{psu, amps, plusAt}`: through a
   * branch from its + rail, or out of a chip output sourcing from it) and
   * where current leaves it for a − rail or a sinking output (`{amps,
   * minusAt}`); each junction's current and voltage; each output's load;
   * and every input's stress.
   */
  function flows(k, p, guess) {
    const cl = topo.clusters[k];
    const entry = blank();
    if (isLone(cl)) {
      const net = cl.nets[0];
      const fixed = fixedOf(net, false, p);
      if (fixed != null) {
        inputFlow(entry, p, net, fixed);
        return entry;
      }
      const { outs, stages, splits } = loneStages(net, p);
      if (!outs.length) return entry;
      const v = p === plan ? volts.get(net) : solveDrivers(stages, stages[0].volts); // prettier-ignore
      if (p !== plan) guess.set(net, v);
      for (const o of outs) stageFlow(entry, p, o, v);
      for (const { stage, dev } of splits) {
        // Out through the output's lead, in through GND's, into its rail.
        const amps = -stageCurrent(stage, v);
        if (dev.outAt) entry.leads.push([dev.outAt, amps]);
        if (dev.gndAt) entry.leads.push([dev.gndAt, -amps]);
        if (amps > BOOK_FLOOR_A && topo.sup.minusNets.has(dev.gnd)) entry.returns.push({ amps, minusAt: dev.gndAt }); // prettier-ignore
      }
      inputFlow(entry, p, net, v);
      loadCheck(entry, p, net, v, outs.map((o) => ({ d: o.d, sources: o.stage.sources, open: o.stage.volts }))); // prettier-ignore
      return entry;
    }
    // The passes' own solve, where there was one this tick.
    const nw = (p === plan && solvedAs.get(k)) || network(k, { p, guess });
    if (p !== plan) {
      for (const [node, v] of nw.volts) guess.set(node, v);
      if (nw.balanced) own.setUnsettled().delete(k);
      else own.setUnsettled().add(k);
    }
    const vAt = (node) => nw.fixed.get(node) ?? nw.volts.get(node) ?? 0;
    const nodePsu = new Map();
    const nodeMinus = new Set();
    const supplyAt = new Map(); // node → where its current really enters
    const returnAt = new Map(); // …or leaves, where that is somewhere else
    for (const net of cl.rails) {
      const psu = topo.sup.psuOfNet.get(net);
      if (psu) nodePsu.set(nw.nodeOf(net), psu);
      if (topo.sup.minusNets.has(net)) nodeMinus.add(nw.nodeOf(net));
    }
    // A clock brick holding its net: what it sources comes from the supply
    // on its `vcc` terminal, and what it sinks returns through its `gnd`.
    for (const net of cl.nets) {
      const clk = topo.clockPsu.get(net);
      const node = nw.nodeOf(net);
      if (!clk || !nw.fixed.has(node) || nodePsu.has(node)) continue;
      // A wave anywhere between its rails sources out of its supply and
      // sinks into its ground, whichever way its load takes current.
      if (candidates.get(net)?.wave != null) {
        nodePsu.set(node, clk.psu);
        supplyAt.set(node, clk.plusAt);
        nodeMinus.add(node);
        returnAt.set(node, clk.minusAt);
        continue;
      }
      const level = sourceLevel(topo.sources.get(net));
      if (level === H) {
        nodePsu.set(node, clk.psu);
        supplyAt.set(node, clk.plusAt);
      } else if (level === L) {
        nodeMinus.add(node);
        supplyAt.set(node, clk.minusAt);
      }
    }
    for (const br of nw.branches) {
      if (br.kind === "q" || br.kind === "m") {
        deviceFlow(entry, br, vAt, nodePsu, nodeMinus, p);
        continue;
      }
      if (br.kind === "t") {
        splitterFlow(entry, br, vAt, nodePsu, nodeMinus);
        continue;
      }
      if (ANALOG_KINDS.has(br.kind)) {
        analogFlow(entry, br, vAt, nodePsu, nodeMinus);
        continue;
      }
      if (br.kind === "s") {
        stageBranchFlow(entry, br, vAt, nodePsu, nodeMinus, p);
        continue;
      }
      // A branch between two UNHELD nets (reached through junctions alone):
      // their voltages are the solve's own — noise, on a net nothing holds —
      // unless the cluster balanced and a real current runs through it. The
      // middle LED of a series string, a resistor between two: dropped
      // here, it read dark with its neighbours lit at 18 mA, and was never
      // judged for overdrive or burning.
      const unheld = !nw.held.has(br.a) && !nw.held.has(br.b);
      if (unheld && !nw.balanced) continue;
      const vd = vAt(br.a) - vAt(br.b);
      const amps = br.kind === "r" ? vd / br.ohms : br.kind === "l" ? br.amps : junctionCurrent(br, vd); // prettier-ignore
      if (unheld && !(Math.abs(amps) > BOOK_FLOOR_A)) continue;
      if (br.kind === "j") entry.junctions.push([br.key, amps, vd]);
      if (br.channel) entry.switches.push([br.comp, br.channel, Math.abs(amps), p.chips.get(br.comp)?.c.def.contacts?.limits]); // prettier-ignore
      if (br.aAt) entry.leads.push([br.aAt, amps]);
      if (br.bAt) entry.leads.push([br.bAt, -amps]);
      if (!(Math.abs(amps) > BOOK_FLOOR_A)) continue;
      const [from, fromAt, to, toAt] =
        amps > 0 ? [br.a, br.aAt, br.b, br.bAt] : [br.b, br.bAt, br.a, br.aAt];
      if (nodePsu.has(from)) entry.sources.push({ psu: nodePsu.get(from), amps: Math.abs(amps), plusAt: supplyAt.get(from) ?? fromAt }); // prettier-ignore
      if (nodePsu.has(to)) entry.sinks.push({ psu: nodePsu.get(to), amps: Math.abs(amps) }); // prettier-ignore
      if (nodeMinus.has(to)) entry.returns.push({ amps: Math.abs(amps), minusAt: returnAt.get(to) ?? supplyAt.get(to) ?? toAt }); // prettier-ignore
    }
    for (const [node, list] of nw.outs) {
      if (nw.fixed.has(node)) continue;
      for (const o of list) stageFlow(entry, p, o, vAt(node));
    }
    if (p === plan) sustainedFlow(entry, k, cl, nw, vAt);
    if (p === plan) {
      // Each net's drivers, an off-rail chip's ("s") with the rest.
      const offDrivers = new Map(); // node → [{d, sources, open}]
      for (const br of nw.branches) {
        if (br.kind !== "s" || !br.d) continue;
        const list = offDrivers.get(br.out) ?? [];
        list.push({ d: br.d, sources: br.stage.sources, open: vAt(br.ref) + br.offset }); // prettier-ignore
        offDrivers.set(br.out, list);
      }
      for (const net of cl.nets) {
        const node = nw.nodeOf(net);
        if (nw.fixed.has(node) || !nw.held.has(node)) continue;
        const drivers = (nw.outs.get(node) ?? []).map((o) => ({ d: o.d, sources: o.stage.sources, open: o.stage.volts })); // prettier-ignore
        drivers.push(...(offDrivers.get(node) ?? []));
        loadCheck(entry, p, net, vAt(node), drivers);
      }
    }
    const vNet = (net) => vAt(nw.nodeOf(net));
    for (const net of cl.nets) {
      const node = nw.nodeOf(net);
      if (nw.held.has(node)) inputFlow(entry, p, net, vAt(node), vNet);
    }
    // An off-rail chip's inputs tied to a rail: stressed against its ground
    // (in its home network only).
    const homed = cl.offChips.filter((comp) => topo.offRail.get(comp)?.home === k); // prettier-ignore
    if (homed.length) {
      for (const net of cl.rails) inputFlow(entry, p, net, vNet(net), vNet, homed); // prettier-ignore
    }
    return entry;
  }

  /** An off-rail chip's stage (an "s" branch): the current out of its pin
      and in through its supply pin (or the reverse), booked where that pin
      is on a rail; and an output's own load against its family's limits. */
  function stageBranchFlow(entry, br, vAt, nodePsu, nodeMinus, p) {
    const [[, amps]] = deviceCurrents(br, vAt); // into the output's net
    if (br.outAt) entry.leads.push([br.outAt, -amps]);
    if (br.feedAt) entry.leads.push([br.feedAt, amps]);
    // An input's own stage: through its pin and its supply pin, as the probe
    // reads them — its draw inside its chip's ICC.
    if (!br.d) return;
    if (amps > BOOK_FLOOR_A && nodePsu.has(br.feed)) entry.sources.push({ psu: nodePsu.get(br.feed), amps, plusAt: br.feedAt }); // prettier-ignore
    if (amps < -BOOK_FLOOR_A && nodeMinus.has(br.feed)) entry.returns.push({ amps: -amps, minusAt: br.feedAt }); // prettier-ignore
    const limits = p.chips.get(br.comp)?.limitsFor(br.d.pin) ?? null;
    if (Math.abs(amps) > BOOK_FLOOR_A && limits) {
      const open = vAt(br.ref) + br.offset;
      entry.outputs.push([br.comp, br.d.pin, Math.abs(amps), Math.abs(amps * (open - vAt(br.out))), limits]); // prettier-ignore
    }
  }

  /** A transistor's currents: through each of its leads, from a + rail or
      into a − one; and, for a discrete transistor, whether it conducts and
      whether its gate is floating on the charge it was left with. */
  function deviceFlow(entry, br, vAt, nodePsu, nodeMinus, p) {
    const flowsIn = deviceCurrents(br, vAt); // [node, amps into the network]
    const where = br.kind === "q" ? [br.bAt, br.cAt, br.eAt] : [br.aAt, br.bAt]; // prettier-ignore
    flowsIn.forEach(([node, amps], i) => {
      if (where[i]) entry.leads.push([where[i], -amps]);
      if (amps < -BOOK_FLOOR_A && nodePsu.has(node)) entry.sources.push({ psu: nodePsu.get(node), amps: -amps, plusAt: where[i] }); // prettier-ignore
      if (amps > BOOK_FLOOR_A && nodePsu.has(node)) entry.sinks.push({ psu: nodePsu.get(node), amps }); // prettier-ignore
      if (amps > BOOK_FLOOR_A && nodeMinus.has(node)) entry.returns.push({ amps, minusAt: where[i] }); // prettier-ignore
    });
    if (br.outPin != null) {
      // One of an array's (a ULN2003A's): the chip's output it is, held to
      // that pin's own rating — its collector current, what it dissipates.
      const amps = Math.abs(flowsIn[1][1]);
      const def = p.chips.get(br.comp)?.c.def;
      const limits = def ? pinOutputLimits(def, br.outPin) : null;
      let watts = 0;
      for (const [node, into] of flowsIn) watts -= vAt(node) * into;
      if (amps > BOOK_FLOOR_A && limits) entry.outputs.push([br.comp, br.outPin, amps, Math.max(0, watts), limits]); // prettier-ignore
      return;
    }
    if (br.array) {
      // One of a CD4007UB's: held, as every CD4000 output transistor is, to
      // the power in it (spice/params.js `outputLimits`) — no lamp of its own.
      const amps = Math.abs(flowsIn[0][1]);
      const limits = p.chips.get(br.comp)?.limitsFor(br.aPin) ?? null;
      if (amps > BOOK_FLOOR_A && limits) entry.outputs.push([br.comp, br.aPin, amps, amps * Math.abs(vAt(br.a) - vAt(br.b)), limits]); // prettier-ignore
      return;
    }
    const amps = Math.abs(flowsIn[br.kind === "q" ? 1 : 0][1]);
    const held = br.kind === "m" && br.g != null && !topo.rails.has(br.g) && !auth.has(br.g); // prettier-ignore
    entry.transistors.push([br.comp, { on: deviceConducts(br, vAt), held, amps }]); // prettier-ignore
    // What it dissipates — the power into it through every lead — against
    // its package's (spice/params.js TRANSISTOR_LIMITS), and what it
    // carries against its grade's part's rating (spice/transistors.js).
    let watts = 0;
    for (const [node, into] of flowsIn) watts -= vAt(node) * into;
    const c = p.chips.get(br.comp)?.c;
    const pkg = transistorCase(c?.def, c?.comp.params);
    const power = TRANSISTOR_LIMITS[br.kind === "q" && pkg === "TO-92" ? "bjt" : pkg]; // prettier-ignore
    const limits = power && { warnMw: power.warnMw, smokeMw: power.smokeMw, ...br.model?.limits }; // prettier-ignore
    if (limits && amps > BOOK_FLOOR_A) entry.devices.push([br.comp, amps, Math.max(0, watts), limits]); // prettier-ignore
  }

  /** A 74LS splitter's current: out through its output's lead and in
      through its GND's, into a − rail there. (Its output's stage booked
      what the supply delivers.) */
  function splitterFlow(entry, br, vAt, nodePsu, nodeMinus) {
    const flowsIn = deviceCurrents(br, vAt);
    const where = [br.outAt, br.gndAt];
    flowsIn.forEach(([node, amps], i) => {
      if (where[i]) entry.leads.push([where[i], -amps]);
      if (amps < -BOOK_FLOOR_A && nodePsu.has(node)) entry.sources.push({ psu: nodePsu.get(node), amps: -amps, plusAt: where[i] }); // prettier-ignore
      if (amps > BOOK_FLOOR_A && nodePsu.has(node)) entry.sinks.push({ psu: nodePsu.get(node), amps }); // prettier-ignore
      if (amps > BOOK_FLOOR_A && nodeMinus.has(node)) entry.returns.push({ amps, minusAt: where[i] }); // prettier-ignore
    });
  }

  /** A bench part's currents (spice/analog-devices.js): through each of its
      leads, from a + rail or into a − one; and what it reports — an
      optocoupler's load against its ratings, a regulator's output and the
      heat it makes, an electronic load's reading. */
  function analogFlow(entry, br, vAt, nodePsu, nodeMinus) {
    const flowsIn = deviceCurrents(br, vAt);
    const where = analogHoles(br);
    flowsIn.forEach(([node, amps], i) => {
      if (where[i]) entry.leads.push([where[i], -amps]);
      if (amps < -BOOK_FLOOR_A && nodePsu.has(node)) entry.sources.push({ psu: nodePsu.get(node), amps: -amps, plusAt: where[i] }); // prettier-ignore
      if (amps > BOOK_FLOOR_A && nodePsu.has(node)) entry.sinks.push({ psu: nodePsu.get(node), amps }); // prettier-ignore
      if (amps > BOOK_FLOOR_A && nodeMinus.has(node)) entry.returns.push({ amps, minusAt: where[i] }); // prettier-ignore
    });
    let watts = 0;
    for (const [node, into] of flowsIn) watts -= vAt(node) * into;
    if (br.kind === "o") {
      // Its LED's current against its rating, or its phototransistor's —
      // whichever is nearer its own (OPTO_LIMITS).
      const { led, out } = optoAmps(br, vAt);
      const onLed =
        led / OPTO_LIMITS.led.warnMa >= out / OPTO_LIMITS.out.warnMa;
      const [amps, limits] = onLed ? [led, OPTO_LIMITS.led] : [out, OPTO_LIMITS.out]; // prettier-ignore
      // (Its LED's is said as the LED's, not a transistor's: `led`.)
      if (amps > BOOK_FLOOR_A) entry.devices.push([br.comp, amps, Math.max(0, watts), limits, onLed]); // prettier-ignore
    } else if (br.kind === "g") {
      const amps = flowsIn[2][1]; // OUT's (`analogCurrents`' order)
      // What it holds its output at, against ground: an LM317's ADJ is not
      // ground, and what its resistors set is OUT's voltage. A fixed one's
      // against its own GND — the same on a grounded board, and on one whose
      // DC side floats (a bridge's − on a rail nothing grounds, off an
      // earthed AC supply) the only reading that means anything: against
      // earth its OUT swung −11 V…+5.7 V every cycle. Shut down it holds
      // nothing (a net a constant-current load alone is on has no voltage
      // worth reading).
      // …except with its GND wired to nothing (`refOpen`): that GND stands
      // wherever the solve leaves a net no current leaves (up at IN), so
      // its OUT is read against the desk's ground, where it really stands —
      // IN less the dropout — and it is not "in dropout": it has nothing to
      // regulate against.
      // Wired to nothing at all, or to nothing a DC current can take (a
      // dangling resistor, a capacitor to ground): no current leaves GND
      // and OUT stands below it — which no regulator does that has a GND.
      const floating = Math.abs(flowsIn[1][1]) < OPEN_GND_A && vAt(br.ref) - vAt(br.out) > OPEN_GND_V; // prettier-ignore
      const open = (Boolean(br.refOpen) || (!br.reg.adjustable && floating)) && !br.off; // prettier-ignore
      const out = br.off ? 0 : vAt(br.out) - (br.reg.adjustable || open ? 0 : vAt(br.ref)); // prettier-ignore
      const low = !br.off && !open && vAt(br.inp) - br.reg.dropoutV < vAt(br.ref) + br.reg.vref; // prettier-ignore
      const dropout = low && amps > BOOK_FLOOR_A;
      // Its input too low to regulate, and sourcing nothing: its output
      // already stands where the input lets it (spice/engine.js `measure`).
      const starved = low && !(amps > BOOK_FLOOR_A);
      // (On its limit by what it sources — its divider's microamps aside.)
      const limited = regulatorAmps(br, vAt) >= br.reg.limitA * (1 - 1e-9);
      entry.analog.push([br.comp, { kind: "regulator", volts: out, amps, watts: Math.max(0, watts), dropout, starved, limited, off: Boolean(br.off), open }]); // prettier-ignore
    } else if (br.kind === "p") {
      // A supply on its limit: what it delivers, as its own brick reads it.
      const volts = vAt(br.pos) - vAt(br.neg);
      const amps = supplyAmps(br, vAt);
      entry.analog.push([br.comp, { kind: "psu", volts, amps, limited: amps >= br.limit * (1 - 1e-9) }]); // prettier-ignore
    } else if (br.kind === "x") {
      // A multimeter's element: the voltage across its probes, and what
      // flows into its red jack (catalog/meter.js).
      const volts = vAt(br.pos) - vAt(br.neg);
      entry.analog.push([br.comp, { kind: "meter", volts, amps: -meterAmps(br, vAt) }]); // prettier-ignore
    } else if (br.kind === "e") {
      const volts = vAt(br.pos) - vAt(br.neg);
      const amps = loadAmps(br, vAt);
      // Short of what it is set to: CC under its current, CV unable to
      // hold its voltage, CP its power (`loadRegulates`).
      const unreg = br.mode === "cc" ? br.amps > 0 && amps < br.amps * (1 - 1e-6) : br.mode !== "cr" && !loadRegulates(br, volts); // prettier-ignore
      entry.analog.push([br.comp, { kind: "load", volts, amps, watts: Math.max(0, volts * amps), unreg }]); // prettier-ignore
    }
  }

  /** What flows between and on the rails themselves, at the plan's rail
      voltages: the branches straight across them, an output wired to one,
      an input tied to one. */
  function railFlows(p) {
    const entry = blank();
    const railAt = (net) => p.railVolts.get(net) ?? 0;
    for (const br of topo.railBranches) {
      const vd = railAt(br.a) - railAt(br.b);
      // (A burnt junction, or a speaker's coil burnt open, carries nothing.)
      if (br.key != null && burnt.has(br.key)) continue;
      let ohms = br.ohms;
      if (br.kind === "ch") {
        // A switch channel straight across two rails, switched on.
        const chip = p.chips.get(br.ch.comp);
        if (channelOn.get(br.ch.key) !== H || !chip?.ok || !(chip.channelOhms > 0)) continue; // prettier-ignore
        ohms = chip.channelOhms;
      } else if (br.kind === "load") {
        // A chip across two rails: its supply current, as a load.
        ohms = p.chips.get(br.comp)?.loadOhms;
        if (!Number.isFinite(ohms)) continue;
      }
      const amps = br.kind === "j" ? junctionCurrent(br, vd) : vd / ohms;
      if (br.kind === "j") entry.junctions.push([br.key, amps, vd]);
      if (br.kind === "ch") entry.switches.push([br.ch.comp, br.ch.key, Math.abs(amps), p.chips.get(br.ch.comp)?.c.def.contacts?.limits]); // prettier-ignore
      if (br.aAt) entry.leads.push([br.aAt, amps]);
      if (br.bAt) entry.leads.push([br.bAt, -amps]);
      if (!(Math.abs(amps) > BOOK_FLOOR_A)) continue;
      const [from, fromAt, to, toAt] =
        amps > 0 ? [br.a, br.aAt, br.b, br.bAt] : [br.b, br.bAt, br.a, br.aAt];
      const psu = topo.sup.psuOfNet.get(from);
      if (psu)
        entry.sources.push({ psu, amps: Math.abs(amps), plusAt: fromAt });
      const into = topo.sup.psuOfNet.get(to);
      if (into) entry.sinks.push({ psu: into, amps: Math.abs(amps) });
      if (topo.sup.minusNets.has(to)) entry.returns.push({ amps: Math.abs(amps), minusAt: toAt }); // prettier-ignore
    }
    // An inductor straight across two rails: its current, which the supply
    // delivers. Unbooked, a 0.09 Ω coil across 5 V carried 55 A off a 1 A
    // supply that read 0 A and was never limited (the regrade, 2026-10-23).
    for (const l of topo.railCoils) {
      const amps = coilAmps.get(l.id) ?? 0;
      if (l.aAt) entry.leads.push([l.aAt, amps]);
      if (l.bAt) entry.leads.push([l.bAt, -amps]);
      if (!(Math.abs(amps) > BOOK_FLOOR_A)) continue;
      const [from, fromAt, to, toAt] =
        amps > 0 ? [l.a, l.aAt, l.b, l.bAt] : [l.b, l.bAt, l.a, l.aAt];
      const psu = topo.sup.psuOfNet.get(from);
      if (psu) entry.sources.push({ psu, amps: Math.abs(amps), plusAt: fromAt }); // prettier-ignore
      const into = topo.sup.psuOfNet.get(to);
      if (into) entry.sinks.push({ psu: into, amps: Math.abs(amps) });
      if (topo.sup.minusNets.has(to)) entry.returns.push({ amps: Math.abs(amps), minusAt: toAt }); // prettier-ignore
    }
    // A transistor with every end on a rail: a MOSFET from + to −, say — a
    // short through its channel, which the supply delivers.
    const gates = new Map(); // a gate the solve holds elsewhere → its volts
    for (const dev of topo.railDevices) {
      const br = deviceBranch(dev, p, (net) => net, (g, v) => gates.set(g, v), () => false); // prettier-ignore
      if (!br) continue;
      const vAt = (node) => gates.get(node) ?? railAt(node);
      if (ANALOG_KINDS.has(br.kind))
        analogFlow(entry, br, vAt, topo.sup.psuOfNet, topo.sup.minusNets); // prettier-ignore
      else if (br.kind === "t")
        splitterFlow(entry, br, vAt, topo.sup.psuOfNet, topo.sup.minusNets); // prettier-ignore
      else deviceFlow(entry, br, vAt, topo.sup.psuOfNet, topo.sup.minusNets, p);
    }
    for (const { d, net } of topo.railDrivers) {
      const stage = stageAt(d, p);
      if (!stage) continue;
      const amps = stageFlow(entry, p, { stage, d }, p.railVolts.get(net) ?? 0);
      // …and the rail's side of it: into a − rail, or out of a + one.
      if (amps > BOOK_FLOOR_A && topo.sup.minusNets.has(net)) entry.returns.push({ amps, minusAt: d.at }); // prettier-ignore
      const psu = topo.sup.psuOfNet.get(net);
      if (amps < -BOOK_FLOOR_A && psu) entry.sources.push({ psu, amps: -amps, plusAt: d.at }); // prettier-ignore
    }
    for (const { net } of topo.railReaders) {
      // Once per rail: inputFlow reads every input on it.
      if (entry.read?.has(net)) continue;
      (entry.read ??= new Set()).add(net);
      inputFlow(entry, p, net, p.railVolts.get(net) ?? 0);
    }
    return entry;
  }

  /**
   * What flows, as the tick ends: each junction's current and voltage
   * (`junctions`: key → {amps, volts}), the current through every lead the
   * solve knows (`currents`: hole → amps, a magnitude, summed where leads
   * share a hole) and what each supply delivers (`draws`, spice/supply.js's
   * shape, each paired with where its cluster's current returns). `atSet`
   * reads only the draws, with every supply at its SET voltage (a solve of
   * its own) — what demand is booked at; else everything, from the passes'
   * own solution. Either way a cluster no pass has re-solved since the last
   * such report keeps its answer (at SET, while the plan at SET is the one it
   * was booked under): nothing it reads has moved, so solving it again would
   * land where it stands.
   * @param {{atSet?: boolean}} [opts]
   */
  function report({ atSet = false } = {}) {
    if (!topo) return { junctions: new Map(), currents: new Map(), draws: [], outputs: [], stress: [], transistors: new Map(), switches: [], devices: [], brownouts: [], analog: new Map() }; // prettier-ignore
    if (atSet) {
      const p = makePlan(ctxNow, config, topo.sup, true, topo.offRail, topo.clockPsu, topo.freeNets); // prettier-ignore
      const every = p.signature !== setSignature;
      setSignature = p.signature;
      const draws = [];
      for (let k = 0; k < topo.clusters.length; k++) {
        let entry = setReported.get(k);
        if (every || !entry || setStale.has(k)) {
          own.setReported().set(k, (entry = flows(k, p, own.setVolts())));
          if (stats) stats.bookings = (stats.bookings ?? 0) + 1;
        }
        draws.push(...shareOf(entry).draws);
      }
      if (setStale.size) own.setStale().clear();
      draws.push(...shareOf(railFlows(p)).draws);
      return { draws };
    }
    // Nothing re-solved since the last report: it stands.
    if (!stale.size && !railMoved && lastReport?.plan === plan) return lastReport.answer; // prettier-ignore
    railMoved = false;
    for (const k of stale) {
      own.reported().set(k, auth.has(topo.clusters[k].nets[0]) || !isLone(topo.clusters[k]) ? flows(k, plan, volts) : null); // prettier-ignore
    }
    if (stale.size) own.stale().clear();
    const entries = [];
    for (const entry of reported.values()) if (entry) entries.push(entry);
    entries.push(railFlows(plan));
    const junctions = new Map();
    const into = new Map();
    const draws = [];
    const outputs = [];
    const stress = [];
    const transistors = new Map();
    const switches = [];
    const devices = [];
    const brownouts = [];
    const analog = new Map();
    // (Index loops and `forEach`, no iterators or spreads: this runs every
    // tick over every cluster, and its garbage was a tenth of a tick's.)
    const append = (to, from) => {
      for (let j = 0; j < from.length; j++) to.push(from[j]);
    };
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const own = shareOf(e);
      for (let j = 0; j < e.analog.length; j++) analog.set(e.analog[j][0], e.analog[j][1]); // prettier-ignore
      for (let j = 0; j < e.transistors.length; j++) transistors.set(e.transistors[j][0], e.transistors[j][1]); // prettier-ignore
      const js = own.junctions;
      for (let j = 0; j < js.length; j++) junctions.set(js[j][0], js[j][1]);
      const leads = e.leads;
      for (let j = 0; j < leads.length; j++) {
        const at = leads[j][0];
        into.set(at, (into.get(at) ?? 0) + leads[j][1]);
      }
      append(outputs, own.outputs);
      append(stress, e.stress);
      append(draws, own.draws);
      append(switches, own.switches);
      append(devices, own.devices);
      append(brownouts, own.brownouts);
    }
    // Each hole's current a magnitude — in place: the sums are done.
    into.forEach((amps, at) => into.set(at, Math.abs(amps)));
    const currents = into;
    const answer = { junctions, currents, draws, outputs, stress, transistors, switches, devices, brownouts, analog }; // prettier-ignore
    lastReport = { plan, answer };
    return answer;
  }

  return {
    context,
    /** The network topology the last context was read with. */
    topology() {
      return topo;
    },
    linearize,
    linearizeGroup,
    adoptGroupSwing,
    currentsAt,
    currentsReader,
    kicks,
    heldAt,
    current,
    affine,
    setNodes,
    guessNets,
    setCoils,
    setBurnt,
    setThermal,
    outputs,
    pass,
    passOverrides,
    report,
    /** What the bench sources hold from now on: the clocks' phases and the
        signals' levels (a late tick replays its history on the last tick's,
        and switches to its own at its own moment). */
    sources(clocks, signals) {
      clockPhase = clocks;
      signalLevels = signals;
    },
    /** Solve every network as it stands, outside a pass: what a tick does
        before its first, when a reading is wanted that no pass has given a
        voltage to read yet. */
    prime() {
      if (!topo) return;
      all = true;
      solveDirty();
      noteUsed();
    },
    /** Solve, outside a pass, whatever a burnt junction moved. */
    resolve() {
      if (!topo) return;
      solveDirty();
      noteUsed();
    },
    /** What `comp`'s `pin` reads on `net`, or null where the voltage says
        nothing. */
    reading(comp, pin, net) {
      return readings.get(net)?.get(readerKey(comp, pin)) ?? null;
    },
    /** What a discrete transistor's base or gate reads — whether the solve
        has it conducting (`selfControlled`) — or null: any other part, or
        none of its nets with a voltage yet. */
    selfControl(comp) {
      const dev = topo?.selfControlled.get(comp);
      return dev ? selfLevel(dev) : null;
    },
    /** The reader pins spice/engine.js reads itself (`owned`), by their keys:
        their nets' readings here leave them out. */
    setOwned(keys) {
      if (keys.size === owned.size && [...keys].every((k) => owned.has(k))) return; // prettier-ignore
      owned = keys;
      all = true;
    },
    /** A held net's (or a rail's) voltage, or null. */
    voltOfNet,
    /** Whether the last pass changed what any input reads. */
    get moved() {
      return moved;
    },
    /** The chips whose readings changed since last asked. */
    takeReread() {
      if (!reread.size) return null;
      const out = reread;
      reread = new Set();
      return out;
    },
    /** Every net something holds, at its voltage. */
    volts() {
      return volts;
    },
    /** The voltage an RC node's networks were last solved with, or
        undefined (spice/engine.js keeps an island it does not tick there). */
    nodeVoltUsed(net) {
      return fixedUsed.get(net);
    },
    /** A held net's voltage, or null. */
    voltOf(net) {
      return auth.has(net) ? (volts.get(net) ?? null) : null;
    },
    /**
     * What reaches a chip that is not straight across the rails: the voltage
     * across its supply pins, as the last solve left them — or null where
     * the solve says nothing yet (a first settle; a pin floating).
     */
    chipVolts(vccNet, gndNets) {
      const at = (net) =>
        net == null
          ? null
          : (plan?.railVolts.get(net) ??
            (auth.has(net) ? (volts.get(net) ?? null) : null));
      const vcc = at(vccNet);
      if (vcc == null || !gndNets.length) return null;
      let gnd = Number.NEGATIVE_INFINITY;
      for (const net of gndNets) {
        const v = at(net);
        if (v == null) return null;
        gnd = Math.max(gnd, v);
      }
      return vcc - gnd;
    },
    /** What the networks are (`shape`, above), as a string. */
    epoch() {
      if (shape == null) {
        const sorted = (set) => [...set].sort().join();
        const entries = (map, value = (v) => v) => [...map].map(([k, v]) => `${k}=${value(v)}`).sort().join(); // prettier-ignore
        const gates = [...(topo?.gates ?? [])].map((net) => `${net}=${volts.get(net)}`).join(); // prettier-ignore
        // (An op-amp's outputs are its devices', never a stage of the
        // networks — `analogOuts`: the level a comparator's swing reads as
        // changes none of them, and stated it made every curve and every
        // kept read of its group anew at each swing.)
        const outOf = ([comp, out]) => {
          const amps = plan?.chips.get(comp)?.c.def.opAmps?.units.map((u) => u.out); // prettier-ignore
          return `${comp}=${[...out].filter(([pin]) => !amps?.includes(pin)).map(([pin, l]) => `${pin}${l}`).join()}`; // prettier-ignore
        };
        const outs = [...used].map(outOf).sort().join();
        shape = [fresh ? "fresh" : "", signature, sorted(burnt), sorted(thermal), freeKey, outs, entries(channelOn), entries(sourceUsed), gates].join("#"); // prettier-ignore
      }
      return shape;
    },
    groupKey,
    /** Whether a cluster this tick solved is out of balance and was not
        before it (spice/engine.js wakes the desk soon, once). */
    newlyUnsettled() {
      return newly;
    },
    /** This run's own object (`lineage`, above). */
    lineage() {
      return lineage;
    },
    /** What the next tick starts from. */
    snapshot() {
      return {
        lineage,
        netlist,
        configKey,
        freeKey,
        owned,
        volts,
        readings,
        shown,
        auth,
        used,
        channelOn,
        sourceUsed,
        fixedUsed,
        coilUsed,
        signature,
        burntUsed,
        thermalUsed,
        disagree,
        shownMoved,
        reported,
        stale,
        loose,
        setVolts,
        setReported,
        setStale,
        setSignature,
        unsettled,
        setUnsettled,
      };
    },
  };
}

/**
 * `clear()` for a set of constraints (`constraints` in `linearizeGroup`):
 * the least over them of how long, from the moment the last `margin` read,
 * the constraint's quantity takes at the soonest to reach either of its
 * edges — `below` and `above` as that read left them, and each mode's
 * e^(k·dt) there, and a ringing one's turn (`decay`, `cos`, `sin`,
 * spice/dynamics.js `curveRates`). Each quantity's rate along a mode is
 * fixed (its gradient on the states dotted with their rates). A real mode
 * pushes it one way for good, at most |rate|·e^(k·dt) a second from then
 * on — never past Σ |rate|·e^(k·dt)/|k| where it decays, so an edge
 * further than the decaying modes pushing toward it can carry it, with
 * nothing else pushing that way, is never reached. A ringing mode pushes
 * the way it is going now and turns no faster than |rate|·|λ|·e^(k·dt) a
 * second²: a mains sine carries a junction it has just carried across an
 * edge on away from it, which, read as a speed either way, held the search
 * to a doubling grid from the nanosecond up (a bridge rectifier off an AC
 * adapter: two dozen reads a corner — the speed round, 2026-10-26). Null
 * when a mode grows.
 * @param {{modes: number[][], rates: number[][], decay: Float64Array, cos: Float64Array, sin: Float64Array}} rates
 * @param {Float64Array[]} along
 * @param {Float64Array} below - each quantity's distance above its lower edge
 * @param {Float64Array} above - …and below its upper one
 */
function clearance({ modes, rates, decay, cos, sin }, along, below, above) {
  const nm = modes.length;
  // Each constraint's rate along each mode it moves along (complex: a
  // ringing mode's turns) — its real ones, its ringing ones and its size
  // along those.
  const pulls = [];
  for (const g of along) {
    const real = [];
    const ring = [];
    for (let m = 0; m < nm; m++) {
      let r = 0;
      let i = 0;
      for (let j = 0; j < g.length && j < rates.length; j++) {
        r += g[j] * rates[j][2 * m];
        i += g[j] * rates[j][2 * m + 1];
      }
      if (!r && !i) continue;
      if (modes[m][0] > 0) return null;
      if (modes[m][1]) {
        ring.push(m, r, i, Math.hypot(r, i) * Math.hypot(...modes[m]));
      } else real.push(m, r);
    }
    pulls.push({ real, ring });
  }
  // How long until the quantity can have moved `d` one way, at most
  // `speed` that way now and turning toward it at `bend` a second²:
  // never, where the modes pushing that way decay (`bounded`) short of it
  // (`reach`).
  const until = (d, speed, bend, bounded, reach) => {
    if (d === Number.POSITIVE_INFINITY || (bounded && reach < d)) return Number.POSITIVE_INFINITY; // prettier-ignore
    if (!(bend > 0)) return speed > 0 ? d / speed : Number.POSITIVE_INFINITY;
    return (2 * d) / (speed + Math.sqrt(speed * speed + 2 * bend * d));
  };
  return () => {
    let least = Number.POSITIVE_INFINITY;
    for (let c = 0; c < pulls.length; c++) {
      if (!(below[c] > 0) || !(above[c] > 0)) return 0;
      const { real, ring } = pulls[c];
      let down = 0;
      let up = 0;
      let bend = 0;
      let downReach = 0;
      let upReach = 0;
      let downBounded = true;
      let upBounded = true;
      for (let x = 0; x < real.length; x += 2) {
        const m = real[x];
        const k = modes[m][0];
        const v = real[x + 1] * decay[m];
        if (v < 0) {
          down -= v;
          if (k < 0) downReach += v / k;
          else downBounded = false;
        } else {
          up += v;
          if (k < 0) upReach -= v / k;
          else upBounded = false;
        }
      }
      for (let x = 0; x < ring.length; x += 4) {
        // Re(rate·e^(λ·dt)): how fast it pushes now, and its bend.
        const m = ring[x];
        const v = decay[m] * (ring[x + 1] * cos[m] - ring[x + 2] * sin[m]);
        if (v < 0) down -= v;
        else up += v;
        bend += ring[x + 3] * decay[m];
        downBounded = upBounded = false;
      }
      least = Math.min(least, until(below[c], down, bend, downBounded, downReach), until(above[c], up, bend, upBounded, upReach)); // prettier-ignore
    }
    return least;
  };
}
