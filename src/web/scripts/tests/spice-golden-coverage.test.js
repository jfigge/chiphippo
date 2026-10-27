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

// Every part Spice Lite models is graded against ngspice (2026-10-26, the
// fix round's phase 5: "every catalog part with a Spice Lite model must
// appear in at least one golden case"). What a part is modelled BY is read
// off the catalog fields the engine reads and the engine's own device tables
// — never a list of what is modelled — so a new part, a new transistor grade,
// a new LED colour or a new meter element fails here, by name, until a case
// in spice-golden-cases.js grades it.
//
// Logic-only chips (gates, flip-flops, counters, memories, processors) are
// graded by FAMILY, not part by part: their Spice Lite model is their
// family's input and output stages (spice/params.js, spice/output-stage.js),
// which the stage areas grade — `ls-stage` the 74LS04's own schematic,
// `cmos-stage` the CD4000 square law — so one case of the family covers
// every part in it ("stage:74LS", "stage:CD4000", and "stage:none" for the
// family-less parts' common MOS stage). A chip with figures of its OWN (its
// silicon, an op-amp, an optocoupler, a transistor array, an output stage of
// its own, Schmitt thresholds, analog switch channels) is graded by part; an
// open-collector output by family ("open-collector:74LS").

import test from "node:test";
import assert from "node:assert/strict";
import { BRICK_KINDS, PALETTE_DEFS, partDef } from "../catalog/index.js";
import { familyOf } from "../catalog/families.js";
import {
  diodeGrade,
  transistorCustom,
  transistorGrade,
} from "../catalog/discretes.js";
import { CLOCK_WAVES } from "../catalog/parts.js";
import { LOAD_MODES, loadSettings } from "../catalog/bench-parts.js";
import { METER_ELEMENTS, meterSetup } from "../catalog/meter.js";
import { DIODE_GRADE_SPECS } from "../sim/spice/diodes.js";
import { LED_SPECS } from "../sim/spice/leds.js";
import { BJT_GRADES, MOSFET_GRADES } from "../sim/spice/transistors.js";
import { GOLDEN_CASES } from "./spice-golden-cases.js";

/**
 * The parts Spice Lite deliberately does NOT model electrically, each with
 * why. Hand-kept, and held to it: an entry that turns out to carry a field
 * the engine reads fails below.
 */
const EXEMPT = Object.freeze({
  ...Object.fromEntries(
    [
      "sw-slide",
      "sw-push",
      "sw-tact",
      "sw-dpdt",
      "sw-toggle",
      "sw-dip1",
      "sw-dip2",
      "sw-dip4",
      "sw-dip8",
    ].map(
      // prettier-ignore
      (id) => [
        id,
        "an ideal contact: the netlist joins its legs while it is closed " +
          "(internalBridges) — no resistance, nothing to grade; its bounce " +
          "is timing (sim/bounce.js), not a voltage",
      ],
    ),
  ),
});

/** The engine's own grades of a transistor type (spice/transistors.js). */
const gradesOf = (type) => Object.keys(BJT_GRADES[type] ?? MOSFET_GRADES[type] ?? {}); // prettier-ignore

/** Whether a def's logic drives a pin (an output stage under Spice Lite) —
    not a part whose pins are switched channels (a relay's contacts). */
const drives = (def) =>
  Boolean(def.logic) &&
  !def.logic.channels &&
  (def.pins ?? []).some((p) => p.role === "output" || p.role === "io");

/** A chip whose figures are its own (graded by part), and why. */
function ownFigures(def) {
  if (def.silicon) return "silicon";
  if (def.opAmps) return "op-amp";
  if (def.optocoupler) return "optocoupler";
  if (def.bipolarArray) return "transistor array";
  if (def.transistorArray) return "MOSFET array";
  if (def.outputStage) return "own output stage";
  if (def.schmitt) return "Schmitt thresholds";
  if (def.logic?.channels) return "analog switch";
  return null;
}

/**
 * What a part is modelled by, as coverage keys: every key a case must hold
 * for the part to count as graded — with `instance`, the keys THIS part (its
 * params: its grade, colour, wave, mode, dial) covers. Null: the catalog
 * says nothing Spice Lite reads.
 * @param {object} def
 * @param {object} [instance] - a placed part's params
 */
function modelKeys(def, instance = null) {
  const part = `part:${def.id}`;
  const each = (stem, all, mine) =>
    instance ? (mine == null ? [] : [`${stem}:${mine}`]) : all.map((x) => `${stem}:${x}`); // prettier-ignore
  if (def.kind === "chip") {
    if (ownFigures(def)) return [part];
    const family = familyOf(def) ?? "none";
    if (def.openCollector) return [`open-collector:${family}`];
    return [`stage:${family}`];
  }
  if (BRICK_KINDS.has(def.kind)) {
    if (def.kind === "clock") {
      const wave = instance && def.isAuto(instance) ? def.waveOf(instance) : null; // prettier-ignore
      return [part, ...each("wave", CLOCK_WAVES, wave)];
    }
    if (def.kind === "load") {
      return [part, ...each("load-mode", LOAD_MODES, instance && loadSettings(instance).mode)]; // prettier-ignore
    }
    if (def.kind === "meter") {
      const element = instance && meterSetup(instance).element;
      const name = Object.entries(METER_ELEMENTS).find(([, e]) => e === element)?.[0]; // prettier-ignore
      return [part, ...each("meter-element", Object.keys(METER_ELEMENTS), name)]; // prettier-ignore
    }
    return [part];
  }
  if (def.transistor) {
    const type = def.transistor.type;
    const grade = instance && !transistorCustom(def, instance) ? transistorGrade(def, instance) : null; // prettier-ignore
    return [part, ...each("grade", gradesOf(type).map((g) => `${type}/${g}`), grade && `${type}/${grade}`)]; // prettier-ignore
  }
  if (def.diode && !def.diode.zener) {
    return [part, ...each("diode-grade", Object.keys(DIODE_GRADE_SPECS), instance && diodeGrade(instance))]; // prettier-ignore
  }
  if (typeof def.polarity === "function" && def.colors) {
    return [part, ...each("led-colour", Object.keys(LED_SPECS), instance && (instance.color ?? "red"))]; // prettier-ignore
  }
  const keys = [];
  if (
    def.diode ||
    def.rectifier ||
    def.segments ||
    def.backlight ||
    def.capacitor ||
    def.inductor ||
    def.regulator ||
    def.coil ||
    def.speaker ||
    typeof def.weakBridges === "function"
  ) {
    keys.push(part);
  }
  // A discrete that drives (an oscillator can, a character LCD's bus): the
  // family-less parts' common MOS stage, as a logic chip of no family.
  if (drives(def)) keys.push(`stage:${familyOf(def) ?? "none"}`);
  return keys.length ? keys : null;
}

/** Every key the golden cases cover, and which cases cover each. */
function coverage() {
  const by = new Map();
  for (const c of GOLDEN_CASES) {
    const { doc } = c.build();
    for (const comp of doc.components ?? []) {
      const def = partDef(comp.ref);
      if (!def) continue;
      for (const key of modelKeys(def, comp.params ?? {}) ?? []) {
        if (!by.has(key)) by.set(key, new Set());
        by.get(key).add(c.id);
      }
    }
  }
  return by;
}

const CATALOG = PALETTE_DEFS.filter((def) => !def.custom);

test("golden coverage: every part Spice Lite models is graded by a case", (t) => {
  const covered = coverage();
  const missing = [];
  let parts = 0;
  for (const def of CATALOG) {
    const keys = modelKeys(def);
    if (!keys) continue;
    parts++;
    for (const key of keys) {
      if (!covered.has(key)) missing.push(`${def.id}: ${key}`);
    }
  }
  t.diagnostic(`${parts} parts modelled, ${covered.size} coverage keys graded by ${GOLDEN_CASES.length} cases`); // prettier-ignore
  for (const [key, ids] of [...covered].sort()) {
    t.diagnostic(`  ${key}: ${[...ids].slice(0, 3).join(", ")}${ids.size > 3 ? ` +${ids.size - 3}` : ""}`); // prettier-ignore
  }
  assert.deepEqual(
    missing,
    [],
    "graded by no golden case — add one to spice-golden-cases.js (and run make spice-golden)", // prettier-ignore
  );
});

test("golden coverage: every part is either modelled or exempt, with a reason", () => {
  const unknown = CATALOG.filter((d) => !modelKeys(d) && !EXEMPT[d.id]).map((d) => d.id); // prettier-ignore
  assert.deepEqual(unknown, [], "a part with no field Spice Lite reads and no EXEMPT reason: say how it is modelled"); // prettier-ignore
  const stale = Object.keys(EXEMPT).filter((id) => !partDef(id) || modelKeys(partDef(id))); // prettier-ignore
  assert.deepEqual(stale, [], "EXEMPT names a part that is not in the catalog, or one Spice Lite models"); // prettier-ignore
});

test("golden coverage: the family stages are graded by the stage areas", () => {
  // "stage:74LS" and "stage:CD4000" must be covered by the areas that grade
  // the stages themselves, not only by a part that happens to use one.
  const covered = coverage();
  const area = (id) => GOLDEN_CASES.find((c) => c.id === id)?.area;
  for (const [key, want] of [
    ["stage:74LS", "ls-stage"],
    ["stage:CD4000", "cmos-stage"],
  ]) {
    const areas = new Set([...(covered.get(key) ?? [])].map(area));
    assert.ok(areas.has(want), `${key} is graded by no ${want} case`);
  }
});
