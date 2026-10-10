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

// scene-builder.js — what one build of the 3D scene collects, and the heights
// everything stands at. The models (board-model.js, part-models.js,
// wire-model.js) all write into one SceneBuilder:
//
//   · `mesh`    — the STATIC geometry: every board, body, leg and wire, merged
//                 into one buffer the renderer draws in one call.
//   · `lamps`   — the geometry whose colour the SIMULATION decides (an LED's
//                 lens, a display segment, a clock's lamp, a transistor's),
//                 each its own small mesh drawn with a colour the view picks
//                 per sim-state — so a tick recolours, it never rebuilds.
//   · `labels`  — printed text (a chip's part number, a supply's voltage) as
//                 a rectangle the renderer fills with the text.
//   · `screens` — an LCD module's glass, which the renderer paints from the
//                 running module's framebuffer.
//   · `plumes`  — where each part's smoke would rise from: the top of its
//                 own geometry, so a part the simulation burns can smoke in
//                 3D as it does on the desk (scene3d/smoke.js).
//
// Everything is in WORLD coordinates (pitch units; x = desk x, z = desk y,
// y up — scene3d/mat4.js). The top face of a breadboard is y = 0.

import { MeshBuilder } from "./mesh.js";

/** A breadboard's thickness: 8.5 mm of plastic, so the desk is below it. */
export const BOARD_THICKNESS = 3.35;

/** The desk's surface — where the boards and the bench bricks stand. */
export const DESK_Y = -BOARD_THICKNESS;

/** How far a lead shows going down into its hole before it disappears. */
export const HOLE_DEPTH = 0.4;

/** A component lead's radius (~0.3 mm wire). */
export const LEAD_RADIUS = 0.06;

/** A jumper wire's radius (22 AWG solid core, insulation included). */
export const WIRE_RADIUS = 0.12;

/** A bench brick's (PSU / clock) body height, and its binding posts'. */
export const BRICK_HEIGHT = 3.2;
export const POST_HEIGHT = 1.1;

/** The top of a brick's binding post — where a wire to its terminal ends. */
export const TERMINAL_Y = DESK_Y + BRICK_HEIGHT + POST_HEIGHT;

/** The world-space directions a label is written along on a top face: left
    to right along +x, its top toward −z (up the desk), so it reads the same
    way the desk's own printing does from the default camera. */
export const ON_TOP = Object.freeze({
  right: Object.freeze([1, 0, 0]),
  up: Object.freeze([0, 0, -1]),
});

/** …and on a face looking toward the viewer (+z). */
export const ON_FRONT = Object.freeze({
  right: Object.freeze([1, 0, 0]),
  up: Object.freeze([0, 1, 0]),
});

/** What the four lamp kinds are lit by (the view's apply step reads it). */
export const LAMP_KINDS = Object.freeze(["led", "segment", "clock", "channel"]);

/** A smoke plume's puff radius is this share of its part's narrower side,
    within these bounds — a chip's column broader than an LED's, as the
    desk's burn overlays are sized. */
const PLUME_SHARE = 0.28;
const PLUME_MIN = 0.3;
const PLUME_MAX = 1;

export class SceneBuilder {
  /** @param {object} palette - scene3d/palette.js's readPalette() */
  constructor(palette) {
    this.palette = palette;
    this.mesh = new MeshBuilder();
    this.lampList = [];
    this.labelList = [];
    this.screenList = [];
    this.plumeList = [];
    /** Component id → the model kind that drew it (tests ask; nothing else). */
    this.modelled = new Map();
  }

  /**
   * Start a lamp: geometry whose colour the simulation picks.
   * A round lamp may carry a `halo` — the glow a lit one throws, centred on
   * `center`, `radius` across at full brightness (the desk's drop-shadow).
   * @param {{kind: string, compId: string, seg?: string|null,
   *   on: number[], off: number[], burnt?: number[],
   *   halo?: {center: number[], radius: number}|null}} spec
   * @returns {MeshBuilder} the builder to put the lamp's shape into
   */
  lamp({ kind, compId, seg = null, on, off, burnt, halo = null }) {
    const mb = new MeshBuilder();
    this.lampList.push({
      kind,
      compId,
      seg,
      on,
      off,
      burnt: burnt ?? this.palette.smoke,
      halo,
      mb,
    });
    return mb;
  }

  /** Where the geometry stands before a part is built — `plume`'s argument,
      and `rewind`'s. */
  mark() {
    return {
      vertex: this.mesh.vertexCount,
      lamp: this.lampList.length,
      label: this.labelList.length,
      screen: this.screenList.length,
      plume: this.plumeList.length,
    };
  }

  /** Take back everything built since `mark` — a part whose model threw is
      left out WHOLE, never half-drawn. */
  rewind(mark) {
    this.mesh.truncate(mark.vertex);
    this.lampList.length = mark.lamp;
    this.labelList.length = mark.label;
    this.screenList.length = mark.screen;
    this.plumeList.length = mark.plume;
  }

  /**
   * Record where component `compId`'s smoke rises from: the top centre of
   * everything drawn for it since `mark` (body and lamps alike), the puffs
   * sized off its narrower side. Nothing drawn, no plume.
   */
  plume(compId, mark) {
    let box = this.mesh.boundsSince(mark.vertex);
    for (const lamp of this.lampList.slice(mark.lamp)) {
      box = unionBounds(box, lamp.mb.bounds);
    }
    if (!box) return;
    const narrow = Math.min(box.max[0] - box.min[0], box.max[2] - box.min[2]);
    this.plumeList.push({
      compId,
      base: [
        (box.min[0] + box.max[0]) / 2,
        box.max[1],
        (box.min[2] + box.max[2]) / 2,
      ],
      radius: Math.min(PLUME_MAX, Math.max(PLUME_MIN, narrow * PLUME_SHARE)),
    });
  }

  /**
   * Print `text` on a face: a rectangle centred on `center`, written along the
   * unit `right` with its top toward the unit `up`, `height` tall and no wider
   * than `maxWidth` (the renderer shrinks it to fit rather than overflow).
   * `align: "left"` puts `center` at the middle of the text's LEFT edge
   * instead — for desk annotations, which read from where they were put.
   */
  label({
    text,
    center,
    right = ON_TOP.right,
    up = ON_TOP.up,
    height = 0.6,
    maxWidth = Infinity,
    color,
    font = "sans",
    align = "center",
    weight = 600,
  }) {
    if (typeof text !== "string" || !text) return;
    this.labelList.push({
      text,
      center,
      right: [...right],
      up: [...up],
      height,
      maxWidth,
      color: color ?? this.palette.chipLabel,
      font,
      align,
      weight,
    });
  }

  /**
   * An LCD's glass: four corners (top-left, top-right, bottom-right,
   * bottom-left as the text reads) and the character grid painted on it.
   */
  screen(spec) {
    this.screenList.push(spec);
  }

  /** A lead or leg along `points`, in the tinned-lead colour. */
  lead(points, radius = LEAD_RADIUS) {
    this.mesh.tube(points, radius, this.palette.chipLeg, { sides: 5 });
  }

  /**
   * The finished scene.
   * @returns {{mesh: object, lamps: object[], labels: object[],
   *   screens: object[], plumes: object[], bounds: object|null}}
   */
  result() {
    const lamps = this.lampList.map(({ mb, ...rest }) => ({
      ...rest,
      mesh: mb.build(),
    }));
    let bounds = this.mesh.bounds;
    for (const lamp of lamps) bounds = unionBounds(bounds, lamp.mesh.bounds);
    return {
      mesh: this.mesh.build(),
      lamps,
      labels: this.labelList,
      screens: this.screenList,
      plumes: this.plumeList,
      bounds,
    };
  }
}

/** The smallest box holding both (either may be null). */
export function unionBounds(a, b) {
  if (!a) return b ? { min: [...b.min], max: [...b.max] } : null;
  if (!b) return { min: [...a.min], max: [...a.max] };
  return {
    min: a.min.map((v, i) => Math.min(v, b.min[i])),
    max: a.max.map((v, i) => Math.max(v, b.max[i])),
  };
}
