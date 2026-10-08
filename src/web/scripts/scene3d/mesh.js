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

// mesh.js — the shape vocabulary every 3D model is built from. A MeshBuilder
// accumulates plain triangles (position, normal, colour per vertex — no index
// buffer, no materials, no textures) in WORLD coordinates: a part model places
// its geometry where it sits, so the renderer draws a whole desk in one call
// and never needs a per-part transform.
//
// Pure and DOM-free (the GL upload is components/gl-renderer.js's), so every
// model can be built and measured under `node --test`.
//
// WINDING DOES NOT MATTER. The renderer draws both faces and turns each
// normal toward the viewer before lighting it, so a primitive here only has
// to put its normals along the right LINE. That is a deliberate trade: a
// hand-built box or a fan cap wound the wrong way round would otherwise
// render black, and a check that every primitive winds consistently would be
// a second geometry exam per shape for no visible gain.
//
// Colours are `[r, g, b]` in 0…1 (scene3d/palette.js turns the theme's hex
// tokens into these).

import {
  add,
  cross,
  dot,
  length,
  normalize,
  perpendicular,
  scale,
  sub,
} from "./mat4.js";

const TAU = Math.PI * 2;

export class MeshBuilder {
  #pos = [];
  #nrm = [];
  #col = [];
  #min = [Infinity, Infinity, Infinity];
  #max = [-Infinity, -Infinity, -Infinity];

  /** Triangles so far. */
  get triangleCount() {
    return this.#pos.length / 9;
  }

  /** Vertices so far (three per triangle). */
  get vertexCount() {
    return this.#pos.length / 3;
  }

  /** The axis-aligned box round every vertex so far, or null when empty. */
  get bounds() {
    if (this.#pos.length === 0) return null;
    return { min: [...this.#min], max: [...this.#max] };
  }

  /**
   * The axis-aligned box round the vertices from index `from` on (a
   * `vertexCount` read earlier), or null when none have been added since —
   * the box round one part's geometry in a builder shared with the rest.
   */
  boundsSince(from) {
    const pos = this.#pos;
    if (pos.length <= from * 3) return null;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = from * 3; i < pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (pos[i + k] < min[k]) min[k] = pos[i + k];
        if (pos[i + k] > max[k]) max[k] = pos[i + k];
      }
    }
    return { min, max };
  }

  #vertex(p, n, c) {
    this.#pos.push(p[0], p[1], p[2]);
    this.#nrm.push(n[0], n[1], n[2]);
    this.#col.push(c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) {
      if (p[i] < this.#min[i]) this.#min[i] = p[i];
      if (p[i] > this.#max[i]) this.#max[i] = p[i];
    }
  }

  /**
   * One triangle. With no normals given it is flat-shaded along its own
   * face normal; `normals` may give one per corner for a smooth surface.
   */
  triangle(a, b, c, color, normals = null) {
    if (normals) {
      this.#vertex(a, normals[0], color);
      this.#vertex(b, normals[1], color);
      this.#vertex(c, normals[2], color);
      return this;
    }
    const n = normalize(cross(sub(b, a), sub(c, a)));
    this.#vertex(a, n, color);
    this.#vertex(b, n, color);
    this.#vertex(c, n, color);
    return this;
  }

  /** A flat four-cornered face, corners in order round its edge. */
  quad(a, b, c, d, color) {
    const n = normalize(cross(sub(c, a), sub(d, b)));
    this.triangle(a, b, c, color, [n, n, n]);
    this.triangle(a, c, d, color, [n, n, n]);
    return this;
  }

  /** A flat convex polygon, corners in order round its edge (fan-filled). */
  polygon(points, color) {
    if (points.length < 3) return this;
    let n = [0, 0, 0];
    for (let i = 1; i < points.length - 1; i++) {
      n = add(
        n,
        cross(sub(points[i], points[0]), sub(points[i + 1], points[0])),
      );
    }
    n = normalize(n);
    for (let i = 1; i < points.length - 1; i++) {
      this.triangle(points[0], points[i], points[i + 1], color, [n, n, n]);
    }
    return this;
  }

  /**
   * An axis-aligned box from `min` to `max`. `color` is one colour, or
   * `{top, side, bottom}` (side also stands in for a missing top or bottom).
   */
  box(min, max, color) {
    return this.orientedBox(
      [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
      color,
    );
  }

  /**
   * A box with its own axes: centred on `center`, `half` = half-extents along
   * the three unit vectors `ax` (along), `ay` (up) and `az` (across). The
   * faces along ±ay are its top and bottom for colouring.
   */
  orientedBox(center, ax, ay, az, half, color) {
    const { top, side, bottom } = faceColors(color);
    const corner = (sx, sy, sz) =>
      add(
        add(add(center, scale(ax, sx * half[0])), scale(ay, sy * half[1])),
        scale(az, sz * half[2]),
      );
    const c = {
      lbn: corner(-1, -1, -1),
      rbn: corner(1, -1, -1),
      rbf: corner(1, -1, 1),
      lbf: corner(-1, -1, 1),
      ltn: corner(-1, 1, -1),
      rtn: corner(1, 1, -1),
      rtf: corner(1, 1, 1),
      ltf: corner(-1, 1, 1),
    };
    this.quad(c.ltn, c.rtn, c.rtf, c.ltf, top);
    this.quad(c.lbn, c.rbn, c.rbf, c.lbf, bottom);
    this.quad(c.lbn, c.rbn, c.rtn, c.ltn, side);
    this.quad(c.lbf, c.rbf, c.rtf, c.ltf, side);
    this.quad(c.lbn, c.lbf, c.ltf, c.ltn, side);
    this.quad(c.rbn, c.rbf, c.rtf, c.rtn, side);
    return this;
  }

  /**
   * Extrude the flat polygon `base` (3D points, in order round its edge) along
   * `dir` — a prism. The two caps are filled as fans, so the outline must be
   * convex; the walls are flat-shaded per edge.
   * @param {number[][]} base
   * @param {number[]} dir - the extrusion vector (its length is the height)
   * @param {number[]|object} color - one colour or `{top, side, bottom}`
   * @param {{smooth?: boolean}} [opts] - smooth: shade the walls as one
   *   curved surface (a cylinder-like outline), not as facets
   */
  extrude(base, dir, color, { smooth = false } = {}) {
    const { top, side, bottom } = faceColors(color);
    const lid = base.map((p) => add(p, dir));
    this.polygon(base, bottom);
    this.polygon(lid, top);
    const n = base.length;
    const up = normalize(dir);
    // Outward normal of each wall, flat — then averaged at the corners for a
    // smooth outline.
    const centre = scale(
      base.reduce((acc, p) => add(acc, p), [0, 0, 0]),
      1 / n,
    );
    const wall = [];
    for (let i = 0; i < n; i++) {
      const a = base[i];
      const b = base[(i + 1) % n];
      let w = normalize(cross(sub(b, a), up));
      const mid = scale(add(a, b), 0.5);
      if (dot(w, sub(mid, centre)) < 0) w = scale(w, -1);
      wall.push(w);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = base[i];
      const b = base[j];
      if (smooth) {
        const na = normalize(add(wall[(i - 1 + n) % n], wall[i]));
        const nb = normalize(add(wall[i], wall[j]));
        this.triangle(a, b, lid[j], side, [na, nb, nb]);
        this.triangle(a, lid[j], lid[i], side, [na, nb, na]);
      } else {
        this.triangle(a, b, lid[j], side, [wall[i], wall[i], wall[i]]);
        this.triangle(a, lid[j], lid[i], side, [wall[i], wall[i], wall[i]]);
      }
    }
    return this;
  }

  /**
   * A flat disc of `radius` about `center`, facing along `normal`.
   */
  disc(center, normal, radius, color, segments = 20) {
    const [u, v] = basis(normal);
    const ring = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * TAU;
      ring.push(
        add(
          center,
          add(scale(u, Math.cos(a) * radius), scale(v, Math.sin(a) * radius)),
        ),
      );
    }
    return this.polygon(ring, color);
  }

  /**
   * A cylinder standing on `base` along the unit `axis` for `height`, smooth
   * walls, capped at both ends unless told otherwise.
   * @param {{segments?: number, caps?: boolean, capColor?: number[]}} [opts]
   */
  cylinder(base, axis, radius, height, color, opts = {}) {
    const { segments = 16, caps = true, capColor = color } = opts;
    const ax = normalize(axis);
    const [u, v] = basis(ax);
    const top = add(base, scale(ax, height));
    const dirs = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * TAU;
      dirs.push(add(scale(u, Math.cos(a)), scale(v, Math.sin(a))));
    }
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      const b0 = add(base, scale(dirs[i], radius));
      const b1 = add(base, scale(dirs[j], radius));
      const t0 = add(top, scale(dirs[i], radius));
      const t1 = add(top, scale(dirs[j], radius));
      this.triangle(b0, b1, t1, color, [dirs[i], dirs[j], dirs[j]]);
      this.triangle(b0, t1, t0, color, [dirs[i], dirs[j], dirs[i]]);
    }
    if (caps) {
      this.polygon(
        dirs.map((d) => add(base, scale(d, radius))),
        capColor,
      );
      this.polygon(
        dirs.map((d) => add(top, scale(d, radius))),
        capColor,
      );
    }
    return this;
  }

  /**
   * Half a sphere of `radius` on `center`, bulging along the unit `axis` (an
   * LED's lens, a button's cap). Its flat side is left open — it always sits
   * on something.
   */
  dome(center, axis, radius, color, { segments = 16, rings = 6 } = {}) {
    const ax = normalize(axis);
    const [u, v] = basis(ax);
    const point = (ring, seg) => {
      const phi = (ring / rings) * (Math.PI / 2); // 0 at the rim, π/2 at the top
      const th = (seg / segments) * TAU;
      const r = Math.cos(phi);
      return add(
        scale(add(scale(u, Math.cos(th) * r), scale(v, Math.sin(th) * r)), 1),
        scale(ax, Math.sin(phi)),
      );
    };
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < segments; s++) {
        const n00 = point(r, s);
        const n01 = point(r, s + 1);
        const n10 = point(r + 1, s);
        const n11 = point(r + 1, s + 1);
        const p = (n) => add(center, scale(n, radius));
        this.triangle(p(n00), p(n01), p(n11), color, [n00, n01, n11]);
        if (r < rings - 1) {
          this.triangle(p(n00), p(n11), p(n10), color, [n00, n11, n10]);
        }
      }
    }
    return this;
  }

  /**
   * A torus (a ring of round section) about `center`, its hole along the unit
   * `axis`: `major` from the centre to the middle of the tube, `minor` the
   * tube's own radius.
   */
  torus(center, axis, major, minor, color, { segments = 32, sides = 10 } = {}) {
    const ax = normalize(axis);
    const [u, v] = basis(ax);
    const at = (i, j) => {
      const a = (i / segments) * TAU;
      const b = (j / sides) * TAU;
      const radial = add(scale(u, Math.cos(a)), scale(v, Math.sin(a)));
      const n = add(scale(radial, Math.cos(b)), scale(ax, Math.sin(b)));
      const p = add(center, add(scale(radial, major), scale(n, minor)));
      return { p, n };
    };
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < sides; j++) {
        const a = at(i, j);
        const b = at(i + 1, j);
        const c = at(i + 1, j + 1);
        const d = at(i, j + 1);
        this.triangle(a.p, b.p, c.p, color, [a.n, b.n, c.n]);
        this.triangle(a.p, c.p, d.p, color, [a.n, c.n, d.n]);
      }
    }
    return this;
  }

  /**
   * A round tube of `radius` through `points` (two or more) — a wire, a lead.
   * Each joint is MITRED: its ring lies in the plane that bisects the bend and
   * is stretched across it, so a sharp corner (a routed wire's) keeps the
   * tube's thickness instead of pinching. The ends are left open; they are
   * always buried in a hole or a part.
   * @param {{sides?: number}} [opts]
   */
  tube(points, radius, color, { sides = 6 } = {}) {
    const pts = dedupe(points);
    if (pts.length < 2) return this;
    const n = pts.length;
    const seg = [];
    for (let i = 0; i < n - 1; i++)
      seg.push(normalize(sub(pts[i + 1], pts[i])));
    // The ring's reference direction, carried from joint to joint (parallel
    // transport) so the tube never twists.
    let ref = perpendicular(seg[0]);
    const rings = [];
    for (let i = 0; i < n; i++) {
      const before = seg[Math.max(0, i - 1)];
      const after = seg[Math.min(n - 2, i)];
      const t = normalize(add(before, after), after);
      ref = normalize(sub(ref, scale(t, dot(ref, t))), perpendicular(t));
      const side = cross(t, ref);
      // How far the bisecting plane is tilted off square to the run: a ring
      // there has to be wider ACROSS the bend by 1/cos of the half-angle.
      const c = Math.max(0.25, dot(t, after));
      const bend = sub(after, before);
      const k =
        length(bend) > 1e-9
          ? normalize(sub(bend, scale(t, dot(bend, t))))
          : null;
      const ring = [];
      for (let s = 0; s < sides; s++) {
        const a = (s / sides) * TAU;
        const dir = add(scale(ref, Math.cos(a)), scale(side, Math.sin(a)));
        let off = scale(dir, radius);
        if (k) off = add(off, scale(k, dot(off, k) * (1 / c - 1)));
        ring.push({ p: add(pts[i], off), n: dir });
      }
      rings.push(ring);
    }
    for (let i = 0; i < n - 1; i++) {
      for (let s = 0; s < sides; s++) {
        const s2 = (s + 1) % sides;
        const a = rings[i][s];
        const b = rings[i][s2];
        const c = rings[i + 1][s2];
        const d = rings[i + 1][s];
        this.triangle(a.p, b.p, c.p, color, [a.n, b.n, c.n]);
        this.triangle(a.p, c.p, d.p, color, [a.n, c.n, d.n]);
      }
    }
    return this;
  }

  /**
   * Append everything another builder holds.
   * @param {{positions: Float32Array, normals: Float32Array, colors: Float32Array}} data
   */
  append(data) {
    for (let i = 0; i < data.positions.length; i += 3) {
      this.#vertex(
        [data.positions[i], data.positions[i + 1], data.positions[i + 2]],
        [data.normals[i], data.normals[i + 1], data.normals[i + 2]],
        [data.colors[i], data.colors[i + 1], data.colors[i + 2]],
      );
    }
    return this;
  }

  /**
   * The finished arrays, ready for a vertex buffer.
   * @returns {{positions: Float32Array, normals: Float32Array,
   *   colors: Float32Array, count: number, bounds: object|null}}
   */
  build() {
    return {
      positions: Float32Array.from(this.#pos),
      normals: Float32Array.from(this.#nrm),
      colors: Float32Array.from(this.#col),
      count: this.vertexCount,
      bounds: this.bounds,
    };
  }
}

/** `{top, side, bottom}` from either one colour or a partial set. */
function faceColors(color) {
  if (Array.isArray(color)) return { top: color, side: color, bottom: color };
  const side = color.side ?? color.top ?? color.bottom;
  return {
    top: color.top ?? side,
    side,
    bottom: color.bottom ?? side,
  };
}

/** Two unit vectors completing the unit `axis` to a right-handed frame. */
function basis(axis) {
  const u = perpendicular(axis);
  return [u, cross(axis, u)];
}

/** Drop consecutive points that coincide — a zero-length run has no direction
    to build a ring square to. */
function dedupe(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || length(sub(p, last)) > 1e-6) out.push(p);
  }
  return out;
}

/**
 * Points along the cubic Bézier P0→P3 with controls P1, P2 (`steps` + 1 of
 * them, both ends included) — a wire's arch.
 */
export function cubicPoints(p0, p1, p2, p3, steps = 16) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push([
      a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
      a * p0[2] + b * p1[2] + c * p2[2] + d * p3[2],
    ]);
  }
  return out;
}

/**
 * A rounded rectangle's outline in the desk plane at height `y`, as 3D points
 * in order — the plan of most parts' plastic. `r` is clamped to fit.
 */
export function roundedRect(minX, minZ, maxX, maxZ, r, y, steps = 3) {
  const rr = Math.max(0, Math.min(r, (maxX - minX) / 2, (maxZ - minZ) / 2));
  if (rr === 0) {
    return [
      [minX, y, minZ],
      [maxX, y, minZ],
      [maxX, y, maxZ],
      [minX, y, maxZ],
    ];
  }
  const out = [];
  const corners = [
    [maxX - rr, maxZ - rr, 0],
    [minX + rr, maxZ - rr, Math.PI / 2],
    [minX + rr, minZ + rr, Math.PI],
    [maxX - rr, minZ + rr, (3 * Math.PI) / 2],
  ];
  for (const [cx, cz, start] of corners) {
    for (let i = 0; i <= steps; i++) {
      const a = start + (i / steps) * (Math.PI / 2);
      out.push([cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr]);
    }
  }
  return out;
}
