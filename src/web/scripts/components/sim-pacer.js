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

// sim-pacer.js — how often SimController wakes to run a BATCH of ticks, how
// long one batch may work, and how fast simulated time is actually going
// (features/done/batched-ticks.md). DOM-free; the wall clock is handed in, so the
// tests choose it.
//
// The views are told about a batch once, however many edges it ran, and a
// display shows ~60–120 frames a second — so a batch runs at most every
// FRAME_MS. A batch that cannot do all that is due inside BATCH_BUDGET_MS
// leaves the rest UNDONE: simulated time is moved back to the last edge it
// ran (the debt is dropped, not queued — a stall's rule, "time freezes, edges
// are skipped"), the run goes slower, and the meter says by how much, so the
// speed button can show it. A transport that quietly ran slower than asked is
// what the old timer floor was written to prevent.

/** The shortest gap between two batches, wall ms. */
export const FRAME_MS = 8;

/** How often the views are told, at most, wall ms — 25 frames a second
    (features/01-display-wakes.md). A batch's board, or a moving desk's
    curves read where the sim clock has got to, goes out at most this often;
    an input's tick still publishes at once. */
export const PUBLISH_MS = 40;

/** The most wall ms one batch spends ticking before it lets the frame go. */
export const BATCH_BUDGET_MS = 6;

/** The simulation Worker's pacing (components/sim-worker-host.js): no
    display shares its thread, so a batch need not leave a gap for one, and
    may work most of a publish frame — 30 ms of 40 — before it lets the
    messages waiting for it (an input, an edit) in. A run that is BEHIND
    goes from one batch straight to the next on the unclamped continuation
    (SimController #arm), so an input waits for the batch in flight: for
    INPUT_WINDOW_MS after an input a pacer's batches work `behindMs`, and
    the next input is let in three times as often (runtime review N3:
    busy16k ×4, a clock's pause answered in 20–41 ms, now 4–16 after the
    first). Not always — each batch costs, and 10 ms ones throughout ran
    that desk ×3.80, not ×3.90. */
export const WORKER_PACING = Object.freeze({
  frameMs: 0,
  budgetMs: 30,
  behindMs: 10,
});

/** How long a dropped debt keeps the run reported as behind, wall ms — and
    the window the achieved rate is measured over. */
export const BEHIND_WINDOW_MS = 1000;

/** The run reads as behind only below this share of the asked speed. */
const BEHIND_SHARE = 0.95;

/** The meter keeps a sample at most this often, wall ms (RunMeter#record). */
const SAMPLE_MS = 1;

/**
 * Simulated time against wall time, over the last BEHIND_WINDOW_MS. Fed one
 * sample per batch; told when a batch dropped debt. Reset whenever the sim
 * clock is stopped ON PURPOSE (pause, a speed change, the chip debugger
 * holding the board), so a frozen stretch never reads as a slow one. An
 * Arduino's stall is not reset: the board waiting on its device IS the run
 * going slower than asked, and its end is told as dropped debt.
 */
export class RunMeter {
  // [{wall, sim}] oldest first from #head — at most one a wall ms (#record):
  // a run behind on back-to-back batches records thousands a second, and
  // one shifted off the front at a time, the first record after a clock's
  // pause moved 40–60k of them for every one it let go — a 330–710 ms
  // stall on resume (runtime regrade NEW-1, 2026-10-27).
  #samples = [];
  #head = 0;
  #lastDrop = -Infinity;

  reset() {
    this.#samples = [];
    this.#head = 0;
    this.#lastDrop = -Infinity;
  }

  /** The samples held (the tests: bounded by the window, a wall ms each). */
  get size() {
    return this.#samples.length - this.#head;
  }

  /** A batch ended with the sim clock at `sim` seconds at wall ms `wall`. */
  record(wall, sim) {
    const s = this.#samples;
    // Within a ms of the one before it, the newest sample is moved, not
    // added to: the rate over a second reads the same.
    if (this.size >= 2 && wall - s[s.length - 2].wall < SAMPLE_MS) {
      s[s.length - 1] = { wall, sim };
    } else s.push({ wall, sim });
    while (s.length - this.#head > 2 && wall - s[this.#head + 1].wall >= BEHIND_WINDOW_MS) this.#head += 1; // prettier-ignore
    // The dead front is let go once it is half the array: each sample is
    // copied at most once more, so a record is O(1) amortized.
    if (this.#head > 64 && this.#head * 2 > s.length) {
      this.#samples = s.slice(this.#head);
      this.#head = 0;
    }
  }

  /** A batch ran out of budget with events still due. */
  dropped(wall) {
    this.#lastDrop = wall;
  }

  /** The wall ms from which `behind` reads null again, whatever comes —
      the last dropped debt's window closed. */
  clearsAt() {
    return this.#lastDrop + BEHIND_WINDOW_MS + 1;
  }

  /**
   * The speed actually achieved (simulated seconds per wall second), when it
   * falls short of `speed` — or null while the run keeps up.
   */
  behind(wall, speed) {
    if (wall - this.#lastDrop > BEHIND_WINDOW_MS) return null;
    const first = this.#samples[this.#head];
    const last = this.#samples.at(-1);
    if (!first || last.wall - first.wall < FRAME_MS) return null;
    const achieved = ((last.sim - first.sim) * 1000) / (last.wall - first.wall);
    return achieved < speed * BEHIND_SHARE ? achieved : null;
  }
}
