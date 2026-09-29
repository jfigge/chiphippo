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
    // A connector's two pins, a row apart, so the rail symbols hanging off
    // them have room.
    const [a, b] = ports;
    sides.right.push(pin(a), null, pin(b));
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
 * box is made wide enough for it between the two columns of pin names, and
 * the Reference sits above its top-left corner, clear of a centred VCC pin.
 */
function boxSymbol(name, sides, valueWidth) {
  const rows = Math.max(sides.left.length, sides.right.length, 1);
  const h = (rows + 1) * PITCH;
  const width = (list) =>
    Math.max(0, ...list.filter(Boolean).map((p) => textWidth(p.name)));
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
    return pinNode(p, p.x, p.y, p.side === "left" ? 0 : 180);
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
  if (kp.shape === "led") return ledSymbol(name);
  if (kp.shape === "spst") return spstSymbol(name);
  if (kp.shape === "spdt") return spdtSymbol(name);
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
      : [["pin_names", ["offset", 1.016]]]),
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
  return [
    "symbol",
    q(`${prefix}${name}`),
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
    ["symbol", q(`${name}_0_1`), ...graphics],
    [
      "symbol",
      q(`${name}_1_1`),
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
