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
// (features/done/spice-lite-3-plan.md, Phase 0; `make spice-golden`).
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
import { PSU_OUTPUT_F } from "../src/web/scripts/sim/spice/analog-devices.js";

/** How many operating points a case with a chip off the rails is run at
    to find the volts across it, and how still they must stand, volts — a
    stillness the deck's twelve printed digits can show (spice-deck.mjs
    `PRINT_DIGITS`; at `print`'s seven a read flipped by its last digit).
    Each round closes the gap by ~0.1–0.25 here, so a nanovolt takes up to
    seventeen (a 74LS04 behind the µA shunt). */
const FED_ROUNDS = 30;
const FED_EPS_V = 1e-9;

/** How far a supply's own output capacitor may sag on the charge an ideal
    reference source delivers past its limit before the case counts as
    overloading it, volts. */
const SAG_FLOOR_V = 1e-3;
import {
  AREAS,
  GOLDEN_CASES,
  NGSPICE_VERSION,
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
  // A chip off the rails (fed through a resistor or a meter's shunt) is
  // stated at the volts across its supply pins (spice-deck.mjs
  // `chipVolts`), as Spice Lite runs it at what reaches them: found in the
  // reference itself, its operating point run again on what the last one
  // put there until they stand.
  const chipVolts = {};
  const ngspice = (text, name) => {
    const deck = join(dir, `${name}.cir`);
    writeFileSync(deck, text);
    return execFileSync("ngspice", ["-b", deck], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 << 20,
    });
  };
  const printedIn = (log, vector) => {
    const line = log.split("\n").find((l) => l.trim().toLowerCase().startsWith(`${vector} =`)); // prettier-ignore
    if (!line) throw new Error(`${c.id}: ngspice printed no ${vector}`);
    return Number(line.split("=")[1]);
  };
  for (let round = 0; round < FED_ROUNDS; round++) {
    const { text, fed } = spiceDeck(doc, { ...opts, analysis: { op: true }, chipVolts, fedGuess: 5 }); // prettier-ignore
    if (!fed.length) break;
    const log = ngspice(text, `${c.id}-fed`);
    let moved = 0;
    for (const f of fed) {
      const at = (x) => (x === "0" ? 0 : printedIn(log, x));
      const volts = at(f.vcc) - at(f.gnd);
      moved = Math.max(moved, Math.abs(volts - (chipVolts[f.id] ?? Infinity)));
      chipVolts[f.id] = volts;
    }
    if (moved < FED_EPS_V) break;
    if (round === FED_ROUNDS - 1) throw new Error(`${c.id}: a chip off the rails never came to rest`); // prettier-ignore
  }
  const { text, vectors, limits } = spiceDeck(doc, { ...opts, chipVolts });
  const log = ngspice(text, c.id);
  const keys = keysOf(m);
  // An ideal supply in the reference past its limit: Spice Lite would hold
  // it on that limit, so the case compares two different circuits.
  const overLimit = (l, amps) => {
    if (amps > l.limit * (1 + 1e-6)) {
      throw new Error(`${c.id}: the reference's ${l.id} delivers ${amps.toPrecision(4)} A, past its ${l.limit} A limit — store a currentLimit so the deck writes it`); // prettier-ignore
    }
  };
  // …in time, by the charge it delivers past its limit: what would come out
  // of its own output capacitor (PSU_OUTPUT_F). The first rows are left out:
  // the run's first instant charges the deck's picofarads from `uic`'s zero,
  // amps for picoseconds that `linearize` spreads across a whole row.
  const overCharge = (l, rows, col) => {
    let excess = 0;
    for (let i = 3; i < rows.length; i++) {
      const over = (r) => Math.max(0, -r[col] - l.limit);
      excess += ((over(rows[i - 1]) + over(rows[i])) / 2) * (rows[i][0] - rows[i - 1][0]); // prettier-ignore
    }
    if (excess / PSU_OUTPUT_F > SAG_FLOOR_V) {
      throw new Error(`${c.id}: the reference's ${l.id} delivers ${excess.toPrecision(3)} C past its ${l.limit} A limit — store a currentLimit so the deck writes it`); // prettier-ignore
    }
  };
  if (m.kind === "dc") {
    // `print` lines: "<vector> = <value>", in the deck's order.
    const printed = (vector) => {
      const line = log.split("\n").find((l) => l.trim().toLowerCase().startsWith(`${vector} =`)); // prettier-ignore
      if (!line) throw new Error(`${c.id}: ngspice printed no ${vector}`);
      return Number(line.split("=")[1]);
    };
    const values = {};
    for (const [i, vector] of vectors.entries()) values[keys[i]] = printed(vector); // prettier-ignore
    // (A source's current is into its +: delivering is negative.)
    for (const l of limits) overLimit(l, -printed(l.vector));
    return values;
  }
  const rows = readRows(file);
  const first = 1 + (m.kind === "tran" ? (m.volts ?? []).length + (m.coils ?? []).length : 1); // prettier-ignore
  limits.forEach((l, i) => overCharge(l, rows, first + i));
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
if (version !== NGSPICE_VERSION) {
  console.warn(`warning: this is ${version}; the committed references are ${NGSPICE_VERSION} (spice-golden-cases.js NGSPICE_VERSION) — a reference that moves may be ngspice's change, not the engine's`); // prettier-ignore
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
