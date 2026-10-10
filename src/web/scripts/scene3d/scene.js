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
// the scene's LAMPS are lit and how brightly (`lampState`, `lampLevel`,
// `lampLook`), and which PLUMES smoke (`plumeSmoke`); the renderer recolours
// the lamps and draws the halos and puffs.

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
    const mark = sb.mark();
    try {
      fn();
    } catch (error) {
      // …and leaves nothing of itself behind: a model that threw half-way
      // would otherwise stand half-built on the desk.
      sb.rewind(mark);
      sb.modelled.delete(id);
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

/** How bright a lit lamp glows at full level: 1 ignores the light entirely. */
export const LIT_GLOW = 0.85;

/** A lamp's halo, at full level, is this opaque at its centre. */
const HALO_ALPHA = 0.55;

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

/**
 * How bright a lit LED or segment is on one sim-state — the desk's own
 * `level` (SimOverlay: Spice Lite's current, 1 at the LED's datasheet
 * current; 1 on the digital engine) — or null for a lamp with no level of
 * its own (a clock's, a transistor's: on is simply on).
 * @param {{kind: string, compId: string, seg?: string|null}} lamp
 * @param {object|null} live - as lampState's
 * @returns {number|null}
 */
export function lampLevel(lamp, live) {
  if (!live?.running) return null;
  const verdict =
    lamp.kind === "led"
      ? live.ledOf?.(lamp.compId)
      : lamp.kind === "segment"
        ? live.segmentOf?.(lamp.compId, lamp.seg)
        : null;
  const level = verdict?.level;
  return Number.isFinite(level) ? level : null;
}

/**
 * What a lamp looks like: its colour, how far it glows past the light, and
 * the halo it throws (null for none). The desk's look, stood up — a lit LED's
 * lens from 30 % to full colour as its level climbs to 1 (`fill-opacity:
 * 0.3 + 0.7·level`), its halo growing with the level uncapped, so an
 * overdriven LED blazes wider than a comfortable one; past 1 its lens also
 * washes toward white. `glowing` false (a run toggling faster than the eye
 * reads a glow — SimOverlay's GLOW_MAX_HZ) keeps the lens and drops the halo,
 * as the desk goes flat.
 * @param {{on: number[], off: number[], burnt: number[],
 *   halo?: {center: number[], radius: number}|null}} lamp
 * @param {"on"|"off"|"burnt"} state - lampState's
 * @param {number|null} level - lampLevel's; null is full
 * @param {boolean} [glowing]
 * @returns {{color: number[], emissive: number,
 *   halo: {center: number[], radius: number, alpha: number}|null}}
 */
export function lampLook(lamp, state, level, glowing = true) {
  if (state === "burnt") return { color: lamp.burnt, emissive: 0, halo: null };
  if (state !== "on") return { color: lamp.off, emissive: 0, halo: null };
  const L = Math.max(0, level ?? 1);
  const k = 0.3 + 0.7 * Math.min(1, L);
  let color = mix(lamp.off, lamp.on, k);
  if (L > 1) color = mix(color, [1, 1, 1], Math.min(0.35, (L - 1) * 0.6));
  const halo =
    glowing && lamp.halo && L > 0
      ? {
          center: lamp.halo.center,
          radius: lamp.halo.radius * Math.min(2, Math.max(0.35, L)),
          alpha: HALO_ALPHA * Math.min(1, L),
        }
      : null;
  return { color, emissive: LIT_GLOW * k, halo };
}

/**
 * Whether a part's plume smokes on one sim-state, and in which smoke:
 * "grey" (the magic smoke — reversed, killed by 12 V, an LED, segment or
 * diode burnt out) or "brown" (Spice Lite's overload), else null. Decided by
 * the desk (SimOverlay.smokeOf), never here.
 * @param {{compId: string}} plume
 * @param {{running: boolean, smokeOf?: (id: string) => ("grey"|"brown"|null)}|null} live
 * @returns {"grey"|"brown"|null}
 */
export function plumeSmoke(plume, live) {
  if (!live?.running) return null;
  return live.smokeOf?.(plume.compId) ?? null;
}
