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

// export-fixtures.js — the desks the export tests (Feature 390) run over: a
// small compiled bench, and every shipped demo bench (src/web/demos/), which
// between them seat every 74xx part and most discretes.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeDocument } from "../model/desk-doc.js";
import { compileNetlist } from "../model/autobuild.js";

const DEMOS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "demos",
);

/**
 * A compiled bench: a NAND fed from two slide switches (each throwing between
 * the rails), driving a lamp — plus whatever `extra` adds.
 */
export function bench(extra = {}) {
  const built = compileNetlist({
    title: "NAND bench",
    parts: [
      { id: "U1", ref: "74LS00" },
      { id: "S1", ref: "sw-slide" },
      { id: "S2", ref: "sw-slide" },
      { id: "D1", ref: "led" },
      ...(extra.parts ?? []),
    ],
    nets: [
      { name: "A", members: ["U1.1A", "S1.C"] },
      { name: "A_HI", members: ["S1.#1", "VCC"] },
      { name: "A_LO", members: ["S1.#3", "GND"] },
      { name: "B", members: ["U1.1B", "S2.C"] },
      { name: "B_HI", members: ["S2.#1", "VCC"] },
      { name: "B_LO", members: ["S2.#3", "GND"] },
      { name: "Y", members: ["U1.1Y", "D1.A"] },
      { name: "LAMP", members: ["D1.K", "GND"] },
      ...(extra.nets ?? []),
    ],
  });
  assert.ok(built.ok, JSON.stringify(built.errors));
  return normalizeDocument(built.document);
}

/** Every shipped demo bench, `{ ref, doc }`, in name order. */
export function demoDocs() {
  return fs
    .readdirSync(DEMOS)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({
      ref: f.replace(/\.json$/, ""),
      doc: normalizeDocument(
        JSON.parse(fs.readFileSync(path.join(DEMOS, f), "utf8")).doc,
      ),
    }));
}
