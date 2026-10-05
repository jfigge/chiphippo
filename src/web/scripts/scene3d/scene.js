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

// scene.js — the 3D view's one entry point into geometry: a desk DOCUMENT in,
// everything the renderer draws out. It is a PROJECTION, exactly as the
// schematic is (Feature 150): the document stays the single source of truth,
// nothing here is stored, and the whole scene is rebuilt from scratch on a
// document change (a desk is small; a rebuild is simple and correct).
//
// The live simulation never rebuilds it. A sim-state only decides which of
// the scene's LAMPS are lit (`lampState`), and the renderer recolours them.

import { H } from "../sim/levels.js";
import { buildAnnotation } from "./annotation-model.js";
import { buildBoard } from "./board-model.js";
import { MeshBuilder } from "./mesh.js";
import { mix } from "./palette.js";
import { buildPart } from "./part-models.js";
import { DESK_Y, SceneBuilder } from "./scene-builder.js";
import { buildBus, buildFlag, buildWire } from "./wire-model.js";

/**
 * Build the scene for one desk document.
 * @param {{boards: object[], components: object[], wires: object[],
 *   buses?: object[], signals?: object[], integrations?: object[],
 *   annotations?: object[]}} doc
 * @param {object} palette - scene3d/palette.js's readPalette()
 * @returns {{mesh: object, lamps: object[], labels: object[],
 *   screens: object[], bounds: object|null, modelled: Map<string,string>,
 *   errors: Array<{id: string, error: Error}>}}
 */
export function buildScene(doc, palette) {
  const sb = new SceneBuilder(palette);
  const errors = [];
  // One part that cannot be modelled must not take the whole desk with it —
  // the 2D desk carries on past a part it cannot draw, and so does this. The
  // failure is REPORTED (`errors`), so a test sees it.
  const guarded = (id, fn) => {
    try {
      fn();
    } catch (error) {
      errors.push({ id, error });
    }
  };
  const boards = doc.boards ?? [];
  const view = {
    boards,
    components: doc.components ?? [],
  };
  for (const board of boards) guarded(board.id, () => buildBoard(sb, board));
  for (const comp of view.components) {
    guarded(comp.id, () => buildPart(sb, view, comp));
  }

  const wires = doc.wires ?? [];
  const buses = doc.buses ?? [];
  const wiresById = new Map(wires.map((w) => [w.id, w]));
  // A bus member belongs to its ribbon: it is never drawn as a loose jumper,
  // even when the ribbon could not place it (the desk's rule too).
  const members = new Set(buses.flatMap((b) => b.members));
  for (const bus of buses) {
    guarded(bus.id, () => buildBus(sb, view, bus, wiresById));
  }
  for (const wire of wires) {
    if (members.has(wire.id)) continue;
    guarded(wire.id, () => buildWire(sb, view, wire));
  }

  for (const sig of doc.signals ?? []) {
    if (!sig.flag?.anchor) continue;
    guarded(sig.id, () =>
      buildFlag(sb, view, sig.flag.anchor, sig.flag.rot, sig.color),
    );
  }
  for (const element of doc.integrations ?? []) {
    for (const tag of Object.values(element.tags ?? {})) {
      if (!tag?.anchor) continue;
      guarded(element.id, () =>
        buildFlag(sb, view, tag.anchor, tag.rot, element.color),
      );
    }
  }

  for (const ann of doc.annotations ?? []) {
    guarded(ann.id, () => buildAnnotation(sb, ann));
  }

  return { ...sb.result(), modelled: sb.modelled, errors };
}

/**
 * The desk the boards stand on: one large square under everything, a shade
 * off the app's background so the light gives the scene a floor.
 * @param {{min: number[], max: number[]}|null} bounds
 * @param {object} palette
 */
export function groundMesh(bounds, palette) {
  const b = bounds ?? { min: [-30, 0, -30], max: [30, 0, 30] };
  const cx = (b.min[0] + b.max[0]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  const half = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2], 40) * 2 + 100;
  const y = DESK_Y - 0.01;
  const color = mix(palette.base, [1, 1, 1], 0.06);
  return new MeshBuilder()
    .quad(
      [cx - half, y, cz - half],
      [cx + half, y, cz - half],
      [cx + half, y, cz + half],
      [cx - half, y, cz + half],
      color,
    )
    .build();
}

/**
 * Which colour a lamp shows on one sim-state — "on", "off" or "burnt".
 *
 * Nothing here works out a level: an LED's and a segment's verdicts are the
 * desk's own (SimOverlay's, read through `ledOf` / `segmentOf`), and a
 * clock's and a transistor's come straight off the published sim-state — so
 * the 3D view can never light a lamp the desk shows dark.
 *
 * @param {{kind: string, compId: string, seg?: string|null}} lamp
 * @param {{running: boolean,
 *   ledOf?: (id: string) => ({lit: boolean, burnt: boolean}|null),
 *   segmentOf?: (id: string, seg: string) => ({lit: boolean, burnt: boolean}|null),
 *   clockLevels?: Map<string, string>,
 *   channels?: Map<string, Array<{on: string}>>}|null} live
 * @returns {"on"|"off"|"burnt"}
 */
export function lampState(lamp, live) {
  if (!live?.running) return "off";
  const verdict = (s) => (s?.burnt ? "burnt" : s?.lit ? "on" : "off");
  switch (lamp.kind) {
    case "led":
      return verdict(live.ledOf?.(lamp.compId));
    case "segment":
      return verdict(live.segmentOf?.(lamp.compId, lamp.seg));
    case "clock":
      return live.clockLevels?.get(lamp.compId) === H ? "on" : "off";
    case "channel":
      return live.channels?.get(lamp.compId)?.[0]?.on === H ? "on" : "off";
    default:
      return "off";
  }
}
