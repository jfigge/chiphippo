/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// wire-length.js — HOW LONG IS THIS WIRE, in one place. Pure and DOM-free over a
// plain desk document, so everything that states a length says the same number:
// the wire's own dimensioned drawing in its Properties dialog
// (components/wire-gauge.js) and the Bill of Materials' wire list
// (model/build-plan.js), which is the shopping list you cut from.
//
// TWO NUMBERS, AND THE DIFFERENCE MATTERS.
//   • the RUN (`wireRunMm`) — hole to hole, exactly the shape the desk DRAWS.
//     This is what the sleeve of a real jumper spans, so it is what the drawing
//     needs to size its sleeve by.
//   • the CUT (`wireCutMm`) — the run plus a STRIP_MM of stripped lead at each
//     end, because a lead does not stop at the surface of the board: it reaches
//     INTO both holes. So a jumper crossing one 2.54 mm pitch is ~13 mm of wire,
//     not 3 mm. This is what you cut, and what a BOM line states.
//
// THE RUN IS THE DRAWN SHAPE, not the straight line between two holes — a real
// lead spanning two holes is longer than the gap, and the desk draws that slack:
//   • direct — the sagging curve's own ARC length (desk/wire-path.js);
//   • routed — the polyline through the wire's waypoints;
//   • a BUS MEMBER — its lead off the ribbon, the length of the ribbon it runs
//     inside, then its lead at the far end. A conductor in a ribbon cable is as
//     long as the cable however short the two ends sticking out are.
// Which is why this reaches into desk/ for the sag and the ribbon geometry: those
// ARE the shapes, and a second implementation of them here could quietly disagree
// with the picture on the desk.
//
// It deliberately knows nothing about live drags: a wire is measured as the
// document has it (a wire cannot be dragged while its Properties dialog is up,
// and a BOM is not a live readout of a gesture).

import { formatNumber, tf } from "../i18n.js";
import { PX_PER_UNIT, pxToMm } from "../desk/desk-geometry.js";
import { polylineLength, wireLength } from "../desk/wire-path.js";
import {
  centroid,
  ribbonLayout,
  ribbonSpread,
  ribbonWidth,
} from "../desk/ribbon-path.js";
import { addressWorld } from "./part-geometry.js";

/** How much sleeve a jumper is stripped back at each end (mm) — bench practice,
    and the one place that number lives. */
export const STRIP_MM = 5;

/** The whole wire (mm) for a given hole-to-hole run: a strip at each end reaches
    into the board, so both are wire you have to cut. A nonsense run floors at
    zero rather than producing a length with a minus sign in it. */
export const wireTotalMm = (runMm) => Math.max(0, runMm) + 2 * STRIP_MM;

/** A length in centimetres to a tenth, locale-formatted (so a decimal comma
    lands where one belongs) — the ONE format, shared by the drawing's dimension
    line and the BOM's wire lines, which is what stops the same wire reading two
    different ways in two places.

    `tf`, not `t`: this is model code, so it has to read correctly under `node
    --test` with no catalog loaded — the same reason every string in build-plan.js
    carries its English along (see catalog/labels.js for the rule). The unit
    symbol is the same in all seven languages; what the catalog decides is where
    the number and the symbol sit. */
export function wireLengthLabel(mm) {
  return tf("wire.lengthCm", "{value} cm", {
    value: formatNumber(Math.max(0, mm) / 10, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }),
  });
}

/** Read a document's four lists ONCE — a DeskDoc's getters copy on every access,
    and this walks them per wire. Also accepts a plain `toJSON()` document. */
const scene = (doc) => ({
  boards: doc?.boards ?? [],
  components: doc?.components ?? [],
  wires: doc?.wires ?? [],
  buses: doc?.buses ?? [],
});

/** An address → world PX resolver. World px, not pitch units, because the sag is
    defined in px (desk/wire-path.js's SAG_MIN/SAG_MAX are absolute). */
const resolver = (s) => (address) => {
  const p = addressWorld(s.boards, s.components, address);
  return p ? { x: p.x * PX_PER_UNIT, y: p.y * PX_PER_UNIT } : null;
};

/**
 * A bundle's at-rest ribbon geometry: its collars and each member's own
 * attachment point across the pipe's face. The same pure primitives WireLayer
 * draws with (desk/ribbon-path.js), so the length agrees with the picture; what
 * it leaves out is the render-time concerns the layer adds — drag offsets and
 * live board-move overrides. Null when no member resolves.
 */
function ribbonGeometry(s, bus, at) {
  const froms = [];
  const tos = [];
  for (const id of bus.members) {
    const wire = s.wires.find((w) => w.id === id);
    if (!wire) continue;
    const a = at(wire.from);
    const b = at(wire.to);
    if (!a || !b) continue;
    froms.push(a);
    tos.push(b);
  }
  if (froms.length === 0) return null;
  const A = centroid(froms);
  const B = centroid(tos);
  const count = bus.members.length;
  const width = ribbonWidth(count);
  return {
    ...ribbonLayout(A, B),
    ...ribbonSpread(A, B, width, count),
  };
}

/**
 * The RUN one wire covers, hole to hole, in millimetres — the drawn shape's own
 * length (see the note at the top). Null when the wire is gone or either end
 * doesn't resolve: a dangling wire has no length to state.
 *
 * @param {{boards:Array, components:Array, wires:Array, buses?:Array}} doc
 *   a DeskDoc or a plain desk document.
 * @param {string} wireId
 * @returns {number|null}
 */
export function wireRunMm(doc, wireId) {
  const s = scene(doc);
  const wire = s.wires.find((w) => w.id === wireId);
  if (!wire) return null;
  const at = resolver(s);
  const a = at(wire.from);
  const b = at(wire.to);
  if (!a || !b) return null;

  const bus = s.buses.find((x) => x.members.includes(wireId));
  if (bus) {
    const geo = ribbonGeometry(s, bus, at);
    if (geo) {
      const i = bus.members.indexOf(wireId);
      return pxToMm(
        wireLength(geo.spreadA[i] ?? geo.collarA, a) +
          wireLength(geo.collarA, geo.collarB) +
          wireLength(geo.spreadB[i] ?? geo.collarB, b),
      );
    }
  }
  if (wire.layout === "routed") {
    // Waypoints are desk coordinates (the one part of a wire that is not an
    // address), so they scale to px the same way a hole's position does.
    const points = [
      a,
      ...(wire.points ?? []).map((p) => ({
        x: p.x * PX_PER_UNIT,
        y: p.y * PX_PER_UNIT,
      })),
      b,
    ];
    return pxToMm(polylineLength(points));
  }
  return pxToMm(wireLength(a, b));
}

/**
 * The whole wire one wire IS: its run plus a strip at each end — the length you
 * would cut. Null exactly when `wireRunMm` is.
 *
 * @param {{boards:Array, components:Array, wires:Array, buses?:Array}} doc
 * @param {string} wireId
 * @returns {number|null}
 */
export function wireCutMm(doc, wireId) {
  const run = wireRunMm(doc, wireId);
  return run == null ? null : wireTotalMm(run);
}
