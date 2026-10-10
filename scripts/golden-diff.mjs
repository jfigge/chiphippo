#!/usr/bin/env node
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

// golden-diff.mjs — two Spice Lite golden scorecards side by side
// (`SPICE_GOLDEN_REPORT=… node --test web/scripts/tests/spice-golden.test.js`):
// every value that is not BIT-identical — the case's own answer and its
// tick-spacing re-runs — with both values and the relative change, and every
// grade that moved. Exit status 1 when anything differs.
//
//   node scripts/golden-diff.mjs before.json after.json

import { readFileSync } from "node:fs";

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error("usage: golden-diff.mjs BEFORE.json AFTER.json");
  process.exit(2);
}
const a = JSON.parse(readFileSync(aPath, "utf8"));
const b = JSON.parse(readFileSync(bPath, "utf8"));

let changed = 0;
let worst = 0;
const rel = (x, y) =>
  x === y ? 0 : Math.abs(y - x) / Math.max(Math.abs(x), Math.abs(y), 1e-300);
const row = (where, x, y) => {
  if (Object.is(x, y)) return;
  changed++;
  const r = x == null || y == null ? Infinity : rel(x, y);
  worst = Math.max(worst, r);
  console.log(`  ${where.padEnd(48)} ${String(x).padStart(24)} → ${String(y).padStart(24)}  rel ${r === Infinity ? "∞" : r.toExponential(2)}`); // prettier-ignore
};
for (const id of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
  const x = a[id];
  const y = b[id];
  if (!x || !y) {
    console.log(`  ${id}: only in ${x ? "BEFORE" : "AFTER"}`);
    changed++;
    continue;
  }
  if (x.grade !== y.grade) {
    console.log(`  ${id}: grade ${x.grade} → ${y.grade}`);
    changed++;
  }
  if (id.startsWith("area:")) continue;
  for (const k of Object.keys({ ...x.got, ...y.got })) row(`${id} ${k}`, x.got?.[k], y.got?.[k]); // prettier-ignore
  (x.spaced ?? []).forEach((s, i) => {
    for (const k of Object.keys(s)) row(`${id} [grid ${i}] ${k}`, s[k], y.spaced?.[i]?.[k]); // prettier-ignore
  });
}
console.log(changed ? `${changed} difference(s); worst relative ${worst.toExponential(2)}` : "bit-identical"); // prettier-ignore
process.exit(changed ? 1 : 0);
