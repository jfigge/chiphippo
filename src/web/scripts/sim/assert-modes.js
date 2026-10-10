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

// assert-modes.js — the engines' ASSERTION MODES (features/spice-perf,
// MASTER.md ground rule 5): each optimization that skips work the engine used
// to do has a mode that does the work anyway, beside it, and throws when the
// two disagree. Read once from the environment; tests and the bench only —
// the renderer has no `process`, so in the app every mode is off.

const env = globalThis.process?.env ?? {};

/** Every reuse of a per-tick cache (a context under hooks, Spice Lite's
    analysis, listeners and plan) checked against the same computed afresh
    (features/09-cache-tick-analysis.md). */
export const ASSERT_ANALYSIS = Boolean(env.SPICE_ASSERT_ANALYSIS);

/** Every replay settle a quiet tick skips run anyway, and held to changing
    nothing in one pass (features/05-skip-replay-settle.md). */
export const ASSERT_REPLAY = Boolean(env.SPICE_ASSERT_REPLAY);

/** Every outputs-hook call the sparse walk skips made anyway, and held to
    changing nothing (features/06-sparse-outputs-hook.md). */
export const ASSERT_OUTPUTS = Boolean(env.SPICE_ASSERT_OUTPUTS);

/** Every pass the levels hook is applied as a delta, the whole map held to
    what the hook shows on top of the pass's resolution
    (features/07-delta-level-maps.md). */
export const ASSERT_DELTA = Boolean(env.SPICE_ASSERT_DELTA);

/** A tick's first settle started warm from the last tick's work: every chip
    the invalidation rule leaves clean evaluated anyway, every driver rebuilt,
    and held to the cache (features/08-warm-incremental-cache.md). */
export const ASSERT_WARM = Boolean(env.SPICE_ASSERT_WARM);

/** Every tick's first settle started cold, as before 08 (debugging). */
export const COLD_SETTLE = Boolean(env.SPICE_COLD_SETTLE);

/** Every island ticked at every tick, as before 12 (the reference
    features/12-island-scheduling.md compares with). */
export const UNSCOPED = Boolean(env.SPICE_UNSCOPED);
