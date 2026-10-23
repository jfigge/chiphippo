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

// A cycle Spice Lite draws slowed, as the analyzer draws it: true
// (model/scope-periodic.js).

import test from "node:test";
import assert from "node:assert/strict";

import {
  PeriodicTracker,
  spanAt,
  templateAt,
} from "../model/scope-periodic.js";

// A true cycle of 200 µs: a ramp 1 → 3 V over its first 100 µs (HIGH),
// then held at 0.5 V (LOW) — stepped at 0 and 100 µs.
const P = 200e-6;
const TEMPLATE = [
  { u: 0, cell: "H", volts: 1, curve: false },
  { u: 50e-6, cell: "H", volts: 2, curve: true },
  { u: 100e-6, cell: "H", volts: 3, curve: true },
  { u: 100e-6, cell: "L", volts: 0.5, curve: false },
];
// Shown slowed to 1 ms from 0.010 s on: 5 true cycles a shown one.
const CYCLE = { id: 0.01, start: 0.01, shown: 1e-3, period: P };

test("templateAt joins curve points, holds to a step, and wraps round the period", () => {
  assert.equal(templateAt(TEMPLATE, 25e-6, P).volts, 1.5);
  assert.equal(templateAt(TEMPLATE, 75e-6, P).cell, "H");
  const low = templateAt(TEMPLATE, 150e-6, P);
  assert.deepEqual([low.cell, low.volts], ["L", 0.5], "held to the next step");
  // At 100 µs both the ramp's end and the step are there.
  assert.equal(templateAt(TEMPLATE, 100e-6, P, 1e-12).near.length, 2);
  // Past the last point it runs on to the first, a period on: a step.
  assert.equal(templateAt(TEMPLATE, 199e-6, P).volts, 0.5);
});

/** The value the slowed picture shows at sim time `at`. */
const shownAt = (at) => {
  const u = (((at - CYCLE.start) % CYCLE.shown) / CYCLE.shown) * P;
  const r = templateAt(TEMPLATE, u, P);
  return { cell: r.cell, volts: r.volts };
};

function feed(tracker, times, valueAt = shownAt) {
  for (const at of times) {
    tracker.observe(
      at,
      new Map([["a", { ...valueAt(at), cycle: CYCLE, template: TEMPLATE }]]),
      { tolerance: 0.1 },
    );
  }
}

const grid = (from, to, step) => {
  const out = [];
  for (let t = from; t <= to + 1e-12; t += step) out.push(t);
  return out;
};

test("a channel is drawn true only once a whole shown cycle has stood on its template", () => {
  const tracker = new PeriodicTracker();
  feed(tracker, grid(0.01, 0.0105, 1e-4));
  assert.deepEqual(tracker.spansOf("a"), [], "half a shown cycle: not yet");
  feed(tracker, grid(0.0106, 0.0125, 1e-4));
  const [span] = tracker.spansOf("a");
  assert.ok(span, "confirmed");
  assert.equal(span.period, P);
  assert.equal(span.from, 0.01);
  assert.ok(Math.abs(span.to - 0.0125) < 1e-9);
  assert.equal(spanAt([span], 0.011), span);
  assert.equal(spanAt([span], 0.02), null);
});

test("a column off its template ends the stretch; it is looked at again from the next shown cycle", () => {
  const tracker = new PeriodicTracker();
  feed(tracker, grid(0.01, 0.0125, 1e-4));
  // A counter output on the island moves at its own pace: 4 V where the
  // picture says otherwise.
  feed(tracker, [0.01255], () => ({ cell: "H", volts: 4 }));
  const [span] = tracker.spansOf("a");
  assert.ok(Math.abs(span.to - 0.0125) < 1e-9, "what fitted stands");
  // Back on its template: a new stretch from the next shown cycle (13 ms),
  // confirmed a shown cycle later.
  feed(tracker, grid(0.0126, 0.0145, 1e-4));
  assert.equal(tracker.spansOf("a").length, 2);
  const again = tracker.spansOf("a")[1].from;
  assert.ok(again >= 0.013 - 1e-9 && again < 0.0131 + 1e-9, `${again}`);
});

test("a flat template, a channel on no cycle and a new run leave nothing", () => {
  const tracker = new PeriodicTracker();
  const flatTemplate = [{ u: 0, cell: "L", volts: 0.1, curve: false }];
  for (const at of grid(0.01, 0.013, 1e-4)) {
    tracker.observe(
      at,
      new Map([
        ["flat", { cell: "L", volts: 0.1, cycle: CYCLE, template: flatTemplate }], // prettier-ignore
        ["none", { cell: "H", volts: 5, cycle: null, template: null }],
      ]),
      { tolerance: 0.1 },
    );
  }
  assert.deepEqual(
    tracker.spansOf("flat"),
    [],
    "a counter's slow stage, still: its columns say it",
  );
  assert.deepEqual(tracker.spansOf("none"), []);
  feed(tracker, grid(0.01, 0.0125, 1e-4));
  assert.equal(tracker.spansOf("a").length, 1);
  tracker.evictBefore(0.02);
  assert.equal(tracker.spansOf("a").length, 1, "the open stretch is kept");
  tracker.reset();
  assert.deepEqual(tracker.spansOf("a"), []);
});
