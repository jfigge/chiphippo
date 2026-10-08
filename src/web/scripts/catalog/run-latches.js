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

// run-latches.js — the params a RUN writes into the document and nothing
// else may keep. Pure and DOM-free.
//
// The engine is a pure function of the document, so a chip that let its smoke
// out at one tick can only stay dead at the next if the document says so:
// SimController latches it into the component's params (`#persistDamage`).
// Two latches exist — 12 V's magic smoke (`damaged`) and Spice Lite's brown
// smoke (`overloaded`, an output driven past twice its budget) — and they
// share one lifecycle: every part that can be latched KEEPS them through its
// normalizer (or the next tick's write is dropped and the latch never holds),
// Stop clears them, and every road a part takes INTO a desk — a load, a paste,
// a duplicate, a design clip — strips them, since a fresh part is never
// pre-damaged. This is the one list both halves read, so a third latch is one
// line here rather than another place left keeping or carrying it.

/** The run-volatile latches, by param key. */
export const RUN_LATCHES = Object.freeze(["damaged", "overloaded"]);

/**
 * Carry the latches `raw` holds onto a normalizer's `params` (each only
 * when exactly true). Returns `params`.
 * @param {object|null|undefined} raw
 * @param {object} params
 */
export function keepRunLatches(raw, params) {
  for (const key of RUN_LATCHES) if (raw?.[key] === true) params[key] = true;
  return params;
}

/**
 * Strip every latch from `params` in place — a part arriving on a desk.
 * Returns `params`.
 * @param {object} params
 */
export function dropRunLatches(params) {
  for (const key of RUN_LATCHES) delete params[key];
  return params;
}
