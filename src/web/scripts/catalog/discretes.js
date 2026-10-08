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

// discretes.js — the discretes: capacitors, inductors, diodes and
// transistors, each in its own COMPONENTS group. Pure data and pure functions,
// like every def in catalog/parts.js, which spreads this list into PART_DEFS.
//
// The tray marks all four groups — a red (i) saying these parts have limited
// functionality and exist for export and a complete design
// (palette-panel.js, which finds them by `countsAsConnection`, below).
//
// What the four have in common is the bargain each strikes with a LOGIC
// simulator: it does as much as a digital, event-driven engine can honestly
// represent, and no more — and it exports to KiCad as the real part, which is
// what makes it worth placing at all. So:
//
//   capacitor   joins NOTHING (a charged capacitor blocks DC); timing parts
//               read its value off the wiring (sim/rc-trace.js).
//   inductor    conducts like a WIRE (a coil at DC is a length of copper);
//               the digital engine never simulates its inductance (Spice
//               Lite does: sim/spice/inductors.js).
//   diode       ONE-WAY (`oneWayBridges`): a HIGH on the anode passes to the
//               cathode at the strength it arrived with; nothing passes back.
//   transistor  a SWITCH its base or gate opens and closes — an analog-switch
//               channel (sim/analog-switch.js `transistorSwitch`), the very
//               mechanism the CD4066B uses.
//
// No forward drop, Zener breakdown, gain, threshold or kickback: analog, and
// out of scope. Every part here carries an optional Part number, printed on
// the part and exported, which changes nothing about how it behaves.
//
// And every part here COUNTS AS A CONNECTION (`countsAsConnection`): a pin
// whose only company is one of them is wired, whether or not the part is
// conducting right now — a reversed diode and an off transistor are a valid
// board, not an unconnected pin (sim/rc-trace.js `connectedByPart`).

import { normalizeLeadOffset } from "./lead-offset.js";
import {
  ZENER_VOLTS_FIELD,
  partTypeField,
  storedValue,
  transistorPartField,
  valueField,
} from "./value-fields.js";
import {
  CERAMIC_VALUES,
  ELECTROLYTIC_VALUES,
  INDUCTOR_VALUES,
  VALUE_RANGES,
  formatComponentValue,
  transistorTypeOf,
} from "../model/component-value.js";
import { transistorSwitch } from "../sim/analog-switch.js";
import { H, L } from "../sim/levels.js";

/** The longest part number kept — longer than any a maker prints. */
const MAX_PART_NUMBER = 32;

/**
 * The Part number field every one of the discretes carries: free text (1N4148,
 * 2N2222, BZX79-C5V1…), printed on the part and written to the export. It is a
 * LABEL, as a resistor's colour is not: nothing in the simulation reads it.
 */
export const PART_NUMBER_FIELD = Object.freeze({
  key: "partNumber",
  label: "Part number",
  type: "text",
});

/**
 * A part's typed part number, trimmed and capped, or null when it has none —
 * the one place it is coerced, so every reader (the desk, the BOM, the
 * schematic, the export) sees the same text.
 * @param {{partNumber?: unknown}} [params]
 * @returns {string|null}
 */
export function partNumberOf(params) {
  const text =
    typeof params?.partNumber === "string" ? params.partNumber.trim() : "";
  return text ? text.slice(0, MAX_PART_NUMBER) : null;
}

/** `params` with the part number laid on, stored only when there is one — so
    a part that never had one round-trips byte-identical. */
function withPartNumber(params, raw) {
  const partNumber = partNumberOf(raw);
  return partNumber ? { ...params, partNumber } : params;
}

/** The two-free-ends geometry every two-lead part here keeps, as the resistor
    and the LED do (see normalizeLeadOffset). */
function leadGeometry(raw) {
  const rotated = raw?.rot === 90;
  return {
    rot: rotated ? 90 : 0,
    end: rotated ? normalizeLeadOffset(raw?.end) : null,
  };
}

// ── Capacitors ──────────────────────────────────────────────────────────────

/** A capacitor's Type: the two are one part to the user, swapped in place
    (value-fields.js `partTypeField`). */
const CAPACITORS = Object.freeze(["cap-ceramic", "cap-electrolytic"]);
const CAPACITOR_TYPE_FIELD = partTypeField([
  { value: "cap-ceramic", label: "Ceramic" },
  { value: "cap-electrolytic", label: "Electrolytic" },
]);

/** Each capacitor's Capacitance: its own range and its own common values. */
const capacitanceField = (range, values) =>
  valueField({
    key: "farads",
    label: "Capacitance",
    unit: "farad",
    range,
    values,
  });

/**
 * A capacitor's params: its value, plus the same two-free-ends geometry the
 * resistor and LED keep (`rot`, `end` — see normalizeLeadOffset). Any positive
 * value is KEPT, in range or not (a ceramic swapped for an electrolytic keeps
 * its value, and its card says if the new type cannot be that); text an older
 * document holds is read, or kept as it was (value-fields.js `storedValue`).
 */
function capacitorParams(raw, fallback) {
  return withPartNumber(
    {
      farads: storedValue(raw?.farads, "farad", fallback),
      ...leadGeometry(raw),
    },
    raw,
  );
}

/** What both capacitors' blurbs say about what a capacitor IS here. */
const CAPACITOR_NOTE =
  "In this logic sim a capacitor joins nothing — it passes no current, " +
  "between any two holes, rails included (a charged capacitor blocks DC) — " +
  "and it does not filter, smooth or store charge. What it carries is its " +
  "VALUE: a timing part (the 555, or one of the 4000-series timers) reads " +
  "it off the wiring, and the KiCad export writes it. A pin whose only " +
  "company is a capacitor is not called unconnected.";

// ── Inductors ───────────────────────────────────────────────────────────────

/**
 * The Inductance field — OPTIONAL, unlike a capacitance: a bare inductor is a
 * part you can place, and clearing the box clears the value rather than
 * being refused.
 */
const INDUCTANCE_FIELD = valueField({
  key: "henries",
  label: "Inductance",
  unit: "henry",
  range: VALUE_RANGES.inductor,
  values: INDUCTOR_VALUES,
  optional: true,
});

/**
 * Which inductor it is, the first the default: a TOROID ("coil" — copper
 * wound round a ferrite ring, standing on its two leads) or a DRUM in a black
 * can, the leads out of its base. The desk draws it and the export picks its
 * footprint by it (kicad-parts.js); the simulation never reads it.
 */
export const INDUCTOR_STYLES = Object.freeze(["coil", "can"]);

const INDUCTOR_STYLE_FIELD = Object.freeze({
  key: "style",
  label: "Style",
  type: "segmented",
  options: Object.freeze([
    Object.freeze({ value: "coil", label: "Coil" }),
    Object.freeze({ value: "can", label: "Can" }),
  ]),
});

/**
 * How many holes an inductor's body covers between its leads: 1 puts the
 * leads 0.2 in (5.08 mm) apart under the smallest body, 2 (the default) 0.3 in
 * (7.62 mm), 3 0.4 in (10.16 mm) under the biggest. Unlike the style it MOVES
 * a pin: lying along a row, pin 2 lands as many holes on (`offsetsFor`,
 * below); stood up on two free ends, only the body changes.
 */
export const INDUCTOR_BODY_HOLES = Object.freeze([1, 2, 3]);

/** The holes between a new inductor's leads — the size every inductor had
    before the 1-hole one was added, so a fresh part places as it always has. */
export const INDUCTOR_DEFAULT_HOLES = 2;

const BODY_HOLES_FIELD = Object.freeze({
  key: "bodyHoles",
  label: "Holes between leads",
  type: "segmented",
  options: Object.freeze(
    INDUCTOR_BODY_HOLES.map((n) => Object.freeze({ value: n, label: `${n}` })),
  ),
  // It can move a pin, so it is a topology edit: greyed while the circuit
  // runs (desk-controller.js #propertyFieldsFor), and refused — saying this
  // — where the part sits has no room for it (DeskDoc.canSetComponentParams).
  movesPins: true,
  refused:
    "No room — the hole its lead would move to is taken, or past the end " +
    "of the board.",
});

/** An inductor's lead offsets, by the holes between its leads. */
const INDUCTOR_OFFSETS = Object.freeze({
  1: Object.freeze([0, 2]),
  2: Object.freeze([0, 3]),
  3: Object.freeze([0, 4]),
});

/** The holes between an inductor's leads, `params.bodyHoles` when it is one
    of the sizes, else the default — the one read for the offsets, the
    drawing and the export, so they can never disagree. */
export const inductorHoles = (params) =>
  INDUCTOR_BODY_HOLES.includes(params?.bodyHoles)
    ? params.bodyHoles
    : INDUCTOR_DEFAULT_HOLES;

/**
 * An inductor's winding resistance (DCR), Ω, as a power of its inductance:
 * R = `ohms1mH` · (L / 1 mH)^`p` — a maker's series does not hold R/L
 * constant (finer wire on the bigger values), so a fixed ohms-per-henry
 * would be wrong by a factor of several across a series. Fitted per body
 * and size to the TYPICAL winding:
 *   can (a radial drum)  1 hole: Bourns RLB0914 (8.7 mm, 5 mm pitch),
 *                        28 values 3.3 µH–1 mH; 2 and 3 holes: Bourns
 *                        RLB1314 (11.7 mm, 7 mm pitch), 23 values
 *                        3.3 µH–15 mH (the series' largest body);
 *   coil (a toroid)      3 holes: Bourns 2100 series (21.8 mm), 10 µH 6 mΩ,
 *                        22 µH 15 mΩ, 330 µH 230 mΩ, 1 mH 400 mΩ; 2 and 1
 *                        hole scaled from it by size (16 and 10 mm: at one
 *                        inductance a winding's resistance goes as 1/size²).
 * Each series spreads ±40 % about its fit; the WINDING grades span that.
 */
export const INDUCTOR_WINDING_FITS = Object.freeze({
  can: Object.freeze({
    1: Object.freeze({ ohms1mH: 1.946, p: 0.801 }),
    2: Object.freeze({ ohms1mH: 1.213, p: 0.949 }),
    3: Object.freeze({ ohms1mH: 1.213, p: 0.949 }),
  }),
  coil: Object.freeze({
    1: Object.freeze({ ohms1mH: 1.9, p: 0.91 }),
    2: Object.freeze({ ohms1mH: 0.74, p: 0.91 }),
    3: Object.freeze({ ohms1mH: 0.4, p: 0.91 }),
  }),
});

/** The winding grades (Spice Lite's Winding field), each a factor on its
    body's typical resistance. */
export const INDUCTOR_WINDINGS = Object.freeze(["lowest", "typical", "higher", "highest"]); // prettier-ignore
export const WINDING_FACTOR = Object.freeze({
  lowest: 0.6,
  typical: 1,
  higher: 1.6,
  highest: 2.5,
});
export const DEFAULT_WINDING = "typical";

/** An inductor's winding grade: `params.winding` when it is one, else
    Typical. */
export const inductorWinding = (params) =>
  INDUCTOR_WINDINGS.includes(params?.winding) ? params.winding : DEFAULT_WINDING; // prettier-ignore

/** An inductor's DC resistance, Ω, at a grade (its own, by default) — or
    null with no inductance (a wire). */
export function inductorOhms(params, winding = inductorWinding(params)) {
  const henries = Number(params?.henries);
  if (!(henries > 0)) return null;
  const style = INDUCTOR_STYLES.includes(params?.style) ? params.style : INDUCTOR_STYLES[0]; // prettier-ignore
  const fit = INDUCTOR_WINDING_FITS[style][inductorHoles(params)];
  return fit.ohms1mH * (henries / 1e-3) ** fit.p * WINDING_FACTOR[winding];
}

/** Each winding grade's English name (`properties.option.<grade>`). */
const WINDING_LABELS = Object.freeze({
  lowest: "Lowest",
  typical: "Typical",
  higher: "Higher",
  highest: "Highest",
});

/**
 * Spice Lite's Winding field: which of its body's windings the part has, each
 * option stating the resistance it gives at the part's CURRENT values
 * (`detail`, re-asked by the dialog after every change, so a new Inductance,
 * style or size moves it). Shown only while Spice Lite is on (`spiceOnly`,
 * desk-controller.js #propertyFieldsFor) — the digital engine runs an
 * inductor as a wire — and greyed while the Inductance is blank, when the
 * part is a wire in both engines. It moves no pin, so it stays live while the
 * circuit runs.
 */
const WINDING_FIELD = Object.freeze({
  key: "winding",
  label: "Winding",
  type: "select",
  default: DEFAULT_WINDING,
  spiceOnly: true,
  options: (values) =>
    INDUCTOR_WINDINGS.map((winding) => {
      const ohms = inductorOhms(values, winding);
      return {
        value: winding,
        label: WINDING_LABELS[winding],
        detail: ohms == null ? null : formatComponentValue(Number(ohms.toPrecision(2)), "ohm"), // prettier-ignore
      };
    }),
  disabledWhen: (values) => !(Number(values.henries) > 0),
});

// ── Diodes ──────────────────────────────────────────────────────────────────

/** What both diodes' blurbs say about what a diode IS here. */
const DIODE_NOTE =
  "In this logic sim a diode is ONE-WAY: a HIGH on the anode passes to the " +
  "cathode at the strength it arrived with — from a rail or an output it " +
  "drives, through a resistor it only pulls — and nothing ever passes back. " +
  "A LOW or undriven anode leaves the cathode to whatever else is on it, so " +
  "two diodes into one net with a pull-down resistor make a diode-OR. No " +
  "forward drop is modelled. Like an LED, one wired forward straight across " +
  "two strongly driven nets (rail to rail, an output into ground) burns. " +
  "Under Spice Lite it is a silicon junction: it conducts from 0.6 V, " +
  "carries what the circuit pushes through it, and burns by its junction's " +
  "temperature.";

function diodeDef({ id, title, blurb, zener }) {
  return {
    id,
    kind: "discrete",
    title,
    blurb,
    group: "Diodes",
    // A DO-35/DO-41 glass or epoxy body, its leads bent to 0.3 in (7.62 mm)
    // — the footprint the KiCad export gives it.
    footprint: Object.freeze({ offsets: Object.freeze([0, 3]) }),
    rotatable: true,
    // A resistor's reach (see its def): the body is about as long, and 2.5
    // still lets a lead land on the rail 2.76 away from row a.
    minSpan: 2.5,
    // The data hook every consumer branches on (the drawing, the burn rule,
    // the schematic, the export) — never an id.
    diode: Object.freeze({ zener }),
    countsAsConnection: true,
    properties: zener
      ? [ZENER_VOLTS_FIELD, PART_NUMBER_FIELD]
      : [PART_NUMBER_FIELD],
    pins: [
      { n: 1, name: "A", role: "anode", detail: "anode" },
      {
        n: 2,
        name: "K",
        role: "cathode",
        detail: "cathode — the end the band marks",
      },
    ],
    normalizeParams(raw) {
      // A Zener's voltage (value-fields.js ZENER_VOLTS_FIELD) — optional,
      // and export-only.
      const zenerVolts = zener
        ? storedValue(raw?.zenerVolts, "volt", undefined)
        : undefined;
      return withPartNumber(
        {
          ...(zenerVolts != null ? { zenerVolts } : {}),
          ...leadGeometry(raw),
        },
        raw,
      );
    },
    // It joins no net: a diode passes a level one way, which no bridge in
    // the netlist can say.
    internalBridges() {
      return [];
    },
    // …so it says so here instead, as DATA: each pair passes a HIGH from its
    // first pin (the anode) to its second (the cathode) and nothing back
    // (sim/engine.js `buildContext` → `resolveAll`).
    oneWayBridges() {
      return [[1, 2]];
    },
  };
}

// ── Transistors ─────────────────────────────────────────────────────────────

/**
 * The three pins of a TO-92, in the ONE generic order this app draws: the
 * control in the middle, the switched pins either side (E·B·C, S·G·D — the
 * order a 2N2222, 2N3904, 2N3906 or 2N7000 has). It is not any one maker's
 * pinout: a BC547 is C·B·E, and a transistor turns end-for-end with R. The
 * KiCad export numbers its TO-92 pads in this order and says to check them.
 *
 * The control is an `input` (it reads a level and drives nothing); the
 * switched pins are `io`, an analog switch's terminals, which is what they
 * are to the engine.
 */
const BJT_PINS = (npn) => [
  {
    n: 1,
    name: "E",
    role: "io",
    detail: npn ? "emitter — usually to GND" : "emitter — usually to +V",
  },
  {
    n: 2,
    name: "B",
    role: "input",
    detail: npn
      ? "base — HIGH turns it on; floating, it is off"
      : "base — LOW turns it on; floating, it is off",
  },
  { n: 3, name: "C", role: "io", detail: "collector — to the load" },
];
const FET_PINS = (nChannel) => [
  {
    n: 1,
    name: "S",
    role: "io",
    detail: nChannel ? "source — usually to GND" : "source — usually to +V",
  },
  {
    n: 2,
    name: "G",
    role: "input",
    detail: nChannel
      ? "gate — HIGH turns it on; floating, it holds its last state"
      : "gate — LOW turns it on; floating, it holds its last state",
  },
  { n: 3, name: "D", role: "io", detail: "drain — to the load" },
];

/**
 * The packages a transistor can be drawn and exported in, the default first:
 * a MOSFET a TO-220 (the power part an IRLZ44N or an IRF520 is) or a TO-92 (a
 * 2N7000, a BS170); a BJT a TO-92 (a 2N3904) or a TO-220 (a TIP120, a
 * TIP31C). Both stand over three holes in a row — a TO-220's legs are on
 * 0.1 in too. A MOSFET always stores its package; a BJT only a TO-220, so
 * every document from before it had the choice reads as it did.
 */
export const MOSFET_CASES = Object.freeze(["TO-220", "TO-92"]);
export const BJT_CASES = Object.freeze(["TO-92", "TO-220"]);

/** The Package field, its options package NAMES, the same in every
    language; a BJT's shows its default when none is stored. */
const caseField = (cases) =>
  Object.freeze({
    key: "case",
    label: "Package",
    type: "segmented",
    default: cases[0],
    options: Object.freeze(
      cases.map((value) => Object.freeze({ value, label: value })),
    ),
  });

/**
 * Each transistor type's Spice Lite GRADES (features/spice-lite-3-plan.md,
 * "Spice-only properties"): which representative part's figures it
 * simulates with (sim/spice/transistors.js holds them). The first is a
 * TO-92's default, Power a TO-220's (Jason, 2026-10-08). The labels are the
 * catalog's English (`properties.option.<value>` translates them); `part`
 * is printed beside each, the same in every language.
 */
export const TRANSISTOR_GRADES = Object.freeze({
  npn: Object.freeze([
    Object.freeze({ value: "small-signal", label: "Small signal", part: "2N3904" }), // prettier-ignore
    Object.freeze({ value: "general", label: "General purpose", part: "2N2222A" }), // prettier-ignore
    Object.freeze({ value: "darlington", label: "Darlington", part: "TIP120" }),
    Object.freeze({ value: "power", label: "Power", part: "TIP31C" }),
  ]),
  pnp: Object.freeze([
    Object.freeze({ value: "small-signal", label: "Small signal", part: "2N3906" }), // prettier-ignore
    Object.freeze({ value: "general", label: "General purpose", part: "2N2907A" }), // prettier-ignore
    Object.freeze({ value: "darlington", label: "Darlington", part: "TIP125" }),
    Object.freeze({ value: "power", label: "Power", part: "TIP32C" }),
  ]),
  nmos: Object.freeze([
    Object.freeze({ value: "logic", label: "Logic level", part: "2N7000" }),
    Object.freeze({ value: "logic-power", label: "Logic-level power", part: "IRLZ44N" }), // prettier-ignore
    Object.freeze({ value: "power", label: "Power", part: "IRF540N" }),
  ]),
  pmos: Object.freeze([
    Object.freeze({ value: "logic", label: "Logic level", part: "BS250" }),
    Object.freeze({ value: "power", label: "Power", part: "IRF9540N" }),
  ]),
});

/** A transistor's grade when none is stored: Power in a TO-220, else its
    type's first. */
export function defaultGrade(type, pkg) {
  const grades = TRANSISTOR_GRADES[type] ?? [];
  if (pkg === "TO-220" && grades.some((g) => g.value === "power")) return "power"; // prettier-ignore
  return grades[0]?.value ?? null;
}

/**
 * The grade a transistor simulates as under Spice Lite: its stored `grade`
 * when its type has it, else its package's default.
 * @param {object|null} def
 * @param {object} [params]
 */
export function transistorGrade(def, params) {
  const type = def?.transistor?.type;
  const grades = TRANSISTOR_GRADES[type] ?? [];
  if (grades.some((g) => g.value === params?.grade)) return params.grade;
  return defaultGrade(type, transistorCase(def, params));
}

/** The Grade field (spiceOnly): its type's grades, each with its
    representative part beside it; its default the package's. */
const gradeField = (type, cases) =>
  Object.freeze({
    key: "grade",
    label: "Grade",
    type: "select",
    spiceOnly: true,
    default: (values) => defaultGrade(type, caseAmong(cases, values)),
    options: Object.freeze(
      TRANSISTOR_GRADES[type].map((g) =>
        Object.freeze({ value: g.value, label: g.label, detail: g.part }),
      ),
    ),
  });

/**
 * The package a transistor is in: its params' choice among its def's
 * `transistor.cases`, else the first of them. The one place it is read, so
 * the drawing, the box, the BOM and the export can never disagree.
 * @param {object|null} def
 * @param {{case?: unknown}|null} [params]
 * @returns {string|null}
 */
export function transistorCase(def, params) {
  return caseAmong(def?.transistor?.cases ?? [], params);
}

/** `params.case` when it is one of `cases`, else the first of them. */
const caseAmong = (cases, params) =>
  cases.includes(params?.case) ? params.case : (cases[0] ?? null);

/** What every transistor's blurb says about how it is placed. */
const placementNote = (cases) =>
  (cases.length > 1
    ? `A ${cases[0]} (or a ${cases.slice(1).join(", ")} — pick its Package ` +
      "in Properties) standing over three holes in a row"
    : `A ${cases[0]} standing over three holes in a row`) +
  "; its pin letters are printed on it, and R with it selected turns it " +
  "end-for-end. Real pinouts differ by part number, so check yours. In the " +
  "digital sim no gain, threshold, saturation or on-resistance is " +
  "modelled — put a resistor in an LED's leg as you would on a bench. Set " +
  "an optional part number in Properties.";

/** The four transistors are one part to the user, its Type swapped in place
    (value-fields.js `partTypeField`) — four kinds, so a list, not a track. */
const TRANSISTORS = Object.freeze(["npn", "pnp", "nmos", "pmos"]);
const TRANSISTOR_TYPE_FIELD = partTypeField(
  [
    { value: "npn", label: "NPN" },
    { value: "pnp", label: "PNP" },
    { value: "nmos", label: "N-channel MOSFET" },
    { value: "pmos", label: "P-channel MOSFET" },
  ],
  "select",
);

/** What a transistor is under Spice Lite, where it is no switch. */
const BJT_SPICE_NOTE =
  "Under Spice Lite it is a transistor of the Grade its Properties pick " +
  "(small signal by default, power in a TO-220; a Darlington too): its base " +
  "conducts from about 0.6 V (1.2 V a Darlington), its collector carries " +
  "its gain times the base current as far as the circuit allows, and it " +
  "saturates as its datasheet's part does.";
const MOSFET_SPICE_NOTE =
  "Under Spice Lite its channel opens past its Grade's gate threshold " +
  "(logic level by default, power in a TO-220) along its datasheet's " +
  "transfer curve, and its gate keeps the voltage it was last driven to.";

/**
 * One transistor def. `type` names it (the data hook the drawing, the
 * schematic and the export read); `onLevel` is what its control must read to
 * turn it on; `holds` marks a MOSFET, whose gate keeps its last state.
 */
function transistorDef({ id, title, blurb, type, onLevel, holds }) {
  const pins = holds ? FET_PINS(onLevel === H) : BJT_PINS(onLevel === H);
  const cases = holds ? MOSFET_CASES : BJT_CASES;
  return {
    id,
    kind: "discrete",
    title,
    blurb: `${blurb} ${holds ? MOSFET_SPICE_NOTE : BJT_SPICE_NOTE} ${placementNote(cases)}`, // prettier-ignore
    group: "Transistors",
    footprint: Object.freeze({ offsets: Object.freeze([0, 1, 2]) }),
    // Turns end-for-end in place (params.rot 180), as the resistor array
    // does: the same three holes, the pin order reversed.
    reversible: true,
    // `cases` are the packages it can be drawn and exported in
    // (transistorCase).
    transistor: Object.freeze({ type, holds, cases }),
    // A base or gate nothing drives is UNDEFINED to the switch, never the
    // HIGH a TTL input would read (catalog/families.js `floatsUnknown`).
    floating: "unknown",
    countsAsConnection: true,
    swapsWith: TRANSISTORS,
    // The part number is a combo of this type's common parts
    // (value-fields.js `transistorPartField`) — still only a label.
    properties: [
      TRANSISTOR_TYPE_FIELD,
      caseField(cases),
      gradeField(type, cases),
      transistorPartField(type),
    ],
    pins,
    // Swapped in from another type (DeskDoc.setComponentRef): a part number
    // that type's list holds names a part this one is not, so it goes; one
    // on no list is the user's, and stays.
    adoptParams(params) {
      const owner = transistorTypeOf(params?.partNumber);
      if (!owner || owner === type) return params;
      const { partNumber: _dropped, ...rest } = params;
      return rest;
    },
    normalizeParams(raw) {
      // A MOSFET's package is always stored (a document has always held
      // one); a BJT's only when it is not the TO-92 every BJT once was. The
      // Spice Lite grade only when it is not its package's default.
      const pkg = caseAmong(cases, raw);
      const grade = TRANSISTOR_GRADES[type].some((g) => g.value === raw?.grade) ? raw.grade : null; // prettier-ignore
      return withPartNumber(
        {
          ...(raw?.rot === 180 ? { rot: 180 } : {}),
          ...(holds || pkg !== cases[0] ? { case: pkg } : {}),
          ...(grade && grade !== defaultGrade(type, pkg) ? { grade } : {}),
        },
        raw,
      );
    },
    // No bridge: whether it conducts is a question about LEVELS, which only
    // the engine can answer — the channel below.
    internalBridges() {
      return [];
    },
    logic: transistorSwitch({ control: 2, a: 1, b: 3, onLevel, holds }),
  };
}

export const DISCRETE_DEFS = Object.freeze(
  [
    {
      id: "cap-ceramic",
      kind: "discrete",
      title: "Capacitor (ceramic)",
      blurb:
        "Ceramic disc capacitor — non-polarised, either way round. Set its " +
        "Capacitance in Properties (100p, 10n, 4.7µ, 4u7…), and an optional " +
        "part number. " +
        CAPACITOR_NOTE +
        " Press R while placing to stand it up and pick two free ends.",
      group: "Capacitors",
      // A disc's leads at 2.5 mm (0.1 in) — adjacent holes, as the
      // electrolytic's are.
      footprint: Object.freeze({ offsets: Object.freeze([0, 1]) }),
      rotatable: true,
      minSpan: 1,
      // The data hook every consumer branches on (the trace, the drop note,
      // the BOM, the export) — never an id.
      capacitor: Object.freeze({ polarized: false }),
      countsAsConnection: true,
      swapsWith: CAPACITORS,
      properties: [
        CAPACITOR_TYPE_FIELD,
        capacitanceField(VALUE_RANGES.ceramic, CERAMIC_VALUES),
        PART_NUMBER_FIELD,
      ],
      pins: [
        { n: 1, name: "1", role: "lead" },
        { n: 2, name: "2", role: "lead" },
      ],
      normalizeParams: (raw) => capacitorParams(raw, 100e-9),
      // A non-connect, always: no bridge, hard or weak.
      internalBridges() {
        return [];
      },
    },
    {
      id: "cap-electrolytic",
      kind: "discrete",
      title: "Capacitor (electrolytic)",
      blurb:
        "Aluminium electrolytic capacitor — POLARISED: pin 1 is +, pin 2 is " +
        "−, which the stripe down its side marks. Set its Capacitance in " +
        "Properties (1µ, 10µ, 4u7, 470µ…), and an optional part number. " +
        CAPACITOR_NOTE +
        " Its polarity is drawn and exported; wiring it backwards changes " +
        "nothing in the sim. Press R while placing to stand it up and pick " +
        "two free ends.",
      group: "Capacitors",
      // A small radial can's leads at 2.5 mm (0.1 in).
      footprint: Object.freeze({ offsets: Object.freeze([0, 1]) }),
      rotatable: true,
      minSpan: 1,
      capacitor: Object.freeze({ polarized: true }),
      countsAsConnection: true,
      swapsWith: CAPACITORS,
      properties: [
        CAPACITOR_TYPE_FIELD,
        capacitanceField(VALUE_RANGES.electrolytic, ELECTROLYTIC_VALUES),
        PART_NUMBER_FIELD,
      ],
      pins: [
        { n: 1, name: "+", role: "lead" },
        { n: 2, name: "-", role: "lead" },
      ],
      normalizeParams: (raw) => capacitorParams(raw, 10e-6),
      internalBridges() {
        return [];
      },
    },
    diodeDef({
      id: "diode",
      title: "Diode",
      blurb:
        "Small-signal or rectifier diode (a 1N4148, a 1N4001) — anode at " +
        "pin 1, cathode at pin 2, the end the band marks. " +
        DIODE_NOTE +
        " Press R while placing to stand it up and pick two free ends.",
      zener: false,
    }),
    diodeDef({
      id: "zener",
      title: "Zener diode",
      blurb:
        "Zener diode — anode at pin 1, cathode at pin 2, the end the band " +
        "marks. Set its Zener voltage (5.1V, 5V1, 3.3…) in Properties; it is " +
        "printed and exported. In the digital sim it is exactly a diode: " +
        "reverse breakdown — what a Zener is for — is analog, so it regulates " +
        "nothing there; under Spice Lite it conducts backwards at its Zener " +
        "voltage and clamps. " +
        DIODE_NOTE +
        " Press R while placing to stand it up and pick two free ends.",
      zener: true,
    }),
    {
      id: "inductor",
      kind: "discrete",
      title: "Inductor",
      blurb:
        "Axial inductor (a choke). Set an optional Inductance (100n, 10µ, " +
        "4u7, 100m, 1H…) and part number in Properties; both are printed and " +
        "exported. Properties also picks which it is — a Coil (copper wound " +
        "round a ferrite ring) or a Can (a drum in a black sleeve, its value " +
        "printed on top) — and how many holes its body covers between its " +
        "leads (1, 2 or 3, the smallest part to the biggest). " +
        "In the digital sim it conducts exactly like a WIRE — its two leads " +
        "are one net — because at DC that is what a coil is, so one wired " +
        "across the rails is a short. Under Spice Lite one with an " +
        "Inductance is a real inductor: its current cannot change in an " +
        "instant, it rises and dies away through its winding's resistance " +
        "(Properties ▸ Winding, shown under Spice Lite), and switched off " +
        "with no diode across it, it kicks the transistor that switched it " +
        "into breakdown. With no Inductance it is a wire under both. Press R " +
        "while placing to stand it up and pick two free ends.",
      group: "Inductors",
      // Leads 0.3 in (7.62 mm) apart — or 0.2 / 0.4 in, set to one or three
      // holes between them (`offsetsFor`, read through catalog/index.js
      // `footprintOffsets`).
      footprint: Object.freeze({ offsets: INDUCTOR_OFFSETS[INDUCTOR_DEFAULT_HOLES] }), // prettier-ignore
      offsetsFor: (params) => INDUCTOR_OFFSETS[inductorHoles(params)],
      rotatable: true,
      // Two pitches: the 1-hole part's own leads, lying along a row.
      minSpan: 2,
      inductor: true,
      countsAsConnection: true,
      properties: [
        INDUCTANCE_FIELD,
        INDUCTOR_STYLE_FIELD,
        BODY_HOLES_FIELD,
        WINDING_FIELD,
        PART_NUMBER_FIELD,
      ],
      pins: [
        { n: 1, name: "1", role: "lead" },
        {
          n: 2,
          name: "2",
          role: "lead",
          detail:
            "2, 3 or 4 holes along from pin 1 (1, 2 or 3 between the leads)",
        },
      ],
      normalizeParams(raw) {
        const henries = storedValue(raw?.henries, "henry", undefined);
        return withPartNumber(
          {
            ...(henries != null ? { henries } : {}),
            style: INDUCTOR_STYLES.includes(raw?.style)
              ? raw.style
              : INDUCTOR_STYLES[0],
            bodyHoles: inductorHoles(raw),
            // Spice Lite's Winding, stored only when it is not Typical.
            ...(inductorWinding(raw) !== DEFAULT_WINDING ? { winding: inductorWinding(raw) } : {}), // prettier-ignore
            ...leadGeometry(raw),
          },
          raw,
        );
      },
      // A WIRE: the two leads are one net, in the netlist as on the bench.
      internalBridges() {
        return [[1, 2]];
      },
    },
    transistorDef({
      id: "npn",
      title: "NPN transistor (BJT)",
      blurb:
        "NPN bipolar transistor, pins E · B · C. In this logic sim it is a " +
        "SWITCH: while the base reads HIGH, collector and emitter are joined; " +
        "otherwise they are apart. A base that is floating or undefined " +
        "passes no current, so the transistor is off — a BJT remembers " +
        "nothing.",
      type: "npn",
      onLevel: H,
      holds: false,
    }),
    transistorDef({
      id: "pnp",
      title: "PNP transistor (BJT)",
      blurb:
        "PNP bipolar transistor, pins E · B · C. In this logic sim it is a " +
        "SWITCH: while the base reads LOW, emitter and collector are joined; " +
        "otherwise they are apart. A base that is floating or undefined " +
        "passes no current, so the transistor is off — a BJT remembers " +
        "nothing.",
      type: "pnp",
      onLevel: L,
      holds: false,
    }),
    transistorDef({
      id: "nmos",
      title: "N-channel MOSFET",
      blurb:
        "N-channel enhancement MOSFET, pins S · G · D. In this logic sim it " +
        "is a SWITCH: while the gate reads HIGH, drain and source are joined; " +
        "while it reads LOW they are apart. The gate stores charge, so a gate " +
        "left floating or undefined HOLDS the last state it was driven to — " +
        "off until it has been driven at all — and the part shows that it is " +
        "holding. On a real board that charge leaks away: tie the gate down " +
        "with a resistor.",
      type: "nmos",
      onLevel: H,
      holds: true,
    }),
    transistorDef({
      id: "pmos",
      title: "P-channel MOSFET",
      blurb:
        "P-channel enhancement MOSFET, pins S · G · D. In this logic sim it " +
        "is a SWITCH: while the gate reads LOW, source and drain are joined; " +
        "while it reads HIGH they are apart. The gate stores charge, so a " +
        "gate left floating or undefined HOLDS the last state it was driven " +
        "to — off until it has been driven at all — and the part shows that " +
        "it is holding. On a real board that charge leaks away: tie the gate " +
        "up with a resistor.",
      type: "pmos",
      onLevel: L,
      holds: true,
    }),
  ].map(Object.freeze),
);
