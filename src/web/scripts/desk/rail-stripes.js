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

// rail-stripes.js — where a rail strip's printed red/blue lines run, in the
// strip's own unrotated frame. Pure, DOM-free: the desk (breadboard-view.js)
// and the 3D view (scene3d/board-model.js) both draw exactly these rects, so
// the two can never disagree about a stripe — least of all about where a split
// rail's stripe breaks, which is the only thing telling its halves apart.

import { holePosition, railSegments, spec } from "../model/breadboard.js";

/** Stripe thickness, how far it overhangs a rail's END holes, and how far its
    outer edge sits from the strip's own edge. Pinned to the EDGE rather than
    offset from the hole row, because that is where the printed line runs on
    the real part — and because the plastic outside a rail's rows is 3.2 mm of
    it (board-types.js measures the strip at 8.9 mm), so a stripe hung off the
    row would float in the middle of it. */
export const STRIPE_HEIGHT = 0.22;
export const STRIPE_OVERHANG = 0.7;
export const STRIPE_EDGE_GAP = 0.32;

/** How far a stripe runs past the hole either side of a SPLIT — short of the
    end overhang, so the break reads as one: with holes 25 and 26 two pitches
    apart it leaves 1.4 pitch of bare plastic, as printed on split boards. */
export const STRIPE_CUT_OVERHANG = 0.3;

/**
 * One rect per rail SEGMENT (`railSegments`): `{polarity, x0, y0, x1, y1}`.
 * A continuous rail gets one stripe end to end; a split rail two, broken
 * between its halves. Each hugs the strip edge its own row faces (read off
 * the row's y, so a strip listing its rails the other way round still prints
 * them outermost-first rather than crossing them over the holes).
 */
export function railStripes(type) {
  const s = spec(type);
  const out = [];
  for (const seg of railSegments(type)) {
    const rail = s.rails.find((r) => r.id === seg.railId);
    const first = holePosition(type, `${seg.railId}${seg.first}`);
    const last = holePosition(type, `${seg.railId}${seg.last}`);
    const y0 =
      rail.y < s.height / 2
        ? STRIPE_EDGE_GAP
        : s.height - STRIPE_EDGE_GAP - STRIPE_HEIGHT;
    const lead = seg.first === 1 ? STRIPE_OVERHANG : STRIPE_CUT_OVERHANG;
    const tail = seg.last === s.railHoles ? STRIPE_OVERHANG : STRIPE_CUT_OVERHANG; // prettier-ignore
    out.push({
      polarity: seg.polarity,
      x0: first.x - lead,
      y0,
      x1: last.x + tail,
      y1: y0 + STRIPE_HEIGHT,
    });
  }
  return out;
}
