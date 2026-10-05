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

// part-models.js — a 3D model for every part the catalog offers. Each model
// is the desk's own drawing given height: it stands where the 2D part is
// drawn, over the holes its pins resolve to, with the outline the desk view
// draws it with — so the 3D view is the breadboard on screen, stood up, and
// never a second opinion about where anything is.
//
// What a model may borrow, and does:
//   · WHERE the pins are — model/part-geometry.js's `partPinsWorld` and
//     model/breadboard.js's `holePosition`, the same functions the desk and the
//     netlist read; a leg is drawn into the very hole the netlist joins.
//   · OUTLINES the 2D views already state — a chip's body slab (chip-view.js
//     `chipBodyBox`), a DIP switch's taller body, a TO-220's outline, an
//     inductor's size and a resistor's band layout (discrete-view.js). Those
//     are imported, so a retuned outline moves both views at once.
//   · COLOURS — the theme's tokens (scene3d/palette.js).
// What it adds is the third dimension: heights, and the shapes only a side
// view shows (a TO-92 is a D standing up; a resistor network is a SIP).
//
// Collisions are deliberately ignored in this first pass: a part is drawn
// where it sits whatever else is there, so a long jumper can pass through a
// chip, exactly as the flat desk lets a wire cross one.
//
// `modelKind(def)` names the model a catalog def gets, or null; a test holds
// every PALETTE_DEFS entry to having one, so a part added to the catalog
// without a 3D model fails rather than going missing from the view.

import { footprintOffsets, partDef } from "../catalog/index.js";
import { partNumberOf, transistorCase } from "../catalog/discretes.js";
import { holePosition } from "../model/breadboard.js";
import { packageSpec } from "../model/footprints.js";
import { partPinsWorld } from "../model/part-geometry.js";
import { formatOhms } from "../model/ohm-format.js";
import { formatFarads } from "../model/farad-format.js";
import { formatHenries } from "../model/henry-format.js";
import { chipBodyBox, chipBox } from "../components/chip-view.js";
import {
  DIP_BODY_BOTTOM,
  DIP_BODY_TOP,
  TO220,
  TYPE_LABEL,
  inductorSize,
  resistorBandLayout,
} from "../components/discrete-view.js";
import { add, cross, normalize, scale, sub } from "./mat4.js";
import { roundedRect } from "./mesh.js";
import { mix, namedColor, shade } from "./palette.js";
import {
  BRICK_HEIGHT,
  DESK_Y,
  HOLE_DEPTH,
  ON_FRONT,
  ON_TOP,
  POST_HEIGHT,
} from "./scene-builder.js";

const UP = Object.freeze([0, 1, 0]);

/** Printing sits a hair proud of the face it is printed on. */
const INK = 0.005;

/** A DIP's plastic: lifted off the board on its legs, 3.3 mm thick. */
const DIP_Y0 = 0.35;
const DIP_Y1 = 1.65;

/**
 * The model a catalog def gets — the same split the desk's views make
 * (chip-view.js for a DIP chip, discrete-view.js's buildDiscreteSvg for the
 * rest, psu-view/clock-view for the bench bricks) — or null for a def no
 * model knows.
 * @param {object|null} def
 * @returns {string|null}
 */
export function modelKind(def) {
  if (!def) return null;
  if (def.kind === "chip") return "chip";
  if (def.kind === "psu") return "psu";
  if (def.kind === "clock") return "clock";
  if (def.switchBank) return "dip-switch";
  if (def.rotatable) return "span";
  if (def.can) return "can";
  if (def.characterDisplay) return "lcd";
  if (def.transistor) return "transistor";
  switch (def.id) {
    case "seg8cc":
    case "seg8ca":
      return "digit";
    case "bar8":
      return "bar";
    case "bar8iso":
      return "bar-array";
    case "rnet9":
      return "rnet";
    case "pot":
      return "pot";
    case "sw-slide":
      return "slide";
    case "sw-push":
    case "sw-toggle":
      return "button";
    default:
      return null;
  }
}

/**
 * Add one component's model to the scene. A part that does not resolve (its
 * board gone, its anchor junk) draws nothing, as on the desk.
 * @param {import("./scene-builder.js").SceneBuilder} sb
 * @param {{boards: object[], components: object[]}} doc
 * @param {object} comp
 * @returns {boolean} whether anything was drawn
 */
export function buildPart(sb, doc, comp) {
  const def = partDef(comp.ref);
  const kind = modelKind(def);
  const build = kind && BUILDERS[kind];
  if (!build) return false;
  const params = paramsOf(def, comp);
  const drawn = build(sb, doc, comp, def, params) !== false;
  if (drawn) sb.modelled.set(comp.id, kind);
  return drawn;
}

/** The part's params as its def reads them — defaults filled in. */
function paramsOf(def, comp) {
  try {
    return def.normalizeParams?.(comp.params ?? {}) ?? comp.params ?? {};
  } catch {
    return comp.params ?? {};
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/** The world position of a seated part's ANCHOR hole as `{x, z}`, or null —
    the origin every footprint part's outline is stated from. Pin-boards never
    turn, so a seated part's local axes are the world's. */
function anchorOf(doc, comp) {
  const board = doc.boards.find((b) => b.id === comp.board);
  if (!board) return null;
  let pos = null;
  try {
    pos = holePosition(board.type, comp.anchor, board.rot ?? 0);
  } catch {
    return null;
  }
  return pos ? { x: board.x + pos.x, z: board.y + pos.y } : null;
}

/** A point in a part's own frame (origin at the anchor hole). */
const at = (o, lx, y, lz) => [o.x + lx, y, o.z + lz];

/** A slab of plastic over the local rectangle, rounded in plan. */
function slab(sb, o, x0, z0, x1, z1, y0, y1, color, r = 0.12) {
  sb.mesh.extrude(
    roundedRect(o.x + x0, o.z + z0, o.x + x1, o.z + z1, r, y0),
    [0, y1 - y0, 0],
    color,
  );
}

/** A flat rectangle printed on a face at height `y`. */
function printRect(mesh, o, x0, z0, x1, z1, y, color) {
  mesh.quad(
    at(o, x0, y, z0),
    at(o, x1, y, z0),
    at(o, x1, y, z1),
    at(o, x0, y, z1),
    color,
  );
}

/** A straight leg from inside its hole up to `top`. */
function stub(sb, x, z, top) {
  sb.lead([
    [x, -HOLE_DEPTH, z],
    [x, top, z],
  ]);
}

/** Every pin's world position (`{x, y}` — desk coordinates), or []. */
function pinsOf(doc, comp) {
  try {
    return partPinsWorld(doc.boards, comp) ?? [];
  } catch {
    return [];
  }
}

/**
 * A DIP's legs: down into each pin's hole and out under the body to its
 * nearer long edge, the shoulder a real DIP's leg has.
 * @param {number} zNear - the body edge on row e's side (local z)
 * @param {number} zFar - the body edge on row f's side
 */
function dipLegs(sb, o, pins, zNear, zFar, y0) {
  const color = sb.palette.chipLeg;
  for (const pin of pins) {
    const lz = pin.y - o.z;
    const edge = lz < -1.5 ? zFar : zNear;
    const z0 = Math.min(pin.y, o.z + edge);
    const z1 = Math.max(pin.y, o.z + edge);
    sb.mesh.box(
      [pin.x - 0.11, -HOLE_DEPTH, pin.y - 0.05],
      [pin.x + 0.11, y0 + 0.3, pin.y + 0.05],
      color,
    );
    sb.mesh.box(
      [pin.x - 0.14, y0 + 0.18, z0 - 0.05],
      [pin.x + 0.14, y0 + 0.32, z1 + 0.05],
      color,
    );
  }
}

/** An LED colour's lamp colours: lit, unlit, and the desk's burnt smoke. */
function ledColors(palette, name) {
  const c = namedColor(palette, name);
  return {
    on: mix(shade(c, 1.35), [1, 1, 1], 0.08),
    off: shade(c, 0.38),
    burnt: palette.smoke,
  };
}

/** A label's writing directions on a face looking along the horizontal unit
    `facing`, upright. */
function facingLabel(facing) {
  return { right: cross(UP, facing), up: [...UP] };
}

// ── Chips ───────────────────────────────────────────────────────────────────

/** A DIP chip: a black slab across the channel on its legs, the notch and
    pin-1 dot at pin 1's end, the part number on top. Flipped (rot 180) the
    whole package turns half a lap, notch and printing with it — the real part
    seated the other way round. */
function buildChip(sb, doc, comp, def, params) {
  const o = anchorOf(doc, comp);
  if (!o) return false;
  const p = sb.palette;
  const { halfPins } = packageSpec(def.package);
  const box = chipBodyBox(def.package);
  const x0 = box.minX;
  const x1 = box.minX + box.width;
  const z0 = box.minY;
  const z1 = box.minY + box.height;
  slab(
    sb,
    o,
    x0,
    z0,
    x1,
    z1,
    DIP_Y0,
    DIP_Y1,
    {
      top: shade(p.chipBody, 1.15),
      side: p.chipBody,
    },
    0.06,
  );
  dipLegs(sb, o, pinsOf(doc, comp), z1, z0, DIP_Y0);

  const flipped = params.rot === 180;
  const top = DIP_Y1 + INK;
  const zMid = (z0 + z1) / 2;
  // The notch: a half-moon at pin 1's end.
  const notchX = flipped ? x1 : x0;
  const dir = flipped ? -1 : 1;
  const notch = [];
  for (let i = 0; i <= 10; i++) {
    const a = -Math.PI / 2 + (i / 10) * Math.PI;
    notch.push(
      at(o, notchX + dir * Math.cos(a) * 0.36, top, zMid + Math.sin(a) * 0.36),
    );
  }
  sb.mesh.polygon(notch, p.chipNotch);
  // Pin 1's dot, in its corner.
  const dot = flipped ? [halfPins - 1 - 0.1, z0 + 0.42] : [0.1, z1 - 0.42];
  sb.mesh.disc(at(o, dot[0], top, dot[1]), UP, 0.15, p.chipNotch, 12);

  sb.label({
    text: def.id,
    center: at(o, (x0 + x1) / 2 + dir * 0.25, top + INK, zMid),
    right: flipped ? [-1, 0, 0] : ON_TOP.right,
    up: flipped ? [0, 0, 1] : ON_TOP.up,
    height: 0.62,
    maxWidth: box.width - 1.3,
    color: p.chipLabel,
    font: "mono",
  });
}

/** A DIP switch bank: a chip-shaped body, taller as the real part is, with a
    slide actuator per switch over its own column — against the ON band when
    closed (discrete-view.js's buildDipSwitchBank, given height). */
function buildDipSwitch(sb, doc, comp, def, params) {
  const o = anchorOf(doc, comp);
  if (!o) return false;
  const p = sb.palette;
  const { halfPins: n } = packageSpec(def.package);
  const box = chipBox(def.package);
  const x0 = box.minX + 0.1;
  const x1 = box.minX + box.width - 0.1;
  const Y1 = DIP_Y0 + 1.0;
  slab(
    sb,
    o,
    x0,
    DIP_BODY_TOP,
    x1,
    DIP_BODY_BOTTOM,
    DIP_Y0,
    Y1,
    p.partBody,
    0.15,
  );
  dipLegs(sb, o, pinsOf(doc, comp), DIP_BODY_BOTTOM, DIP_BODY_TOP, DIP_Y0);

  // Seated backwards, the whole face turns half a lap about its centre.
  const flipped = params.rot === 180;
  const turn = (x, z) => (flipped ? [n - 1 - x, -3 - z] : [x, z]);
  const rect = (ax, az, bx, bz, y, color) => {
    const [p0x, p0z] = turn(ax, az);
    const [p1x, p1z] = turn(bx, bz);
    printRect(
      sb.mesh,
      o,
      Math.min(p0x, p1x),
      Math.min(p0z, p1z),
      Math.max(p0x, p1x),
      Math.max(p0z, p1z),
      y,
      color,
    );
  };
  const band = 0.58;
  rect(x0, DIP_BODY_TOP, x1, DIP_BODY_TOP + band, Y1 + INK, p.partInset);
  const [lx, lz] = turn(x0 + 0.55, DIP_BODY_TOP + band / 2);
  sb.label({
    text: "ON", // printed on the part, so never translated (as on the desk)
    center: at(o, lx, Y1 + 2 * INK, lz),
    right: flipped ? [-1, 0, 0] : ON_TOP.right,
    up: flipped ? [0, 0, 1] : ON_TOP.up,
    height: 0.4,
    maxWidth: 1,
    color: p.chipLabel,
    font: "mono",
  });
  const slotZ0 = DIP_BODY_TOP + band + 0.1;
  const slotZ1 = DIP_BODY_BOTTOM - 0.1;
  const states = params.states ?? [];
  for (let i = 0; i < n; i++) {
    rect(i - 0.24, slotZ0, i + 0.24, slotZ1, Y1 + INK, p.partInset);
    const on = states[i] === true;
    const nz0 = on ? slotZ0 + 0.06 : slotZ1 - 0.06 - 0.64;
    const [ax, az] = turn(i - 0.18, nz0);
    const [bx, bz] = turn(i + 0.18, nz0 + 0.64);
    sb.mesh.box(
      at(o, Math.min(ax, bx), Y1, Math.min(az, bz)),
      at(o, Math.max(ax, bx), Y1 + 0.32, Math.max(az, bz)),
      on ? p.success : p.partCap,
    );
  }
}

// ── Displays ────────────────────────────────────────────────────────────────

/** A display's nine legs, down from under the block to its row of holes. */
function displayLegs(sb, o, offsets, bodyEdgeZ) {
  for (const dx of offsets) {
    sb.lead([
      at(o, dx, -HOLE_DEPTH, 0),
      at(o, dx, 0.18, 0),
      at(o, dx, 0.18, bodyEdgeZ - 0.3),
      at(o, dx, 0.45, bodyEdgeZ - 0.3),
    ]);
  }
}

/** The seven-segment digit (common cathode or anode — the same block): the
    desk's segment layout (discrete-view.js's buildDigitDisplay) on top of a
    black block, each segment a lamp the simulation lights. */
function buildDigit(sb, doc, comp, def, params) {
  const o = anchorOf(doc, comp);
  if (!o) return false;
  const p = sb.palette;
  const Y0 = 0.3;
  const Y1 = 1.7;
  slab(sb, o, -0.45, -7.4, 8.45, -0.6, Y0, Y1, p.chipBody, 0.4);
  displayLegs(sb, o, footprintOffsets(def, params), -0.6);
  const colors = ledColors(p, params.color);
  const y = Y1 + INK;
  // The desk's numbers (buildDigitDisplay): bar thickness, the verticals'
  // offset, the three bar heights, bar lengths.
  const t = 0.5;
  const cx = 4;
  const hw = 1.4;
  const yT = -6.5;
  const yM = -4.05;
  const yB = -1.6;
  const lh = 2.4;
  const lv = 2.1;
  const hSeg = (sx, sz) => {
    const h = t / 2;
    return [
      [sx - lh / 2, sz],
      [sx - lh / 2 + h, sz - h],
      [sx + lh / 2 - h, sz - h],
      [sx + lh / 2, sz],
      [sx + lh / 2 - h, sz + h],
      [sx - lh / 2 + h, sz + h],
    ];
  };
  const vSeg = (sx, sz) => {
    const h = t / 2;
    return [
      [sx, sz - lv / 2],
      [sx + h, sz - lv / 2 + h],
      [sx + h, sz + lv / 2 - h],
      [sx, sz + lv / 2],
      [sx - h, sz + lv / 2 - h],
      [sx - h, sz - lv / 2 + h],
    ];
  };
  const shapes = {
    a: hSeg(cx, yT),
    b: vSeg(cx + hw, (yT + yM) / 2),
    c: vSeg(cx + hw, (yM + yB) / 2),
    d: hSeg(cx, yB),
    e: vSeg(cx - hw, (yM + yB) / 2),
    f: vSeg(cx - hw, (yT + yM) / 2),
    g: hSeg(cx, yM),
  };
  for (const seg of def.segments) {
    const lamp = sb.lamp({
      kind: "segment",
      compId: comp.id,
      seg: seg.id,
      ...colors,
    });
    if (shapes[seg.id]) {
      lamp.polygon(
        shapes[seg.id].map(([x, z]) => at(o, x, y, z)),
        colors.off,
      );
    } else {
      lamp.disc(at(o, cx + hw + 0.9, y, yB), UP, 0.32, colors.off, 14);
    }
  }
}

/** The bar graph (bar8): eight bars over its block, each a lamp. */
function buildBar(sb, doc, comp, def, params) {
  const o = anchorOf(doc, comp);
  if (!o) return false;
  const p = sb.palette;
  const Y1 = 1.5;
  slab(sb, o, -0.45, -4.4, 8.45, -0.6, 0.3, Y1, p.chipBody, 0.35);
  displayLegs(sb, o, footprintOffsets(def, params), -0.6);
  const colors = ledColors(p, params.color);
  def.segments.forEach((seg, i) => {
    const lamp = sb.lamp({
      kind: "segment",
      compId: comp.id,
      seg: seg.id,
      ...colors,
    });
    printRect(lamp, o, i - 0.28, -4.0, i + 0.28, -1.0, Y1 + INK, colors.off);
  });
}

/** The isolated bar array (bar8iso): a 16-pin DIP across the channel with a
    bar over each column, the same package as bar8, wired one LED per column. */
function buildBarArray(sb, doc, comp, def, params) {
  const o = anchorOf(doc, comp);
  if (!o) return false;
  const p = sb.palette;
  const Y1 = DIP_Y0 + 1.1;
  slab(sb, o, -0.5, -3.4, 7.5, 0.4, DIP_Y0, Y1, p.chipBody, 0.3);
  for (const pin of pinsOf(doc, comp)) stub(sb, pin.x, pin.y, DIP_Y0 + 0.05);
  const colors = ledColors(p, params.color);
  def.segments.forEach((seg, c) => {
    const lamp = sb.lamp({
      kind: "segment",
      compId: comp.id,
      seg: seg.id,
      ...colors,
    });
    printRect(lamp, o, c - 0.28, -3.0, c + 0.28, 0, Y1 + INK, colors.off);
  });
}

/**
 * A character-LCD module: the green PCB raised on its header, the dark bezel,
 * and the glass, which the renderer paints from the running module's
 * framebuffer (`sb.screen`). Every outline is the def's own datasheet data
 * (catalog/parts.js `characterDisplay`), as on the desk.
 */
function buildLcd(sb, doc, comp, def, params) {
  const o = anchorOf(doc, comp);
  if (!o) return false;
  const p = sb.palette;
  const cd = def.characterDisplay;
  const PCB0 = 3.0;
  const PCB1 = 3.16;
  const BEZEL = 4.3;
  const offsets = footprintOffsets(def, params);
  // The header the module stands on, and its pins.
  slab(
    sb,
    o,
    -0.5,
    -0.5,
    offsets.at(-1) + 0.5,
    0.5,
    2.2,
    PCB0,
    p.chipBody,
    0.05,
  );
  for (const dx of offsets) stub(sb, o.x + dx, o.z, PCB0 + 0.05);
  const b = cd.body;
  slab(
    sb,
    o,
    b.minX,
    b.minY,
    b.minX + b.width,
    b.minY + b.height,
    PCB0,
    PCB1,
    p.lcdPcb,
    0.3,
  );
  const w = cd.window;
  slab(
    sb,
    o,
    w.x,
    w.y,
    w.x + w.width,
    w.y + w.height,
    PCB1,
    BEZEL,
    p.lcdBezel,
    0.15,
  );
  const s = cd.screen;
  const y = BEZEL + INK;
  const color = params.color in p.lcdScreen ? params.color : "green";
  sb.screen({
    compId: comp.id,
    corners: [
      at(o, s.x, y, s.y),
      at(o, s.x + s.width, y, s.y),
      at(o, s.x + s.width, y, s.y + s.height),
      at(o, s.x, y, s.y + s.height),
    ],
    cols: cd.cols,
    rows: cd.rows,
    screen: p.lcdScreen[color],
    dot: p.lcdDot[color],
  });
}

// ── Switches, networks, trimmers ────────────────────────────────────────────

/** The slide switch: a housing over its three holes and a knob at position
    1 or 2. */
function buildSlide(sb, doc, comp, def, params) {
  const o = anchorOf(doc, comp);
  if (!o) return false;
  const p = sb.palette;
  const Y1 = 1.35;
  for (const dx of footprintOffsets(def, params)) stub(sb, o.x + dx, o.z, 0.3);
  slab(sb, o, -0.6, -1, 2.6, 1, 0.25, Y1, p.partBody, 0.2);
  printRect(sb.mesh, o, -0.25, -0.35, 2.25, 0.35, Y1 + INK, p.partInset);
  const kx = params.pos === "2" ? 1.15 : -0.15;
  slab(sb, o, kx, -0.45, kx + 1, 0.45, Y1, Y1 + 0.6, p.partAccent, 0.15);
}

/** The push button and the latching toggle button: a square tactile body
    and its round cap — the toggle's down and green while latched on. */
function buildButton(sb, doc, comp, def, params) {
  const o = anchorOf(doc, comp);
  if (!o) return false;
  const p = sb.palette;
  const Y1 = 1.3;
  for (const dx of footprintOffsets(def, params)) stub(sb, o.x + dx, o.z, 0.3);
  slab(sb, o, -0.6, -1.3, 2.6, 1.3, 0.3, Y1, p.partBody, 0.25);
  const latched = def.id === "sw-toggle" && params.on === true;
  sb.mesh.cylinder(
    at(o, 1, Y1, 0),
    UP,
    0.72,
    latched ? 0.28 : 0.55,
    latched ? p.success : p.partCap,
    {
      segments: 20,
    },
  );
}

/** The bussed resistor network: a 9-pin SIP standing on its row of holes,
    printed with its value, the dot over pin 1 (the common bus) — which is the
    far end when it is turned end-for-end. */
function buildRnet(sb, doc, comp, def, params) {
  const o = anchorOf(doc, comp);
  if (!o) return false;
  const p = sb.palette;
  const Y0 = 0.3;
  const Y1 = 2.6;
  for (const dx of footprintOffsets(def, params))
    stub(sb, o.x + dx, o.z, Y0 + 0.05);
  slab(sb, o, -0.45, -0.45, 8.45, 0.45, Y0, Y1, p.partResistor, 0.2);
  const comX = params.rot === 180 ? 8 : 0;
  sb.mesh.disc(
    at(o, comX, Y1 - 0.35, 0.45 + INK),
    [0, 0, 1],
    0.2,
    p.chipBody,
    12,
  );
  sb.label({
    text: formatOhms(params.ohms),
    center: at(o, 4, (Y0 + Y1) / 2 - 0.1, 0.45 + INK),
    ...ON_FRONT,
    height: 0.7,
    maxWidth: 6,
    color: p.chipBody,
  });
}

/** The trimmer (a Bourns 3296): the blue block over its three pins, the
    brass screw at its right-hand end with the slot turned to the position. */
function buildPot(sb, doc, comp, def, params) {
  const o = anchorOf(doc, comp);
  if (!o) return false;
  const p = sb.palette;
  const Y1 = 2.1;
  for (const dx of footprintOffsets(def, params)) stub(sb, o.x + dx, o.z, 0.3);
  slab(sb, o, 1 - 1.85, -0.75, 1 + 1.85, 0.75, 0.25, Y1, p.trimpot, 0.2);
  const screw = at(o, 2.25, Y1, 0);
  sb.mesh.cylinder(screw, UP, 0.42, 0.14, p.screw, { segments: 18 });
  const turn = ((-135 + 2.7 * (params.position ?? 50)) * Math.PI) / 180;
  const along = [Math.sin(turn), 0, -Math.cos(turn)];
  sb.mesh.orientedBox(
    add(screw, [0, 0.15, 0]),
    along,
    UP,
    cross(along, UP),
    [0.34, 0.02, 0.05],
    p.screwSlot,
  );
  sb.label({
    text: Number.isFinite(params.ohms) ? formatOhms(params.ohms) : "",
    center: at(o, 0.55, Y1 + INK, 0),
    height: 0.5,
    maxWidth: 2.2,
    color: p.trimpotText,
  });
}

// ── Transistors ─────────────────────────────────────────────────────────────

/** Its face's printing: the part number, or the type until it has one. */
const transistorText = (def, params) =>
  partNumberOf(params) ?? TYPE_LABEL[def.transistor.type] ?? "";

/** A transistor, in whichever package it is: a TO-92's D standing on its
    three legs, or a TO-220's moulding and metal tab. Either carries a lamp
    the simulation lights while it conducts. */
function buildTransistor(sb, doc, comp, def, params) {
  const o = anchorOf(doc, comp);
  if (!o) return false;
  const p = sb.palette;
  const lampColors = { on: p.partOn, off: p.partInset };
  if (transistorCase(def, params) === "TO-220") {
    const { left, width, back, tab, front } = TO220;
    const mould = back + tab;
    const Y0 = 0.9;
    const Y1 = 4.4;
    for (const dx of [0, 1, 2]) stub(sb, o.x + dx, o.z, Y0 + 0.05);
    sb.mesh.box(
      at(o, left, Y0, mould),
      at(o, left + width, Y1, front),
      p.transistor,
    );
    sb.mesh.box(
      at(o, left, Y0, back),
      at(o, left + width, Y1 + 1.8, mould),
      p.transistorTab,
    );
    for (const z of [mould + INK, back - INK]) {
      sb.mesh.disc(at(o, 1, Y1 + 1.0, z), [0, 0, 1], 0.5, p.partInset, 16);
    }
    sb.label({
      text: transistorText(def, params),
      center: at(o, 1, (Y0 + Y1) / 2, front + INK),
      ...ON_FRONT,
      height: 0.6,
      maxWidth: width - 0.4,
      color: p.transistorText,
    });
    sb.lamp({ kind: "channel", compId: comp.id, ...lampColors }).disc(
      at(o, 1, Y1 + INK, (mould + front) / 2),
      UP,
      0.18,
      lampColors.off,
      12,
    );
    return;
  }
  // TO-92: the moulding is the D of a disc — round at the back, its flat face
  // toward the viewer — standing on the legs (discrete-view.js's buildTo92).
  const cx = 1;
  const cz = -0.02;
  const r = 0.72;
  const flat = 0.4;
  const Y0 = 1.0;
  const Y1 = 2.8;
  const s = (flat - cz) / r;
  const from = Math.PI - Math.asin(s);
  const to = Math.asin(s) + 2 * Math.PI;
  const outline = [];
  for (let i = 0; i <= 20; i++) {
    const a = from + ((to - from) * i) / 20;
    outline.push(at(o, cx + Math.cos(a) * r, Y0, cz + Math.sin(a) * r));
  }
  sb.mesh.extrude(outline, [0, Y1 - Y0, 0], p.transistor, { smooth: true });
  for (const dx of [0, 1, 2]) {
    const lean = (dx - 1) * 0.6;
    sb.lead([
      at(o, dx, -HOLE_DEPTH, 0),
      at(o, dx, 0.45, 0),
      at(o, 1 + lean * 0.6, Y0 + 0.05, 0),
    ]);
  }
  sb.label({
    text: transistorText(def, params),
    center: at(o, cx, (Y0 + Y1) / 2 + 0.2, flat + INK),
    ...ON_FRONT,
    height: 0.34,
    maxWidth: 1.05,
    color: p.transistorText,
  });
  sb.lamp({ kind: "channel", compId: comp.id, ...lampColors }).disc(
    at(o, cx, Y1 + INK, cz - 0.3),
    UP,
    0.14,
    lampColors.off,
    12,
  );
}

// ── Oscillator cans ─────────────────────────────────────────────────────────

/** A crystal oscillator: a metal can over its four corner pins, its pin-1
    dot in the corner nearest pin 1 — wherever a quarter-turn has put it. */
function buildCan(sb, doc, comp, def, params) {
  const pins = pinsOf(doc, comp);
  if (pins.length === 0) return false;
  const p = sb.palette;
  const xs = pins.map((q) => q.x);
  const zs = pins.map((q) => q.y);
  const x0 = Math.min(...xs) - 0.5;
  const x1 = Math.max(...xs) + 0.5;
  const z0 = Math.min(...zs) - 0.5;
  const z1 = Math.max(...zs) + 0.5;
  const Y1 = 1.9;
  for (const pin of pins) stub(sb, pin.x, pin.y, 0.35);
  sb.mesh.extrude(
    roundedRect(x0, z0, x1, z1, 0.3, 0.3),
    [0, Y1 - 0.3, 0],
    p.chipLeg,
  );
  sb.mesh.polygon(
    roundedRect(x0 + 0.22, z0 + 0.22, x1 - 0.22, z1 - 0.22, 0.16, Y1 + INK),
    shade(p.chipLeg, 0.88),
  );
  const centre = [(x0 + x1) / 2, Y1, (z0 + z1) / 2];
  const pin1 = [pins[0].x, Y1, pins[0].y];
  const toward = normalize(sub(centre, pin1), [1, 0, 0]);
  sb.mesh.disc(
    add(add(pin1, scale(toward, 0.45)), [0, 2 * INK, 0]),
    UP,
    0.12,
    p.partInset,
    10,
  );
  sb.label({
    text: `${params.hz} Hz`, // the desk's badge, printed as on the can
    center: [centre[0], Y1 + 2 * INK, centre[2]],
    height: 0.6,
    maxWidth: x1 - x0 - 0.8,
    color: p.partInset,
  });
}

// ── Two-lead parts (resistors, LEDs, capacitors, diodes, inductors) ─────────

/**
 * A two-lead part, from where its two leads actually land (`partPinsWorld`):
 * lying along its leads or standing between them, at any angle — the
 * footprint form and the bent free-ends form are one model, because both are
 * just two holes.
 */
function buildSpan(sb, doc, comp, def, params) {
  const pins = pinsOf(doc, comp);
  if (pins.length < 2) return false;
  const a = [pins[0].x, 0, pins[0].y];
  const b = [pins[1].x, 0, pins[1].y];
  const u = normalize(sub(b, a), [1, 0, 0]);
  u[1] = 0;
  const n = [-u[2], 0, u[0]];
  const m = scale(add(a, b), 0.5);
  const ctx = { sb, a, b, u, n, m, comp, def, params, p: sb.palette };
  if (def.polarity) return buildLed(ctx);
  if (def.capacitor) {
    return def.capacitor.polarized ? buildElectrolytic(ctx) : buildCeramic(ctx);
  }
  if (def.diode) return buildDiode(ctx);
  if (def.inductor) return buildInductor(ctx);
  return buildResistor(ctx);
}

/** Point `along` the leads from the middle, at height `y`. */
const onAxis = ({ m, u }, along, y) => [
  m[0] + u[0] * along,
  y,
  m[2] + u[2] * along,
];

/** Both leads of a part lying along its leads at height `y`, from each hole
    up and in to the body's ends `reach` either side of the middle. */
function axialLeads(ctx, y, reach) {
  const { sb, a, b } = ctx;
  sb.lead([[a[0], -HOLE_DEPTH, a[2]], [a[0], y, a[2]], onAxis(ctx, -reach, y)]);
  sb.lead([[b[0], -HOLE_DEPTH, b[2]], [b[0], y, b[2]], onAxis(ctx, reach, y)]);
}

/** Both leads of a part standing between its holes, from each hole up and in
    to its base, `reach` either side of the middle at height `y`. */
function standingLeads(ctx, knee, y, reach) {
  const { sb, a, b } = ctx;
  sb.lead([
    [a[0], -HOLE_DEPTH, a[2]],
    [a[0], knee, a[2]],
    onAxis(ctx, -reach, y),
  ]);
  sb.lead([
    [b[0], -HOLE_DEPTH, b[2]],
    [b[0], knee, b[2]],
    onAxis(ctx, reach, y),
  ]);
}

/** The axial resistor: a beige body with bulged ends lying over its leads,
    banded with its value's colour code (discrete-view.js's layout). */
function buildResistor(ctx) {
  const { sb, u, p, params } = ctx;
  const H = 0.75;
  axialLeads(ctx, H, 0.9);
  sb.mesh.cylinder(onAxis(ctx, -1, H), u, 0.33, 2, p.partResistor);
  sb.mesh.cylinder(onAxis(ctx, -1, H), u, 0.42, 0.48, p.partResistor);
  sb.mesh.cylinder(onAxis(ctx, 0.52, H), u, 0.42, 0.48, p.partResistor);
  for (const { color, at: x } of resistorBandLayout(params.ohms)) {
    const r = Math.abs(x) >= 0.5 ? 0.435 : 0.345;
    sb.mesh.cylinder(
      onAxis(ctx, x - 0.065, H),
      u,
      r,
      0.13,
      p.band[color] ?? p.chipBody,
      {
        segments: 16,
      },
    );
  }
}

/** A diode or Zener: a small glass/epoxy body with its band at the cathode,
    pin 2's end. */
function buildDiode(ctx) {
  const { sb, u, p, def } = ctx;
  const H = 0.5;
  const zener = def.diode?.zener === true;
  axialLeads(ctx, H, 0.7);
  sb.mesh.cylinder(
    onAxis(ctx, -0.75, H),
    u,
    0.3,
    1.5,
    zener ? p.zener : p.diode,
  );
  sb.mesh.cylinder(
    onAxis(ctx, 0.38, H),
    u,
    0.315,
    0.22,
    zener ? p.zenerBand : p.diodeBand,
    {
      segments: 16,
    },
  );
}

/** An inductor in either of its looks: a copper-wound toroid standing on edge
    over its leads, or a drum in a black can (its `style`), sized by the holes
    between its leads (discrete-view.js's inductorSize). */
function buildInductor(ctx) {
  const { sb, n, m, p, params } = ctx;
  const size = inductorSize(params);
  if (params.style === "can") {
    const r = size.drum;
    standingLeads(ctx, 0.15, 0.25, r * 0.6);
    const H = 2.2;
    sb.mesh.cylinder([m[0], 0.25, m[2]], UP, r, H, p.inductorDrum, {
      segments: 24,
    });
    if (Number.isFinite(params.henries)) {
      sb.label({
        text: formatHenries(params.henries),
        center: [m[0], 0.25 + H + INK, m[2]],
        height: Math.min(0.55, r * 0.6),
        maxWidth: r * 1.6,
        color: p.inductorText,
      });
    }
    return;
  }
  const minor = size.width / 2;
  const major = size.length / 2 - minor;
  const centre = [m[0], 0.2 + major + minor, m[2]];
  standingLeads(ctx, 0.15, 0.35, major * 0.7);
  sb.mesh.torus(centre, n, major, minor, p.inductorCopper, {
    segments: 36,
    sides: 12,
  });
  // The ferrite showing through the middle of the winding.
  sb.mesh.cylinder(
    add(centre, scale(n, -minor * 0.6)),
    n,
    major - minor * 0.9,
    minor * 1.2,
    p.inductorCore,
    {
      segments: 24,
    },
  );
}

/** An LED standing on its two legs: flange, body and lens — all one lamp,
    lit in its colour while the simulation drives it, smoke once it burns. */
function buildLed(ctx) {
  const { sb, comp, params, m, p } = ctx;
  standingLeads(ctx, 0.5, 1.25, 0.25);
  const colors = ledColors(p, params.color);
  const lamp = sb.lamp({ kind: "led", compId: comp.id, ...colors });
  lamp.cylinder([m[0], 1.25, m[2]], UP, 0.8, 0.16, colors.off, {
    segments: 20,
  });
  lamp.cylinder([m[0], 1.41, m[2]], UP, 0.7, 1.6, colors.off, {
    segments: 20,
    caps: false,
  });
  lamp.dome([m[0], 3.01, m[2]], UP, 0.7, colors.off, {
    segments: 20,
    rings: 6,
  });
}

/** A ceramic disc standing on its legs, its value printed on the face that
    looks toward the viewer. */
function buildCeramic(ctx) {
  const { sb, n, m, p, params } = ctx;
  const r = 0.78;
  const centre = [m[0], 0.55 + r, m[2]];
  standingLeads(ctx, 0.35, centre[1] - 0.55, 0.3);
  sb.mesh.cylinder(add(centre, scale(n, -0.14)), n, r, 0.28, p.ceramic, {
    segments: 22,
  });
  const facing = n[2] >= 0 ? n : scale(n, -1);
  if (Number.isFinite(params.farads)) {
    sb.label({
      text: formatFarads(params.farads),
      center: add(centre, scale(facing, 0.14 + INK)),
      ...facingLabel(facing),
      height: 0.34,
      maxWidth: 1.2,
      color: p.ceramicText,
    });
  }
}

/** A radial electrolytic: a can on short legs with the printed stripe down
    the side of its NEGATIVE lead (pin 2) and its value on top. */
function buildElectrolytic(ctx) {
  const { sb, u, n, m, p, params } = ctx;
  const r = 0.88;
  const Y0 = 0.3;
  const H = 2.3;
  standingLeads(ctx, 0.1, Y0, 0.35);
  sb.mesh.cylinder([m[0], Y0, m[2]], UP, r, H, p.capCan, {
    segments: 24,
    capColor: p.chipLeg,
  });
  sb.mesh.orientedBox(
    add([m[0], Y0 + H / 2, m[2]], scale(u, r - 0.02)),
    n,
    UP,
    u,
    [0.26, H / 2 - 0.05, 0.04],
    p.capStripe,
  );
  if (Number.isFinite(params.farads)) {
    sb.label({
      text: formatFarads(params.farads),
      center: [m[0], Y0 + H + INK, m[2]],
      height: 0.42,
      maxWidth: 1.5,
      color: p.chipBody,
    });
  }
}

// ── The bench bricks ───────────────────────────────────────────────────────

/** A brick's binding post, the colour of its terminal. */
function bindingPost(sb, x, z, color) {
  const top = DESK_Y + BRICK_HEIGHT;
  sb.mesh.cylinder([x, top, z], UP, 0.55, 0.3, sb.palette.partInset, {
    segments: 16,
  });
  sb.mesh.cylinder([x, top + 0.3, z], UP, 0.36, POST_HEIGHT - 0.3, color, {
    segments: 16,
  });
}

/** The bench power supply: a box on the desk beside the boards, its voltage
    on top and a red and a black binding post. */
function buildPsu(sb, doc, comp, def, params) {
  return buildBrick(sb, comp, def, `${params.volts} V`, (t) =>
    t.id === "+" ? sb.palette.wire.red : sb.palette.wire.black,
  );
}

/** The clock source: the same box with its rate on top, an orange `out` and a
    black `gnd`, and the lamp that blinks with its output. */
function buildClock(sb, doc, comp, def, params) {
  const drawn = buildBrick(
    sb,
    comp,
    def,
    params.hz === "manual" ? "MAN" : `${params.hz} Hz`, // the desk's badge
    (t) => (t.id === "out" ? sb.palette.wire.orange : sb.palette.wire.black),
  );
  if (!drawn) return false;
  const p = sb.palette;
  sb.lamp({
    kind: "clock",
    compId: comp.id,
    on: p.simHigh,
    off: p.partInset,
  }).dome(
    [comp.x + 1.4, DESK_Y + BRICK_HEIGHT, comp.y + 1.4],
    UP,
    0.42,
    p.partInset,
    { segments: 16, rings: 5 },
  );
  return true;
}

function buildBrick(sb, comp, def, text, postColor) {
  if (!Number.isFinite(comp.x) || !Number.isFinite(comp.y)) return false;
  const p = sb.palette;
  const { width, height } = def.size;
  const top = DESK_Y + BRICK_HEIGHT;
  sb.mesh.extrude(
    roundedRect(comp.x, comp.y, comp.x + width, comp.y + height, 0.5, DESK_Y),
    [0, BRICK_HEIGHT, 0],
    { top: shade(p.psuBody, 1.12), side: p.psuBody },
  );
  for (const t of def.terminals) {
    bindingPost(sb, comp.x + t.dx, comp.y + t.dy, postColor(t));
  }
  sb.label({
    text,
    center: [comp.x + width / 2, top + INK, comp.y + 1.6],
    height: 1.2,
    maxWidth: width - 3.4,
    color: p.psuBadge,
  });
  return true;
}

const BUILDERS = Object.freeze({
  chip: buildChip,
  "dip-switch": buildDipSwitch,
  digit: buildDigit,
  bar: buildBar,
  "bar-array": buildBarArray,
  lcd: buildLcd,
  slide: buildSlide,
  button: buildButton,
  rnet: buildRnet,
  pot: buildPot,
  transistor: buildTransistor,
  can: buildCan,
  span: buildSpan,
  psu: buildPsu,
  clock: buildClock,
});

/** Every model kind there is — a test holds BUILDERS and modelKind to it. */
export const MODEL_KINDS = Object.freeze(Object.keys(BUILDERS));
