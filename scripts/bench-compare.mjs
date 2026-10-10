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

// bench-compare.mjs — two `make bench BENCH_JSON=…` runs side by side
// (src/web/scripts/bench/islands.bench.js): per fixture and per counter, the
// BASE value, the HEAD value and HEAD ÷ BASE (under 1 is fewer, i.e. better),
// and each oscillator's running check in both.
//
//   make bench-compare BASE=a.json HEAD=b.json

import { readFileSync } from "node:fs";

const [basePath, headPath] = process.argv.slice(2);
if (!basePath || !headPath) {
  console.error("usage: bench-compare.mjs BASE.json HEAD.json");
  process.exit(2);
}
const base = JSON.parse(readFileSync(basePath, "utf8")).fixtures;
const head = JSON.parse(readFileSync(headPath, "utf8")).fixtures;

const COUNTERS = [
  ["msPerSimS", "ms", 1],
  ["ticksPerSimS", "ticks", 0],
  ["settlesPerSimS", "settles", 0],
  ["passesPerSimS", "passes", 0],
  ["evaluationsPerSimS", "evals", 0],
  ["outputsCallsPerSimS", "outputs", 0],
  ["clusterSolvesPerSimS", "clusters", 0],
  ["replaysPerSimS", "replays", 0],
];

const num = (x, d) => (x == null ? "—" : x.toFixed(d));
const ratio = (a, b) => (a == null || b == null ? "—" : a === 0 ? (b === 0 ? "1.00" : "∞") : (b / a).toFixed(2)); // prettier-ignore

console.log(`BASE ${basePath}\nHEAD ${headPath}\n`);
console.log(`  ${"fixture".padEnd(22)} ${"counter".padEnd(9)} ${"base".padStart(10)} ${"head".padStart(10)} ${"head/base".padStart(10)}`); // prettier-ignore
const names = [...new Set([...Object.keys(base), ...Object.keys(head)])];
for (const name of names) {
  const a = base[name];
  const b = head[name];
  for (const [key, label, d] of COUNTERS) {
    console.log(`  ${name.padEnd(22)} ${label.padEnd(9)} ${num(a?.[key], d).padStart(10)} ${num(b?.[key], d).padStart(10)} ${ratio(a?.[key], b?.[key]).padStart(10)}`); // prettier-ignore
  }
  const oscs = [...new Set([...(a?.oscillators ?? []), ...(b?.oscillators ?? [])].map((o) => o.name))]; // prettier-ignore
  for (const o of oscs) {
    const x = a?.oscillators.find((y) => y.name === o);
    const y = b?.oscillators.find((z) => z.name === o);
    const show = (v) => (v ? `${v.status}${v.period == null ? "" : ` ${v.period.toExponential(4)} s`}` : "—"); // prettier-ignore
    console.log(`  ${name.padEnd(22)} ${o.padEnd(9)} ${show(x)}  →  ${show(y)}`); // prettier-ignore
  }
}
