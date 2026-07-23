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

// discrete-view.js — the seated discrete parts (.layer-parts): slide switch
// with a visible slider position, push button whose cap depresses while
// held, toggle button whose cap latches on/off, and LED dome with a
// flat-side cathode cue. One SVG per part, rebuilt only when params change
// (never on camera moves); NO electrical logic here.
//
// The push button's cap is interactive VIEW state (momentary — nothing
// durable): the view owns the press gesture (capture on the cap,
// stopPropagation so the controller never starts a drag from it) and
// announces `chiphippo:part-state` for later stages. A slide switch or
// toggle button instead persists a durable param, so the CONTROLLER owns
// the write (plain click on the part).
//
// Local SVG coordinates are pitch units with the ORIGIN AT PIN 1's hole.

import { el } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { holePosition, rotateOffset } from "../model/breadboard.js";
import { partDef } from "../catalog/index.js";
import {
  buildBurnOverlay,
  buildWarnOverlay,
  STATUS_HINT,
} from "./part-symbols.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  return node;
}

/** Per-ref body boxes (pitch units, origin at pin 1's hole). */
const BOXES = Object.freeze({
  "sw-slide": Object.freeze({
    minX: -0.7,
    minY: -1.1,
    width: 3.4,
    height: 2.2,
  }),
  "sw-push": Object.freeze({ minX: -0.7, minY: -1.4, width: 3.4, height: 2.8 }),
  "sw-toggle": Object.freeze({
    minX: -0.7,
    minY: -1.4,
    width: 3.4,
    height: 2.8,
  }),
  led: Object.freeze({ minX: -0.7, minY: -1.9, width: 2.4, height: 2.9 }),
  resistor: Object.freeze({ minX: -0.7, minY: -1.1, width: 4.4, height: 2.2 }),
  // A 9-pin SIP standing over one row of holes (like the displays), body above
  // so every hole stays clickable for wiring.
  rnet9: Object.freeze({ minX: -0.7, minY: -2.9, width: 9.4, height: 3.5 }),
  // Nine holes along one row (x 0…8) with the display block standing ABOVE
  // them, so each anode's lower column holes stay clickable for wiring.
  seg8: Object.freeze({ minX: -0.7, minY: -7.7, width: 9.4, height: 8.3 }),
  // The common-anode digit is the same physical block as seg8.
  seg8ca: Object.freeze({ minX: -0.7, minY: -7.7, width: 9.4, height: 8.3 }),
  bar8: Object.freeze({ minX: -0.7, minY: -4.7, width: 9.4, height: 5.3 }),
  // A 16-pin DIP straddling the trench (row e ↔ row f, 3 pitches): the box
  // matches chipBox("DIP-16") so the block covers both leg rows and the trench,
  // leaving the rows above/below clickable — exactly as a chip does.
  bar8iso: Object.freeze({ minX: -0.6, minY: -3.6, width: 8.2, height: 4.2 }),
});

/**
 * An oscillator can's box (rot-aware, unlike every fixed BOXES entry): its
 * body is the pin rectangle plus a 0.5-pitch overhang on every side, drawn
 * canonically with pin 1 at the local origin then rotated in place — so the
 * bounding box itself shifts (and the full can's swaps width/height) as it
 * spins. Rotating the canonical body's 4 corners with the SAME primitive
 * (`rotateOffset`) the pin math uses keeps the drawn box and the resolved
 * pins from ever disagreeing.
 */
function canBox(def, rot) {
  const { width: w, height: h } = def.can;
  const corners = [
    { dx: -0.5, dy: 0.5 },
    { dx: w + 0.5, dy: 0.5 },
    { dx: w + 0.5, dy: -h - 0.5 },
    { dx: -0.5, dy: -h - 0.5 },
  ].map((c) => rotateOffset(c, rot));
  const xs = corners.map((c) => c.dx);
  const ys = corners.map((c) => c.dy);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    minX,
    minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

/**
 * Footprint box for a discrete ref (positioning + ghost sizing). `rot` only
 * matters for a `def.can` part (an oscillator can) — every fixed BOXES entry
 * ignores it.
 */
export function discreteBox(ref, rot = 0) {
  const def = partDef(ref);
  if (def?.can) return canBox(def, rot);
  const box = BOXES[ref];
  if (!box) {
    const err = new Error(`unknown discrete ref: ${ref}`);
    err.code = "INVALID_REF";
    throw err;
  }
  return box;
}

/**
 * Each span part's body, drawn about the midpoint `m` in a frame where the
 * leads run along +x — the caller rotates the group to the lead angle.
 *
 * `pad` is how far (pitch units) the body reaches beyond the leads in ANY
 * direction, since the group rotates: it sizes the SVG viewBox AND offsets the
 * element, so the two must use the same number or the body gets clipped. A
 * resistor's body is only half a unit off its leads; an LED's dome stands a
 * whole unit off and is 0.85 across, so it needs more than twice the room.
 */
const SPAN_BODIES = Object.freeze({
  resistor: Object.freeze({
    pad: 0.9, // body half-height 0.5 (the 1.6-wide hit stroke wants 0.8)
    build: (m) => [
      svgEl("rect", {
        class: "part-resistor-body",
        x: m.x - 1,
        y: m.y - 0.5,
        width: 2,
        height: 1,
        rx: 0.4,
      }),
      ...[-0.4, 0, 0.4].map((off) =>
        svgEl("rect", {
          class: "part-resistor-band",
          x: m.x + off - 0.07,
          y: m.y - 0.45,
          width: 0.14,
          height: 0.9,
        }),
      ),
    ],
  }),
  // Dome above the leads with the flat chord marking the CATHODE side — pin 2
  // by default, mirrored to pin 1's side when flipped.
  led: Object.freeze({
    pad: 2, // dome centre 1 off the leads + radius 0.85, plus a hair
    build: (m, params) => [
      svgEl("circle", {
        class: `part-led-dome part-led-dome--${params.color ?? "red"}`,
        cx: m.x,
        cy: m.y - 1,
        r: 0.85,
      }),
      svgEl("rect", {
        class: "part-led-flat",
        x: m.x + (params.flip ? -0.65 : 0.65) - 0.07,
        y: m.y - 1.75,
        width: 0.14,
        height: 1.5,
      }),
    ],
  }),
});

const DEFAULT_SPAN_PAD = 0.9;

/** The viewBox padding for a span part — shared by the SVG builder and the
    placement math so the drawn body is never clipped. */
export function spanPad(ref) {
  return SPAN_BODIES[ref]?.pad ?? DEFAULT_SPAN_PAD;
}

/**
 * A two-free-ends part drawn between pin 1 (local origin) and pin 2 at
 * (dx, dy) pitch units — a straight lead with the part's body centred over the
 * middle and rotated to the lead angle. Handles ANY angle (rail↔column leads
 * bend when the two holes aren't aligned). Pure DOM construction.
 */
export function buildSpanSvg(ref, dx, dy, params = {}) {
  const pad = spanPad(ref);
  const minX = Math.min(0, dx) - pad;
  const minY = Math.min(0, dy) - pad;
  const width = Math.abs(dx) + 2 * pad;
  const height = Math.abs(dy) + 2 * pad;
  const midX = dx / 2;
  const midY = dy / 2;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;

  const svg = svgEl("svg", {
    class: `part-discrete-svg part-discrete-svg--${ref} part-discrete-svg--rotated`,
    viewBox: `${minX} ${minY} ${width} ${height}`,
    width: width * PX_PER_UNIT,
    height: height * PX_PER_UNIT,
    "aria-hidden": "true",
  });
  // The lead runs straight from hole to hole; the body rides over the middle,
  // rotated to align with the lead. The widened invisible hit stroke (the same
  // sanctioned exception the wires use) is the ONLY part that takes the
  // pointer — a long span's box would otherwise swallow clicks on the holes
  // underneath it.
  svg.append(
    svgEl("line", {
      class: "part-span-hit",
      x1: 0,
      y1: 0,
      x2: dx,
      y2: dy,
    }),
    svgEl("line", {
      class: "part-span-lead",
      x1: 0,
      y1: 0,
      x2: dx,
      y2: dy,
    }),
  );
  const spec = SPAN_BODIES[ref];
  if (spec) {
    const body = svgEl("g", { transform: `rotate(${angle} ${midX} ${midY})` });
    body.append(...spec.build({ x: midX, y: midY }, params));
    svg.append(body);
  }
  // Burn-out overlay (CSS shows it only on .part-discrete--burnt): a red X over
  // the LED plus smoke. The dome sits one unit off the leads, so after the
  // body's rotation it lands here — smoke must rise in SCREEN space, not the
  // rotated frame, so it's built outside the rotated group.
  if (ref === "led") {
    const rad = (angle * Math.PI) / 180;
    svg.append(buildBurnOverlay(midX + Math.sin(rad), midY - Math.cos(rad)));
  }
  return svg;
}

/** Points for a hexagonal 7-seg HORIZONTAL bar centred at (cx, cy). */
function hSegPoints(cx, cy, len, t) {
  const h = t / 2;
  const x0 = cx - len / 2;
  const x1 = cx + len / 2;
  return `${x0},${cy} ${x0 + h},${cy - h} ${x1 - h},${cy - h} ${x1},${cy} ${x1 - h},${cy + h} ${x0 + h},${cy + h}`;
}

/** Points for a hexagonal 7-seg VERTICAL bar centred at (cx, cy). */
function vSegPoints(cx, cy, len, t) {
  const h = t / 2;
  const y0 = cy - len / 2;
  const y1 = cy + len / 2;
  return `${cx},${y0} ${cx - h},${y0 + h} ${cx - h},${y1 - h} ${cx},${y1} ${cx + h},${y1 - h} ${cx + h},${y0 + h}`;
}

/** Nine short pin legs from the block's bottom edge down to holes 0…8. */
function appendDisplayLegs(svg, edgeY) {
  for (let i = 0; i <= 8; i++) {
    svg.append(
      svgEl("rect", {
        class: "part-led-leg",
        x: i - 0.1,
        y: edgeY,
        width: 0.2,
        height: -edgeY,
      }),
    );
  }
}

/**
 * The single-block 8-segment digit (7 bars a–g + decimal point), common
 * cathode. Each lit-able element carries `data-seg` so the view can light it;
 * the whole block takes its colour from an inherited --wire-color.
 */
function buildDigitDisplay(svg, color) {
  svg.style.setProperty("--wire-color", `var(--color-wire-${color})`);
  const bodyY = -7.4;
  const edgeY = -0.6;
  svg.append(
    svgEl("rect", {
      class: "part-display-body",
      x: -0.45,
      y: bodyY,
      width: 8.9,
      height: edgeY - bodyY,
      rx: 0.5,
    }),
  );
  appendDisplayLegs(svg, edgeY);

  const t = 0.5;
  const cx = 4;
  const hw = 1.4; // vertical bars sit ±hw off centre
  const yT = -6.5;
  const yM = -4.05;
  const yB = -1.6;
  const yUp = (yT + yM) / 2; // upper verticals (f, b)
  const yDn = (yM + yB) / 2; // lower verticals (e, c)
  const lh = 2.4;
  const lv = 2.1;
  const bars = [
    ["a", hSegPoints(cx, yT, lh, t)],
    ["b", vSegPoints(cx + hw, yUp, lv, t)],
    ["c", vSegPoints(cx + hw, yDn, lv, t)],
    ["d", hSegPoints(cx, yB, lh, t)],
    ["e", vSegPoints(cx - hw, yDn, lv, t)],
    ["f", vSegPoints(cx - hw, yUp, lv, t)],
    ["g", hSegPoints(cx, yM, lh, t)],
  ];
  for (const [id, points] of bars) {
    svg.append(svgEl("polygon", { class: "part-seg", "data-seg": id, points }));
  }
  svg.append(
    svgEl("circle", {
      class: "part-seg",
      "data-seg": "dp",
      cx: cx + hw + 0.9,
      cy: yB,
      r: 0.32,
    }),
  );
  svg.append(buildBurnOverlay(cx, (yT + yB) / 2));
  // Body-only hit target: the block drags, the holes underneath stay clickable.
  svg.append(
    svgEl("rect", {
      class: "part-display-hit",
      x: -0.45,
      y: bodyY,
      width: 8.9,
      height: edgeY - bodyY,
    }),
  );
}

/** The 8-segment LED bar graph (eight bars over holes 0…7), common cathode. */
function buildBarDisplay(svg, color) {
  svg.style.setProperty("--wire-color", `var(--color-wire-${color})`);
  const bodyY = -4.4;
  const edgeY = -0.6;
  svg.append(
    svgEl("rect", {
      class: "part-display-body",
      x: -0.45,
      y: bodyY,
      width: 8.9,
      height: edgeY - bodyY,
      rx: 0.35,
    }),
  );
  appendDisplayLegs(svg, edgeY);
  for (let i = 0; i < 8; i++) {
    svg.append(
      svgEl("rect", {
        class: "part-seg",
        "data-seg": `s${i + 1}`,
        x: i - 0.28,
        y: -4.0,
        width: 0.56,
        height: 3.0,
        rx: 0.14,
      }),
    );
  }
  svg.append(buildBurnOverlay(4, -2.4, 0.7));
  svg.append(
    svgEl("rect", {
      class: "part-display-hit",
      x: -0.45,
      y: bodyY,
      width: 8.9,
      height: edgeY - bodyY,
    }),
  );
}

/**
 * The isolated 8-segment LED bar array (bar8iso): a 16-pin DIP straddling the
 * trench, eight INDEPENDENT bars each with its own anode (row e, local y 0) and
 * cathode (row f, local y -3, three pitches up). The body is a chip-like slab
 * over the trench with the eight bars drawn on it; legs reach both hole rows.
 */
function buildBarArrayDisplay(svg, color) {
  svg.style.setProperty("--wire-color", `var(--color-wire-${color})`);
  const bodyTop = -2.55;
  const bodyBottom = -0.45;
  // Legs: down from the slab to each row-e hole, up from each row-f hole (y=-3).
  for (let c = 0; c <= 7; c++) {
    svg.append(
      svgEl("rect", {
        class: "part-led-leg",
        x: c - 0.14,
        y: bodyBottom - 0.05,
        width: 0.28,
        height: 0.6,
      }),
      svgEl("rect", {
        class: "part-led-leg",
        x: c - 0.14,
        y: -3.1,
        width: 0.28,
        height: bodyTop + 3.1,
      }),
    );
  }
  svg.append(
    svgEl("rect", {
      class: "part-display-body",
      x: -0.5,
      y: bodyTop,
      width: 8,
      height: bodyBottom - bodyTop,
      rx: 0.3,
    }),
  );
  // Eight vertical bars, one per column: bar s(c+1) over the anode at column c.
  for (let c = 0; c <= 7; c++) {
    svg.append(
      svgEl("rect", {
        class: "part-seg",
        "data-seg": `s${c + 1}`,
        x: c - 0.28,
        y: bodyTop + 0.25,
        width: 0.56,
        height: bodyBottom - bodyTop - 0.5,
        rx: 0.14,
      }),
    );
  }
  svg.append(buildBurnOverlay(3.5, (bodyTop + bodyBottom) / 2, 0.9));
  svg.append(
    svgEl("rect", {
      class: "part-display-hit",
      x: -0.5,
      y: bodyTop,
      width: 8,
      height: bodyBottom - bodyTop,
    }),
  );
}

/**
 * A crystal-oscillator can (osc-full/osc-half): a rigid rectangular body with
 * legs only at its 4 corners (`def.can` — see catalog/parts.js), free to seat
 * anywhere and spin in true 90° steps. The body/legs/dot/badge are drawn ONCE
 * in canonical (rot 0) local coordinates with pin 1 (NC) at the origin, then
 * wrapped in an SVG `rotate()` group: pin 1 sits exactly at the pivot, so its
 * own leg never moves in the drawing — the body and the other 3 legs swing
 * around it, exactly matching how the pins themselves resolve
 * (model/occupancy.js's `def.can` branch, both sharing model/breadboard.js's
 * `rotateOffset`). The fault-status overlay stays OUTSIDE the rotated group
 * (screen space — smoke must rise), so its centre is rotated separately.
 */
function buildOscillatorCan(svg, def, params) {
  const { width: w, height: h } = def.can;
  const rot = params.rot ?? 0;
  const bodyX = -0.5;
  const bodyY = -h - 0.5;
  const bodyWidth = w + 1;
  const bodyHeight = h + 1;

  const spin = svgEl("g", {
    class: "part-can-spin",
    transform: `rotate(${rot})`,
  });
  // Corner legs: pin 1 (NC) bottom-left, pin 2 (GND) bottom-right, pin 3
  // (OUT) top-right, pin 4 (VCC) top-left — the canonical order
  // model/occupancy.js's `def.can` branch derives the other 3 pins from.
  for (const { x, yFrom, yTo } of [
    { x: 0, yFrom: 0, yTo: 0.5 },
    { x: w, yFrom: 0, yTo: 0.5 },
    { x: w, yFrom: -h - 0.5, yTo: -h },
    { x: 0, yFrom: -h - 0.5, yTo: -h },
  ]) {
    spin.append(
      svgEl("rect", {
        class: "part-chip-leg",
        x: x - 0.14,
        y: Math.min(yFrom, yTo),
        width: 0.28,
        height: Math.abs(yTo - yFrom),
      }),
    );
  }
  spin.append(
    svgEl("rect", {
      class: "part-can-body",
      x: bodyX,
      y: bodyY,
      width: bodyWidth,
      height: bodyHeight,
      rx: 0.3,
    }),
    svgEl("rect", {
      class: "part-can-rim",
      x: bodyX + 0.22,
      y: bodyY + 0.22,
      width: bodyWidth - 0.44,
      height: bodyHeight - 0.44,
      rx: 0.16,
    }),
    // Pin-1 cue, inset from the corner nearest the anchor.
    svgEl("circle", {
      class: "part-can-dot",
      cx: bodyX + 0.32,
      cy: bodyY + bodyHeight - 0.32,
      r: 0.12,
    }),
  );
  const badge = svgEl("text", {
    class: "part-can-badge",
    x: w / 2,
    y: -h / 2 + 0.3,
    "text-anchor": "middle",
  });
  badge.textContent = `${params.hz} Hz`;
  spin.append(badge);
  // Body-only hit target: the can drags, the holes underneath stay clickable.
  spin.append(
    svgEl("rect", {
      class: "part-display-hit",
      x: bodyX,
      y: bodyY,
      width: bodyWidth,
      height: bodyHeight,
    }),
  );
  svg.append(spin);

  // Fault symbols stay in SCREEN space (smoke must rise): the canonical
  // centre, rotated the same way the drawing group was.
  const center = rotateOffset({ dx: w / 2, dy: -h / 2 }, rot);
  const status = svgEl("g", { class: "part-can-status" });
  status.append(
    svgEl("title"), // hover hint; text set by DiscreteView.setStatus
    buildWarnOverlay(center.dx, center.dy, 0.6),
    buildBurnOverlay(center.dx, center.dy, 0.6),
  );
  svg.append(status);
}

/** A compact ohms label: 10000 → "10k", 4700000 → "4.7M", 220 → "220". */
function formatOhms(ohms) {
  if (ohms >= 1e6) return `${+(ohms / 1e6).toFixed(2)}M`;
  if (ohms >= 1e3) return `${+(ohms / 1e3).toFixed(2)}k`;
  return String(ohms);
}

/**
 * The bussed resistor array (rnet9): a 9-pin SIP standing over one row of
 * holes, its beige body printed with the value and a dot marking the common
 * bus (pin 9, x=8). Like the displays, the body stands ABOVE the legs so every
 * hole underneath stays clickable.
 */
function buildResistorNetwork(svg, ohms) {
  const edgeY = -0.6;
  const bodyY = -2.4;
  appendDisplayLegs(svg, edgeY); // nine legs down to holes 0…8
  svg.append(
    svgEl("rect", {
      class: "part-rnet-body",
      x: -0.45,
      y: bodyY,
      width: 8.9,
      height: edgeY - bodyY,
      rx: 0.25,
    }),
  );
  // A dot over pin 9 marks the shared/common bus end.
  svg.append(
    svgEl("circle", {
      class: "part-rnet-dot",
      cx: 8,
      cy: bodyY + 0.42,
      r: 0.22,
    }),
  );
  const label = svgEl("text", {
    class: "part-rnet-label",
    x: 4,
    y: (bodyY + edgeY) / 2 + 0.3,
    "text-anchor": "middle",
  });
  label.textContent = formatOhms(ohms);
  svg.append(label);
  // Body-only hit target: the block drags, the holes underneath stay clickable.
  svg.append(
    svgEl("rect", {
      class: "part-display-hit",
      x: -0.45,
      y: bodyY,
      width: 8.9,
      height: edgeY - bodyY,
    }),
  );
}

/**
 * Build a discrete part's SVG from its catalog def + params. Pure DOM
 * construction (unit-testable under jsdom).
 */
export function buildDiscreteSvg(ref, params = {}) {
  const def = partDef(ref);
  const normalized = def.normalizeParams(params);
  const box = discreteBox(ref, normalized.rot);

  const svg = svgEl("svg", {
    class: `part-discrete-svg part-discrete-svg--${ref}`,
    viewBox: `${box.minX} ${box.minY} ${box.width} ${box.height}`,
    width: box.width * PX_PER_UNIT,
    height: box.height * PX_PER_UNIT,
    "aria-hidden": "true",
  });

  if (ref === "sw-slide") {
    // Body over the three holes, slot, and the knob at position 1 or 2.
    svg.append(
      svgEl("rect", {
        class: "part-body",
        x: -0.6,
        y: -1,
        width: 3.2,
        height: 2,
        rx: 0.2,
      }),
      svgEl("rect", {
        class: "part-slide-slot",
        x: -0.25,
        y: -0.35,
        width: 2.5,
        height: 0.7,
        rx: 0.15,
      }),
      svgEl("rect", {
        class: "part-slide-knob",
        x: normalized.pos === "2" ? 1.15 : -0.15,
        y: -0.45,
        width: 1,
        height: 0.9,
        rx: 0.15,
      }),
    );
  } else if (ref === "sw-push") {
    // Square tactile body spanning the two holes (0 and +2), round cap.
    svg.append(
      svgEl("rect", {
        class: "part-body",
        x: -0.6,
        y: -1.3,
        width: 3.2,
        height: 2.6,
        rx: 0.25,
      }),
      svgEl("circle", {
        class: "part-button-cap",
        cx: 1,
        cy: 0,
        r: 0.85,
      }),
    );
  } else if (ref === "sw-toggle") {
    // Same body as sw-push, but the cap LATCHES: params.on (persisted, a
    // controller click flips it) drives the cap's own on-state, not a
    // transient pointer-held class.
    svg.append(
      svgEl("rect", {
        class: "part-body",
        x: -0.6,
        y: -1.3,
        width: 3.2,
        height: 2.6,
        rx: 0.25,
      }),
      svgEl("circle", {
        class: normalized.on
          ? "part-toggle-cap part-toggle-cap--on"
          : "part-toggle-cap",
        cx: 1,
        cy: 0,
        r: 0.85,
      }),
    );
  } else if (ref === "resistor") {
    // Axial resistor: a lead to each end hole (0 and +3) with a banded body
    // between them. Purely cosmetic — value/orientation don't affect the sim.
    svg.append(
      svgEl("rect", {
        class: "part-resistor-lead",
        x: 0,
        y: -0.06,
        width: 0.6,
        height: 0.12,
      }),
      svgEl("rect", {
        class: "part-resistor-lead",
        x: 2.4,
        y: -0.06,
        width: 0.6,
        height: 0.12,
      }),
      svgEl("rect", {
        class: "part-resistor-body",
        x: 0.5,
        y: -0.5,
        width: 2,
        height: 1,
        rx: 0.4,
      }),
      ...[0.85, 1.25, 1.65].map((x) =>
        svgEl("rect", {
          class: "part-resistor-band",
          x,
          y: -0.45,
          width: 0.14,
          height: 0.9,
        }),
      ),
    );
  } else if (ref === "seg8" || ref === "seg8ca") {
    buildDigitDisplay(svg, normalized.color);
  } else if (ref === "bar8") {
    buildBarDisplay(svg, normalized.color);
  } else if (ref === "bar8iso") {
    buildBarArrayDisplay(svg, normalized.color);
  } else if (ref === "osc-full" || ref === "osc-half") {
    buildOscillatorCan(svg, def, normalized);
  } else if (ref === "rnet9") {
    buildResistorNetwork(svg, normalized.ohms);
  } else {
    // LED dome over the two holes; the flat chord marks the CATHODE side
    // (right by default — pin 2; params.flip mirrors it to the left).
    const cathodeRight = !normalized.flip;
    const flatX = cathodeRight ? 1.15 : -0.15;
    svg.append(
      svgEl("rect", {
        class: "part-led-leg",
        x: -0.12,
        y: -0.7,
        width: 0.24,
        height: 0.85,
      }),
      svgEl("rect", {
        class: "part-led-leg",
        x: 0.88,
        y: -0.7,
        width: 0.24,
        height: 0.85,
      }),
      svgEl("circle", {
        class: `part-led-dome part-led-dome--${normalized.color}`,
        cx: 0.5,
        cy: -1,
        r: 0.85,
      }),
      svgEl("rect", {
        class: "part-led-flat",
        x: flatX,
        y: -1.75,
        width: 0.14,
        height: 1.5,
      }),
    );
  }
  return svg;
}

export class DiscreteView {
  #el;
  #id;
  #ref;
  #rotated = false; // a two-free-ends part — rendered/placed as a span
  #params = {}; // latest params (the span body needs LED colour/flip)

  /**
   * @param {HTMLElement} layer - the `.layer-parts` element.
   * @param {{id:string,ref:string,params:object}} component
   * @param {object} [callbacks]
   * @param {(id: string, e: PointerEvent) => void} [callbacks.onPointerDown]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onContextMenu]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onDoubleClick] -
   *   opens the pin-assignments window (Feature 100 wiring aid).
   */
  constructor(
    layer,
    component,
    { onPointerDown, onContextMenu, onDoubleClick } = {},
  ) {
    this.#id = component.id;
    this.#ref = component.ref;
    // EVERY rotatable part renders as a span (body centred between its two
    // ends, rotated to the lead angle) — the controller draws it via
    // updateSpanWorld.
    this.#rotated = Boolean(partDef(component.ref)?.rotatable);
    this.#params = component.params ?? {};
    this.#el = el("div", {
      class: `part part-discrete part-discrete--${component.ref}`,
      dataset: { componentId: component.id },
    });
    // A rotated resistor's SVG needs desk geometry (both end positions), so the
    // controller renders it via updateSpanWorld right after construction.
    if (!this.#rotated) this.updateParams(component.params);
    this.#el.addEventListener("pointerdown", (e) =>
      onPointerDown?.(this.#id, e),
    );
    this.#el.addEventListener("contextmenu", (e) =>
      onContextMenu?.(this.#id, e),
    );
    this.#el.addEventListener("dblclick", (e) => onDoubleClick?.(this.#id, e));
    layer.append(this.#el);
  }

  get id() {
    return this.#id;
  }

  get ref() {
    return this.#ref;
  }

  get element() {
    return this.#el;
  }

  /** Rebuild the SVG for new params (slider position, LED color/flip). A
      span part is rendered by updateSpanWorld (needs geometry), so skip. */
  updateParams(params) {
    this.#params = params ?? {};
    this.#rotated = Boolean(partDef(this.#ref)?.rotatable);
    if (this.#rotated) return;
    this.#el.querySelector("svg")?.remove();
    this.#el.prepend(buildDiscreteSvg(this.#ref, params));
    if (this.#ref === "sw-push") this.#bindCap();
  }

  /**
   * Render + position a resistor spanning two ABSOLUTE world points (pitch
   * units). The span is pure geometry — pin 1's hole plus the lead's bend — so
   * it draws the same whether the far lead lands on a neighbouring strip, sits
   * off-hole mid-drag, or floats over bare desk.
   */
  updateSpanWorld(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    this.#rotated = true;
    this.#el.querySelector("svg")?.remove();
    this.#el.prepend(buildSpanSvg(this.#ref, dx, dy, this.#params));
    const pad = spanPad(this.#ref);
    const minX = Math.min(0, dx) - pad;
    const minY = Math.min(0, dy) - pad;
    this.#el.style.left = `${(p1.x + minX) * PX_PER_UNIT}px`;
    this.#el.style.top = `${(p1.y + minY) * PX_PER_UNIT}px`;
  }

  /** The momentary press gesture lives here — transient view state only. */
  #bindCap() {
    const cap = this.#el.querySelector(".part-button-cap");
    const setPressed = (on) => {
      this.#el.classList.toggle("part-discrete--pressed", on);
      window.dispatchEvent(
        new CustomEvent("chiphippo:part-state", {
          detail: { id: this.#id, ref: this.#ref, state: { pressed: on } },
        }),
      );
    };
    cap.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation(); // never starts a select/drag
      try {
        cap.setPointerCapture(e.pointerId);
      } catch {
        /* best-effort */
      }
      setPressed(true);
      const release = () => setPressed(false);
      cap.addEventListener("pointerup", release, { once: true });
      cap.addEventListener("pointercancel", release, { once: true });
    });
  }

  /** Seat the element: board origin + anchor hole + the footprint box. */
  updatePlacement(board, anchor) {
    const pos = holePosition(board.type, anchor, board.rot ?? 0);
    if (!pos) return;
    const box = discreteBox(this.#ref, this.#params?.rot);
    this.#el.style.left = `${(board.x + pos.x + box.minX) * PX_PER_UNIT}px`;
    this.#el.style.top = `${(board.y + pos.y + box.minY) * PX_PER_UNIT}px`;
  }

  /**
   * A bent lead touching no hole — what a part is left with when the strip
   * under it is moved or deleted away. Legal, so the part keeps its position
   * and span; the cue only says the connection is gone.
   */
  setFloating(on) {
    this.#el.classList.toggle("part-discrete--floating", on);
  }

  /** Light an LED (Feature 90): bright body + glow while its diode conducts. */
  setLit(on) {
    this.#el.classList.toggle("part-discrete--lit", on);
  }

  /** Burnt out — powered with no series resistor: red X + rising smoke. */
  setBurnt(on) {
    this.#el.classList.toggle("part-discrete--burnt", on);
  }

  /**
   * Reflect the simulator's power/health status (Feature 90) — only an
   * oscillator can actually has a status overlay to reveal; every other
   * discrete's classList toggle is a harmless no-op. `null` clears it.
   */
  setStatus(status) {
    for (const s of ["unpowered", "underpowered", "reversed", "damaged"]) {
      this.#el.classList.toggle(`part-discrete--${s}`, status === s);
    }
    const title = this.#el.querySelector(".part-can-status > title");
    if (title) title.textContent = STATUS_HINT[status] ?? "";
  }

  /** Light one segment of a multi-segment display (anode-H / cathode-L). */
  setSegmentLit(segId, on) {
    this.#el
      .querySelector(`[data-seg="${segId}"]`)
      ?.classList.toggle("part-seg--lit", on);
  }

  /** Mark one segment over-driven (conducting with no series resistor). */
  setSegmentBurnt(segId, on) {
    this.#el
      .querySelector(`[data-seg="${segId}"]`)
      ?.classList.toggle("part-seg--burnt", on);
  }

  setSelected(on) {
    this.#el.classList.toggle("part--selected", on);
  }

  setDragging(on) {
    this.#el.classList.toggle("part--dragging", on);
  }

  setIllegal(on) {
    this.#el.classList.toggle("part--illegal", on);
  }

  remove() {
    this.#el.remove();
  }
}
