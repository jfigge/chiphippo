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
// reads from it (features/spice-lite-audit.md, phase B). Pure and DOM-free.
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
//          output a MOSFET that saturates), and each powered input's own:
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
  junctionCurrent,
  newtonSolve,
  pieces,
  touchingOf,
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
  CMOS_BAND_MA,
  CMOS_CLAMP,
  TTL_INPUT_MAX_V,
  inputThresholds,
  pinInputStages,
  pinOutputLimits,
  supplyMaOf,
} from "./params.js";
import { familyOf } from "../../catalog/families.js";
import { internalNet } from "./silicon.js";

/** Pin roles that READ a net. */
const READS = new Set(["input", "io"]);

/** Pin roles that DRIVE one. */
const DRIVES = new Set(["output", "io"]);

/** Each netlist's clusters (`voltageTopology`). */
const TOPOLOGY = new WeakMap();

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
        join(b, cc);
        join(b, e);
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
        devices.push({ key, comp: c.comp.id, kind: "m", p, a, b, g, aAt: where(ch.a), bAt: where(ch.b) }); // prettier-ignore
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
      clusters.push({ nets: [], resistors: [], junctions: [], channels: [], devices: [], loads: [], rails: new Set() }); // prettier-ignore
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
  for (const ch of channels) {
    const k = home(ch.a, ch.b);
    if (k == null) continue;
    clusters[k].channels.push(ch);
    touchRails(clusters[k], ch.a, ch.b);
  }
  for (const load of loads) {
    const k = home(load.a, load.b);
    if (k == null) continue;
    clusters[k].loads.push(load);
    touchRails(clusters[k], load.a, load.b);
  }
  // A MOSFET's cluster depends on its gate's voltage, solved elsewhere: a
  // gate that moves re-solves it. And a gate is a capacitance — left
  // floating it keeps its voltage (`gates`).
  const gateUsers = new Map(); // gate net → the clusters its MOSFETs are in
  const gates = new Set();
  for (const dev of devices) {
    const ends = dev.kind === "q" ? [dev.b, dev.c, dev.e] : [dev.a, dev.b];
    const k = ends.map((n) => clusterOf.get(n)).find((x) => x != null);
    if (k == null) continue;
    clusters[k].devices.push(dev);
    touchRails(clusters[k], ...ends);
    if (dev.kind === "m" && dev.g) {
      gates.add(dev.g);
      if (!gateUsers.has(dev.g)) gateUsers.set(dev.g, new Set());
      gateUsers.get(dev.g).add(k);
    }
  }

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
  const sources = new Map(); // net → {kind, id}
  for (const clk of ctx.clocks) {
    if (clk.outNet && !sources.has(clk.outNet)) sources.set(clk.outNet, { kind: "clock", id: clk.id }); // prettier-ignore
  }
  for (const sig of ctx.signals) {
    if (sig.net && !sources.has(sig.net)) sources.set(sig.net, { kind: "signal", id: sig.id }); // prettier-ignore
  }

  // The outputs and inputs on a rail itself (an output wired to ground, an
  // input tied high): nothing to solve, but current flows and stress shows.
  const railDrivers = [];
  const railReaders = [];
  for (const net of rails) {
    for (const d of drivers.get(net) ?? []) railDrivers.push({ d, net });
    for (const r of readers.get(net) ?? []) railReaders.push({ r, net });
  }

  // Where a transistor sits, the digital engine's own switch moves levels
  // that nothing the solve watches moves — so those nets' shown levels are
  // checked against it every pass.
  const watch = [];
  for (const cl of clusters) {
    if (!cl.devices.length) continue;
    for (const net of cl.nets) if (readers.has(net)) watch.push(net);
  }

  const topo = { rails, clusters, clusterOf, channels, devices, gates, gateUsers, railBranches, railDrivers, railReaders, readers, drivers, senseRefs, sources, sup, watch }; // prettier-ignore
  TOPOLOGY.set(netlist, topo);
  return topo;
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

/**
 * The chips' power, thresholds and stages, the rails and the bench sources,
 * as one context says — or, `atSet`, every supply at its SET voltage and
 * every chip on one at it too (the reading supply demand is measured at,
 * spice/supply.js), a chip its supply has dropped out of range still driving
 * what it last drove (else the load that pulled the supply down would vanish
 * with it, and the supply flicker back).
 */
function makePlan(ctx, config, sup, atSet) {
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
    const drives = ok || (atSet && c.status === CHIP_STATUS.UNDERPOWERED);
    const feed = sup.feeds.get(c.comp.id) ?? null;
    const icc = supplyMaOf(config, c.def, 5) / 1000;
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
    };
    if (drives && vcc > 0) {
      entry.high = outputStage(c.def, vcc, H);
      entry.low = outputStage(c.def, vcc, L);
      // A pin the silicon states its own stage for drives through that
      // (a discharge transistor); every other through the part's.
      const own = c.def.logic?.stages ?? null;
      entry.stageFor = (pin, level) => {
        if (own?.[pin]) return own[pin](vcc, level);
        return level === H ? entry.high : level === L ? entry.low : null;
      };
      entry.limitsFor = (pin) => pinOutputLimits(c.def, pin);
    }
    if (ok) {
      entry.th = { ...inputThresholds(config, c.def, vcc), schmitt: Boolean(c.def.schmitt) }; // prettier-ignore
      const stages = new Map(); // pin → its input stages
      entry.inputsFor = (pin) => {
        if (c.passive || c.analogSwitch) return NONE;
        let list = stages.get(pin);
        if (!list) stages.set(pin, (list = pinInputStages(c.def, vcc, pin)));
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
  const sourceHigh = sourceVolts(ctx);
  for (const [net, v] of sourceHigh) parts.push(`${net}^${v}`);
  return { chips, railVolts, vHigh, sourceHigh, signature: parts.join("|") };
}

/**
 * The voltage side of one Spice Lite tick. `prior` is what the last tick's
 * `snapshot()` returned (null at Run): the solved voltages and the readings
 * carry from tick to tick, as the levels do, so a tick's first pass reads
 * what its warm start says.
 * @param {object} opts
 * @param {object} opts.doc
 * @param {{netOfPoint: Map}} opts.netlist
 * @param {object} opts.config - normalized spice config
 * @param {object|null} opts.prior
 * @param {Map<string,string>} [opts.clockPhase]
 * @param {Map<string,string>} [opts.signalLevels]
 */
export function createVoltages({
  doc,
  netlist,
  config,
  prior = null,
  clockPhase: clocksAt = EMPTY,
  signalLevels: signalsAt = EMPTY,
}) {
  // What the bench sources hold — the tick's own, or, while a late tick
  // replays its history, the last tick's (`sources`).
  let clockPhase = clocksAt;
  let signalLevels = signalsAt;
  const fresh = prior?.netlist !== netlist;
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
  const reported = new Map(fresh ? [] : prior.reported); // cluster → its currents
  const stale = new Set(fresh ? [] : prior.stale); // clusters solved since reported
  let signature = fresh ? null : prior.signature;
  let burntUsed = fresh ? new Set() : prior.burntUsed;
  let setVolts = new Map(fresh ? [] : prior.setVolts); // the booking solve's warm start

  let topo = null;
  let ctxNow = null;
  const solvedAs = new Map(); // cluster → the network its last solve was, this tick
  let lastReport = null; // {plan, answer}: the last report, while nothing moved
  let plan = null; // the chips' power, thresholds and stages, per context
  let all = true; // every cluster is to be solved
  const dirty = new Set(); // cluster indices
  const disagree = new Map(fresh ? [] : prior.disagree); // net → shown ≠ digital
  let reread = new Set();
  let moved = false;
  let candidates = EMPTY; // the RC nodes' nets: their readings are spice/engine.js's
  let owned = new Set(); // reader keys spice/engine.js reads by their crossings
  let rcVolts = EMPTY; // RC node net → volts, for this settle
  let burnt = burntUsed;

  const markNet = (net) => {
    const k = topo?.clusterOf.get(net);
    if (k != null) dirty.add(k);
  };

  /** Read the chips' power off a new context; any change re-solves all. */
  function context(ctx) {
    topo = voltageTopology(doc, netlist, ctx);
    ctxNow = ctx;
    plan = makePlan(ctx, config, topo.sup, false);
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
    for (const [pin, level] of out) {
      if (was?.get(pin) !== level) markNet(c.pinNet.get(pin));
    }
    for (const pin of was?.keys() ?? []) {
      if (!out.has(pin)) markNet(c.pinNet.get(pin));
    }
  }

  /** A fixed net's volts this pass, or null: a source driving, an RC node
      (unless `free` — the node being linearized). */
  function fixedOf(net, free = false, p = plan, nodes = rcVolts) {
    // A bench source holds its net whatever a capacitor on it held a moment
    // ago — it is ideal; an RC node is held where its curve has it.
    const src = topo.sources.get(net);
    if (src) {
      const level = src.kind === "clock" ? clockPhase.get(src.id) : signalLevels.get(src.id); // prettier-ignore
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

  /** A net nothing holds forgets its voltage — unless it is a MOSFET's gate,
      whose capacitance keeps it. A gate that moved re-solves the clusters
      its MOSFETs are in. */
  function settleNet(net, v) {
    const was = volts.get(net);
    if (v == null) {
      auth.delete(net);
      if (!topo.gates.has(net)) volts.delete(net);
      return;
    }
    auth.add(net);
    volts.set(net, v);
    if (topo.gates.has(net) && !(Math.abs((was ?? 0) - v) <= 1e-9)) {
      for (const k of topo.gateUsers.get(net) ?? []) dirty.add(k);
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
   * One cluster as a network to solve (spice/network.js's shape), with the
   * nets it holds fixed, solved. `free` is a net whose own RC curve is NOT
   * applied (the node being linearized), `pin` one held at a voltage of the
   * caller's choosing; `p` the plan (the booking solve's, at SET), `guess`
   * where its unknowns start, `nodes` the RC nodes' voltages (this settle's,
   * unless the caller is reading what a node's moving does).
   */
  function network(
    k,
    { free = null, pin = null, p = plan, guess: warm = volts, nodes = rcVolts, exact = false } = {}, // prettier-ignore
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
      if (a !== b) branches.push({ kind: "r", a, b, ohms: l.ohms, aAt: l.aAt, bAt: l.bAt }); // prettier-ignore
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
      const chip = p.chips.get(dev.comp);
      // A CD4007UB unpowered is no transistor array (its substrate is its
      // supply); a discrete transistor needs none.
      if (!chip?.ok) continue;
      if (dev.kind === "q") {
        branches.push({ ...dev, b: nodeOf(dev.b), c: nodeOf(dev.c), e: nodeOf(dev.e) }); // prettier-ignore
      } else {
        // The gate: this cluster's own net, or a voltage from wherever it is
        // solved (fixed here, drawing nothing).
        let g = dev.g ? nodeOf(dev.g) : null;
        if (g == null) {
          g = `${dev.key}#gate`;
          fixed.set(g, 0);
        } else if (!cl.nets.includes(dev.g)) {
          fixed.set(g, gateVolts(dev.g, p));
        }
        branches.push({ ...dev, a: nodeOf(dev.a), b: nodeOf(dev.b), g });
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
    for (const net of cl.nets) {
      const node = nodeOf(net);
      for (const d of topo.drivers.get(net) ?? []) {
        const st = stageAt(d, p);
        if (!st) continue;
        add(drivers, node, st);
        add(outs, node, { stage: st, d });
        holds.add(node);
      }
      for (const r of topo.readers.get(net) ?? []) {
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
    for (const node of unknown) guess.set(node, warm.get(node) ?? p.vHigh / 2); // prettier-ignore
    const nw = { cl, nodeOf, nodes: unknown, touching, drivers, outs, branches, fixed, volts: guess, driven }; // prettier-ignore
    // A network solved to read a slope off is solved to the last bit: its
    // currents are differenced a millivolt apart.
    if (pin || exact) nw.tolerance = LINEARIZE_A;
    if (holds.size && unknown.length) newtonSolve(nw);
    // What is held: anything a resistive path reaches from a held node —
    // through a transistor only while it conducts, as it now stands.
    const vAt = (node) => fixed.get(node) ?? guess.get(node) ?? 0;
    const held = new Set(holds);
    const stack = [...holds];
    while (stack.length) {
      const node = stack.pop();
      for (const br of touching.get(node) ?? []) {
        let others;
        if (br.kind === "r") others = [br.a === node ? br.b : br.a];
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
    !cl.loads.length;

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
    if (isLone(cl)) {
      const net = cl.nets[0];
      const f = fixedOf(net);
      if (f != null) {
        settleNet(net, f);
        return cl.nets;
      }
      const { stages } = loneStages(net, plan);
      settleNet(net, stages.length ? solveDrivers(stages, volts.get(net) ?? stages[0].volts) : null); // prettier-ignore
      return cl.nets;
    }
    const nw = network(k);
    solvedAs.set(k, nw);
    for (const net of cl.nets) {
      const node = nw.nodeOf(net);
      settleNet(net, nw.held.has(node) ? (nw.fixed.get(node) ?? nw.volts.get(node)) : null); // prettier-ignore
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
    if (
      free.nodes.length > 1 ||
      free.branches.some((br) => br.kind === "q" || br.kind === "m")
    ) {
      // prettier-ignore
      const dir = amps < 0 ? -1 : 1;
      let end = siemens > 1e-8 ? v0 + amps / siemens : v0 + dir * (plan.vHigh + 1); // prettier-ignore
      for (const kv of kinks) if ((kv - v0) * dir > 0 && (kv - end) * dir < 0) end = kv; // prettier-ignore
      const corner = farCorner(k, net, v0 + dir * LINEARIZE_V, end);
      if (corner != null) kinks.push(corner);
    }
    return { driven: null, amps, siemens, kinks };
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
   * @param {Iterable<string>} watch
   * @param {Map<string, number>} at
   * @param {Map<string, number>} [dirs]
   */
  function affine(watch, at, dirs) {
    const out = new Map();
    const byCluster = new Map();
    for (const net of watch) {
      const k = topo?.clusterOf.get(net);
      const nodesIn = k == null ? null : topo.clusters[k].nets.filter((n) => at.has(n)); // prettier-ignore
      if (!nodesIn?.length) {
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
      const base = network(k, { nodes: at, exact: true });
      const v0 = new Map(nets.map((n) => [n, read(base, n)]));
      const terms = new Map(nets.map((n) => [n, new Map()]));
      for (const m of nodesIn) {
        const dv = (dirs?.get(m) ?? 1) < 0 ? -LINEARIZE_V : LINEARIZE_V;
        const nudged = new Map(at);
        nudged.set(m, at.get(m) + dv);
        const nw = network(k, { nodes: nudged, exact: true, guess: base.volts }); // prettier-ignore
        for (const n of nets) {
          const v1 = read(nw, n);
          const coef = v0.get(n) == null || v1 == null ? 0 : (v1 - v0.get(n)) / dv; // prettier-ignore
          if (Math.abs(coef) > 1e-9) terms.get(n).set(m, coef);
        }
      }
      for (const n of nets) {
        if (v0.get(n) == null) {
          out.set(n, null);
          continue;
        }
        let c0 = v0.get(n);
        for (const [m, coef] of terms.get(n)) c0 -= coef * at.get(m);
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
    if (!sense) return readingOf(chip.th, v, before);
    let d = v;
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
    if (all) {
      all = false;
      dirty.clear();
      stale.clear();
      reported.clear();
      solvedAs.clear();
      for (let k = 0; k < topo.clusters.length; k++) nets.push(...solveCluster(k)); // prettier-ignore
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
    for (let round = 0; dirty.size && round < GATE_ROUNDS; round++) {
      const ks = [...dirty];
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
   * began from (an analog switch's control is read off its own reading, or
   * that where the solve says nothing); `state` the parts' own. Returns `next`, or a
   * copy showing the readers' level wherever it is not the digital one.
   */
  function pass(next, { start, state }) {
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
          for (const [pin, net] of c.pinNet) pinLevels.set(pin, net ? (readings.get(net)?.get(readerKey(c.comp.id, pin)) ?? start.get(net) ?? Z) : Z); // prettier-ignore
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
      }
    }
    // The bench sources.
    for (const [net, src] of topo.sources) {
      const level = src.kind === "clock" ? clockPhase.get(src.id) : signalLevels.get(src.id); // prettier-ignore
      if (sourceUsed.get(net) !== level) {
        sourceUsed.set(net, level);
        markNet(net);
      }
    }
    const nets = solveDirty();
    for (const [net, v] of rcVolts) fixedUsed.set(net, v);
    for (const net of [...fixedUsed.keys()]) if (!rcVolts.has(net)) fixedUsed.delete(net); // prettier-ignore

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
  const blank = () => ({ leads: [], sources: [], returns: [], junctions: [], outputs: [], stress: [], extra: [], transistors: [] }); // prettier-ignore

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

  /** What every input on `net` (at `v` volts) suffers: a 74LS input past its
      absolute maximum, a CD4000 input past a rail (its protection diode's
      current — on a silicon `overRail` pin, only past the rating), and a
      CD4000 input in its undefined band (both its input
      transistors part-way on: `CMOS_BAND_MA` from its own supply) — not a
      comparator's (a silicon `sense` pin), whose input draws what its own
      stages say. */
  function inputFlow(entry, p, net, v) {
    for (const r of topo.readers.get(net) ?? []) {
      const chip = p.chips.get(r.comp);
      if (!chip?.ok) continue;
      if (chip.family === "74LS") {
        if (v > TTL_INPUT_MAX_V) entry.stress.push({ comp: r.comp, pin: r.pin, volts: v, family: "74LS" }); // prettier-ignore
        continue;
      }
      if (chip.family !== "CD4000") continue;
      let clamp = 0;
      for (const st of chip.inputsFor(r.pin)) if (st.clamp) clamp += Math.abs(stageCurrent(st, v)); // prettier-ignore
      const smoke = clamp * 1000 > CMOS_CLAMP.smokeMa;
      if (clamp > BOOK_FLOOR_A && (smoke || !chip.overRail.includes(r.pin))) {
        entry.stress.push({ comp: r.comp, pin: r.pin, volts: v, family: "CD4000", amps: clamp, smoke }); // prettier-ignore
      }
      if (
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
      const v = p === plan ? volts.get(net) : solveDrivers(stages, guess.get(net) ?? stages[0].volts); // prettier-ignore
      if (p !== plan) guess.set(net, v);
      for (const o of outs) stageFlow(entry, p, o, v);
      inputFlow(entry, p, net, v);
      return entry;
    }
    // The passes' own solve, where there was one this tick.
    const nw = (p === plan && solvedAs.get(k)) || network(k, { p, guess });
    if (p !== plan) for (const [node, v] of nw.volts) guess.set(node, v);
    const vAt = (node) => nw.fixed.get(node) ?? nw.volts.get(node) ?? 0;
    const nodePsu = new Map();
    const nodeMinus = new Set();
    for (const net of cl.rails) {
      const psu = topo.sup.psuOfNet.get(net);
      if (psu) nodePsu.set(nw.nodeOf(net), psu);
      if (topo.sup.minusNets.has(net)) nodeMinus.add(nw.nodeOf(net));
    }
    for (const br of nw.branches) {
      if (br.kind === "q" || br.kind === "m") {
        deviceFlow(entry, br, vAt, nodePsu, nodeMinus);
        continue;
      }
      if (!nw.held.has(br.a) && !nw.held.has(br.b)) continue;
      const vd = vAt(br.a) - vAt(br.b);
      const amps = br.kind === "r" ? vd / br.ohms : junctionCurrent(br, vd);
      if (br.kind === "j") entry.junctions.push([br.key, amps, vd]);
      if (br.aAt) entry.leads.push([br.aAt, amps]);
      if (br.bAt) entry.leads.push([br.bAt, -amps]);
      if (!(Math.abs(amps) > BOOK_FLOOR_A)) continue;
      const [from, fromAt, to, toAt] =
        amps > 0 ? [br.a, br.aAt, br.b, br.bAt] : [br.b, br.bAt, br.a, br.aAt];
      if (nodePsu.has(from)) entry.sources.push({ psu: nodePsu.get(from), amps: Math.abs(amps), plusAt: fromAt }); // prettier-ignore
      if (nodeMinus.has(to)) entry.returns.push({ amps: Math.abs(amps), minusAt: toAt }); // prettier-ignore
    }
    for (const [node, list] of nw.outs) {
      if (nw.fixed.has(node)) continue;
      for (const o of list) stageFlow(entry, p, o, vAt(node));
    }
    for (const net of cl.nets) {
      const node = nw.nodeOf(net);
      if (nw.held.has(node)) inputFlow(entry, p, net, vAt(node));
    }
    return entry;
  }

  /** A transistor's currents: through each of its leads, from a + rail or
      into a − one; and, for a discrete transistor, whether it conducts and
      whether its gate is floating on the charge it was left with. */
  function deviceFlow(entry, br, vAt, nodePsu, nodeMinus) {
    const flowsIn = deviceCurrents(br, vAt); // [node, amps into the network]
    const where = br.kind === "q" ? [br.bAt, br.cAt, br.eAt] : [br.aAt, br.bAt]; // prettier-ignore
    flowsIn.forEach(([node, amps], i) => {
      if (where[i]) entry.leads.push([where[i], -amps]);
      if (amps < -BOOK_FLOOR_A && nodePsu.has(node)) entry.sources.push({ psu: nodePsu.get(node), amps: -amps, plusAt: where[i] }); // prettier-ignore
      if (amps > BOOK_FLOOR_A && nodeMinus.has(node)) entry.returns.push({ amps, minusAt: where[i] }); // prettier-ignore
    });
    if (br.key !== br.comp) return; // one of a CD4007UB's: no lamp of its own
    const amps = Math.abs(flowsIn[br.kind === "q" ? 1 : 0][1]);
    const held = br.kind === "m" && br.g != null && !topo.rails.has(br.g) && !auth.has(br.g); // prettier-ignore
    entry.transistors.push([br.comp, { on: deviceConducts(br, vAt), held, amps }]); // prettier-ignore
  }

  /** What flows between and on the rails themselves, at the plan's rail
      voltages: the branches straight across them, an output wired to one,
      an input tied to one. */
  function railFlows(p) {
    const entry = blank();
    for (const br of topo.railBranches) {
      const vd = (p.railVolts.get(br.a) ?? 0) - (p.railVolts.get(br.b) ?? 0);
      if (br.kind === "j" && burnt.has(br.key)) continue;
      const amps = br.kind === "r" ? vd / br.ohms : junctionCurrent(br, vd);
      if (br.kind === "j") entry.junctions.push([br.key, amps, vd]);
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
   * reads them with every supply at its SET voltage (a fresh solve); else
   * from the passes' own solution — a cluster no pass has re-solved since
   * the last report keeps its answer.
   * @param {{atSet?: boolean}} [opts]
   */
  function report({ atSet = false } = {}) {
    if (!topo) return { junctions: new Map(), currents: new Map(), draws: [], outputs: [], stress: [], transistors: new Map() }; // prettier-ignore
    const entries = [];
    if (atSet) {
      const p = makePlan(ctxNow, config, topo.sup, true);
      const guess = new Map(setVolts);
      for (let k = 0; k < topo.clusters.length; k++) entries.push(flows(k, p, guess)); // prettier-ignore
      entries.push(railFlows(p));
      setVolts = guess;
    } else {
      // Nothing re-solved since the last report: it stands.
      if (!stale.size && lastReport?.plan === plan) return lastReport.answer;
      for (const k of stale) {
        reported.set(k, auth.has(topo.clusters[k].nets[0]) || !isLone(topo.clusters[k]) ? flows(k, plan, volts) : null); // prettier-ignore
      }
      stale.clear();
      for (const entry of reported.values()) if (entry) entries.push(entry);
      entries.push(railFlows(plan));
    }
    const junctions = new Map();
    const into = new Map();
    const draws = [];
    const outputs = [];
    const stress = [];
    const transistors = new Map();
    for (const e of entries) {
      for (const [comp, v] of e.transistors) transistors.set(comp, v);
      for (const [key, amps, vd] of e.junctions) junctions.set(key, { amps, volts: vd }); // prettier-ignore
      for (const [at, amps] of e.leads)
        into.set(at, (into.get(at) ?? 0) + amps);
      for (const [comp, pin, amps, watts, limits] of e.outputs) outputs.push({ comp, pin, amps, watts, limits }); // prettier-ignore
      stress.push(...e.stress);
      draws.push(...e.extra);
      if (!e.sources.length) continue;
      const back = e.returns.reduce((best, r) => (!best || r.amps > best.amps ? r : best), null); // prettier-ignore
      for (const s of e.sources) {
        draws.push({ chip: null, psu: s.psu, plusAt: s.plusAt ?? null, minusAt: back?.minusAt ?? null, amps: s.amps }); // prettier-ignore
      }
    }
    const currents = new Map();
    for (const [at, amps] of into) currents.set(at, Math.abs(amps));
    const answer = { junctions, currents, draws, outputs, stress, transistors };
    if (!atSet) lastReport = { plan, answer };
    return answer;
  }

  return {
    context,
    /** The network topology the last context was read with. */
    topology() {
      return topo;
    },
    linearize,
    current,
    affine,
    setNodes,
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
        volts,
        readings,
        shown,
        auth,
        used,
        channelOn,
        sourceUsed,
        fixedUsed,
        signature,
        burntUsed,
        disagree,
        reported,
        stale,
        setVolts,
      };
    },
  };
}
