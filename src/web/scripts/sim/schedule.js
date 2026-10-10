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
// 250 Hz clock still land together where the arithmetic says they do. A PWM
// clock's two halves differ — HIGH for its pulse width, LOW for the rest —
// and alternate from the one it stood in at `origin`, so its n-th edge is
// ⌈n/2⌉ of that half and ⌊n/2⌋ of the other, still counted. Edges
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

/** How long a clock spends LOW and HIGH each period, in simulated seconds:
    `duty` of it HIGH (a PWM's pulse width, 0–1). At ½ both are exactly
    `halfPeriodOf` — the square, to the bit. */
export function clockHalves(hz, duty = 0.5) {
  if (duty === 0.5) {
    const half = halfPeriodOf(hz);
    return { low: half, high: half };
  }
  return { low: (1 - duty) / hz, high: duty / hz };
}

/** A clock's edge `n` after its origin: the square's `n·half`, or for two
    halves alternating from `half`, ⌈n/2⌉ of it and ⌊n/2⌋ of `next`. */
const edgeAt = (c) =>
  c.next == null
    ? c.origin + c.n * c.half
    : c.origin + Math.ceil(c.n / 2) * c.half + Math.floor(c.n / 2) * c.next;

/** The half a clock stands in now (before edge `n`) and the one after it. */
const halvesNow = (c) => {
  const other = c.next ?? c.half;
  return c.n % 2 === 1 ? [c.half, other] : [other, c.half];
};

export class EdgeSchedule {
  #clocks = new Map(); // clockId → { half, next?, origin, n }

  /**
   * Run a clock at `halves` seconds per edge — one number for a square, or
   * `[present, next]` for a PWM: the half it stands in now, then the other
   * — its first edge one present half after `now`, or `elapsed` sooner, for
   * one resuming part-way through a half (a Spice Lite wave keeps its place;
   * a PWM whose pulse width moved, its edge). A clock already running at
   * those halves is left alone (its phase kept); a new or re-rated one
   * starts afresh.
   * @param {string} id
   * @param {number|number[]} halves
   * @param {number} now
   * @param {number} [elapsed]
   * @returns {boolean} whether the clock was (re)started
   */
  set(id, halves, now, elapsed = 0) {
    const [half, next] = Array.isArray(halves) ? halves : [halves, halves];
    const had = this.#clocks.get(id);
    if (had) {
      const [present, after] = halvesNow(had);
      if (present === half && after === next) return false;
    }
    this.#clocks.set(id, {
      half,
      ...(next !== half ? { next } : {}),
      origin: now - elapsed,
      n: 1,
    });
    return true;
  }

  /** A clock's whole period as scheduled (its two halves), or null. */
  periodOf(id) {
    const c = this.#clocks.get(id);
    return c ? c.half + (c.next ?? c.half) : null;
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
      at = Math.min(at, edgeAt(c));
    }
    if (at === Infinity) return null;
    const clocks = [];
    for (const [id, c] of this.#clocks) {
      if (edgeAt(c) - at <= COINCIDENT_S) clocks.push(id);
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
    for (const { id, half, next, origin, n } of list) {
      this.#clocks.set(id, {
        half,
        ...(next != null ? { next } : {}),
        origin: origin + shift,
        n,
      });
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
