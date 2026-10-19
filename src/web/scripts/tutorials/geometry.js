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

// tutorials/geometry.js — where a tutorial's callout goes and what its
// decorations look like, as pure arithmetic over screen rectangles.
//
// Every figure here is in CSS pixels of the WINDOW (client coordinates), the
// space `getBoundingClientRect` answers in and the overlay is laid out in. A
// target is never a hard-coded position: the overlay asks the registry for the
// target's rectangle on every frame and hands it here, so a resize, a tray
// sliding open or a font-size change moves the callout with the thing it
// points at. Nothing in this module touches the DOM, which is what lets the
// placement rules be tested exhaustively under `node --test`.
//
// A rect is `{left, top, width, height}` (right/bottom derived), a size
// `{width, height}`, a point `{x, y}`.

/** The four sides a callout can sit on, in the order "auto" breaks a tie. */
export const SIDES = Object.freeze(["below", "right", "above", "left"]);

/** Every `callout.placement` a step may name. `inside-top` sits the callout
    INSIDE the target, at its top — for a target as big as the desk, which
    leaves no room on any side of it. */
export const PLACEMENTS = Object.freeze([...SIDES, "auto", "inside-top"]);

/** Every `callout.decoration` a step may name. */
export const DECORATIONS = Object.freeze(["brace", "arrow", "ring", "none"]);

const OPPOSITE = Object.freeze({
  above: "below",
  below: "above",
  left: "right",
  right: "left",
});

/** How far a decoration stands off its target, and how deep a brace is. */
export const DECOR_OFFSET = 6;
export const BRACE_DEPTH = 14;
/** The extra gap an arrow needs between the callout and its target, so the
    shaft is long enough to read as an arrow rather than a tick. */
export const ARROW_GAP = 44;
/** The gap between a callout and its target (or its brace) otherwise. */
export const CALLOUT_GAP = 12;
/** How far a callout is kept from the window's edges. */
export const VIEW_MARGIN = 12;
/** The spotlight's padding round the target, and its corner radius. */
export const SPOT_PAD = 6;
export const SPOT_RADIUS = 8;

const clamp = (v, lo, hi) => (hi < lo ? lo : Math.min(hi, Math.max(lo, v)));

/** `rect` with `right`/`bottom` filled in (a DOMRect already has them). */
export function normRect(rect) {
  if (!rect) return null;
  const { left, top, width, height } = rect;
  if (![left, top, width, height].every(Number.isFinite)) return null;
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

/** `rect` grown by `pad` on every side. */
export function inflate(rect, pad) {
  const r = normRect(rect);
  return normRect({
    left: r.left - pad,
    top: r.top - pad,
    width: r.width + 2 * pad,
    height: r.height + 2 * pad,
  });
}

/** A point inside `rect`, `at` being fractions of its width and height. */
export function rectPoint(rect, at = [0.5, 0.5]) {
  const r = normRect(rect);
  const [fx, fy] = Array.isArray(at) && at.length === 2 ? at : [0.5, 0.5];
  return { x: r.left + r.width * fx, y: r.top + r.height * fy };
}

/** The gap a decoration needs between target and callout. */
export function decorationGap(decoration) {
  if (decoration === "arrow") return ARROW_GAP;
  if (decoration === "brace") return DECOR_OFFSET + BRACE_DEPTH + CALLOUT_GAP;
  if (decoration === "ring") return SPOT_PAD + CALLOUT_GAP;
  return SPOT_PAD + CALLOUT_GAP;
}

/**
 * Which side of `rect` a callout of `size` goes on. A named side is honoured
 * when the callout fits there, else its OPPOSITE is tried (a tray docked on
 * the left asks for "right"; on a narrow window it may only fit below). Auto —
 * and a named side that fits on neither — takes the side with the most room
 * to spare for this size.
 */
export function chooseSide(rect, size, placement, view, gap) {
  const r = normRect(rect);
  const room = {
    above: r.top,
    below: view.height - r.bottom,
    left: r.left,
    right: view.width - r.right,
  };
  const need = {
    above: size.height + gap,
    below: size.height + gap,
    left: size.width + gap,
    right: size.width + gap,
  };
  const fits = (side) => room[side] - need[side] >= VIEW_MARGIN;
  if (OPPOSITE[placement]) {
    if (fits(placement)) return placement;
    if (fits(OPPOSITE[placement])) return OPPOSITE[placement];
  }
  let best = SIDES[0];
  for (const side of SIDES) {
    if (room[side] - need[side] > room[best] - need[best]) best = side;
  }
  return best;
}

/**
 * Where the callout card goes.
 *
 * @param {object} o
 * @param {object|null} o.rect - the target's rectangle; null centres the
 *   callout in the window (a step with no target).
 * @param {{width:number,height:number}} o.size - the callout card's size.
 * @param {string} [o.placement] - one of PLACEMENTS.
 * @param {string} [o.decoration] - one of DECORATIONS (decides the gap).
 * @param {{width:number,height:number}} o.view - the window.
 * @returns {{x:number, y:number, side:string|null}} the card's top-left and
 *   the side of the target it ended up on (null when centred or inside).
 */
export function placeCallout({
  rect,
  size,
  placement = "auto",
  decoration = "none",
  view,
}) {
  const fit = (x, y) => ({
    x: clamp(x, VIEW_MARGIN, view.width - VIEW_MARGIN - size.width),
    y: clamp(y, VIEW_MARGIN, view.height - VIEW_MARGIN - size.height),
  });
  const r = normRect(rect);
  if (!r) {
    return {
      ...fit((view.width - size.width) / 2, (view.height - size.height) / 2),
      side: null,
    };
  }
  if (placement === "inside-top") {
    return {
      ...fit(r.left + (r.width - size.width) / 2, r.top + 2 * CALLOUT_GAP),
      side: null,
    };
  }
  const gap = decorationGap(decoration);
  const side = chooseSide(r, size, placement, view, gap);
  let x;
  let y;
  if (side === "above" || side === "below") {
    x = r.left + r.width / 2 - size.width / 2;
    y = side === "above" ? r.top - gap - size.height : r.bottom + gap;
  } else {
    y = r.top + r.height / 2 - size.height / 2;
    x = side === "left" ? r.left - gap - size.width : r.right + gap;
  }
  return { ...fit(x, y), side };
}

/** Map a point stated ALONG an edge (u) and OUTWARD from it (v) to the window,
    for the edge of `r` facing `side`. */
function edgeMapper(r, side) {
  switch (side) {
    case "right":
      return (u, v) => [r.right + v, r.top + u];
    case "left":
      return (u, v) => [r.left - v, r.top + u];
    case "above":
      return (u, v) => [r.left + u, r.top - v];
    default: // below
      return (u, v) => [r.left + u, r.bottom + v];
  }
}

const fmt = (n) => String(Math.round(n * 10) / 10);
const pt = ([x, y]) => `${fmt(x)} ${fmt(y)}`;

/**
 * A curly brace along the edge of `rect` facing `side`, its tip pointing at
 * the callout — the spec's "brace spanning the full height of the tray".
 * Drawn in edge-local coordinates and mapped, so one shape serves all four
 * sides. The shoulders shrink on a short edge so the curve never folds back
 * over itself.
 *
 * @returns {{d: string, tip: {x:number, y:number}}} the SVG path and the tip.
 */
export function bracePath(
  rect,
  side,
  { offset = DECOR_OFFSET, depth = BRACE_DEPTH } = {},
) {
  const r = normRect(rect);
  const s = OPPOSITE[side] ? side : "below";
  const map = edgeMapper(r, s);
  const span = s === "left" || s === "right" ? r.height : r.width;
  const q = Math.max(0, Math.min(depth / 2, span / 4));
  const m = span / 2;
  const v0 = offset;
  const v1 = offset + q;
  const tip = map(m, offset + depth);
  const d = [
    `M ${pt(map(0, v0))}`,
    `Q ${pt(map(0, v1))} ${pt(map(q, v1))}`,
    `L ${pt(map(m - q, v1))}`,
    `Q ${pt(map(m, v1))} ${pt(tip)}`,
    `Q ${pt(map(m, v1))} ${pt(map(m + q, v1))}`,
    `L ${pt(map(span - q, v1))}`,
    `Q ${pt(map(span, v1))} ${pt(map(span, v0))}`,
  ].join(" ");
  return { d, tip: { x: tip[0], y: tip[1] } };
}

/**
 * An arrow from the callout to the target: from the middle of the callout's
 * edge nearest the target to the target's facing edge (stood off by the
 * spotlight's padding, so the head lands on the lit outline, not under it).
 *
 * @param {object} rect - the target.
 * @param {object} box - the callout card's rect.
 * @param {string} side - which side of the target the callout is on.
 * @returns {{d: string, from: object, to: object}} shaft + head as one path.
 */
export function arrowPath(rect, box, side, { head = 9 } = {}) {
  const r = normRect(rect);
  const b = normRect(box);
  const stand = SPOT_PAD + 2;
  let from;
  let to;
  if (side === "above" || side === "below") {
    const x = clamp(b.left + b.width / 2, r.left + 4, r.right - 4);
    from = { x, y: side === "below" ? b.top : b.bottom };
    to = { x, y: side === "below" ? r.bottom + stand : r.top - stand };
  } else {
    const y = clamp(b.top + b.height / 2, r.top + 4, r.bottom - 4);
    from = { x: side === "right" ? b.left : b.right, y };
    to = { x: side === "right" ? r.right + stand : r.left - stand, y };
  }
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const wing = (turn) => [
    to.x - head * Math.cos(angle + turn),
    to.y - head * Math.sin(angle + turn),
  ];
  const spread = Math.PI / 7;
  const d =
    `M ${pt([from.x, from.y])} L ${pt([to.x, to.y])} ` +
    `M ${pt(wing(spread))} L ${pt([to.x, to.y])} L ${pt(wing(-spread))}`;
  return { d, from, to };
}

/** A rounded rectangle as a closed SVG subpath. */
export function roundedRectPath(rect, radius) {
  const r = normRect(rect);
  const k = Math.max(0, Math.min(radius, r.width / 2, r.height / 2));
  return (
    `M ${pt([r.left + k, r.top])} H ${fmt(r.right - k)} ` +
    `Q ${pt([r.right, r.top])} ${pt([r.right, r.top + k])} V ${fmt(r.bottom - k)} ` +
    `Q ${pt([r.right, r.bottom])} ${pt([r.right - k, r.bottom])} H ${fmt(r.left + k)} ` +
    `Q ${pt([r.left, r.bottom])} ${pt([r.left, r.bottom - k])} V ${fmt(r.top + k)} ` +
    `Q ${pt([r.left, r.top])} ${pt([r.left + k, r.top])} Z`
  );
}

/**
 * The dimming layer: the whole window, with the target's rectangle (padded,
 * rounded) cut out of it. Filled `evenodd`, so the cut-out is a hole. No
 * target, no hole — the whole app dims behind a centred message.
 */
export function spotlightPath(view, rect) {
  const outer = `M 0 0 H ${fmt(view.width)} V ${fmt(view.height)} H 0 Z`;
  const r = normRect(rect);
  if (!r) return outer;
  return `${outer} ${roundedRectPath(inflate(r, SPOT_PAD), SPOT_RADIUS)}`;
}

/** The ring decoration: the spotlight's own outline, drawn. */
export function ringPath(rect) {
  return roundedRectPath(inflate(rect, SPOT_PAD), SPOT_RADIUS);
}

// ── The fake cursor's motion ────────────────────────────────────────────────

/** Ease in and out (cubic) — a hand's move starts and stops gently. */
export function easeInOut(t) {
  const u = clamp(t, 0, 1);
  return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
}

/** The point `t` of the way from `a` to `b` (no easing). */
export function lerpPoint(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Shortest and longest cursor move, in ms (the spec's "roughly 0.5–1 s"). */
export const MOVE_MS_MIN = 500;
export const MOVE_MS_MAX = 1000;

/** How long a move of the cursor from `a` to `b` takes: longer for longer
    distances, so a hop across the toolbar and a sweep across the window
    both read as one deliberate movement. */
export function travelMs(a, b) {
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  return Math.round(
    clamp(MOVE_MS_MIN + distance * 0.6, MOVE_MS_MIN, MOVE_MS_MAX),
  );
}
