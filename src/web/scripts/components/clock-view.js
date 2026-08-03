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

import { svgEl } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { partDef } from "../catalog/index.js";
import { BrickView } from "./brick-view.js";

const rateLabel = (hz) => (hz === "manual" ? "MAN" : `${hz} Hz`);

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
  }

  /** Reflect the live output level (Feature 100): lamp on while HIGH. */
  setLevel(on) {
    this.element.classList.toggle("part-clock--high", on === true);
  }
}
