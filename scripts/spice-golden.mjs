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

// Regenerate Spice Lite's golden references with ngspice
// (features/spice-lite-3-plan.md, Phase 0; `make spice-golden`).
//
// Every case in src/web/scripts/tests/spice-golden-cases.js is turned into a
// deck (scripts/spice-deck.mjs), run through `ngspice -b`, and measured the
// way spice-golden.test.js measures Spice Lite; the numbers are written to
// src/web/scripts/tests/spice-golden/<area>.json with the ngspice version
// that produced them. Those files are COMMITTED, so `make test` needs no
// ngspice — this is run when a case is added or changed, like
// `make datasheet-urls`, and is not part of `make test`. Without ngspice it
// says so and exits 0.
//
// Usage: node scripts/spice-golden.mjs [case-id-or-area …] [--keep]
//   naming cases or areas regenerates only those (the rest are kept);
//   --keep leaves each deck and its output in a temporary folder, named.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spiceDeck } from "./spice-deck.mjs";
import {
  AREAS,
  GOLDEN_CASES,
  keysOf,
  lastCycle,
} from "../src/web/scripts/tests/spice-golden-cases.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, "src/web/scripts/tests/spice-golden");

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const only = args.filter((a) => !a.startsWith("--"));

function ngspiceVersion() {
  try {
    const text = execFileSync("ngspice", ["-v"], { encoding: "utf8" });
    return /ngspice-\S+/.exec(text)?.[0] ?? "ngspice";
  } catch {
    return null;
  }
}

/** The deck flavour and options a case's reference is read from. */
function deckOptions(c) {
  if (c.reference === "ideal") return { flavour: "same", bias: false };
  return { flavour: c.reference, models: c.models ?? {} };
}

/** Rows of a `wrdata` file (wr_singlescale, wr_vecnames): [t, …vectors]. */
function readRows(file) {
  const lines = readFileSync(file, "utf8").trim().split("\n").slice(1);
  return lines.map((l) => l.trim().split(/\s+/).map(Number));
}

/** A column's value at `t`, by straight lines between rows. */
function valueAt(rows, col, t) {
  let hi = rows.findIndex((r) => r[0] >= t);
  if (hi < 0) return rows.at(-1)[col];
  if (hi === 0) return rows[0][col];
  const [a, b] = [rows[hi - 1], rows[hi]];
  return a[col] + ((b[col] - a[col]) * (t - a[0])) / (b[0] - a[0]);
}

/** The times a column crosses `threshold`: [[t, rising]]. */
function crossings(rows, col, threshold) {
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const [a, b] = [rows[i - 1], rows[i]];
    const da = a[col] - threshold;
    const db = b[col] - threshold;
    if (da < 0 === db < 0 || da === db) continue;
    out.push([a[0] + ((b[0] - a[0]) * -da) / (db - da), db > da]);
  }
  return out;
}

function runCase(c, dir) {
  const { doc, at, signals = {} } = c.build();
  const m = c.measure;
  const file = join(dir, `${c.id}.txt`);
  const probes =
    m.kind === "dc" ? (m.volts ?? []) : m.kind === "tran" ? (m.volts ?? []) : [m.out]; // prettier-ignore
  const opts = {
    ...deckOptions(c),
    probes: probes.map((name) => at[name]),
    lamps: m.amps ?? [],
    coils: m.kind === "tran" ? (m.coils ?? []) : [],
    signals,
    out: file,
    analysis:
      m.kind === "dc" ? { op: true } : { tran: { stop: m.stop, step: m.step } },
  };
  const { text, vectors } = spiceDeck(doc, opts);
  const deck = join(dir, `${c.id}.cir`);
  writeFileSync(deck, text);
  const log = execFileSync("ngspice", ["-b", deck], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 << 20,
  });
  const keys = keysOf(m);
  if (m.kind === "dc") {
    // `print` lines: "<vector> = <value>", in the deck's order.
    const values = {};
    for (const [i, vector] of vectors.entries()) {
      const line = log.split("\n").find((l) => l.trim().toLowerCase().startsWith(`${vector} =`)); // prettier-ignore
      if (!line) throw new Error(`${c.id}: ngspice printed no ${vector}`);
      values[keys[i]] = Number(line.split("=")[1]);
    }
    return values;
  }
  const rows = readRows(file);
  if (m.kind === "tran") {
    // Columns: time, each probe's volts, each coil's current (in that
    // order, as keysOf states them).
    const values = {};
    const series = (m.volts ?? []).length + (m.coils ?? []).length;
    let k = 0;
    for (let col = 0; col < series; col++) {
      for (const t of m.at) values[keys[k++]] = valueAt(rows, col + 1, t);
    }
    return values;
  }
  const cycle = lastCycle(crossings(rows, 1, m.threshold));
  return { "period/s": cycle.period, "high/s": cycle.high, "low/s": cycle.low };
}

const version = ngspiceVersion();
if (!version) {
  console.log("ngspice is not installed: the golden references are unchanged.");
  process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), "spice-golden-"));
mkdirSync(OUT_DIR, { recursive: true });
const wanted = (c) => !only.length || only.includes(c.id) || only.includes(c.area); // prettier-ignore
let failed = 0;
for (const area of AREAS) {
  const cases = GOLDEN_CASES.filter((c) => c.area === area.id);
  if (!cases.some(wanted)) continue;
  const path = join(OUT_DIR, `${area.id}.json`);
  const before = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8")).cases
    : {};
  const out = {};
  for (const c of cases) {
    if (!wanted(c)) {
      if (before[c.id]) out[c.id] = before[c.id];
      continue;
    }
    try {
      // Nine figures: far past any tolerance, and a diff that reads.
      const values = Object.fromEntries(
        Object.entries(runCase(c, dir)).map(([k, v]) => [k, v == null ? null : Number(v.toPrecision(9))]), // prettier-ignore
      );
      out[c.id] = { reference: c.reference, values };
      console.log(`${area.id} ${c.id}: ${JSON.stringify(values)}`);
    } catch (err) {
      failed++;
      console.error(`${area.id} ${c.id}: ${err.message}`);
      if (before[c.id]) out[c.id] = before[c.id];
    }
  }
  const json = { area: area.id, title: area.title, ngspice: version, cases: out }; // prettier-ignore
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}
if (keep) console.log(`decks kept in ${dir}`);
else rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
