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

// A desk document as an ngspice deck (features/done/spice-lite-3-plan.md, Phase 0):
// what `make spice-golden` hands ngspice to get the numbers Spice Lite is
// graded against. Test tooling only — nothing in the app reads it.
//
// It is GENERATED from the document, not written beside it, because a circuit
// written twice (once in JS, once in SPICE) is two circuits: the comparison
// that led to this plan lost four deck bugs that way. And it reads the
// circuit through Spice Lite's OWN readers — the netlist, `lampTopology`'s
// resistors and junctions, `capacitorNets`, each part's pins — so the deck
// cannot wire anything differently from the engine.
//
// Two flavours, the plan's two references:
//
//   "same"    Spice Lite's own models as behavioural sources: every junction,
//             transistor, input and output stage is the function the engine
//             evaluates (spice/leds.js, diodes.js, network.js, params.js,
//             output-stage.js), with the engine's own numbers. It grades the
//             ENGINE — is the solve right, given the models?
//   "device"  the real parts' models: a vendor card or a fit to the same
//             datasheet points Spice Lite cites (`DEVICE_MODELS`) for every
//             LED, diode and transistor, and a CMOS output as the level-1
//             MOSFET pair its B-series sheet is fitted to. It grades the
//             MODELS. Logic, thresholds and the 555's internals stay as the
//             engine states them: there is no device model of a comparator.
//
// A chip is a small library of behavioural blocks (`chipBlock`): a gate's
// unit (INV, NAND, …; a Schmitt input's hysteresis), and the NE555 as its
// silicon (spice/silicon.js) — its divider, its comparators, its latch and its
// discharge transistor. Anything else throws `unsupported`, so a case can
// never silently compare against half a circuit.

import { buildNetlist } from "../src/web/scripts/sim/netlist.js";
import { partDef } from "../src/web/scripts/catalog/index.js";
import { familyOf } from "../src/web/scripts/catalog/families.js";
import { partPinAddresses } from "../src/web/scripts/model/occupancy.js";
import { formatAddress } from "../src/web/scripts/model/breadboard.js";
import { lampTopology } from "../src/web/scripts/sim/spice/lamps.js";
import { capacitorNets } from "../src/web/scripts/sim/spice/engine.js";
import { GMIN_S, LEAK_S } from "../src/web/scripts/sim/spice/network.js";
import {
  BODY_DIODE,
  delayNs,
  inputThresholds,
  pinInputStages,
  stageStrength,
} from "../src/web/scripts/sim/spice/params.js";
import { outputStage } from "../src/web/scripts/sim/spice/output-stage.js";
import { normalizeSpiceConfig } from "../src/web/scripts/sim/spice/config.js";
import {
  internalNet,
  siliconOf,
} from "../src/web/scripts/sim/spice/silicon.js";
import { RESET_VOLTS } from "../src/web/scripts/sim/timer-555.js";
import { inductorTopology } from "../src/web/scripts/sim/spice/inductors.js";
import {
  BREAKDOWN_OHMS,
  transistorModel,
} from "../src/web/scripts/sim/spice/transistors.js";
import { transistorGrade } from "../src/web/scripts/catalog/discretes.js";

/**
 * The device models, by name. Units are SPICE's. Where a vendor publishes a
 * card it is that card verbatim; where none exists the model is fitted to the
 * datasheet points Spice Lite itself cites, so the two answer the same sheet.
 */
export const DEVICE_MODELS = Object.freeze({
  // Vendor cards (ON Semiconductor / Fairchild).
  D1N4148:
    "D(Is=2.682n N=1.836 Rs=.5664 Ikf=44.17m Cjo=4p M=.3333 Vj=.5 Bv=100 Ibv=100u Tt=11.54n)",
  Q2N3904:
    "NPN(Is=6.734f Xti=3 Eg=1.11 Vaf=74.03 Bf=416.4 Ne=1.259 Ise=6.734f Ikf=66.78m Xtb=1.5 Br=.7371 Nc=2 Isc=0 Ikr=0 Rc=1 Cjc=3.638p Mjc=.3085 Vjc=.75 Fc=.5 Cje=4.493p Mje=.2593 Vje=.75 Tr=239.5n Tf=301.2p Itf=.4 Vtf=4 Xtf=2 Rb=10)",
  Q2N2222:
    "NPN(Is=14.34f Xti=3 Eg=1.11 Vaf=74.03 Bf=255.9 Ne=1.307 Ise=14.34f Ikf=.2847 Xtb=1.5 Br=6.092 Nc=2 Isc=0 Ikr=0 Rc=1 Cjc=7.306p Mjc=.3416 Vjc=.75 Fc=.5 Cje=22.01p Mje=.377 Vje=.75 Tr=46.91n Tf=411.1p Itf=.6 Vtf=1.7 Xtf=3 Rb=10)",
  Q2N3906:
    "PNP(Is=1.41f Xti=3 Eg=1.11 Vaf=18.7 Bf=180.7 Ne=1.5 Ise=0 Ikf=80m Xtb=1.5 Br=4.977 Nc=2 Isc=0 Ikr=0 Rc=2.5 Cjc=9.728p Mjc=.5776 Vjc=.75 Fc=.5 Cje=8.063p Mje=.3677 Vje=.75 Tr=33.42n Tf=179.3p Itf=.4 Vtf=4 Xtf=6 Rb=10)",
  Q2N2907A:
    "PNP(Is=650.6E-18 Xti=3 Eg=1.11 Vaf=115.7 Bf=231.7 Ne=1.829 Ise=54.81f Ikf=1.079 Xtb=1.5 Br=3.563 Nc=2 Isc=0 Ikr=0 Rc=.715 Cjc=14.76p Mjc=.5383 Vjc=.75 Fc=.5 Cje=19.82p Mje=.3357 Vje=.75 Tr=111.3n Tf=603.7p Itf=.65 Vtf=5 Xtf=1.7 Rb=10)",
  // A B-series CMOS output (SCHS015C Figs. 1–4): 4.2 mA saturated at VDD
  // 5 V, ~400 Ω in its linear region — a level-1 pair.
  PCD4: "PMOS(LEVEL=1 VTO=-1.5 KP=0.686m)",
  NCD4: "NMOS(LEVEL=1 VTO=1.5 KP=0.686m)",
});

/** Which device model each part kind takes in the "device" flavour, unless a
    case names another (`opts.models`, by component id): the diode's vendor
    card, and each transistor GRADE's — its vendor card where the maker
    publishes one, else its own fit (spice/transistors.js) as a card
    (`gradeCard`). */
const DEFAULT_DEVICE = Object.freeze({ diode: "D1N4148" });
const GRADE_DEVICE = Object.freeze({
  npn: Object.freeze({ "small-signal": "Q2N3904", general: "Q2N2222" }),
  pnp: Object.freeze({ "small-signal": "Q2N3906", general: "Q2N2907A" }),
});

/** A grade's own figures as a SPICE card: a bipolar transistor's
    Gummel–Poon subset, a MOSFET's level 1. */
function gradeCard(type, m) {
  if (m.kind === "mosfet") {
    const sign = type === "pmos" ? -1 : 1;
    return `${type === "pmos" ? "PMOS" : "NMOS"}(LEVEL=1 VTO=${num(sign * m.vtoV)} KP=${num(m.kpA)} RD=${num(m.rdOhm ?? 0)})`; // prettier-ignore
  }
  const ise = m.iseA ? ` ISE=${num(m.iseA)} NE=${num(m.ne)}` : "";
  return `${type === "pnp" ? "PNP" : "NPN"}(IS=${num(m.isA)} BF=${num(m.bf)} IKF=${num(m.ikfA)} VAF=${num(m.vafV)} BR=${num(m.br)} RB=${num(m.rbOhm ?? 0)} RC=${num(m.rcOhm ?? 0)}${ise})`; // prettier-ignore
}

/** A unit's function of its inputs' readings (each 0…1), as SPICE. */
const GATES = Object.freeze({
  INV: ([a]) => `(1-${a})`,
  BUF: ([a]) => a,
  AND: (xs) => xs.join("*"),
  NAND: (xs) => `(1-${xs.join("*")})`,
  OR: (xs) => `(1-${xs.map((x) => `(1-${x})`).join("*")})`,
  NOR: (xs) => xs.map((x) => `(1-${x})`).join("*"),
  XOR: ([a, b]) => `(${a}+${b}-2*${a}*${b})`,
  XNOR: ([a, b]) => `(1-${a}-${b}+2*${a}*${b})`,
});

/** How far past a single trip point a comparator must be to switch, volts:
    Spice Lite's reads a crossing, never a band — a SMOOTH comparator (a tanh
    of any width) is an amplifier of finite gain, and an RC around one biases
    it into its linear region, where the two-gate oscillator crept for 2 ms
    an edge (2.5 % of its period) that the engine's ideal threshold never
    spends. A hair of hysteresis is the ideal comparator ngspice can step. */
const EDGE_V = 2e-3;

/** A stand-in for "no limit" in an expression, amps. */
const NO_LIMIT_A = 1e6;

/** The parasitic every node carries in a transient deck, farads: what lets
    ngspice step through a gate's edge. A picofarad against the microfarads
    these circuits time with moves nothing measurable. */
const NODE_PF = 1e-12;

/** The fastest a behavioural block's memory settles, seconds: a family-less
    part (the 555) switches "in one pass" (spice/params.js `delayNs`). */
const MIN_DELAY_S = 1e-9;

const num = (x) => {
  if (!Number.isFinite(x)) return String(x > 0 ? NO_LIMIT_A : -NO_LIMIT_A);
  return Number(x.toPrecision(12)).toString();
};

/** The current a stage (spice/output-stage.js's shape) puts INTO a node at
    `v` (an expression), as an expression. */
export function stageExpr(st, v) {
  const lim = Number.isFinite(st.limit) ? num(st.limit) : null;
  const ohms = num(st.ohms);
  const volts = num(st.volts);
  if (st.channel) {
    const i = `((${volts})-(${v}))/${ohms}`;
    return lim == null ? i : `max(-${lim},min(${lim},${i}))`;
  }
  const pushed = st.sources
    ? `max(0,((${volts})-(${v}))/${ohms})`
    : `max(0,((${v})-(${volts}))/${ohms})`;
  const amps = lim == null ? pushed : `min(${lim},${pushed})`;
  return st.sources ? amps : `-(${amps})`;
}

/** What a signal flag drives HIGH, volts (a bench's 5 V supply), and how
    fast it switches, seconds. */
const FLAG_VOLTS = 5;
const FLAG_EDGE_S = 1e-9;

/** The level a flag's schedule holds just before `at`. */
function prevLevel(steps, at) {
  let level = steps[0][1];
  for (const [t, lv] of steps) if (t < at) level = lv;
  return level;
}

/** An error a case can recognise: the deck has no block for this part. */
export class Unsupported extends Error {}

/**
 * The deck for a document.
 * @param {object} doc - a desk document (tests/timing-fixtures.js `bench()`)
 * @param {object} [opts]
 * @param {"same"|"device"} [opts.flavour]
 * @param {Record<string, string>} [opts.models] - component id → a
 *   `DEVICE_MODELS` name, in the device flavour
 * @param {boolean} [opts.bias] - false leaves out the comparators' input bias
 *   currents (the 555's THRES and TRIG): an ideal comparator
 * @param {object} [opts.config] - Spice Lite's setting (its defaults)
 * @param {{op?: boolean, tran?: {stop: number, step: number}}} opts.analysis
 * @param {string[]} [opts.probes] - addresses whose voltage is written
 * @param {string[]} [opts.lamps] - junction keys whose current is written
 * @param {string[]} [opts.coils] - inductor ids whose current is written
 * @param {Record<string, Array<[number, "high"|"low"]>>} [opts.signals] -
 *   each signal flag's levels from the times given (the first at 0)
 * @param {string} [opts.out] - the file `wrdata` writes (transient)
 * @returns {{text: string, vectors: string[]}}
 */
export function spiceDeck(doc, opts) {
  const {
    flavour = "same",
    models = {},
    signals = {},
    coils: coilProbes = [],
    bias = true,
    analysis,
    probes = [],
    lamps = [],
    out = "out.txt",
  } = opts;
  const config = normalizeSpiceConfig({ enabled: true, ...opts.config });
  const device = flavour === "device";
  // Spice Lite's own netlist: an inductor is a branch (spice/inductors.js).
  const netlist = buildNetlist(doc, new Map(), { inductors: "branch" });
  const netOf = (address) => netlist.netOfPoint.get(address) ?? null;
  const lines = [];
  const used = new Set();
  // An LED's device is its colour's own fit (spice/leds.js LED_SPECS: an
  // exponential through its Kingbright sheet's forward-current figure) —
  // the curve itself, where Spice Lite solves its table.
  const fits = new Map();
  const ledModel = (spec) => {
    const name = `LED_${spec.part.replace(/[^A-Za-z0-9]/g, "")}`;
    fits.set(name, `D(IS=${num(spec.isA)} N=${num(spec.n)} RS=${num(spec.rsOhm)})`); // prettier-ignore
    used.add(name);
    return name;
  };
  const modelOf = (name) => {
    if (!DEVICE_MODELS[name]) throw new Error(`no device model ${name}`);
    used.add(name);
    return name;
  };
  // A transistor grade with no vendor card: its own figures as one.
  const fit = (name, type, m) => {
    fits.set(name, gradeCard(type, m));
    used.add(name);
    return name;
  };

  // ── Nodes ─────────────────────────────────────────────────────────────
  // Every supply's − is ground (spice/supply.js: "every − is ground here");
  // its + a source at its set voltage. A supply's droop and current limit
  // are not stated: no golden circuit comes near them.
  const names = new Map();
  const plusVolts = new Map(); // + net → volts
  const supplies = (doc.components ?? []).filter((c) => c.kind === "psu");
  for (const psu of supplies) {
    const minus = netOf(formatAddress(psu.id, "-"));
    if (minus) names.set(minus, "0");
  }
  let seq = 0;
  const node = (net) => {
    if (!net) return null;
    let name = names.get(net);
    if (!name) {
      name = `n${++seq}`;
      names.set(net, name);
    }
    return name;
  };
  let inner = 0;
  const fresh = (stem) => `${stem}${++inner}`;
  // A state node read as a level 0…1: held to that range, so a node a step
  // past either end never turns a stage round.
  const level = (state) => `min(1,max(0,V(${state})))`;
  for (const psu of supplies) {
    const plus = netOf(formatAddress(psu.id, "+"));
    if (!plus) continue;
    const volts = Number(psu.params?.volts);
    plusVolts.set(plus, volts);
    lines.push(`V${psu.id} ${node(plus)} 0 ${num(volts)}`);
  }

  // ── Resistors and junctions, read as the engine reads them ────────────
  const lamp = lampTopology(doc, netlist);
  for (const [i, r] of lamp.resistors.entries()) {
    lines.push(`R${i + 1} ${node(r.a)} ${node(r.b)} ${num(r.ohms)}`);
  }
  const senseOf = new Map(); // junction key → its 0 V source
  for (const j of lamp.junctions) {
    if (!j.anode || !j.cathode || j.anode === j.cathode) continue;
    const id = j.key.replace(/[^A-Za-z0-9]/g, "_");
    let anode = node(j.anode);
    if (lamps.includes(j.key)) {
      // A 0 V source in series: its current is the junction's, anode first.
      const tap = fresh("s");
      lines.push(`VS${id} ${anode} ${tap} 0`);
      senseOf.set(j.key, `i(vs${id.toLowerCase()})`);
      anode = tap;
    }
    const cathode = node(j.cathode);
    if (device) {
      const name = models[j.comp]
        ? modelOf(models[j.comp])
        : j.diode
          ? modelOf(DEFAULT_DEVICE.diode)
          : ledModel(j.spec);
      lines.push(`D${id} ${anode} ${cathode} ${name}`);
      continue;
    }
    // Spice Lite's junction: its table (spice/junction-table.js), nothing
    // below its first point (and a Zener's breakdown), across its numerical
    // leakage. ngspice's pwl() runs on along its end segments, as the table.
    const vd = `V(${anode},${cathode})`;
    const s = j.spec;
    const points = [...s.table.v].map((v, k) => `${num(v)},${num(s.table.i[k])}`); // prettier-ignore
    let expr = `max(0,pwl(${vd},${points.join(",")}))`;
    if (j.diode && s.zenerV > 0) {
      expr += `+min(0,(${vd}+${num(s.zenerV)})/${num(s.rzOhm)})`;
    }
    lines.push(`BJ${id} ${anode} ${cathode} I=${expr}`);
    lines.push(`RJ${id} ${anode} ${cathode} ${num(1 / LEAK_S)}`);
  }

  // ── Capacitors (and nothing else stores) ──────────────────────────────
  for (const [id, { a, b }] of capacitorNets(doc, netlist)) {
    if (!a || !b || a === b) continue;
    const comp = doc.components.find((c) => c.id === id);
    lines.push(`C${id} ${node(a)} ${node(b)} ${num(comp.params.farads)} IC=0`);
  }

  // ── Inductors: L in series with its winding's resistance ───────────────
  const coilSense = new Map(); // inductor id → its current's vector
  for (const l of inductorTopology(doc, netlist)) {
    const mid = fresh("w");
    lines.push(`L${l.id} ${node(l.a)} ${mid} ${num(l.henries)} IC=0`);
    lines.push(`RL${l.id} ${mid} ${node(l.b)} ${num(l.ohms)}`);
    coilSense.set(l.id, `i(l${l.id.toLowerCase()})`);
  }

  // ── Signal flags: ideal sources, on a schedule ────────────────────────
  for (const sig of doc.signals ?? []) {
    const net = netOf(sig.flag?.anchor);
    if (!net) continue;
    const steps = signals[sig.id] ?? [[0, sig.rest ?? "low"]];
    const level = (x) => (x === "high" ? FLAG_VOLTS : 0);
    let pwl = `0 ${num(level(steps[0][1]))}`;
    for (const [at, lv] of steps.slice(1)) {
      pwl += ` ${num(at)} ${num(level(prevLevel(steps, at)))} ${num(at + FLAG_EDGE_S)} ${num(level(lv))}`; // prettier-ignore
    }
    lines.push(`VF${sig.id} ${node(net)} 0 PWL(${pwl})`);
  }

  // ── Transistors and chips ─────────────────────────────────────────────
  // How many leads each net holds — every part's pins and every wire's ends:
  // a net with only one chip pin in it reaches nothing.
  const leads = new Map(); // net → [owner id]
  const hold = (net, owner) => {
    if (!net) return;
    if (!leads.has(net)) leads.set(net, []);
    leads.get(net).push(owner);
  };
  for (const w of doc.wires ?? []) {
    hold(netOf(w.from), w.id);
    hold(netOf(w.to), w.id);
  }
  for (const comp of doc.components ?? []) {
    for (const p of partPinAddresses(doc, comp) ?? []) hold(netOf(p.address), comp.id); // prettier-ignore
  }
  const reaches = (net, self) => (leads.get(net) ?? []).some((o) => o !== self); // prettier-ignore
  const pinNets = (comp) => {
    const pins = partPinAddresses(doc, comp) ?? [];
    return new Map(pins.map((p) => [p.pin, netOf(p.address)]));
  };
  for (const comp of doc.components ?? []) {
    if (comp.kind === "psu" || comp.board == null) continue;
    const raw = partDef(comp.ref);
    if (!raw) continue;
    const type = raw.transistor?.type;
    if (type) {
      lines.push(...transistor(comp, type, pinNets(comp)));
      continue;
    }
    if (!raw.logic && !raw.silicon) continue; // passives, LEDs: above
    lines.push(...chipBlock(comp, siliconOf(raw), pinNets(comp)));
  }

  function transistor(comp, type, nets) {
    const [p1, p2, p3] = [1, 2, 3].map((n) => node(nets.get(n)));
    if (!p1 || !p2 || !p3) throw new Unsupported(`${comp.id}: a lead in no net`); // prettier-ignore
    const id = comp.id;
    const grade = transistorGrade(partDef(comp.ref), comp.params);
    const m = transistorModel(type, grade);
    const bipolar = type === "npn" || type === "pnp";
    if (device) {
      // E·B·C and S·G·D (catalog/discretes.js): a BJT is C B E in SPICE, a
      // MOSFET D G S B with its body on its source.
      if (m.kind === "darlington") {
        // Its sheet's two transistors and two resistors, as drawn.
        const mid = fresh("x");
        const q1 = fit(`Q${id}D`, type, m.q1);
        const q2 = fit(`Q${id}O`, type, m.q2);
        const col = fresh("c");
        return [
          `RC${id} ${p3} ${col} ${num(m.rcOhm > 0 ? m.rcOhm : 1e-6)}`,
          `Q${id}A ${col} ${p2} ${mid} ${q1}`,
          `Q${id}B ${col} ${mid} ${p1} ${q2}`,
          `RD1${id} ${p2} ${mid} ${num(m.r1Ohm)}`,
          `RD2${id} ${mid} ${p1} ${num(m.r2Ohm)}`,
        ];
      }
      const name = models[id] ? modelOf(models[id]) : GRADE_DEVICE[type]?.[grade] ? modelOf(GRADE_DEVICE[type][grade]) : fit(`${type.toUpperCase()}_${grade.replace(/-/g, "")}`, type, m); // prettier-ignore
      if (bipolar) return [`Q${id} ${p3} ${p2} ${p1} ${name}`];
      return [`M${id} ${p3} ${p2} ${p1} ${p1} ${name}`];
    }
    if (bipolar) {
      if (m.kind === "darlington") {
        throw new Unsupported(`${id}: a Darlington has no behavioural block`);
      }
      // spice/transistors.js `bjtCurrents`: E·B·C = 1·2·3, its tables as
      // pwl() (each running on along its end segments, as the tables do),
      // its collector resistance a resistor to an internal collector.
      const s = type === "pnp" ? -1 : 1;
      const [e, b, c] = [p1, p2, p3];
      const ci = m.rcOhm > 0 ? fresh("ci") : c;
      const vbe = `(${s}*V(${b},${e}))`;
      const vce = `(${s}*V(${ci},${e}))`;
      const pwl = (x, xs, ys) => `pwl(${x},${[...xs].map((v, k) => `${num(v)},${num(ys[k])}`).join(",")})`; // prettier-ignore
      const v0 = num(m.be.v[0]);
      const ibf = `(${vbe}<${v0}?0:${pwl(vbe, m.be.v, m.be.ib)})`;
      const tf = `(${vbe}<${v0}?0:${pwl(vbe, m.be.v, m.be.tf)})`;
      const qi = `(${vbe}<${v0}?1:${pwl(vbe, m.be.v, m.be.qi)})`;
      const vi = `(${vbe}<${v0}?${vbe}:${pwl(vbe, m.be.v, m.be.vi)})`;
      const vbc = `(${vi}-${vce})`;
      const ir = `(${vbc}<${num(m.bc.v[0])}?0:${pwl(vbc, m.bc.v, m.bc.i)})`;
      const ic = `((${tf}-${ir}*${qi})*(1-${vbc}/${num(m.vafV)})-${ir}/${num(m.br)})`; // prettier-ignore
      const ib = `(${ibf}+${ir}/${num(m.br)})`;
      // Its avalanche past VCEO, across its terminals.
      const over = `max(0,(${s}*V(${c},${e})-${num(m.vceoV)})/${num(BREAKDOWN_OHMS)})`; // prettier-ignore
      const out = [
        `BB${id} ${b} ${e} I=${s}*${ib}`,
        `BC${id} ${ci} ${e} I=${s}*${ic}`,
        `BV${id} ${c} ${e} I=${s}*${over}`,
      ];
      if (ci !== c) out.push(`RC${id} ${c} ${ci} ${num(m.rcOhm)}`);
      return out;
    }
    // spice/transistors.js `mosfetCurrent`: a square law from the source
    // end (the lower for N, the higher for P) behind its drain resistance,
    // current from the higher end to the lower — and its body diode and
    // avalanche (spice/network.js `bodyAmps`), a → b.
    const p = type === "pmos";
    const [a, g, b] = [p1, p2, p3];
    const hi = `max(V(${a}),V(${b}))`;
    const lo = `min(V(${a}),V(${b}))`;
    const vds = `(${hi}-${lo})`;
    const vov = `(${p ? `${hi}-V(${g})` : `V(${g})-${lo}`}-${num(m.vtoV)})`;
    const k = num(m.kpA);
    const r = num(m.rdOhm ?? 0);
    const sat = `(${k}/2*${vov}*${vov})`;
    const aa = `(1+${r}*${k}*${vov})`;
    const x = `(2*${vds}/(${aa}+sqrt(max(0,${aa}*${aa}-2*${r}*${k}*${vds}))))`;
    const lin = `(${k}*(${vov}*${x}-${x}*${x}/2))`;
    const id_ = `(${vov}>0?(${vds}>=${vov}+${r}*${sat}?${sat}:${lin}):0)`;
    const chan = `(V(${a},${b})>=0?${id_}:-${id_})`;
    const fwd = p ? `V(${b},${a})` : `V(${a},${b})`;
    const body = `max(0,(${fwd}-${num(BODY_DIODE.kneeV)})/${num(BODY_DIODE.rdOhm)})`; // prettier-ignore
    const blocked = `max(0,(-${fwd}-${num(m.vbrV)})/${num(BREAKDOWN_OHMS)})`;
    const extra = p ? `(${blocked}-${body})` : `(${body}-${blocked})`;
    return [`BM${id} ${a} ${b} I=${chan}+${extra}`];
  }

  function chipBlock(comp, def, nets) {
    const out = [];
    const id = comp.id;
    const vccPin = def.pins.find((p) => p.role === "vcc")?.n;
    const vcc = plusVolts.get(nets.get(vccPin));
    const grounded = def.pins
      .filter((p) => p.role === "gnd")
      .every((p) => names.get(nets.get(p.n)) === "0");
    if (!(vcc > 0) || !grounded) {
      throw new Unsupported(`${id}: only a chip across a supply's rails`);
    }
    const family = familyOf(def);
    const pin = (n) => {
      const net = nets.get(n);
      if (!net) throw new Unsupported(`${id}: pin ${n} in no net`);
      return node(net);
    };
    const v = (n) => `V(${pin(n)})`;
    // The delay a gate's output follows its inputs by: an RC whose 50 %
    // point is the engine's propagation delay.
    const ns = delayNs(config, def, vcc);
    const delay = Math.max(MIN_DELAY_S, (ns ?? 0) * 1e-9);
    const follow = (target, stem) => {
      const raw = fresh(`${stem}t`);
      const held = fresh(stem);
      out.push(`B${raw} ${raw} 0 V=${target}`);
      out.push(`R${raw} ${raw} ${held} 1k`);
      out.push(`C${raw} ${held} 0 ${num(delay / Math.LN2 / 1e3)}`);
      return held;
    };
    // A comparator reading `d` (an expression, volts) against {up, down}:
    // 1 above, 0 below — and between two points it holds (a Schmitt input),
    // regeneratively: a memory that held its own node's value would stop
    // part-way wherever its inputs let go.
    const reading = (d, up, down) => {
      if (up === down) {
        up += EDGE_V;
        down -= EDGE_V;
      }
      const mem = fresh("h");
      const raw = `${mem}r`;
      out.push(`B${raw} ${raw} 0 V=(${d})>${num(up)}?1:((${d})<${num(down)}?0:(V(${mem})>0.5?1:0))`); // prettier-ignore
      out.push(`R${raw} ${raw} ${mem} 1k`);
      out.push(`C${raw} ${mem} 0 1p`);
      return `V(${mem})`;
    };
    // An input pin's own stages (its bias, its clamps): its family's, or
    // the silicon's own (`pinInputStages`).
    const loadInput = (n, { skipBias = false } = {}) => {
      if (skipBias) return;
      for (const st of pinInputStages(def, vcc, n, config)) {
        out.push(`B${fresh("in")} 0 ${pin(n)} I=${stageExpr(st, v(n))}`);
      }
    };
    // An output pin driving its own stage, blended by a state 0…1 (1 HIGH).
    const drive = (n, state, stages = null) => {
      const hi = stages ? stages(vcc, "H", 1) : outputStage(def, vcc, "H", stageStrength(config, def, "H")); // prettier-ignore
      const lo = stages ? stages(vcc, "L", 1) : outputStage(def, vcc, "L", stageStrength(config, def, "L")); // prettier-ignore
      if (device && family === "CD4000" && !stages) {
        // The level-1 pair the B-series curves are fitted to, its gates
        // driven by the state.
        const gate = fresh("g");
        out.push(`B${gate} ${gate} 0 V=${num(vcc)}*(1-${level(state)})`);
        out.push(`MP${gate} ${pin(n)} ${gate} ${pin(vccPin)} ${pin(vccPin)} ${modelOf("PCD4")}`); // prettier-ignore
        out.push(`MN${gate} ${pin(n)} ${gate} 0 0 ${modelOf("NCD4")}`);
        return;
      }
      const terms = [];
      if (hi) terms.push(`${level(state)}*(${stageExpr(hi, v(n))})`);
      if (lo) terms.push(`(1-${level(state)})*(${stageExpr(lo, v(n))})`);
      if (terms.length) out.push(`B${fresh("o")} 0 ${pin(n)} I=${terms.join("+")}`); // prettier-ignore
    };

    if (comp.ref === "NE555") {
      // spice/silicon.js's 555 (sim/timer-555.js `ne555Silicon`): the
      // divider, three comparators, the latch, OUT and DISCH.
      const tap = node(internalNet(id, "tap"));
      for (const [k, r] of def.logic.internals.resistors.entries()) {
        const end = (x) => (typeof x === "number" ? pin(x) : node(internalNet(id, x))); // prettier-ignore
        out.push(`RI${id}_${k} ${end(r.a)} ${end(r.b)} ${num(r.ohms)}`);
      }
      const [TRIG, OUT, RESET, CONT, THRES, DISCH] = [2, 3, 4, 5, 6, 7];
      for (const n of [TRIG, THRES]) loadInput(n, { skipBias: !bias });
      loadInput(RESET);
      const trig = reading(`${v(TRIG)}-V(${tap})`, 0, 0);
      const thres = reading(`${v(THRES)}-${v(CONT)}`, 0, 0);
      const reset = reading(v(RESET), RESET_VOLTS, RESET_VOLTS);
      // The latch: RESET LOW clears and wins, TRIG below the tap sets, THRES
      // above CONT clears, otherwise it holds.
      const q = fresh("q");
      const raw = `${q}r`;
      out.push(`B${raw} ${raw} 0 V=${reset}<0.5?0:(${trig}<0.5?1:(${thres}>0.5?0:(V(${q})>0.5?1:0)))`); // prettier-ignore
      out.push(`R${raw} ${raw} ${q} 1k`);
      out.push(`C${raw} ${q} 0 ${num(delay / Math.LN2 / 1e3)}`);
      drive(OUT, q);
      // DISCH: the open collector, on while the latch is reset — switched by
      // the latch's settled level, never part-way: a discharge that began
      // while the latch was still turning would pull THRES back under CONT
      // before it had turned, and the deck would chatter there for ever.
      const lo = def.logic.stages[DISCH](vcc, "L");
      out.push(`B${fresh("d")} 0 ${pin(DISCH)} I=(V(${q})<0.5?1:0)*(${stageExpr(lo, v(DISCH))})`); // prettier-ignore
      return out;
    }

    const units = def.logic?.units;
    if (!units?.length || units.some((u) => !GATES[u.fn])) {
      throw new Unsupported(`${comp.ref}: no behavioural block`);
    }
    const th = inputThresholds(config, def, vcc);
    for (const u of units) {
      // A unit whose output reaches nothing is left out: a spare gate's
      // inputs float, and its output moves nothing.
      if (!reaches(nets.get(u.output), comp.id)) continue;
      const reads = u.inputs.map((n) => {
        if (!nets.get(n)) throw new Unsupported(`${id}: pin ${n} floats`);
        return reading(v(n), th.up, th.down);
      });
      for (const n of u.inputs) loadInput(n);
      drive(u.output, follow(GATES[u.fn](reads), "y"));
    }
    return out;
  }

  // ── Analysis ──────────────────────────────────────────────────────────
  const vectors = [
    ...probes.map((address) => {
      const net = netOf(address);
      if (!net) throw new Error(`probe ${address} is in no net`);
      const name = node(net);
      return name === "0" ? "0" : `v(${name})`;
    }),
    ...lamps.map((key) => {
      const sense = senseOf.get(key);
      if (!sense) throw new Error(`no junction ${key}`);
      return sense;
    }),
    ...coilProbes.map((id) => {
      const sense = coilSense.get(id);
      if (!sense) throw new Error(`no inductor ${id}`);
      return sense;
    }),
  ];
  const text = ["* chiphippo golden deck", ""];
  for (const name of used) text.push(`.model ${name} ${DEVICE_MODELS[name] ?? fits.get(name)}`); // prettier-ignore
  text.push(...lines);
  // Every node a teraohm to ground — the engine's GMIN — so a node only
  // one-way stages touch (an unloaded 555 OUT above its HIGH level) is held
  // where the engine holds it rather than wherever ngspice drifts it.
  for (const name of new Set(names.values())) {
    if (name !== "0") text.push(`RG${name} ${name} 0 ${num(1 / GMIN_S)}`);
  }
  if (analysis.tran) {
    // Every node a picofarad to ground, so a gate's edge has a slope.
    for (const name of new Set(names.values())) {
      if (name !== "0") text.push(`CP${name} ${name} 0 ${num(NODE_PF)}`);
    }
    const { stop, step } = analysis.tran;
    text.push(
      ".options method=gear reltol=1e-5 abstol=1e-13 vntol=1e-8",
      ".control",
      "set wr_singlescale",
      "set wr_vecnames",
      `tran ${num(step)} ${num(stop)} 0 ${num(step)} uic`,
      "linearize",
      `wrdata ${out} ${vectors.join(" ")}`,
      ".endc",
    );
  } else {
    text.push(".control", "op", ...vectors.map((x) => `print ${x}`), ".endc");
  }
  text.push(".end", "");
  return { text: text.join("\n"), vectors };
}
