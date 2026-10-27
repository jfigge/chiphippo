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

// Spice Lite against ngspice — the scorecard (features/done/spice-lite-3-plan.md,
// Phase 0). Every case in spice-golden-cases.js is run through Spice Lite
// and measured against the reference ngspice gave for the same document
// (spice-golden/<area>.json, written by `make spice-golden`, committed so
// this needs no ngspice). Each value earns a grade on the plan's rubric; a
// transient case is run again ticked on a grid beside its own wake times, and
// an answer that moves with the tick spacing is held to C. An area's grade is
// its worst case's.
//
// The bar is A for every case (2026-10-26, Jason: "the golden rule of being
// within 2% of ngspice … so we don't drift again"): each case is its own
// subtest, and one value past 2 % (or 20 mV under 1 V) fails it. Nothing
// passes by being missing: a case with no reference, a reference that no
// longer matches its case (another flavour, other readings, a value that is
// not a number), a reference file holding a case that is gone, an area with
// no cases and a case in no area all fail. A case marked `known` (a finding
// waiting on a decision) is a todo while it misses — and a failure once it
// passes; an ACCEPTED exception (`accept`, Jason's decision) is held to its
// own allowance — a grade, a tick-spacing bar — and fails past it or once it
// no longer needs it, and is listed among the diagnostics;
// SPICE_GOLDEN_STRICT=1 holds both kinds to A and INVARIANCE too. Set
// SPICE_GOLDEN_REPORT to a path to have every measurement written there.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { H, L } from "../sim/levels.js";
import { runner } from "./timing-fixtures.js";
import { partDef } from "../catalog/index.js";
import { clockHalves } from "../sim/schedule.js";
import {
  AREAS,
  GOLDEN_CASES,
  INVARIANCE,
  NGSPICE_VERSION,
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
 * the times it is read at), and on `grid` seconds too when given — and at its
 * display frames (`frameAt`, spice/sample.js) unless `frames` is false. The
 * frames were wakes until features/01-display-wakes.md; the scorecard keeps
 * them in its tick grid so it goes on measuring what it always measured, and
 * a run WITHOUT them (the app's own cadence now) is one more tick spacing the
 * answer is held steady across.
 * @returns {Record<string, number|null>}
 */
function measure(c, grid = null, { frames = true } = {}) {
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
  // Each running clock brick's edges from Run, LOW first (as SimController
  // schedules them), and its level and timing at `t`.
  const clockDef = partDef("clock");
  const clocks = (doc.components ?? [])
    .filter((c) => c.kind === "clock" && clockDef.isAuto(c.params))
    .map((c) => {
      const { low, high } = clockHalves(c.params.hz, clockDef.dutyOf(c.params)); // prettier-ignore
      const edges = [];
      for (let t = 0, k = 0; t <= m.stop; k++) edges.push((t += k % 2 ? high : low)); // prettier-ignore
      return { id: c.id, low, high, edges };
    });
  const clocksAt = (t) => {
    if (!clocks.length) return {};
    const clockPhase = new Map();
    const clockTimes = new Map();
    for (const c of clocks) {
      const n = c.edges.filter((e) => e <= t).length;
      const level = n % 2 ? H : L;
      clockPhase.set(c.id, level);
      clockTimes.set(c.id, { half: level === H ? c.high : c.low, since: n ? c.edges[n - 1] : 0 }); // prettier-ignore
    }
    return { clockPhase, clockTimes };
  };
  const edgeTimes = clocks.flatMap((c) => c.edges);
  const netOf = (name) => sim.netlist.netOfPoint.get(at[name]);
  const keys = keysOf(m);
  if (m.kind === "dc") {
    const r = sim.run(0, new Map(), clocksAt(0)).result;
    const values = [
      ...(m.volts ?? []).map((n) => r.nodeVolts.get(netOf(n)) ?? null),
      ...(m.amps ?? []).map((k) => r.lamps.get(k)?.amps ?? null),
    ];
    return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  }
  // Every moment a signal flag switches is ticked (as SimController ticks an
  // input), and a transient's reading times.
  const reads = [...(m.kind === "tran" ? m.at : []), ...switches].sort((a, b) => a - b); // prettier-ignore
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
  let r = sim.run(0, levelsAt(0), clocksAt(0)).result;
  record(0, r);
  for (let i = 0; i < MAX_TICKS; i++) {
    const nextGrid = grid ? (Math.floor(t / grid + 1e-9) + 1) * grid : Infinity; // prettier-ignore
    const nextRead = reads.find((x) => x > t) ?? Infinity;
    const nextEdge = edgeTimes.reduce((a, e) => (e > t && e < a ? e : a), Infinity); // prettier-ignore
    const frame = frames ? (r.frameAt ?? Infinity) : Infinity;
    const next = Math.min(r.wakeAt ?? Infinity, nextGrid, nextRead, nextEdge, frame); // prettier-ignore
    if (!(next <= m.stop)) break;
    t = next;
    r = sim.run(t, levelsAt(t), clocksAt(t)).result;
    record(t, r);
  }
  if (m.kind === "tran") return values;
  const cycle = lastCycle(edges);
  // Built by assignment, not as an object literal: on Node 23.11 the
  // literal's object was observed SHARED between calls once the JIT had
  // warmed (each later call's period written into an earlier call's answer,
  // even one frozen) — which left the tick-spacing check comparing a re-run
  // with itself and the report holding another case's numbers.
  const out = {};
  out["period/s"] = cycle.period;
  out["high/s"] = cycle.high;
  out["low/s"] = cycle.low;
  return out;
}

/** Whether two runs' answers agree to a tick-spacing bar (the rubric's,
    INVARIANCE, unless a case's accepted exception says otherwise). */
function sameAnswer(a, b, bar = INVARIANCE) {
  return Object.keys(a).every((k) => {
    if (a[k] == null || b[k] == null) return a[k] === b[k];
    return Math.abs(a[k] - b[k]) <= bar * Math.max(Math.abs(a[k]), 1e-3); // prettier-ignore
  });
}

const fmt = (x) => (x == null ? "—" : Number(x.toPrecision(5)).toString());
const report = {};

/** Known findings held to A as well (the one-line way to make them fail). */
const STRICT = Boolean(process.env.SPICE_GOLDEN_STRICT);

test("Spice Lite against ngspice — every case is in an area, once", () => {
  const areas = new Set(AREAS.map((a) => a.id));
  assert.equal(areas.size, AREAS.length, "two areas share an id");
  const ids = GOLDEN_CASES.map((c) => c.id);
  const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(twice, [], "case ids must be unique (the references are keyed by them)"); // prettier-ignore
  const lost = GOLDEN_CASES.filter((c) => !areas.has(c.area)).map((c) => `${c.id} (${c.area})`); // prettier-ignore
  assert.deepEqual(lost, [], "a case in no area is never graded");
});

for (const area of AREAS) {
  const cases = GOLDEN_CASES.filter((c) => c.area === area.id);
  test(`Spice Lite against ngspice — ${area.title}`, async (t) => {
    assert.ok(cases.length, `${area.title} has no cases: an empty area grades nothing`); // prettier-ignore
    const file = golden(area.id);
    assert.ok(file, `${area.id}.json is missing: run make spice-golden GOLDEN=${area.id}`); // prettier-ignore
    if (file.ngspice !== NGSPICE_VERSION) {
      t.diagnostic(`${area.id}.json is from ${file.ngspice}, the suite's references from ${NGSPICE_VERSION}`); // prettier-ignore
    }
    const refs = file.cases ?? {};
    const orphans = Object.keys(refs).filter((id) => !cases.some((c) => c.id === id)); // prettier-ignore
    assert.deepEqual(orphans, [], `${area.id}.json holds cases the suite no longer has: run make spice-golden GOLDEN=${area.id}`); // prettier-ignore
    let grade = "A";
    const lines = [];
    const missed = []; // known findings, still missing their A
    const accepted = []; // accepted exceptions, each within its allowance
    for (const c of cases) {
      let own = null;
      // An accepted exception's allowance (spice-golden-cases.js `accept`):
      // the worst grade it may take, and its tick-spacing bar.
      const accept = !STRICT && c.accept ? c.accept : null;
      const allowed = accept?.grade ?? "A";
      const bar = accept?.invariance ?? INVARIANCE;
      await t.test(c.id, { todo: !STRICT && c.known ? c.known : false }, () => {
        const ref = refs[c.id];
        assert.ok(ref, `${c.id} has no reference: run make spice-golden GOLDEN=${c.id}`); // prettier-ignore
        const keys = keysOf(c.measure);
        assert.equal(ref.reference, c.reference, `${c.id}'s reference is ${ref.reference}, the case's ${c.reference}: regenerate it`); // prettier-ignore
        assert.deepEqual(Object.keys(ref.values).sort(), [...keys].sort(), `${c.id}'s reference reads other values than the case: regenerate it`); // prettier-ignore
        for (const k of keys) {
          assert.ok(Number.isFinite(ref.values[k]), `${c.id} ${k}: the reference is ${ref.values[k]}, which grades nothing`); // prettier-ignore
        }
        const got = measure(c);
        own = "A";
        const mine = [];
        for (const k of keys) {
          const g = gradeOf(k, got[k], ref.values[k]);
          own = worse(own, g);
          const err = got[k] != null && ref.values[k] ? ((got[k] - ref.values[k]) / ref.values[k]) * 100 : null; // prettier-ignore
          mine.push(`  ${c.id} ${k}: ${fmt(got[k])} vs ${fmt(ref.values[k])} (${err == null ? "—" : `${err >= 0 ? "+" : ""}${err.toFixed(2)} %`}) ${g}`); // prettier-ignore
        }
        const spaced = (c.measure.grids ?? []).map((g) => measure(c, g));
        // …and ticked only when the engine wakes: no display frames.
        if (c.measure.kind !== "dc") spaced.push(measure(c, null, { frames: false })); // prettier-ignore
        const steady = spaced.every((s) => sameAnswer(got, s, bar));
        if (!steady) {
          own = worse(own, "C");
          mine.push(`  ${c.id}: depends on the tick spacing (${spaced.map((s) => JSON.stringify(s)).join(" / ")})`); // prettier-ignore
        }
        report[c.id] = { area: area.id, grade: own, steady, got, ref: ref.values, spaced, ...(c.known ? { known: c.known } : {}), ...(c.accept ? { accept: c.accept } : {}) }; // prettier-ignore
        lines.push(...mine);
        assert.equal(worse(own, allowed), allowed, `${c.id} is ${own} against ngspice${accept ? ` (accepted: ${allowed})` : ""}:\n${mine.join("\n")}`); // prettier-ignore
        if (accept) {
          // A ratchet both ways: an allowance the case no longer needs is
          // tightened or dropped.
          if (accept.grade) assert.notEqual(own, "A", `${c.id} grades A now: drop its accepted grade`); // prettier-ignore
          if (accept.invariance) {
            const strict = spaced.every((s) => sameAnswer(got, s));
            assert.ok(!strict, `${c.id} keeps the rubric's tick-spacing bar now: drop its accepted invariance`); // prettier-ignore
          }
          accepted.push(`${c.id} (${own}${accept.invariance ? `, tick spacing within ${accept.invariance}` : ""}): ${accept.why}`); // prettier-ignore
        }
      });
      if (c.known && !STRICT) {
        if (own !== "A") missed.push(`${c.id} (${own ?? "not graded"}): ${c.known}`); // prettier-ignore
        assert.ok(own !== "A", `${c.id} is marked known but grades A now: drop its \`known\``); // prettier-ignore
      } else if (own && !accept) grade = worse(grade, own);
    }
    t.diagnostic(`${area.title}: ${grade}${missed.length ? ` (${missed.length} known)` : ""}${accepted.length ? ` (${accepted.length} accepted)` : ""}`); // prettier-ignore
    for (const line of lines) t.diagnostic(line);
    for (const line of missed) t.diagnostic(`  KNOWN ${line}`);
    for (const line of accepted) t.diagnostic(`  ACCEPTED ${line}`);
    report[`area:${area.id}`] = { grade, known: missed.length, accepted: accepted.length }; // prettier-ignore
  });
}

after(() => {
  const path = process.env.SPICE_GOLDEN_REPORT;
  if (path) writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
});
