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

// vero-copper.js — where a veroboard's copper lies, in the board's own frame.
// Pure, DOM-free: the desk (breadboard-view.js, seen through the board) and the
// 3D view's underside (scene3d/board-model.js) both draw exactly these rects,
// so a cut is the same gap in the copper in both — and it is the gap the
// netlist sees, because the runs are breadboard.js `veroRuns`, the statement
// `nodeOf` is made from.

import {
  holePosition,
  spec,
  veroHoleAt,
  veroRuns,
} from "../model/breadboard.js";

/** A strip's width (pitch units): 2 mm of copper on the 2.54 mm pitch, the
    usual figure, so a hairline of board shows between neighbours. */
export const COPPER_WIDTH = 0.78;

/** How far the copper is cleared each side of a cut hole's centre: a 3 mm
    spot-face cutter takes a ring 1.2 pitch across, so the strip either side
    stops 0.4 pitch past its last hole. */
export const CUT_CLEAR = 0.6;

/** How far an uncut strip end stops short of the board's edge. */
export const COPPER_EDGE_INSET = 0.1;

/**
 * Every run of copper as a rect `{strip, first, last, x0, y0, x1, y1}`, and
 * every cut as `{strip, index, x, y}` — the hole's centre.
 */
export function veroCopper(type, cuts) {
  const s = spec(type);
  const { runs, cuts: cutHoles } = veroRuns(type, cuts);
  const centre = (strip, index) =>
    holePosition(type, veroHoleAt(type, strip, index));
  const rects = runs.map(({ strip, first, last }) => {
    const top = centre(strip, first);
    const bottom = centre(strip, last);
    return {
      strip,
      first,
      last,
      x0: top.x - COPPER_WIDTH / 2,
      x1: top.x + COPPER_WIDTH / 2,
      y0: first === 1 ? COPPER_EDGE_INSET : top.y - 1 + CUT_CLEAR,
      y1: last === s.rows ? s.height - COPPER_EDGE_INSET : bottom.y + 1 - CUT_CLEAR, // prettier-ignore
    };
  });
  const marks = cutHoles.map(({ strip, index }) => ({
    strip,
    index,
    ...centre(strip, index),
  }));
  return { rects, cuts: marks };
}
