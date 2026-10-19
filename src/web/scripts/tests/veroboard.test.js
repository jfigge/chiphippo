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

// veroboard.test.js — the veroboard (stripboard): its presets and the hole
// grid derived from a size, its copper as nodes and the cuts that split them,
// the document's cut list (normalized, saved, pasted, undone), parts seated on
// it, and both engines and the probe's partition seeing the one connectivity.

import test from "node:test";
import assert from "node:assert/strict";

import {
  VERO_KIT_KEYS,
  isBoardType,
  kitFor,
  veroSpec,
} from "../model/board-types.js";
import {
  VERO_LIMITS,
  VERO_PITCH_MM,
  VERO_PRESETS,
  parseVeroKey,
  presetKey,
  turnedVeroKey,
  veroTypeKey,
} from "../model/vero-presets.js";
import {
  boardNodeOf,
  canRotate,
  holeAt,
  holePhaseX,
  holePosition,
  holes,
  holesOfNode,
  isCuttable,
  nodeOf,
  normalizeCuts,
  parseHole,
  stripLetters,
  stripNumber,
  veroRuns,
} from "../model/breadboard.js";
import { MM_PER_UNIT } from "../desk/desk-geometry.js";
import { DeskDoc, normalizeDocument } from "../model/desk-doc.js";
import { boardRect, matingEdge, snapCorrection } from "../model/mating.js";
import { partSeatAt } from "../model/seating.js";
import { canPlacePart, partPinAddresses } from "../model/occupancy.js";
import { captureDesign } from "../model/design-clip.js";
import { buildNetlist } from "../sim/netlist.js";
import { ENGINES } from "../sim/engines.js";
import { veroCopper } from "../desk/vero-copper.js";
import { kitLabel } from "../catalog/labels.js";
import { buildPlan } from "../model/build-plan.js";

const EURO = "vero-100x160"; // 39 strips × 62 holes
const PEDAL = "vero-92x54"; // 36 strips × 21 holes

/** The net a hole is in, on a netlist of `doc`. */
const netOf = (netlist, address) => netlist.netOfPoint.get(address);

// ── Presets and the grid a size derives ─────────────────────────────────────

test("every preset is a valid size on the 2.54 mm pitch, and places as one board", () => {
  assert.ok(VERO_PRESETS.length >= 11);
  const ids = new Set();
  for (const p of VERO_PRESETS) {
    assert.ok(!ids.has(p.id), `${p.id} once`);
    ids.add(p.id);
    assert.match(p.id, /^[a-z0-9]+$/, "a key-safe id");
    assert.equal(p.pitchMm, VERO_PITCH_MM);
    for (const mm of [p.widthMm, p.heightMm]) {
      assert.ok(mm >= VERO_LIMITS.minMm && mm <= VERO_LIMITS.maxMm, p.id);
    }
    const key = presetKey(p);
    assert.deepEqual(parseVeroKey(key), {
      widthMm: p.widthMm,
      heightMm: p.heightMm,
    });
    assert.ok(isBoardType(key), key);
    const s = veroSpec(key);
    assert.equal(s.kind, "vero");
    assert.equal(s.preset, p.id);
    assert.equal(s.tiePoints, s.cols * s.rows);
    assert.equal(holes(key).length, s.tiePoints);
    // The holes sit inside the board, with the margin either side even.
    const first = holePosition(key, holes(key)[0]);
    const last = holePosition(key, holes(key).at(-1));
    assert.ok(first.x > 0 && first.y > 0, `${key} first hole inside`);
    assert.ok(last.x < s.width && last.y < s.height, `${key} last hole inside`);
    assert.ok(Math.abs(first.x - (s.width - last.x)) < 0.02, `${key} even across`); // prettier-ignore
    assert.ok(Math.abs(first.y - (s.height - last.y)) < 0.02, `${key} even down`); // prettier-ignore
    // Its kit IS the one board.
    assert.deepEqual(kitFor(key).strips, [{ type: key, dx: 0, dy: 0 }]);
    assert.equal(canRotate(key), false, "a placed veroboard never turns");
  }
  assert.deepEqual(VERO_KIT_KEYS, VERO_PRESETS.map(presetKey));
});

test("the hole count is derived from the size, unless a maker's layout says it", () => {
  // floor((W − 2·1.27) / 2.54) + 1 across, the same down.
  const derived = (mm) => Math.floor((mm - 2 * 1.27) / 2.54 + 1e-9) + 1;
  for (const p of VERO_PRESETS) {
    const s = veroSpec(presetKey(p));
    if (p.cols) continue;
    assert.equal(s.cols, derived(p.widthMm), `${p.id} strips`);
    assert.equal(s.rows, derived(p.heightMm), `${p.id} holes`);
  }
  // "24 columns × 56 pins long" — stated, not derived (65 mm holds 25).
  const s = veroSpec("vero-65x144");
  assert.deepEqual([s.cols, s.rows], [24, 56]);
  // Turned, the stated layout turns with it.
  const turned = veroSpec("vero-144x65");
  assert.deepEqual([turned.cols, turned.rows], [56, 24]);
  // A 12 × 17 in sheet: 120 strips of 170 holes.
  const sheet = veroSpec("vero-304.8x431.8");
  assert.deepEqual([sheet.cols, sheet.rows], [120, 170]);
  // A Eurocard.
  assert.deepEqual([veroSpec(EURO).cols, veroSpec(EURO).rows], [39, 62]);
});

test("a size key has one spelling, inside the limits", () => {
  assert.equal(veroTypeKey(92, 54), "vero-92x54");
  assert.equal(veroTypeKey(38.1, 214.6), "vero-38.1x214.6");
  assert.equal(parseVeroKey("vero-92.0x54"), null, "not canonical");
  assert.equal(parseVeroKey("vero-9x54"), null, "under the minimum");
  assert.equal(parseVeroKey("vero-501x54"), null, "over the maximum");
  assert.equal(parseVeroKey("pins-full"), null);
  assert.equal(isBoardType("vero-9x54"), false);
  assert.equal(turnedVeroKey("vero-92x54"), "vero-54x92");
  // A custom size is the same model as a preset.
  const custom = veroSpec("vero-50x50");
  assert.equal(custom.preset, null);
  assert.equal(custom.tiePoints, holes("vero-50x50").length);
});

test("holes are on the 2.54 mm pitch: one pitch apart both ways, and holeAt inverts them", () => {
  const s = veroSpec(EURO);
  const a = holePosition(EURO, "C14");
  assert.deepEqual(holePosition(EURO, "D14"), { x: a.x + 1, y: a.y });
  const below = holePosition(EURO, "C15");
  assert.ok(Math.abs(below.y - a.y - 1) < 1e-9);
  // 1 world unit IS 2.54 mm.
  assert.equal(MM_PER_UNIT, VERO_PITCH_MM);
  for (const hole of holes(EURO)) {
    const p = holePosition(EURO, hole);
    assert.equal(holeAt(EURO, p.x + 0.1, p.y - 0.1), hole);
  }
  assert.equal(holeAt(EURO, -5, -5), null, "off the board");
  assert.equal(parseHole(EURO, `A${s.rows + 1}`), null, "past the last hole");
  assert.equal(parseHole(EURO, "a1"), null, "a pin-board's grammar");
  assert.equal(parseHole("pins-full", "A1"), null, "and the other way");
});

test("strip letters run A…Z, AA…: one spelling per strip", () => {
  assert.equal(stripLetters(1), "A");
  assert.equal(stripLetters(26), "Z");
  assert.equal(stripLetters(27), "AA");
  assert.equal(stripLetters(120), "DP");
  for (let n = 1; n <= 702; n++) assert.equal(stripNumber(stripLetters(n)), n);
  const sheet = "vero-304.8x431.8";
  assert.equal(parseHole(sheet, "DP170")?.strip, 120);
  assert.equal(parseHole(sheet, "DQ1"), null, "strip 121 is off the sheet");
});

test("a veroboard is placed with its HOLES on the desk's whole-pitch columns", () => {
  const doc = new DeskDoc();
  const [board] = doc.addKit(PEDAL, 10.2, 5);
  const first = holePosition(PEDAL, "A1");
  const x = board.x + first.x;
  assert.ok(Math.abs(x - Math.round(x)) < 1e-9, `hole A1 at x ${x}`);
  assert.ok(holePhaseX(PEDAL) > 0, "the board's edge takes the fraction");
  assert.equal(holePhaseX("pins-full"), 0);
});

// ── Copper, cuts and nodes ──────────────────────────────────────────────────

test("every hole of an uncut strip is one node; neighbouring strips are not", () => {
  const s = veroSpec(PEDAL);
  const node = nodeOf(PEDAL, "C1");
  assert.equal(node, "SC");
  for (let i = 1; i <= s.rows; i++) assert.equal(nodeOf(PEDAL, `C${i}`), node);
  assert.notEqual(nodeOf(PEDAL, "D1"), node);
  assert.equal(holesOfNode(PEDAL, "SC").length, s.rows);
});

test("a cut at a hole isolates that pad and splits the strip either side of it", () => {
  const cuts = ["C10"];
  assert.equal(nodeOf(PEDAL, "C9", cuts), "SC/1");
  assert.equal(nodeOf(PEDAL, "C10", cuts), "SCx10");
  assert.equal(nodeOf(PEDAL, "C11", cuts), "SC/11");
  assert.deepEqual(holesOfNode(PEDAL, "SCx10", cuts), ["C10"]);
  assert.equal(holesOfNode(PEDAL, "SC/1", cuts).length, 9);
  assert.equal(holesOfNode(PEDAL, "SC/11", cuts).length, 21 - 10);
  assert.equal(holesOfNode(PEDAL, "SC", cuts), null, "no whole strip any more");
  assert.equal(nodeOf(PEDAL, "D10", cuts), "SD", "the next strip is untouched");
  // An end hole: only that pad is isolated.
  assert.equal(nodeOf(PEDAL, "E1", ["E1"]), "SEx1");
  assert.equal(nodeOf(PEDAL, "E2", ["E1"]), "SE/2");
  assert.equal(holesOfNode(PEDAL, "SE/2", ["E1"]).length, 20);
  // Two cuts side by side leave no copper between them — and no empty node.
  assert.equal(nodeOf(PEDAL, "F6", ["F5", "F6"]), "SFx6");
  assert.equal(holesOfNode(PEDAL, "SF/6", ["F5", "F6"]), null);
});

test("holesOfNode inverts nodeOf for every hole, cut or not, and the runs agree", () => {
  const cuts = normalizeCuts(PEDAL, ["A1", "B10", "B11", "C21", "D7", "D14"]);
  for (const hole of holes(PEDAL)) {
    const node = nodeOf(PEDAL, hole, cuts);
    assert.ok(holesOfNode(PEDAL, node, cuts).includes(hole), hole);
  }
  // Every run of copper is exactly one node, and every cut its own.
  const { runs, cuts: cutHoles } = veroRuns(PEDAL, cuts);
  for (const run of runs) {
    const ids = [];
    for (let i = run.first; i <= run.last; i++) {
      ids.push(`${stripLetters(run.strip)}${i}`);
    }
    const nodes = new Set(ids.map((h) => nodeOf(PEDAL, h, cuts)));
    assert.equal(nodes.size, 1);
    assert.deepEqual(holesOfNode(PEDAL, [...nodes][0], cuts), ids);
  }
  assert.equal(cutHoles.length, cuts.length);
  const covered =
    runs.reduce((n, r) => n + r.last - r.first + 1, 0) + cutHoles.length;
  assert.equal(covered, holes(PEDAL).length, "every hole is copper or a cut");
});

test("cuts are normalized: real holes only, once each, strip by strip", () => {
  assert.deepEqual(
    normalizeCuts(PEDAL, ["C3", "A9", "C3", "c3", "ZZ1", 7, "A2"]),
    ["A2", "A9", "C3"],
  );
  assert.deepEqual(normalizeCuts("pins-full", ["a1"]), [], "not a veroboard");
  assert.equal(isCuttable(PEDAL, "A1"), true);
  assert.equal(isCuttable("pins-full", "a1"), false);
  assert.equal(isCuttable("rail-full", "+1"), false);
});

// ── The document ────────────────────────────────────────────────────────────

/**
 * A powered veroboard: PSU + to A1, − to H1; a 1 kΩ resistor from A6 to D6
 * and a red LED from D8 to E8 (both across strips), E's strip to H by a
 * jumper. Strips A, D and E carry the current; H is ground.
 */
function litBoard() {
  const doc = new DeskDoc();
  const [board] = doc.addKit(PEDAL, 0, 0);
  doc.addBrick("psu", 0, 30, { volts: 5 });
  const r = doc.addComponent({
    kind: "discrete",
    ref: "resistor",
    board: board.id,
    anchor: "A6",
    params: { ohms: 1000 },
  });
  const led = doc.addComponent({
    kind: "discrete",
    ref: "led",
    board: board.id,
    anchor: "D8",
    params: { color: "red" },
  });
  const wire = (from, to) => doc.addWire({ from, to, color: "black" });
  wire("psu1.+", `${board.id}.A1`);
  wire("psu1.-", `${board.id}.H1`);
  wire(`${board.id}.E10`, `${board.id}.H10`);
  return { doc, board, r, led };
}

test("a cut is one toggle, saved in the board only when there is one", () => {
  const { doc, board } = litBoard();
  assert.deepEqual(doc.toggleCut(board.id, "A2"), { cut: true });
  assert.deepEqual(doc.toggleCut(board.id, "B5"), { cut: true });
  assert.deepEqual(doc.getBoard(board.id).cuts, ["A2", "B5"]);
  assert.deepEqual(doc.toggleCut(board.id, "A2"), { cut: false });
  assert.deepEqual(doc.toggleCut(board.id, "B5"), { cut: false });
  assert.equal("cuts" in doc.getBoard(board.id), false, "omitted when empty");
  assert.throws(() => doc.toggleCut(board.id, "a1"), { code: "INVALID_ARG" });
  assert.throws(() => doc.toggleCut("bb99", "A1"), { code: "NOT_FOUND" });
  const [strip] = doc.addKit("tiny", 0, 60);
  assert.throws(() => doc.toggleCut(strip.id, "a1"), { code: "INVALID_ARG" });
});

test("save → reopen keeps the size, the cuts, the parts and the wires — and the nets", () => {
  const { doc, board } = litBoard();
  doc.toggleCut(board.id, "D9");
  doc.toggleCut(board.id, "A2");
  const saved = JSON.parse(JSON.stringify(doc.toJSON()));
  const reopened = new DeskDoc(saved);
  assert.deepEqual(reopened.toJSON(), doc.toJSON());
  assert.deepEqual(reopened.getBoard(board.id).cuts, ["A2", "D9"]);
  const a = buildNetlist(doc.toJSON());
  const b = buildNetlist(reopened.toJSON());
  assert.deepEqual([...b.netOfPoint], [...a.netOfPoint]);
});

test("the loader keeps a veroboard's real cuts only, and none on a breadboard", () => {
  const doc = normalizeDocument({
    boards: [
      { id: "bb1", type: PEDAL, x: 0, y: 0, cuts: ["AQ1", "B2", "B2", "zz"] },
      { id: "bb2", type: "pins-full", x: 0, y: 40, cuts: ["a1"] },
      { id: "bb3", type: "vero-9x9", x: 0, y: 80 },
    ],
  });
  assert.deepEqual(doc.boards.map((b) => b.id), ["bb1", "bb2"], "a junk size is dropped"); // prettier-ignore
  assert.deepEqual(doc.boards[0].cuts, ["B2"], "AQ is off a 36-strip board");
  assert.equal("cuts" in doc.boards[1], false);
});

test("a veroboard never mates or groups, however flush", () => {
  const s = veroSpec(PEDAL);
  const a = { type: PEDAL, x: 0, y: 0 };
  assert.equal(boardRect(a).mates, false);
  // Flush side by side, and stacked: the dovetail rule would mate either.
  assert.equal(matingEdge(a, { type: PEDAL, x: s.width, y: 0 }), null);
  assert.equal(matingEdge(a, { type: PEDAL, x: 0, y: s.height }), null);
  assert.equal(
    snapCorrection([boardRect({ type: PEDAL, x: s.width + 1, y: 0 })], [boardRect(a)]).dx, // prettier-ignore
    0,
    "no magnet pulls it either",
  );
  // Placed beside one, it stays a loose board.
  const doc = new DeskDoc();
  const [first] = doc.addKit(PEDAL, 0, 0);
  const [second] = doc.addKit(PEDAL, first.x + s.width + 1, 0);
  assert.equal(doc.joinMatedGroup(second.id), null);
  assert.equal(doc.getBoard(second.id).group, null);
});

test("a copied design carries its veroboard's cuts", () => {
  const { doc, board } = litBoard();
  doc.toggleCut(board.id, "D9");
  const clip = captureDesign(doc.toJSON(), {
    boardIds: [board.id],
    componentIds: [],
  });
  assert.deepEqual(clip.boards[0].cuts, ["D9"]);
  const pasted = doc.pasteDesign(clip, { dx: 0, dy: 50 });
  assert.deepEqual(doc.getBoard(pasted.boards[0].id).cuts, ["D9"]);
});

// ── Parts on a veroboard ────────────────────────────────────────────────────

test("a DIP seats across the strips, every pin on its own strip", () => {
  const doc = new DeskDoc();
  const [board] = doc.addKit(EURO, 0, 0);
  const at = holePosition(EURO, "J20");
  const seat = partSeatAt(doc.boards, "74LS00", {
    x: board.x + at.x,
    y: board.y + at.y,
  });
  assert.ok(seat, "it seats");
  assert.equal(seat.board, board.id);
  const comp = { ref: "74LS00", board: board.id, anchor: seat.anchor };
  assert.equal(canPlacePart(doc.toJSON(), comp), true);
  const placed = doc.addComponent({ kind: "chip", ...comp, params: {} });
  const pins = partPinAddresses(doc.toJSON(), doc.getComponent(placed.id));
  assert.equal(pins.length, 14);
  // Pin 1 and pin 14 share a strip — until the strip between them is cut.
  const nodeAt = (address) =>
    boardNodeOf(doc.getBoard(board.id), address.split(".")[1]);
  const pin = (n) => pins.find((p) => p.pin === n).address;
  assert.equal(nodeAt(pin(1)), nodeAt(pin(14)));
  assert.notEqual(nodeAt(pin(1)), nodeAt(pin(2)));
  const strips1to7 = new Set([1, 2, 3, 4, 5, 6, 7].map((n) => nodeAt(pin(n))));
  assert.equal(strips1to7.size, 7, "pins 1–7 on seven strips");
  // The two rows are three holes apart (a 300-mil body).
  const p1 = holePosition(EURO, pin(1).split(".")[1]);
  const p14 = holePosition(EURO, pin(14).split(".")[1]);
  assert.ok(Math.abs(p1.y - p14.y - 3) < 1e-9);
  // A cut between the rows parts pin 1 from pin 14.
  const [strip, index] = [
    pin(1)
      .split(".")[1]
      .match(/^([A-Z]+)(\d+)$/),
  ].map((m) => [m[1], Number(m[2])])[0];
  doc.toggleCut(board.id, `${strip}${index - 1}`);
  assert.notEqual(nodeAt(pin(1)), nodeAt(pin(14)));
});

test("a 600-mil DIP stands six holes across, at its own width", () => {
  const doc = new DeskDoc();
  const [board] = doc.addKit(EURO, 0, 0);
  const at = holePosition(EURO, "K30");
  const seat = partSeatAt(doc.boards, "AT28C256", {
    x: board.x + at.x,
    y: board.y + at.y,
  });
  assert.ok(seat);
  const placed = doc.addComponent({
    kind: "chip",
    ref: "AT28C256",
    board: board.id,
    anchor: seat.anchor,
    params: {},
  });
  const pins = partPinAddresses(doc.toJSON(), doc.getComponent(placed.id));
  const y = (n) =>
    holePosition(EURO, pins.find((p) => p.pin === n).address.split(".")[1]).y;
  assert.ok(Math.abs(y(1) - y(28) - 6) < 1e-9);
});

test("a resistor lies across the strips, and a wire lands on any hole", () => {
  const { doc, board, r } = litBoard();
  const pins = partPinAddresses(doc.toJSON(), doc.getComponent(r.id));
  assert.deepEqual(
    pins.map((p) => p.address),
    [`${board.id}.A6`, `${board.id}.D6`],
  );
  // Near a hole, a resistor's ghost seats on that hole's row.
  const at = holePosition(PEDAL, "F12");
  const seat = partSeatAt(
    doc.boards,
    "resistor",
    { x: board.x + at.x + 1.5, y: board.y + at.y + 0.2 },
    null,
    { ohms: 330 },
  );
  assert.ok(seat);
  assert.match(seat.anchor, /^[A-Z]+12$/);
});

// ── One connectivity, every reader ──────────────────────────────────────────

test("a cut splits the net, a jumper rejoins it, and removing the cut restores it", () => {
  const { doc, board } = litBoard();
  const at = (hole) => `${board.id}.${hole}`;
  let nl = buildNetlist(doc.toJSON());
  assert.equal(netOf(nl, at("A1")), netOf(nl, at("A6")), "strip A is one net");
  doc.toggleCut(board.id, "A3");
  nl = buildNetlist(doc.toJSON());
  assert.notEqual(netOf(nl, at("A1")), netOf(nl, at("A6")), "cut apart");
  assert.notEqual(netOf(nl, at("A3")), netOf(nl, at("A1")), "the pad alone");
  assert.notEqual(netOf(nl, at("A3")), netOf(nl, at("A6")));
  // A jumper across the cut puts them back together.
  const jumper = doc.addWire({ from: at("A2"), to: at("A5"), color: "red" });
  nl = buildNetlist(doc.toJSON());
  assert.equal(netOf(nl, at("A1")), netOf(nl, at("A6")));
  doc.removeWire(jumper.id);
  doc.toggleCut(board.id, "A3");
  nl = buildNetlist(doc.toJSON());
  assert.equal(netOf(nl, at("A1")), netOf(nl, at("A6")), "restored");
  assert.equal(netOf(nl, at("A3")), netOf(nl, at("A6")), "the pad too");
});

test("the wiring partition (probe, schematic, guide) sees the same copper", () => {
  const { doc, board } = litBoard();
  doc.toggleCut(board.id, "D7");
  const live = buildNetlist(doc.toJSON());
  const wired = buildNetlist(doc.toJSON(), new Map(), { bridges: false });
  for (const hole of holes(PEDAL)) {
    const a = `${board.id}.${hole}`;
    for (const b of [`${board.id}.D6`, `${board.id}.D8`, `${board.id}.A1`]) {
      assert.equal(
        netOf(live, a) === netOf(live, b),
        netOf(wired, a) === netOf(wired, b),
        `${a} ~ ${b}`,
      );
    }
  }
});

/** One tick of `engine` on `doc`. */
function tickOnce(doc, engine) {
  const netlist = buildNetlist(
    doc,
    new Map(),
    engine === "spice" ? { inductors: "branch" } : {},
  );
  const result = ENGINES[engine].tick({
    document: doc,
    netlist,
    warmStart: new Map(),
    state: new Map(),
    prevPinLevels: new Map(),
    signalLevels: new Map(),
    now: 0,
    ...(engine === "spice"
      ? { spice: { config: { enabled: true }, analog: null } }
      : {}),
  });
  return { netlist, result };
}

test("both engines light the LED through the copper, and both go dark at a cut", () => {
  const { doc, board, led } = litBoard();
  const anode = `${board.id}.D8`;
  const level = ({ netlist, result }) =>
    result.netLevels.get(netlist.netOfPoint.get(anode));

  const digital = tickOnce(doc.toJSON(), "digital");
  assert.equal(level(digital), "H", "the resistor pulls the anode high");
  const spice = tickOnce(doc.toJSON(), "spice");
  assert.equal(
    spice.result.lamps.get(led.id).lit,
    true,
    "Spice Lite lights it",
  );
  assert.ok(spice.result.lamps.get(led.id).amps > 1e-3);

  // Cut strip A between the supply's wire and the resistor.
  doc.toggleCut(board.id, "A3");
  const cutDigital = tickOnce(doc.toJSON(), "digital");
  assert.notEqual(level(cutDigital), "H", "nothing drives the anode now");
  const cutSpice = tickOnce(doc.toJSON(), "spice");
  assert.equal(cutSpice.result.lamps.get(led.id).lit, false, "dark");
});

// ── What the rest of the app says about one ─────────────────────────────────

test("a veroboard is named by its size, and the build guide lists its cuts", () => {
  assert.match(kitLabel(PEDAL, kitFor(PEDAL)), /92 × 54 mm/);
  assert.match(kitLabel("vero-38.1x214.6"), /38\.1 × 214\.6 mm/);
  assert.equal(kitLabel("full", { label: "Full-size" }), "Full-size");
  const { doc, board } = litBoard();
  doc.toggleCut(board.id, "D9");
  doc.toggleCut(board.id, "A2");
  const plan = buildPlan(doc.toJSON(), buildNetlist(doc.toJSON()));
  const step = plan.steps.find((s) => s.id === `step:boards:${board.id}:cuts`);
  assert.ok(step, "a step for the cuts");
  assert.match(step.text, /A2, D9/);
  const placeAt = plan.steps.findIndex((s) => s.id === `step:boards:${board.id}`); // prettier-ignore
  assert.equal(plan.steps.indexOf(step), placeAt + 1, "straight after placing it"); // prettier-ignore
});

test("the copper's rects run hole to hole and stop short of a cut", () => {
  const cuts = ["C10"];
  const { rects, cuts: marks } = veroCopper(PEDAL, cuts);
  const onC = rects.filter((r) => r.strip === 3);
  assert.equal(onC.length, 2);
  const cut = holePosition(PEDAL, "C10");
  assert.deepEqual(marks, [{ strip: 3, index: 10, ...cut }]);
  for (const r of onC) {
    assert.ok(cut.y < r.y0 || cut.y > r.y1, "no copper over the cut hole");
    assert.ok(Math.abs(r.x0 + r.x1 - 2 * cut.x) < 1e-9, "centred on the strip");
  }
  // An uncut strip runs edge to edge.
  const s = veroSpec(PEDAL);
  const d = rects.filter((r) => r.strip === 4);
  assert.equal(d.length, 1);
  assert.ok(d[0].y0 < holePosition(PEDAL, "D1").y && d[0].y1 > holePosition(PEDAL, `D${s.rows}`).y); // prettier-ignore
});
