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

// derive.js — what a gallery entry says about itself that nobody types: the
// engine it needs, its counts, its logic families, a level and the automatic
// tags, all read off the design (features/chiphippo-gallery-plan.md →
// Phase 1). Pure; the gallery's CI writes the result into `entry.json`'s
// `derived`, and a client's claim to any of it is never read.
//
// THE TAGS ARE A TABLE, NOT CODE PATHS — the catalog's own words (a def's
// `group`, `kind`, `family`, `id`) mapped to the gallery's, so a new part
// earns a tag by its group and a new tag is one row.

import { partDef, withCustomChips } from "../catalog/index.js";
import { familyOf } from "../catalog/families.js";

/**
 * Each row: the tag, and the defs that earn it — by catalog `groups`, `ids`,
 * brick `kinds`, logic `families`, or `custom: true` for a designed chip. A
 * design earns a tag when ANY part it places matches its row.
 */
export const TAG_RULES = Object.freeze([
  { tag: "cpu", groups: ["PROCESSOR"] },
  { tag: "memory", groups: ["Memory"] },
  { tag: "timer", groups: ["Timer"] },
  { tag: "oscillator", groups: ["Oscillators"] },
  {
    tag: "display",
    groups: ["Displays", "Display driver"],
    ids: ["seg7cc", "seg7ca", "seg8cc", "seg8ca", "bar8"],
  },
  { tag: "counter", groups: ["Counter"] },
  { tag: "arithmetic", groups: ["Arithmetic"] },
  {
    tag: "sequential",
    groups: ["Flip-flop", "Latch", "Register", "Shift register"],
  },
  {
    tag: "analog",
    groups: ["Op-amps"],
    kinds: ["ac", "adapter", "transformer"],
  },
  {
    tag: "power",
    groups: ["Regulators"],
    ids: ["bridge-rectifier"],
    kinds: ["ac", "adapter", "transformer", "load"],
  },
  { tag: "audio", groups: ["Audio"] },
  { tag: "interface", groups: ["Interface"] },
  { tag: "custom-chip", custom: true },
  { tag: "ttl", families: ["74LS"] },
  { tag: "cmos", families: ["CD4000"] },
]);

/** Chips (designed ones included) up to which a design is each level. */
export const LEVEL_CHIPS = Object.freeze({ beginner: 3, intermediate: 10 });

/** Does `def` earn `rule`'s tag? */
function earns(rule, def) {
  return Boolean(
    rule.groups?.includes(def.group) ||
    rule.ids?.includes(def.id) ||
    rule.kinds?.includes(def.kind) ||
    (rule.families && !def.custom && rule.families.includes(familyOf(def))) ||
    (rule.custom && def.custom),
  );
}

/**
 * The derived block for a desk document (`entry.json` → `derived`).
 * `chips` are the designed chips the design carries; they are the ONLY ones
 * the question is answered with (`withCustomChips`), so what a submission
 * places is read from the submission alone.
 * @param {object} doc - a normalized desk document.
 * @param {object[]} [chips]
 * @returns {{engine: "logic"|"spice", chips: number, parts: number,
 *   wires: number, families: string[], level: string, autoTags: string[]}}
 */
export function deriveEntry(doc, chips = []) {
  return withCustomChips(chips, () => {
    const defs = [];
    for (const comp of doc?.components ?? []) {
      const def = partDef(comp.ref);
      if (def) defs.push(def);
    }
    // An instrument is not part of the circuit: a meter on the bench counts
    // toward the engine it needs, never toward the parts it has.
    const parts = defs.filter((d) => d.kind !== "meter");
    const chipCount = defs.filter((d) => d.kind === "chip").length;
    const engine = defs.some((d) => d.spiceOnly) ? "spice" : "logic";
    const families = [
      ...new Set(
        defs
          .filter((d) => !d.custom)
          .map(familyOf)
          .filter(Boolean),
      ),
    ].sort();
    const autoTags = TAG_RULES.filter((rule) =>
      defs.some((def) => earns(rule, def)),
    ).map((rule) => rule.tag);
    let step =
      chipCount <= LEVEL_CHIPS.beginner
        ? 0
        : chipCount <= LEVEL_CHIPS.intermediate
          ? 1
          : 2;
    // A processor or an analog bench asks more of a reader than its chip
    // count says: one level up, never past the top.
    if (autoTags.includes("cpu") || engine === "spice") step += 1;
    return {
      engine,
      chips: chipCount,
      parts: parts.length,
      wires: doc?.wires?.length ?? 0,
      families,
      level: ["beginner", "intermediate", "advanced"][Math.min(step, 2)],
      autoTags,
    };
  });
}
