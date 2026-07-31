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

// demo-bench.mjs — the LOGIC BENCH every chip demonstration in demos/ is laid
// out on: one full breadboard, a 5 V brick, switched inputs on the left, the
// chip in the middle, LED read-outs on the right. This is the pure builder —
// no file I/O, no validation (that's demo-build.mjs) and no per-chip knowledge
// at all (that's demo-specs.mjs).
//
// The bench exists because hand-placing a breadboard is where a demo goes
// wrong: every hole here is DERIVED from the model (model/breadboard.js +
// model/occupancy.js), never typed out, and every seated lead is claimed in
// ONE occupancy set — so a collision is a build-time throw rather than a wire
// the loader silently drops.
//
// The frame (matching the two hand-built desktops the demos began with):
//
//   y −23  ┌ psu1 / clk1 bricks
//   y −14  ├ bb1  rail-full   (+ at −13, − at −12)
//   y −11  ├ bb2  pins-full   (rows j…f at −10…−6, trench, rows e…a at −3…1)
//   y   2  └ bb3  rail-full   (+ at 3, − at 4)
//
// Columns, left to right: an optional 8-way DIP-switch bank at 2, slide
// switches after it (pitch 6, four to a half — two when the bank is there
// too), the chip at 26, and the LED read-outs clear of whatever the chip's
// package spans. A block in the UPPER half (rows f–j) reaches the top rail,
// one in the LOWER half (rows a–e) the bottom rail — the two are wired
// together at the far end, so either reaches the same net.

import { holesOfNode, nodeOf } from "../src/web/scripts/model/breadboard.js";
import {
  partPinHoles,
  worldOfAddress,
} from "../src/web/scripts/model/occupancy.js";
import { partDef } from "../src/web/scripts/catalog/index.js";
import { DOC_VERSION } from "../src/web/scripts/model/desk-doc.js";

/** The breadboard kit every bench is built on, at the file's existing origin. */
const BOARDS = Object.freeze([
  { id: "bb1", type: "rail-full", x: -37, y: -14, rot: 0, group: "g1" },
  { id: "bb2", type: "pins-full", x: -37, y: -11, rot: 0, group: "g1" },
  { id: "bb3", type: "rail-full", x: -37, y: 2, rot: 0, group: "g1" },
]);

export const PINS = "bb2";
const TOP_RAIL = "bb1";
const BOT_RAIL = "bb3";

/**
 * Where each block sits, in pin-board columns. The switch slots and the LED
 * run are FUNCTIONS of what else is on the board — a bank pushes the slide
 * switches right (and halves how many fit before the chip), and a wide package
 * pushes the read-outs right — so a demo never has to state a column itself.
 */
export const LAYOUT = Object.freeze({
  bankCol: 2, // the DIP switch bank + its resistor network: columns 2…10
  chipCol: 26,
  displayCol: 40,

  /** Slot i of a switch row: which half it seats in, and at which column. */
  switchSlot(i, banked) {
    const perHalf = banked ? 2 : 4;
    const first = banked ? 13 : 2; // clear of the bank's own columns
    return {
      half: i < perHalf ? "upper" : "lower",
      col: first + 6 * (i % perHalf),
    };
  },

  /** How many slide switches fit alongside (or without) a bank. */
  switchCapacity(banked) {
    return banked ? 4 : 8;
  },

  /** The LED run starts clear of the chip, whatever package it is in. */
  ledCol(i, halfPins = 7) {
    return LAYOUT.chipCol + halfPins + 3 + 3 * (i % 8);
  },
});

/** The demo caption above the bench: line pitch, where the last line sits
    (just clear of the power bricks at y −23), and the muted colour its body
    lines take so the block reads as a caption rather than shouting. */
const CAPTION_LINE = 1.8;
const CAPTION_BOTTOM = -24;
const CAPTION_MUTED = "#808080";

/** Wire colours, by what the wire is FOR (so a demo reads at a glance). */
const WIRE = Object.freeze({
  power: "red",
  ground: "black",
  input: "green",
  link: "blue",
  output: "purple",
  clock: "yellow",
});

/** The two halves of a pin-board: which rows a block uses, and which rail. */
const HALF = Object.freeze({
  upper: {
    switchRow: "h", // the slide switch seats here; f/g/i/j stay free for wires
    pullRow: "i", // …and its pull-down resistor anchors here
    ledRow: "g",
    cathodeResRow: "i", // an LED's series resistor, cathode side (→ −, dy −3)
    anodeResRow: "i", // …or anode side for an active-low output (→ +, dy −4)
    rail: TOP_RAIL,
    labelY: -16.4,
  },
  lower: {
    switchRow: "c",
    pullRow: "a",
    ledRow: "b",
    cathodeResRow: "a", // → −, dy +3
    anodeResRow: "c", // → +, dy +4 (row a would be too short a bend)
    rail: BOT_RAIL,
    labelY: 5.4,
  },
});

/** A part's params, coerced through its own catalog contract. */
function paramsOf(ref, raw) {
  const def = partDef(ref);
  if (!def) throw new Error(`unknown catalog ref: ${ref}`);
  return def.normalizeParams ? def.normalizeParams(raw) : {};
}

export class Bench {
  #boards = BOARDS.map((b) => ({ ...b }));
  #components = [];
  #wires = [];
  #annotations = [];
  #claimed = new Map(); // address → what took it (for the collision message)
  #compSeq = 0;
  #wireSeq = 0;
  #annSeq = 0;

  /** Claim one connection point for `owner`, or throw naming both claimants. */
  #claim(address, owner) {
    const held = this.#claimed.get(address);
    if (held) throw new Error(`${address}: ${owner} collides with ${held}`);
    this.#claimed.set(address, owner);
    return address;
  }

  /** The world position of an address (pitch units) — never hand-derived. */
  #world(address) {
    const pos = worldOfAddress(this.#boards, address);
    if (!pos) throw new Error(`no such hole: ${address}`);
    return pos;
  }

  /** Which rail a hole faces: rows f–j the top strip, rows a–e the bottom. */
  #railFor(hole) {
    return "fghij".includes(hole[0]) ? TOP_RAIL : BOT_RAIL;
  }

  /** The bent-lead offset (pitch units) from an anchor hole to a rail hole. */
  #lead(anchorAddress, railAddress) {
    const a = this.#world(anchorAddress);
    const r = this.#world(railAddress);
    return { dx: r.x - a.x, dy: r.y - a.y };
  }

  // ── Placement ──────────────────────────────────────────────────────────

  /** Seat a board part, claiming every hole its footprint lands on. */
  #part(kind, ref, anchor, raw = {}, meta = {}) {
    const id = `c${++this.#compSeq}`;
    const params = paramsOf(ref, raw);
    const comp = { id, kind, ref, board: PINS, anchor, params, ...meta };
    for (const { pin, hole } of partPinHoles(ref, anchor, params) ?? []) {
      // A bent lead carries an offset, not a hole — its owner claims that.
      if (hole != null) {
        this.#claim(`${PINS}.${hole}`, `${ref} ${id} pin ${pin}`);
      }
    }
    this.#components.push(comp);
    return comp;
  }

  /** A two-terminal part standing up from a pin-board hole onto a rail. */
  #toRail(ref, anchorHole, railId, raw, meta) {
    const anchor = `${PINS}.${anchorHole}`;
    const rail = this.#railFor(anchorHole);
    const railHole = this.railNear(rail, railId, this.#world(anchor).x);
    const comp = this.#part(
      "discrete",
      ref,
      anchorHole,
      { ...raw, rot: 90, end: this.#lead(anchor, railHole) },
      meta,
    );
    this.#claim(railHole, `${ref} ${comp.id} lead`);
    return comp;
  }

  /** Place a desk-level brick (PSU / clock) at a world position. */
  #brick(id, kind, ref, x, y, raw = {}) {
    this.#components.push({ id, kind, ref, x, y, params: paramsOf(ref, raw) });
    return id;
  }

  /** A free hole on the same internal node as `hole`, claimed for a wire. */
  free(hole, board = PINS) {
    const type = this.#boards.find((b) => b.id === board).type;
    const node = nodeOf(type, hole);
    for (const h of holesOfNode(type, node) ?? []) {
      const address = `${board}.${h}`;
      if (!this.#claimed.has(address)) return this.#claim(address, "wire");
    }
    throw new Error(`no free hole left on ${board} node ${node}`);
  }

  /**
   * The FREE hole of one rail nearest a world x. The rails' grouped lattice
   * means a column rarely sits exactly over a hole, so callers take what is
   * nearest and (for a resistor) bend the lead the remaining pitch or two.
   */
  railNear(board, railId, worldX) {
    const type = this.#boards.find((b) => b.id === board).type;
    let best = null;
    for (const hole of holesOfNode(type, railId) ?? []) {
      const address = `${board}.${hole}`;
      if (this.#claimed.has(address)) continue;
      const d = Math.abs(this.#world(address).x - worldX);
      if (!best || d < best.d) best = { address, d };
    }
    if (!best) throw new Error(`no free hole on ${board} rail ${railId}`);
    return best.address;
  }

  wire(from, to, color) {
    this.#wires.push({ id: `w${++this.#wireSeq}`, from, to, color });
  }

  /** Wire a pin-board hole's node to the nearest free hole of a rail. */
  wireToRail(hole, railId, color) {
    const from = this.free(hole);
    const rail = this.#railFor(hole);
    const to = this.#claim(
      this.railNear(rail, railId, this.#world(from).x),
      "wire",
    );
    this.wire(from, to, color);
  }

  /** Claim one SPECIFIC hole for a wire (throws if anything already has it). */
  holeFor(hole, board = PINS) {
    return this.#claim(`${board}.${hole}`, "wire");
  }

  label(text, x, y) {
    this.#annotations.push({ id: `an${++this.#annSeq}`, kind: "label", x, y, text }); // prettier-ignore
  }

  /**
   * The demo's explanation, stacked UPWARD from just above the power bricks so
   * it grows away from the bench instead of over it.
   *
   * Each line is its OWN label rather than one multi-line `note`: a note is a
   * box that wraps at whatever width the overlay layer gives it (which is
   * narrow — `.desk-surface` is a zero-size anchor), so a paragraph lands
   * nowhere near where it was authored. A label is `white-space: nowrap`, so
   * what is written is what is drawn. The heading keeps the desk's text
   * colour; the body lines are muted.
   */
  caption(text, x = -37) {
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      this.#annotations.push({
        id: `an${++this.#annSeq}`,
        kind: "label",
        x,
        y: CAPTION_BOTTOM - (lines.length - i) * CAPTION_LINE,
        text: line,
        ...(i === 0 ? {} : { color: CAPTION_MUTED }),
      });
    });
  }

  // ── Blocks ─────────────────────────────────────────────────────────────

  /** The 5 V brick, and both rail strips tied together at the far end. */
  power() {
    this.#brick("psu1", "psu", "psu", -36, -23, { volts: 5 });
    this.wire("psu1.+", this.#claim("bb1.+1", "wire"), WIRE.power);
    this.wire("psu1.-", this.#claim("bb1.-5", "wire"), WIRE.ground);
    this.wire(this.#claim("bb1.+50", "wire"), this.#claim("bb3.+50", "wire"), WIRE.power); // prettier-ignore
    this.wire(this.#claim("bb1.-50", "wire"), this.#claim("bb3.-50", "wire"), WIRE.ground); // prettier-ignore
  }

  /** The clock brick, its ground reference wired to the top rail. */
  clock(hz) {
    this.#brick("clk1", "clock", "clock", -26, -23, { hz });
    this.wire(
      "clk1.gnd",
      this.#claim(this.railNear(TOP_RAIL, "-", -24), "wire"),
      WIRE.ground,
    );
    return "clk1";
  }

  /**
   * Seat the chip under test and wire its power pins to the rails — whichever
   * rail each pin's own row faces, so a part with non-standard power pins (a
   * '76, a '83) needs no special case.
   */
  chip(ref, col = LAYOUT.chipCol) {
    const def = partDef(ref);
    const anchor = `e${col}`;
    const comp = this.#part("chip", ref, anchor);
    const holes = new Map(
      partPinHoles(ref, anchor, {}).map((p) => [p.pin, p.hole]),
    );
    const vcc = def.pins.find((p) => p.role === "vcc").n;
    const gnd = def.pins.find((p) => p.role === "gnd").n;
    this.wireToRail(holes.get(vcc), "+", WIRE.power);
    this.wireToRail(holes.get(gnd), "-", WIRE.ground);
    return {
      id: comp.id,
      holeOf: (pin) => holes.get(pin),
      // How many columns the package spans — what the LED run clears.
      halfPins: def.pins.length / 2,
    };
  }

  /**
   * One switched input: an SPDT slide switch whose common feeds the chip,
   * throwing between the + rail and a 10 kΩ pull-down. That is the bench's
   * logic-level source — and what keeps "a floating input reads HIGH" from
   * quietly standing in for a real LOW.
   *
   * @returns {{id: string, hole: string}} the switch and its common hole.
   */
  slideSwitch({ half, col, label, name, on = true }) {
    const h = HALF[half];
    const anchor = `${h.switchRow}${col}`;
    // Throw 1 is the +5 V side, throw 2 the pull-down.
    const pos = on ? "1" : "2";
    const sw = this.#part("discrete", "sw-slide", anchor, { pos }, name ? { name } : {}); // prettier-ignore
    this.wireToRail(anchor, "+", WIRE.power); // throw 1 → +5 V
    this.#toRail("resistor", `${h.pullRow}${col + 2}`, "-", { ohms: 10000 }); // throw 2 → GND
    if (label) {
      this.label(label, this.#world(`${PINS}.${anchor}`).x + 0.7, h.labelY);
    }
    return { id: sw.id, hole: `${h.switchRow}${col + 1}` };
  }

  /**
   * A signal ROUTER rather than a source: the same SPDT switch, but its common
   * carries a signal IN (a clock, say) and its two throws hand it to one of two
   * chip pins. Neither throw is tied to a rail — the pin that isn't selected is
   * left floating, which the sim reads HIGH, and HIGH is exactly the idle level
   * an edge-triggered clock input wants. That is what lets one clock brick
   * drive a '193's separate up and down clocks from a single switch.
   *
   * @returns {{id, common: string, throws: [string, string]}}
   */
  routeSwitch({ half, col, label, name, on = true }) {
    const h = HALF[half];
    const anchor = `${h.switchRow}${col}`;
    const pos = on ? "1" : "2";
    const sw = this.#part("discrete", "sw-slide", anchor, { pos }, name ? { name } : {}); // prettier-ignore
    if (label) {
      this.label(label, this.#world(`${PINS}.${anchor}`).x + 0.7, h.labelY);
    }
    return {
      id: sw.id,
      common: `${h.switchRow}${col + 1}`,
      throws: [`${h.switchRow}${col}`, `${h.switchRow}${col + 2}`],
    };
  }

  /**
   * Eight switched inputs in ONE pair of parts: an 8-position DIP switch
   * straddling the trench (each position bridges its own column across it)
   * over a bussed resistor network holding every output down. The rail side is
   * daisy-chained the way a real bench jumpers it, so the block costs n+1
   * wires rather than 2n.
   *
   * @returns {{id: string, holes: string[]}} the bank and its output holes.
   */
  switchBank({ col = LAYOUT.bankCol, labels = [], states = [] }) {
    const positions = 8; // the rnet9's eight elements seat under exactly these
    const bank = this.#part("discrete", `sw-dip${positions}`, `e${col}`, {
      states: Array.from({ length: positions }, (_, i) => states[i] === true),
    });
    this.#part("discrete", "rnet9", `b${col}`, { ohms: 10000 });

    for (let i = 0; i < positions - 1; i++) {
      // Alternating rows, so the run reads as one tidy chain rather than a
      // random walk down whatever hole happened to be free.
      const row = i % 2 === 0 ? "j" : "i";
      this.wire(
        this.holeFor(`${row}${col + i}`),
        this.holeFor(`${row}${col + i + 1}`),
        WIRE.power,
      );
    }
    this.wireToRail(`h${col}`, "+", WIRE.power);
    this.wireToRail(`d${col + positions}`, "-", WIRE.ground); // rnet9 COM
    // A bank's positions are ONE column apart, so their labels are staggered
    // over two lines — "A0 A1 A2 A3" at 10 px a column would otherwise run
    // into each other the moment a label is wider than one character.
    labels.forEach((text, i) => {
      if (!text) return;
      const x = this.#world(`${PINS}.e${col + i}`).x - 0.3;
      this.label(text, x, HALF.upper.labelY - (i % 2 === 0 ? 0 : 1.6));
    });
    return {
      id: bank.id,
      holes: Array.from({ length: positions }, (_, i) => `c${col + i}`),
    };
  }

  /**
   * One LED read-out with its series resistor. `activeLow` flips which leg the
   * chip drives: an active-HIGH output feeds the anode and the resistor takes
   * the cathode to ground; an active-LOW output SINKS the cathode while the
   * resistor holds the anode up at +5 V. Either way exactly one leg is fed
   * through a resistor, which is what tells a lit LED from a burnt one.
   *
   * @returns {{id, hole, anode, cathode}} the LED and the hole the chip drives.
   */
  led({ half, col, label, color = "red", activeLow = false }) {
    const h = HALF[half];
    const anchor = `${h.ledRow}${col}`;
    const led = this.#part("discrete", "led", anchor, { color }, label ? { name: label } : {}); // prettier-ignore
    this.#toRail(
      "resistor",
      activeLow ? `${h.anodeResRow}${col}` : `${h.cathodeResRow}${col + 1}`,
      activeLow ? "+" : "-",
      { ohms: 330 },
    );
    if (label) {
      this.label(label, this.#world(`${PINS}.${anchor}`).x - 0.3, h.labelY);
    }
    return {
      id: led.id,
      hole: `${h.ledRow}${activeLow ? col + 1 : col}`,
      anode: `${PINS}.${h.ledRow}${col}`,
      cathode: `${PINS}.${h.ledRow}${col + 1}`,
    };
  }

  /**
   * A 7-segment digit (common anode) with its common leg held up at +5 V
   * through a resistor, so an active-low driver sinking a segment lights it
   * rather than burning it.
   */
  segmentDisplay({ col = LAYOUT.displayCol, ref = "seg8ca", color = "red" }) {
    const disp = this.#part("discrete", ref, `b${col}`, { color });
    this.#toRail("resistor", `c${col + 8}`, "+", { ohms: 330 });
    return {
      id: disp.id,
      // Segment k (a…g, dp) seats in column col+k−1; pin 9 is the common anode.
      holeOf: (pin) => `b${col + pin - 1}`,
    };
  }

  // ── Wiring shorthands ──────────────────────────────────────────────────

  /** A chip pin tied to a rail (an unused input, an enable held asserted). */
  tie(hole, railId) {
    this.wireToRail(hole, railId, railId === "+" ? WIRE.power : WIRE.ground);
  }

  /** A signal wire between two pin-board holes' nodes. */
  join(fromHole, toHole, kind = "link") {
    this.wire(this.free(fromHole), this.free(toHole), WIRE[kind]);
  }

  /** The clock brick's output → a chip pin. */
  wireClock(hole) {
    this.wire("clk1.out", this.free(hole), WIRE.clock);
  }

  /** The finished desk document. */
  document() {
    return {
      version: DOC_VERSION,
      boards: this.#boards,
      components: this.#components,
      wires: this.#wires,
      buses: [],
      netNames: [],
      annotations: this.#annotations,
      scopeChannels: [],
      nextBoardId: this.#boards.length + 1,
      nextGroupId: 2,
      nextComponentId: this.#compSeq + 1,
      nextPsuId: 2,
      nextClockId: 2,
      nextWireId: this.#wireSeq + 1,
      nextBusId: 1,
      nextAnnotationId: this.#annSeq + 1,
      nextScopeChannelId: 1,
    };
  }
}
