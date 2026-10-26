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

// meter-probes.js — where a multimeter's probes and jacks are on the desk,
// and what each probe touches. Pure and DOM-free.
//
// A probe is stored on a POINT (`{at}`: a board hole or a brick's terminal)
// or lying on the desk at an offset from the meter's top-left corner
// (`{dx, dy}`), so it rides the meter's drags as a probe lying beside it
// does. A probe is no lead: it claims no hole (occupancy never sees it), so
// it may rest on a hole a chip's pin or a wire end is already in — touching
// that lead, as a probe tip does.

import { parseAddress } from "./breadboard.js";
import { boardRect } from "./mating.js";
import { worldOfAddress } from "./occupancy.js";
import { partDef } from "../catalog/index.js";
import {
  METER_COMPACT,
  METER_SIZE,
  PROBES,
  RED_JACKS,
  isCompact,
  isShunt,
  meterSetup,
  meterSize,
  restingProbe,
} from "../catalog/meter.js";

/** The jacks' centres on the body, from its top-left corner (pitch), per
    size: the full body's as the BM235's photograph has them — 10A and VΩ
    high at the sides, µA mA and COM lower between. */
export const JACK_LAYOUTS = Object.freeze({
  full: Object.freeze({
    a: Object.freeze({ dx: 7.85, dy: 44.45 }),
    ma: Object.freeze({ dx: 12.3, dy: 49.7 }),
    com: Object.freeze({ dx: 19.35, dy: 49.7 }),
    v: Object.freeze({ dx: 24.25, dy: 44.45 }),
  }),
  // Folded down: the four in a row under the LCD.
  compact: Object.freeze({
    a: Object.freeze({ dx: 5, dy: 17.6 }),
    ma: Object.freeze({ dx: 10.35, dy: 17.6 }),
    com: Object.freeze({ dx: 15.65, dy: 17.6 }),
    v: Object.freeze({ dx: 21, dy: 17.6 }),
  }),
});

/** The jacks of a meter at its size. */
export function jacksOf(params) {
  return isCompact(params) ? JACK_LAYOUTS.compact : JACK_LAYOUTS.full;
}

/** The full body's boot and the face on it, from its top-left corner
    (pitch): each a rounded rectangle that NARROWS, as the BM235's holster
    does (its photograph): full width round the LCD, its long sides drawing
    in between `from` and `to` (shares of the straight run, top to bottom —
    about the buttons to the dial) and staying in by `waist` all the way down
    to its foot, its bottom corners with them. The face follows the boot a
    little less. */
export const METER_BODY = Object.freeze({
  boot: Object.freeze({ x0: 0.1, y0: 0.1, x1: 31.9, y1: 62.9, r: 3.6, waist: 0.9, from: 0.25, to: 0.65 }), // prettier-ignore
  face: Object.freeze({ x0: 3.3, y0: 3.2, x1: 28.9, y1: 59.6, r: 2.4, waist: 0.75, from: 0.25, to: 0.65 }), // prettier-ignore
});

/**
 * The outline of one of the body's shapes (`METER_BODY.boot` or `.face`):
 * `[x, y]` points in order round it, clockwise from the middle of its top
 * edge — every point of the outline is in sight of that one, so a fan from
 * it fills the shape (scene3d/mesh.js `polygon`). A side comes in by
 * `waist` along a smoothstep from `from` to `to` (level at both ends, so it
 * leaves the top's straight and meets the bottom's smoothly), and the
 * bottom corners are drawn that far in.
 * @param {{x0: number, y0: number, x1: number, y1: number, r: number, waist: number, from: number, to: number}} shape
 * @param {{corner?: number, side?: number}} [steps] - points per corner and per side
 */
export function bodyOutline(shape, { corner = 8, side = 32 } = {}) {
  const { x0, y0, x1, y1, r, waist } = shape;
  const run = y1 - y0 - 2 * r;
  const inward = (y) => {
    const s = (y - (y0 + r)) / run;
    const u = Math.min(1, Math.max(0, (s - shape.from) / (shape.to - shape.from))); // prettier-ignore
    return waist * u * u * (3 - 2 * u);
  };
  const out = [[(x0 + x1) / 2, y0]];
  const arc = (cx, cy, start) => {
    for (let i = 0; i <= corner; i++) {
      const a = start + (i / corner) * (Math.PI / 2);
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  arc(x1 - r, y0 + r, -Math.PI / 2); // top right
  for (let i = 1; i < side; i++) {
    const y = y0 + r + (run * i) / side;
    out.push([x1 - inward(y), y]);
  }
  arc(x1 - waist - r, y1 - r, 0); // bottom right, drawn in
  arc(x0 + waist + r, y1 - r, Math.PI / 2); // bottom left, drawn in
  for (let i = side - 1; i > 0; i--) {
    const y = y0 + r + (run * i) / side;
    out.push([x0 + inward(y), y]);
  }
  arc(x0 + r, y0 + r, Math.PI); // top left
  return out;
}

/** Every multimeter on a desk. */
export function meters(doc) {
  return (doc?.components ?? []).filter((c) => c.kind === "meter");
}

/** The jack a meter's red lead is plugged into. */
export function redJack(params) {
  return RED_JACKS.includes(params?.jack) ? params.jack : "v";
}

/** The jack each lead is in: black always COM. */
export function jackOf(params, which) {
  return which === "black" ? "com" : redJack(params);
}

/** A jack's centre on the desk, world pitch. */
export function jackWorld(meter, jack) {
  const at = jacksOf(meter.params)[jack];
  return { x: meter.x + at.dx, y: meter.y + at.dy };
}

/**
 * A point's place on the desk — a board hole, or a brick terminal — or null
 * where it resolves to nothing.
 * @param {{boards: Array, components: Array}} doc
 * @param {string} address
 */
export function pointWorld(doc, address) {
  const hole = worldOfAddress(doc?.boards, address);
  if (hole) return hole;
  const parsed = parseAddress(address);
  if (!parsed) return null;
  const comp = (doc?.components ?? []).find((c) => c.id === parsed.boardId);
  if (!comp || comp.board != null) return null;
  const t = partDef(comp.ref)?.terminals?.find((x) => x.id === parsed.hole);
  return t ? { x: comp.x + t.dx, y: comp.y + t.dy } : null;
}

/**
 * Where a probe's tip is on the desk, and the point it is on (null while it
 * lies loose — or on a point that resolves to nothing, where it is drawn
 * lying where it rests).
 * @returns {{x: number, y: number, at: string|null}}
 */
export function probeWorld(doc, meter, which) {
  const probe = meter.params?.[which] ?? restingProbe(which);
  if (typeof probe.at === "string") {
    const world = pointWorld(doc, probe.at);
    if (world) return { ...world, at: probe.at };
  }
  const rest = Number.isFinite(probe.dx) ? probe : restingProbe(which);
  return { x: meter.x + rest.dx, y: meter.y + rest.dy, at: null };
}

/** A loose probe lying at `world`, as the meter stores it. */
export function lyingAt(meter, world) {
  const grid = (v) => Math.round(v * 100) / 100;
  return { dx: grid(world.x - meter.x), dy: grid(world.y - meter.y) };
}

/** The point each of a meter's probes is on (null for a loose one). */
export function probePoints(meter) {
  const out = {};
  for (const which of PROBES) {
    const at = meter.params?.[which]?.at;
    out[which] = typeof at === "string" ? at : null;
  }
  return out;
}

/** The probes resting on an owner's points (a board's holes, a brick's
    terminals): `[{meter, which}]`. */
export function probesOn(doc, ownerId) {
  const out = [];
  for (const meter of meters(doc)) {
    for (const which of PROBES) {
      const at = meter.params?.[which]?.at;
      if (typeof at === "string" && parseAddress(at)?.boardId === ownerId) {
        out.push({ meter, which });
      }
    }
  }
  return out;
}

/** The nets a meter's probes touch on `netlist` (null for a loose probe,
    or one on a point the netlist does not have). */
export function probeNets(meter, netlist) {
  const { red, black } = probePoints(meter);
  const net = (at) => (at ? (netlist?.netOfPoint?.get(at) ?? null) : null);
  return { red: net(red), black: net(black) };
}

/** Whether a meter is CLOSING a gap in the circuit: on a current range
    (its shunt intact) with both probes resting on points. An export leaves
    the meter out, and says the gap is left open. */
export function inSeries(meter) {
  const { red, black } = probePoints(meter);
  return Boolean(red && black) && isShunt(meterSetup(meter.params).element);
}

/**
 * What a multimeter in series with a supply's lead reads on a tick — a wire
 * on Spice Lite's netlist (sim/netlist.js `meterSides`): the current the
 * supply delivers to the points beyond it (its draws, each where it leaves
 * the + rail or returns to the −), into the red jack; and the volts its
 * shunt would drop for that, so the display reads it as any shunt's. A
 * supply on its limit books no draws: all it delivers is taken to pass.
 * @param {{psu: string, rail: string, sign: number, beyond: Set<string>}} series
 *   - the netlist's `meterSides` entry
 * @param {{ohms: number}} element - its shunt
 * @param {{draws?: Array, supplies?: Map}} result - a Spice Lite tick's
 * @returns {{volts: number, amps: number}}
 */
export function seriesReading(series, element, result) {
  const { psu, rail, sign, beyond } = series;
  let amps = 0;
  let any = false;
  for (const d of result.draws ?? []) {
    if (d.psu !== psu) continue;
    any = true;
    const at = rail === "+" ? d.plusAt : d.minusAt;
    if (at && beyond.has(at)) amps += d.amps;
  }
  if (!any) amps = result.supplies?.get(psu)?.amps ?? 0;
  amps *= sign;
  return { volts: amps * element.ohms, amps };
}

/** The body's rect on the desk (pitch). */
export function meterRect(meter) {
  const { width, height } = meterSize(meter.params);
  return { x: meter.x, y: meter.y, width, height };
}

/** Room kept clear right of a meter taken out, pitch: where its probes lie
    (catalog/meter.js `restingProbe`, 36 from its left edge, and their
    length) stays in view. */
const PROBE_ROOM = 12;

/**
 * Where a meter taken out onto the desk goes (DeskController `addMeter`):
 * at the right of `view` — the world rect the desk shows — with its resting
 * probes beside it (`PROBE_ROOM`), near its top, stepping left past each
 * meter already out (`taken`, their rects) so none lands on another. It
 * floats over whatever else is there. A view with no room (none measured)
 * puts it just right of everything on the desk (`right`, the rightmost edge
 * any board or brick reaches).
 * @param {{x: number, y: number, width: number, height: number}} view
 * @param {number} [right]
 * @param {Array<{x: number, y: number, width: number, height: number}>} [taken]
 * @returns {{x: number, y: number}}
 */
export function meterSpot(view, right = 0, taken = []) {
  const { width, height } = METER_SIZE;
  const y = Math.round(view.y + 2);
  let x =
    view.width >= width + PROBE_ROOM + 2
      ? Math.floor(view.x + view.width - width - PROBE_ROOM)
      : Math.ceil(right) + 4;
  const clear = (at) =>
    taken.every((r) => at + width + PROBE_ROOM <= r.x || r.x + r.width + PROBE_ROOM <= at || y + height <= r.y || r.y + r.height <= y); // prettier-ignore
  for (let i = 0; i <= taken.length && !clear(x); i++) x -= width + PROBE_ROOM;
  return { x, y };
}

/**
 * A desk document as a FILE holds it (model/project-doc.js `projectForFile`,
 * a desktop's export): each meter without its place on the desk (`x`, `y`)
 * or its size — both the session's, so taking a meter out, moving it or
 * folding it is never a change to the design (Jason, 2026-10-26). A loose
 * probe of a folded meter is put back into the full body's frame, so it lies
 * beside the full meter the file reopens as. Everything else is the
 * document's own, shared, not copied.
 * @param {{components?: Array}} doc
 */
export function meterForFile(doc) {
  if (!(doc?.components ?? []).some((c) => c.kind === "meter")) return doc;
  return {
    ...doc,
    components: doc.components.map((c) => {
      if (c.kind !== "meter") return c;
      const { x: _x, y: _y, ...meter } = c;
      void _x;
      void _y;
      const { size: _size, ...params } = c.params ?? {};
      void _size;
      if (isCompact(c.params)) {
        const { origin } = METER_COMPACT;
        for (const which of PROBES) {
          const probe = params[which];
          if (Number.isFinite(probe?.dx)) params[which] = { dx: probe.dx + origin.x, dy: probe.dy + origin.y }; // prettier-ignore
        }
      }
      return { ...meter, params };
    }),
  };
}

/**
 * Where meters loaded with no place (`meterForFile`) go: in a row just right
 * of everything on the desk (`right`, the rightmost edge a board or brick
 * reaches), level with the top of the boards, each with its resting probes'
 * room beside it.
 * @param {{boards?: Array, components?: Array}} doc - what is already placed
 * @param {number} count
 * @returns {Array<{x: number, y: number}>}
 */
export function meterSpotsBeside(doc, count) {
  let right = 0;
  let top = null;
  for (const b of doc?.boards ?? []) {
    const r = boardRect(b);
    right = Math.max(right, r.x + r.width);
    top = top == null ? r.y : Math.min(top, r.y);
  }
  for (const c of doc?.components ?? []) {
    if (c.board != null || c.kind === "meter" || !Number.isFinite(c.x))
      continue;
    const size = partDef(c.ref)?.size;
    if (size) right = Math.max(right, c.x + size.width);
  }
  const x = Math.ceil(right) + 4;
  const y = Math.round(top ?? 0);
  const step = METER_SIZE.width + PROBE_ROOM;
  return Array.from({ length: count }, (_, i) => ({ x: x + i * step, y }));
}
