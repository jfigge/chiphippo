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

// smoke.js — the 3D view's smoke: where each puff of a burning part's plume
// is at a moment in time. Pure arithmetic, so a test can hold it; the view
// asks for the puffs each frame and the renderer draws them as soft discs.
//
// It is the desk's plume (styles/app.css `part-burn-smoke`) stood up: the
// same 2.4 s cycle, the same staggered puffs, nearly opaque at the base and
// slow to climb, then swelling and fading as they rise — so the two views
// smoke alike. With reduced motion asked for, the plume holds still, as the
// desk's does.

/** One puff's rise from the part's top to gone, seconds (the desk's). */
export const PUFF_CYCLE_S = 2.4;

/** Puffs per plume, spread evenly over the cycle — more than the desk's
    four, so a column seen from any side reads as one plume, not beads. */
const PUFFS = 7;

/** Each puff's sideways offset, as a share of the plume's radius — the
    desk's staggered column, swaying both ways across the desk. */
const SWAY = Object.freeze([
  [-0.3, 0.1],
  [0.18, -0.2],
  [-0.08, 0.26],
  [0.26, 0.08],
  [0.02, -0.12],
  [-0.22, -0.16],
  [0.12, 0.22],
]);

/** How high a puff climbs over its cycle, in plume radii. */
const RISE = 5.5;

/** A puff's size over its cycle: from this share of the radius to RISE's
    top at GROW times it (the desk's scale 0.4 → 1.7). */
const BORN = 0.55;
const GROW = 2.2;

/**
 * How opaque a puff is at phase `p` (0…1 through its cycle): the desk's
 * keyframes — clear, 0.95 by 18 %, 0.85 at 45 %, clear again at the top.
 * @param {number} p
 */
export function puffOpacity(p) {
  if (p <= 0 || p >= 1) return 0;
  if (p < 0.18) return (0.95 * p) / 0.18;
  if (p < 0.45) return 0.95 - (0.1 * (p - 0.18)) / 0.27;
  return 0.85 * (1 - (p - 0.45) / 0.55);
}

/**
 * Every puff of one plume at time `t`.
 * @param {{base: number[], radius: number}} plume - scene-builder's plume
 * @param {number} t - seconds (any clock; only its fractional cycles matter)
 * @param {{still?: boolean}} [opts] - still: reduced motion — a fixed column
 * @returns {Array<{center: number[], radius: number, alpha: number}>}
 */
export function plumePuffs(plume, t, { still = false } = {}) {
  const { base, radius: r } = plume;
  const puffs = [];
  for (let i = 0; i < PUFFS; i++) {
    // Still, each puff holds the phase it has at t = 0 — a column of them,
    // fading upward — at the desk's reduced-motion 0.7.
    const phase = still
      ? (i + 0.5) / PUFFS
      : (((t / PUFF_CYCLE_S + i / PUFFS) % 1) + 1) % 1;
    // Ease out: quick off the part, slowing as it thins (the desk's ease-out).
    const climb = 1 - (1 - phase) * (1 - phase);
    const [sx, sz] = SWAY[i % SWAY.length];
    // The sway grows as the puff climbs: a plume leans, it does not stack.
    const spread = r * (0.35 + climb);
    puffs.push({
      center: [
        base[0] + sx * spread,
        base[1] + r * (0.3 + RISE * climb),
        base[2] + sz * spread,
      ],
      radius: r * (BORN + (GROW - BORN) * climb),
      alpha: still ? 0.7 * (1 - phase * 0.8) : puffOpacity(phase),
    });
  }
  return puffs;
}
