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
//          output-stage.js: a 74LS HIGH is 3.6 V behind 120 Ω, a CD4000
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
//          element); every LED, segment, diode and Zener (a burnt one is
//          open); an analog switch channel switched on (its on-resistance,
//          its control read off its own voltage); and every transistor — a
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
import { lampTopology, sourceVolts } from "./lamps.js";
import {
  currentInto,
  deviceConducts,
  deviceCurrents,
  isDevice,
  junctionCurrent,
  newtonSolve,
  pieces,
  touchingOf,
  GMIN_S,
  TOLERANCE_A,
} from "./network.js";
import { supplyTopology } from "./supply.js";
import { ledKnee } from "./leds.js";
import {
  channelOhms,
  outputStage,
  stageCurrent,
  stageSlope,
} from "./output-stage.js";
import {
  BREAKDOWN,
  CMOS_BAND_MA,
  CMOS_CLAMP,
  SWITCH_LIMITS,
  TRANSISTOR_LIMITS,
  TTL_INPUT_MAX_V,
  inputThresholds,
  pinInputStages,
  pinOutputLimits,
  stageStrength,
  supplyMaOf,
  limitsAt,
} from "./params.js";
import { familyOf } from "../../catalog/families.js";
import { transistorCase } from "../../catalog/discretes.js";
import { formatAddress } from "../../model/breadboard.js";
import { internalNet } from "./silicon.js";
import { inductorTopology } from "./inductors.js";

/** Pin roles that READ a net. */
const READS = new Set(["input", "io"]);

/** Pin roles that DRIVE one. */
const DRIVES = new Set(["output", "io"]);

/** Each netlist's clusters (`voltageTopology`). */
const TOPOLOGY = new WeakMap();

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
 * is keyed by. Computed once per netlist, from the first context built on it.
 * @param {object} doc
 * @param {{netOfPoint: Map}} netlist
 * @param {object} ctx - sim/engine.js's context
 */
export function voltageTopology(doc, netlist, ctx) {
  const cached = TOPOLOGY.get(netlist);
  if (cached) return cached;
  const lamp = lampTopology(doc, netlist);
  const sup = supplyTopology(doc, netlist);
  const rails = new Set([...ctx.supplyPlusVolts.keys(), ...ctx.supplyMinus]);
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
    if (type === "npn" || type === "pnp") {
      const [e, b, cc] = [net(1), net(2), net(3)];
      if (b && cc && e) {
        devices.push({ key: c.comp.id, comp: c.comp.id, kind: "q", pnp: type === "pnp", b, c: cc, e, bAt: where(2), cAt: where(3), eAt: where(1) }); // prettier-ignore
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
        devices.push({ key, comp: c.comp.id, kind: "m", p, a, b, g, aAt: where(ch.a), bAt: where(ch.b), aPin: ch.a, bPin: ch.b, array: !type }); // prettier-ignore
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

  // A chip NOT straight across the rails draws its supply current through
  // whatever feeds it — a LOAD between its supply pins' nets, solved like any
  // branch (its value is its family's ICC, spice/params.js; `makePlan`).
  const plus = new Set(ctx.supplyPlusVolts.keys());
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
  }

  const clusters = [];
  const clusterOf = new Map(); // net → cluster index
  const byRoot = new Map();
  for (const net of [...ctx.netIds, ...innerNets]) {
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
      railBranches.push({ kind: "r", a: r.a, b: r.b, ohms: r.ohms, aAt: r.aAt, bAt: r.bAt }); // prettier-ignore
      continue;
    }
    clusters[k].resistors.push(r);
    touchRails(clusters[k], r.a, r.b);
  }
  for (const j of lamp.junctions) {
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
  // floating it keeps its voltage (`gates`).
  const gateUsers = new Map(); // gate net → the clusters its MOSFETs are in
  const gates = new Set();
  const railDevices = []; // every terminal on a rail: `railFlows` books them
  for (const dev of devices) {
    const ends = dev.kind === "q" ? [dev.b, dev.c, dev.e] : [dev.a, dev.b];
    const k = ends.map((n) => clusterOf.get(n)).find((x) => x != null);
    if (k == null) railDevices.push(dev);
    else {
      clusters[k].devices.push(dev);
      touchRails(clusters[k], ...ends);
    }
    if (dev.kind === "m" && dev.g) {
      gates.add(dev.g);
      if (!gateUsers.has(dev.g)) gateUsers.set(dev.g, new Set());
      // A rail device's gate re-reports the rails (`RAIL`).
      gateUsers.get(dev.g).add(k ?? RAIL);
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
  const readers = new Map(); // net → [{comp, pin}]
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
    for (const p of c.def.pins) {
      const net = c.pinNet.get(p.n);
      if (!net) continue;
      if (
        (READS.has(p.role) && !(c.analogSwitch && p.role === "io")) ||
        sense?.[p.n]
      ) {
        // prettier-ignore
        push(readers, net, { comp: c.comp.id, pin: p.n });
      }
      if ((DRIVES.has(p.role) && !c.analogSwitch) || drives?.includes(p.n)) {
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

  const topo = { rails, clusters, clusterOf, order, rank, channels, devices, gates, gateUsers, railBranches, railDevices, railDrivers, railReaders, readers, drivers, senseRefs, sources, clockPsu, offRail, sup, watch, coils, railCoils }; // prettier-ignore
  TOPOLOGY.set(netlist, topo);
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
    for (const s of e.sources) {
      draws.push({ chip: null, psu: s.psu, plusAt: s.plusAt ?? null, minusAt: back?.minusAt ?? null, amps: s.amps }); // prettier-ignore
    }
  }
  share = {
    junctions: e.junctions.map(([key, amps, vd]) => [key, { amps, volts: vd }]), // prettier-ignore
    outputs: e.outputs.map(([comp, pin, amps, watts, limits]) => ({ comp, pin, amps, watts, limits })), // prettier-ignore
    switches: e.switches.map(([comp, key, amps]) => ({ comp, key, amps, limits: SWITCH_LIMITS })), // prettier-ignore
    devices: e.devices.map(([comp, amps, watts, limits]) => ({ comp, amps, watts, limits })), // prettier-ignore
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

/** How closely a network is balanced to read that slope, amps. */
const LINEARIZE_A = 1e-15;

/** The least an inductor's current is nudged by to read its slope, amps. */
const LINEARIZE_I = 1e-6;

/**
 * The chips' power, thresholds and stages, the rails and the bench sources,
 * as one context says — or, `atSet`, every supply at its SET voltage and
 * every chip on one at it too (the reading supply demand is measured at,
 * spice/supply.js), a chip its supply has dropped out of range still driving
 * what it last drove (else the load that pulled the supply down would vanish
 * with it, and the supply flicker back).
 */
function makePlan(ctx, config, sup, atSet, offRail = EMPTY) {
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
      // through lets go (features/spice-lite-3-plan.md, Phase 3).
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
      entry.channelOhms = c.analogSwitch ? channelOhms(c.def, vcc) : 0;
    }
    chips.set(c.comp.id, entry);
  }
  const railVolts = new Map();
  let vHigh = 0;
  for (const [net, list] of ctx.supplyPlusVolts) {
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
  for (const [net, v] of sourceHigh) {
    if (v == null && lowestSet != null) sourceHigh.set(net, lowestSet);
    parts.push(`${net}^${sourceHigh.get(net)}`);
  }
  return { chips, railVolts, vHigh, sourceHigh, signature: parts.join("|") };
}

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
 */
export function createVoltages({
  doc,
  netlist,
  config,
  prior = null,
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
  const fresh = prior?.netlist !== netlist || prior.configKey !== configKey;
  // Copied, never mutated: an inner readings map is replaced, never edited,
  // so the outer copy is all a tick needs.
  const volts = new Map(fresh ? [] : prior.volts);
  const readings = new Map(fresh ? [] : prior.readings); // net → Map<comp, level>
  const shown = new Map(fresh ? [] : prior.shown); // net → the readers' level
  const auth = new Set(fresh ? [] : prior.auth);
  const used = new Map(fresh ? [] : prior.used); // comp → the outputs last solved with
  const channelOn = new Map(fresh ? [] : prior.channelOn); // channel key → H|L|X
  const sourceUsed = new Map(fresh ? [] : prior.sourceUsed); // net → level
  const fixedUsed = new Map(fresh ? [] : prior.fixedUsed); // RC net → volts
  const coilUsed = new Map(fresh ? [] : prior.coilUsed); // inductor → amps
  const reported = new Map(fresh ? [] : prior.reported); // cluster → its currents
  const stale = new Set(fresh ? [] : prior.stale); // clusters solved since reported
  // …and the same for the booking at SET (`report({atSet})`), with the plan
  // signature it was booked under.
  const setReported = new Map(fresh ? [] : prior.setReported);
  const setStale = new Set(fresh ? [] : prior.setStale);
  let setSignature = fresh ? null : prior.setSignature;
  // The clusters whose last solve could not balance (and the same at SET):
  // where they stopped is no answer to carry, and a solve from there may move
  // on — so each tick solves them again, as a full solve does.
  const unsettled = new Set(fresh ? [] : prior.unsettled);
  const setUnsettled = new Set(fresh ? [] : prior.setUnsettled);
  for (const k of setUnsettled) setStale.add(k);
  // Where each net NOTHING holds last solved — a floating anode, a lead held
  // only through a junction's leakage. Its voltage is the solver's noise (a
  // nanoamp of tolerance over a nanosiemens of leakage is a volt), so it is
  // never a reading; but it is the next solve's starting guess, so solving
  // an unchanged network again lands where it already stands rather than on
  // fresh noise from mid-supply.
  const loose = new Map(fresh ? [] : prior.loose);
  let signature = fresh ? null : prior.signature;
  let burntUsed = fresh ? new Set() : prior.burntUsed;
  const setVolts = new Map(fresh ? [] : prior.setVolts); // the booking solve's warm start

  let topo = null;
  let ctxNow = null;
  const solvedAs = new Map(); // cluster → the network its last solve was, this tick
  let lastReport = null; // {plan, answer}: the last report, while nothing moved
  let plan = null; // the chips' power, thresholds and stages, per context
  let all = fresh || full; // every cluster is to be solved
  const dirty = new Set(unsettled); // cluster indices
  const disagree = new Map(fresh ? [] : prior.disagree); // net → shown ≠ digital
  let reread = new Set();
  let moved = false;
  let candidates = EMPTY; // the RC nodes' nets: their readings are spice/engine.js's
  let owned = fresh ? new Set() : prior.owned; // reader keys spice/engine.js reads by their crossings
  let rcVolts = EMPTY; // RC node net → volts, for this settle
  let coilAmps = EMPTY; // inductor → amps, for this settle
  let burnt = burntUsed;
  // Something only the rails' own report reads moved (a channel or a MOSFET
  // straight across two rails): the next report is read afresh.
  let railMoved = false;

  const markNet = (net, other = null) => {
    const k = topo?.clusterOf.get(net) ?? topo?.clusterOf.get(other);
    if (k != null) dirty.add(k);
  };

  /** Read the chips' power off a new context; any change re-solves all. */
  function context(ctx) {
    topo = voltageTopology(doc, netlist, ctx);
    ctxNow = ctx;
    plan = makePlan(ctx, config, topo.sup, false, topo.offRail);
    if (plan.signature !== signature) {
      signature = plan.signature;
      all = true;
    }
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
    if (set.size !== burntUsed.size || [...set].some((k) => !burntUsed.has(k))) all = true; // prettier-ignore
    burnt = set;
  }

  /** A chip's outputs as this pass let them through. */
  function outputs(c, out) {
    const was = used.get(c.comp.id);
    if (was === out) return;
    used.set(c.comp.id, out);
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
    const wasHeld = gate && auth.has(net);
    if (v == null) {
      auth.delete(net);
      if (!gate) volts.delete(net);
      else if (wasHeld) gateMoved(net);
      return;
    }
    auth.add(net);
    volts.set(net, v);
    if (gate && (!wasHeld || !(Math.abs((was ?? 0) - v) <= 1e-9))) {
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

  /**
   * One cluster as a network to solve (spice/network.js's shape), with the
   * nets it holds fixed, solved. `free` is a net whose own RC curve is NOT
   * applied (the node being linearized), `pin` one held at a voltage of the
   * caller's choosing; `p` the plan (the booking solve's, at SET), `guess`
   * where its unknowns start, `nodes` the RC nodes' voltages (this settle's,
   * unless the caller is reading what a node's moving does).
   */
  function network(
    k,
    { free = null, pin = null, p = plan, guess: warm = volts, nodes = rcVolts, amps = coilAmps, exact = false } = {}, // prettier-ignore
  ) {
    const cl = topo.clusters[k];
    // What is held, strongest first: a rail, then a bench source, then an RC
    // node at its curve — so where a switched-on channel joins them, the
    // rail is what the joined nets are held at.
    const given = new Map(); // net → volts
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
    const fixed = new Map();
    for (const [net, v] of given) {
      const node = nodeOf(net);
      if (!fixed.has(node)) fixed.set(node, v);
    }
    // The node being linearized: driven outright by what it is joined to,
    // or pinned where the caller says.
    const driven = free != null && fixed.has(nodeOf(free)) ? fixed.get(nodeOf(free)) : null; // prettier-ignore
    if (pin && driven == null) fixed.set(nodeOf(pin.net), pin.volts);
    const branches = [];
    for (const r of cl.resistors) {
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
          branches.push({ kind: "s", key: `${comp}#${r.pin}#in`, comp, out: nodeOf(r.net), ref: gndNode, feed, stage: st, offset: st.volts }); // prettier-ignore
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
    const guess = new Map();
    for (const node of unknown) guess.set(node, warm.get(node) ?? loose.get(node) ?? p.vHigh / 2); // prettier-ignore
    const nw = { cl, nodeOf, nodes: unknown, touching, drivers, outs, branches, fixed, volts: guess, driven }; // prettier-ignore
    // A network solved to read a slope off is solved to the last bit: its
    // currents are differenced a millivolt apart.
    if (pin || exact) nw.tolerance = LINEARIZE_A;
    nw.balanced = holds.size && unknown.length ? newtonSolve(nw) : true;
    // What is held: anything a resistive path reaches from a held node —
    // through a transistor only while it conducts, as it now stands.
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

  /** Whether a cluster is one net with nothing but drivers on it. */
  const isLone = (cl) =>
    cl.nets.length === 1 &&
    !cl.resistors.length &&
    !cl.junctions.length &&
    !cl.channels.length &&
    !cl.devices.length &&
    !cl.loads.length &&
    !cl.inductors.length &&
    !cl.offChips.length;

  /** One lone net's stages (its outputs', and its 74LS inputs' own). */
  function loneStages(net, p) {
    const outs = [];
    for (const d of topo.drivers.get(net) ?? []) {
      const st = stageAt(d, p);
      if (st) outs.push({ stage: st, d });
    }
    const stages = outs.map((o) => o.stage);
    if (outs.length) {
      for (const r of topo.readers.get(net) ?? []) {
        const chip = p.chips.get(r.comp);
        if (chip?.ok) stages.push(...chip.inputsFor(r.pin));
      }
    }
    return { outs, stages };
  }

  /** Solve one cluster; returns its nets. */
  function solveCluster(k) {
    const cl = topo.clusters[k];
    stale.add(k);
    setStale.add(k);
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
      // 3.6 V and a CMOS input's clamp, which carries nothing from there to
      // its VDD + 0.5 V — and the answer must be the same however the net
      // got there (a carried solve and a fresh one alike).
      settleNet(net, stages.length ? solveDrivers(stages, stages[0].volts) : null); // prettier-ignore
      return cl.nets;
    }
    const nw = network(k);
    if (nw.balanced) unsettled.delete(k);
    else unsettled.add(k);
    solvedAs.set(k, nw);
    for (const net of cl.nets) {
      const node = nw.nodeOf(net);
      const held = nw.held.has(node);
      settleNet(net, held ? (nw.fixed.get(node) ?? nw.volts.get(node)) : null); // prettier-ignore
      if (held || !nw.volts.has(node)) loose.delete(node);
      else loose.set(node, nw.volts.get(node));
    }
    return cl.nets;
  }

  /**
   * An RC node, linearized where it stands (`v0` volts) — for spice/engine.js
   * to run its curve along: `{driven}` when a source or a closed transistor
   * holds it outright; else the current its network pushes into it there
   * (`amps`, its capacitors open), how fast that falls as it rises
   * (`siemens`), and the voltages ahead of it where that slope changes
   * (`kinks`: a stage's open-circuit level or the corner it saturates at, a
   * junction's knee against a fixed far side) — where the curve must be
   * linearized again. Null for a net no cluster holds (a rail).
   * @param {string} net
   * @param {number} v0
   */
  function linearize(net, v0) {
    const k = topo?.clusterOf.get(net);
    if (k == null) return null;
    const free = network(k, { free: net });
    if (free.driven != null) return { driven: free.driven };
    const node = free.nodeOf(net);
    const at = (v) => {
      const nw = network(k, { free: net, pin: { net, volts: v } });
      return currentInto(node, nw);
    };
    const amps = at(v0);
    // The slope of the segment the node is heading into.
    const dv = amps < 0 ? -LINEARIZE_V : LINEARIZE_V;
    const siemens = (amps - at(v0 + dv)) / dv;
    const kinks = [];
    for (const st of free.drivers.get(node) ?? []) {
      kinks.push(st.volts);
      if (Number.isFinite(st.limit)) {
        kinks.push(st.sources ? st.volts - st.limit * st.ohms : st.volts + st.limit * st.ohms); // prettier-ignore
        // A channel saturates the other way too.
        if (st.channel) kinks.push(st.sources ? st.volts + st.limit * st.ohms : st.volts - st.limit * st.ohms); // prettier-ignore
      }
    }
    for (const br of free.touching.get(node) ?? []) {
      if (br.kind !== "j") continue;
      const other = br.a === node ? br.b : br.a;
      const far = free.fixed.get(other);
      if (far == null) continue;
      const knee = br.diode ? br.spec.kneeV : ledKnee(br.spec);
      // Anode on the node: it conducts past far + knee; cathode: below far − knee.
      kinks.push(br.a === node ? far + knee : far - knee);
      if (br.diode && br.spec.zenerV > 0) {
        kinks.push(br.a === node ? far - br.spec.zenerV : far + br.spec.zenerV);
      }
    }
    // A corner further off in its network — a protection diode a resistor
    // away, a stage on the far side of one — is where the network's pieces
    // change as the node moves: searched toward where it is headed, as far
    // as its own nearest corner (or where it would settle).
    if (free.nodes.length > 1 || free.branches.some(isDevice)) {
      // prettier-ignore
      const dir = amps < 0 ? -1 : 1;
      let end = siemens > 1e-8 ? v0 + amps / siemens : v0 + dir * (plan.vHigh + 1); // prettier-ignore
      for (const kv of kinks) if ((kv - v0) * dir > 0 && (kv - end) * dir < 0) end = kv; // prettier-ignore
      const corner = farCorner(k, net, v0 + dir * LINEARIZE_V, end);
      if (corner != null) kinks.push(corner);
    }
    return { driven: null, amps, siemens, kinks };
  }

  /** The voltage a source holds an RC node at outright (a bench source, a
      switch closed onto a rail), or null where none does — a node free to
      run along its capacitors' charge. */
  function heldAt(net) {
    const k = topo?.clusterOf.get(net);
    if (k == null) return null;
    return network(k, { free: net }).driven;
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
          limit = BREAKDOWN.bjtV;
        } else if (br.kind === "m" && !br.array) {
          v = br.p ? vAt(br.a) - vAt(br.b) : vAt(br.b) - vAt(br.a);
          limit = BREAKDOWN.mosfetV;
        }
        if (v != null && v > limit) out.push({ comp: br.comp, volts: v, amps: (v - limit) / BREAKDOWN.ohms, cluster: k }); // prettier-ignore
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
   * @param {string[]} free
   * @param {Array<{id: string, a: string, b: string, ohms: number}>} coils
   * @param {Map<string, number>} at
   * @param {Map<string, number>} amps
   * @param {Map<string, number>} [dirs] - net or inductor id → ±1
   */
  function linearizeGroup(free, coils, at, amps, dirs) {
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
    const read = (nw, id) => nw.fixed.get(id) ?? nw.volts.get(id) ?? 0;
    for (const [k, own] of byCluster) {
      const base = network(k, { nodes: at, amps, exact: true });
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
      for (const i of states) {
        const coil = i >= nc ? coils[i - nc] : null;
        const key = coil ? coil.id : free[i];
        const up = (dirs?.get(key) ?? 1) >= 0;
        let nw;
        let dv;
        if (coil) {
          dv = (up ? 1 : -1) * Math.max(LINEARIZE_I, Math.abs(s0[i]) * 1e-6);
          const nudged = new Map(amps);
          nudged.set(coil.id, s0[i] + dv);
          nw = network(k, { nodes: at, amps: nudged, exact: true, guess: base.volts }); // prettier-ignore
        } else {
          dv = up ? LINEARIZE_V : -LINEARIZE_V;
          const nudged = new Map(at);
          nudged.set(free[i], s0[i] + dv);
          nw = network(k, { nodes: nudged, amps, exact: true, guess: base.volts }); // prettier-ignore
        }
        for (const [r, v] of out(nw)) {
          const was = g0.find(([x]) => x === r)[1];
          y[r][i] = -(v - was) / dv;
        }
        for (const id of ids) sens.get(id)[i] = (read(nw, id) - volts0.get(id)) / dv; // prettier-ignore
      }
      for (const j of own.coils) y[nc + j][nc + j] += coils[j].ohms;
      models.push({ base, ids, volts0, sens });
    }
    for (let i = 0; i < nc; i++) y[i][i] += GMIN_S;
    // g = g(s0) − Y·(s − s0), so i0 = g(s0) + Y·s0.
    const i0 = Float64Array.from(g, (x, i) => {
      let sum = x;
      for (let j = 0; j < n; j++) sum += y[i][j] * s0[j];
      return sum;
    });
    const piecesAt = (st) => {
      let out = "";
      for (const { base, ids, volts0, sens } of models) {
        const fixed = new Map(base.fixed);
        const volts = new Map(base.volts);
        for (const id of ids) {
          let x = volts0.get(id);
          const sv = sens.get(id);
          for (let j = 0; j < n; j++) x += sv[j] * (st[j] - s0[j]);
          (fixed.has(id) ? fixed : volts).set(id, x);
        }
        out += `${pieces({ drivers: base.drivers, branches: base.branches, fixed, volts })}|`; // prettier-ignore
      }
      return out;
    };
    return { y, i0, piecesAt };
  }

  /** The first voltage between `from` and `to` of an RC node where anything
      in its network changes piece (spice/network.js `pieces`), by bisection —
      or null where nothing does. */
  function farCorner(k, net, from, to) {
    if (!(Math.abs(to - from) > LINEARIZE_V)) return null;
    const piecesAt = (v) => pieces(network(k, { free: net, pin: { net, volts: v } })); // prettier-ignore
    const start = piecesAt(from);
    if (piecesAt(to) === start) return null;
    let lo = from;
    let hi = to;
    for (let i = 0; i < 48 && Math.abs(hi - lo) > 1e-7; i++) {
      const mid = (lo + hi) / 2;
      if (piecesAt(mid) === start) lo = mid;
      else hi = mid;
    }
    return hi;
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
        readings.delete(net);
        for (const key of old.keys()) reread.add(compOfKey(key));
        moved = true;
      }
      shown.delete(net);
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
        readings.delete(net);
        for (const key of old.keys()) reread.add(compOfKey(key));
        moved = true;
      }
      shown.delete(net);
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
      readings.set(net, next);
      for (const [key, reading] of next) {
        if (old?.get(key) !== reading) reread.add(compOfKey(key));
      }
      for (const key of old?.keys() ?? []) if (!next.has(key)) reread.add(compOfKey(key)); // prettier-ignore
      moved = true;
    }
    shown.set(net, level);
  }

  /** Solve every cluster something moved in (all, after a change of power);
      returns the nets solved, each re-read. */
  function solveDirty() {
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
      stale.clear();
      reported.clear();
      setStale.clear();
      setReported.clear();
      solvedAs.clear();
      for (const k of topo.order) nets.push(...solveCluster(k));
      // A rail holds its voltage whatever is drawn from it.
      for (const net of topo.rails) {
        volts.set(net, plan.railVolts.get(net) ?? 0);
        auth.add(net);
        nets.push(net);
      }
      burntUsed = new Set(burnt);
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
   * is not the digital one.
   */
  function pass(next, { start, state, read = null }) {
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
        channelOn.set(ch.key, on);
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
        sourceUsed.set(net, level);
        markNet(net);
      }
    }
    const nets = solveDirty();
    for (const [net, v] of rcVolts) fixedUsed.set(net, v);
    for (const net of [...fixedUsed.keys()]) if (!rcVolts.has(net)) fixedUsed.delete(net); // prettier-ignore
    for (const l of topo.coils) coilUsed.set(l.id, coilAmps.get(l.id) ?? 0);

    for (const net of topo.watch.length ? [...nets, ...topo.watch] : nets) {
      const level = shown.get(net);
      const digital = next.get(net);
      if (level != null && digital !== Z && level !== digital) {
        disagree.set(net, level);
      } else {
        disagree.delete(net);
      }
    }
    if (!disagree.size) return next;
    let out = next;
    for (const [net, level] of disagree) {
      const digital = next.get(net);
      if (digital === Z || digital == null) {
        disagree.delete(net);
        continue;
      }
      if (digital === level) continue;
      if (out === next) out = new Map(next);
      out.set(net, level);
    }
    return out;
  }

  // ── What flows ─────────────────────────────────────────────────────────

  /** An empty report entry. */
  const blank = () => ({ leads: [], sources: [], returns: [], junctions: [], outputs: [], stress: [], extra: [], transistors: [], switches: [], devices: [], brownouts: [] }); // prettier-ignore

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
    const into = (v) =>
      currentInto(node, network(k, { free: net, pin: { net, volts: v } }));
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
      if (chip.family === "74LS") {
        if (v > TTL_INPUT_MAX_V) entry.stress.push({ comp: r.comp, pin: r.pin, volts: v, family: "74LS" }); // prettier-ignore
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
      const { outs, stages } = loneStages(net, p);
      if (!outs.length) return entry;
      const v = p === plan ? volts.get(net) : solveDrivers(stages, stages[0].volts); // prettier-ignore
      if (p !== plan) guess.set(net, v);
      for (const o of outs) stageFlow(entry, p, o, v);
      inputFlow(entry, p, net, v);
      loadCheck(entry, p, net, v, outs.map((o) => ({ d: o.d, sources: o.stage.sources, open: o.stage.volts }))); // prettier-ignore
      return entry;
    }
    // The passes' own solve, where there was one this tick.
    const nw = (p === plan && solvedAs.get(k)) || network(k, { p, guess });
    if (p !== plan) {
      for (const [node, v] of nw.volts) guess.set(node, v);
      if (nw.balanced) setUnsettled.delete(k);
      else setUnsettled.add(k);
    }
    const vAt = (node) => nw.fixed.get(node) ?? nw.volts.get(node) ?? 0;
    const nodePsu = new Map();
    const nodeMinus = new Set();
    const supplyAt = new Map(); // node → where its current really enters
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
      if (br.kind === "s") {
        stageBranchFlow(entry, br, vAt, nodePsu, nodeMinus, p);
        continue;
      }
      if (!nw.held.has(br.a) && !nw.held.has(br.b)) continue;
      const vd = vAt(br.a) - vAt(br.b);
      const amps = br.kind === "r" ? vd / br.ohms : br.kind === "l" ? br.amps : junctionCurrent(br, vd); // prettier-ignore
      if (br.kind === "j") entry.junctions.push([br.key, amps, vd]);
      if (br.channel) entry.switches.push([br.comp, br.channel, Math.abs(amps)]); // prettier-ignore
      if (br.aAt) entry.leads.push([br.aAt, amps]);
      if (br.bAt) entry.leads.push([br.bAt, -amps]);
      if (!(Math.abs(amps) > BOOK_FLOOR_A)) continue;
      const [from, fromAt, to, toAt] =
        amps > 0 ? [br.a, br.aAt, br.b, br.bAt] : [br.b, br.bAt, br.a, br.aAt];
      if (nodePsu.has(from)) entry.sources.push({ psu: nodePsu.get(from), amps: Math.abs(amps), plusAt: supplyAt.get(from) ?? fromAt }); // prettier-ignore
      if (nodeMinus.has(to)) entry.returns.push({ amps: Math.abs(amps), minusAt: supplyAt.get(to) ?? toAt }); // prettier-ignore
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
    if (!br.d) return; // an input's own stage: inside its chip's ICC
    if (br.outAt) entry.leads.push([br.outAt, -amps]);
    if (br.feedAt) entry.leads.push([br.feedAt, amps]);
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
      if (amps > BOOK_FLOOR_A && nodeMinus.has(node)) entry.returns.push({ amps, minusAt: where[i] }); // prettier-ignore
    });
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
    // its kind's common limits (spice/params.js TRANSISTOR_LIMITS).
    let watts = 0;
    for (const [node, into] of flowsIn) watts -= vAt(node) * into;
    const c = p.chips.get(br.comp)?.c;
    const limits =
      br.kind === "q"
        ? TRANSISTOR_LIMITS.bjt
        : TRANSISTOR_LIMITS[transistorCase(c?.def, c?.comp.params)];
    if (limits && amps > BOOK_FLOOR_A) entry.devices.push([br.comp, amps, Math.max(0, watts), limits]); // prettier-ignore
  }

  /** What flows between and on the rails themselves, at the plan's rail
      voltages: the branches straight across them, an output wired to one,
      an input tied to one. */
  function railFlows(p) {
    const entry = blank();
    const railAt = (net) => p.railVolts.get(net) ?? 0;
    for (const br of topo.railBranches) {
      const vd = railAt(br.a) - railAt(br.b);
      if (br.kind === "j" && burnt.has(br.key)) continue;
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
      if (br.kind === "ch") entry.switches.push([br.ch.comp, br.ch.key, Math.abs(amps)]); // prettier-ignore
      if (br.aAt) entry.leads.push([br.aAt, amps]);
      if (br.bAt) entry.leads.push([br.bAt, -amps]);
      if (!(Math.abs(amps) > BOOK_FLOOR_A)) continue;
      const [from, fromAt, to, toAt] =
        amps > 0 ? [br.a, br.aAt, br.b, br.bAt] : [br.b, br.bAt, br.a, br.aAt];
      const psu = topo.sup.psuOfNet.get(from);
      if (psu)
        entry.sources.push({ psu, amps: Math.abs(amps), plusAt: fromAt });
      if (topo.sup.minusNets.has(to)) entry.returns.push({ amps: Math.abs(amps), minusAt: toAt }); // prettier-ignore
    }
    // A transistor with every end on a rail: a MOSFET from + to −, say — a
    // short through its channel, which the supply delivers.
    const gates = new Map(); // a gate the solve holds elsewhere → its volts
    for (const dev of topo.railDevices) {
      const br = deviceBranch(dev, p, (net) => net, (g, v) => gates.set(g, v), () => false); // prettier-ignore
      if (!br) continue;
      const vAt = (node) => gates.get(node) ?? railAt(node);
      deviceFlow(entry, br, vAt, topo.sup.psuOfNet, topo.sup.minusNets, p);
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
    if (!topo) return { junctions: new Map(), currents: new Map(), draws: [], outputs: [], stress: [], transistors: new Map(), switches: [], devices: [], brownouts: [] }; // prettier-ignore
    if (atSet) {
      const p = makePlan(ctxNow, config, topo.sup, true, topo.offRail);
      const every = p.signature !== setSignature;
      setSignature = p.signature;
      const draws = [];
      for (let k = 0; k < topo.clusters.length; k++) {
        let entry = setReported.get(k);
        if (every || !entry || setStale.has(k)) {
          setReported.set(k, (entry = flows(k, p, setVolts)));
          if (stats) stats.bookings = (stats.bookings ?? 0) + 1;
        }
        draws.push(...shareOf(entry).draws);
      }
      setStale.clear();
      draws.push(...shareOf(railFlows(p)).draws);
      return { draws };
    }
    // Nothing re-solved since the last report: it stands.
    if (!stale.size && !railMoved && lastReport?.plan === plan) return lastReport.answer; // prettier-ignore
    railMoved = false;
    for (const k of stale) {
      reported.set(k, auth.has(topo.clusters[k].nets[0]) || !isLone(topo.clusters[k]) ? flows(k, plan, volts) : null); // prettier-ignore
    }
    stale.clear();
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
    for (const e of entries) {
      const own = shareOf(e);
      for (const [comp, v] of e.transistors) transistors.set(comp, v);
      for (const [key, j] of own.junctions) junctions.set(key, j);
      for (const [at, amps] of e.leads)
        into.set(at, (into.get(at) ?? 0) + amps);
      outputs.push(...own.outputs);
      stress.push(...e.stress);
      draws.push(...own.draws);
      switches.push(...own.switches);
      devices.push(...own.devices);
      brownouts.push(...own.brownouts);
    }
    // Each hole's current a magnitude — in place: the sums are done.
    for (const [at, amps] of into) into.set(at, Math.abs(amps));
    const currents = into;
    const answer = { junctions, currents, draws, outputs, stress, transistors, switches, devices, brownouts }; // prettier-ignore
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
    currentsAt,
    kicks,
    heldAt,
    current,
    affine,
    setNodes,
    setCoils,
    setBurnt,
    outputs,
    pass,
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
    },
    /** Solve, outside a pass, whatever a burnt junction moved. */
    resolve() {
      if (topo) solveDirty();
    },
    /** What `comp`'s `pin` reads on `net`, or null where the voltage says
        nothing. */
    reading(comp, pin, net) {
      return readings.get(net)?.get(readerKey(comp, pin)) ?? null;
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
    /** What the next tick starts from. */
    snapshot() {
      return {
        netlist,
        configKey,
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
        disagree,
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
