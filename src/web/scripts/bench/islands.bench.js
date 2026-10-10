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

// islands.bench.js — Spice Lite on independent sub-circuits ("islands"),
// timed and counted headless (features/00-bench-islands.md). Part of
// `make bench`, not `make test`.
//
//   make bench                              the table
//   make bench BENCH_JSON=path/to/out.json  the table, and the numbers as JSON
//   make bench-compare BASE=a.json HEAD=b.json
//
// Each fixture (bench/islands-fixtures.js) is driven exactly as SimController
// drives Spice Lite (bench/drive-spice.js) for its simulated seconds, and
// measured over its last WINDOW of them (the first stretch — a 555's first,
// longer HIGH, the Run tick — is left out). Per simulated second:
//
//   ms        wall-clock work (the best of RUNS timed runs; above 1000 a desk
//             cannot keep up and SimController reports it `behind`)
//   ticks     engine ticks
//   settles   digital ticks Spice Lite runs (sim/spice/engine.js `settleAt`)
//   passes    settle passes
//   evals     chip evaluations the settles performed
//   outputs   calls into Spice Lite's `outputs` hook
//   clusters  voltage clusters solved
//   replays   drawn-cycle segments replayed from their record, not settled
//             (features/02-cycle-replay.md)
//
// and each oscillator's RUNNING CHECK: the period its timing readout measured
// (spice/measure.js — true time, a drawn cycle included) against the one its
// values should give, and whether it ran: `running`, `chatter` (the engine
// spent its event budget on it and backed off — an `oscillation` warning; its
// readout's last period may still look right, but it is not being run), or
// `not running` (no period measured at all).

import test from "node:test";
import { writeFileSync } from "node:fs";
import { islandFixtures } from "./islands-fixtures.js";
import { driveSpice } from "./drive-spice.js";

/** The share of each run measured — its last part. */
const WINDOW = 0.8;
/** Timed runs per fixture (after one to warm the JIT); the fastest is kept. */
const RUNS = Number(process.env.BENCH_RUNS ?? 3);
const COUNTERS = ["settles", "passes", "evaluations", "outputsCalls", "clusterSolves", "replays"]; // prettier-ignore

/** One timed run of a fixture: its numbers over the window. */
function measure(f) {
  const from = f.seconds * (1 - WINDOW);
  const stats = {};
  let atFrom = null;
  let ticks = 0;
  let ms = 0;
  let t0 = 0;
  let chatter = 0;
  const run = driveSpice(f.doc, {
    seconds: f.seconds,
    scope: f.scope,
    stats,
    beforeTick: (now) => {
      if (now >= from && atFrom == null) atFrom = { ...stats };
      t0 = performance.now();
    },
    onTick: (now, r) => {
      if (now < from) return;
      ms += performance.now() - t0;
      ticks++;
      if (r.warnings.some((w) => w.type === "oscillation")) chatter++;
    },
  });
  const span = f.seconds - from;
  const per = (n) => n / span;
  const counted = {};
  for (const k of COUNTERS) counted[k] = per((stats[k] ?? 0) - (atFrom?.[k] ?? 0)); // prettier-ignore
  const oscillators = f.oscillators.map((o) => {
    const section = run.result.timing?.get(o.chip)?.sections?.[0];
    const period = section?.measured && section.period > 0 ? section.period : null; // prettier-ignore
    const status = period == null ? "not running" : chatter ? "chatter" : "running"; // prettier-ignore
    return { name: o.name, expected: o.expected, period, ratio: period == null ? null : period / o.expected, status }; // prettier-ignore
  });
  // How many islands the run ended drawing by a schedule (spice/cycles.js,
  // spice/islands.js).
  const drawn = run.result.analog?.cycles?.size ?? 0;
  return { msPerSimS: per(ms), ticksPerSimS: per(ticks), drawn, ...Object.fromEntries(COUNTERS.map((k) => [`${k}PerSimS`, counted[k]])), oscillators }; // prettier-ignore
}

function benchIslands() {
  const out = {};
  for (const f of islandFixtures()) {
    measure({ ...f, seconds: Math.min(f.seconds, 0.05) }); // JIT warm-up
    let best = null;
    for (let i = 0; i < RUNS; i++) {
      const m = measure(f);
      if (!best || m.msPerSimS < best.msPerSimS) best = m;
    }
    out[f.name] = { seconds: f.seconds, window: WINDOW, ...best };
  }
  return out;
}

const fmt = (x, d = 0) => (x == null ? "—" : x.toFixed(d));

test("Spice Lite islands bench", () => {
  const fixtures = benchIslands();
  const lines = [];
  const say = (s = "") => lines.push(s);
  say("SPICE LITE ISLANDS (per simulated second, over the last 80 % of each run)"); // prettier-ignore
  say(`  ${"fixture".padEnd(22)} ${"ms".padStart(8)} ${"ticks".padStart(7)} ${"settles".padStart(8)} ${"passes".padStart(8)} ${"evals".padStart(9)} ${"outputs".padStart(9)} ${"clusters".padStart(9)} ${"replays".padStart(8)}`); // prettier-ignore
  for (const [name, m] of Object.entries(fixtures)) {
    say(`  ${name.padEnd(22)} ${fmt(m.msPerSimS, 1).padStart(8)} ${fmt(m.ticksPerSimS).padStart(7)} ${fmt(m.settlesPerSimS).padStart(8)} ${fmt(m.passesPerSimS).padStart(8)} ${fmt(m.evaluationsPerSimS).padStart(9)} ${fmt(m.outputsCallsPerSimS).padStart(9)} ${fmt(m.clusterSolvesPerSimS).padStart(9)} ${fmt(m.replaysPerSimS).padStart(8)}`); // prettier-ignore
  }
  say();
  say("RUNNING CHECK (measured period against the values' own)");
  for (const [name, m] of Object.entries(fixtures)) {
    for (const o of m.oscillators) {
      say(`  ${name.padEnd(22)} ${o.name.padEnd(10)} ${o.status.padEnd(12)} ${m.drawn ? "drawn  " : "stepped"} period ${o.period == null ? "—" : o.period.toExponential(4)} s  expected ${o.expected.toExponential(4)} s  ratio ${fmt(o.ratio, 4)}`); // prettier-ignore
    }
  }
  console.log(`\n${lines.join("\n")}\n`);
  const path = process.env.BENCH_JSON;
  if (path) {
    const json = { version: 1, date: new Date().toISOString(), node: process.version, fixtures }; // prettier-ignore
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
    console.log(`written: ${path}`);
  }
});
