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

// schedule.js — WHEN the board next changes on its own, in SIMULATED seconds
// (features/done/batched-ticks.md). The free-running clocks' edges and the timed
// parts' `wakeAt` are one queue: SimController asks for the earliest event,
// runs its tick at exactly that moment, and asks again — as many times as a
// batch has time for — before the views hear about any of it.
//
// A clock's edges are counted, never accumulated: its n-th edge after
// `origin` falls at `origin + n·half`, so a thousand edges in, a 100 Hz and a
// 250 Hz clock still land together where the arithmetic says they do. Edges
// that coincide (within COINCIDENT_S) are ONE event and one tick, every clock
// in it flipped together — the same rule Step has always followed, and what
// the engine's two-phase tick is built for (all edges observed at once).
//
// Pure: no timers, no wall clock. The speed multiplier scales the SIM clock
// that reads this, never the schedule itself.

/** Two moments this close are the same instant (seconds). */
export const COINCIDENT_S = 1e-9;

/** A clock's half-period, in simulated seconds. */
export const halfPeriodOf = (hz) => 1 / (2 * hz);

export class EdgeSchedule {
  #clocks = new Map(); // clockId → { half, origin, n }

  /**
   * Run a clock at `half` seconds per edge, its first edge one half-period
   * after `now` — or `elapsed` sooner, for one resuming part-way through a
   * half (a Spice Lite wave keeps its place). A clock already running at that
   * rate is left alone (its phase kept); a new or re-rated one starts afresh.
   * @returns {boolean} whether the clock was (re)started
   */
  set(id, half, now, elapsed = 0) {
    if (this.#clocks.get(id)?.half === half) return false;
    this.#clocks.set(id, { half, origin: now - elapsed, n: 1 });
    return true;
  }

  /** Stop scheduling a clock (paused on its own, deleted, gone manual). */
  delete(id) {
    return this.#clocks.delete(id);
  }

  clear() {
    this.#clocks.clear();
  }

  has(id) {
    return this.#clocks.has(id);
  }

  /** The clocks scheduled, each with its half-period — for tests and the
      rate the desk shows. */
  get halves() {
    return new Map([...this.#clocks].map(([id, c]) => [id, c.half]));
  }

  /**
   * The earliest thing due: `{at, clocks}` — the moment, and the clocks that
   * flip at it (empty when it is only a timed part's wake) — or null when
   * nothing is scheduled at all.
   * @param {number|null} wakeAt - when a timed part next changes, or null
   */
  next(wakeAt = null) {
    let at = wakeAt ?? Infinity;
    for (const c of this.#clocks.values()) {
      at = Math.min(at, c.origin + c.n * c.half);
    }
    if (at === Infinity) return null;
    const clocks = [];
    for (const [id, c] of this.#clocks) {
      if (c.origin + c.n * c.half - at <= COINCIDENT_S) clocks.push(id);
    }
    return { at, clocks };
  }

  /** Every clock as plain data (a run handed to another thread). */
  export() {
    return [...this.#clocks].map(([id, c]) => ({ id, ...c }));
  }

  /** Clocks exactly as `export` gave them, `shift` seconds later in sim
      time (none: the sim clock is the same one). */
  import(list, shift = 0) {
    this.#clocks.clear();
    for (const { id, half, origin, n } of list) {
      this.#clocks.set(id, { half, origin: origin + shift, n });
    }
  }

  /** The event's clocks have flipped: each one's next edge, please. */
  consume(clockIds) {
    for (const id of clockIds) {
      const c = this.#clocks.get(id);
      if (c) c.n += 1;
    }
  }
}
