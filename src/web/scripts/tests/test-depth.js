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

// test-depth.js — how thorough this run is.
//
// `make test` is the COMPLETE run, and nothing here changes it. `make
// test-fast` sets CHIPHIPPO_TEST_FAST=1 for a quick confirmation: every test
// file still runs, and the few whose cost is a CORPUS run an evenly spread
// sample of it. What a fast run leaves out it SKIPS — never drops — with a
// reason naming the complete run, so the summary counts it among the skips
// and a fast pass can never be mistaken for a full one.

/** Is this a fast run (`make test-fast`)? */
export const FAST = process.env.CHIPHIPPO_TEST_FAST === "1";

/** The skip reason for whatever a fast run leaves out. */
export const FAST_SKIP = "left out of the fast run — make test runs it";

/**
 * A corpus at this run's depth: every item on a complete run; on a fast one,
 * every `stride`-th of its SORTED items, the first included — sorted so the
 * sample never depends on the order a directory listing comes back in.
 * @template T
 * @param {readonly T[]} items
 * @param {number} stride
 * @returns {Set<T>}
 */
export function sampled(items, stride) {
  if (!FAST) return new Set(items);
  return new Set([...items].sort().filter((_, i) => i % stride === 0));
}
