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

// jsdom tests for the wire's own workshop drawing (components/wire-gauge.js):
// the sleeve, the two stripped ends, and the dimension line under them.
//
// Every case is stated as the RUN the caller hands over — hole to hole — because
// that is the module's input; the wire it draws and dimensions is that run PLUS a
// strip at each end, since a lead has to reach into both holes.
//
// The one thing a fixed-width drawing can be honest about is the RATIO of
// stripped lead to whole wire, so that is what most of this pins: a short hop
// shows generous copper, a long haul a whisker, and neither clamp is allowed to
// swallow the other.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { bareLead, buildWireGauge, setWireGaugeColor, setWireGaugeRun } =
  await import("../components/wire-gauge.js");
// The strip, the total and the length format belong to the model — the BOM states
// the same numbers about the same wires (model/wire-length.js).
const { STRIP_MM, wireTotalMm } = await import("../model/wire-length.js");

/** Where a path's horizontal run starts and ends: `M x y H x2`. */
function span(path) {
  const [, x, , x2] = path.getAttribute("d").match(/M ([\d.]+) ([\d.]+) H ([\d.]+)/); // prettier-ignore
  return { from: Number(x), to: Number(x2) };
}

const gauge = (opts) => {
  const svg = buildWireGauge(opts);
  document.body.append(svg);
  return svg;
};

test("the dimension is the run PLUS a strip at each end — the length you cut", () => {
  resetDom();
  // The figures a bench asks for: one 2.54 mm pitch of run is 2.54 + 2 × 5 mm of
  // wire, and two pitches 5.08 + 10 — not 3 mm and 5 mm, which is the run alone.
  assert.ok(Math.abs(wireTotalMm(2.54) - 12.54) < 1e-9);
  assert.ok(Math.abs(wireTotalMm(2 * 2.54) - 15.08) < 1e-9);
  assert.equal(
    wireTotalMm(0),
    2 * STRIP_MM,
    "a wire is never shorter than this",
  );
  assert.equal(
    wireTotalMm(-40),
    2 * STRIP_MM,
    "a nonsense run floors, not signs",
  );

  const svg = gauge({ color: "red", runMm: 117 });
  // 117 mm of run + 10 mm of strip.
  assert.equal(svg.querySelector(".wire-gauge-length").textContent, "12.7 cm");
  // The same measurement is the picture's accessible name — it is one <svg>,
  // so a reader gets the label, never the parts.
  assert.equal(svg.getAttribute("role"), "img");
  assert.match(svg.getAttribute("aria-label"), /12\.7 cm/);

  // A whole number still shows the tenth, so a column of them lines up.
  assert.equal(
    gauge({ color: "red", runMm: 90 }).querySelector(".wire-gauge-length")
      .textContent,
    "10.0 cm",
  );
});

test("the sleeve is drawn in the wire's own colour, and repaints in place", () => {
  resetDom();
  const svg = gauge({ color: "green", runMm: 70 });
  assert.equal(
    svg.style.getPropertyValue("--wire-color"),
    "var(--color-wire-green)",
  );
  const before = svg.querySelector(".wire-gauge-sleeve").getAttribute("d");

  setWireGaugeColor(svg, "purple");
  assert.equal(
    svg.style.getPropertyValue("--wire-color"),
    "var(--color-wire-purple)",
  );
  assert.equal(
    svg.querySelector(".wire-gauge-sleeve").getAttribute("d"),
    before,
    "a colour change is one property — the geometry is untouched",
  );
});

test("re-measuring moves the strip and restates the figure, colour intact", () => {
  resetDom();
  const svg = gauge({ color: "green", runMm: 290 });
  const longHaul = span(svg.querySelector(".wire-gauge-sleeve"));

  // Shorter wire, same drawing: the same 5 mm of strip is now a bigger share of
  // it, so the sleeve gives ground at both ends. (30 mm of run + 10 of strip.)
  setWireGaugeRun(svg, 30);
  const shortHop = span(svg.querySelector(".wire-gauge-sleeve"));
  assert.ok(shortHop.from > longHaul.from, "the left strip grew");
  assert.ok(shortHop.to < longHaul.to, "and so did the right");
  // The outline still matches the sleeve it sits under, and the leads still
  // reach the tips (they only ever change how far under the sleeve they run).
  assert.deepEqual(span(svg.querySelector(".wire-gauge-sleeve-outline")), shortHop); // prettier-ignore
  const leads = [...svg.querySelectorAll(".wire-gauge-lead")].map(span);
  assert.ok(leads[0].to > shortHop.from && leads[1].to < shortHop.to);

  assert.equal(svg.querySelector(".wire-gauge-length").textContent, "4.0 cm");
  assert.match(svg.getAttribute("aria-label"), /4\.0 cm/, "the label too");
  assert.equal(
    svg.style.getPropertyValue("--wire-color"),
    "var(--color-wire-green)",
    "a re-measure is not a repaint",
  );
});

test("the sleeve is stripped back at BOTH ends, over the bare lead", () => {
  resetDom();
  const svg = gauge({ color: "red", runMm: 90 });
  const sleeve = span(svg.querySelector(".wire-gauge-sleeve"));
  const leads = [...svg.querySelectorAll(".wire-gauge-lead")].map(span);
  assert.equal(leads.length, 2, "one stripped end each side");

  // The leads start at the very tips, and the sleeve starts inside both.
  const [left, right] = leads;
  assert.ok(left.from < sleeve.from, "left tip is bare");
  assert.ok(right.from > sleeve.to, "right tip is bare");
  // Each runs a little way UNDER the sleeve, so there is no seam to see.
  assert.ok(left.to > sleeve.from, "the left lead passes under the sleeve");
  assert.ok(right.to < sleeve.to, "and so does the right");
  // Symmetric: the same amount comes off each end.
  assert.ok(
    Math.abs(sleeve.from - left.from - (right.from - sleeve.to)) < 0.01,
    "both ends are stripped alike",
  );

  // The outline is the SAME run as the core it sits under.
  assert.deepEqual(span(svg.querySelector(".wire-gauge-sleeve-outline")), sleeve); // prettier-ignore
});

test("bareLead: a strip's share of the WHOLE wire, floored and capped", () => {
  const width = 300;
  // Note bareLead takes the TOTAL, strips included — 10 cm of wire stripped 5 mm
  // at each end shows a twentieth of the drawing as copper per end.
  assert.ok(Math.abs(bareLead(width, 100) - width * 0.05) < 1e-9);

  // A long haul would draw a lead too small to see; a floor keeps it a drawing.
  const long = bareLead(width, 5000);
  assert.ok(long > 0 && long < width * 0.05, `${long} is a whisker`);
  assert.equal(long, bareLead(width, 50_000), "and it cannot shrink past it");

  // The ceiling is the SHORTEST wire this app can hold (one pitch of run plus
  // both strips), so it never binds on a real one — the shortest real wire's own
  // share sits just under it, and gets drawn to scale.
  const shortest = wireTotalMm(2.54);
  const tightest = bareLead(width, shortest);
  assert.ok(
    Math.abs(tightest - width * (STRIP_MM / shortest)) < 1e-9,
    "the shortest real wire is still drawn to scale, not clamped",
  );
  assert.ok(tightest * 2 < width, `${tightest} leaves sleeve between the ends`);
  // Only a nonsense total reaches the cap.
  assert.equal(
    bareLead(width, 1),
    tightest,
    "a length under the shortest caps",
  );
  assert.equal(bareLead(width, 0), tightest, "and so does nothing at all");
});

test("the dimension line spans the wire, arrowheads out, measurement above", () => {
  resetDom();
  const svg = gauge({ color: "red", runMm: 117 });
  const dim = svg.querySelector(".wire-gauge-dim-line");
  const sleeve = span(svg.querySelector(".wire-gauge-sleeve"));
  const leads = [...svg.querySelectorAll(".wire-gauge-lead")].map(span);
  const run = span(dim);

  // It measures the WHOLE wire, bare ends included — not just the sleeve.
  assert.equal(run.from, leads[0].from, "starts under the left tip");
  assert.equal(run.to, leads[1].from, "ends under the right tip");
  assert.ok(run.from < sleeve.from && run.to > sleeve.to);

  // One witness line dropped from each tip, at the same two x positions.
  const witness = [...svg.querySelectorAll(".wire-gauge-witness")].map((p) =>
    Number(p.getAttribute("d").match(/M ([\d.]+)/)[1]),
  );
  assert.deepEqual(witness, [run.from, run.to]);

  // Both arrowheads have their tip ON the extension line and point outward.
  const arrows = [...svg.querySelectorAll(".wire-gauge-arrow")].map((p) =>
    [...p.getAttribute("d").matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    })),
  );
  assert.equal(arrows.length, 2);
  assert.equal(arrows[0][0].x, run.from);
  assert.ok(arrows[0][1].x > run.from, "the left head opens to the right");
  assert.equal(arrows[1][0].x, run.to);
  assert.ok(arrows[1][1].x < run.to, "the right head opens to the left");

  // The measurement sits between the wire and the line it belongs to.
  const text = svg.querySelector(".wire-gauge-length");
  const wireY = Number(
    svg.querySelector(".wire-gauge-sleeve").getAttribute("d").match(/M [\d.]+ ([\d.]+)/)[1], // prettier-ignore
  );
  assert.ok(Number(text.getAttribute("y")) > wireY);
  assert.ok(Number(text.getAttribute("y")) < arrows[0][0].y);
  assert.equal(text.getAttribute("text-anchor"), "middle");
});
