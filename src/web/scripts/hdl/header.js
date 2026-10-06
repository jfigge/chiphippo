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

// header.js — the module header ChipHippo writes for a custom chip, from its
// package (the port list) and its body (whether each output is driven by an
// always block — `output reg` — or by `assign` — `output wire`). The user
// never edits it, which is what keeps the code's pins and the package's from
// drifting apart: rename a pin and the header follows.

import { KEYWORDS } from "./lexer.js";

/**
 * A port's width as Verilog declares it: "" for one bit, `[3:0]` for four.
 * @param {number} w
 */
export const rangeText = (w) => (w > 1 ? `[${w - 1}:0]` : "");

/**
 * The header text, `module NAME (` … `);`, one port per line, columns
 * aligned. A module with no ports is `module NAME;` — legal Verilog.
 *
 * @param {string} name - the module's name (a Verilog identifier).
 * @param {Array<{name: string, dir: string, width: number}>} ports
 * @param {Map<string, "reg"|"wire">} [outputKind]
 */
export function moduleHeader(name, ports, outputKind = new Map()) {
  if (!ports.length) return `module ${name};`;
  const rows = ports.map((p) => {
    const dir = p.dir === "output" ? "output" : "input";
    const kind = p.dir === "output" ? (outputKind.get(p.name) ?? "wire") : "wire"; // prettier-ignore
    return [dir, kind, rangeText(p.width ?? 1), p.name];
  });
  const widths = [0, 1, 2].map((c) => Math.max(...rows.map((r) => r[c].length))); // prettier-ignore
  // A column nobody uses (no vector ports: no ranges) takes no space.
  const columns = [0, 1, 2].filter((c) => widths[c] > 0);
  const lines = rows.map((r, i) => {
    const cells = columns.map((c) => r[c].padEnd(widths[c]));
    const comma = i < rows.length - 1 ? "," : "";
    return `  ${cells.join(" ")} ${r[3]}${comma}`;
  });
  return [`module ${name} (`, ...lines, ");"].join("\n");
}

/** The closing line. */
export const MODULE_END = "endmodule";

/**
 * A part number as a Verilog module name: itself when it already is one,
 * else with every other character turned to `_`, and `chip_` in front of a
 * leading digit (a "74XX01" is a fine part number and no identifier).
 * @param {string} partName
 */
export function moduleName(partName) {
  let name = String(partName ?? "").replace(/[^A-Za-z0-9_$]/g, "_");
  if (!name) name = "chip";
  if (!/^[A-Za-z_]/.test(name) || KEYWORDS.has(name)) name = `chip_${name}`;
  return name;
}
