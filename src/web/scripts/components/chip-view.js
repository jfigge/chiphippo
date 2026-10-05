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

// chip-view.js — a seated DIP chip drawn on the desk (.layer-parts): black
// body with a subtle top-light gradient, left notch, pin-1 dot, centered
// part number, and stub legs reaching the seated holes. One static SVG per
// chip (crisp at all zooms, no rebuilds on camera moves); NO per-pin DOM —
// pin hover is math over derived positions in DeskController.
//
// Local SVG coordinates are pitch units with the ORIGIN AT PIN 1's hole (the
// component anchor), and the upper row of pins `span` pitches above it: 3 for a
// 300-mil part (rows e and f, straight across the trench), 6 for a 600-mil one
// at its true width (rows d and h — footprints.js `dipRows`). Whole pitches by
// design: one per row, three across the channel.

import { el, svgEl } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { holePosition } from "../model/breadboard.js";
import { dipRows, packageSpec } from "../model/footprints.js";
import { chipDef } from "../catalog/index.js";
import { isRomChip, isTimed } from "../sim/chip-eval.js";
import {
  timingCapped,
  timingDescription,
  timingProblemSentences,
  timingReadout,
} from "../model/timing-summary.js";
import {
  buildBurnOverlay,
  buildWarnOverlay,
  statusHint,
} from "./part-symbols.js";

/**
 * The pitches between a chip's two rows of pins, read off its ANCHOR: the row
 * pin 1 is in says which seat it has (a 600-mil part anchored in row e kept the
 * narrow seat an older desk gave it). With no anchor — a ghost not yet over a
 * board — it is the seat the part will be PLACED in.
 * @param {string} pkg
 * @param {string|null} [anchor] - pin 1's hole id, e.g. "d12" — or just its
 *   row ("d"), which is all this reads
 * @returns {number} 3 or 6
 */
export function chipSpan(pkg, anchor = null) {
  const row = typeof anchor === "string" ? anchor[0] : undefined;
  return (dipRows(pkg, row) ?? dipRows(pkg)).span;
}

/** Footprint-box geometry shared by the builder and the ghost/controller —
    for a chip seated at `anchor` (see `chipSpan`). */
export function chipBox(pkg, anchor = null) {
  const { halfPins } = packageSpec(pkg);
  const span = chipSpan(pkg, anchor);
  // x spans the pin columns ± body overhang; y spans the upper row → the
  // lower (anchor) row ± legs.
  return {
    minX: -0.6,
    minY: -span - 0.6,
    width: halfPins - 1 + 1.2,
    height: span + 1.2,
  };
}

/** Body edges (pitch units, local coords): between the rows, inset a full
    HOLE_HIT_RADIUS from each pin row. Across the trench (a 300-mil part) that
    leaves no hole under the slab at all; a 600-mil part at its true width
    stands over rows e, f and g, and those holes are its to cover — occupancy.js
    claims them for it (`partCoverAddresses`). (A DIP SWITCH bank is drawn
    chip-shaped but states its own, taller edges — see discrete-view.js's
    DIP_BODY_TOP: the holes under its overhang are all its own pins, so it has
    nothing to keep clear of.) */
const BODY_INSET = 0.45;
const bodyTop = (span) => -span + BODY_INSET;
const CHIP_BODY_BOTTOM = -BODY_INSET;
const LEG_WIDTH = 0.28;

/**
 * A chip's BODY slab alone — `chipBox` without the legs it allows room for.
 *
 * The two are not interchangeable, and the auto-router (Feature 360) is why the
 * distinction has to be exported. `chipBox` reaches 0.6 pitch PAST its pin rows
 * so the drawn legs have somewhere to be; treat that as the obstacle, inflate it
 * by a wire's clearance, and the row just outside them — the row every wire on a
 * chip's lower node actually leaves from — closes up, which would make a seated
 * chip unwireable. The slab is the plastic, and the plastic is what a jumper has
 * to go round.
 *
 * The legs need no allowance of their own: each one stands in its own pin's
 * hole, and a hole with a pin in it is already spoken for.
 */
export function chipBodyBox(pkg, anchor = null) {
  const { halfPins } = packageSpec(pkg);
  const top = bodyTop(chipSpan(pkg, anchor));
  return {
    minX: -0.6,
    minY: top,
    width: halfPins - 1 + 1.2,
    height: CHIP_BODY_BOTTOM - top,
  };
}

/**
 * Build a chip's complete SVG from its catalog def. Pure DOM construction
 * (unit-testable under jsdom).
 * @param {string} ref - catalog id, e.g. "74LS00"
 * @param {object} [params]
 * @param {string|null} [anchor] - pin 1's hole, which says how wide the chip
 *   is seated (`chipSpan`); none draws it as it would be placed
 * @returns {SVGSVGElement}
 */
export function buildChipSvg(ref, params = {}, anchor = null) {
  const def = chipDef(ref);
  if (!def) {
    const err = new Error(`unknown catalog ref: ${ref}`);
    err.code = "INVALID_REF";
    throw err;
  }
  const { halfPins } = packageSpec(def.package);
  const span = chipSpan(def.package, anchor);
  const box = chipBox(def.package, anchor);
  const top = bodyTop(span);
  const mid = -span / 2; // halfway between the two pin rows

  const svg = svgEl("svg", {
    class: "part-chip-svg",
    viewBox: `${box.minX} ${box.minY} ${box.width} ${box.height}`,
    width: box.width * PX_PER_UNIT,
    height: box.height * PX_PER_UNIT,
    "aria-hidden": "true",
  });

  // Legs first (under the body edge): stubs from the body to each hole.
  // The lower row's holes sit at local y=0, the upper row's at y=-span; the
  // body spans between.
  const legs = svgEl("g", { class: "part-chip-legs" });
  for (let dcol = 0; dcol < halfPins; dcol++) {
    for (const [y, h] of [
      [CHIP_BODY_BOTTOM - 0.05, 0.6], // down over the lower row's holes
      [-span - 0.1, top + span + 0.1], // up from the upper row's to the body
    ]) {
      legs.append(
        svgEl("rect", {
          class: "part-chip-leg",
          x: dcol - LEG_WIDTH / 2,
          y,
          width: LEG_WIDTH,
          height: h,
        }),
      );
    }
  }
  svg.append(legs);

  // Body slab with the molded top-light sheen.
  svg.append(
    svgEl("rect", {
      class: "part-chip-body",
      x: box.minX + 0.1,
      y: top,
      width: box.width - 0.2,
      height: CHIP_BODY_BOTTOM - top,
      rx: 0.18,
    }),
  );

  // Left notch (semicircle biting into the body) + pin-1 dot (bottom-left).
  svg.append(
    svgEl("path", {
      class: "part-chip-notch",
      d: `M ${box.minX + 0.1} ${mid - 0.32} A 0.32 0.32 0 0 1 ${box.minX + 0.1} ${mid + 0.32} Z`,
    }),
  );
  svg.append(
    svgEl("circle", {
      class: "part-chip-dot",
      cx: 0.12,
      cy: -0.82,
      r: 0.12,
    }),
  );

  // Centered part number.
  const label = svgEl("text", {
    class: "part-chip-label",
    x: (halfPins - 1) / 2,
    y: mid + 0.22,
    "text-anchor": "middle",
  });
  label.textContent = def.id;
  svg.append(label);

  // Flipped 180°: turn the whole slab about the footprint's centre, so the
  // notch swings to the right edge and the pin-1 dot to the far corner — the
  // printed label reads upside down, exactly as a real chip seated backwards.
  if (params?.rot === 180) {
    const turned = svgEl("g", {
      class: "part-chip-flipped",
      transform: `rotate(180 ${(halfPins - 1) / 2} ${mid})`,
    });
    while (svg.firstChild) turned.append(svg.firstChild);
    svg.append(turned);
  }

  // A timed part's readout (the 555, the RC-timed CD4000 parts): its rate or
  // pulse length, printed under the part number while it runs. Outside the
  // flip group, so it reads upright on a chip seated backwards too; empty
  // until ChipView.setTiming fills it.
  const cx = (halfPins - 1) / 2;
  if (isTimed(def)) {
    const readout = svgEl("text", {
      class: "part-chip-timing",
      x: cx,
      y: mid + 0.84,
      "text-anchor": "middle",
    });
    readout.append(svgEl("title"), svgEl("tspan"));
    svg.append(readout);
  }

  // Fault symbols (Feature 90), centred on the body — appended AFTER the flip
  // group above so they stay in screen space: smoke must rise, and an
  // upside-down warning triangle would read as a delta. CSS reveals exactly
  // one per .part-chip--<status> class and hides both otherwise.
  const cy = (top + CHIP_BODY_BOTTOM) / 2;
  const status = svgEl("g", { class: "part-chip-status" });
  status.append(
    svgEl("title"), // the hover hint; text set by ChipView.setStatus
    buildWarnOverlay(cx, cy),
    buildBurnOverlay(cx, cy, 0.7),
  );
  svg.append(status);
  return svg;
}

export class ChipView {
  #el;
  #id;
  #ref;
  #params = {}; // latest params (the 180° flip changes the drawn orientation)
  #anchor = null; // pin 1's hole — its row says how wide the chip is seated
  #status = null; // last engine-reported power/health status (Feature 90)
  #volts = null; // …and the supply volts the engine saw (Feature 400)
  #unprogrammed = false; // a ROM/EPROM/EEPROM with no image loaded (Feature 190)
  #timing = null; // a timed part's reading of its own R and C, while running

  /**
   * @param {HTMLElement} layer - the `.layer-parts` element.
   * @param {{id:string,ref:string}} component
   * @param {object} [callbacks]
   * @param {(id: string, e: PointerEvent) => void} [callbacks.onPointerDown]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onContextMenu]
   */
  constructor(layer, component, { onPointerDown, onContextMenu } = {}) {
    this.#id = component.id;
    this.#ref = component.ref;
    this.#el = el("div", {
      class: "part part-chip",
      dataset: { componentId: component.id },
    });
    this.#params = component.params ?? {};
    this.#anchor = component.anchor ?? null;
    this.#el.append(buildChipSvg(component.ref, this.#params, this.#anchor));
    this.#el.addEventListener("pointerdown", (e) =>
      onPointerDown?.(this.#id, e),
    );
    this.#el.addEventListener("contextmenu", (e) =>
      onContextMenu?.(this.#id, e),
    );
    layer.append(this.#el);
    this.#refresh();
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

  /** Rebuild the SVG for new params (the 180° flip). */
  updateParams(params) {
    this.#params = params ?? {};
    this.#rebuild();
  }

  /** Redraw the SVG from the current params and seat. */
  #rebuild() {
    this.#el.querySelector("svg")?.remove();
    this.#el.prepend(buildChipSvg(this.#ref, this.#params, this.#anchor));
    this.#refresh();
    this.#paintTiming();
  }

  /**
   * A timed part's reading of its own wiring (sim/timing.js), from the live
   * sim-state, or null when stopped: the readout printed on the body (amber
   * when it is faster, or a pulse shorter, than the desk can show), and — when
   * the part cannot read its R and C — the warning triangle, which explains.
   */
  setTiming(analysis) {
    this.#timing = analysis ?? null;
    this.#paintTiming();
    this.#refresh();
  }

  #paintTiming() {
    const readout = this.#el.querySelector(".part-chip-timing");
    if (!readout) return;
    const text = timingReadout(this.#timing);
    readout.querySelector("title").textContent = text
      ? timingDescription(this.#timing)
      : "";
    readout.querySelector("tspan").textContent = text;
    this.#el.classList.toggle(
      "part-chip--capped",
      Boolean(text) && timingCapped(this.#timing),
    );
  }

  /**
   * Seat the element: the SVG box is anchored on pin 1's hole, so the world
   * position is board origin + anchor hole position + the box offsets.
   * A seat at another WIDTH redraws the chip first — a 600-mil part an older
   * desk seated narrow takes its true width the moment it is moved, and the
   * live drag shows it doing so.
   * @param {{type:string,x:number,y:number}} board
   * @param {string} anchor - pin 1's hole id (row e, or d at 600-mil width)
   */
  updatePlacement(board, anchor) {
    const pos = holePosition(board.type, anchor, board.rot ?? 0);
    if (!pos) return; // defensive: never seat a view on a phantom hole
    const pkg = chipDef(this.#ref).package;
    const widthChanged = chipSpan(pkg, anchor) !== chipSpan(pkg, this.#anchor);
    this.#anchor = anchor;
    if (widthChanged) this.#rebuild();
    const box = chipBox(pkg, anchor);
    this.#el.style.left = `${(board.x + pos.x + box.minX) * PX_PER_UNIT}px`;
    this.#el.style.top = `${(board.y + pos.y + box.minY) * PX_PER_UNIT}px`;
  }

  /**
   * Reflect the simulator's power/health status (Feature 90): a warning
   * triangle over the body when unpowered, the red X + smoke when reversed or
   * damaged, an amber corner dot when underpowered. `null` clears everything
   * (editing / stopped) — but an unprogrammed ROM's own warning (Feature 190
   * follow-up, see #refresh) is independent of this and stays put.
   */
  setStatus(status, volts = null) {
    this.#status = status;
    this.#volts = volts;
    this.#refresh();
  }

  /**
   * Recompute every fault class + hover hint from the engine status (above,
   * cleared whenever the sim isn't running) and the "unprogrammed" flag
   * (computed from params alone, so it's true at design time too — a ROM/
   * EPROM/EEPROM with no image loaded reads garbage whether or not the sim
   * is running). The two share the one warning-triangle asset; a burn fault
   * (reversed/damaged — the chip needs replacing outright) wins over the
   * milder "load an image" hint rather than drawing both overlays at once.
   */
  #refresh() {
    this.#unprogrammed =
      isRomChip(chipDef(this.#ref)) &&
      Boolean(this.#params?.storage?.guid) &&
      this.#params?.programmed !== true;
    const burning = this.#status === "reversed" || this.#status === "damaged";
    for (const s of ["unpowered", "underpowered", "reversed", "damaged"]) {
      this.#el.classList.toggle(`part-chip--${s}`, this.#status === s);
    }
    this.#el.classList.toggle(
      "part-chip--unprogrammed",
      this.#unprogrammed && !burning,
    );
    // A timed part that cannot read its own R and C shares the triangle; a
    // power fault (which stops it computing at all) speaks first.
    const fault = ["unpowered", "underpowered", "reversed", "damaged"].includes(
      this.#status,
    );
    const timingProblems = fault ? [] : timingProblemSentences(this.#timing);
    this.#el.classList.toggle("part-chip--timing", timingProblems.length > 0);
    const title = this.#el.querySelector(".part-chip-status > title");
    if (title) {
      const about = { volts: this.#volts, def: chipDef(this.#ref) };
      title.textContent =
        statusHint(this.#status, about) ||
        (timingProblems.length
          ? statusHint("timing", { ...about, problems: timingProblems })
          : "") ||
        (this.#unprogrammed ? statusHint("unprogrammed", about) : "");
    }
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
