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

// kicad-symbols.js — the KiCad library symbol for each catalog part, drawn
// from its catalog pins (Feature 390).
//
// OUR OWN SYMBOLS, not KiCad's 74xx library's. KiCad draws a 7400 as four gate
// units plus a power unit; a breadboard design has one chip with fourteen
// pins, and every pin number here IS the physical pin (or, for a part whose
// footprint numbers its pads otherwise, the pad — kicad-parts.js). The box is
// laid out the way the Schematic view lays out a chip (catalog/symbols.js):
// power on top and bottom, inputs left, outputs right — with every pin shown,
// since a PCB needs all of them where the view may fold a bus into one stub.
//
// COORDINATES are KiCad's library convention: millimetres, y UP, every pin tip
// on the 1.27 mm (50 mil) grid, which is what lets a wire meet it. A pin's
// `(at x y angle)` is its free end — the point a wire connects to — and the
// angle points from there INTO the body.

import { pinType } from "./kicad-parts.js";
import { q } from "./sexpr.js";

/** Pin pitch and length (100 mil), and the grid everything sits on. */
export const PITCH = 2.54;
export const GRID = 1.27;
const PIN_LEN = 2.54;
/** How far inside the body a pin's name starts, from the pin's root. */
export const PIN_NAME_OFFSET = 1.016;
/** A rough stroke-font advance per character at 1.27 mm, for sizing boxes. */
export const CHAR_W = 1.1;

const FONT = ["effects", ["font", ["size", 1.27, 1.27]]];
/** KiCad 8 writes a hidden field as `(effects (font …) (hide yes))`. */
export const EFFECTS_HIDDEN = [
  "effects",
  ["font", ["size", 1.27, 1.27]],
  ["hide", "yes"],
];
/** Field text, optionally justified (`left bottom`, `left`, …). */
export function effects(...justify) {
  return justify.length
    ? ["effects", ["font", ["size", 1.27, 1.27]], ["justify", ...justify]]
    : FONT;
}

/**
 * A pin name as KiCad markup: the catalog spells an overbar with a combining
 * macron (`1Q̄`), KiCad with `~{…}`.
 */
export function pinLabel(name) {
  const text = String(name ?? "");
  if (/̄$/.test(text)) return `~{${text.slice(0, -1)}}`;
  return text;
}

/** The width of a label as drawn (markup braces are not drawn). */
function textWidth(text) {
  return String(text).replace(/[~_^]\{|\}/g, "").length * CHAR_W;
}

const up = (v, step = PITCH) => Math.ceil(v / step - 1e-9) * step;

/**
 * Which side of a box each pin goes on, in draw order (a `null` in a column
 * is an empty row).
 * @param {object} def
 * @param {(key:string) => string} pad
 * @returns {{left:Array, right:Array, top:Array, bottom:Array}}
 */
function boxSides(def, ports, pad) {
  const sides = { left: [], right: [], top: [], bottom: [] };
  const pin = (port) => ({
    number: pad(port.key),
    name: pinLabel(port.name),
    type: pinType(def, port),
  });

  if (def.kind === "psu" || def.kind === "clock") {
    // A connector's pins, a row apart, so the rail symbols hanging off them
    // have room.
    ports.forEach((port, i) => {
      if (i) sides.right.push(null);
      sides.right.push(pin(port));
    });
    return sides;
  }
  if (def.switchBank) {
    // Pole k's two contacts face each other, as they do in the view.
    const n = ports.length / 2;
    const byPin = new Map(ports.map((p) => [p.pin, p]));
    for (let i = 1; i <= n; i++) {
      sides.left.push(pin(byPin.get(i)));
      sides.right.push(pin(byPin.get(2 * n + 1 - i)));
    }
    return sides;
  }
  const powered = ports.some((p) => p.role === "vcc" || p.role === "gnd");
  const nc = [];
  for (const port of ports) {
    if (powered || def.kind === "chip") {
      if (port.role === "vcc") sides.top.push(pin(port));
      else if (port.role === "gnd") sides.bottom.push(pin(port));
      else if (port.role === "output") sides.right.push(pin(port));
      else if (port.role === "nc") nc.push(pin(port));
      else sides.left.push(pin(port));
    } else if (["cathode", "common", "gnd"].includes(port.role)) {
      sides.right.push(pin(port));
    } else {
      sides.left.push(pin(port));
    }
  }
  sides.left.push(...nc); // real pins, listed last so they stay out of the way
  return sides;
}

function pinNode({ type, number, name }, x, y, angle, len = PIN_LEN) {
  return [
    "pin",
    type,
    "line",
    ["at", x, y, angle],
    ["length", len],
    ["name", q(name), FONT],
    ["number", q(number), FONT],
  ];
}

const stroke = (width = 0.254) => [
  "stroke",
  ["width", width],
  ["type", "default"],
];
const fill = (type = "none") => ["fill", ["type", type]];
const poly = (points, fillType = "none", width = 0.254) => [
  "polyline",
  ["pts", ...points.map(([x, y]) => ["xy", x, y])],
  stroke(width),
  fill(fillType),
];

/**
 * @typedef {object} KicadSymbol
 * @property {string} name        the symbol's name in the library
 * @property {Array} graphics     body drawing nodes (unit 0)
 * @property {Array} pinNodes     pin nodes (unit 1)
 * @property {Map<string,{x:number,y:number,side:string}>} pins
 *   pad number → the pin's free end and which way it faces
 * @property {{minX:number,maxX:number,minY:number,maxY:number}} box
 *   the body's extent (library coords, y up)
 * @property {boolean} compact    a two-terminal shape: numbers and names hidden
 * @property {{reference:object, value:object}} fields  where the Reference and
 *   Value text sit, `{x, y, justify}` in library coords
 */

/**
 * A labelled box with pins on its four sides. The Value (the part number)
 * sits IN the box, centred, the way the Schematic view labels a chip — so the
 * box is made wide enough for it between the two columns of pin names, tall
 * enough for it between the top and bottom pins' names (which read down into
 * the body: a 6-pin chip's VCC and GND met in the middle of a box sized by its
 * three rows alone), and the Reference sits above its top-left corner, clear
 * of a centred VCC pin.
 */
function boxSymbol(name, sides, valueWidth) {
  const rows = Math.max(sides.left.length, sides.right.length, 1);
  const width = (list) =>
    Math.max(0, ...list.filter(Boolean).map((p) => textWidth(p.name)));
  const reach = Math.max(width(sides.top), width(sides.bottom));
  const h = Math.max(
    (rows + 1) * PITCH,
    reach ? up(2 * (PIN_NAME_OFFSET + reach + GRID), PITCH) : 0,
  );
  const leftW = width(sides.left);
  const rightW = width(sides.right);
  const across = Math.max(sides.top.length, sides.bottom.length);
  const w = Math.max(
    3 * PITCH * 2,
    up(2 * Math.max(leftW, rightW) + valueWidth + 2 * PITCH, 2 * PITCH),
    up((across + 1) * PITCH, 2 * PITCH),
  );
  const hw = w / 2;
  const hh = h / 2;

  const pins = new Map();
  const pinNodes = [];
  const column = (list, side) => {
    list.forEach((p, i) => {
      if (!p) return; // a spacer row
      const y = ((rows - 1) / 2 - i) * PITCH;
      const x = side === "left" ? -(hw + PIN_LEN) : hw + PIN_LEN;
      pinNodes.push(pinNode(p, x, y, side === "left" ? 0 : 180));
      pins.set(p.number, { x, y, side });
    });
  };
  const row = (list, side) => {
    list.forEach((p, i) => {
      const x = (i - (list.length - 1) / 2) * PITCH;
      const y = side === "top" ? hh + PIN_LEN : -(hh + PIN_LEN);
      pinNodes.push(pinNode(p, x, y, side === "top" ? 270 : 90));
      pins.set(p.number, { x, y, side });
    });
  };
  column(sides.left, "left");
  column(sides.right, "right");
  row(sides.top, "top");
  row(sides.bottom, "bottom");

  return {
    name,
    graphics: [
      [
        "rectangle",
        ["start", -hw, hh],
        ["end", hw, -hh],
        stroke(),
        fill("background"),
      ],
    ],
    pinNodes,
    pins,
    box: { minX: -hw, maxX: hw, minY: -hh, maxY: hh },
    compact: false,
    fields: {
      reference: { x: -hw, y: hh + GRID, justify: ["left", "bottom"] },
      value: { x: 0, y: 0, justify: [] },
    },
  };
}

/** A two-terminal body between pins at ±`reach`. */
function twoPin(name, pins, graphics, reach, halfHeight) {
  const map = new Map();
  const pinNodes = pins.map((p) => {
    map.set(p.number, { x: p.x, y: p.y, side: p.side });
    return pinNode(p, p.x, p.y, p.side === "left" ? 0 : 180, p.len);
  });
  return {
    name,
    graphics,
    pinNodes,
    pins: map,
    box: { minX: -reach, maxX: reach, minY: -halfHeight, maxY: halfHeight },
    compact: true,
    fields: {
      reference: { x: 0, y: halfHeight + 2 * GRID, justify: [] },
      value: { x: 0, y: -halfHeight - 2 * GRID, justify: [] },
    },
  };
}

function resistorSymbol(name) {
  return twoPin(
    name,
    [
      { number: "1", name: "~", type: "passive", x: -5.08, y: 0, side: "left" },
      { number: "2", name: "~", type: "passive", x: 5.08, y: 0, side: "right" },
    ],
    [
      [
        "rectangle",
        ["start", -2.54, 1.016],
        ["end", 2.54, -1.016],
        stroke(),
        fill("none"),
      ],
    ],
    2.54,
    1.016,
  );
}

/**
 * A potentiometer: the resistor's body between pins 1 and 3, and the wiper
 * (pin 2) coming down onto it from above, ending in an arrowhead — KiCad's
 * Device:R_Potentiometer turned on its side to match the resistor here. The
 * Reference sits beside the wiper rather than over it, and the Value below.
 */
function potentiometerSymbol(name) {
  const pins = [
    { number: "1", name: "~", type: "passive", x: -5.08, y: 0, side: "left" },
    { number: "3", name: "~", type: "passive", x: 5.08, y: 0, side: "right" },
    { number: "2", name: "~", type: "passive", x: 0, y: 3.81, side: "top" },
  ];
  const ANGLE = { left: 0, right: 180, top: 270 };
  const map = new Map();
  const pinNodes = pins.map((p) => {
    map.set(p.number, { x: p.x, y: p.y, side: p.side });
    const len = p.side === "top" ? GRID : PIN_LEN;
    return pinNode(p, p.x, p.y, ANGLE[p.side], len);
  });
  return {
    name,
    graphics: [
      [
        "rectangle",
        ["start", -2.54, 1.016],
        ["end", 2.54, -1.016],
        stroke(),
        fill("none"),
      ],
      poly([
        [0, 2.54],
        [0, 1.778],
      ]),
      poly(
        [
          [-0.508, 1.778],
          [0, 1.016],
          [0.508, 1.778],
          [-0.508, 1.778],
        ],
        "outline",
      ),
    ],
    pinNodes,
    pins: map,
    box: { minX: -2.54, maxX: 2.54, minY: -1.016, maxY: 1.016 },
    compact: true,
    fields: {
      reference: { x: GRID, y: 2.54, justify: ["left"] },
      value: { x: 0, y: -1.016 - 2 * GRID, justify: [] },
    },
  };
}

/**
 * A capacitor: two plates across a gap — KiCad's Device:C shape — or, for a
 * polarised one, Device:C_Polarized's open box for the + plate and a filled
 * one for −, with a + mark on pin 1's side.
 */
function capacitorSymbol(name, polarized) {
  const graphics = polarized
    ? [
        [
          "rectangle",
          ["start", -0.762, 2.286],
          ["end", -0.254, -2.286],
          stroke(),
          fill("none"),
        ],
        [
          "rectangle",
          ["start", 0.762, 2.286],
          ["end", 0.254, -2.286],
          stroke(),
          fill("outline"),
        ],
        poly([
          [-2.286, 2.286],
          [-1.27, 2.286],
        ]),
        poly([
          [-1.778, 2.794],
          [-1.778, 1.778],
        ]),
      ]
    : [
        poly([
          [-0.762, 2.032],
          [-0.762, -2.032],
        ]),
        poly([
          [0.762, 2.032],
          [0.762, -2.032],
        ]),
      ];
  return twoPin(
    name,
    [
      {
        number: "1",
        name: polarized ? "+" : "~",
        type: "passive",
        x: -3.81,
        y: 0,
        side: "left",
        len: 3.048, // to the plate, as Device:C draws it
      },
      {
        number: "2",
        name: polarized ? "-" : "~",
        type: "passive",
        x: 3.81,
        y: 0,
        side: "right",
        len: 3.048,
      },
    ],
    graphics,
    1.27,
    2.286,
  );
}

function ledSymbol(name) {
  return twoPin(
    name,
    [
      // KiCad's own LED numbering: 1 = K, 2 = A (kicad-parts.js).
      { number: "2", name: "A", type: "passive", x: -3.81, y: 0, side: "left" },
      { number: "1", name: "K", type: "passive", x: 3.81, y: 0, side: "right" },
    ],
    [
      poly([
        [-1.27, 1.27],
        [-1.27, -1.27],
        [1.27, 0],
        [-1.27, 1.27],
      ]),
      poly([
        [1.27, 1.27],
        [1.27, -1.27],
      ]),
      poly(
        [
          [-0.508, 1.778],
          [0.762, 3.048],
        ],
        "none",
        0.1524,
      ),
      poly(
        [
          [0.508, 1.778],
          [1.778, 3.048],
        ],
        "none",
        0.1524,
      ),
    ],
    1.27,
    1.27,
  );
}

/**
 * A diode — KiCad's Device:D drawn on its side, or Device:D_Zener with the
 * cathode bar's ends bent — numbered as KiCad numbers both: pin 1 the CATHODE
 * (kicad-parts.js maps our pin 2 onto it), pin 2 the anode.
 */
function diodeSymbol(name, zener) {
  return twoPin(
    name,
    [
      { number: "2", name: "A", type: "passive", x: -3.81, y: 0, side: "left" },
      { number: "1", name: "K", type: "passive", x: 3.81, y: 0, side: "right" },
    ],
    [
      poly([
        [-1.27, 1.27],
        [-1.27, -1.27],
        [1.27, 0],
        [-1.27, 1.27],
      ]),
      poly(
        zener
          ? [
              [0.762, 1.27],
              [1.27, 1.27],
              [1.27, -1.27],
              [1.778, -1.27],
            ]
          : [
              [1.27, 1.27],
              [1.27, -1.27],
            ],
      ),
    ],
    1.27,
    1.27,
  );
}

/**
 * A bridge rectifier — a diamond of four diodes, as KiCad's Device:D_Bridge
 * draws one: + at the top corner (two cathodes), − at the bottom (two
 * anodes), the AC pins left and right. Numbered as the DB-1 is and as the
 * footprint's pads are (kicad-parts.js): 1 +, 2 −, 3 and 4 ~.
 */
function bridgeSymbol(name) {
  const r = 5.08;
  const corner = { t: [0, r], b: [0, -r], l: [-r, 0], rt: [r, 0] };
  const graphics = [poly([corner.l, corner.t, corner.rt, corner.b, corner.l])];
  const s = 0.762;
  for (const [[ax, ay], [kx, ky]] of [
    [corner.l, corner.t],
    [corner.rt, corner.t],
    [corner.b, corner.l],
    [corner.b, corner.rt],
  ]) {
    const len = Math.hypot(kx - ax, ky - ay);
    const [ux, uy] = [(kx - ax) / len, (ky - ay) / len];
    const [nx, ny] = [-uy, ux];
    const [mx, my] = [(ax + kx) / 2, (ay + ky) / 2];
    const tip = [mx + s * ux, my + s * uy];
    const round2 = (v) => Math.round(v * 1e4) / 1e4;
    const pt = (x, y) => [round2(x), round2(y)];
    graphics.push(
      poly([
        pt(mx - s * ux + s * nx, my - s * uy + s * ny),
        pt(mx - s * ux - s * nx, my - s * uy - s * ny),
        pt(...tip),
        pt(mx - s * ux + s * nx, my - s * uy + s * ny),
      ]),
      poly([
        pt(tip[0] + s * nx, tip[1] + s * ny),
        pt(tip[0] - s * nx, tip[1] - s * ny),
      ]),
    );
  }
  const pinList = [
    { number: "1", name: "+", x: 0, y: r + PIN_LEN, angle: 270, side: "top" },
    { number: "2", name: "-", x: 0, y: -r - PIN_LEN, angle: 90, side: "bottom" }, // prettier-ignore
    { number: "3", name: "~", x: r + PIN_LEN, y: 0, angle: 180, side: "right" },
    { number: "4", name: "~", x: -r - PIN_LEN, y: 0, angle: 0, side: "left" },
  ];
  const pins = new Map();
  const pinNodes = pinList.map((p) => {
    pins.set(p.number, { x: p.x, y: p.y, side: p.side });
    return pinNode({ ...p, type: "passive" }, p.x, p.y, p.angle);
  });
  return {
    name,
    graphics,
    pinNodes,
    pins,
    box: { minX: -r, maxX: r, minY: -r, maxY: r },
    compact: false,
    fields: {
      reference: { x: 2.54, y: r - 1.27, justify: ["left"] },
      value: { x: 2.54, y: -r + 1.27, justify: ["left"] },
    },
  };
}

/** One arc through `mid`, KiCad's `(arc (start) (mid) (end))`. */
const arc = (start, mid, end) => [
  "arc",
  ["start", ...start],
  ["mid", ...mid],
  ["end", ...end],
  stroke(),
  fill(),
];

/** An inductor — KiCad's Device:L on its side: four turns between the pins. */
function inductorSymbol(name) {
  const turns = [-2.54, -1.27, 0, 1.27].map((x) =>
    arc([x, 0], [x + 0.635, 0.635], [x + 1.27, 0]),
  );
  return twoPin(
    name,
    [
      { number: "1", name: "1", type: "passive", x: -3.81, y: 0, side: "left" },
      { number: "2", name: "2", type: "passive", x: 3.81, y: 0, side: "right" },
    ],
    turns,
    2.54,
    1.016,
  );
}

/** A speaker — KiCad's Device:Speaker: the magnet's box, the cone flaring
    out of it, both pins in from the left (1 the +, above). */
function speakerSymbol(name) {
  return twoPin(
    name,
    [
      { number: "1", name: "1", type: "passive", x: -5.08, y: 1.27, side: "left" }, // prettier-ignore
      { number: "2", name: "2", type: "passive", x: -5.08, y: -1.27, side: "left" }, // prettier-ignore
    ],
    [
      [
        "rectangle",
        ["start", -2.54, 2.54],
        ["end", 1.016, -2.54],
        stroke(),
        fill("none"),
      ],
      poly([
        [1.016, 2.54],
        [3.556, 5.08],
        [3.556, -5.08],
        [1.016, -2.54],
      ]),
    ],
    5.08,
    5.08,
  );
}

/** A filled arrowhead with its tip at `tip`, pointing along `dir`. */
function arrowhead(tip, dir, size = 0.9) {
  const len = Math.hypot(dir[0], dir[1]) || 1;
  const [ux, uy] = [dir[0] / len, dir[1] / len];
  const base = [tip[0] - ux * size, tip[1] - uy * size];
  const r = (v) => Math.round(v * 1000) / 1000;
  const side = (k) => [r(base[0] - uy * k), r(base[1] + ux * k)];
  const a = side(size * 0.4);
  const b = side(-size * 0.4);
  return poly([tip, a, b, tip], "outline");
}

/**
 * A transistor, drawn to KiCad's Device:Q_NPN / Q_PNP / Q_NMOS / Q_PMOS: the
 * base or gate in from the left, the switched pins out of the top and bottom
 * at x 2.54, all in a circle. Pins are NUMBERED as ours are (1·2·3 = E·B·C or
 * S·G·D — KiCad 9's own Q_* number theirs by letter, which no TO-92 pad
 * matches), so the TO-92 footprint's pads line up with the desk's order.
 *
 * `top`/`bottom` name which of our pins leaves each way: current flows in at
 * the top (an NPN's collector, a PNP's emitter, an N-channel's drain, a
 * P-channel's source).
 */
function transistorSymbol(name, type) {
  const bjt = type === "npn" || type === "pnp";
  const [top, bottom] =
    type === "npn" || type === "nmos"
      ? [{ number: "3" }, { number: "1" }]
      : [{ number: "1" }, { number: "3" }];
  const letters = bjt ? { 1: "E", 2: "B", 3: "C" } : { 1: "S", 2: "G", 3: "D" };
  const lead = bjt ? 2.54 : 3.302;
  const pins = [
    { number: "2", x: -5.08, y: 0, side: "left", angle: 0, len: bjt ? 5.715 : 5.334 }, // prettier-ignore
    { ...top, x: 2.54, y: 5.08, side: "top", angle: 270, len: lead },
    { ...bottom, x: 2.54, y: -5.08, side: "bottom", angle: 90, len: lead },
  ];
  const map = new Map();
  const pinNodes = pins.map((p) => {
    map.set(p.number, { x: p.x, y: p.y, side: p.side });
    return pinNode(
      { type: "passive", number: p.number, name: letters[p.number] },
      p.x,
      p.y,
      p.angle,
      p.len,
    );
  });
  const circle = (cx, r) => [
    "circle",
    ["center", cx, 0],
    ["radius", r],
    stroke(),
    fill(),
  ];
  let graphics;
  if (bjt) {
    graphics = [
      circle(1.27, 2.8448),
      poly(
        [
          [0.635, 1.905],
          [0.635, -1.905],
        ],
        "none",
        0.508,
      ),
      poly([
        [0.635, 0.635],
        [2.54, 2.54],
      ]),
      poly([
        [0.635, -0.635],
        [2.54, -2.54],
      ]),
      // The emitter's arrow: OUT along the lower diagonal for an NPN, IN
      // along the upper one for a PNP.
      type === "npn"
        ? arrowhead([2.286, -2.286], [1, -1])
        : arrowhead([1.016, 1.016], [-1, -1]),
    ];
  } else {
    // The body ties to the source: the bottom pin of an N-channel, the top of
    // a P-channel.
    const source = type === "nmos" ? -1.778 : 1.778;
    graphics = [
      circle(1.651, 2.794),
      poly([
        [0.254, 1.905],
        [0.254, -1.905],
      ]),
      ...[
        [2.286, 1.27],
        [0.508, -0.508],
        [-1.27, -2.286],
      ].map(([a, b]) =>
        poly(
          [
            [0.762, a],
            [0.762, b],
          ],
          "none",
          0.254,
        ),
      ),
      poly([
        [0.762, 1.778],
        [2.54, 1.778],
      ]),
      poly([
        [0.762, -1.778],
        [2.54, -1.778],
      ]),
      poly([
        [0.762, 0],
        [2.54, 0],
        [2.54, source],
      ]),
      type === "nmos"
        ? arrowhead([1.016, 0], [-1, 0])
        : arrowhead([2.286, 0], [1, 0]),
    ];
  }
  return {
    name,
    graphics,
    pinNodes,
    pins: map,
    box: { minX: -1.6, maxX: 4.5, minY: -2.9, maxY: 2.9 },
    compact: true,
    fields: {
      reference: { x: 5.08, y: 1.27, justify: ["left"] },
      value: { x: 5.08, y: -1.27, justify: ["left"] },
    },
  };
}

function spstSymbol(name) {
  return twoPin(
    name,
    [
      { number: "1", name: "1", type: "passive", x: -5.08, y: 0, side: "left" },
      { number: "2", name: "2", type: "passive", x: 5.08, y: 0, side: "right" },
    ],
    [
      ["circle", ["center", -2.032, 0], ["radius", 0.508], stroke(), fill()],
      ["circle", ["center", 2.032, 0], ["radius", 0.508], stroke(), fill()],
      poly([
        [-2.54, 1.524],
        [2.54, 1.524],
      ]),
      poly([
        [0, 1.524],
        [0, 3.048],
      ]),
    ],
    2.54,
    1.524,
  );
}

function spdtSymbol(name) {
  return twoPin(
    name,
    [
      // pin 2 is the common; pin 1 the upper throw, pin 3 the lower — as the
      // Schematic view draws it.
      { number: "2", name: "C", type: "passive", x: -5.08, y: 0, side: "left" },
      {
        number: "1",
        name: "1",
        type: "passive",
        x: 5.08,
        y: 2.54,
        side: "right",
      },
      {
        number: "3",
        name: "2",
        type: "passive",
        x: 5.08,
        y: -2.54,
        side: "right",
      },
    ],
    [
      ["circle", ["center", -2.032, 0], ["radius", 0.508], stroke(), fill()],
      ["circle", ["center", 2.032, 2.54], ["radius", 0.508], stroke(), fill()],
      ["circle", ["center", 2.032, -2.54], ["radius", 0.508], stroke(), fill()],
      poly([
        [-1.524, 0.254],
        [1.778, 2.032],
      ]),
    ],
    2.54,
    2.54,
  );
}

/**
 * A DPDT switch: two SPDT poles one above the other, their levers tied by a
 * dashed link, each drawn on its A throw (the released position). Pins are
 * numbered as the footprint's pads (kicad-parts.js maps ours onto them):
 * pole 1 COM 2 · A 1 · B 3, pole 2 COM 5 · A 4 · B 6.
 */
function dpdtSymbol(name) {
  const pins = [];
  const graphics = [];
  const pole = (yc, com, a, b) => {
    pins.push(
      { number: com, name: `COM${com === "2" ? 1 : 2}`, type: "passive", x: -5.08, y: yc, side: "left" }, // prettier-ignore
      { number: a, name: "A", type: "passive", x: 5.08, y: yc + 2.54, side: "right" }, // prettier-ignore
      { number: b, name: "B", type: "passive", x: 5.08, y: yc - 2.54, side: "right" }, // prettier-ignore
    );
    graphics.push(
      ["circle", ["center", -2.032, yc], ["radius", 0.508], stroke(), fill()],
      ["circle", ["center", 2.032, yc + 2.54], ["radius", 0.508], stroke(), fill()], // prettier-ignore
      ["circle", ["center", 2.032, yc - 2.54], ["radius", 0.508], stroke(), fill()], // prettier-ignore
      poly([
        [-1.524, yc + 0.254],
        [1.778, yc + 2.032],
      ]),
    );
  };
  pole(3.81, "2", "1", "3");
  pole(-3.81, "5", "4", "6");
  graphics.push([
    "polyline",
    ["pts", ["xy", 0, 4.953], ["xy", 0, -2.667]],
    ["stroke", ["width", 0.254], ["type", "dash"]],
    fill(),
  ]);
  return twoPin(name, pins, graphics, 2.54, 6.35);
}

/**
 * The library symbol for one part's def.
 * @param {object} part - an ExportPart.
 * @param {{shape:string, pad:(key:string)=>string}} kp - its kicadPart().
 * @param {string} [widestValue] - the longest Value any instance prints, so a
 *   box is wide enough for every one of them.
 * @returns {KicadSymbol}
 */
export function symbolFor(part, kp, widestValue = part.def.id) {
  const name = symbolName(part.def);
  if (kp.shape === "resistor") return resistorSymbol(name);
  if (kp.shape === "potentiometer") return potentiometerSymbol(name);
  if (kp.shape === "led") return ledSymbol(name);
  if (kp.shape === "capacitor") return capacitorSymbol(name, false);
  if (kp.shape === "capacitor-polarized") return capacitorSymbol(name, true);
  if (kp.shape === "diode") return diodeSymbol(name, false);
  if (kp.shape === "zener") return diodeSymbol(name, true);
  if (kp.shape === "bridge") return bridgeSymbol(name);
  if (kp.shape === "inductor") return inductorSymbol(name);
  if (kp.shape === "speaker") return speakerSymbol(name);
  if (["npn", "pnp", "nmos", "pmos"].includes(kp.shape)) {
    return transistorSymbol(name, kp.shape);
  }
  if (kp.shape === "spst") return spstSymbol(name);
  if (kp.shape === "spdt") return spdtSymbol(name);
  if (kp.shape === "dpdt") return dpdtSymbol(name);
  return boxSymbol(
    name,
    boxSides(part.def, part.ports, kp.pad),
    textWidth(widestValue),
  );
}

/** A def's symbol name in the `chiphippo` library. */
export function symbolName(def) {
  return def.id.replace(/[^A-Za-z0-9_+\-.]/g, "_");
}

/**
 * The full library-symbol node, `(symbol "NAME" …)`. `prefix` is prepended to
 * the name for a schematic's embedded `lib_symbols` (`chiphippo:74LS00`); a
 * library file lists it bare.
 */
export function symbolNode(
  sym,
  { prefix = "", reference, value, footprint, description },
) {
  const field = (key, text, at) => [
    "property",
    q(key),
    q(text),
    ["at", at.x, at.y, 0],
    effects(...at.justify),
  ];
  return [
    "symbol",
    q(`${prefix}${sym.name}`),
    ...(sym.compact
      ? [
          ["pin_numbers", "hide"],
          ["pin_names", ["offset", 0], "hide"],
        ]
      : [["pin_names", ["offset", PIN_NAME_OFFSET]]]),
    ["exclude_from_sim", "no"],
    ["in_bom", "yes"],
    ["on_board", "yes"],
    field("Reference", reference, sym.fields.reference),
    field("Value", value, sym.fields.value),
    ["property", q("Footprint"), q(footprint), ["at", 0, 0, 0], EFFECTS_HIDDEN],
    ["property", q("Datasheet"), q(""), ["at", 0, 0, 0], EFFECTS_HIDDEN],
    [
      "property",
      q("Description"),
      q(description),
      ["at", 0, 0, 0],
      EFFECTS_HIDDEN,
    ],
    ["symbol", q(`${sym.name}_0_1`), ...sym.graphics],
    ["symbol", q(`${sym.name}_1_1`), ...sym.pinNodes],
  ];
}

/**
 * A power symbol: `VCC`-style (an arrow up) or `GND` (the ground bars). Its
 * one hidden `power_in` pin is named for the net, which in KiCad is what a
 * power symbol connects: every symbol of that name on the sheet is one net.
 */
/** A rail's power symbol's LIBRARY name (its net is `name`). */
export function powerSymbolName(name) {
  return `rail_${name}`;
}

export function powerSymbolNode(name, polarity, prefix = "") {
  const graphics =
    polarity === "GND"
      ? [
          poly(
            [
              [0, 0],
              [0, -1.27],
              [1.27, -1.27],
              [0, -2.54],
              [-1.27, -1.27],
              [0, -1.27],
            ],
            "none",
            0,
          ),
        ]
      : [
          poly(
            [
              [-0.762, 1.27],
              [0, 2.54],
            ],
            "none",
            0,
          ),
          poly(
            [
              [0, 2.54],
              [0.762, 1.27],
            ],
            "none",
            0,
          ),
          poly(
            [
              [0, 0],
              [0, 2.54],
            ],
            "none",
            0,
          ),
        ];
  const valueY = polarity === "GND" ? -3.81 : 3.556;
  // Named apart from the part symbols and PWR_FLAG in the one library: a
  // rail the user called `resistor` (or `PWR_FLAG`) once shared a symbol
  // name with a part. The net is its pin name and Value, never this.
  const lib = powerSymbolName(name);
  return [
    "symbol",
    q(`${prefix}${lib}`),
    ["power"],
    ["pin_names", ["offset", 0]],
    ["exclude_from_sim", "no"],
    ["in_bom", "yes"],
    ["on_board", "yes"],
    [
      "property",
      q("Reference"),
      q("#PWR"),
      ["at", 0, polarity === "GND" ? -6.35 : -3.81, 0],
      EFFECTS_HIDDEN,
    ],
    ["property", q("Value"), q(name), ["at", 0, valueY, 0], FONT],
    ["property", q("Footprint"), q(""), ["at", 0, 0, 0], EFFECTS_HIDDEN],
    ["property", q("Datasheet"), q(""), ["at", 0, 0, 0], EFFECTS_HIDDEN],
    [
      "property",
      q("Description"),
      q(`Power symbol creates a global label with name "${name}"`),
      ["at", 0, 0, 0],
      EFFECTS_HIDDEN,
    ],
    ["symbol", q(`${lib}_0_1`), ...graphics],
    [
      "symbol",
      q(`${lib}_1_1`),
      [
        "pin",
        "power_in",
        "line",
        ["at", 0, 0, polarity === "GND" ? 270 : 90],
        ["length", 0],
        "hide",
        ["name", q(name), FONT],
        ["number", q("1"), FONT],
      ],
    ],
  ];
}

/** KiCad's PWR_FLAG: tells ERC where a supply comes from. */
export function pwrFlagNode(prefix = "") {
  return [
    "symbol",
    q(`${prefix}PWR_FLAG`),
    ["power"],
    ["pin_numbers", "hide"],
    ["pin_names", ["offset", 0], "hide"],
    ["exclude_from_sim", "no"],
    ["in_bom", "yes"],
    ["on_board", "yes"],
    [
      "property",
      q("Reference"),
      q("#FLG"),
      ["at", 0, 1.905, 0],
      EFFECTS_HIDDEN,
    ],
    ["property", q("Value"), q("PWR_FLAG"), ["at", 0, 3.81, 0], FONT],
    ["property", q("Footprint"), q(""), ["at", 0, 0, 0], EFFECTS_HIDDEN],
    ["property", q("Datasheet"), q("~"), ["at", 0, 0, 0], EFFECTS_HIDDEN],
    [
      "property",
      q("Description"),
      q("Special symbol for telling ERC where power comes from"),
      ["at", 0, 0, 0],
      EFFECTS_HIDDEN,
    ],
    [
      "symbol",
      q("PWR_FLAG_0_0"),
      [
        "pin",
        "power_out",
        "line",
        ["at", 0, 0, 90],
        ["length", 0],
        ["name", q("pwr"), FONT],
        ["number", q("1"), FONT],
      ],
    ],
    [
      "symbol",
      q("PWR_FLAG_0_1"),
      poly(
        [
          [0, 0],
          [0, 1.27],
          [-1.016, 1.905],
          [0, 2.54],
          [1.016, 1.905],
          [0, 1.27],
        ],
        "none",
        0,
      ),
    ],
  ];
}
