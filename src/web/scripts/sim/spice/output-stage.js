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

// spice/output-stage.js — what a chip output can PUSH: the current it sources
// HIGH or sinks LOW into whatever hangs on it, as a function of the voltage
// that load holds the pin at. Pure and DOM-free. The voltage solve (spice/
// voltages.js) drives every net through the stages of the outputs on it.
//
// A stage is an open-circuit level behind a resistance, optionally capped by
// a current the output transistor saturates at:
//
//   source (HIGH): I = min(limit, (Voc − V) / R) while V < Voc, else 0
//   sink   (LOW):  I = min(limit, (V − Vol) / R) while V > Vol, else 0
//
// — or, for a MOSFET whose stage says `curve`, the square law those two
// figures set: R is its slope at the rail and the limit where it saturates,
// so with d the volts the load holds it from its open-circuit level, its
// overdrive is vov = 2·R·limit and
//
//   I = limit · (2x − x²),  x = d / vov,   and the limit from x = 1 on
//
// — a level-1 channel with Vgs = VDD, no new figure in it. A square law is
// not straight, so it is drawn as chords between CURVE_CORNERS (tenths of
// the overdrive, finer near the rail — transistors.js re-linearizes a
// MOSFET's linear region by tenths too), each chord's end a corner. Two
// lines met 1.7 V from the rail at 5 V, where the channel delivers only
// 3.1 mA of the lines' 4.2: a capacitor charged too fast mid-ramp, the B
// ngspice graded (features/done/spice-lite-3-plan.md).
//
// Or, for a family side that states a `table`, the corners it gives: [d,
// amps] read off a transistor-level sweep, chords between them, saturated
// past the last.
//
// Each family's numbers are its representative part's, typical at 25 °C:
//
//   74LS    SN74LS04 — not a line but a TABLE (`table`): the I-V curves of
//           the sheet's own schematic (SDLS029C p. 4 — the Darlington HIGH
//           behind its 120 Ω, the Schottky-clamped pull-down with its
//           squaring network) swept transistor by transistor in ngspice
//           (scripts/spice-deck.mjs `lsGate`, the models fitted to §6.5:
//           VOH 3.37 V at −0.4 mA, VOL 0.30 V at 4 mA and 0.35 V at 8 mA,
//           VCC 4.75 V), read off at the corners where it bends. HIGH: open
//           at VCC − 0.49 V, a soft knee down to 3.6 V by 0.2 mA (the
//           Darlington's base-emitter drops, falling with its current), then
//           ~120 Ω down to ground, where it shorts at 31.8 mA at 5 V (IOS
//           20–100 mA) — the same curve at every VCC, measured from its open
//           level (4.75–5.25 V agree within 2 mV). LOW: open at 0.204 V,
//           ~35 Ω up to 1 mA and ~15 Ω on to 16 mA, flat at 18.5 mA (all the
//           base drive the pull-down has) from 0.6 to 1.4 V, and then — the
//           output pushed up past the Darlington's emitter — climbing to
//           152 mA by 2.8 V: a LOW shorted to VCC smokes. The LOW's
//           currents follow VCC (`lsLowTable`: swept at 4.75, 5 and 5.25 V,
//           its open level the same within 0.3 mV — the plateau 16.8, 18.5
//           and 20.2 mA, a short 135, 152 and 164 mA), between the three
//           sweeps by straight lines and held at the nearer outside them.
//           A line could not be both: 3.6 V behind 120 Ω read a 100 kΩ load
//           0.6 V low and a capacitor charged through 10 kΩ stopped at 3.6 V
//           where the gate takes it past 4.2 (the C ngspice graded,
//           2026-10-13).
//   CD4000  CD4029B (SCHS034C, the Harris scan: "typical output low (sink)
//           / high (source) current characteristics", Figs. 1 and 3, and the
//           static characteristics' IOL) — a MOSFET
//           that saturates at ~4.2 mA at VDD 5 V, ~16 mA at 10 V and ~28 mA
//           at 15 V (sink and source read alike), behind its linear-region
//           resistance: IOL 1 mA typ at VO 0.4 V (5 V), 2.6 mA at 0.5 V
//           (10 V) — 400 Ω and 190 Ω — and ~200 Ω at 15 V (Fig. 1's slope).
//           Between the two, the square law they set (a `curve`): an
//           overdrive of 3.36 / 6.08 / 11.2 V. Below 5 V the saturation
//           current is taken down to nothing at 2 V, a B-series threshold
//           (an assumption: no sheet curve goes below VGS 5 V).
//
//   MOS     every part in NO family that states no stage of its own — the
//           memories, the CPUs and the 65xx peripherals, the HD44780 LCD
//           controller, the oscillator cans. They are CMOS (or NMOS) parts
//           with TTL-COMPATIBLE outputs: their sheets guarantee a TTL VOH
//           (2.4 V) and VOL (0.4 V) at a few milliamps, and draw no curve. One
//           common stage stands for all of them (Jason, 2026-10-07 — one
//           common set, never per part): rail to rail behind 100 Ω, with no
//           saturation. 100 Ω is an ASSUMPTION, bracketed by the TTL-
//           compatible CMOS logic sheets that do draw one (SN74HCT00,
//           SCLS062: VOH 3.98 V min at −4 mA, VCC 4.5 V — 130 Ω — and about
//           50 Ω typical; VOL 0.26 V max at 4 mA — 65 Ω).
//
// A part whose output stage is not its family's says so in the catalog
// (`def.outputStage`, either side or both): the NE555's bipolar output, the
// CD4511B's n-p-n segment drivers, the CD4049UB/CD4050B's high-current sink.
//
// STRENGTH. Settings ▸ Spice Lite's output source and sink currents (spice/
// params.js FAMILY_DEFAULTS `sourceMa`, `sinkMa`) are what each family's
// stage is built round: the current its representative output delivers at
// its sheet's VOH / VOL test point. A user's own figure scales the stage
// that derives from the family by its ratio to the default (`stageStrength`):
// twice the sink current is a LOW transistor twice as big — half the
// resistance, twice the saturation current — as a def's own `scale` is. A
// stage a def states outright (its own ohms, its own limit) is that part's,
// and no family figure moves it.

import { familyOf } from "../../catalog/families.js";

/** [volts, value] points, read by straight lines between them and held
    beyond the ends. */
export function interpolate(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

/** A B-series output's saturation current, mA, at VDD (Figs. 1 and 3). */
const CMOS_SATURATION_MA = Object.freeze([
  Object.freeze([2, 0]),
  Object.freeze([5, 4.2]),
  Object.freeze([10, 16]),
  Object.freeze([15, 28]),
]);

/** A B-series output's linear-region resistance, Ω, at VDD. */
const CMOS_ON_OHMS = Object.freeze([
  Object.freeze([5, 400]),
  Object.freeze([10, 190]),
  Object.freeze([15, 200]),
]);

/** The 74LS HIGH's open-circuit level below VCC, volts (the header's). */
const LS_HIGH_DROP_V = 0.49;

/** The 74LS HIGH's corners, [volts below its open level, mA], to 24 mA. */
// prettier-ignore
const LS_HIGH_MA = Object.freeze(
  [
    [0, 0], [0.0699, 0.001], [0.1263, 0.005], [0.1647, 0.01], [0.2239, 0.02],
    [0.3715, 0.05], [0.5959, 0.1], [0.7846, 0.15], [0.8379, 0.2],
    [0.8703, 0.3], [0.8862, 0.4], [0.912, 0.7], [0.9277, 1], [0.9605, 2],
    [0.9929, 3], [1.0741, 4], [1.3022, 6], [1.5457, 8], [2.5395, 16],
    [3.5374, 24],
  ].map((c) => Object.freeze(c)),
); // prettier-ignore

/** Past its 24 mA corner the HIGH runs on in a line to its short, mA/V. */
const LS_HIGH_TAIL_MA_PER_V = 8.02;

/** The 74LS HIGH's corners at `vcc`: the table, and its short (the pin at
    0 V) where the line past 24 mA reaches it — or where the table does, on
    a supply too low to get that far. */
function lsHighTable(vcc) {
  const short = Math.max(vcc - LS_HIGH_DROP_V, 1e-3);
  const [d0, i0] = LS_HIGH_MA[LS_HIGH_MA.length - 1];
  const out = LS_HIGH_MA.filter(([d]) => d < short);
  const amps = short > d0 ? i0 + (short - d0) * LS_HIGH_TAIL_MA_PER_V : interpolate(LS_HIGH_MA, short); // prettier-ignore
  out.push([short, amps]);
  return out;
}

/** The 74LS LOW's open-circuit level, volts (the header's). */
const LS_LOW_V = 0.2044;

/** The 74LS LOW's corners, volts above its open level — one set for all
    three sweeps (each within 0.03 mA — or 0.6 % past 25 mA — of its own
    curve between them) — and its currents there, mA, at VCC 4.75, 5 and
    5.25 V. */
// prettier-ignore
const LS_LOW_D = Object.freeze([
  0, 0.02, 0.038, 0.056, 0.076, 0.098, 0.132, 0.192, 0.228, 0.26, 0.294,
  0.336, 0.446, 1.238, 1.286, 1.344, 1.384, 1.424, 1.47, 1.534, 1.632,
  1.806, 2.3, 2.42, 2.526, 2.618,
]);
// prettier-ignore
const LS_LOW_MA = Object.freeze([
  [4.75, Object.freeze([
    0, 0.447, 1.053, 1.866, 2.999, 4.471, 7.036, 11.663, 13.981, 15.434,
    16.273, 16.648, 16.769, 16.794, 16.889, 17.433, 18.513, 20.458,
    23.654, 29.262, 39.394, 59.73, 120.773, 131.797, 134.594, 134.723,
  ])],
  [5, Object.freeze([
    0, 0.487, 1.132, 1.991, 3.179, 4.713, 7.384, 12.28, 14.857, 16.605,
    17.731, 18.292, 18.484, 18.502, 18.567, 18.97, 19.838, 21.55, 24.564,
    30.057, 40.156, 60.594, 123.653, 138.076, 148.346, 151.99,
  ])],
  [5.25, Object.freeze([
    0, 0.527, 1.21, 2.112, 3.35, 4.94, 7.706, 12.835, 15.637, 17.659,
    19.099, 19.907, 20.207, 20.223, 20.266, 20.557, 21.235, 22.698, 25.49,
    30.83, 40.863, 61.351, 125.453, 140.952, 153.929, 163.639,
  ])],
]);

/** The 74LS LOW's corners at `vcc`, [volts above its open level, mA]: each
    corner's current along VCC between the three sweeps, held at the nearer
    outside them. */
function lsLowTable(vcc) {
  const v = Math.min(5.25, Math.max(4.75, Number.isFinite(vcc) ? vcc : 5));
  const k = v <= 5 ? 0 : 1;
  const [[v0, from], [v1, to]] = [LS_LOW_MA[k], LS_LOW_MA[k + 1]];
  const f = (v - v0) / (v1 - v0);
  return LS_LOW_D.map((d, i) => [d, from[i] + (to[i] - from[i]) * f]);
}

/**
 * A 74LS gate's PHASE SPLITTER, part-way on. Its input is a Schottky diode
 * into the splitter's base (an LS NAND one per input, the lowest winning),
 * so an input held LOW at anything above ground lifts that base, and the
 * pull-down under the output conducts a little while the output is HIGH: a
 * current out of the output into GND, set by the input's voltage and by
 * nothing else (the swept gate, scripts/spice-deck.mjs `lsGate`: the same
 * to a few nA with the output held anywhere from 1 V to 4 V). It is nothing
 * at a grounded input, 15 µA at an LS LOW's 0.2 V and 54 µA at 0.4 V — and
 * so nothing to a load drawing milliamps, but a 10 kΩ charging a capacitor
 * sees the HIGH's knee 75 mV lower for it (the ring of gates ngspice grades,
 * spice-golden-cases.js `mixed-ls-rc-ring`, 3.5 % slow without it). Past
 * 0.8 V (VIL) the gate is switching, and the logic decides; the current is
 * held there. The gates whose inputs reach the splitter straight are
 * `SPLITTER_GATES` (`splitterUnits`); an AND, an OR, a NOR, a Schmitt
 * trigger or anything with logic between its pins and its outputs drives its
 * splitter from inside, and an open collector has no HIGH to pull on.
 */
const SPLITTER_GATES = Object.freeze(new Set(["INV", "NAND"]));

/** A def's units whose outputs carry a splitter's current — a 74LS INV or
    NAND with its family's totem pole — or none. */
export function splitterUnits(def) {
  if (familyOf(def) !== "74LS") return [];
  if (def.outputStage || def.schmitt || def.openCollector) return [];
  return (def.logic?.units ?? []).filter((u) => SPLITTER_GATES.has(u.fn));
}

/** The splitter's current, [volts at the lowest input, µA]: VCC 5 V, and
    4.75–5.25 V agree within half a microamp. */
// prettier-ignore
export const SPLITTER_UA = Object.freeze(
  [
    [0, 0], [0.05, 0.45], [0.1, 2.5], [0.15, 7.6], [0.2, 15], [0.25, 23.8],
    [0.3, 33.3], [0.4, 53.7], [0.5, 74.8], [0.6, 96.4], [0.7, 119.2],
    [0.75, 134.9], [0.8, 172],
  ].map((c) => Object.freeze(c)),
);

/** Below this across the pull-down, volts, it saturates: its current falls
    to nothing with the output at its GND. */
export const SPLITTER_SAT_V = 0.2;

/**
 * The current, amps, a 74LS gate's output takes to its GND through a
 * part-way pull-down while it drives HIGH: its lowest input `vin` volts
 * above its GND, its output `vout`.
 */
export function splitterAmps(vin, vout) {
  if (!(vin > 0) || !(vout > 0)) return 0;
  const ua = interpolate(SPLITTER_UA, vin);
  return (ua / 1e6) * Math.min(1, vout / SPLITTER_SAT_V);
}

/** Which piece `splitterAmps` is on, one fragment ending in `|`. */
export function splitterPiece(vin, vout) {
  if (!(vin > 0) || !(vout > 0)) return "0|";
  let k = 0;
  while (k < SPLITTER_UA.length - 1 && vin >= SPLITTER_UA[k + 1][0]) k++;
  return `${String.fromCharCode(97 + k)}${vout < SPLITTER_SAT_V ? "s" : ""}|`;
}

/**
 * Each family's stage, as functions of the chip's supply: `high` and `low`
 * each `{volts(vcc), ohms(vcc), limitMa(vcc), channel?, curve?, table?}` —
 * the open-circuit level, the resistance behind it, the most it delivers
 * (Infinity: no limit), whether it is a MOSFET CHANNEL, and whether it is
 * curved: a square law (`curve`) or its own corners (`table(vcc)`, [volts
 * from the open level, mA]; its last is its limit, and its `ohms` only a
 * representative slope — what a Newton step is pointed along where it
 * wants one, spice/network.js `offStageSlope`). A channel is an on
 * transistor that conducts either way. A CMOS LOW is an n-channel to ground, so a node pulled below
 * ground through a capacitor draws current back up through it, as a HIGH
 * takes current into VDD from a node pushed above it; a 74LS totem pole's
 * Darlington cannot sink and its saturated pull-down cannot source, so its
 * stages are one-way. One-way, a CMOS LOW let the far plate of a capacitor
 * fall 2.5 V below ground, and the two-gate RC oscillator chattered at its
 * first crossing.
 */
export const FAMILY_STAGES = Object.freeze({
  "74LS": Object.freeze({
    high: Object.freeze({
      volts: (vcc) => vcc - LS_HIGH_DROP_V,
      ohms: () => 120,
      limitMa: () => Number.POSITIVE_INFINITY,
      table: lsHighTable,
    }),
    low: Object.freeze({
      volts: () => LS_LOW_V,
      ohms: () => 25,
      limitMa: () => Number.POSITIVE_INFINITY,
      table: lsLowTable,
    }),
  }),
  CD4000: Object.freeze({
    high: Object.freeze({
      volts: (vcc) => vcc,
      ohms: (vcc) => interpolate(CMOS_ON_OHMS, vcc),
      limitMa: (vcc) => interpolate(CMOS_SATURATION_MA, vcc),
      channel: true,
      curve: true,
    }),
    low: Object.freeze({
      volts: () => 0,
      ohms: (vcc) => interpolate(CMOS_ON_OHMS, vcc),
      limitMa: (vcc) => interpolate(CMOS_SATURATION_MA, vcc),
      channel: true,
      curve: true,
    }),
  }),
});

/** A clock brick's output resistance under Spice Lite, ohms: a bench
    function generator's 50 Ω (Jason, 2026-10-27). Ideal, an edge through a
    capacitor into a clamp drove 6 A into a 1N4148 and 100 A into a 1N4007
    for a moment no generator gives. A square or PWM drives its net as this
    stage, both ways; a wave (spice/waves.js) is still held outright. */
export const CLOCK_OHMS = 50;

/** Each clock HIGH's stage, by its volts (`clockStage`). */
const CLOCK_STAGES = new Map();
const CLOCK_LOW = Object.freeze({ volts: 0, ohms: CLOCK_OHMS, limit: Number.POSITIVE_INFINITY, sources: false, channel: true }); // prettier-ignore

/** A square clock's output as a stage: its level's volts behind
    `CLOCK_OHMS`, sourcing or sinking alike. */
export function clockStage(high, volts) {
  if (!high) return CLOCK_LOW;
  let st = CLOCK_STAGES.get(volts);
  if (!st) {
    if (CLOCK_STAGES.size >= STAGES_KEPT) CLOCK_STAGES.clear();
    CLOCK_STAGES.set(volts, (st = Object.freeze({ volts, ohms: CLOCK_OHMS, limit: Number.POSITIVE_INFINITY, sources: true, channel: true }))); // prettier-ignore
  }
  return st;
}

/** The common stage of a part in no family (the header's MOS). */
export const MOS_STAGE = Object.freeze({
  high: Object.freeze({
    volts: (vcc) => vcc,
    ohms: () => 100,
    limitMa: () => Number.POSITIVE_INFINITY,
    channel: true,
  }),
  low: Object.freeze({
    volts: () => 0,
    ohms: () => 100,
    limitMa: () => Number.POSITIVE_INFINITY,
    channel: true,
  }),
});

/** An analog switch channel's on-resistance, Ω, at VDD: the CD4066B/405xB
    sheets' 470 Ω typical at 5 V, 180 Ω at 10 V and 125 Ω at 15 V (as
    catalog/families.js's LED rule reads them). */
const SWITCH_ON_OHMS = Object.freeze([
  Object.freeze([5, 470]),
  Object.freeze([10, 180]),
  Object.freeze([15, 125]),
]);

/** An analog switch channel's on-resistance, Ω, for a part on `vcc` volts.
    (A transistor — a discrete one, or one of a CD4007UB's — is no channel
    to Spice Lite but a device of the network solve: spice/network.js.) */
export function channelOhms(def, vcc) {
  return interpolate(SWITCH_ON_OHMS, Number.isFinite(vcc) ? vcc : 5);
}

/** The stages a def's outputs are built from: its family's, or — in no
    family — the common MOS one. */
export function stagesOf(def) {
  return FAMILY_STAGES[familyOf(def)] ?? MOS_STAGE;
}

/**
 * One output's stage while it drives `level` from a supply of `vcc` volts:
 * `{volts, ohms, limit, sources, channel}` — the open-circuit level, the
 * resistance, the most it delivers in AMPS (Infinity: none), whether it
 * pushes current OUT (HIGH) or takes it IN (LOW), and whether it conducts
 * the other way too (a MOSFET channel; a def's own side says so, or takes
 * its family's) — and a curved one's chords: its square law's overdrive
 * (`vov`) or its table's `corners`, `[d, amps]`. Null for anything but H or
 * L.
 * @param {object} def - the chip's catalog def
 * @param {number} vcc - the supply the chip sees, volts
 * @param {"H"|"L"} level
 * @param {number} [strength] - the family's figure against its default
 *   (spice/params.js `stageStrength`; 1 = the default)
 */
export function outputStage(def, vcc, level, strength = 1) {
  if (level !== "H" && level !== "L") return null;
  // Kept per def, side, strength and supply (`STAGES`): every plan asked it
  // of every driving chip, and built a 74LS table's corners afresh each
  // time — the most a busy desk's tick allocated (the 2026-10-26 review).
  // Pure, so a kept answer is the one it would build again.
  if (def == null || typeof def !== "object") return buildStage(def, vcc, level, strength); // prettier-ignore
  let bySide = STAGES.get(def);
  if (!bySide) STAGES.set(def, (bySide = { H: new Map(), L: new Map() }));
  let byVcc = bySide[level].get(strength);
  if (!byVcc) bySide[level].set(strength, (byVcc = new Map()));
  let stage = byVcc.get(vcc);
  if (stage === undefined) {
    if (byVcc.size >= STAGES_KEPT) byVcc.clear();
    byVcc.set(vcc, (stage = Object.freeze(buildStage(def, vcc, level, strength)))); // prettier-ignore
  }
  return stage;
}

/** Each def's stages (`outputStage`), by side, strength and supply. */
const STAGES = new WeakMap();

/** The most supplies one def's side keeps stages for before it starts
    again — a drooping supply asks a new one every tick. */
const STAGES_KEPT = 64;

/** `outputStage`, built. */
function buildStage(def, vcc, level, strength) {
  const side = level === "H" ? "high" : "low";
  const base = stagesOf(def)[side];
  const own = def?.outputStage?.[side] ?? null;
  const volts = own?.volts ?? base.volts(vcc);
  // A `scale` is a transistor that many times its family's: that many times
  // the current, and a resistance that many times smaller — as is a user's
  // own figure for the family (`strength`), on whatever derives from it.
  const scale = (own?.scale ?? 1) * strength;
  const ohms = own?.ohms ?? base.ohms(vcc) / scale;
  // A def's own limit is a [volts, mA] table, or one number at every supply
  // (Infinity: a stage nothing but its own resistance limits).
  const ownLimit = own?.limitMa;
  // A table's stage is its own corners, a `scale` moving their currents and
  // never their volts — while it is the family's: a side stating its own
  // resistance or limit is some other transistor.
  const tabled = base.table && own?.ohms == null && ownLimit == null;
  const corners = tabled
    ? base.table(vcc).map(([d, ma]) => [d, (ma * scale) / 1000])
    : null;
  const limitMa =
    corners != null
      ? corners[corners.length - 1][1] * 1000
      : ownLimit == null
        ? base.limitMa(vcc) * scale
        : (typeof ownLimit === "number"
            ? ownLimit
            : interpolate(ownLimit, vcc)) * (own?.scale ?? 1);
  const limit = limitMa / 1000;
  const stage = {
    volts: typeof volts === "function" ? volts(vcc) : volts,
    ohms,
    limit,
    sources: level === "H",
    channel: own?.channel ?? base.channel ?? false,
  };
  // The family's square law, where the stage is still the family's MOSFET
  // (a `scale` keeps it: the current scales, the overdrive does not). A side
  // stating its own resistance or limit is some other transistor.
  const curved = base.curve && own?.ohms == null && ownLimit == null;
  if (curved && limit > 0 && Number.isFinite(limit)) stage.vov = 2 * ohms * limit; // prettier-ignore
  if (corners) stage.corners = corners;
  return stage;
}

/**
 * Where a curved stage's chords end, as fractions of its overdrive: tenths,
 * with the first tenth halved three times more — a chord there is nearly
 * the curve's own slope, and nearly every load on a desk (a pull-up, an
 * input, a 10 kΩ divider) sits within it. Past the last, saturated.
 */
export const CURVE_CORNERS = Object.freeze([
  0, 0.0125, 0.025, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1,
]);

/** The chords' ends on a curved stage, `[d, amps]` from 0 to saturation:
    a table's own, or along a square law's overdrive — ON the square law, but
    the first, which is on its tangent, so a load that draws little sees R
    exactly. */
export function stageCorners(stage) {
  if (stage.corners) return stage.corners;
  return CURVE_CORNERS.map((x, k) => [
    x * stage.vov,
    stage.limit * (k === 1 ? 2 * x : x * (2 - x)),
  ]);
}

/**
 * A square-law stage's output transistor as the level-1 channel it is
 * (spice/transistors.js `mosfetCurrent`), at any gate: its square law
 * driven at VGS = VDD, so VTO = VDD − vov and KP = 2·limit / vov² — at a
 * gate on VDD it IS the stage's curve (the chords drawn through it), and
 * the same card `scripts/spice-deck.mjs` writes for a CD4000 output. What a
 * CD4007UB's bare MOSFETs are (spice/voltages.js `deviceBranch`). A stage
 * with no square law (VDD ≤ 2 V, no current) is a channel that never
 * conducts.
 * @param {object} stage - an `outputStage` of the family's
 * @param {number} vcc - the chip's supply, volts
 */
export function stageChannel(stage, vcc) {
  if (!(stage?.vov > 0)) return CHANNEL_OFF;
  let byVcc = CHANNELS.get(stage);
  if (!byVcc) CHANNELS.set(stage, (byVcc = new Map()));
  let card = byVcc.get(vcc);
  if (!card) {
    card = Object.freeze({ kind: "mosfet", vtoV: vcc - stage.vov, kpA: (2 * stage.limit) / stage.vov ** 2 }); // prettier-ignore
    byVcc.set(vcc, card);
  }
  return card;
}

/** A channel with no square law: its threshold never reached. */
const CHANNEL_OFF = Object.freeze({ kind: "mosfet", vtoV: Infinity, kpA: 0 });

/** Each stage's channel (`stageChannel`), by stage and supply: a branch is
    built every solve. */
const CHANNELS = new WeakMap();

/** Each curved stage's chords' ends, by stage: a stage is built once per
    output per solve and read at every Newton step. */
const CORNERS = new WeakMap();

/** Whether a stage is drawn as chords: a square law, or a table's. */
const isCurved = (stage) => stage.vov > 0 || stage.corners != null;

function cornersOf(stage) {
  if (stage.corners) return stage.corners;
  let corners = CORNERS.get(stage);
  if (!corners) CORNERS.set(stage, (corners = stageCorners(stage)));
  return corners;
}

/** The chord `d` volts of drive is on (0…), or the corners' count less one
    once saturated. */
function chordOf(corners, d) {
  let k = 0;
  while (k < corners.length - 1 && d >= corners[k + 1][0]) k++;
  return k;
}

/** A chord's slope, siemens. */
function chordSiemens(corners, k) {
  const [d0, i0] = corners[k];
  const [d1, i1] = corners[k + 1];
  return (i1 - i0) / (d1 - d0);
}

/**
 * The current, amps, a stage delivers with its net held `d` volts from its
 * open-circuit level the way it drives (d > 0): along its resistance up to
 * its limit, or along its curve's chords.
 * @param {object} stage - an `outputStage`
 * @param {number} d
 */
export function stageDelivers(stage, d) {
  if (!(d > 0)) return 0;
  if (!isCurved(stage)) return Math.min(stage.limit, d / stage.ohms);
  const corners = cornersOf(stage);
  const k = chordOf(corners, d);
  if (k >= corners.length - 1) return stage.limit;
  return corners[k][1] + (d - corners[k][0]) * chordSiemens(corners, k);
}

/** ∂(stageDelivers)/∂d at `d` ≥ 0, siemens: 1/R (or the chord's slope)
    where it is linear, 0 where it is saturated. */
function deliversSlope(stage, d) {
  if (!isCurved(stage)) return d / stage.ohms < stage.limit ? 1 / stage.ohms : 0; // prettier-ignore
  const corners = cornersOf(stage);
  const k = chordOf(corners, d);
  return k >= corners.length - 1 ? 0 : chordSiemens(corners, k);
}

/**
 * The current, amps, a stage puts INTO its net when that net sits at `v`
 * volts — positive while a HIGH sources, negative while a LOW sinks, and
 * never the other way (a TTL HIGH cannot sink, a LOW cannot source) — except
 * through a channel, which carries either way, up to its limit each way.
 */
export function stageCurrent(stage, v) {
  if (stage.channel) {
    const d = stage.volts - v;
    return d < 0 ? -stageDelivers(stage, -d) : stageDelivers(stage, d);
  }
  if (stage.sources) return stageDelivers(stage, stage.volts - v);
  const pull = v - stage.volts;
  return pull > 0 ? -stageDelivers(stage, pull) : 0;
}

/** ∂(stageCurrent)/∂v, siemens: −1/R (or its chord's slope) where the stage
    is linear, 0 where it is saturated or off — the slope a Newton step reads
    (spice/lamps.js). */
export function stageSlope(stage, v) {
  const d = stage.sources || stage.channel ? stage.volts - v : v - stage.volts;
  const g = stage.channel || d > 0 ? deliversSlope(stage, Math.abs(d)) : 0;
  return g > 0 ? -g : 0;
}

/**
 * Which piece of its characteristic a stage is on at `v`, one character:
 * "0" off, "1" along its resistance (a curve: its chord, a letter — lower
 * case driving its own way, upper case driven back through a channel, the
 * chord through zero one straight line both ways), "2" saturated driving
 * its own way and "3" saturated the other (a channel).
 */
export function stagePiece(stage, v) {
  const d = stage.sources || stage.channel ? stage.volts - v : v - stage.volts;
  if (!stage.channel && !(d > 0)) return "0";
  const ahead = stage.channel ? d >= 0 : true;
  const along = Math.abs(d);
  if (isCurved(stage)) {
    const corners = cornersOf(stage);
    const k = chordOf(corners, along);
    if (k >= corners.length - 1) return ahead ? "2" : "3";
    return String.fromCharCode((ahead || k === 0 ? 97 : 65) + k);
  }
  if (along / stage.ohms < stage.limit) return "1";
  return ahead ? "2" : "3";
}

/**
 * The voltages where a stage's slope changes: its open-circuit level, and
 * where it saturates — each chord's end along a curve — the way it drives
 * (a channel both ways).
 */
export function stageKinks(stage) {
  const out = [stage.volts];
  if (!Number.isFinite(stage.limit)) return out;
  const reach = isCurved(stage)
    ? cornersOf(stage)
        .slice(1)
        .map(([d]) => d)
    : [stage.limit * stage.ohms];
  // A source falls below its level as it delivers; a sink rises above it.
  const dir = stage.sources ? -1 : 1;
  for (const d of reach) {
    out.push(stage.volts + dir * d);
    if (stage.channel) out.push(stage.volts - dir * d);
  }
  return out;
}
