/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Unit tests for the pure undo/redo core (model/history-store.js): the
// past/present/future cursor, byte-exact snapshot round-trips, opt-in
// coalescing in a time window, the depth bound, redo truncation, freeze during
// a run, and sync-on-stop. No DOM, no wall-clock — every time is injected.

import test from "node:test";
import assert from "node:assert/strict";

import { HistoryStore } from "../model/history-store.js";

/** A distinct snapshot object per step (identity + a value to compare). */
const snap = (n) => ({ step: n, boards: [{ id: `bb${n}` }] });

test("a fresh store seeded with one snapshot has nothing to undo/redo", () => {
  const h = new HistoryStore();
  h.clear(snap(0));
  assert.equal(h.canUndo, false);
  assert.equal(h.canRedo, false);
  assert.equal(h.size, 1);
});

test("record/undo/redo walk the cursor and return the right snapshots", () => {
  const h = new HistoryStore();
  h.clear(snap(0));
  h.record(snap(1), "a", 1);
  h.record(snap(2), "b", 2);
  assert.equal(h.canUndo, true);
  assert.equal(h.canRedo, false);

  assert.deepEqual(h.undo(), snap(1));
  assert.deepEqual(h.undo(), snap(0));
  assert.equal(h.canUndo, false);
  assert.equal(h.undo(), null); // past the start

  assert.deepEqual(h.redo(), snap(1));
  assert.deepEqual(h.redo(), snap(2));
  assert.equal(h.canRedo, false);
  assert.equal(h.redo(), null); // past the end
});

test("undo/redo return byte-identical snapshots", () => {
  const h = new HistoryStore();
  const s0 = snap(0);
  const s1 = { boards: [{ id: "bb1", x: 3, y: 4 }], wires: [], nextBoardId: 2 };
  h.clear(s0);
  h.record(s1, "edit", 1);
  const back = h.undo();
  const forward = h.redo();
  assert.deepEqual(back, s0);
  assert.deepEqual(forward, s1);
  // The stored entry is the very object passed in (the caller clones, not us).
  assert.equal(forward, s1);
});

test("a new edit after an undo truncates the redo future", () => {
  const h = new HistoryStore();
  h.clear(snap(0));
  h.record(snap(1), "a", 1);
  h.record(snap(2), "b", 2);
  h.undo(); // back to snap(1)
  assert.equal(h.canRedo, true);
  h.record(snap(3), "c", 3); // a new branch drops snap(2)
  assert.equal(h.canRedo, false);
  assert.deepEqual(h.undo(), snap(1));
  assert.deepEqual(h.redo(), snap(3));
});

test("opt-in coalescing merges a same-label burst into one entry", () => {
  const h = new HistoryStore({ coalesceMs: 400 });
  h.clear(snap(0));
  h.record(snap(1), "set voltage", 100, { coalesce: true });
  h.record(snap(2), "set voltage", 200, { coalesce: true });
  h.record(snap(3), "set voltage", 300, { coalesce: true });
  // Three nudges inside the window collapse to a single undo step.
  assert.equal(h.size, 2); // baseline + the coalesced entry
  assert.deepEqual(h.undo(), snap(0)); // one undo lands before the burst
});

test("coalescing stops once the time window is exceeded", () => {
  const h = new HistoryStore({ coalesceMs: 400 });
  h.clear(snap(0));
  h.record(snap(1), "set voltage", 100, { coalesce: true });
  h.record(snap(2), "set voltage", 600, { coalesce: true }); // 500ms later
  assert.equal(h.size, 3);
});

test("records without the coalesce flag never merge, even same-label", () => {
  const h = new HistoryStore({ coalesceMs: 400 });
  h.clear(snap(0));
  h.record(snap(1), "delete part", 100);
  h.record(snap(2), "delete part", 150);
  assert.equal(h.size, 3); // two distinct undo steps
});

test("a differently-labelled edit never coalesces into the prior burst", () => {
  const h = new HistoryStore({ coalesceMs: 400 });
  h.clear(snap(0));
  h.record(snap(1), "set voltage", 100, { coalesce: true });
  h.record(snap(2), "set clock rate", 150, { coalesce: true });
  assert.equal(h.size, 3);
});

test("history is bounded: the oldest entries drop past the limit", () => {
  const h = new HistoryStore({ limit: 3 });
  h.clear(snap(0));
  h.record(snap(1), "a", 1);
  h.record(snap(2), "b", 2);
  h.record(snap(3), "c", 3); // pushes snap(0) out
  assert.equal(h.size, 3);
  // The deepest undo now reaches snap(1), not snap(0).
  assert.deepEqual(h.undo(), snap(2));
  assert.deepEqual(h.undo(), snap(1));
  assert.equal(h.canUndo, false);
});

test("frozen record is a no-op; unfreeze resumes recording", () => {
  const h = new HistoryStore();
  h.clear(snap(0));
  h.freeze();
  h.record(snap(1), "a", 1);
  h.record(snap(2), "b", 2);
  assert.equal(h.size, 1); // nothing recorded while frozen
  assert.equal(h.canUndo, false);
  h.unfreeze();
  h.record(snap(3), "c", 3);
  assert.equal(h.size, 2);
  assert.deepEqual(h.undo(), snap(0));
});

test("sync rewrites the present snapshot without adding an undo step", () => {
  const h = new HistoryStore();
  h.clear(snap(0));
  h.record(snap(1), "a", 1);
  const synced = { ...snap(1), damaged: true };
  h.sync(synced);
  assert.equal(h.size, 2); // no new entry
  assert.deepEqual(h.redo(), null); // still at the present
  assert.deepEqual(h.undo(), snap(0));
  assert.deepEqual(h.redo(), synced); // the reconciled present
});

test("clear() with no snapshot leaves an empty stack", () => {
  const h = new HistoryStore();
  h.record(snap(1), "a", 1);
  h.clear();
  assert.equal(h.size, 0);
  assert.equal(h.canUndo, false);
  assert.equal(h.canRedo, false);
  assert.equal(h.undo(), null);
});

test("clear() also thaws a frozen store", () => {
  const h = new HistoryStore();
  h.clear(snap(0));
  h.freeze();
  h.clear(snap(0));
  assert.equal(h.frozen, false);
});
