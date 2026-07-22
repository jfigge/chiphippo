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

// symbols.js — the LOGICAL symbol of each chip, derived from its catalog def
// exactly the way footprints.js derives seated holes: pure data, no per-chip
// drawing code. The schematic view (Feature 150) draws a box with named pin
// stubs grouped by side, and the layout router connects the stubs by net.
//
// Grouping rules (deterministic, from the def's pins + Feature 130 pinGroups):
//   • VCC → a stub on the TOP edge, GND → a stub on the BOTTOM edge (real
//     schematics drop rail symbols at these rather than route them),
//   • a `pinGroups` bus collapses its whole run into ONE bus stub (dir in →
//     left, out → right, io → left),
//   • every remaining functional pin is one stub: input/io on the LEFT,
//     output on the RIGHT,
//   • NC pins are omitted — a schematic shows only what carries signal.
//
// A chip whose `logic.units` are all one gate primitive also carries a
// distinctive-shape `glyph` (AND/OR/NAND/NOR/XOR/NOT/BUFFER) the view draws as
// a small type badge; multi-function parts (decoders, counters, sequential)
// are a plain labelled box. The glyph is keyed off the SAME `logic.units` the
// evaluator walks, so it can never disagree with the simulated behavior.

import { CHIP_DEFS, chipDef, partDef } from "./index.js";

/** Which box edge a functional pin/bus of a given role/direction sits on. */
function sideForRole(role) {
  return role === "output" ? "right" : "left"; // input & io read on the left
}

/** A bus tap's electrical role, from its `pinGroups` direction. */
function roleForBusDir(dir) {
  if (dir === "out") return "output";
  if (dir === "io") return "io";
  return "input";
}

/** Gate-primitive fn → distinctive-shape glyph name, or null (no shape). */
const GLYPH_OF_FN = Object.freeze({
  AND: "AND",
  OR: "OR",
  NAND: "NAND",
  NOR: "NOR",
  XOR: "XOR",
  INV: "NOT",
  BUF3: "BUFFER",
});

/**
 * The distinctive-shape glyph for a def, or null. Only a chip whose every
 * combinational unit is the SAME gate primitive earns a glyph (a quad NAND is
 * still "a NAND"); mixed or `COMB`/sequential parts stay a plain box.
 */
export function glyphOf(def) {
  const units = def?.logic?.units;
  if (!units?.length) return null; // sequential parts have no units
  const fns = new Set(units.map((u) => u.fn));
  if (fns.size !== 1) return null;
  return GLYPH_OF_FN[units[0].fn] ?? null;
}

/**
 * Build the logical symbol record for a chip def. Pure: derives from the def's
 * `pins` + `pinGroups` only, never mutates it.
 *
 * @param {object} def - a catalog chip def.
 * @returns {{ id, label, title, glyph, sides:{left,right,top,bottom} }}
 *   Each side is an ordered list of stubs; a stub is either
 *   `{ kind:"pin", pin, name, role }` or
 *   `{ kind:"bus", name, pins, dir, role }`.
 */
export function buildSymbol(def) {
  const sides = { left: [], right: [], top: [], bottom: [] };

  // First member of a pinGroup → the group; every later member is skipped so
  // the whole run collapses to one bus stub.
  const groupOfPin = new Map();
  for (const g of def.pinGroups ?? []) {
    for (const pin of g.pins) if (!groupOfPin.has(pin)) groupOfPin.set(pin, g);
  }
  const emittedGroups = new Set();

  for (const p of def.pins) {
    if (p.role === "vcc") {
      sides.top.push({ kind: "pin", pin: p.n, name: p.name, role: p.role });
      continue;
    }
    if (p.role === "gnd") {
      sides.bottom.push({ kind: "pin", pin: p.n, name: p.name, role: p.role });
      continue;
    }
    if (p.role === "nc") continue; // omit no-connects from the symbol

    const group = groupOfPin.get(p.n);
    if (group) {
      if (emittedGroups.has(group)) continue; // already represented
      emittedGroups.add(group);
      const role = roleForBusDir(group.dir);
      sides[sideForRole(role)].push({
        kind: "bus",
        name: group.name,
        pins: [...group.pins],
        dir: group.dir,
        role,
      });
      continue;
    }
    sides[sideForRole(p.role)].push({
      kind: "pin",
      pin: p.n,
      name: p.name,
      role: p.role,
    });
  }

  return {
    id: def.id,
    label: def.id,
    title: def.title,
    kind: "chip",
    glyph: glyphOf(def),
    sides,
  };
}

// ── Non-chip parts: distinctive-shape symbols + boxes (Feature 150) ──────────
//
// A discrete or brick renders either as a distinctive SCHEMATIC SHAPE (a diode
// triangle, a resistor body, a switch, a source) with a fixed set of TERMINALS,
// or — for the many-pinned displays / resistor array — as a plain labelled box
// like a chip. A terminal references a pin number (`pin`, a seated discrete) or
// a brick terminal id (`terminal`, a PSU/clock pad); the geometry lives in
// schematic-layout.js, exactly as the chip box geometry does.

/** id → distinctive shape + its terminals (side + the pin/terminal it maps). */
const SHAPE_DEFS = Object.freeze({
  led: {
    shape: "led",
    terminals: [
      { name: "A", side: "top", pin: 1 },
      { name: "K", side: "bottom", pin: 2 },
    ],
  },
  resistor: {
    shape: "resistor",
    terminals: [
      { name: "1", side: "left", pin: 1 },
      { name: "2", side: "right", pin: 2 },
    ],
  },
  "sw-slide": {
    shape: "switch",
    terminals: [
      { name: "C", side: "left", pin: 2 },
      { name: "1", side: "right", pin: 1, offset: -1 },
      { name: "2", side: "right", pin: 3, offset: 1 },
    ],
  },
  "sw-push": {
    shape: "button",
    terminals: [
      { name: "1", side: "left", pin: 1 },
      { name: "2", side: "right", pin: 2 },
    ],
  },
  psu: {
    shape: "psu",
    terminals: [
      { name: "+", side: "top", terminal: "+" },
      { name: "−", side: "bottom", terminal: "-" },
    ],
  },
  clock: {
    shape: "clock",
    terminals: [
      { name: "clk", side: "right", terminal: "out" },
      { name: "gnd", side: "bottom", terminal: "gnd" },
    ],
  },
});

/** Short type label shown in the symbol (params add volts/ohms/Hz in the view). */
const SHAPE_LABEL = Object.freeze({
  psu: "PSU",
  clock: "CLK",
});

/** Which box edge a discrete pin sits on: the "return" pins (cathode / common /
    ground) exit RIGHT, everything else (anode / lead / contact) exits LEFT. */
function partPinSide(role) {
  return role === "cathode" || role === "common" || role === "gnd"
    ? "right"
    : "left";
}

/** A box symbol for a many-pinned discrete (a display / resistor array). */
function buildPartBox(def) {
  const sides = { left: [], right: [], top: [], bottom: [] };
  for (const p of def.pins) {
    sides[partPinSide(p.role)].push({
      kind: "pin",
      pin: p.n,
      name: p.name,
      role: p.role,
    });
  }
  return {
    id: def.id,
    label: def.id,
    title: def.title,
    kind: "box",
    glyph: null,
    sides,
  };
}

/** The logical symbol for a discrete part or a desk brick (PSU / clock). */
export function buildPartSymbol(def) {
  const spec = SHAPE_DEFS[def.id];
  if (spec) {
    return {
      id: def.id,
      label: SHAPE_LABEL[def.id] ?? "",
      title: def.title,
      kind: "shape",
      shape: spec.shape,
      terminals: spec.terminals.map((t) => ({
        key: t.terminal != null ? `t:${t.terminal}` : `pin:${t.pin}`,
        name: t.name,
        side: t.side,
        offset: t.offset ?? 0,
        pin: t.pin ?? null,
        terminal: t.terminal ?? null,
      })),
    };
  }
  return buildPartBox(def);
}

/** Every chip's logical symbol, keyed by catalog id. */
export const SYMBOLS = new Map(
  CHIP_DEFS.map((def) => [def.id, buildSymbol(def)]),
);

/**
 * The logical symbol for ANY catalog id — chip, discrete, or brick — or null.
 * Chips are boxes with pin-role sides; discretes/bricks are distinctive shapes
 * (or boxes for the many-pinned displays).
 */
export function symbolFor(ref) {
  const cached = SYMBOLS.get(ref);
  if (cached) return cached;
  const chip = chipDef(ref);
  if (chip) return buildSymbol(chip);
  const part = partDef(ref);
  return part ? buildPartSymbol(part) : null;
}

/** Every stub of a symbol, flattened with its side tag. */
export function symbolStubs(symbol) {
  const out = [];
  for (const side of ["left", "right", "top", "bottom"]) {
    for (const stub of symbol.sides[side]) out.push({ ...stub, side });
  }
  return out;
}
