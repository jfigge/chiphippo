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

// Islands (features/04-island-analog-bookkeeping.md): parts of a desk that
// cannot see each other — their own boards, their own supplies — each with
// its own cycle, its own event budget and its own chatter back-off
// (spice/islands.js). Each oscillator here runs beside another and must
// measure what it measures alone.

import test from "node:test";
import assert from "node:assert/strict";
import { driveSpice } from "../bench/drive-spice.js";
import {
  ASTABLES,
  EMPTY,
  desk,
  island555,
  islandWave,
  relabel,
} from "../bench/islands-fixtures.js";
import { busyDocument } from "../bench/busy-circuit.js";
import { relaxation } from "./incremental-fixtures.js";
import { INVARIANCE, TOLERANCE } from "./spice-golden-cases.js";

/** A 555's measured period at the end of `seconds` of `doc`, and the run. */
function periodOf(doc, chip, seconds, opts = {}) {
  let oscillation = 0;
  const run = driveSpice(doc, { seconds, end: true, onTick: (now, r) => { if (r.warnings.some((w) => w.type === "oscillation")) oscillation++; }, ...opts }); // prettier-ignore
  const section = run.result.timing.get(chip)?.sections?.[0];
  return { period: section?.measured ? section.period : null, oscillation, run }; // prettier-ignore
}

/** Within the golden NE555 area's grade (tests/spice-golden-cases.js: A). */
function sameAsAlone(together, alone, what) {
  assert.ok(alone > 0 && together > 0, `${what}: measured (${together} vs ${alone})`); // prettier-ignore
  const rel = Math.abs(together - alone) / alone;
  assert.ok(rel <= TOLERANCE.A.rel, `${what}: ${together} beside the other, ${alone} alone (${(rel * 100).toFixed(3)} %)`); // prettier-ignore
}

test("two 555s on their own boards and supplies are two islands, each analog", () => {
  const doc = desk(EMPTY, island555(ASTABLES.fast, 0), island555({ ...ASTABLES.fast, rb: 12e3 }, 1)); // prettier-ignore
  const run = driveSpice(doc, { seconds: 0.002, end: true });
  const isl = run.result.analog.islands;
  assert.equal(isl.analog.length, 2);
  assert.notEqual(isl.chipIsland.get("i0_u1"), isl.chipIsland.get("i1_u1"));
});

test("two unconnected 555s with different periods: both drawn by their own schedules, each at its period alone", () => {
  const a = ASTABLES.fast;
  const b = { ...ASTABLES.fast, rb: 12e3 };
  const seconds = 0.2;
  const both = desk(EMPTY, island555(a, 0), island555(b, 1));
  const stats = {};
  const together = periodOf(both, "i0_u1", seconds, { stats });
  assert.equal(together.run.result.analog.cycles.size, 2, "both drawn");
  assert.equal(together.oscillation, 0, "and neither an oscillation");
  const second = together.run.result.timing.get("i1_u1").sections[0].period;
  const aloneA = periodOf(desk(EMPTY, island555(a, 0)), "i0_u1", seconds);
  const aloneB = periodOf(desk(EMPTY, island555(b, 1)), "i1_u1", seconds);
  sameAsAlone(together.period, aloneA.period, "the 10 kΩ 555");
  sameAsAlone(second, aloneB.period, "the 12 kΩ 555");
  // Each drawn: replayed from its record, a frame at a time — not run edge
  // by edge into the event cap.
  assert.ok(stats.replays > 0, "replayed");
  assert.ok(together.run.ticks < 3 * (aloneA.run.ticks + aloneB.run.ticks), `ticks ${together.run.ticks} vs ${aloneA.run.ticks} + ${aloneB.run.ticks} alone`); // prettier-ignore
});

test("a 68 kHz 555 beside a triangle clock elsewhere is drawn, at its period alone", () => {
  const seconds = 0.3;
  const beside = desk(EMPTY, island555(ASTABLES.faster, 0), islandWave("triangle", 10, 10e3, 1e-6, 1)); // prettier-ignore
  const together = periodOf(beside, "i0_u1", seconds);
  assert.equal(together.run.result.analog.cycles.size, 1, "the 555 drawn");
  assert.equal(together.oscillation, 0);
  const alone = periodOf(desk(EMPTY, island555(ASTABLES.faster, 0)), "i0_u1", seconds); // prettier-ignore
  sameAsAlone(together.period, alone.period, "the 68 kHz 555");
  // …on EVERY tick, not only the last: a frame wake walks two cycles, so
  // the readout always times a rise from the one before it.
  const periods = [];
  driveSpice(beside, { seconds, onTick: (now, r) => { const s = r.timing.get("i0_u1")?.sections?.[0]; if (s?.measured && now > 0.01) periods.push(s.period); } }); // prettier-ignore
  assert.ok(periods.length > 5);
  for (const p of periods) sameAsAlone(p, alone.period, "every tick's readout");
});

test("one island chattering does not delay a healthy island's crossings", () => {
  const seconds = 0.3;
  const slow = island555(ASTABLES.slow, 0);
  const loop = relaxation("CD4069UB", { r: 100e3, c: 1e-6 });
  const chatter = relabel(loop, "x_", 100, 60);
  const both = desk(EMPTY, slow, chatter);
  // The same inverter with its feedback resistor taken out, quiet: the desk
  // the 555 is compared on holds the same chips. (Each island keeps its own
  // pace — features/13 — so on it the 555 runs exactly as on a desk alone.)
  const still = relabel({ ...loop, components: loop.components.filter((c) => c.id !== "r1") }, "x_", 100, 60); // prettier-ignore
  // Each moment its OUT rose at, as its readout timed it (spice/measure.js
  // — the settle's own moment, whichever tick ran it).
  const rises = (doc) => {
    const at = [];
    const run = driveSpice(doc, { seconds, end: true, onTick: (now, r) => { const m = r.analog.marks.get("i0_u1#3"); if (m?.rise != null && m.rise !== at.at(-1)) at.push(m.rise); } }); // prettier-ignore
    return { at, run };
  };
  const together = rises(both);
  const { analog } = together.run.result;
  assert.ok(analog.chatters.length >= 1, "the inverter chatters");
  assert.ok(analog.chatters.every((c) => c.key !== analog.islands.chipIsland.get("i0_u1")), "the 555's island does not"); // prettier-ignore
  const alone = rises(desk(EMPTY, slow, still));
  assert.equal(alone.run.result.analog.chatters.length, 0, "the quiet one does not chatter"); // prettier-ignore
  assert.ok(alone.at.length >= 10, `the 555 ran (${alone.at.length} rises)`);
  assert.equal(together.at.length, alone.at.length, "as many rises");
  // Each rise where it is beside the quiet loop — to the golden rubric's
  // tick-spacing tolerance (INVARIANCE of a period): ticked only at its own
  // events (features/12), a crossing can be settled a few gate delays apart
  // from where a tick of the other island happened to catch it.
  const period = alone.at[1] - alone.at[0];
  together.at.forEach((t, i) => assert.ok(Math.abs(t - alone.at[i]) <= INVARIANCE * period, `rise ${i}: ${t} vs ${alone.at[i]}`)); // prettier-ignore
  const p = periodOf(both, "i0_u1", seconds).period;
  const q = periodOf(desk(EMPTY, slow, still), "i0_u1", seconds).period;
  sameAsAlone(p, q, "the 555's period");
});

/** Two slow 555s on their own boards (their edges apart — two fast ones
    are woken together, each tick a frame for both); `shared`: both fed by
    the first's supply. */
function twin555(shared) {
  const doc = desk(EMPTY, island555(ASTABLES.slow, 0), island555({ ...ASTABLES.slow, rb: 12e3 }, 1)); // prettier-ignore
  if (!shared) return doc;
  doc.components = doc.components.filter((c) => c.id !== "i1_psu1");
  for (const w of doc.wires) {
    w.from = w.from.replace(/^i1_psu1\./, "i0_psu1.");
    w.to = w.to.replace(/^i1_psu1\./, "i0_psu1.");
  }
  return doc;
}

/** Every tick of `doc` scheduled by island and not, side by side. */
function ticksBothWays(doc, seconds) {
  const run = (scoped) => {
    const out = [];
    const stats = {};
    driveSpice(doc, { seconds, end: true, stats, spice: { scoped }, onTick: (now, r) => out.push({ now, levels: [...r.netLevels], volts: [...(r.nodeVolts ?? [])], supplies: [...(r.supplies ?? [])].map(([id, s]) => [id, s.volts, s.amps]), wakeAt: r.wakeAt }) }); // prettier-ignore
    return { out, stats };
  };
  return { scoped: run(true), unscoped: run(false) };
}

test("islands sharing a supply are scheduled together: every tick exactly as unscheduled", () => {
  const { scoped, unscoped } = ticksBothWays(twin555(true), 0.1);
  assert.deepStrictEqual(scoped.out, unscoped.out);
});

test("islands on their own supplies are ticked apart, each at its period alone", () => {
  const { scoped } = ticksBothWays(twin555(false), 0.1);
  assert.ok(scoped.stats.scopedTicks > 0, "ticks for one island only");
  const run = driveSpice(twin555(false), { seconds: 0.2, end: true });
  const alone = (values, slot) => driveSpice(desk(EMPTY, island555(values, slot)), { seconds: 0.2, end: true }).result.timing.get(`i${slot}_u1`).sections[0].period; // prettier-ignore
  // (Within the tick-spacing tolerance, not just the grade: each is ticked
  // as if it were alone.)
  const close = (a, b, what) => assert.ok(Math.abs(a - b) <= INVARIANCE * b, `${what}: ${a} vs ${b} alone`); // prettier-ignore
  close(run.result.timing.get("i0_u1").sections[0].period, alone(ASTABLES.slow, 0), "the 10 kΩ 555"); // prettier-ignore
  close(run.result.timing.get("i1_u1").sections[0].period, alone({ ...ASTABLES.slow, rb: 12e3 }, 1), "the 12 kΩ 555"); // prettier-ignore
});

test("a CD4000 island beside a 74LS board keeps its own gates' pace", () => {
  // features/13-per-island-quantum.md: a pass on a tick for the CD40106's
  // island alone is ITS gate delay, not the 74LS board's 10 ns — so its
  // crossings settle in about the passes they take on a desk of their own
  // (a tick for both islands adds the board's), at the moments they do there.
  const seconds = 0.4;
  const loop = relabel(relaxation("CD40106B", { r: 100e3, c: 1e-6 }), "x_", 0, -40); // prettier-ignore
  const flips = (doc) => {
    const stats = {};
    const at = [];
    const passes = [];
    let last = 0;
    let level = null;
    driveSpice(doc, { seconds, end: true, stats, onTick: (now, r) => { const lv = r.netLevels.get("x_bb1.a11"); if (lv !== level) { at.push(now); passes.push(stats.passes - last); level = lv; } last = stats.passes; } }); // prettier-ignore
    return { at: at.slice(1), passes: passes.slice(1) };
  };
  const mixed = flips(desk(busyDocument(1, { hz: 100 }), loop));
  const alone = flips(desk(EMPTY, loop));
  assert.ok(alone.at.length >= 6, `the loop ran (${alone.at.length} flips)`);
  assert.equal(mixed.at.length, alone.at.length, "as many flips");
  const period = alone.at[2] - alone.at[0];
  // (Cut into the board's 10 ns, a CD40106 crossing took 14 passes.)
  mixed.at.forEach((t, i) => {
    assert.ok(mixed.passes[i] <= alone.passes[i] + 1, `flip ${i}: ${mixed.passes[i]} passes, ${alone.passes[i]} alone`); // prettier-ignore
    // (A flip on a tick for both is seen at that tick's end, a frame.)
    if (mixed.passes[i] > alone.passes[i]) return;
    assert.ok(Math.abs(t - alone.at[i]) <= INVARIANCE * period, `flip ${i}: ${t} vs ${alone.at[i]}`); // prettier-ignore
  });
});

test("an island that appears mid-run is ticked as one that was there from Run", () => {
  // A part edited in (here the second 555's timing capacitor) re-sorts the
  // desk's islands; the next tick must not be scoped by the LAST desk's
  // islands and their next events, or the new one could stand frozen while
  // the other keeps the ticks to itself (dueIslands' same-desk rule).
  const full = desk(EMPTY, island555(ASTABLES.fast, 0), island555({ ...ASTABLES.slow, rb: 12e3 }, 1)); // prettier-ignore
  const before = structuredClone(full);
  before.components = before.components.filter((c) => !(c.id.startsWith("i1_") && /^cap/.test(c.ref))); // prettier-ignore
  const periodWith = (scoped) => driveSpice(before, { seconds: 0.15, end: true, spice: { scoped }, edits: [{ at: 0.0123, doc: full }] }).result.timing.get("i1_u1")?.sections?.[0]?.period; // prettier-ignore
  const scoped = periodWith(true);
  const reference = periodWith(false);
  assert.ok(scoped > 0, "the new island runs");
  assert.ok(Math.abs(scoped - reference) <= INVARIANCE * reference, `${scoped} vs ${reference} unscheduled`); // prettier-ignore
});
