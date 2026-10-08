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

// Spice Lite against ngspice — the scorecard (features/spice-lite-3-plan.md,
// Phase 0). Every case in spice-golden-cases.js is run through Spice Lite
// and measured against the reference ngspice gave for the same document
// (spice-golden/<area>.json, written by `make spice-golden`, committed so
// this needs no ngspice). Each value earns a grade on the plan's rubric; a
// transient case is run again ticked on a grid beside its own wake times, and
// an answer that moves with the tick spacing is held to C. An area's grade is
// its worst case's.
//
// Two bars per area: its FLOOR, the grade it has reached (below it fails —
// the ratchet), and its TARGET, the grade its phase brings it to (below it is
// a todo until that phase is in LANDED, a failure after). Set
// SPICE_GOLDEN_REPORT to a path to have every measurement written there.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { H, L } from "../sim/levels.js";
import { runner } from "./timing-fixtures.js";
import {
  AREAS,
  GOLDEN_CASES,
  INVARIANCE,
  LANDED,
  atLeast,
  gradeOf,
  keysOf,
  lastCycle,
  worse,
} from "./spice-golden-cases.js";

const GOLDEN = new URL("./spice-golden/", import.meta.url);

/** The most ticks one run takes: a guard, far past any case's. */
const MAX_TICKS = 20_000;

function golden(area) {
  const url = new URL(`${area}.json`, GOLDEN);
  return existsSync(url) ? JSON.parse(readFileSync(url, "utf8")) : null;
}

/**
 * Spice Lite's answer to a case: ticked at the circuit's own wake times (and
 * the times it is read at), and on `grid` seconds too when given.
 * @returns {Record<string, number|null>}
 */
function measure(c, grid = null) {
  const { doc, at, signals = {} } = c.build();
  const m = c.measure;
  const sim = runner(doc, { engine: "spice" });
  // Each signal flag's level at `t` (its schedule's last step at or before).
  const levelsAt = (t) => {
    const out = new Map();
    for (const [id, steps] of Object.entries(signals)) {
      let level = steps[0][1];
      for (const [from, lv] of steps) if (from <= t) level = lv;
      out.set(id, level === "high" ? H : L);
    }
    return out;
  };
  const switches = Object.values(signals).flatMap((steps) => steps.map(([t]) => t)).filter((t) => t > 0); // prettier-ignore
  const netOf = (name) => sim.netlist.netOfPoint.get(at[name]);
  const keys = keysOf(m);
  if (m.kind === "dc") {
    const r = sim.run(0).result;
    const values = [
      ...(m.volts ?? []).map((n) => r.nodeVolts.get(netOf(n)) ?? null),
      ...(m.amps ?? []).map((k) => r.lamps.get(k)?.amps ?? null),
    ];
    return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  }
  const reads = m.kind === "tran" ? [...m.at, ...switches].sort((a, b) => a - b) : []; // prettier-ignore
  const values = {};
  const edges = [];
  let level = null;
  const record = (t, r) => {
    if (m.kind === "tran") {
      if (!m.at.includes(t)) return;
      for (const name of m.volts ?? []) {
        values[`${name}@${t}/V`] = r.nodeVolts.get(netOf(name)) ?? null;
      }
      for (const id of m.coils ?? []) {
        values[`${id}@${t}/A`] = r.analog?.coilAmps?.get(id) ?? null;
      }
      return;
    }
    const now = r.netLevels.get(netOf(m.out));
    if ((now === H || now === L) && level != null && now !== level) {
      edges.push([t, now === H]);
    }
    if (now === H || now === L) level = now;
  };
  let t = 0;
  let r = sim.run(0, levelsAt(0)).result;
  record(0, r);
  for (let i = 0; i < MAX_TICKS; i++) {
    const nextGrid = grid ? (Math.floor(t / grid + 1e-9) + 1) * grid : Infinity; // prettier-ignore
    const nextRead = reads.find((x) => x > t) ?? Infinity;
    const next = Math.min(r.wakeAt ?? Infinity, nextGrid, nextRead);
    if (!(next <= m.stop)) break;
    t = next;
    r = sim.run(t, levelsAt(t)).result;
    record(t, r);
  }
  if (m.kind === "tran") return values;
  const cycle = lastCycle(edges);
  return { "period/s": cycle.period, "high/s": cycle.high, "low/s": cycle.low };
}

/** Whether two runs' answers agree to the rubric's tick-spacing bar. */
function sameAnswer(a, b) {
  return Object.keys(a).every((k) => {
    if (a[k] == null || b[k] == null) return a[k] === b[k];
    return Math.abs(a[k] - b[k]) <= INVARIANCE * Math.max(Math.abs(a[k]), 1e-3); // prettier-ignore
  });
}

const fmt = (x) => (x == null ? "—" : Number(x.toPrecision(5)).toString());
const report = {};

for (const area of AREAS) {
  const cases = GOLDEN_CASES.filter((c) => c.area === area.id);
  test(`Spice Lite against ngspice — ${area.title}`, (t) => {
    const refs = golden(area.id)?.cases ?? {};
    let grade = "A";
    const lines = [];
    for (const c of cases) {
      const ref = refs[c.id];
      if (!ref) {
        t.todo(`${c.id} has no reference: run make spice-golden`);
        return;
      }
      const got = measure(c);
      let own = "A";
      for (const k of keysOf(c.measure)) {
        const g = gradeOf(k, got[k], ref.values[k]);
        own = worse(own, g);
        const err = got[k] != null && ref.values[k] ? ((got[k] - ref.values[k]) / ref.values[k]) * 100 : null; // prettier-ignore
        lines.push(`  ${c.id} ${k}: ${fmt(got[k])} vs ${fmt(ref.values[k])} (${err == null ? "—" : `${err >= 0 ? "+" : ""}${err.toFixed(2)} %`}) ${g}`); // prettier-ignore
      }
      const spaced = (c.measure.grids ?? []).map((g) => measure(c, g));
      const steady = spaced.every((s) => sameAnswer(got, s));
      if (!steady) {
        own = worse(own, "C");
        lines.push(`  ${c.id}: depends on the tick spacing (${spaced.map((s) => JSON.stringify(s)).join(" / ")})`); // prettier-ignore
      }
      grade = worse(grade, own);
      report[c.id] = { area: area.id, grade: own, steady, got, ref: ref.values, spaced }; // prettier-ignore
    }
    t.diagnostic(`${area.title}: ${grade} (floor ${area.floor}, target ${area.target})`); // prettier-ignore
    for (const line of lines) t.diagnostic(line);
    report[`area:${area.id}`] = { grade, floor: area.floor, target: area.target }; // prettier-ignore
    assert.ok(
      atLeast(grade, area.floor),
      `${area.title} fell to ${grade}, below its floor ${area.floor}`,
    );
    if (grade !== area.floor && atLeast(grade, area.floor)) {
      t.diagnostic(`${area.title} beat its floor: raise it to ${grade}`);
    }
    if (!atLeast(grade, area.target)) {
      const due = area.phase == null || LANDED.includes(area.phase);
      if (!due) {
        t.todo(`${grade}, target ${area.target} with Phase ${area.phase}`);
      }
      assert.ok(
        !due,
        `${area.title} is ${grade}; Phase ${area.phase ?? "—"} has landed and its target is ${area.target}`,
      );
    }
  });
}

after(() => {
  const path = process.env.SPICE_GOLDEN_REPORT;
  if (path) writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
});
