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

// bounce.js — a mechanical switch's contact bounce (Settings ▸ Spice Lite ▸
// Switch bounce). Pure and DOM-free; SimController owns the timing.
//
// A contact that CLOSES does not close once: the actuator travels, the
// contact touches, springs off and touches again, a few times over a couple
// of milliseconds, before it rests closed — which is why a push button
// clocking a counter on a real bench skips counts, and why a debouncer (an
// RC into a Schmitt input, an SPDT switch into an S-R latch) exists. A
// contact that OPENS is taken to open cleanly: a slide switch's old throw
// never re-makes as its new one bounces (the SPDT latch debouncer works
// because of exactly that).
//
// So a switch whose contacts changed is, for a little while, a switch with
// only the contacts BOTH positions share (`gapContacts`) — at the times its
// bounce says (`bounceGaps`) — and otherwise the switch as it now stands.
// The times are drawn per press from a seeded generator, so a run is the
// same run every time; the shape is the usual tactile switch's: a travel
// gap, then three to six touches, the open gaps shrinking as the closed
// ones lengthen, all within about 3 ms.

import { partDef } from "../catalog/index.js";

/** The longest a bounce lasts from the actuator moving, seconds. */
export const BOUNCE_MAX_S = 3e-3;

/** A part's contacts as keys a set compares: each pin pair, lower pin
    first. */
export function contactKeys(bridges) {
  return new Set(
    (bridges ?? []).map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`)),
  );
}

/** Whether two contact sets differ. */
export function contactsDiffer(a, b) {
  if (a.size !== b.size) return true;
  for (const k of a) if (!b.has(k)) return true;
  return false;
}

/** The contacts a bouncing switch keeps through its gaps: those closed in
    both positions — every contact that is closing is open. */
export function gapContacts(before, after) {
  return (after ?? []).filter(([a, b]) => {
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    return contactKeys(before).has(k);
  });
}

/** Whether any contact closes on the way from `before` to `after` (an
    opening alone is clean: nothing to bounce). */
export function closesContact(before, after) {
  const was = contactKeys(before);
  for (const k of contactKeys(after)) if (!was.has(k)) return true;
  return false;
}

/** A small seeded generator (mulberry32): [0, 1). */
function generator(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A string's seed (FNV-1a). */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * One bounce: the intervals, seconds from the actuator moving, during which
 * the closing contacts are open — `[[start, end], …]`, in order, the first
 * from 0 (its travel), every one ended by BOUNCE_MAX_S. `key` names the
 * press (a part and how many times it has moved), so the same press bounces
 * the same way.
 * @param {string} key
 * @returns {Array<[number, number]>}
 */
export function bounceIntervals(key) {
  const rand = generator(hash(key));
  const between = (lo, hi) => lo + (hi - lo) * rand();
  const out = [];
  // The travel before the first touch.
  let t = between(0.15e-3, 0.4e-3);
  out.push([0, t]);
  const touches = 3 + Math.floor(rand() * 4);
  for (let k = 0; k < touches; k++) {
    // Each touch lasts longer and each spring-off is shorter than the last.
    const f = (k + 1) / touches;
    t += between(0.05e-3, 0.15e-3) + f * between(0.1e-3, 0.35e-3);
    const gap = between(0.02e-3, 0.12e-3) * (1 - 0.6 * f);
    if (t + gap >= BOUNCE_MAX_S) break;
    out.push([t, t + gap]);
    t += gap;
  }
  return out;
}

/**
 * The switches open in a gap at `at`: compId → the contacts they keep then.
 * @param {Map<string, {t0: number, gaps: Array<[number, number]>,
 *   contacts: Array<[number, number]>}>} bounces
 * @param {number} at - seconds
 * @returns {Map<string, Array<[number, number]>>}
 */
export function bounceGaps(bounces, at) {
  const out = new Map();
  for (const [id, b] of bounces) {
    const d = at - b.t0;
    if (b.gaps.some(([s, e]) => d >= s - 1e-12 && d < e - 1e-12)) {
      out.set(id, b.contacts);
    }
  }
  return out;
}

/** The next moment after `after` a bouncing switch makes or breaks, or
    null. */
export function nextBounceAt(bounces, after) {
  let next = Number.POSITIVE_INFINITY;
  for (const b of bounces.values()) {
    for (const [s, e] of b.gaps) {
      for (const edge of [b.t0 + s, b.t0 + e]) {
        if (edge > after + 1e-12 && edge < next) next = edge;
      }
    }
  }
  return Number.isFinite(next) ? next : null;
}

/** The bounces still under way at `at` (the rest are over). */
export function liveBounces(bounces, at) {
  const out = new Map();
  for (const [id, b] of bounces) {
    const end = b.t0 + Math.max(...b.gaps.map(([, e]) => e));
    if (end > at + 1e-12) out.set(id, b);
  }
  return out;
}

/**
 * A run's switches and their bounces: what each mechanical switch's contacts
 * were when last looked at, and every bounce still under way. SimController
 * holds one per run and asks it at each tick.
 */
export class ContactBounce {
  #contacts = new Map(); // compId → its contacts (pin pairs) when last seen
  #moves = new Map(); // compId → how many times it has moved (the seed)
  #bounces = new Map(); // compId → {t0, gaps, contacts}

  /** Forget everything (a Run, a Stop). */
  reset() {
    this.#contacts.clear();
    this.#moves.clear();
    this.#bounces.clear();
  }

  /** Whether any bounce is under way. */
  get active() {
    return this.#bounces.size > 0;
  }

  /** Every switch as last seen, its moves and its bounce, as plain data (a
      run handed to another thread). */
  export() {
    return { contacts: new Map(this.#contacts), moves: new Map(this.#moves), bounces: new Map(this.#bounces) }; // prettier-ignore
  }

  /** Switches exactly as `export` gave them — the sim clock is the same
      one, so a bounce under way carries on, and the next move's seed is the
      one an unbroken run would draw. */
  import(data) {
    this.#contacts = new Map(data?.contacts ?? []);
    this.#moves = new Map(data?.moves ?? []);
    this.#bounces = new Map(data?.bounces ?? []);
  }

  /**
   * Look at the switches as they now stand, at `at` seconds: a switch whose
   * contacts changed since it was last looked at — and closed one — starts
   * bouncing there (with `bounce` false it is only remembered). A switch
   * seen for the first time is only remembered.
   * @param {object} doc
   * @param {Map<string, object>} partStates - the netlist's (a held button)
   * @param {number} at
   * @param {boolean} bounce
   */
  watch(doc, partStates, at, bounce) {
    this.#bounces = liveBounces(this.#bounces, at);
    for (const comp of doc.components ?? []) {
      const def = partDef(comp.ref);
      if (!def?.contactBounce || typeof def.internalBridges !== "function") continue; // prettier-ignore
      const now = def.internalBridges(comp.params, partStates.get(comp.id)) ?? []; // prettier-ignore
      const was = this.#contacts.get(comp.id);
      this.#contacts.set(comp.id, now);
      if (!was || !contactsDiffer(contactKeys(was), contactKeys(now))) continue; // prettier-ignore
      const moves = (this.#moves.get(comp.id) ?? 0) + 1;
      this.#moves.set(comp.id, moves);
      if (!bounce || !closesContact(was, now)) {
        this.#bounces.delete(comp.id);
        continue;
      }
      this.#bounces.set(comp.id, {
        t0: at,
        gaps: bounceIntervals(`${comp.id}#${moves}`),
        contacts: gapContacts(was, now),
      });
    }
  }

  /** The switches open in a gap at `at`: compId → the contacts they keep. */
  gapsAt(at) {
    return bounceGaps(this.#bounces, at);
  }

  /** The next moment after `after` a bouncing contact makes or breaks, or
      null. */
  nextAt(after) {
    return nextBounceAt(this.#bounces, after);
  }
}
