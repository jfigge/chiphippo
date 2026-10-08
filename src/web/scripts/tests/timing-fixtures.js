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

// timing-fixtures.js — circuits for the timer, capacitor and trace tests,
// built in code on ONE full pin-board: parts seated in their own columns,
// every connection a wire between two nodes' free holes, power straight off
// a PSU's terminals. And a runner that ticks the engine the way SimController
// does — warm start, state and sampled pins carried tick to tick — at a
// simulated time the test chooses.

import { partPinHoles } from "../model/occupancy.js";
import { holesOfNode, nodeOf } from "../model/breadboard.js";
import { buildNetlist } from "../sim/netlist.js";
import { ENGINES } from "../sim/engines.js";
import { partDef } from "../catalog/index.js";

const BOARD = "bb1";
const TYPE = "pins-full";

/**
 * A bench builder. Every method returns the builder's own helpers; `doc` is
 * the document so far.
 * @param {{volts?: number}} [opts]
 */
export function bench({ volts = 5 } = {}) {
  let seq = 0;
  const used = new Set(); // holes a pin or a wire end already holds
  const doc = {
    version: 1,
    boards: [{ id: BOARD, type: TYPE, x: 0, y: 0 }],
    components: [
      { id: "psu1", kind: "psu", ref: "psu", x: 0, y: 30, params: { volts } },
    ],
    wires: [],
    signals: [],
  };
  /** A free hole in `hole`'s node (its column-half), taken. */
  const free = (hole) => {
    const pick = holesOfNode(TYPE, nodeOf(TYPE, hole)).find(
      (h) => !used.has(h),
    );
    if (!pick) throw new Error(`no free hole beside ${hole}`);
    used.add(pick);
    return `${BOARD}.${pick}`;
  };
  const wire = (from, to) =>
    doc.wires.push({ id: `w${++seq}`, from, to, color: "black" });
  /** Seat a part; returns pin → hole. */
  const seat = (id, ref, anchor, params = {}) => {
    const def = partDef(ref);
    doc.components.push({
      id,
      kind: def.kind,
      ref,
      board: BOARD,
      anchor,
      params: def.normalizeParams(params),
    });
    const holes = new Map(
      partPinHoles(ref, anchor, params).map(({ pin, hole }) => [pin, hole]),
    );
    for (const h of holes.values()) used.add(h);
    return holes;
  };
  return {
    doc,
    seat,
    /** Join two holes' nodes with a wire. */
    link: (a, b) => wire(free(a), free(b)),
    /** Tie a hole's node to the supply's + or −. */
    vcc: (hole) => wire("psu1.+", free(hole)),
    gnd: (hole) => wire("psu1.-", free(hole)),
    /** Plant a signal flag (a momentary, resting `rest`) in a hole's node. */
    signal: (id, hole, rest = "low") => {
      doc.signals.push({
        id,
        color: "red",
        type: "momentary",
        rest,
        flag: { anchor: free(hole), rot: 0 },
      });
    },
    /** The board address of a hole. */
    at: (hole) => `${BOARD}.${hole}`,
  };
}

/**
 * Tick a document the way SimController does, at chosen simulated times.
 * `run(now, signals)` advances to `now` (seconds) with the given signal levels
 * and returns `{ result, level(hole) }`. `rebuild()` re-derives the netlist
 * after a test changes a switch's params — as SimController does on every
 * part-state change — and the run's state carries across it. `engine` picks
 * sim/engines.js's "digital" (the default) or "spice", whose analog state is
 * carried the same way, under the Spice Lite setting `spice`.
 * @param {object} doc
 * @param {{engine?: string, spice?: object}} [opts]
 */
export function runner(doc, { engine = "digital", spice = null } = {}) {
  const { tick } = ENGINES[engine];
  let netlist = buildNetlist(doc);
  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  let analog = null;
  let last = null;
  const level = (hole) =>
    last.netLevels.get(netlist.netOfPoint.get(`${BOARD}.${hole}`));
  return {
    get netlist() {
      return netlist;
    },
    rebuild() {
      netlist = buildNetlist(doc);
    },
    run(now, signalLevels = new Map()) {
      last = tick({
        document: doc,
        netlist,
        warmStart: warm,
        state,
        prevPinLevels: prev,
        signalLevels,
        now,
        ...(engine === "spice"
          ? { spice: { config: { enabled: true, ...spice }, analog } }
          : {}),
      });
      warm = last.netLevels;
      state = last.state;
      prev = last.pinLevels;
      analog = last.analog ?? null;
      return { result: last, level };
    },
    level,
    get result() {
      return last;
    },
  };
}

/**
 * The 555's astable circuit (SLFS022K Figure 6-5) at e10: RA from DISCH to
 * VCC, RB from DISCH to TRIG+THRES, C from there to GND, RESET tied HIGH — and,
 * with `cv`, the usual bypass capacitor from CONT to GND.
 * @returns {{doc: object, b: ReturnType<typeof bench>, u: Map<number, string>}}
 */
export function astable555({
  ra,
  rb,
  c,
  capRef = "cap-electrolytic",
  cv = null,
  reset = true,
}) {
  const b = bench();
  const u = b.seat("u1", "NE555", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(1));
  if (reset) b.vcc(u.get(4)); // else RESET is the caller's to wire
  b.link(u.get(2), u.get(6));
  const cap = b.seat("c1", capRef, "a30", { farads: c });
  b.link(cap.get(1), u.get(6));
  b.gnd(cap.get(2));
  const rB = b.seat("r2", "resistor", "a40", { ohms: rb });
  b.link(rB.get(1), u.get(7));
  b.link(rB.get(2), u.get(6));
  const rA = b.seat("r1", "resistor", "a50", { ohms: ra });
  b.link(rA.get(1), u.get(7));
  b.vcc(rA.get(2));
  if (cv) {
    const bypass = b.seat("c2", "cap-ceramic", "a20", { farads: cv });
    b.link(bypass.get(1), u.get(5));
    b.gnd(bypass.get(2));
  }
  return { doc: b.doc, b, u };
}
