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

// wire-gauge.js — a wire drawn as a WORKSHOP DRAWING, the last field of a wire's
// Properties dialog (the `"wire-gauge"` field type — see
// part-properties-dialog.js). The jumper lies straight across the full width of
// the card in its own colour, its sleeve stripped back at both ends to the bare
// tinned lead that actually goes in a hole, and a dimensioned line beneath it
// states how long it is in centimetres.
//
// It answers the one question the desk cannot: which lead out of the drawer is
// this. A wire on the desk is a curve between two holes at whatever zoom the
// camera happens to be at, so "how much wire is that" is unreadable there — but
// it is exactly what you need before cutting one.
//
// **THE CALLER GIVES THE RUN; THE WIRE IS THE RUN PLUS TWO STRIPS.** A lead does
// not stop at the surface of the board — it has to reach INTO both holes, so a
// jumper crossing one 2.54 mm pitch is 2.54 + 2 × STRIP_MM ≈ 13 mm of wire, not
// 3 mm. So this module is handed the run between the two holes and adds the strip
// at each end through `wireTotalMm`, which — along with STRIP_MM itself and the
// length FORMAT — belongs to model/wire-length.js, because the Bill of Materials
// states the same numbers about the same wires and the two must not diverge. Both
// halves of the drawing follow from that and agree with each other: the SLEEVE
// covers exactly the run (what the sleeved part of a real jumper spans, hole to
// hole), the bare tips are the strips, and the dimension line spans the lot,
// which is the length you cut.
//
// TO SCALE, WITHIN REASON. The drawing is a fixed width whatever the wire
// measures, so the ONE thing it can be honest about is the RATIO: each strip is
// drawn as its share of the whole wire, which is why a short hop shows generous
// copper and a long haul shows a whisker. Two clamps: a bare end never falls
// below MIN_BARE (a tip too small to see defeats the reason for drawing one) and
// never takes more than MAX_BARE_SHARE, which is derived from the SHORTEST wire
// this app can hold — so it can never bind on a real one and exists only to stop
// a nonsense length drawing an all-copper line. The dimension states the truth
// exactly either way.
//
// Pure DOM over one `<svg>`: it takes a colour token and a run in mm and knows
// nothing about wires, documents, or the dialog it sits in. The colour rides the
// SAME `--wire-color` custom property the desk's own wires and the toolbar's
// colour dot use, so the dialog repaints it on a colour pick by setting that one
// property rather than rebuilding the drawing.

import { t } from "../i18n.js";
import { svgEl } from "../dom.js";
import { MM_PER_UNIT } from "../desk/desk-geometry.js";
// The measurement, the strip, and the one length FORMAT all live in the model —
// the BOM states the same numbers about the same wires (model/wire-length.js).
import {
  STRIP_MM,
  wireLengthLabel,
  wireTotalMm,
} from "../model/wire-length.js";

/** The drawing's own coordinate space. CSS gives the element `width: 100%`, so
    the viewBox is what fixes its proportions rather than its size — it spans
    whatever the dialog is wide and scales its own height to match. */
const VIEW_W = 300;
const VIEW_H = 62;

/** Room at each end for half a stroke, so a lead's tip is never clipped. */
const INSET = 2;

/** The wire's centre line, and the dimension line below it. */
const WIRE_Y = 17;
const DIM_Y = 49;

/** How far a bare lead runs UNDER the sleeve, so the two read as one wire
    rather than three pieces laid end to end. */
const LEAD_OVERLAP = 2;

/** The least bare lead the drawing shows (drawing units) — below this a stripped
    end is not visibly one. */
const MIN_BARE = 7;

/** And the most, as a share of the whole wire: exactly the share the SHORTEST
    wire this app can hold has — one pitch hole to hole, plus both strips. Every
    real wire is longer than that (and its drawn run is longer still, since it
    sags), so this ceiling can never bind on one; it is here to stop a length of
    zero or nonsense drawing a line with no sleeve left in it. */
const MAX_BARE_SHARE = STRIP_MM / wireTotalMm(MM_PER_UNIT);

/** Dimension-line furniture: the arrowhead's length and half-height, how far
    below the wire a witness line starts, how far past the dimension line it
    runs on, and how far above it the measurement sits. */
const ARROW = 8;
const ARROW_HALF = 3;
const WITNESS_GAP = 8;
const WITNESS_PAST = 6;
const TEXT_LIFT = 7;

/** Trim float noise out of a generated coordinate. */
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * How much bare lead to draw at each end (drawing units): one STRIP_MM as its
 * share of the WHOLE wire (strips included, per `wireTotalMm`), clamped to stay
 * both visible and short of the whole drawing. A total of zero or less (nothing
 * sensible to scale against) shows the maximum, which is the most honest thing a
 * scale-free drawing can do.
 */
export function bareLead(span, totalMm) {
  const max = span * MAX_BARE_SHARE;
  if (!(totalMm > 0)) return max;
  return Math.max(MIN_BARE, Math.min(max, span * (STRIP_MM / totalMm)));
}

/** The three runs that depend on how long the wire is — where each stripped end
    reaches, and the sleeve between them, which covers exactly the hole-to-hole
    RUN. Everything else (the dimension line, its witnesses and arrowheads) spans
    the drawing whatever the wire measures, which is why re-measuring touches
    only these. */
function geometry(runMm) {
  const x0 = INSET;
  const x1 = VIEW_W - INSET;
  const bare = bareLead(x1 - x0, wireTotalMm(runMm));
  return {
    leadA: `M ${x0} ${WIRE_Y} H ${r2(x0 + bare + LEAD_OVERLAP)}`,
    leadB: `M ${x1} ${WIRE_Y} H ${r2(x1 - bare - LEAD_OVERLAP)}`,
    sleeve: `M ${r2(x0 + bare)} ${WIRE_Y} H ${r2(x1 - bare)}`,
  };
}

/** The measurement: the WHOLE wire — the run plus both strips, i.e. the length
    you would cut — through the shared formatter, so this dimension and the BOM's
    line for the same wire can never read differently. */
const measurement = (runMm) => wireLengthLabel(wireTotalMm(runMm));

/** One end's arrowhead, tip ON the extension line and pointing outward
    (`dir` is +1 at the left end, −1 at the right). */
const arrowHead = (x, dir) =>
  `M ${r2(x)} ${DIM_Y} L ${r2(x + dir * ARROW)} ${DIM_Y - ARROW_HALF} ` +
  `L ${r2(x + dir * ARROW)} ${DIM_Y + ARROW_HALF} Z`;

/**
 * Build the drawing: one `<svg>`, sized by CSS, coloured through
 * `--wire-color`.
 *
 * @param {object} opts
 * @param {string} opts.color - a wire colour name (`WIRE_COLORS`), which names
 *   the `--color-wire-<name>` token the sleeve is drawn in.
 * @param {number} opts.runMm - the run the wire crosses, hole to hole, in
 *   millimetres. The strip at each end is added here (`wireTotalMm`), so this is
 *   the number the desk measures, not the length that gets dimensioned.
 * @returns {SVGElement}
 */
export function buildWireGauge({ color, runMm }) {
  const x0 = INSET;
  const x1 = VIEW_W - INSET;
  const { leadA, leadB, sleeve } = geometry(runMm);
  const length = measurement(runMm);

  const measure = svgEl("text", {
    class: "wire-gauge-length",
    x: VIEW_W / 2,
    y: DIM_Y - TEXT_LIFT,
    "text-anchor": "middle",
  });
  measure.textContent = length;

  const svg = svgEl(
    "svg",
    {
      class: "wire-gauge",
      viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
      // One picture, so one label — the measurement it already shows.
      role: "img",
      "aria-label": t("wire.gaugeLabel", { length }),
    },
    [
      // The stripped ends first, so the sleeve is drawn OVER the stretch they
      // run beneath. Each is a round-capped stub: a cut conductor, not a point.
      svgEl("path", { class: "wire-gauge-lead", d: leadA }),
      svgEl("path", { class: "wire-gauge-lead", d: leadB }),
      // The insulation: the desk's own outline-under-core pair, with BUTT caps,
      // so each end reads as sleeve that was CUT rather than rounded off.
      svgEl("path", { class: "wire-gauge-sleeve-outline", d: sleeve }),
      svgEl("path", { class: "wire-gauge-sleeve", d: sleeve }),
      // The dimension: witness lines down from each tip, an arrowheaded line
      // between them, and the measurement above it.
      svgEl("g", { class: "wire-gauge-dim" }, [
        svgEl("path", {
          class: "wire-gauge-witness",
          d: `M ${x0} ${WIRE_Y + WITNESS_GAP} V ${DIM_Y + WITNESS_PAST}`,
        }),
        svgEl("path", {
          class: "wire-gauge-witness",
          d: `M ${x1} ${WIRE_Y + WITNESS_GAP} V ${DIM_Y + WITNESS_PAST}`,
        }),
        svgEl("path", {
          class: "wire-gauge-dim-line",
          d: `M ${x0} ${DIM_Y} H ${x1}`,
        }),
        svgEl("path", { class: "wire-gauge-arrow", d: arrowHead(x0, 1) }),
        svgEl("path", { class: "wire-gauge-arrow", d: arrowHead(x1, -1) }),
        measure,
      ]),
    ],
  );
  // el()'s prop bag can't set a CUSTOM property (CSSStyleDeclaration ignores
  // plain assignment for `--*` keys), and this is the same one every wire on the
  // desk carries — see color-swatches.js and wire-layer.js.
  svg.style.setProperty("--wire-color", `var(--color-wire-${color})`);
  return svg;
}

/** Repaint an already-built drawing in another colour — what the Properties
    dialog does when a colour swatch is picked, since it applies live and never
    rebuilds its own rows. */
export function setWireGaugeColor(svg, color) {
  svg.style.setProperty("--wire-color", `var(--color-wire-${color})`);
}

/**
 * Re-measure an already-built drawing against a new hole-to-hole `runMm`: the
 * stripped ends move to their share of the new whole, and the dimension states
 * the new figure. The dialog does this after EVERY change, because a wire's
 * length is not its own property — switching Layout Method to Direct throws its
 * bends away and shortens it, and a dimension drawing showing the length before
 * that is simply wrong.
 */
export function setWireGaugeRun(svg, runMm) {
  const { leadA, leadB, sleeve } = geometry(runMm);
  const [a, b] = svg.querySelectorAll(".wire-gauge-lead");
  a.setAttribute("d", leadA);
  b.setAttribute("d", leadB);
  for (const path of svg.querySelectorAll(
    ".wire-gauge-sleeve, .wire-gauge-sleeve-outline",
  )) {
    path.setAttribute("d", sleeve);
  }
  const length = measurement(runMm);
  svg.querySelector(".wire-gauge-length").textContent = length;
  svg.setAttribute("aria-label", t("wire.gaugeLabel", { length }));
}
