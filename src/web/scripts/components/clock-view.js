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
import { BrickView } from "./brick-view.js";

const rateLabel = (hz) => (hz === "manual" ? "MAN" : `${hz} Hz`);

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

/** Build a clock brick's SVG from the catalog def + params. */
export function buildClockSvg(params = {}) {
  const def = partDef("clock");
  const { width, height } = def.size;
  const { hz } = def.normalizeParams(params);

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

  // Pulse lamp (lights while the output is HIGH) + a small square-wave glyph.
  svg.append(
    svgEl("circle", { class: "part-clock-lamp", cx: 1.2, cy: 1.5, r: 0.45 }),
    svgEl("path", {
      class: "part-clock-wave",
      d: "M 2.3 2.0 L 2.3 1.0 L 3.1 1.0 L 3.1 2.0 L 3.9 2.0 L 3.9 1.0 L 4.7 1.0",
    }),
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
    glyph.textContent = t.id === "out" ? "⎍" : "⏚";
    svg.append(glyph);
  }
  return svg;
}

export class ClockView extends BrickView {
  #paused = false;

  /**
   * @param {HTMLElement} layer - the `.layer-parts` element.
   * @param {{id:string,x:number,y:number,params:object}} clock
   * @param {object} [callbacks]
   * @param {(id: string, e: PointerEvent) => void} [callbacks.onPointerDown]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onContextMenu]
   */
  constructor(layer, clock, callbacks = {}) {
    super(layer, clock, "part-clock", callbacks);
    this.updateParams(clock.params);
  }

  /** Rebuild the SVG (the badge shows the current rate). */
  updateParams(params) {
    this.element.querySelector("svg")?.remove();
    this.element.prepend(buildClockSvg(params));
    this.#labelPauseButton();
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
