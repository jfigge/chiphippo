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

import { el, svgEl } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { holePosition, rotateOffset } from "../model/breadboard.js";
import { footprintOffsets, partDef } from "../catalog/index.js";
import { packageSpec } from "../model/footprints.js";
import { formatOhms } from "../model/ohm-format.js";
import { formatFarads } from "../model/farad-format.js";
import { formatHenries } from "../model/henry-format.js";
import { formatVolts } from "../model/volt-format.js";
import { resistorBands } from "../model/resistor-bands.js";
import { partNumberOf, transistorCase } from "../catalog/discretes.js";
import { hzLabel } from "../catalog/parts.js";
import { t } from "../i18n.js";
import { chipBox } from "./chip-view.js";
import {
  buildBurnOverlay,
  buildWarnOverlay,
  statusHint,
} from "./part-symbols.js";

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
  led: Object.freeze({ minX: -0.7, minY: -1.2, width: 2.4, height: 2.4 }),
  resistor: Object.freeze({ minX: -0.7, minY: -1.1, width: 4.4, height: 2.2 }),
  // A disc and a radial can, each over adjacent holes 0 and 1.
  "cap-ceramic": Object.freeze({
    minX: -0.7,
    minY: -1.1,
    width: 2.4,
    height: 2.2,
  }),
  "cap-electrolytic": Object.freeze({
    minX: -0.7,
    minY: -1.2,
    width: 2.4,
    height: 2.4,
  }),
  // Two-lead parts on 0.3 in, as the resistor is (their span form is what is
  // seated; this box is the placement ghost's). An inductor's depends on its
  // params (inductorBox).
  diode: Object.freeze({ minX: -0.7, minY: -1.1, width: 4.4, height: 2.2 }),
  zener: Object.freeze({ minX: -0.7, minY: -1.1, width: 4.4, height: 2.2 }),
  // A TO-92 over three holes in a row, its moulding centred on the middle one
  // (see buildTo92). A MOSFET in its TO-220 takes TO220_BOX instead.
  npn: Object.freeze({ minX: -0.3, minY: -0.9, width: 2.6, height: 1.45 }),
  pnp: Object.freeze({ minX: -0.3, minY: -0.9, width: 2.6, height: 1.45 }),
  nmos: Object.freeze({ minX: -0.3, minY: -0.9, width: 2.6, height: 1.45 }),
  pmos: Object.freeze({ minX: -0.3, minY: -0.9, width: 2.6, height: 1.45 }),
  // A 9-pin SIP standing over one row of holes (like the displays), body above
  // so every hole stays clickable for wiring.
  rnet9: Object.freeze({ minX: -0.7, minY: -2.9, width: 9.4, height: 3.5 }),
  // A trimmer potentiometer, its body centred over its three holes as a slide
  // switch's is (see buildPotentiometer).
  pot: Object.freeze({ minX: -1, minY: -1, width: 4, height: 2 }),
  // Nine holes along one row (x 0…8) with the display block standing ABOVE
  // them, so each anode's lower column holes stay clickable for wiring.
  seg8cc: Object.freeze({ minX: -0.7, minY: -7.7, width: 9.4, height: 8.3 }),
  // The common-anode digit is the same physical block as seg8cc.
  seg8ca: Object.freeze({ minX: -0.7, minY: -7.7, width: 9.4, height: 8.3 }),
  bar8: Object.freeze({ minX: -0.7, minY: -4.7, width: 9.4, height: 5.3 }),
  // A 16-pin DIP straddling the trench (row e ↔ row f, 3 pitches): the body
  // (see buildBarArrayDisplay) overhangs its own 8-column leg span by half a
  // pitch on every side — enough to read as its own package without
  // overlapping a neighbour seated flush against it — and runs past both
  // hole rows the same way, rather than hugging the trench like a real
  // chip's body would. This box is that body plus a 0.25 margin.
  bar8iso: Object.freeze({ minX: -0.75, minY: -3.6, width: 8.5, height: 4.2 }),
});

/**
 * A TO-220 standing over three holes in a row, seen from above (see
 * buildTo220): KiCad's TO-220-3_Vertical outline in pitch units, its 10 mm
 * body centred on the middle hole and its metal tab behind — so it reaches a
 * pitch past the outer holes and over the row behind, as the real one does.
 */
export const TO220 = Object.freeze({
  left: -0.97,
  width: 3.94,
  back: -1.24, // the tab's back face
  tab: 0.5, // the tab's thickness
  front: 0.49, // the moulding's front face
});
const TO220_BOX = Object.freeze({
  minX: TO220.left - 0.1,
  minY: TO220.back - 0.1,
  width: TO220.width + 0.2,
  height: TO220.front - TO220.back + 0.2,
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
 * ignores it. `params` only for a part whose params change its outline: a
 * MOSFET's package, an inductor's holes between its leads.
 */
export function discreteBox(ref, rot = 0, params = null) {
  const def = partDef(ref);
  if (def?.can) return canBox(def, rot);
  if (def?.transistor && transistorCase(def, params) === "TO-220") {
    return TO220_BOX;
  }
  if (def?.inductor) {
    // Its look and its size are both params (inductorBox).
    return inductorBox(params, footprintOffsets(def, params).at(-1));
  }
  // A character-LCD module's box is DATASHEET DATA, not hand-tuned padding, so
  // it lives on the def beside the window/screen rects it has to agree with —
  // three rectangles cut from one mechanical drawing, which is exactly the
  // thing a second home could let drift.
  if (def?.characterDisplay) return def.characterDisplay.body;
  const box = BOXES[ref];
  if (box) return box;
  // A DIP-packaged discrete with no hand-tuned BOXES entry (a DIP switch
  // bank) is exactly a DIP: derive its box from the package, the same one
  // chip-view.js draws from. A half-lap flip maps a DIP box onto itself, so
  // `rot` never enters.
  if (def?.package) return chipBox(def.package);
  const err = new Error(`unknown discrete ref: ${ref}`);
  err.code = "INVALID_REF";
  throw err;
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
 *
 * `size` is the body's own half-extents about `m` — `along` the leads and
 * `across` them (a function of the params where its size is a property) —
 * which is where a label beside it starts (spanLabel) and what its selection
 * frame hugs (buildSpanSvg).
 */
const SPAN_BODIES = Object.freeze({
  resistor: Object.freeze({
    pad: 0.9, // body half-height 0.5 (the 1.6-wide hit stroke wants 0.8)
    size: { along: 1, across: 0.5 },
    build: (m, params) => [
      svgEl("rect", {
        class: "part-resistor-body",
        x: m.x - 1,
        y: m.y - 0.5,
        width: 2,
        height: 1,
        rx: 0.4,
      }),
      ...resistorBandRects(m, params.ohms),
    ],
  }),
  // A ceramic disc, seen face-on: its value is printed on it (upright — see
  // buildSpanSvg), and it carries no polarity.
  "cap-ceramic": Object.freeze({
    pad: 1,
    size: { along: 0.78, across: 0.78 },
    build: (m) => [
      svgEl("circle", {
        class: "part-cap-ceramic",
        cx: m.x,
        cy: m.y,
        r: 0.78,
      }),
    ],
  }),
  // A radial electrolytic, seen from above: the can, and the printed stripe
  // down the side of the NEGATIVE lead — pin 2, at +x in this frame — with its
  // minus sign. The value is printed beside the stripe, not across it
  // (`label`: its shift along the body, in this frame).
  "cap-electrolytic": Object.freeze({
    pad: 1.05,
    size: { along: 0.88, across: 0.88 },
    label: -0.2,
    build: (m) => {
      const r = 0.88;
      const d = 0.5; // where the stripe starts, from the centre
      const h = Math.sqrt(r * r - d * d);
      return [
        svgEl("circle", { class: "part-cap-can", cx: m.x, cy: m.y, r }),
        svgEl("path", {
          class: "part-cap-stripe",
          d: `M ${m.x + d} ${m.y - h} A ${r} ${r} 0 0 1 ${m.x + d} ${m.y + h} Z`,
        }),
        svgEl("line", {
          class: "part-cap-minus",
          x1: m.x + d + 0.12,
          y1: m.y,
          x2: m.x + d + 0.34,
          y2: m.y,
        }),
      ];
    },
  }),
  // A diode, its band on the CATHODE end — pin 2, at +x in this frame.
  diode: Object.freeze({
    pad: 0.9,
    size: { along: 0.75, across: 0.32 },
    build: (m) => diodeBody(m),
  }),
  zener: Object.freeze({
    pad: 0.9,
    size: { along: 0.75, across: 0.32 },
    build: (m) => diodeBody(m, true),
  }),
  // An inductor, in either of its two looks (its `style`), seen from above
  // over its leads: a TOROID standing on edge — copper wound round a ferrite
  // ring — or a drum in a black CAN. Its size follows the holes between its
  // leads (so `size` is a function here); the pad covers the bigger drum.
  inductor: Object.freeze({
    pad: 1.7,
    size: (params) => {
      const { length, width, drum } = inductorSize(params);
      return params?.style === "can"
        ? { along: drum, across: drum }
        : { along: length / 2, across: width / 2 };
    },
    build: (m, params) =>
      params.style === "can"
        ? inductorCan(m, params)
        : inductorToroid(m, params),
  }),
  // Dome centred on the pin-to-pin midpoint (both axes — swapping which hole
  // either pin lands in never moves it) with the flat chord marking the
  // CATHODE side — pin 2 by default, mirrored to pin 1's side when flipped.
  led: Object.freeze({
    pad: 1, // radius 0.85, plus a hair
    size: { along: 0.85, across: 0.85 },
    build: (m, params) => [
      svgEl("circle", {
        class: `part-led-dome part-led-dome--${params.color ?? "red"}`,
        cx: m.x,
        cy: m.y,
        r: 0.85,
      }),
      svgEl("rect", {
        class: "part-led-flat",
        x: m.x + (params.flip ? -0.65 : 0.65) - 0.07,
        y: m.y - 0.75,
        width: 0.14,
        height: 1.5,
      }),
    ],
  }),
});

const DEFAULT_SPAN_PAD = 0.9;

/** A span part's body half-extents, `{along, across}` its leads — fixed on
    most, a function of its params where its size is a property. */
function bodySize(ref, params) {
  const size = SPAN_BODIES[ref]?.size;
  return (typeof size === "function" ? size(params) : size) ?? NO_BODY;
}
const NO_BODY = Object.freeze({ along: 0, across: 0.5 });

/** Half a lead's stroke: how far its round cap reaches past the hole. */
const LEAD_CAP = 0.07;

/**
 * The selection frame of a span part with its leads `reach` either side of
 * `m` (in the leads' own frame, so it turns with them): the outline every
 * other part gets from `.part--selected`, drawn here so it hugs the part —
 * its leads and its body — rather than the element's box, which is padded for
 * the body at any angle. Gap and stroke match that outline's (1 px off, 2 px
 * wide, at PX_PER_UNIT 10); CSS shows it only while selected, or refused.
 */
function spanFrame(ref, params, m, reach) {
  const { along, across } = bodySize(ref, params);
  const x = Math.max(reach + LEAD_CAP, along) + 0.2;
  const y = Math.max(LEAD_CAP, across) + 0.2;
  return svgEl("rect", {
    class: "part-span-frame",
    x: m.x - x,
    y: m.y - y,
    width: 2 * x,
    height: 2 * y,
    rx: Math.min(0.4, y),
  });
}

/**
 * An inductor's size, by the holes between its leads (pitch units): a
 * standing toroid's length along its leads and its width across them — a
 * little longer than its leads are apart, as the real part is — and a can's
 * drum radius, a drum sitting between its leads (Jason's sizes: 3.2 across
 * over three holes, two thirds of that over two).
 */
const INDUCTOR_SIZE = Object.freeze({
  2: Object.freeze({ length: 3.2, width: 1.35, drum: 1.06 }),
  3: Object.freeze({ length: 4.3, width: 1.7, drum: 1.6 }),
});
export const inductorSize = (params) =>
  INDUCTOR_SIZE[params?.bodyHoles === 3 ? 3 : 2];

/** Turns round a toroid's ring, all the way round — about one every 0.13
    pitch along its top, which is what reads as close-wound wire. */
const TOROID_TURNS = 72;

/**
 * A toroidal inductor about `m`, leads along +x, seen from ABOVE: it stands
 * on edge over its two leads with its ring in their plane, so what shows is
 * the top of the ring — a long rounded body, the copper wound round the dark
 * ferrite turn after turn, out to both ends. Each turn is drawn where it
 * crosses the top of the ring, so they bunch up toward the ends, where the
 * ring curves down out of sight, and open out over the middle, where the
 * dark core shows between them; and each is lit by how squarely it faces up
 * (`part-inductor-turn` opacity), dimming toward the ends — together what
 * makes it read as a ring rather than a bobbin.
 */
function inductorToroid(m, params) {
  const { length, width } = inductorSize(params);
  const half = length / 2;
  const corner = width * 0.4;
  // The body's half-height `d` in from either end (its rounded corners).
  const reach = (d) =>
    d >= corner
      ? width / 2
      : width / 2 - corner + Math.sqrt(corner * corner - (corner - d) ** 2);
  const turns = [];
  for (let k = 1; k < TOROID_TURNS / 2; k++) {
    const phi = (2 * Math.PI * k) / TOROID_TURNS;
    const x = m.x + (half - 0.03) * Math.cos(phi);
    const h = reach(half - Math.abs(x - m.x)) - 0.03;
    if (h <= 0.05) continue;
    const lit = (0.35 + 0.65 * Math.sin(phi)).toFixed(2);
    // Each turn over the dark edge of the next, a little slanted — wire —
    // and seen ever more edge-on toward the ends.
    const slant = 0.04 * Math.sin(phi);
    for (const cls of ["part-inductor-turn-edge", "part-inductor-turn"]) {
      turns.push(
        svgEl("line", {
          class: cls,
          x1: x - slant,
          y1: m.y - h,
          x2: x + slant,
          y2: m.y + h,
          ...(cls === "part-inductor-turn" ? { "stroke-opacity": lit } : {}),
        }),
      );
    }
  }
  const body = {
    x: m.x - half,
    y: m.y - width / 2,
    width: length,
    height: width,
    rx: corner,
  };
  return [
    svgEl("rect", { class: "part-inductor-core", ...body }),
    ...turns,
    // The whole body takes the pointer as well as the leads.
    svgEl("rect", { class: "part-display-hit", ...body }),
  ];
}

/**
 * A drum inductor in a can about `m`, seen from above: the black sleeve with
 * the lighter bevel of its rim, standing over both its leads, which run
 * underneath it to their holes. Its value is printed on top (valueLabel).
 */
function inductorCan(m, params) {
  const r = inductorSize(params).drum;
  return [
    svgEl("circle", { class: "part-inductor-drum", cx: m.x, cy: m.y, r }),
    svgEl("circle", {
      class: "part-inductor-drum-top",
      cx: m.x,
      cy: m.y,
      r: r - 0.22,
    }),
    svgEl("circle", { class: "part-display-hit", cx: m.x, cy: m.y, r }),
  ];
}

/**
 * The box an inductor's footprint form (its placement ghost) needs, its
 * leads `end` holes apart: its body centred over them, a little past them.
 */
function inductorBox(params, end) {
  const { length, width, drum } = inductorSize(params);
  const can = params?.style === "can";
  const halfLong = (can ? drum : length / 2) + 0.15;
  const halfWide = (can ? drum : width / 2) + 0.15;
  const mid = end / 2;
  const minX = Math.min(-0.3, mid - halfLong);
  return {
    minX,
    minY: -halfWide,
    width: Math.max(end + 0.3, mid + halfLong) - minX,
    height: 2 * halfWide,
  };
}

/**
 * A diode's body about `m`, leads along +x: a short body with the band on the
 * cathode end (pin 2) — black epoxy and a silver band for a rectifier, amber
 * glass and a black band for a Zener.
 */
function diodeBody(m, zener = false) {
  const mod = (base) => (zener ? `${base} ${base}--zener` : base);
  return [
    svgEl("rect", {
      class: mod("part-diode-body"),
      x: m.x - 0.75,
      y: m.y - 0.32,
      width: 1.5,
      height: 0.64,
      rx: 0.16,
    }),
    svgEl("rect", {
      class: mod("part-diode-band"),
      x: m.x + 0.4,
      y: m.y - 0.32,
      width: 0.2,
      height: 0.64,
    }),
  ];
}

/**
 * Where each colour band sits along a resistor's 2-pitch body, measured from
 * its middle: `[{color, at}]`, value bands from the left end and the tolerance
 * band set apart at the right. The ONE statement of the layout — the desk
 * draws it from here, and so does the 3D view (scene3d/part-models.js), so a
 * resistor reads the same from either.
 * @param {number} ohms
 * @returns {Array<{color: string, at: number}>}
 */
export function resistorBandLayout(ohms) {
  const bands = resistorBands(ohms);
  if (!bands.length) return [];
  const value = bands.slice(0, -1);
  const pitch = value.length > 3 ? 0.22 : 0.26;
  const first = -0.62;
  const at = [...value.map((_, i) => first + i * pitch), 0.62];
  return bands.map((color, i) => ({ color, at: at[i] }));
}

/**
 * A resistor's colour code (model/resistor-bands.js) as band rects across a
 * body two units long centred on `m`: the value bands grouped from the left
 * end, the tolerance band set apart at the right — which is how the real
 * part says which end to read from.
 */
function resistorBandRects(m, ohms) {
  return resistorBandLayout(ohms).map(({ color, at }) =>
    svgEl("rect", {
      class: `part-resistor-band part-resistor-band--${color}`,
      x: m.x + at - 0.065,
      y: m.y - 0.47,
      width: 0.13,
      height: 0.94,
    }),
  );
}

/** Whether an inductor prints its value on its own body — the can does, on
    its top; a toroid is all winding, so its value goes beside it. */
const printsOwnValue = (def, params) =>
  Boolean(def?.inductor) && params?.style === "can";

/**
 * A capacitor's printed value ("100n", "4.7µ", "10µ"), or a canned
 * inductor's ("4.7µH"), upright at `m` whatever angle its leads run at — text
 * that turns with the body reads upside down half the time. A body that
 * prints it off-centre (the electrolytic, clear of its stripe) moves it along
 * the lead at `angle` degrees. Null for a part with no value printed on it (a
 * bare inductor; a toroid, whose value goes BESIDE it).
 */
function valueLabel(ref, m, params, angle = 0) {
  const def = partDef(ref);
  const henries = printsOwnValue(def, params)
    ? formatHenries(Number(params?.henries))
    : "";
  const text = def?.capacitor
    ? formatFarads(Number(params?.farads))
    : henries
      ? `${henries}H`
      : "";
  if (!text) return null;
  const shift = SPAN_BODIES[ref]?.label ?? 0;
  const rad = (angle * Math.PI) / 180;
  const label = svgEl("text", {
    class: def.capacitor
      ? `part-cap-label part-cap-label--${ref}`
      : "part-inductor-label",
    x: m.x + shift * Math.cos(rad),
    y: m.y + shift * Math.sin(rad) + (def.capacitor ? 0.2 : 0.16),
    "text-anchor": "middle",
  });
  label.textContent = text;
  return label;
}

/**
 * What a two-lead part among the discretes prints BESIDE itself: its part
 * number, then a Zener's voltage or a toroid's inductance — a diode's body
 * has no room for either, and a toroid is all winding (a can prints its
 * value on its top instead). "" for a part with nothing to say (or one that
 * is not a discrete).
 */
function besideText(def, params) {
  if (!def?.countsAsConnection) return "";
  const volts = def.diode?.zener ? formatVolts(Number(params?.zenerVolts)) : "";
  const henries =
    def.inductor && !printsOwnValue(def, params)
      ? formatHenries(Number(params?.henries))
      : "";
  return [
    partNumberOf(params),
    volts ? `${volts}V` : "",
    henries ? `${henries}H` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * That text, upright, just clear of the body at `m`: BELOW it while the leads
 * run more across than down, to its RIGHT once they run more down than across
 * — always on the side a reader looks first, whichever way round the part was
 * placed.
 */
function spanLabel(ref, text, m, angle = 0, params = null) {
  const rad = (angle * Math.PI) / 180;
  let nx = -Math.sin(rad);
  let ny = Math.cos(rad);
  const below = Math.abs(ny) >= Math.abs(nx);
  if (below ? ny < 0 : nx < 0) {
    nx = -nx;
    ny = -ny;
  }
  const gap = bodySize(ref, params).across + 0.18;
  const label = svgEl("text", {
    class: "part-span-label",
    x: m.x + nx * gap,
    y: m.y + ny * gap + (below ? 0.36 : 0.15),
    "text-anchor": below ? "middle" : "start",
  });
  label.textContent = text;
  return label;
}

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
export function buildSpanSvg(ref, dx, dy, rawParams = {}) {
  // Coerced once here, so a body never draws from a half-filled params object
  // (a resistor's bands need its ohms, a capacitor's label its farads).
  const params = partDef(ref)?.normalizeParams?.(rawParams) ?? rawParams;
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
  // sanctioned exception the wires use) is the part that takes the pointer — a
  // long span's box would otherwise swallow clicks on the holes underneath it
  // — beside a body's own `.part-display-hit`, where it has one.
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
  const body = svgEl("g", { transform: `rotate(${angle} ${midX} ${midY})` });
  const m = { x: midX, y: midY };
  if (spec) body.append(...spec.build(m, params));
  body.append(spanFrame(ref, params, m, Math.hypot(dx, dy) / 2));
  svg.append(body);
  const value = valueLabel(ref, { x: midX, y: midY }, params, angle);
  if (value) svg.append(value);
  const beside = besideText(partDef(ref), params);
  if (beside) {
    svg.append(spanLabel(ref, beside, { x: midX, y: midY }, angle, params));
  }
  // Burn-out overlay (CSS shows it only on .part-discrete--burnt): a red X over
  // the LED — or a diode, which burns by the same rule — plus smoke, centred
  // on the same midpoint the body is. Smoke must rise in SCREEN space, not the
  // rotated frame, so it's built outside the rotated group.
  if (ref === "led" || partDef(ref)?.diode) {
    svg.append(buildBurnOverlay(midX, midY));
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
 * cathode (row f, local y -3, three pitches up). The slab is taller than its
 * own leg span (as tall as bar8's body, 3.8) rather than fitting inside the
 * trench like a real chip's body would — bar8iso reads as the same physical
 * bar-graph package as bar8, just wired isolated. That means the body (and
 * the bars on it) run 0.4 past BOTH hole rows, over the top of the anode and
 * cathode pins themselves, so no leg stub is drawn to either row — there is
 * no longer a gap for one to bridge. Widthwise it only overhangs its own
 * 8-column leg span by half a pitch a side (BODY_WIDTH below) — any more and
 * a neighbour seated flush against it would visibly overlap.
 */
function buildBarArrayDisplay(svg, color) {
  svg.style.setProperty("--wire-color", `var(--color-wire-${color})`);
  const bodyTop = -3.4; // 0.4 past the row-f holes (y -3)
  const bodyBottom = 0.4; // 0.4 past the row-e holes (y 0)
  const BODY_WIDTH = 8; // half a pitch past the leg span (columns 0…7) a side
  const bodyX = 3.5 - BODY_WIDTH / 2; // centred over legs at columns 0…7
  svg.append(
    svgEl("rect", {
      class: "part-display-body",
      x: bodyX,
      y: bodyTop,
      width: BODY_WIDTH,
      height: bodyBottom - bodyTop,
      rx: 0.3,
    }),
  );
  // Eight vertical bars, one per column: bar s(c+1) over the anode at column
  // c, inset 0.4 from the body's top/bottom edges — the same inset bar8 uses.
  for (let c = 0; c <= 7; c++) {
    svg.append(
      svgEl("rect", {
        class: "part-seg",
        "data-seg": `s${c + 1}`,
        x: c - 0.28,
        y: bodyTop + 0.4,
        width: 0.56,
        height: bodyBottom - bodyTop - 0.8,
        rx: 0.14,
      }),
    );
  }
  svg.append(buildBurnOverlay(3.5, (bodyTop + bodyBottom) / 2, 0.9));
  svg.append(
    svgEl("rect", {
      class: "part-display-hit",
      x: bodyX,
      y: bodyTop,
      width: BODY_WIDTH,
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
  badge.textContent = hzLabel(params.hz);
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

/**
 * The bussed resistor array (rnet9): a 9-pin SIP standing over one row of
 * holes, its beige body printed with the value and a dot marking the common
 * bus. Like the displays, the body stands ABOVE the legs so every hole
 * underneath stays clickable.
 *
 * THE DOT IS OVER PIN 1, always — which is what the dot means on the real
 * part, and pin 1 is the common bus. So it is derived from the same `rot` the
 * pin mapping is (model/occupancy.js): at rot 0 pin 1 is the anchor hole, and
 * a part turned end-for-end has it at the far end. The body itself is
 * symmetric, so the dot is the ONLY thing that moves — which is exactly why it
 * has to be right: it is the one mark on the desk saying which end the eight
 * elements bus to.
 */
function buildResistorNetwork(svg, ohms, rot) {
  const edgeY = -0.6;
  const bodyY = -2.4;
  const comX = rot === 180 ? 8 : 0;
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
  // The dot marks pin 1 — the common bus.
  svg.append(
    svgEl("circle", {
      class: "part-rnet-dot",
      cx: comX,
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

/** What a transistor with no part number says on its face. Identity, like a
    part number, so never translated. */
export const TYPE_LABEL = Object.freeze({
  npn: "NPN",
  pnp: "PNP",
  nmos: "NMOS",
  pmos: "PMOS",
});

/**
 * A transistor (the discretes), in whichever package it is (`transistorCase`
 * — a MOSFET's Package property): a TO-92 or a TO-220, seen from above.
 *
 * Either way its face carries what the real one does — its part number (the
 * type, until it has one) and its pin letters in the order they sit, which a
 * turned part (`rot` 180) reverses — and a LAMP: lit while the transistor
 * conducts, ringed amber while a MOSFET is holding its last state
 * (DiscreteView.setChannel), with a `<title>` on the body saying which, in
 * words. Only the body takes the pointer, so the holes around it stay
 * clickable.
 */
function buildTransistor(svg, def, params) {
  if (transistorCase(def, params) === "TO-220") buildTo220(svg, def, params);
  else buildTo92(svg, def, params);
}

/** The pin letters in the order they sit, left to right. */
const pinLetters = (def, params) => {
  const names = def.pins.map((p) => p.name);
  return params.rot === 180 ? [...names].reverse() : names;
};

/**
 * The printing on a transistor's face, centred at (`x`, `y`): its part number
 * or type at `size` (the stylesheet's, for the class `modifier` adds), shrunk
 * to fit `room` rather than spilling off the body.
 */
function transistorLabel(def, params, { x, y, size, room, modifier = "" }) {
  const text = partNumberOf(params) ?? TYPE_LABEL[def.transistor.type];
  const label = svgEl("text", {
    class: modifier
      ? `part-transistor-label part-transistor-label--${modifier}`
      : "part-transistor-label",
    x,
    y,
    "text-anchor": "middle",
  });
  const fit = Math.min(size, room / (Math.max(text.length, 1) * 0.6));
  if (fit < size) label.style.fontSize = `${fit}px`;
  label.textContent = text;
  return label;
}

/** The pin letters, one at each `xs`, on the baseline `y`. */
const pinLetterTexts = (def, params, xs, y) =>
  pinLetters(def, params).map((name, i) => {
    const pin = svgEl("text", {
      class: "part-transistor-pin",
      x: xs[i],
      y,
      "text-anchor": "middle",
    });
    pin.textContent = name;
    return pin;
  });

/** The lamp, and the body-only hit target carrying the conduction hint. */
function transistorLampAndHit(lamp, hitRect) {
  const hit = svgEl("g", { class: "part-transistor-hit" });
  hit.append(
    svgEl("title"),
    svgEl("rect", { class: "part-display-hit", ...hitRect }),
  );
  return [
    svgEl("circle", { class: "part-transistor-lamp", ...lamp, r: 0.12 }),
    hit,
  ];
}

/**
 * A TO-92: its moulding — the D of a disc with a flat face — centred on the
 * middle hole, the two outer legs fanning out to theirs. Like the pot it is
 * held a little short of the rows either side, so the holes a wire to its
 * pins plugs into stay clear.
 */
function buildTo92(svg, def, params) {
  const cx = 1;
  const cy = -0.02;
  const r = 0.72;
  const flat = 0.4;
  const half = Math.sqrt(r * r - (flat - cy) ** 2);
  // The outer legs, from their holes in under the moulding (the middle one is
  // beneath it).
  for (const x of [0, 2]) {
    svg.append(
      svgEl("line", {
        class: "part-span-lead",
        x1: x,
        y1: 0,
        x2: x === 0 ? cx - half + 0.05 : cx + half - 0.05,
        y2: 0.12,
      }),
    );
  }
  svg.append(
    svgEl("path", {
      class: "part-to92-body",
      d: `M ${cx - half} ${flat} A ${r} ${r} 0 1 1 ${cx + half} ${flat} Z`,
    }),
    ...pinLetterTexts(def, params, [cx - 0.38, cx, cx + 0.38], 0.3),
    transistorLabel(def, params, { x: cx, y: -0.08, size: 0.36, room: 1.3 }),
    ...transistorLampAndHit(
      { cx, cy: -0.46 },
      { x: cx - r, y: cy - r, width: 2 * r, height: flat - (cy - r) },
    ),
  );
}

/**
 * A TO-220 standing over its three holes (KiCad's TO-220-3_Vertical, TO220
 * above): the black moulding over the legs, which hides them, with its front
 * face toward the row in front, and the metal tab behind it — the two lines
 * across the tab are where it steps in to the mounting hole. Its pin letters
 * sit along the front edge over their own holes; the lamp sits on the tab.
 * The body overhangs the holes beside and behind it as the real part does,
 * but only the moulding over its own three holes takes the pointer.
 */
function buildTo220(svg, def, params) {
  const { left, width, back, tab, front } = TO220;
  const mould = back + tab;
  svg.append(
    svgEl("rect", {
      class: "part-to220-tab",
      x: left,
      y: back,
      width,
      height: tab,
    }),
    ...[0.27, 1.73].map((x) =>
      svgEl("line", {
        class: "part-to220-tab-line",
        x1: x,
        y1: back,
        x2: x,
        y2: mould,
      }),
    ),
    svgEl("rect", {
      class: "part-to220-body",
      x: left,
      y: mould,
      width,
      height: front - mould,
      rx: 0.06,
    }),
    ...pinLetterTexts(def, params, [0, 1, 2], front - 0.11),
    transistorLabel(def, params, {
      x: 1,
      y: -0.06,
      size: 0.42,
      room: width - 0.4,
      modifier: "to220",
    }),
    ...transistorLampAndHit(
      { cx: 1, cy: back + tab / 2 },
      { x: -0.55, y: mould, width: 3.1, height: front - mould },
    ),
  );
}

/**
 * The words a transistor's hover shows for its live state (a `<title>`):
 * conducting or off, and — for a MOSFET whose gate reads undefined — that it
 * is HOLDING that state, which is the thing worth being told.
 * @param {{on?: string, held?: boolean}|null} channel
 */
export function transistorHint(channel) {
  if (!channel) return "";
  const on = channel.on === "H";
  if (channel.held) {
    return on ? t("desk.transistor.heldOn") : t("desk.transistor.heldOff");
  }
  return on ? t("desk.transistor.on") : t("desk.transistor.off");
}

/**
 * A trimmer potentiometer (pot): a Bourns 3296-style blue block seen from
 * above, CENTRED over its three pins as the real part is — the row of pins
 * runs under the middle of the body, the wiper (hole 1) dead centre — so, like
 * a slide switch's, its pins are hidden beneath it. Only the body takes the
 * pointer; the holes around it stay clickable. It is printed with the track's
 * value, and its brass adjusting screw shows the wiper: the slot turns through
 * 270° as the Position goes 0 → 100 %, a dot on its rim marking which end is
 * the pointer (a bare slot reads the same both ways round).
 */
function buildPotentiometer(svg, { ohms, position }) {
  // About the middle pin (1, 0): a 3296W's full 9.5 mm long (3.7 pitch), but
  // 1.5 pitch deep against its 4.8 mm (1.9), so the body — outline included —
  // stops short of the holes in the rows either side (their squares start
  // 0.78 out), the ones a wire to its pins plugs into, rather than covering
  // part of them.
  const bodyW = 3.7;
  const bodyH = 1.5;
  const bodyX = 1 - bodyW / 2;
  const bodyY = -bodyH / 2;
  svg.append(
    svgEl("rect", {
      class: "part-pot-body",
      x: bodyX,
      y: bodyY,
      width: bodyW,
      height: bodyH,
      rx: 0.2,
    }),
  );
  const label = svgEl("text", {
    class: "part-pot-label",
    x: 0.55,
    y: 0.21,
    "text-anchor": "middle",
  });
  label.textContent = formatOhms(ohms);
  svg.append(label);
  // The screw, at the body's right-hand end as on the real part.
  const screw = { x: 2.25, y: 0 };
  const r = 0.42;
  const turn = ((-135 + 2.7 * position) * Math.PI) / 180;
  const along = { x: Math.sin(turn), y: -Math.cos(turn) };
  svg.append(
    svgEl("circle", {
      class: "part-pot-screw",
      cx: screw.x,
      cy: screw.y,
      r,
    }),
    svgEl("line", {
      class: "part-pot-slot",
      x1: screw.x - along.x * r * 0.8,
      y1: screw.y - along.y * r * 0.8,
      x2: screw.x + along.x * r * 0.8,
      y2: screw.y + along.y * r * 0.8,
    }),
    svgEl("circle", {
      class: "part-pot-pointer",
      cx: screw.x + along.x * r * 0.62,
      cy: screw.y + along.y * r * 0.62,
      r: 0.07,
    }),
    // Body-only hit target: the block drags, the holes around it stay
    // clickable.
    svgEl("rect", {
      class: "part-display-hit",
      x: bodyX,
      y: bodyY,
      width: bodyW,
      height: bodyH,
    }),
  );
}

/**
 * A DIP switch's body is TALLER than a chip's, because the real part is: a
 * 0.3-in DIP switch measures around 9.9 mm across its body against a plastic
 * DIP's 6.35, so it stands proud of its own pin rows where a chip sits well
 * inside them. That extra height is what the part is FOR — it is the actuator
 * travel, and squeezed into a chip's slab there was barely a nub's worth of it.
 *
 * It cannot overhang as far as the real part does: rows e and f sit at y 0 and
 * -3 and their hole squares are 0.44 across, so the body stops DIP_HOLE_GAP
 * short of them and the legs still show which columns are seated. Unlike the
 * character-LCD module — which insets its hit rect so the holes it covers stay
 * wireable — the hit rects here follow the body, because EVERY hole under a
 * bank's body is one of its own pins (pin i+1 in row e, pin 2n-i in row f) and
 * so is already spoken for. There is nothing under there to click.
 */
// Row f's centre (-3) + the hole square's half-width (0.22, breadboard-view's
// HOLE_SIZE) + 0.08 of board left showing, and the mirror of that at row e —
// so the two are symmetric about y -1.5, the centre the 180° flip turns about.
export const DIP_BODY_TOP = -2.7;
export const DIP_BODY_BOTTOM = -0.3;
/** How far a leg reaches past its hole's centre, so the seat still reads. */
const DIP_LEG_OVERSHOOT = 0.1;

/** The ON band: a printed strip along the edge the nub closes toward, deep
    enough to carry the word. It is the one cue that does NOT depend on colour
    — a green nub and a red one are the same nub to a colourblind reader, but
    "the nub is up against the ON band" is legible to anyone. */
const DIP_BAND_HEIGHT = 0.58;
/** How far the slot and its nub are held off the band and the body's far edge. */
const DIP_SLOT_INSET = 0.1;
const DIP_NUB_INSET = 0.06;
const DIP_NUB_HEIGHT = 0.64;

/**
 * A DIP switch bank (sw-dip1/2/4/8): a DIP-2n body straddling the trench with
 * n slide actuators in a row. Switch i's actuator sits over column i — its
 * OWN pin pair (the pins facing each other across the trench per
 * model/footprints.js's pinOffset), so what you click and what conducts are
 * the same column. The nub sits toward the row-f edge (the ON band) when
 * closed.
 *
 * Each actuator carries `data-switch-index` and NO listener of its own: a
 * bank position is a DURABLE param, so the CONTROLLER owns the write (the
 * house rule at the top of this file) — it reads the index off the pointer
 * event's target. The body-wide hit rect is appended BEFORE the per-switch
 * groups so a press between actuators still drags the package, while each
 * actuator's own (later, topmost) hit rect wins over its own column.
 */
function buildDipSwitchBank(svg, def, params) {
  const { halfPins: n } = packageSpec(def.package);
  const box = chipBox(def.package);
  const states = params.states ?? [];
  const bodyX = box.minX + 0.1;
  const bodyWidth = box.width - 0.2;
  const bodyHeight = DIP_BODY_BOTTOM - DIP_BODY_TOP;
  // The slot runs from under the ON band to the body's far edge; the nub
  // travels within it, and CLOSED is the end against the band.
  const slotY = DIP_BODY_TOP + DIP_BAND_HEIGHT + DIP_SLOT_INSET;
  const slotHeight = DIP_BODY_BOTTOM - DIP_SLOT_INSET - slotY;

  // Legs: the same stubs a chip draws, one pair per column — stated off the
  // body's own edges, so they stay tucked under it however tall it is.
  for (let dcol = 0; dcol < n; dcol++) {
    for (const [y, h] of [
      // down over the row-e holes, and up from the row-f holes to the body
      [DIP_BODY_BOTTOM - 0.05, 0.05 + DIP_LEG_OVERSHOOT - DIP_BODY_BOTTOM],
      [-3 - DIP_LEG_OVERSHOOT, DIP_BODY_TOP + 3 + DIP_LEG_OVERSHOOT],
    ]) {
      svg.append(
        svgEl("rect", {
          class: "part-chip-leg",
          x: dcol - 0.14,
          y,
          width: 0.28,
          height: h,
        }),
      );
    }
  }

  svg.append(
    svgEl("rect", {
      class: "part-body",
      x: bodyX,
      y: DIP_BODY_TOP,
      width: bodyWidth,
      height: bodyHeight,
      rx: 0.18,
    }),
    // The ON band marks which edge is "closed" — the row-f side.
    svgEl("rect", {
      class: "part-dip-on-bar",
      x: bodyX,
      y: DIP_BODY_TOP,
      width: bodyWidth,
      height: DIP_BAND_HEIGHT,
    }),
    // Body-only hit target: a press outside every actuator still drags the
    // package, same trick every wide discrete above uses.
    svgEl("rect", {
      class: "part-display-hit",
      x: bodyX,
      y: DIP_BODY_TOP,
      width: bodyWidth,
      height: bodyHeight,
    }),
  );

  // "ON" printed at the band's left end, exactly as the real part carries it —
  // the marking that says which way is closed without asking anyone to read a
  // colour. It rides the 180° flip below with the rest of the silkscreen, so a
  // bank seated backwards reads upside down and ON stays on the closing edge.
  const onLabel = svgEl("text", {
    class: "part-dip-on-label",
    x: bodyX + 0.16,
    y: DIP_BODY_TOP + DIP_BAND_HEIGHT - 0.15,
  });
  onLabel.textContent = "ON";
  svg.append(onLabel);

  // One slot + nub + hit target per switch, appended LAST so they win
  // hit-testing over the body-wide hit rect.
  for (let i = 0; i < n; i++) {
    const group = svgEl("g", {
      class: "part-dip-switch",
      "data-switch-index": i,
    });
    const on = states[i] === true;
    group.append(
      svgEl("rect", {
        class: "part-dip-slot",
        x: i - 0.24,
        y: slotY,
        width: 0.48,
        height: slotHeight,
        rx: 0.08,
      }),
      svgEl("rect", {
        class: on ? "part-dip-nub part-dip-nub--on" : "part-dip-nub",
        x: i - 0.18,
        y: on
          ? slotY + DIP_NUB_INSET
          : slotY + slotHeight - DIP_NUB_INSET - DIP_NUB_HEIGHT,
        width: 0.36,
        height: DIP_NUB_HEIGHT,
        rx: 0.06,
      }),
      svgEl("rect", {
        class: "part-display-hit",
        x: i - 0.45,
        y: DIP_BODY_TOP,
        width: 0.9,
        height: bodyHeight,
      }),
    );
    svg.append(group);
  }

  // Flipped 180°: the same half-lap turn chip-view.js's buildChipSvg uses —
  // the ON bar swings to the row-e side and switch 1's actuator lands at the
  // far end, matching where its pins now sit. Indices do NOT renumber:
  // switch i's actuator moves with switch i's pins, which is exactly right.
  if (params?.rot === 180) {
    const turned = svgEl("g", {
      class: "part-chip-flipped",
      transform: `rotate(180 ${(n - 1) / 2} -1.5)`,
    });
    while (svg.firstChild) turned.append(svg.firstChild);
    svg.append(turned);
  }
}

/** How far a hole's centre may sit from the LCD body's header edge before the
    hit rect gives way — half a pitch, so the next hole row stays wireable. */
const LCD_HIT_CLEAR = 0.5;
/** Stroke inset, so the body outline isn't clipped by the viewBox. */
const LCD_BODY_INSET = 0.05;
/** A Ø1.0 mm plated-through hole, in pitch units. */
const LCD_HOLE_R = 0.197;
/** A corner mounting hole: Ø2.5 mm, its centre 2.5 mm in from both edges. */
const LCD_MOUNT_R = 0.492;
const LCD_MOUNT_INSET = 0.984;
/** How far the silkscreen size badge is held off the right edge — clear of the
    mounting holes that now sit in that corner (2.5 mm + its radius, rounded
    up), so the two never overlap on the narrower 16×2 board. */
const LCD_BADGE_INSET = 2.4;

/**
 * A character-LCD module (HD44780), drawn as the three things a real one IS:
 * a bare PCB, the display module bonded to it, and the glass inside that —
 * plus the 16-way header printed where it plugs in, and the corner mounting
 * holes. Every rectangle comes from the def's `characterDisplay`, i.e. from
 * the measured module, so this function decides no geometry of its own and a
 * second module size is a catalog entry and nothing else.
 *
 * THE THREE RECTANGLES ARE THREE MATERIALS, and each gets its own tone: green
 * board, dark metal frame, backlit glass. The PCB and the frame used to share
 * the one dark bezel token, which read as a single black slab — survivable
 * while the drawing was a much larger industrial module's, half again the size
 * of the part it stood in for, because the slab was big enough to see the
 * opening inside it. At the real module's size the tones are what tell the
 * three apart.
 *
 * Deliberately NO leg stubs, unlike the digit/bar displays: those bodies stop
 * short of their hole row and a stub bridges the gap, but a real LCD module's
 * own PCB runs PAST its header — 0.98 units on both, since both carry the same
 * row of pins 2.5 mm off the same edge — so there is no gap for one to bridge.
 * Same situation `bar8iso` documents.
 *
 * The live characters are NOT drawn here — LcdView overlays a <canvas> on the
 * `.part-lcd-panel` rect, so this stays pure static DOM the placement ghost
 * can reuse.
 */
function buildCharacterDisplay(svg, def, params) {
  const cd = def.characterDisplay;
  const { body, window: win, screen } = cd;
  const headerBelowBody = cd.headerEdge === "bottom";

  // The backlight tint is the ONE thing params change here, and it goes
  // through a custom property (the buildDigitDisplay precedent) so a colour
  // change is a repaint rather than a different drawing.
  svg.style.setProperty(
    "--lcd-screen",
    `var(--color-lcd-screen-${params.color})`,
  );

  svg.append(
    svgEl("rect", {
      class: "part-lcd-body",
      x: body.minX + LCD_BODY_INSET,
      y: body.minY + LCD_BODY_INSET,
      width: body.width - 2 * LCD_BODY_INSET,
      height: body.height - 2 * LCD_BODY_INSET,
      rx: 0.5,
    }),
    svgEl("rect", {
      class: "part-lcd-window",
      x: win.x,
      y: win.y,
      width: win.width,
      height: win.height,
      rx: 0.2,
    }),
    svgEl("rect", {
      class: "part-lcd-panel",
      x: screen.x,
      y: screen.y,
      width: screen.width,
      height: screen.height,
    }),
  );

  // The four corner mounting holes — the one silkscreen feature that says
  // "this is a board", and the reason the badge below is held off the corner.
  for (const cx of [
    body.minX + LCD_MOUNT_INSET,
    body.minX + body.width - LCD_MOUNT_INSET,
  ]) {
    for (const cy of [
      body.minY + LCD_MOUNT_INSET,
      body.minY + body.height - LCD_MOUNT_INSET,
    ]) {
      svg.append(
        svgEl("circle", { class: "part-lcd-mount", cx, cy, r: LCD_MOUNT_R }),
      );
    }
  }

  // The header, at the local origin in both sizes: a solder strip, 16 plated
  // holes on the 0.1-in pitch, and a square pad on pin 1 — the silkscreen
  // convention, and the only thing saying which end of the run is pin 1.
  svg.append(
    svgEl("rect", {
      class: "part-lcd-header",
      x: -0.6,
      y: -0.6,
      width: 16.2,
      height: 1.2,
      rx: 0.25,
    }),
  );
  for (let i = 0; i < 16; i++) {
    svg.append(
      svgEl(i === 0 ? "rect" : "circle", {
        class: "part-lcd-hole",
        ...(i === 0
          ? {
              x: -LCD_HOLE_R,
              y: -LCD_HOLE_R,
              width: 2 * LCD_HOLE_R,
              height: 2 * LCD_HOLE_R,
            }
          : { cx: i, cy: 0, r: LCD_HOLE_R }),
      }),
    );
  }
  // The "1" goes BESIDE pin 1, not above or below it: at the module's real
  // size the band between the header and the PCB edge is ~1.5 mm, so a label
  // stacked on that side would spill off the board (and, on the header side,
  // onto the breadboard). There is room to the LEFT of the strip on both
  // modules, and it needs no headerEdge branch to find it.
  const pinLabel = svgEl("text", {
    class: "part-lcd-pin1-label",
    x: -0.95,
    y: 0.2,
    "text-anchor": "middle",
  });
  pinLabel.textContent = "1";
  svg.append(pinLabel);

  // Silkscreen size badge, in the wide bare band on the side AWAY from the
  // header — the one place on either module guaranteed to be clear.
  const badge = svgEl("text", {
    class: "part-lcd-size",
    x: body.minX + body.width - LCD_BADGE_INSET,
    y: headerBelowBody ? body.minY + 1.2 : body.minY + body.height - 0.7,
    "text-anchor": "end",
  });
  badge.textContent = `${cd.cols}×${cd.rows}`;
  svg.append(badge);

  // Body-only hit target, held clear of the hole row on the header side. The
  // full body would cover it: the PCB reaches 0.98 units past the header, which
  // stops just short of the next row's hole CENTRES but well inside the holes
  // themselves, so a click meant for a wire would start a drag instead.
  const hitTop = headerBelowBody ? body.minY + LCD_BODY_INSET : LCD_HIT_CLEAR;
  const hitBottom = headerBelowBody
    ? -LCD_HIT_CLEAR
    : body.minY + body.height - LCD_BODY_INSET;
  svg.append(
    svgEl("rect", {
      class: "part-display-hit",
      x: body.minX + LCD_BODY_INSET,
      y: hitTop,
      width: body.width - 2 * LCD_BODY_INSET,
      height: hitBottom - hitTop,
    }),
  );

  // Fault symbols over the glass, outside the hit rect so they never swallow a
  // click (same shape the oscillator can uses; DiscreteView.setStatus fills in
  // the <title>).
  const status = svgEl("g", { class: "part-can-status" });
  status.append(
    svgEl("title"),
    buildWarnOverlay(
      screen.x + screen.width / 2,
      screen.y + screen.height / 2,
      0.9,
    ),
    buildBurnOverlay(
      screen.x + screen.width / 2,
      screen.y + screen.height / 2,
      0.9,
    ),
  );
  svg.append(status);
}

/**
 * Build a discrete part's SVG from its catalog def + params. Pure DOM
 * construction (unit-testable under jsdom).
 */
export function buildDiscreteSvg(ref, params = {}) {
  const def = partDef(ref);
  const normalized = def.normalizeParams(params);
  const box = discreteBox(ref, normalized.rot, normalized);

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
      ...resistorBandRects({ x: 1.5, y: 0 }, normalized.ohms),
    );
  } else if (def.capacitor || def.diode || def.inductor) {
    // The footprint form (the placement ghost): a straight lead between the
    // two holes and the same body the span form draws, centred over them.
    const end = footprintOffsets(def, normalized).at(-1);
    const m = { x: end / 2, y: 0 };
    svg.append(
      svgEl("line", {
        class: "part-span-lead",
        x1: 0,
        y1: 0,
        x2: end,
        y2: 0,
      }),
      ...SPAN_BODIES[ref].build(m, normalized),
    );
    const value = valueLabel(ref, m, normalized);
    if (value) svg.append(value);
  } else if (def.transistor) {
    buildTransistor(svg, def, normalized);
  } else if (ref === "seg8cc" || ref === "seg8ca") {
    buildDigitDisplay(svg, normalized.color);
  } else if (ref === "bar8") {
    buildBarDisplay(svg, normalized.color);
  } else if (ref === "bar8iso") {
    buildBarArrayDisplay(svg, normalized.color);
  } else if (ref === "osc-full" || ref === "osc-half") {
    buildOscillatorCan(svg, def, normalized);
  } else if (def.characterDisplay) {
    buildCharacterDisplay(svg, def, normalized);
  } else if (ref === "rnet9") {
    buildResistorNetwork(svg, normalized.ohms, normalized.rot);
  } else if (ref === "pot") {
    buildPotentiometer(svg, normalized);
  } else if (def.switchBank) {
    buildDipSwitchBank(svg, def, normalized);
  } else {
    // LED dome centred on the two holes (both axes — so swapping which hole
    // either pin lands in never moves it); the flat chord marks the CATHODE
    // side (right by default — pin 2; params.flip mirrors it to the left).
    const cathodeRight = !normalized.flip;
    const flatX = cathodeRight ? 1.15 : -0.15;
    svg.append(
      svgEl("circle", {
        class: `part-led-dome part-led-dome--${normalized.color}`,
        cx: 0.5,
        cy: 0,
        r: 0.85,
      }),
      svgEl("rect", {
        class: "part-led-flat",
        x: flatX,
        y: -0.75,
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
  // What `setStatus` last drew — undefined until it has, and again whenever
  // the SVG (and the hint inside it) is rebuilt — so the status that arrives
  // unchanged with every tick touches nothing.
  #status = undefined;
  #statusVolts = undefined;
  #segs = null; // segId → its element, while this SVG stands (`#seg`)

  /**
   * @param {HTMLElement} layer - the `.layer-parts` element.
   * @param {{id:string,ref:string,params:object}} component
   * @param {object} [callbacks]
   * @param {(id: string, e: PointerEvent) => void} [callbacks.onPointerDown]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onContextMenu]
   */
  constructor(layer, component, { onPointerDown, onContextMenu } = {}) {
    this.#id = component.id;
    this.#ref = component.ref;
    // EVERY rotatable part renders as a span (body centred between its two
    // ends, rotated to the lead angle) — the controller draws it via
    // updateSpanWorld.
    this.#rotated = Boolean(partDef(component.ref)?.rotatable);
    this.#params = component.params ?? {};
    this.#el = el("div", {
      // A span part draws its own selection frame (spanFrame), in place of
      // the element outline every other part takes.
      class: `part part-discrete part-discrete--${component.ref}${this.#rotated ? " part-discrete--span" : ""}`, // prettier-ignore
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
    this.#rebuilt();
    if (this.#ref === "sw-push") this.#bindCap();
  }

  /** A new SVG: what was looked up or drawn in the old one is gone. */
  #rebuilt() {
    this.#segs = null;
    this.#status = undefined;
    this.#statusVolts = undefined;
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
    this.#rebuilt();
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
    const box = discreteBox(this.#ref, this.#params?.rot, this.#params);
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
   * How bright a lit LED glows (Spice Lite: 1 at its datasheet's current,
   * dimmer below, a wider halo past it), or null for the plain lit look.
   * Written only when it changes — it arrives with every tick.
   */
  setLevel(level) {
    const text = level == null ? "" : String(level);
    if (this.#el.style.getPropertyValue("--led-level") === text) return;
    if (text) this.#el.style.setProperty("--led-level", text);
    else this.#el.style.removeProperty("--led-level");
  }

  /**
   * Reflect the simulator's power/health status (Feature 90) — only an
   * oscillator can actually has a status overlay to reveal; every other
   * discrete's classList toggle is a harmless no-op. `null` clears it.
   */
  setStatus(status, volts = null) {
    if (status === this.#status && volts === this.#statusVolts) return;
    this.#status = status;
    this.#statusVolts = volts;
    for (const s of [
      "unpowered",
      "underpowered",
      "reversed",
      "damaged",
      "overloaded",
    ]) {
      this.#el.classList.toggle(`part-discrete--${s}`, status === s);
    }
    const title = this.#el.querySelector(".part-can-status > title");
    if (title) {
      title.textContent = statusHint(status, {
        volts,
        def: partDef(this.#ref),
      });
    }
  }

  /**
   * A transistor's live state (the discretes): whether its
   * channel conducts, and whether a MOSFET is holding its last state because
   * its gate reads undefined — the lamp on its face, and the words on its
   * hover. `null` (stopped) clears both.
   * @param {{on?: string, held?: boolean}|null} channel
   */
  setChannel(channel) {
    this.#el.classList.toggle("part-discrete--on", channel?.on === "H");
    this.#el.classList.toggle("part-discrete--held", channel?.held === true);
    const title = this.#el.querySelector(".part-transistor-hit > title");
    if (title) title.textContent = transistorHint(channel);
  }

  /** One segment's element (the first drawn with its `data-seg`), looked up
      once per SVG: three setters ask for every segment on every tick. */
  #seg(segId) {
    if (!this.#segs) {
      this.#segs = new Map();
      for (const node of this.#el.querySelectorAll("[data-seg]")) {
        const id = node.getAttribute("data-seg");
        if (!this.#segs.has(id)) this.#segs.set(id, node);
      }
    }
    return this.#segs.get(String(segId)) ?? null;
  }

  /** Light one segment of a multi-segment display (anode-H / cathode-L). */
  setSegmentLit(segId, on) {
    this.#seg(segId)?.classList.toggle("part-seg--lit", on);
  }

  /** Mark one segment over-driven (conducting with no series resistor). */
  setSegmentBurnt(segId, on) {
    this.#seg(segId)?.classList.toggle("part-seg--burnt", on);
  }

  /** One segment's brightness — `setLevel` for a segment. */
  setSegmentLevel(segId, level) {
    const seg = this.#seg(segId);
    if (!seg) return;
    const text = level == null ? "" : String(level);
    if (seg.style.getPropertyValue("--led-level") === text) return;
    if (text) seg.style.setProperty("--led-level", text);
    else seg.style.removeProperty("--led-level");
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
