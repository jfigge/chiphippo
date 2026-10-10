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

// clock-view.js — a clock source brick on the desk (.layer-parts): a body with
// a rate badge (any of CLOCK_HZ, or MAN), a pulse indicator that lights while the
// output is HIGH, and the `out` / `gnd` terminal pads (the addressable wire
// points clk1.out / clk1.gnd). The blink is driven from chiphippo:sim-state
// (setLevel) — the timer itself lives in the SimController, never here. In
// manual mode the whole body is a click-to-toggle button (the controller owns
// that gesture, like a slide switch).
//
// A free-running clock also carries its OWN pause button in the top-right
// corner, level with the lamp it mirrors. It is drawn at every rate but shown
// only while the circuit runs (CSS keys it off `.desk-viewport--running`, the
// class the editing lock already sets), since stopped there is no clock to
// pause and a press there is a drag. Both glyphs are always in the SVG and the
// `part-clock--paused` class picks one, so a rate change mid-run — which
// rebuilds the SVG — can never show the wrong one. The press is the
// controller's, like the manual toggle; the paused set arrives on sim-state.

import { t } from "../i18n.js";
import { svgEl } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { partDef } from "../catalog/index.js";
import { LEVEL_WAVES, hzLabel } from "../catalog/parts.js";
import { BrickView } from "./brick-view.js";

const rateLabel = (hz) => (hz === "manual" ? "MAN" : hzLabel(hz));

/** The pause button's centre: the lamp's mirror image across the body, so the
    top row reads lamp · wave · button. */
const PAUSE_CX = 6.8;
const PAUSE_CY = 1.5;

/** The pause/resume button (a free-running clock's only). The disc is the hit
    target; the two glyphs are pointer-inert and CSS shows exactly one. */
function buildPauseButton() {
  const cx = PAUSE_CX;
  const cy = PAUSE_CY;
  const g = svgEl("g", { class: "part-clock-pause" });
  g.append(
    svgEl("title"), // the hover hint; text set by ClockView.setPaused
    svgEl("circle", { class: "part-clock-pause-disc", cx, cy, r: 0.6 }),
    // ⏸ — shown while the clock runs: a click pauses it.
    svgEl("path", {
      class: "part-clock-pause-glyph part-clock-pause-glyph--pause",
      d:
        `M ${cx - 0.28} ${cy - 0.3} h 0.18 v 0.6 h -0.18 Z ` +
        `M ${cx + 0.1} ${cy - 0.3} h 0.18 v 0.6 h -0.18 Z`,
    }),
    // ▶ — shown while it is held: a click resumes it. Its tip sits right of
    // centre so the triangle's centroid, not its box, is on the disc's centre.
    svgEl("path", {
      class: "part-clock-pause-glyph part-clock-pause-glyph--resume",
      d: `M ${cx - 0.15} ${cy - 0.32} L ${cx + 0.3} ${cy} L ${cx - 0.15} ${cy + 0.32} Z`,
    }),
  );
  return g;
}

/** The wave glyph beside the lamp, two periods of each wave across x 2.3–4.7
    between y 2.0 (LOW) and 1.0 (HIGH). A sine is sampled: an SVG arc is a
    circle's, not a sine's. */
const WAVE_GLYPH = Object.freeze({
  square:
    "M 2.3 2.0 L 2.3 1.0 L 3.1 1.0 L 3.1 2.0 L 3.9 2.0 L 3.9 1.0 L 4.7 1.0",
  triangle: "M 2.3 2.0 L 2.9 1.0 L 3.5 2.0 L 4.1 1.0 L 4.7 2.0",
  // Flat 30 %, up 20 %, flat 30 %, down 20 % (spice/waves.js).
  trapezoid:
    "M 2.3 2.0 L 2.66 2.0 L 2.9 1.0 L 3.26 1.0 L 3.5 2.0 L 3.86 2.0 L 4.1 1.0 L 4.46 1.0 L 4.7 2.0",
  "ramp-up": "M 2.3 2.0 L 3.5 1.0 L 3.5 2.0 L 4.7 1.0 L 4.7 2.0",
  "ramp-down": "M 2.3 1.0 L 3.5 2.0 L 3.5 1.0 L 4.7 2.0 L 4.7 1.0",
  sine: Array.from({ length: 33 }, (_, i) => {
    const x = 2.3 + (2.4 * i) / 32;
    const y = 1.5 + 0.5 * Math.cos((2 * Math.PI * 2 * i) / 32);
    return `${i ? "L" : "M"} ${x.toFixed(3)} ${y.toFixed(3)}`;
  }).join(" "),
});

/** A PWM's glyph: two periods, each HIGH for its pulse width (`duty`, 0–1)
    and then LOW — drawn at the width it is set to. */
function pwmGlyph(duty) {
  const parts = [];
  for (const x0 of [2.3, 3.5]) {
    const fall = (x0 + 1.2 * duty).toFixed(3);
    parts.push(`${x0 === 2.3 ? "M" : "L"} ${x0} 2.0 L ${x0} 1.0`);
    parts.push(`L ${fall} 1.0 L ${fall} 2.0`);
  }
  parts.push("L 4.7 2.0");
  return parts.join(" ");
}

/** What each terminal pad is marked with: the wave it puts out, the supply
    it runs from, the ground it returns to. */
const TERMINAL_GLYPH = Object.freeze({ out: "⎍", vcc: "+", gnd: "⏚" });

/**
 * Build a clock brick's SVG from the catalog def + params. Its wave glyph is
 * the wave it puts out: a level (a square, a PWM at its pulse width) in
 * either engine, any other wave only under Spice Lite (`spiceLite`) — the
 * digital engine runs that one square.
 */
export function buildClockSvg(params = {}, { spiceLite = false } = {}) {
  const def = partDef("clock");
  const { width, height } = def.size;
  const { hz } = def.normalizeParams(params);
  const own = def.waveOf(def.normalizeParams(params));
  const wave = spiceLite || LEVEL_WAVES.includes(own) ? own : "square";
  const glyph =
    wave === "pwm"
      ? pwmGlyph(def.dutyOf(def.normalizeParams(params)))
      : WAVE_GLYPH[wave];

  const svg = svgEl("svg", {
    class: "part-clock-svg",
    viewBox: `0 0 ${width} ${height}`,
    width: width * PX_PER_UNIT,
    height: height * PX_PER_UNIT,
    "aria-hidden": "true",
  });

  svg.append(
    svgEl("rect", {
      class: "part-clock-body",
      x: 0.1,
      y: 0.1,
      width: width - 0.2,
      height: height - 0.2,
      rx: 0.5,
    }),
  );

  // Pulse lamp (lights while the output is HIGH) + a small glyph of its wave.
  svg.append(
    svgEl("circle", { class: "part-clock-lamp", cx: 1.2, cy: 1.5, r: 0.45 }),
    svgEl("path", { class: "part-clock-wave", d: glyph }),
  );

  // The rate gets a LINE OF ITS OWN, between the wave and the terminals. It
  // used to sit beside the wave on the same baseline, and the two overlapped at
  // every rate the app has ever offered — "2 Hz" already drew as ⎍2⎍Hz, with the
  // glyph running through the digits (it is in the shipped user-guide
  // screenshot). An 8-unit-wide brick has no room for a 2.4-unit glyph and a
  // 4-unit string side by side, and "100 Hz" is the widest the badge can now be,
  // so the fix is vertical: lamp + wave read as "this is a clock" across the
  // top, the value below them, the terminals under that.
  const badge = svgEl("text", {
    class: "part-clock-badge",
    x: width / 2,
    y: 3.2,
    "text-anchor": "middle",
  });
  badge.textContent = rateLabel(hz);
  svg.append(badge);

  // A manual clock has no timer, so nothing to pause: it moves on a click.
  if (def.isAuto({ hz })) svg.append(buildPauseButton());

  for (const t of def.terminals) {
    svg.append(
      svgEl("circle", {
        class: `part-clock-terminal part-clock-terminal--${t.id}`,
        cx: t.dx,
        cy: t.dy,
        r: 0.55,
      }),
    );
    const glyph = svgEl("text", {
      class: "part-clock-terminal-glyph",
      x: t.dx,
      y: t.dy + 0.22,
      "text-anchor": "middle",
    });
    glyph.textContent = TERMINAL_GLYPH[t.id] ?? "";
    svg.append(glyph);
  }
  return svg;
}

export class ClockView extends BrickView {
  #paused = false;
  #params = {};
  #spiceLite = false;

  /**
   * @param {HTMLElement} layer - the `.layer-parts` element.
   * @param {{id:string,x:number,y:number,params:object}} clock
   * @param {object} [callbacks]
   * @param {(id: string, e: PointerEvent) => void} [callbacks.onPointerDown]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onContextMenu]
   * @param {{spiceLite?: boolean}} [opts] - whether Spice Lite is on
   */
  constructor(layer, clock, callbacks = {}, { spiceLite = false } = {}) {
    super(layer, clock, "part-clock", callbacks);
    this.#spiceLite = spiceLite;
    this.updateParams(clock.params);
  }

  /** Rebuild the SVG (the badge shows the current rate, the glyph its wave). */
  updateParams(params) {
    this.#params = params ?? {};
    this.element.querySelector("svg")?.remove();
    this.element.prepend(buildClockSvg(this.#params, { spiceLite: this.#spiceLite })); // prettier-ignore
    this.#labelPauseButton();
  }

  /** Spice Lite switched on or off: the glyph shows the wave it now runs. */
  setSpiceLite(on) {
    if (this.#spiceLite === (on === true)) return;
    this.#spiceLite = on === true;
    this.updateParams(this.#params);
  }

  /** Reflect the live output level (Feature 100): lamp on while HIGH. */
  setLevel(on) {
    this.element.classList.toggle("part-clock--high", on === true);
  }

  /** Reflect this clock's OWN pause (not the transport's): the button offers
      resume while it is held, pause otherwise. Re-applied on every sim-state,
      so the hint follows a language change at the next tick. */
  setPaused(on) {
    this.#paused = on === true;
    this.element.classList.toggle("part-clock--paused", this.#paused);
    this.#labelPauseButton();
  }

  /** The hint says what a click would do, as the transport's Pause does. */
  #labelPauseButton() {
    const title = this.element.querySelector(".part-clock-pause > title");
    if (!title) return;
    title.textContent = this.#paused
      ? t("desk.clock.resume")
      : t("desk.clock.pause");
  }
}
