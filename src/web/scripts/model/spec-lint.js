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

// spec-lint.js — the electrical rules a generated netlist is held to that no
// simulation will report on its own.
//
// Each of these is a circuit that LOADS, SETTLES and VERIFIES while doing
// something other than what was meant, because the engine is right to accept
// it:
//
//   * An output tied straight to a supply rail. The engine gives a supply
//     precedence over a chip output (sim/resolve.js), so the net simply reads
//     as the rail and the output drives nothing — no short, no conflict.
//   * An input left out of the netlist. A floating TTL input reads HIGH
//     (sim/levels.js), so an enable nobody wired quietly disables the part,
//     and a clear nobody wired quietly holds it — every net still settles.
//   * Two outputs on one net. The engine does report that — but only in a
//     state where they disagree, and only the states something exercises.
//
// Pure and DOM-free: the compiler (autobuild.js) asks the driver questions of
// each net as it resolves the spec, and the verifier (autobuild-verify.js)
// asks the floating-input question of the finished build.

import { outputEnablePins } from "../catalog/index.js";
import { floatsUnknown } from "../catalog/families.js";
import {
  evaluate,
  hasLogic,
  isMemory,
  isSequential,
} from "../sim/chip-eval.js";
import { H, L, Z } from "../sim/levels.js";

const NONE = Object.freeze(new Set());
const switchable = new Map(); // def id → Set of pin numbers

const drives = (p) => p.role === "output" || p.role === "io";

/**
 * The output pins a part's output enables can FLOAT — the ones that may share
 * a net with another driver, because they can be switched off while it
 * drives.
 *
 * Probed from the real evaluator rather than assumed from `outputEnables`,
 * because an enable does not have to gate every output: the '595's OE floats
 * QA–QH and leaves its serial QH' driving regardless. Every enable off, every
 * other input LOW; whatever reads Z is switchable. `chips-tristate.test.js`
 * proves each declared enable floats something, which is what makes a single
 * all-enables-off vector sufficient here.
 *
 * @param {object} def  a catalog def
 * @returns {Set<number>}
 */
export function switchableOutputs(def) {
  const enables = outputEnablePins(def);
  if (!enables.length) return NONE;
  const known = switchable.get(def.id);
  if (known) return known;
  // A memory's data pins float on its chip/output enables by construction
  // (`memUnit`), and it cannot be probed without an image — so every one of
  // them is switchable, which is what lets two ROMs share a data bus.
  if (isMemory(def)) {
    const pins = new Set(def.pins.filter(drives).map((p) => p.n));
    switchable.set(def.id, pins);
    return pins;
  }
  // Each enable at its OFF level (HIGH for an active-LOW one, LOW for the
  // 4094's active-HIGH one).
  const off = new Map(enables.map((e) => [e.n, e.on === L ? H : L]));
  const levels = new Map();
  for (const p of def.pins ?? []) {
    if (p.role === "vcc" || p.role === "gnd" || p.role === "nc") continue;
    levels.set(p.n, off.get(p.n) ?? L);
  }
  let out = null;
  if (hasLogic(def)) out = evaluate(def, levels);
  else if (isSequential(def))
    out = def.logic.outputs(def.logic.state0(), levels);
  const pins = new Set(
    (def.pins ?? [])
      .filter((p) => drives(p) && out?.get(p.n) === Z)
      .map((p) => p.n),
  );
  switchable.set(def.id, pins);
  return pins;
}

/**
 * The drivers among one net's resolved pins, split by whether they can be
 * switched off.
 *
 * Only `output`-role pins count. A bidirectional (`io`) pin — a memory's data
 * line, a transceiver's port — drives or listens by protocol, so a bus of them
 * is the ordinary case and is left to the engine, which reports a fight in any
 * state that has one.
 *
 * @param {Array<{partId:string, kind:string, pin?:number}>} pins
 * @param {Map<string, {def:object}>} parts  spec id → part
 * @returns {{hard: Array, switchable: Array}} each entry `{partId, pin, name}`
 */
export function netDrivers(pins, parts) {
  const hard = [];
  const soft = [];
  for (const m of pins) {
    if (m.kind !== "pin") continue;
    const def = parts.get(m.partId)?.def;
    const p = def?.pins?.find((q) => q.n === m.pin);
    if (p?.role !== "output") continue;
    const entry = { partId: m.partId, pin: m.pin, name: p.name };
    (switchableOutputs(def).has(m.pin) ? soft : hard).push(entry);
  }
  return { hard, switchable: soft };
}

/** `U1.1Y (pin 3)` — how a fault names a pin, in the spec's own terms. */
export const pinLabel = (d) => `${d.partId}.${d.name} (pin ${d.pin})`;

/** The unit a pin belongs to by the datasheet convention: `2CLK` → "2". */
const unitOf = (name) => /^(\d+)(?=[A-Za-z])/.exec(String(name))?.[1] ?? null;

/**
 * The CMOS sheets number a section at the END instead (Feature 400): the
 * CD4013B's `CLOCK1`, `D2`, `Q̄1`. Only for a CD4000 part — read on a TTL one
 * it would turn the '193's `D0`…`D3` into four "sections" and stop requiring
 * three of them. A bare number (`5`, the 4017's decoded output) is a name,
 * not a section.
 */
const cmosUnitOf = (name) =>
  /(?:[A-Za-z]|\u0304)(\d+)$/.exec(String(name))?.[1] ?? null;

/**
 * The inputs a part USES, given which of its pins the netlist connects — the
 * one rule `floatingInputs` (an input in use but unwired) and
 * `spareCmosInputs` (a CMOS input nothing uses) are the two sides of.
 * @param {object} def
 * @param {(n: number) => boolean} on  is pin n in a net?
 * @returns {Set<number>}
 */
function requiredInputs(def, on) {
  const pins = def?.pins ?? [];
  const need = new Set();
  const units = def.logic?.units;
  if (units?.length) {
    for (const u of units) {
      if (!on(u.output)) continue;
      for (const n of u.inputs ?? []) need.add(n);
      if (u.enable != null) need.add(u.enable);
    }
    return need;
  }
  const sectionOf = floatsUnknown(def) ? cmosUnitOf : unitOf;
  const outs = pins.filter(drives);
  const used = outs.length ? outs.filter((p) => on(p.n)) : [];
  const anyUsed = outs.length ? used.length > 0 : pins.some((p) => on(p.n));
  const sections = new Set(used.map((p) => sectionOf(p.name)).filter(Boolean));
  for (const p of pins) {
    if (p.role !== "input") continue;
    const section = sectionOf(p.name);
    if (section ? sections.has(section) : anyUsed) need.add(p.n);
  }
  return need;
}

/** `partId.pin` for every pin a net connects. */
function connectedPins(nets) {
  const connected = new Set();
  for (const net of nets) {
    for (const m of net.pins ?? []) {
      if (m.kind === "pin") connected.add(`${m.partId}.${m.pin}`);
    }
  }
  return connected;
}

/**
 * Inputs a part USES but the netlist never connects.
 *
 * "Uses" is the part of this that needs care, because an unused section of a
 * part is allowed to float — nobody ties off the three spare gates of a 7400
 * they took one gate from. So an input is required when something it feeds is
 * in use:
 *
 *   * A part whose behaviour is a list of UNITS (gates, tri-state buffers, the
 *     COMB units of decoders and muxes) says exactly that: a unit whose output
 *     is on a net needs every input and enable it reads.
 *   * Anything else — flip-flops, counters, memory, a CPU — is read by the
 *     datasheet's own naming: pins numbered `1…`/`2…` belong to that section,
 *     and a section is in use when one of its outputs is. An input with no
 *     section number (a shared CLK, CLR, OE, an address line) is needed as soon
 *     as ANY output of the part is used, or — for a part with no outputs — as
 *     soon as any of its pins is.
 *
 * Only `input`-role pins are ever required: power is the compiler's, and an
 * `io` line left off a bus is a narrower bus, not a floating control.
 *
 * @param {Array<{id:string, def:object}>} parts  spec parts
 * @param {Array<{pins:Array}>} nets  resolved nets
 * @returns {Array<{partId:string, ref:string, pins:Array<{n:number, name:string}>}>}
 */
export function floatingInputs(parts, nets) {
  const connected = connectedPins(nets);
  const out = [];
  for (const { id, def } of parts) {
    const pins = def?.pins ?? [];
    if (!pins.some((p) => p.role === "input")) continue;
    const on = (n) => connected.has(`${id}.${n}`);
    const need = requiredInputs(def, on);
    const loose = pins.filter(
      (p) => p.role === "input" && need.has(p.n) && !on(p.n),
    );
    if (loose.length) {
      out.push({
        partId: id,
        ref: def.id,
        pins: loose.map((p) => ({ n: p.n, name: p.name })),
      });
    }
  }
  return out;
}

/**
 * The CMOS inputs NOTHING uses — the spare gates of a CD4000 part, the unused
 * flip-flop of a 4013 (Feature 400).
 *
 * A TTL designer leaves these floating and is right to (a floating TTL input
 * reads HIGH, harmlessly). A CMOS one is not: a floating CMOS input reads
 * unknown, and the datasheets say to tie every unused input. A netlist should
 * not have to say so, any more than it says which resistor limits an LED, so
 * the compiler ties these to GND (autobuild.js). An input the part DOES use is
 * not here: leaving one of those out is the spec's mistake, which
 * `floatingInputs` reports.
 *
 * @param {Array<{id:string, def:object}>} parts  spec parts
 * @param {Array<{pins:Array}>} nets  resolved nets
 * @returns {Array<{partId:string, ref:string, pins:Array<{n:number, name:string}>}>}
 */
export function spareCmosInputs(parts, nets) {
  const connected = connectedPins(nets);
  const out = [];
  for (const { id, def } of parts) {
    if (!floatsUnknown(def)) continue;
    const on = (n) => connected.has(`${id}.${n}`);
    const need = requiredInputs(def, on);
    const spare = (def.pins ?? []).filter(
      (p) => p.role === "input" && !need.has(p.n) && !on(p.n),
    );
    if (spare.length) {
      out.push({
        partId: id,
        ref: def.id,
        pins: spare.map((p) => ({ n: p.n, name: p.name })),
      });
    }
  }
  return out;
}
