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
// statement of the lattice. A pin-board's underside carries a quiet credit
// line, printed in the board's own label colour.
//
// A VEROBOARD is the one board with an underside worth seeing: a thin sheet of
// substrate on stand-offs, its copper strips below it as runs of copper with
// REAL gaps where a strip is cut (desk/vero-copper.js — the rects the desk
// draws and the netlist agrees with), a hole through the copper at every hole,
// and solder where a lead or a wire is in one.

import {
  boardSize,
  holePosition,
  holes,
  rotatePoint,
  spec,
} from "../model/breadboard.js";
import { railStripes } from "../desk/rail-stripes.js";
import { veroCopper } from "../desk/vero-copper.js";
import { roundedRect } from "./mesh.js";
import { BOARD_THICKNESS, DESK_Y } from "./scene-builder.js";

/** Corner radius of a strip's plastic (breadboard-view.js's BODY_RADIUS). */
const BODY_RADIUS = 0.6;

/** A tie point's square, a little smaller than the desk draws it (0.44) so
    the plastic between neighbours still reads at a shallow angle. */
const HOLE_SIZE = 0.4;

/** Printing sits a hair above the face it is printed on, so the depth test
    never has to decide between the two. */
const INK = 0.004;

/** A veroboard's sheet: 1.6 mm of SRBP, in pitch units. */
export const VERO_THICKNESS = 0.63;

/** A veroboard hole, a 1 mm drill, drawn as a square this wide. */
const VERO_HOLE = 0.36;

/** A solder fillet under a lead: a little wider than the hole's copper. */
const SOLDER_RADIUS = 0.3;

/** The stand-offs a veroboard rests on (it is far thinner than the plastic a
    breadboard is): this square, this far in from each corner. */
const STANDOFF = 0.5;
const STANDOFF_INSET = 1.2;

/** The credit printed on a breadboard's underside (each pin-board's) —
    identity, like the product name, so never translated. */
export const BOARD_ATTRIBUTION = "Designed by Jason, coded by Claud";

/**
 * Add one strip to the scene.
 * @param {import("./scene-builder.js").SceneBuilder} sb
 * @param {{id: string, type: string, x: number, y: number, rot?: number}} board
 * @param {{soldered?: Set<string>}} [opts] - a veroboard's holes with a lead
 *   or a wire in them (scene.js works them out)
 */
export function buildBoard(sb, board, { soldered } = {}) {
  let s;
  try {
    s = spec(board.type);
  } catch {
    return; // a junk board type draws nothing, as on the desk
  }
  if (s.kind === "vero") {
    buildVeroBoard(sb, board, s, soldered ?? new Set());
    return;
  }
  if (s.kind === "pins") printCredit(sb, board, s);
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

/**
 * The credit, under a pin-board: on the plastic's bottom face (the desk's
 * level), along the strip, its face looking down (−y) so it reads the right
 * way round from below — and so is never seen from above, where the board's
 * own top hides it. A pin-board never turns, so the strip's frame is the
 * desk's.
 */
function printCredit(sb, board, s) {
  sb.label({
    text: BOARD_ATTRIBUTION,
    center: [board.x + s.width / 2, -BOARD_THICKNESS - INK, board.y + s.height / 2], // prettier-ignore
    right: [1, 0, 0],
    up: [0, 0, 1],
    height: Math.min(1, s.width / 30),
    maxWidth: s.width * 0.8,
    color: sb.palette.boardLabel,
    weight: 400,
  });
}

/**
 * A veroboard: the sheet (its top at y 0, like every board's, standing on
 * four stand-offs), the holes through its top, and its underside — the copper
 * runs with the cuts as real gaps, every hole through the copper, and solder
 * at each hole in use.
 */
function buildVeroBoard(sb, board, s, soldered) {
  const p = sb.palette;
  const mesh = sb.mesh;
  const x0 = board.x;
  const z0 = board.y;
  const bottom = -VERO_THICKNESS;

  mesh.extrude(
    roundedRect(x0, z0, x0 + s.width, z0 + s.height, 0.15, bottom),
    [0, VERO_THICKNESS, 0],
    { top: p.veroSubstrate, side: p.veroEdge, bottom: p.veroSubstrate },
  );
  // Stand-offs: a board too small to hold four inset from its corners keeps
  // the ones it can (none, for a sliver) — it still floats true.
  if (
    s.width > 2 * STANDOFF_INSET + STANDOFF &&
    s.height > 2 * STANDOFF_INSET + STANDOFF
  ) {
    const h = STANDOFF / 2;
    for (const [cx, cz] of [
      [x0 + STANDOFF_INSET, z0 + STANDOFF_INSET],
      [x0 + s.width - STANDOFF_INSET, z0 + STANDOFF_INSET],
      [x0 + STANDOFF_INSET, z0 + s.height - STANDOFF_INSET],
      [x0 + s.width - STANDOFF_INSET, z0 + s.height - STANDOFF_INSET],
    ]) {
      mesh.box(
        [cx - h, DESK_Y, cz - h],
        [cx + h, bottom, cz + h],
        p.partAccent,
      );
    }
  }

  // A rect in the board's frame on a horizontal face at height `y`.
  const flat = (ax, az, bx, bz, y, color) =>
    mesh.quad(
      [x0 + ax, y, z0 + az],
      [x0 + bx, y, z0 + az],
      [x0 + bx, y, z0 + bz],
      [x0 + ax, y, z0 + bz],
      color,
    );

  // The copper, under the sheet: each run its own rect, so a cut is a gap
  // with no copper in it at all — not a mark drawn on a whole strip.
  const under = bottom - INK;
  const { rects } = veroCopper(board.type, board.cuts);
  for (const r of rects) flat(r.x0, r.y0, r.x1, r.y1, under, p.veroCopper);

  // Every hole, top and bottom — through the copper below — and the solder
  // under each one a lead or a wire is in.
  const h = VERO_HOLE / 2;
  for (const id of holes(board.type)) {
    const c = holePosition(board.type, id);
    flat(c.x - h, c.y - h, c.x + h, c.y + h, INK * 2, p.boardHole);
    if (soldered.has(id)) {
      mesh.disc(
        [x0 + c.x, under - INK * 2, z0 + c.y],
        [0, -1, 0],
        SOLDER_RADIUS,
        p.chipLeg,
        10,
      );
    } else {
      flat(c.x - h, c.y - h, c.x + h, c.y + h, under - INK, p.boardHole);
    }
  }
}
