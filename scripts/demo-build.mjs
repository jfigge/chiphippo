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

// demo-build.mjs — turn a demo spec into a laid-out desk document, and PROVE
// it works. Split out from the make-gate-demos.mjs CLI so the shipped file's
// guard test (web/scripts/tests/gate-demos.test.js) exercises the very same
// build and the very same checks, rather than a second implementation of them.
//
// What counts as proved depends on the demo: a combinational one has every
// switch combination settled and every LED read; a display demo every digit;
// a clocked one every rising edge of a run. All three additionally insist the
// engine reports NO warnings — a short or an oscillation in a demonstration is
// a wiring mistake, not a lesson.

import { Bench, LAYOUT } from "./demo-bench.mjs";
import { normalizeDocument } from "../src/web/scripts/model/desk-doc.js";
import {
  canPlacePart,
  partPinAddresses,
} from "../src/web/scripts/model/occupancy.js";
import { partDef } from "../src/web/scripts/catalog/index.js";
import { buildNetlist } from "../src/web/scripts/sim/netlist.js";
import { settle, tick } from "../src/web/scripts/sim/engine.js";
import { H, L } from "../src/web/scripts/sim/levels.js";

/** How many rising clock edges a sequential demo is run for. */
const SEQUENTIAL_EDGES = 20;

/**
 * The desktops of demos/GateTests.chiphippo that were built BY HAND (id → the
 * name they are kept under). They are never regenerated — the writer preserves
 * them and the guard test only checks that they still load.
 */
export const HAND_BUILT = new Map([
  ["t1", "74LS00"],
  ["t3", "74LS02"], // named "Desktop 3" before this script had a naming scheme
]);

/** Generated desktops start here, so a hand-built one is never overwritten. */
export const FIRST_GENERATED_TAB = 10;

// ── Build ────────────────────────────────────────────────────────────────

/**
 * One demonstration desktop: the bench laid out from a spec, plus the handles
 * the validator needs (which component is which switch, which LED is which).
 */
export function buildDemo(spec) {
  const b = new Bench();
  b.power();
  if (spec.clock) b.clock(spec.clock.hz);
  const chip = b.chip(spec.ref);

  // How the demo comes up: `defaults` is the position of each switch as
  // SAVED, chosen to show the part doing something the moment it is opened.
  // Validation drives every combination through, so the defaults have to be
  // put back afterwards (validateDemo) or the file would keep whatever the
  // last case set.
  const defaults = (n) => Array.from({ length: n }, (_, i) => spec.defaults?.[i] ?? true); // prettier-ignore

  // Switched inputs, left to right — four to a half, upper half first.
  const switches = (spec.inputs ?? []).map((input, i) => {
    const sw = b.slideSwitch({
      half: i < 4 ? "upper" : "lower",
      col: LAYOUT.switchCol(i % 4),
      label: input.label,
      name: `Input ${input.label}`,
      on: spec.defaults?.[i] ?? true,
    });
    for (const pin of input.pins) b.join(sw.hole, chip.holeOf(pin), "input");
    return { ...sw, label: input.label };
  });

  // …or one DIP-switch bank, for a chip with more inputs than that.
  let bank = null;
  if (spec.bank) {
    bank = b.switchBank({
      labels: spec.bank.labels,
      states: defaults(spec.bank.pins.length),
    });
    bank.holes.forEach((hole, i) => {
      const pin = spec.bank.pins[i];
      if (pin) b.join(hole, chip.holeOf(pin), "input");
    });
  }

  for (const { pins, rail } of spec.ties ?? []) {
    for (const pin of pins) b.tie(chip.holeOf(pin), rail);
  }
  for (const [from, to] of spec.links ?? []) {
    b.join(chip.holeOf(from), chip.holeOf(to), "link");
  }
  // The clock brick has ONE `out` terminal, so a second clocked pin is
  // daisy-chained off the first, exactly as it would be on the bench.
  if (spec.clock) {
    spec.clock.pins.forEach((pin, i) => {
      if (i === 0) b.wireClock(chip.holeOf(pin));
      else b.join(chip.holeOf(spec.clock.pins[i - 1]), chip.holeOf(pin), "clock"); // prettier-ignore
    });
  }

  const leds = (spec.leds ?? []).map((led, i) => {
    const placed = b.led({
      half: i < 8 ? "upper" : "lower",
      col: LAYOUT.ledCol(i % 8),
      label: led.label,
      color: led.color,
      activeLow: led.activeLow,
    });
    b.join(chip.holeOf(led.pin), placed.hole, "output");
    return { ...placed, label: led.label };
  });

  let display = null;
  if (spec.display) {
    display = b.segmentDisplay({});
    spec.display.segPins.forEach((pin, i) => {
      b.join(chip.holeOf(pin), display.holeOf(i + 1), "output");
    });
  }

  b.caption(spec.note);

  // Validate what the APP will load, not what the builder happened to emit.
  const doc = normalizeDocument(b.document());
  assertClean(b.document(), doc, spec.ref);
  assertPlaceable(doc, spec.ref);
  return {
    spec,
    doc,
    chipId: chip.id,
    switches,
    bank,
    leds,
    display,
    defaults: defaults(bank ? bank.holes.length : switches.length),
  };
}

/** The loader must keep every entity — a dropped one is a silent dead wire. */
function assertClean(before, after, label) {
  for (const key of ["boards", "components", "wires", "annotations"]) {
    if (before[key].length !== after[key].length) {
      throw new Error(
        `${label}: the loader dropped ${before[key].length - after[key].length} of ${before[key].length} ${key}`,
      );
    }
  }
}

/**
 * Every seated part must pass the SAME legality check the desk applies to a
 * hand-placed one (occupancy.js) — no lead in mid-air, no hole shared with a
 * wire end, no resistor bent shorter than its own body. A generated demo the
 * user could not have built by hand is a bug in the bench, not a shortcut.
 */
function assertPlaceable(doc, label) {
  for (const comp of doc.components) {
    if (comp.kind !== "chip" && comp.kind !== "discrete") continue;
    const ok = canPlacePart(doc, {
      ref: comp.ref,
      board: comp.board,
      anchor: comp.anchor,
      params: comp.params,
      ignoreId: comp.id,
    });
    if (!ok) {
      throw new Error(
        `${label}: ${comp.ref} (${comp.id}) could not legally be seated at ${comp.board}.${comp.anchor}`,
      );
    }
  }
}

// ── Validation ───────────────────────────────────────────────────────────

/** Set every switch (or every DIP-switch position) from a bit pattern. */
function applyInputs(built, values) {
  const find = (id) => built.doc.components.find((c) => c.id === id);
  built.switches.forEach((sw, i) => {
    // Throw 1 is the +5 V side, throw 2 the pull-down.
    find(sw.id).params = { pos: values[i] ? "1" : "2" };
  });
  if (built.bank) find(built.bank.id).params = { states: values.map(Boolean) };
}

/** Is this junction conducting AND current-limited — i.e. lit, not burnt? */
function junctionLit(result, netlist, anode, cathode) {
  const level = (a) => result.netLevels.get(netlist.netOfPoint.get(a));
  const strong = (a) => result.strongLevels.get(netlist.netOfPoint.get(a));
  if (level(anode) !== H || level(cathode) !== L) return false;
  return !(strong(anode) === H && strong(cathode) === L);
}

const litLeds = (built, result, netlist) =>
  built.leds.map((led) => junctionLit(result, netlist, led.anode, led.cathode));

const bits = (values) => values.map((v) => (v ? 1 : 0)).join("");

/**
 * The engine must have nothing to complain about: a short, a driver conflict,
 * an oscillation or an unpowered chip in a DEMO is a wiring mistake, not a
 * lesson.
 */
function assertQuiet(built, result, context) {
  if (result.warnings.length) {
    const what = result.warnings.map((w) => w.type).join(", ");
    throw new Error(`${built.spec.ref}: ${context} — engine warned: ${what}`);
  }
}

/** Settle the bench with one input combination applied. */
function settleWith(built, values) {
  applyInputs(built, values);
  const netlist = buildNetlist(built.doc);
  const result = settle({ document: built.doc, netlist });
  assertQuiet(built, result, `inputs ${bits(values)}`);
  return { netlist, result };
}

/** Enumerate EVERY input combination and check each LED against the spec. */
function checkTruthTable(built) {
  const n = built.bank ? built.bank.holes.length : built.switches.length;
  const labels = built.bank
    ? built.spec.bank.labels
    : built.switches.map((s) => s.label);
  for (let word = 0; word < 1 << n; word++) {
    const values = Array.from({ length: n }, (_, i) =>
      Boolean(word & (1 << i)),
    );
    const { netlist, result } = settleWith(built, values);
    const actual = litLeds(built, result, netlist);
    const expected = built.spec.expect(values).map(Boolean);
    if (bits(actual) !== bits(expected)) {
      throw new Error(
        `${built.spec.ref}: with ${labels.join("")}=${bits(values)} ` +
          `expected LEDs ${bits(expected)}, got ${bits(actual)}`,
      );
    }
  }
  return 1 << n;
}

/** Check a 74LS47-style display demo digit by digit. */
function checkDisplay(built) {
  const { spec } = built;
  const comp = built.doc.components.find((c) => c.id === built.display.id);
  const def = partDef(comp.ref);
  const pins = partPinAddresses(built.doc, comp);
  const addressOf = (pin) => pins.find((p) => p.pin === pin).address;

  for (const [digit, wanted] of Object.entries(spec.digits)) {
    const value = Number(digit);
    const values = [0, 1, 2, 3].map((bit) => Boolean(value & (1 << bit)));
    const { netlist, result } = settleWith(built, values);
    const on = def.segments
      .filter((seg) =>
        junctionLit(
          result,
          netlist,
          addressOf(seg.anodePin),
          addressOf(seg.cathodePin),
        ),
      )
      .map((seg) => seg.id)
      .filter((id) => spec.segments.includes(id))
      .join("");
    if (on !== wanted) {
      throw new Error(
        `${spec.ref}: digit ${digit} lit segments "${on}", expected "${wanted}"`,
      );
    }
  }
  return Object.keys(spec.digits).length;
}

/**
 * Run a clocked demo edge by edge with every switch left at its stored
 * position, checking the LEDs after each RISING edge (the phase the engine is
 * handed alternates, exactly as the SimController's timer drives it).
 */
function checkSequential(built) {
  const netlist = buildNetlist(built.doc);
  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  let edges = 0;
  for (let i = 0; i < SEQUENTIAL_EDGES * 2 + 1; i++) {
    const phase = i % 2 === 1 ? H : L; // start LOW, so edge 1 is a rise
    const result = tick({
      document: built.doc,
      netlist,
      warmStart: warm,
      state,
      prevPinLevels: prev,
      clockPhase: new Map([["clk1", phase]]),
    });
    warm = result.netLevels;
    state = result.state;
    prev = result.pinLevels;
    assertQuiet(built, result, `clock phase ${phase} (tick ${i})`);
    if (phase !== H) continue;
    edges++;
    const actual = litLeds(built, result, netlist);
    const expected = built.spec.sequential.expect(edges).map(Boolean);
    if (bits(actual) !== bits(expected)) {
      throw new Error(
        `${built.spec.ref}: after ${edges} clock edge(s) expected LEDs ` +
          `${bits(expected)}, got ${bits(actual)}`,
      );
    }
  }
  return edges;
}

/**
 * Prove one demo works, and describe what was proved. Checking a truth table
 * WORKS the switches, so the demo's saved positions are restored afterwards —
 * a desktop must open the way it was designed to open, not in whatever state
 * the last test case left behind.
 */
export function validateDemo(built) {
  try {
    if (built.spec.sequential) {
      return `${checkSequential(built)} clock edges`;
    }
    if (built.spec.display) {
      return `${checkDisplay(built)} digits`;
    }
    const cases = checkTruthTable(built);
    return `${cases} input combination${cases === 1 ? "" : "s"}`;
  } finally {
    applyInputs(built, built.defaults);
  }
}
