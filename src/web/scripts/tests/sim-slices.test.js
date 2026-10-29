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

// A pacer's batch on the Worker in SLICES (WORKER_PACING.sliceMs, the
// runtime round, 2026-10-28): it lets the thread go every `sliceMs` of work,
// on the continuation, so a Pause or an input sent meanwhile waits for a
// slice, not the batch's 30 ms — and goes on where it was, as one batch. The
// ticks it runs are the unsliced batch's, tick for tick; a Pause between two
// slices ends the batch on a tick boundary (catching up one slice at most,
// then dropping the rest as a batch out of budget does), and Step goes on one
// edge from there.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { busyDocument } from "../bench/busy-circuit.js";
import { WORKER_PACING } from "../components/sim-pacer.js";

const { SimController } = await import("../components/sim-controller.js");

/** A DeskDoc stand-in over a plain document. */
function fakeDoc(raw) {
  const doc = JSON.parse(JSON.stringify(raw));
  return {
    toJSON: () => doc,
    getComponent: (id) => doc.components.find((c) => c.id === id) ?? null,
    setComponentParams(id, patch) {
      const c = doc.components.find((x) => x.id === id);
      c.params = { ...c.params, ...patch };
      return c;
    },
  };
}

/** A wall clock and timers the test drives, every reading costing `cost`
    ms — and the longest TASK (one timer's run) it has seen: how long a
    message sent to the thread meanwhile would wait. */
function fakeClock({ cost = 0 } = {}) {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  const clock = {
    longest: 0,
    now() {
      const t = now;
      now += cost;
      return t;
    },
    setTimeout(fn, ms) {
      pending.set(++seq, { at: now + Math.max(0, ms), fn, seq });
      return seq;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of pending) {
          if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
        }
        if (!due) break;
        pending.delete(due[0]);
        now = Math.max(now, due[1].at);
        const from = now;
        due[1].fn();
        clock.longest = Math.max(clock.longest, now - from);
      }
      now = Math.max(now, end);
    },
  };
  return clock;
}

/** A busy desk on the Worker's pacing (or `pacing`), its continuation the
    test clock's, counted. */
function run({ sliceMs, budgetMs = WORKER_PACING.budgetMs, cost, hz = 1000 }) {
  resetDom();
  const clock = fakeClock({ cost });
  let soon = 0;
  const continuation = {
    set: (fn, ms) => ((soon += 1), clock.setTimeout(fn, ms)),
    clear: (id) => clock.clearTimeout(id),
  };
  const sim = new SimController({
    deskDoc: fakeDoc(busyDocument(2, { hz })),
    notifications: { notify() {}, dismiss() {}, clear() {} },
    clock,
    pacing: { ...WORKER_PACING, budgetMs, sliceMs },
    continuation,
  });
  sim.setSpeed(4);
  const ticks = [];
  const states = [];
  window.addEventListener("chiphippo:sim-ticks", (e) => ticks.push(...e.detail.ticks.map((t) => ({ at: t.at, levels: JSON.stringify([...t.netLevels]) })))); // prettier-ignore
  window.addEventListener("chiphippo:sim-state", (e) => states.push(e.detail));
  return { sim, clock, ticks, states, soon: () => soon };
}

test("the Worker's pacing slices its batches", () => {
  assert.ok(WORKER_PACING.sliceMs > 0 && WORKER_PACING.sliceMs < WORKER_PACING.behindMs); // prettier-ignore
});

test("a batch run in slices runs the unsliced batch's ticks, tick for tick", async () => {
  // A budget no batch reaches: nothing is ever dropped, so the ticks are the
  // schedule's whatever the batching — and the slices must not change one.
  const out = {};
  for (const sliceMs of [0, WORKER_PACING.sliceMs]) {
    const r = run({ sliceMs, budgetMs: 1e6, cost: 0.02 });
    await r.sim.start();
    r.clock.advance(1500);
    r.sim.stop();
    out[sliceMs] = r;
  }
  const whole = out[0].ticks;
  const sliced = out[WORKER_PACING.sliceMs].ticks;
  const n = Math.min(whole.length, sliced.length);
  assert.ok(n > 500, `${n} ticks compared`);
  for (let i = 0; i < n; i++) {
    assert.equal(sliced[i].at, whole[i].at, `tick ${i}'s moment`);
    assert.equal(sliced[i].levels, whole[i].levels, `tick ${i}'s levels`);
  }
});

test("a run behind lets the thread go every slice, not every batch", async () => {
  const longest = {};
  for (const sliceMs of [0, WORKER_PACING.sliceMs]) {
    const r = run({ sliceMs, cost: 0.1, hz: 2000 }); // (behind: 16000 edges a second asked)
    await r.sim.start();
    r.clock.advance(1000);
    assert.ok(r.states.at(-1).behind != null, "behind");
    longest[sliceMs] = r.clock.longest;
    r.sim.stop();
  }
  assert.ok(longest[0] >= WORKER_PACING.budgetMs - 1, `whole batches: ${longest[0]} ms`); // prettier-ignore
  // A slice, the tick that ends it, and a batch's close at most.
  assert.ok(longest[WORKER_PACING.sliceMs] <= WORKER_PACING.sliceMs + 2, `slices: ${longest[WORKER_PACING.sliceMs]} ms`); // prettier-ignore
});

test("a Pause between two slices stops on a tick boundary, at once, and Step goes on one edge from there", async () => {
  const r = run({ sliceMs: WORKER_PACING.sliceMs, cost: 0.02, hz: 10000 });
  const half = 1 / (2 * 10000);
  await r.sim.start();
  r.clock.advance(300);
  assert.ok(r.states.at(-1).behind != null, "behind");
  for (let k = 0; k < 12; k++) {
    // A press at a task boundary — between two slices, or two batches.
    r.clock.advance(7 + k * 3.3);
    const before = r.clock.now();
    r.sim.pause();
    const took = r.clock.now() - before;
    assert.equal(r.sim.mode, "paused");
    // It caught up a slice at most (and published the board).
    assert.ok(took <= WORKER_PACING.sliceMs + 1, `press ${k}: the Pause took ${took} ms`); // prettier-ignore
    // Frozen on the last tick run, never past an edge it did not run: the
    // board shown is that tick's.
    const shown = r.states.at(-1);
    const last = r.ticks.at(-1);
    assert.equal(shown.mode, "paused");
    assert.ok(shown.at >= last.at && shown.at < last.at + half, `press ${k}: frozen at ${shown.at}, the last tick at ${last.at}`); // prettier-ignore
    assert.equal(JSON.stringify([...shown.netLevels]), last.levels);
    // Step: one edge, half a period on from there.
    const n = r.ticks.length;
    r.sim.step();
    assert.equal(r.ticks.length, n + 1, `press ${k}: one tick a Step`);
    assert.ok(Math.abs(r.ticks.at(-1).at - shown.at - half) < 1e-9, `press ${k}: one edge on (${r.ticks.at(-1).at - shown.at})`); // prettier-ignore
    r.sim.resume();
  }
  r.sim.stop();
});
