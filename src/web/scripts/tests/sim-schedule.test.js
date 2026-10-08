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

// The edge schedule (sim/schedule.js) and the run meter (sim-pacer.js) —
// the pure halves of SimController's batches (features/done/batched-ticks.md).

import test from "node:test";
import assert from "node:assert/strict";

import { EdgeSchedule, halfPeriodOf } from "../sim/schedule.js";
import { RunMeter } from "../components/sim-pacer.js";

/** Pop `n` events, flipping (consuming) each one's clocks. */
function drain(schedule, n, wakeAt = null) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const e = schedule.next(wakeAt);
    if (!e) break;
    schedule.consume(e.clocks);
    out.push(e);
  }
  return out;
}

test("a clock's edges fall every half-period from where it started", () => {
  const s = new EdgeSchedule();
  s.set("clk1", halfPeriodOf(1000), 2);
  const at = drain(s, 4).map((e) => e.at);
  assert.deepEqual(at, [2.0005, 2.001, 2.0015, 2.002]);
});

test("edges are COUNTED, so a thousand in they have not drifted", () => {
  const s = new EdgeSchedule();
  s.set("fast", halfPeriodOf(1000), 0);
  s.set("slow", halfPeriodOf(1), 0);
  const events = drain(s, 1100);
  // Every 1000th fast edge lands WITH a slow one: one event, both clocks.
  // 1100 events reach 0.55 s, so there is exactly one shared edge: at 0.5.
  const both = events.filter((e) => e.clocks.length === 2);
  assert.equal(both.length, 1);
  assert.equal(both[0].at, 0.5);
  assert.deepEqual(both[0].clocks.sort(), ["fast", "slow"]);
});

test("coincident edges are ONE event — every clock in it flips together", () => {
  const s = new EdgeSchedule();
  s.set("a", halfPeriodOf(10), 0);
  s.set("b", halfPeriodOf(20), 0);
  const [first, second] = drain(s, 2);
  assert.deepEqual(first, { at: 0.025, clocks: ["b"] });
  assert.deepEqual(second.clocks.sort(), ["a", "b"]);
  assert.ok(Math.abs(second.at - 0.05) < 1e-12);
});

test("a timed part's wake is an event too, and joins an edge it lands on", () => {
  const s = new EdgeSchedule();
  assert.equal(s.next(null), null, "nothing scheduled, nothing due");
  assert.deepEqual(s.next(0.3), { at: 0.3, clocks: [] });
  s.set("clk1", halfPeriodOf(1), 0);
  assert.deepEqual(s.next(0.3), { at: 0.3, clocks: [] }, "the wake first");
  assert.deepEqual(s.next(0.5), { at: 0.5, clocks: ["clk1"] }, "together");
  assert.deepEqual(
    s.next(0.9),
    { at: 0.5, clocks: ["clk1"] },
    "the edge first",
  );
});

test("set keeps a clock's phase unless its rate changed; delete drops it", () => {
  const s = new EdgeSchedule();
  s.set("clk1", halfPeriodOf(2), 0);
  assert.equal(s.set("clk1", halfPeriodOf(2), 0.1), false, "same rate: kept");
  assert.equal(s.next().at, 0.25);
  assert.equal(s.set("clk1", halfPeriodOf(5), 0.1), true, "re-rated");
  assert.ok(Math.abs(s.next().at - 0.2) < 1e-12, "a half-period from now");
  assert.deepEqual([...s.halves], [["clk1", 0.1]]);
  s.delete("clk1");
  assert.equal(s.has("clk1"), false);
  assert.equal(s.next(), null);
});

test("the run meter reports the speed achieved only after a batch fell short", () => {
  const m = new RunMeter();
  for (let wall = 0; wall <= 500; wall += 10) m.record(wall, (wall / 1000) * 4);
  assert.equal(m.behind(500, 4), null, "keeping up at ×4");
  const slow = new RunMeter();
  for (let wall = 0; wall <= 500; wall += 10) slow.record(wall, wall / 1000);
  assert.equal(slow.behind(500, 4), null, "no debt dropped: not behind");
  slow.dropped(500);
  assert.ok(Math.abs(slow.behind(500, 4) - 1) < 1e-9, "×1 achieved of ×4");
  assert.equal(slow.behind(1600, 4), null, "a second later it is forgotten");
  slow.reset();
  slow.dropped(0);
  assert.equal(slow.behind(0, 4), null, "no samples, no claim");
});
