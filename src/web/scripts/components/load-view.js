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

// load-view.js — the electronic load brick on the desk (.layer-parts): its
// body, its setting on the badge (CC 100mA, CR 47Ω), and the red `+` /
// black `−` terminals whose centres are its wire points (load1.pos /
// load1.neg). Under Spice Lite two lines under the badge show what it is
// drawing while the circuit runs — volts and amps, then watts — in amber
// while it cannot draw what it is set to (`setReading`, fed from
// `chiphippo:sim-state`). The logic engine has no currents: blank.

import { svgEl } from "../dom.js";
import { formatNumber } from "../i18n.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { partDef } from "../catalog/index.js";
import { loadBadge } from "../catalog/bench-parts.js";
import { BrickView } from "./brick-view.js";

/**
 * Build a load brick's SVG from its params. Pure DOM construction
 * (unit-testable under jsdom).
 */
export function buildLoadSvg(params = {}) {
  const def = partDef("load");
  const { width, height } = def.size;
  const svg = svgEl("svg", {
    class: "part-load-svg",
    viewBox: `0 0 ${width} ${height}`,
    width: width * PX_PER_UNIT,
    height: height * PX_PER_UNIT,
    "aria-hidden": "true",
  });
  svg.append(
    svgEl("rect", { class: "part-load-body", x: 0.1, y: 0.1, width: width - 0.2, height: height - 0.2, rx: 0.5 }), // prettier-ignore
  );
  const badge = svgEl("text", { class: "part-load-badge", x: width / 2, y: 1.6, "text-anchor": "middle" }); // prettier-ignore
  badge.textContent = loadBadge(params);
  fitText(badge, badge.textContent, BADGE_FIT_CHARS);
  svg.append(badge);
  // Spice Lite's live readout — empty (and so invisible) until a run says.
  svg.append(
    svgEl("text", { class: "part-load-readout", x: width / 2, y: 2.65, "text-anchor": "middle" }), // prettier-ignore
    svgEl("text", { class: "part-load-watts", x: width / 2, y: 3.6, "text-anchor": "middle" }), // prettier-ignore
  );
  for (const t of def.terminals) {
    const plus = t.id === "pos";
    svg.append(
      svgEl("circle", {
        class: `part-psu-terminal part-psu-terminal--${plus ? "plus" : "minus"}`,
        cx: t.dx,
        cy: t.dy,
        r: 0.55,
      }),
    );
    const glyph = svgEl("text", { class: "part-psu-terminal-glyph", x: t.dx, y: t.dy + 0.22, "text-anchor": "middle" }); // prettier-ignore
    glyph.textContent = plus ? "+" : "−";
    svg.append(glyph);
  }
  return svg;
}

export class LoadView extends BrickView {
  /** What the readout last showed, so a rebuild keeps it and a tick that
      changes nothing writes nothing. */
  #reading = null;
  #shown = "";

  /**
   * @param {HTMLElement} layer - the `.layer-parts` element.
   * @param {{id:string,x:number,y:number,params:object}} load
   * @param {object} [callbacks]
   */
  constructor(layer, load, callbacks = {}) {
    super(layer, load, "part-load", callbacks);
    this.updateParams(load.params);
  }

  /** Rebuild the SVG (the badge shows the setting). */
  updateParams(params) {
    this.element.querySelector("svg")?.remove();
    this.element.prepend(buildLoadSvg(params));
    this.#shown = null;
    this.setReading(this.#reading);
  }

  /**
   * Show what the load is drawing (Spice Lite), or nothing.
   * @param {{volts: number, amps: number, watts: number, unreg: boolean}|null} reading
   */
  setReading(reading) {
    this.#reading = reading ?? null;
    const [text, watts] = reading ? loadReadout(reading) : ["", ""];
    if (`${text}|${watts}` === this.#shown) return;
    this.#shown = `${text}|${watts}`;
    const readout = this.element.querySelector(".part-load-readout");
    if (readout) {
      readout.textContent = text;
      fitText(readout, text, READOUT_FIT_CHARS);
    }
    const power = this.element.querySelector(".part-load-watts");
    if (power) power.textContent = watts;
    this.element.classList.toggle("part-load--unreg", Boolean(reading?.unreg)); // prettier-ignore
  }
}

// The badge and the readout share the brick's 7.4 units inside its rounded
// corners: a line longer than its size fits there is squeezed to the body
// rather than spilling past its edges.
const BADGE_FIT_CHARS = 10;
const READOUT_FIT_CHARS = 12;
const FIT_WIDTH = 7.4;

function fitText(node, text, chars) {
  if (text.length > chars) {
    node.setAttribute("textLength", FIT_WIDTH);
    node.setAttribute("lengthAdjust", "spacingAndGlyphs");
  } else {
    node.removeAttribute("textLength");
    node.removeAttribute("lengthAdjust");
  }
}

/** A current as the readout says it: "35 mA", "1.20 A". */
function ampsText(amps) {
  return amps < 1
    ? `${formatNumber(amps * 1000, { maximumFractionDigits: 0 })} mA`
    : `${formatNumber(amps, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} A`; // prettier-ignore
}

/**
 * The readout's two lines: volts and amps, then watts. Numbers and unit
 * symbols only, so nothing here is a word.
 * @param {{volts: number, amps: number, watts: number}} reading
 * @returns {[string, string]}
 */
export function loadReadout({ volts, amps, watts }) {
  const two = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return [`${formatNumber(volts, two)} V · ${ampsText(amps)}`, `${formatNumber(watts, two)} W`]; // prettier-ignore
}
