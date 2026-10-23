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
//             MOSFET pair its B-series figures set, per supply
//             (`cmosChannel`). It grades the MODELS. Logic, thresholds and the 555's internals stay as the
//             engine states them: there is no device model of a comparator.
//             Except a 74LS gate (an inverter or a NAND): that is its
//             datasheet schematic, transistor by transistor (`lsGate`), so
//             its input current, its threshold and both output levels are
//             the circuit's own.
//
// A chip is a small library of behavioural blocks (`chipBlock`): a gate's
// unit (INV, NAND, …; a Schmitt input's hysteresis), the NE555 as its
// silicon (spice/silicon.js) — its divider, its comparators, its latch and its
// discharge transistor — and a ULN2003A as its channels' Darlingtons. The
// bench parts (an optocoupler, an op-amp, a regulator, an electronic load)
// are their laws (spice/analog-devices.js) as B-sources in either flavour:
// no maker publishes a model of them to grade the law against, so a case
// grades the SOLVE on them (`benchBlock`). A clock brick putting out a wave
// is the ideal source Spice Lite makes it (`waveSource`), an AC supply its
// sine and a transformer two coupled coils. Anything else
// throws `unsupported`, so a case can never silently compare against half a
// circuit.

import { buildNetlist } from "../src/web/scripts/sim/netlist.js";
import { partDef } from "../src/web/scripts/catalog/index.js";
import { familyOf } from "../src/web/scripts/catalog/families.js";
import { partPinAddresses } from "../src/web/scripts/model/occupancy.js";
import { formatAddress } from "../src/web/scripts/model/breadboard.js";
import { lampTopology } from "../src/web/scripts/sim/spice/lamps.js";
import { capacitorNets } from "../src/web/scripts/sim/spice/engine.js";
import { GMIN_S, LEAK_S } from "../src/web/scripts/sim/spice/network.js";
import { BODY_SPEC } from "../src/web/scripts/sim/spice/diodes.js";
import {
  delayNs,
  inputThresholds,
  pinInputStages,
  stageStrength,
} from "../src/web/scripts/sim/spice/params.js";
import {
  SPLITTER_SAT_V,
  SPLITTER_UA,
  outputStage,
  splitterUnits,
  stageCorners,
} from "../src/web/scripts/sim/spice/output-stage.js";
import { normalizeSpiceConfig } from "../src/web/scripts/sim/spice/config.js";
import {
  internalNet,
  siliconOf,
} from "../src/web/scripts/sim/spice/silicon.js";
import { RESET_VOLTS } from "../src/web/scripts/sim/timer-555.js";
import {
  inductorTopology,
  transformerResistors,
} from "../src/web/scripts/sim/spice/inductors.js";
import { acSupplies } from "../src/web/scripts/sim/spice/ac-supplies.js";
import { floatingGrounds } from "../src/web/scripts/sim/floating-grounds.js";
import { transistorModelFor } from "../src/web/scripts/sim/spice/transistor-figures.js";
import {
  ARRAY_MODELS,
  BREAKDOWN_OHMS,
} from "../src/web/scripts/sim/spice/transistors.js";
import {
  AC_INSULATION_OHMS,
  AC_SOURCE_OHMS,
  PSU_LIMIT_SIEMENS,
  PSU_OUTPUT_F,
  PSU_SOURCE_OHMS,
  LOAD_CP_STEPS,
  LOAD_CV_OHMS,
  LOAD_MAX_A,
  LOAD_RON,
  OPTO,
  OPTO_TRANSFER,
  QUIESCENT_HEAD_V,
  REGULATOR_DIVIDER_S,
} from "../src/web/scripts/sim/spice/analog-devices.js";
import { benchDevices } from "../src/web/scripts/sim/spice/bench-parts.js";
import { LEVEL_WAVES } from "../src/web/scripts/catalog/parts.js";
import {
  TRAPEZOID_RAMP,
  acSwing,
  waveSwing,
} from "../src/web/scripts/sim/spice/waves.js";
import { clockHalves } from "../src/web/scripts/sim/schedule.js";
import {
  transistorCustom,
  transistorGrade,
} from "../src/web/scripts/catalog/discretes.js";

/**
 * The device models, by name. Units are SPICE's. Where a vendor publishes a
 * card it is that card verbatim; where none exists the model is fitted to the
 * datasheet points Spice Lite itself cites, so the two answer the same sheet.
 */
export const DEVICE_MODELS = Object.freeze({
  // Vendor cards (ON Semiconductor / Fairchild).
  D1N4148:
    "D(Is=2.682n N=1.836 Rs=.5664 Ikf=44.17m Cjo=4p M=.3333 Vj=.5 Bv=100 Ibv=100u Tt=11.54n)",
  // The rectifier die a bridge rectifier holds (spice/diodes.js BRIDGE_SPEC),
  // and the 1 A rectifier diode grade's.
  D1N4007:
    "D(Is=7.02767n N=1.80803 Rs=.0341512 Cjo=10p M=.5 Vj=.7 Tt=100n Bv=1000 Ibv=98.5655u)",
  // The power-rectifier and Schottky diode grades: no vendor card, so the
  // datasheet fits spice/diodes.js states (POWER_CURVE, SCHOTTKY_CURVE), DC
  // only.
  D1N5408: "D(Is=224n N=1.86 Rs=5.5m Ikf=.794)",
  D1N5819: "D(Is=299u N=1.7 Rs=35.9m)",
  Q2N3904:
    "NPN(Is=6.734f Xti=3 Eg=1.11 Vaf=74.03 Bf=416.4 Ne=1.259 Ise=6.734f Ikf=66.78m Xtb=1.5 Br=.7371 Nc=2 Isc=0 Ikr=0 Rc=1 Cjc=3.638p Mjc=.3085 Vjc=.75 Fc=.5 Cje=4.493p Mje=.2593 Vje=.75 Tr=239.5n Tf=301.2p Itf=.4 Vtf=4 Xtf=2 Rb=10)",
  Q2N2222:
    "NPN(Is=14.34f Xti=3 Eg=1.11 Vaf=74.03 Bf=255.9 Ne=1.307 Ise=14.34f Ikf=.2847 Xtb=1.5 Br=6.092 Nc=2 Isc=0 Ikr=0 Rc=1 Cjc=7.306p Mjc=.3416 Vjc=.75 Fc=.5 Cje=22.01p Mje=.377 Vje=.75 Tr=46.91n Tf=411.1p Itf=.6 Vtf=1.7 Xtf=3 Rb=10)",
  Q2N3906:
    "PNP(Is=1.41f Xti=3 Eg=1.11 Vaf=18.7 Bf=180.7 Ne=1.5 Ise=0 Ikf=80m Xtb=1.5 Br=4.977 Nc=2 Isc=0 Ikr=0 Rc=2.5 Cjc=9.728p Mjc=.5776 Vjc=.75 Fc=.5 Cje=8.063p Mje=.3677 Vje=.75 Tr=33.42n Tf=179.3p Itf=.4 Vtf=4 Xtf=6 Rb=10)",
  Q2N2907A:
    "PNP(Is=650.6E-18 Xti=3 Eg=1.11 Vaf=115.7 Bf=231.7 Ne=1.829 Ise=54.81f Ikf=1.079 Xtb=1.5 Br=3.563 Nc=2 Isc=0 Ikr=0 Rc=.715 Cjc=14.76p Mjc=.5383 Vjc=.75 Fc=.5 Cje=19.82p Mje=.3357 Vje=.75 Tr=111.3n Tf=603.7p Itf=.65 Vtf=5 Xtf=1.7 Rb=10)",
  // A 74LS gate's own devices (`lsGate`) — no maker publishes a card for a
  // transistor inside a chip, so these are FITTED: plain integrated-circuit
  // figures, tuned until the schematic below lands on the sheet's typicals
  // at VCC = 4.75 V (SN74LS04, SDLS029C): VOH 3.37 V at −0.4 mA (typ 3.4),
  // VOL 0.30 V at 4 mA (typ 0.25) and 0.35 V at 8 mA (typ 0.35), IIL
  // −0.18 mA at 0.4 V (max −0.4), switching at about 0.94 V.
  QLS: "NPN(IS=5e-16 BF=60 BR=1 RB=30 RC=10)",
  QLSO: "NPN(IS=1.5e-15 BF=60 BR=1 RB=10 RC=5 RE=6)",
  DLS: "D(IS=1e-11 N=1.05 RS=10)",
});

/**
 * A 74LS gate as its transistors: SN74LS04's "schematics (each gate)"
 * (SDLS029C p. 4), every input a Schottky diode into the phase splitter's
 * base (an LS NAND is the same circuit with one diode per input — DTL), with
 * its own clamp to ground. Every Schottky-clamped transistor is an NPN with a
 * Schottky diode base → collector; the Darlington's upper transistor is not
 * clamped (it never saturates). Ports: the inputs, then Y, VCC, GND.
 */
function lsGate(inputs) {
  const ins = Array.from({ length: inputs }, (_, k) => `A${k + 1}`);
  return [
    `.subckt LSGATE${inputs} ${ins.join(" ")} Y VCC GND`,
    "R20 VCC B1 20k",
    ...ins.flatMap((a) => [`DI${a} B1 ${a} DLS`, `DC${a} GND ${a} DLS`]),
    "R12 B1 E1 12k",
    "Q1 C1 B1 E1 QLS",
    "DQ1 B1 C1 DLS",
    "R8 VCC C1 8k",
    "Q3 C3 C1 E3 QLS",
    "DQ3 C1 C3 DLS",
    "R120 VCC C3 120",
    "DSP E3 C1 DLS",
    "Q4 C3 E3 Y QLSO",
    "R4 E3 Y 4k",
    "DYC Y C1 DLS",
    "Q5 Y E1 GND QLSO",
    "DQ5 E1 Y DLS",
    "R15 E1 B6 1.5k",
    "R3 E1 C6 3k",
    "Q6 C6 B6 GND QLS",
    "DQ6 B6 C6 DLS",
    ".ends",
  ];
}

/** The gates `lsGate` draws: an inverter is its one-input NAND. */
const LS_GATES = Object.freeze({ INV: 1, NAND: null });

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
  if (st.vov || st.corners) return curveExpr(st, v);
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

/** Past every voltage a deck reaches, volts: where a curve's pwl() is
    pinned flat, since pwl() runs on along its end segments. */
const CURVE_END_V = 1e3;

/** A curved stage (spice/output-stage.js's square law, as its chords) as an
    expression: pwl() through every chord corner, flat past saturation. */
function curveExpr(st, v) {
  const ahead = [...stageCorners(st), [CURVE_END_V, st.limit]];
  // A channel delivers the other way along the same curve; a one-way stage
  // delivers nothing.
  const behind = st.channel
    ? ahead
        .slice(1)
        .map(([d, i]) => [-d, -i])
        .reverse()
    : [[-CURVE_END_V, 0]];
  const points = [...behind, ...ahead].map(([d, i]) => `${num(d)},${num(i)}`); // prettier-ignore
  const d = st.sources || st.channel ? `((${num(st.volts)})-(${v}))` : `((${v})-(${num(st.volts)}))`; // prettier-ignore
  const amps = `pwl(${d},${points.join(",")})`;
  return st.sources || st.channel ? amps : `-(${amps})`;
}

/** A CP load's P / V as an expression in `v`: pwl() through the chords'
    corners (analog-devices.js `LOAD_CP_STEPS`), from an octave under where
    RON's line or the ceiling hands over to them up to CURVE_END_V. */
function powerExpr(watts, v) {
  const from = Math.min(Math.sqrt(watts * LOAD_RON), watts / LOAD_MAX_A);
  const at = (k) => 2 ** (k / LOAD_CP_STEPS);
  const points = [];
  let k = Math.floor(LOAD_CP_STEPS * Math.log2(from)) - LOAD_CP_STEPS;
  for (; at(k - 1) < CURVE_END_V; k++) {
    points.push(`${num(at(k))},${num(watts / at(k))}`);
  }
  // (Past its last point pwl() runs on down through zero: never below it.)
  return `max(0,pwl(${v},${points.join(",")}))`;
}

/** A 74LS splitter's current (spice/output-stage.js `splitterAmps`) for
    inputs at `ins` and its output at `out` (expressions), as an expression:
    the lowest input along its table, flat past both ends, falling to
    nothing below SPLITTER_SAT_V on the output. */
function splitterExpr(ins, out) {
  const low = ins.reduce((a, b) => `min(${a},${b})`);
  const ends = SPLITTER_UA[SPLITTER_UA.length - 1];
  const points = [[-CURVE_END_V, 0], ...SPLITTER_UA, [CURVE_END_V, ends[1]]];
  const table = points.map(([x, ua]) => `${num(x)},${num(ua / 1e6)}`).join(",");
  return `pwl(${low},${table})*min(1,max(0,(${out})/${num(SPLITTER_SAT_V)}))`;
}

/** A CD4000 output's level-1 transistor (`"pmos"` its HIGH, `"nmos"` its
    LOW) as the figures `gradeCard` writes: the square law its stage is,
    driven at VGS = VDD — VTO = VDD − vov, KP = 2·limit / vov². */
export function cmosChannel(st, vcc) {
  if (!st?.vov) throw new Unsupported("a CD4000 output with no square law (VDD ≤ 2 V)"); // prettier-ignore
  return { kind: "mosfet", vtoV: vcc - st.vov, kpA: (2 * st.limit) / st.vov ** 2 }; // prettier-ignore
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

/**
 * A clock brick's wave (spice/waves.js `waveVolts`) as an ngspice source
 * spec: from Run, LOW half first, each half `half` seconds, swinging `lo` to
 * `hi` (`waveSwing`) — a SIN for the sine (its centre less half its swing
 * times cos 2πft), else a PWL through every corner to `stop`, a sawtooth's
 * drop one edge (`FLAG_EDGE_S`) long. (Clipped at the rails by its caller.)
 */
function waveSource(wave, half, { lo, hi }, stop) {
  const period = 2 * half;
  const span = hi - lo;
  if (wave === "sine") {
    return `SIN(${num((lo + hi) / 2)} ${num(span / 2)} ${num(1 / period)} 0 0 -90)`; // prettier-ignore
  }
  const r = TRAPEZOID_RAMP;
  // Each period's corners, [phase, shape 0…1], from its start.
  const corners = {
    triangle: [
      [0, 0],
      [0.5, 1],
    ],
    trapezoid: [
      [0, 0],
      [0.5 - r, 0],
      [0.5, 1],
      [1 - r, 1],
    ],
    "ramp-up": [
      [0, 0],
      [1, 1, true],
    ],
    "ramp-down": [
      [0, 1],
      [1, 0, true],
    ],
  }[wave];
  if (!corners) throw new Unsupported(`a ${wave} clock has no wave source`);
  // Every period that begins before `stop`, and the one after: a PWL holds
  // its last value past its last point.
  const points = [];
  for (let k = 0; k * period <= stop + period; k++) {
    for (const [phase, shape, edge] of corners) {
      points.push([(k + phase) * period - (edge ? FLAG_EDGE_S : 0), lo + span * shape]); // prettier-ignore
    }
  }
  return `PWL(${points.map(([t, v]) => `${num(t)} ${num(v)}`).join(" ")})`;
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
  // A CD4000 output's transistor at its supply and strength: one card per
  // distinct set of figures.
  const channelCards = new Map();
  // The transistor-level 74LS gates the deck uses, by input count.
  const subckts = new Map();
  const channelModel = (type, st, vcc) => {
    const m = cmosChannel(st, vcc);
    const card = gradeCard(type, m);
    if (!channelCards.has(card)) channelCards.set(card, `${type === "pmos" ? "P" : "N"}CD4_${channelCards.size + 1}`); // prettier-ignore
    return fit(channelCards.get(card), type, m);
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
  // The mains' N is a − rail too (sim/engine.js buildContext, under Spice
  // Lite), and so is each AC adapter's floating circuit's ground
  // (sim/floating-grounds.js).
  const mains = acSupplies(doc, netlist);
  for (const ac of mains) if (ac.neutral && !ac.isolated) names.set(ac.neutral, "0"); // prettier-ignore
  for (const net of floatingGrounds(doc, netlist).values()) names.set(net, "0"); // prettier-ignore
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
    // A supply whose current limit a case sets is its set voltage behind
    // its own resistance, never past that limit (spice/analog-devices.js
    // "p" — which the engine holds it by while it is on it), past its knee
    // the limit behind its own conductance — with its output capacitor
    // across it (`PSU_OUTPUT_F`), at its set voltage from the start: the
    // engine starts it empty only for a capacitor's inrush at Run, which no
    // case is.
    const limit = Number(psu.params?.currentLimit);
    if (limit > 0) {
      const knee = volts - limit * PSU_SOURCE_OHMS;
      lines.push(`BPSU${psu.id} 0 ${node(plus)} I=V(${node(plus)})>${num(knee)}?(${num(volts)}-V(${node(plus)}))/${num(PSU_SOURCE_OHMS)}:${num(limit)}+(${num(knee)}-V(${node(plus)}))*${num(PSU_LIMIT_SIEMENS)}`); // prettier-ignore
      lines.push(`CPSU${psu.id} ${node(plus)} 0 ${num(PSU_OUTPUT_F)} IC=${num(volts)}`); // prettier-ignore
      continue;
    }
    lines.push(`V${psu.id} ${node(plus)} 0 ${num(volts)}`);
  }
  // Its L a sine about N, from Run on its way up (spice/waves.js acSwing,
  // acGenerator) — a frequency edited mid-run is no case here. An AC
  // ADAPTER's sine floats with its S2, behind its own resistance, S2
  // insulated from ground (spice/analog-devices.js "v"); its circuit's
  // ground is named "0" above.
  for (const ac of mains) {
    if (!ac.line || !ac.neutral) continue;
    const { lo, hi } = acSwing(ac.params);
    const sine = `SIN(${num((lo + hi) / 2)} ${num((hi - lo) / 2)} ${num(ac.params.hz)})`; // prettier-ignore
    if (!ac.isolated) {
      lines.push(`VAC${ac.id} ${node(ac.line)} 0 ${sine}`);
      continue;
    }
    const w = fresh("ac");
    lines.push(
      `VAC${ac.id} ${w} ${node(ac.neutral)} ${sine}`,
      `RAC${ac.id} ${w} ${node(ac.line)} ${num(ac.ohms ?? AC_SOURCE_OHMS)}`,
      `RACI${ac.id} ${node(ac.neutral)} 0 ${num(AC_INSULATION_OHMS)}`,
    );
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
          ? modelOf(j.spec.device ?? DEFAULT_DEVICE.diode)
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
    // A transformer's two windings coupled (spice/inductors.js
    // transformerWindings: M = k·√(L1·L2)).
    if (l.couple && l.winding === "primary") {
      const other = inductorTopology(doc, netlist).find((x) => x.id === l.couple.id); // prettier-ignore
      lines.push(`K${l.comp} L${l.id} L${other.id} ${num(l.couple.henries / Math.sqrt(l.henries * other.henries))}`); // prettier-ignore
    }
  }
  // Its windings' shunts and the insulation between them, as the engine
  // solves them.
  for (const [i, r] of transformerResistors(doc, netlist).entries()) {
    lines.push(`RT${i + 1} ${node(r.a)} ${node(r.b)} ${num(r.ohms)}`);
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

  // ── Clock bricks putting out a wave: ideal sources ────────────────────
  // (spice/engine.js: a wave holds its net, 0 V to its own supply.) A
  // square or a PWM is a level, driven like an output: no block.
  const clockDef = partDef("clock");
  const stop = analysis.tran?.stop ?? 0;
  for (const clk of (doc.components ?? []).filter((c) => c.kind === "clock")) {
    const out = netOf(formatAddress(clk.id, "out"));
    if (!out) continue;
    const wave = clockDef.waveOf(clk.params);
    if (LEVEL_WAVES.includes(wave) || !clockDef.isAuto(clk.params)) {
      throw new Unsupported(`${clk.id}: a ${wave} clock has no source`);
    }
    const high = plusVolts.get(netOf(formatAddress(clk.id, "vcc")));
    const gnd = netOf(formatAddress(clk.id, "gnd"));
    if (!(high > 0) || names.get(gnd) !== "0") {
      throw new Unsupported(`${clk.id}: only a clock across a supply's rails`);
    }
    const { low } = clockHalves(clk.params.hz, clockDef.dutyOf(clk.params));
    const swing = waveSwing(clk.params, high);
    if (swing.lo >= swing.floor && swing.hi <= swing.ceil) {
      lines.push(`VK${clk.id} ${node(out)} 0 ${waveSource(wave, low, swing, stop)}`); // prettier-ignore
    } else {
      // Past a rail: the wave as set, clipped at the rails.
      const raw = fresh("k");
      lines.push(`VK${clk.id} ${raw} 0 ${waveSource(wave, low, swing, stop)}`); // prettier-ignore
      lines.push(`BK${clk.id} ${node(out)} 0 V=max(${num(swing.floor)},min(${num(swing.ceil)},V(${raw})))`); // prettier-ignore
    }
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
    if (raw.optocoupler || raw.opAmps) continue; // `benchBlock`, below
    lines.push(...chipBlock(comp, siliconOf(raw), pinNets(comp)));
  }
  for (const br of benchDevices(doc, netlist)) lines.push(...benchBlock(br));

  /** A bench device (spice/analog-devices.js `analogCurrents`) as
      B-sources: each `B a b I=…` carries its current from a through it to
      b. */
  function benchBlock(br) {
    // An AC adapter is its source, above.
    if (br.kind === "v") return [];
    const id = br.key.replace(/[^A-Za-z0-9]/g, "_");
    const v = (net) => `V(${node(net)})`;
    const clamp = (x, lo, hi) => `min(${hi},max(${lo},${x}))`;
    if (br.kind === "o") {
      // Its LED, the junction table; its phototransistor CTR × IF along its
      // transfer (`OPTO_TRANSFER`, IF itself past its last corner), never
      // past its saturation (`OPTO`: nothing below its knee, then RSAT).
      const vd = `V(${node(br.a)},${node(br.k)})`;
      const t = br.spec.table;
      const points = [...t.v].map((x, k) => `${num(x)},${num(t.i[k])}`).join(","); // prettier-ignore
      const led = `(${vd}>0?max(0,pwl(${vd},${points})):0)`;
      const vce = `V(${node(br.c)},${node(br.e)})`;
      const sat = `(max(0,${vce}-${num(OPTO.kneeV)})/${num(OPTO.rsatOhm)})`;
      const transfer = [...OPTO_TRANSFER, [CURVE_END_V, CURVE_END_V]].map(([i, g]) => `${num(i)},${num(g)}`).join(","); // prettier-ignore
      return [
        `BOL${id} ${node(br.a)} ${node(br.k)} I=${led}`,
        `BOC${id} ${node(br.c)} ${node(br.e)} I=(${vce}>0?min(${num(br.ctr)}*pwl(${led},${transfer}),${sat}):0)`, // prettier-ignore
      ];
    }
    if (br.kind === "a") {
      // Its gain about the middle of its swing, clamped to the swing (an
      // open collector's at its bottom only), behind its output resistance
      // and its two current limits.
      const m = br.amp;
      const lo = `(${v(br.gnd)}+${num(m.lowV)})`;
      const hi = `max(${lo},${v(br.vcc)}-${num(m.headroomV)})`;
      const raw = `(${lo}+${hi})/2+${num(m.gain)}*(${v(br.inp)}-${v(br.inn)})`;
      const level = m.openCollector ? `max(${lo},${raw})` : clamp(raw, lo, hi);
      const i = clamp(`(${level}-${v(br.out)})/${num(m.rOut)}`, `-${num(m.sinkA)}`, num(m.sourceA)); // prettier-ignore
      return [
        `BAS${id} ${node(br.vcc)} ${node(br.out)} I=max(0,${i})`,
        `BAK${id} ${node(br.out)} ${node(br.gnd)} I=max(0,-(${i}))`,
      ];
    }
    if (br.kind === "g") {
      // OUT held its reference above REF behind its output resistance,
      // never above IN less its dropout, sourced only, to its limit; its
      // quiescent current IN → REF, a line through zero below
      // QUIESCENT_HEAD_V of headroom (analog-devices.js `regulatorQuiescent`).
      const r = br.reg;
      const target = `min(${v(br.ref)}+${num(r.vref)},${v(br.inp)}-${num(r.dropoutV)})`; // prettier-ignore
      const i = clamp(`(${target}-${v(br.out)})/${num(r.rOut)}`, 0, num(r.limitA)); // prettier-ignore
      const head = `min(1,(${v(br.inp)}-${v(br.ref)})/${num(QUIESCENT_HEAD_V)})`; // prettier-ignore
      return [
        `BGO${id} ${node(br.inp)} ${node(br.out)} I=${i}`,
        `BGQ${id} ${node(br.inp)} ${node(br.ref)} I=${num(r.quiescentA)}*${head}`,
        // Its feedback divider (analog-devices.js `REGULATOR_DIVIDER_S`).
        `RGD${id} ${node(br.out)} ${node(br.ref)} ${num(1 / REGULATOR_DIVIDER_S)}`,
      ];
    }
    // An electronic load (analog-devices.js `loadLaw`): constant current
    // (V / RON until its setting), constant resistance, constant voltage
    // (nothing to its setting, then CV_OHMS an amp) or constant power (P / V
    // through the same chords) — the last two never past RON's line nor its
    // ceiling — sinking only.
    const vl = `V(${node(br.pos)},${node(br.neg)})`;
    const line = `max(0,${vl})/${num(LOAD_RON)}`;
    const ceiling = num(LOAD_MAX_A);
    // prettier-ignore
    const amps =
      br.mode === "cr" ? (br.ohms > 0 ? `max(0,${vl})/${num(br.ohms)}` : "0")
      : br.mode === "cv" ? `min(${line},min(${ceiling},max(0,${vl}-${num(br.volts)})/${num(LOAD_CV_OHMS)}))`
      : br.mode === "cp" ? (br.watts > 0 ? `min(${line},min(${ceiling},${powerExpr(br.watts, vl)}))` : "0")
      : `min(${num(br.amps)},${line})`;
    return [`BE${id} ${node(br.pos)} ${node(br.neg)} I=${amps}`];
  }

  function transistor(comp, type, nets) {
    const [p1, p2, p3] = [1, 2, 3].map((n) => node(nets.get(n)));
    if (!p1 || !p2 || !p3) throw new Unsupported(`${comp.id}: a lead in no net`); // prettier-ignore
    const id = comp.id;
    const grade = transistorGrade(partDef(comp.ref), comp.params);
    // A custom grade (spice/transistor-figures.js) is its own fit, never its
    // base grade's vendor card.
    const custom = transistorCustom(partDef(comp.ref), comp.params);
    const m = transistorModelFor(type, grade, custom);
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
      const name = models[id] ? modelOf(models[id]) : !custom && GRADE_DEVICE[type]?.[grade] ? modelOf(GRADE_DEVICE[type][grade]) : fit(custom ? `${type.toUpperCase()}_C${id}` : `${type.toUpperCase()}_${grade.replace(/-/g, "")}`, type, m); // prettier-ignore
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
    const bodyPoints = [...BODY_SPEC.table.v].map((v, n) => `${num(v)},${num(BODY_SPEC.table.i[n])}`); // prettier-ignore
    const body = `(${fwd}>0?max(0,pwl(${fwd},${bodyPoints.join(",")})):0)`;
    const blocked = `max(0,(-${fwd}-${num(m.vbrV)})/${num(BREAKDOWN_OHMS)})`;
    const extra = p ? `(${blocked}-${body})` : `(${body}-${blocked})`;
    return [`BM${id} ${a} ${b} I=${chan}+${extra}`];
  }

  function chipBlock(comp, def, nets) {
    const out = [];
    const id = comp.id;
    if (def.bipolarArray) return arrayBlock(comp, def, nets);
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
        // The level-1 pair the B-series stage is the square law of, its
        // gates driven by the state.
        const gate = fresh("g");
        out.push(`B${gate} ${gate} 0 V=${num(vcc)}*(1-${level(state)})`);
        out.push(`MP${gate} ${pin(n)} ${gate} ${pin(vccPin)} ${pin(vccPin)} ${channelModel("pmos", hi, vcc)}`); // prettier-ignore
        out.push(
          `MN${gate} ${pin(n)} ${gate} 0 0 ${channelModel("nmos", lo, vcc)}`,
        );
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

    // The package's own resistors (a monostable's CX tied to VSS inside).
    for (const [k, r] of (def.logic?.internals?.resistors ?? []).entries()) {
      const end = (x) => (typeof x === "number" ? (nets.get(x) ? pin(x) : null) : node(internalNet(id, x))); // prettier-ignore
      const [a, b] = [end(r.a), end(r.b)];
      if (a && b && a !== b) out.push(`RI${id}_${k} ${a} ${b} ${num(r.ohms)}`);
    }
    // An output of a timing part, driven from a state (an expression 0…1)
    // after the part's gate delay, when it reaches anything.
    const output = (n, expr, stem) => {
      if (!reaches(nets.get(n), comp.id)) return;
      drive(n, follow(expr, stem));
    };
    // A memory bit: `set` and `clear` (expressions, true/false), else it
    // holds — regenerative, settling in the part's gate delay.
    const memory = (set, clear) => {
      const q = fresh("m");
      const raw = `${q}r`;
      out.push(`B${raw} ${raw} 0 V=(${set})?1:((${clear})?0:(V(${q})>0.5?1:0))`); // prettier-ignore
      out.push(`R${raw} ${raw} ${q} 1k`);
      out.push(`C${raw} ${q} 0 ${num(delay / Math.LN2 / 1e3)}`);
      return `V(${q})`;
    };
    const th = inputThresholds(config, def, vcc);
    const readPin = (n) => {
      loadInput(n);
      return reading(v(n), th.up, th.down);
    };

    if (comp.ref === "CD4060B" || comp.ref === "CD4541B") {
      // An RC oscillator's two inverters (sim/ripple-oscillator.js,
      // sim/programmable-timer.js silicon): the input pin read at its
      // threshold, the output in phase with it and its complement — φO and
      // φ̄O, CTC and RTC — which Fig. 12 / Fig. 2's Cx, Rx and Rs close into
      // an oscillator. Running: a 4060's RESET LOW, a 4541's MR LOW with AR
      // LOW (its power-on reset released at Run).
      const [IN, SAME, OPP, HOLD] = comp.ref === "CD4060B" ? [11, 9, 10, 12] : [3, 2, 1, 6]; // prettier-ignore
      if (comp.ref === "CD4541B") loadInput(5);
      const held = readPin(HOLD);
      const x = readPin(IN);
      // Held (a 4060's RESET or a 4541's MR HIGH): the in-phase output LOW.
      const same = `(${held}>0.5?0:${x})`;
      output(SAME, same, "y");
      output(OPP, `(1-${same})`, "y");
      return out;
    }

    if (comp.ref === "CD4047B") {
      // sim/monostable.js `cd4047Silicon`, astable only: RC COMMON read at
      // ½·VDD, C (and OSC OUT) in phase with it, R against it, Q toggled on
      // each rise of the oscillator (FF4: a master–slave pair).
      const P = { C: 1, R: 2, RC: 3, AN: 4, A: 5, RESET: 9, Q: 10, QN: 11, OSC: 13 }; // prettier-ignore
      const astable = `(1-(1-${readPin(P.A)})*${readPin(P.AN)})`;
      const reset = readPin(P.RESET);
      loadInput(P.RC);
      const up = def.logic.sense[P.RC].up(vcc);
      const osc = `(${astable}*${reading(v(P.RC), up, up)})`;
      const m = fresh("m");
      const q = fresh("m");
      for (const [name, expr] of [
        [m, `${osc}<0.5?(V(${q})>0.5?0:1):(V(${m})>0.5?1:0)`],
        [q, `${reset}>0.5?0:(${osc}>0.5?(V(${m})>0.5?1:0):(V(${q})>0.5?1:0))`],
      ]) {
        out.push(`B${name}r ${name}r 0 V=${expr}`);
        out.push(`R${name}r ${name}r ${name} 1k`);
        out.push(`C${name}r ${name} 0 ${num(delay / Math.LN2 / 1e3)}`);
      }
      output(P.C, osc, "y");
      output(P.R, `(1-${osc})`, "y");
      output(P.OSC, osc, "y");
      output(P.Q, `V(${q})`, "y");
      output(P.QN, `(1-V(${q}))`, "y");
      return out;
    }

    if (def.logic?.sections) {
      // A dual monostable's silicon (sim/monostable.js
      // `dualMonostableSilicon`): a trigger edge (+TR rising or −TR
      // falling) turns the discharge on and Q HIGH; RX CX emptied below the
      // lower comparator turns the discharge off; charged back past the
      // upper, Q falls. RESET LOW holds Q LOW and the discharge on.
      for (const s of def.logic.sections) {
        if (!reaches(nets.get(s.q), comp.id) && !reaches(nets.get(s.qn), comp.id)) continue; // prettier-ignore
        const reset = readPin(s.reset);
        const trig = `(1-(1-${readPin(s.plus)})*${readPin(s.minus)})`;
        // The trigger a gate delay ago: its edge is where the two differ.
        const was = `V(${follow(trig, "w")})`;
        const edge = `(${trig}>0.5&&${was}<0.5)`;
        const sense = def.logic.sense[s.rxcx];
        const high = reading(v(s.rxcx), sense.up(vcc), sense.up(vcc));
        const low = reading(v(s.rxcx), sense.down(vcc), sense.down(vcc));
        loadInput(s.rxcx);
        const dis = memory(`${reset}<0.5||${edge}`, `${low}<0.5`);
        const q = memory(`${reset}>0.5&&${edge}`, `${reset}<0.5||(${dis}<0.5&&${high}>0.5)`); // prettier-ignore
        const lo = def.logic.stages[s.rxcx](vcc, "L");
        out.push(`B${fresh("d")} 0 ${pin(s.rxcx)} I=(${dis}>0.5?1:0)*(${stageExpr(lo, v(s.rxcx))})`); // prettier-ignore
        output(s.q, q, "y");
        output(s.qn, `(1-${q})`, "y");
      }
      return out;
    }

    const units = def.logic?.units;
    if (device && family === "74LS") {
      // The gate's own transistors (`lsGate`): its inputs load themselves and
      // its output is the totem pole, so neither the engine's stages nor its
      // thresholds take part.
      if (!units?.length || units.some((u) => !(u.fn in LS_GATES))) {
        throw new Unsupported(`${comp.ref}: no transistor-level gate`);
      }
      for (const u of units) {
        if (!reaches(nets.get(u.output), comp.id)) continue;
        const ins = u.inputs.map((n) => {
          if (!nets.get(n)) throw new Unsupported(`${id}: pin ${n} floats`);
          return pin(n);
        });
        for (const name of ["QLS", "QLSO", "DLS"]) modelOf(name);
        subckts.set(ins.length, lsGate(ins.length));
        out.push(`X${fresh("ls")} ${ins.join(" ")} ${pin(u.output)} ${pin(vccPin)} 0 LSGATE${ins.length}`); // prettier-ignore
      }
      return out;
    }
    if (!units?.length || units.some((u) => !GATES[u.fn])) {
      throw new Unsupported(`${comp.ref}: no behavioural block`);
    }
    const splitters = new Set(splitterUnits(def));
    for (const u of units) {
      // A unit whose output reaches nothing is left out: a spare gate's
      // inputs float, and its output moves nothing.
      if (!reaches(nets.get(u.output), comp.id)) continue;
      const reads = u.inputs.map((n) => {
        if (!nets.get(n)) throw new Unsupported(`${id}: pin ${n} floats`);
        return reading(v(n), th.up, th.down);
      });
      for (const n of u.inputs) loadInput(n);
      const state = follow(GATES[u.fn](reads), "y");
      drive(u.output, state);
      // A 74LS splitter part-way on while it drives HIGH (spice/network.js
      // "t"): out of the output to ground, by its lowest input.
      if (splitters.has(u)) {
        out.push(`B${fresh("t")} ${pin(u.output)} 0 I=${level(state)}*(${splitterExpr(u.inputs.map(v), v(u.output))})`); // prettier-ignore
      }
    }
    return out;
  }

  /** An array of transistors on one die (a ULN2003A): each channel's input
      resistor to its internal base, its Darlington (spice/transistors.js
      ARRAY_MODELS) from its output to E, and its clamp diode to COM. The
      Darlington has no behavioural block: the device flavour only, its two
      transistors their figures' cards, as a discrete Darlington's are. */
  function arrayBlock(comp, def, nets) {
    if (!device) throw new Unsupported(`${comp.ref}: a Darlington has no behavioural block`); // prettier-ignore
    const out = [];
    const id = comp.id;
    const m = ARRAY_MODELS[def.bipolarArray];
    const parts = def.logic.internals;
    const end = (x) => (typeof x === "number" ? node(nets.get(x)) : node(internalNet(id, x))); // prettier-ignore
    for (const [k, r] of parts.resistors.entries()) {
      const [a, b] = [end(r.a), end(r.b)];
      if (a && b && a !== b) out.push(`RI${id}_${k} ${a} ${b} ${num(r.ohms)}`);
    }
    for (const [k, d] of parts.junctions.entries()) {
      const [a, c] = [end(d.anode), end(d.cathode)];
      if (a && c && a !== c && reaches(nets.get(d.cathode), id)) {
        out.push(`DI${id}_${k} ${a} ${c} ${modelOf(DEFAULT_DEVICE.diode)}`);
      }
    }
    const q1 = fit(`Q${def.bipolarArray.toUpperCase()}D`, "npn", m.q1);
    const q2 = fit(`Q${def.bipolarArray.toUpperCase()}O`, "npn", m.q2);
    def.logic.channels.forEach((ch, i) => {
      const [c, e] = [nets.get(ch.a), nets.get(ch.b)];
      if (!c || !e || c === e || !reaches(c, id)) return;
      const b = node(internalNet(id, ch.base));
      const mid = fresh("x");
      const col = fresh("c");
      out.push(
        `RC${id}_${i} ${node(c)} ${col} ${num(m.rcOhm > 0 ? m.rcOhm : 1e-6)}`,
        `Q${id}_${i}A ${col} ${b} ${mid} ${q1}`,
        `Q${id}_${i}B ${col} ${mid} ${node(e)} ${q2}`,
        `RD1${id}_${i} ${b} ${mid} ${num(m.r1Ohm)}`,
        `RD2${id}_${i} ${mid} ${node(e)} ${num(m.r2Ohm)}`,
      );
    });
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
  for (const sub of subckts.values()) text.push(...sub);
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
