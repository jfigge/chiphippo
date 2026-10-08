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

// board-model.js — a breadboard STRIP in 3D: the slab of plastic, its holes,
// the channel down a pin-board and the red/blue lines along a rail. Every
// position comes from model/breadboard.js (`holes`, `holePosition`,
// `rotatePoint`, `boardSize`) exactly as breadboard-view.js draws the desk,
// so a hole in 3D is the hole a part's pin resolves to — never a second
// statement of the lattice.

import {
  boardSize,
  holePosition,
  holes,
  rotatePoint,
  spec,
} from "../model/breadboard.js";
import { railStripes } from "../desk/rail-stripes.js";
import { roundedRect } from "./mesh.js";
import { BOARD_THICKNESS } from "./scene-builder.js";

/** Corner radius of a strip's plastic (breadboard-view.js's BODY_RADIUS). */
const BODY_RADIUS = 0.6;

/** A tie point's square, a little smaller than the desk draws it (0.44) so
    the plastic between neighbours still reads at a shallow angle. */
const HOLE_SIZE = 0.4;

/** Printing sits a hair above the face it is printed on, so the depth test
    never has to decide between the two. */
const INK = 0.004;

/**
 * Add one strip to the scene.
 * @param {import("./scene-builder.js").SceneBuilder} sb
 * @param {{id: string, type: string, x: number, y: number, rot?: number}} board
 */
export function buildBoard(sb, board) {
  let s;
  try {
    s = spec(board.type);
  } catch {
    return; // a junk board type draws nothing, as on the desk
  }
  const p = sb.palette;
  const rot = board.rot ?? 0;
  const { width, height } = boardSize(board.type, rot);
  const mesh = sb.mesh;

  // The slab, standing on the desk with its top at y 0.
  mesh.extrude(
    roundedRect(
      board.x,
      board.y,
      board.x + width,
      board.y + height,
      BODY_RADIUS,
      -BOARD_THICKNESS,
    ),
    [0, BOARD_THICKNESS, 0],
    { top: p.boardBody, side: p.boardEdge },
  );

  // A rectangle stated in the strip's OWN unrotated frame, laid on its top
  // face wherever the strip has been turned to.
  const rect = (x0, y0, x1, y1, color, lift = INK) => {
    const corners = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ].map(([x, y]) => {
      const r = rotatePoint(board.type, { x, y }, rot);
      return [board.x + r.x, lift, board.y + r.y];
    });
    mesh.quad(...corners, color);
  };

  if (s.trench) {
    rect(
      0,
      s.trench.centerY - s.trench.height / 2,
      s.width,
      s.trench.centerY + s.trench.height / 2,
      p.boardTrench,
    );
  }

  // The printed rail lines — the desk's own rects (desk/rail-stripes.js),
  // so a split rail's break is in the same place in both views.
  for (const st of railStripes(board.type)) {
    rect(st.x0, st.y0, st.x1, st.y1, st.polarity === "+" ? p.railPlus : p.railMinus); // prettier-ignore
  }

  // Every tie point. A quarter-turn maps a square onto itself, so the holes
  // stay axis-aligned at any angle and only their centres need turning —
  // holePosition already answers in the turned frame.
  const h = HOLE_SIZE / 2;
  for (const id of holes(board.type)) {
    const c = holePosition(board.type, id, rot);
    if (!c) continue;
    const x = board.x + c.x;
    const z = board.y + c.y;
    mesh.quad(
      [x - h, INK * 2, z - h],
      [x + h, INK * 2, z - h],
      [x + h, INK * 2, z + h],
      [x - h, INK * 2, z + h],
      p.boardHole,
    );
  }
}
