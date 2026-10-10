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
    messages waiting for it (an input, an edit) in. */
export const WORKER_PACING = Object.freeze({ frameMs: 0, budgetMs: 30 });

/** How long a dropped debt keeps the run reported as behind, wall ms — and
    the window the achieved rate is measured over. */
export const BEHIND_WINDOW_MS = 1000;

/** The run reads as behind only below this share of the asked speed. */
const BEHIND_SHARE = 0.95;

/**
 * Simulated time against wall time, over the last BEHIND_WINDOW_MS. Fed one
 * sample per batch; told when a batch dropped debt. Reset whenever the sim
 * clock is stopped ON PURPOSE (pause, a speed change, the chip debugger
 * holding the board), so a frozen stretch never reads as a slow one. An
 * Arduino's stall is not reset: the board waiting on its device IS the run
 * going slower than asked, and its end is told as dropped debt.
 */
export class RunMeter {
  #samples = []; // [{wall, sim}] oldest first
  #lastDrop = -Infinity;

  reset() {
    this.#samples = [];
    this.#lastDrop = -Infinity;
  }

  /** A batch ended with the sim clock at `sim` seconds at wall ms `wall`. */
  record(wall, sim) {
    this.#samples.push({ wall, sim });
    while (
      this.#samples.length > 2 &&
      wall - this.#samples[1].wall >= BEHIND_WINDOW_MS
    ) {
      this.#samples.shift();
    }
  }

  /** A batch ran out of budget with events still due. */
  dropped(wall) {
    this.#lastDrop = wall;
  }

  /**
   * The speed actually achieved (simulated seconds per wall second), when it
   * falls short of `speed` — or null while the run keeps up.
   */
  behind(wall, speed) {
    if (wall - this.#lastDrop > BEHIND_WINDOW_MS) return null;
    const first = this.#samples[0];
    const last = this.#samples.at(-1);
    if (!first || last.wall - first.wall < FRAME_MS) return null;
    const achieved = ((last.sim - first.sim) * 1000) / (last.wall - first.wall);
    return achieved < speed * BEHIND_SHARE ? achieved : null;
  }
}
