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
// it works. Split out from the make-gate-demos.mjs CLI so the shipped files'
// guard test (web/scripts/tests/gate-demos.test.js) exercises the very same
// build and the very same checks, rather than a second implementation of them.
//
// What counts as proved depends on the demo: a combinational one has every
// switch combination settled and every LED read (or the explicit `cases` a
// wide-input part lists, since 12 switched inputs is 4096 settles); a display
// demo every digit; a clocked one every rising edge of a run, optionally
// working the switches part-way through (`phases`) so a load-then-shift or an
// up-then-down really is exercised. All of them additionally insist the engine
// reports NO warnings — a short or an oscillation in a demonstration is a
// wiring mistake, not a lesson.
//
// The INPUT VECTOR is the one ordering everything here shares: the DIP-switch
// bank's bits first (if the demo has one), then the slide switches left to
// right, then a routing switch. `defaults`, `expect`, `cases` and `phases` all
// index it, so a spec never has to know which physical part a bit landed on.

import { Bench, LAYOUT } from "./demo-bench.mjs";
import {
  DeskDoc,
  normalizeDocument,
} from "../src/web/scripts/model/desk-doc.js";
import { deskBounds } from "../src/web/scripts/model/part-geometry.js";
import {
  canPlacePart,
  partPinAddresses,
} from "../src/web/scripts/model/occupancy.js";
import { CHIP_DEFS, partDef } from "../src/web/scripts/catalog/index.js";
import { buildNetlist } from "../src/web/scripts/sim/netlist.js";
import { settle, tick } from "../src/web/scripts/sim/engine.js";
import { H, L } from "../src/web/scripts/sim/levels.js";

/** How many rising clock edges a sequential demo is run for by default. */
const SEQUENTIAL_EDGES = 20;

/**
 * Catalog groups whose parts cannot be demonstrated by flipping switches at
 * them — a RAM or a CPU needs a program, which is what demos/65xx-* are. They
 * get no group project, and no spec is expected for their chips.
 */
export const PROGRAM_ONLY = new Set(["Memory", "Interface", "PROCESSOR"]);

/** A group's demo file name: its own name, spaces closed up. */
export const fileNameOf = (group) => `${group.replace(/\s+/g, "-")}.chiphippo`;

/**
 * The catalog's benchable groups → the chip ids in each, in catalog order.
 * This is the ONE definition of what the demos must cover: the group set, the
 * membership and the ordering all come from the catalog itself, so a part
 * added there shows up here as a missing spec rather than as a silent gap.
 */
export function catalogGroups() {
  const groups = new Map();
  for (const def of CHIP_DEFS) {
    if (PROGRAM_ONLY.has(def.group)) continue;
    if (!groups.has(def.group)) groups.set(def.group, []);
    groups.get(def.group).push(def.id);
  }
  return groups;
}

/** Every chip in every benchable group must have a spec — no quiet gaps. */
export function assertComplete(groups, specs) {
  const missing = [];
  for (const [group, ids] of groups) {
    for (const id of ids) if (!specs.has(id)) missing.push(`${group}/${id}`);
  }
  if (missing.length) {
    throw new Error(
      `no demo spec for ${missing.length} catalog chip(s): ${missing.join(", ")}`,
    );
  }
  const known = new Set([...groups.values()].flat());
  const stray = [...specs.keys()].filter((id) => !known.has(id));
  if (stray.length) {
    throw new Error(`demo spec for unknown/program-only chip(s): ${stray.join(", ")}`); // prettier-ignore
  }
}

// ── Build ────────────────────────────────────────────────────────────────

/** Every switched input of a spec, in input-vector order. */
function inputLabels(spec) {
  return [
    ...(spec.bank?.labels ?? []),
    ...(spec.inputs ?? []).map((i) => i.label),
    ...(spec.route ? [spec.route.label] : []),
  ];
}

/**
 * One demonstration desktop: the bench laid out from a spec, plus the handles
 * the validator needs (which component is which switch, which LED is which).
 */
export function buildDemo(spec) {
  const b = new Bench();
  b.power();
  if (spec.clock) b.clock(spec.clock.hz);
  const chip = b.chip(spec.ref);

  // How the demo comes up: `defaults` is the position of each switched input
  // as SAVED, chosen to show the part doing something the moment it is opened.
  // Validation works the switches, so the defaults have to be put back
  // afterwards (validateDemo) or the file would keep the last case's state.
  const labels = inputLabels(spec);
  const defaults = labels.map((_, i) => spec.defaults?.[i] ?? true);
  const banked = Boolean(spec.bank);
  let vectorAt = 0; // how much of the input vector is spoken for so far

  // The DIP-switch bank, if this part has more inputs than switches will fit.
  let bank = null;
  if (spec.bank) {
    bank = b.switchBank({
      labels: spec.bank.labels,
      states: defaults.slice(0, spec.bank.pins.length),
    });
    bank.holes.forEach((hole, i) => {
      const pin = spec.bank.pins[i];
      if (pin != null) b.join(hole, chip.holeOf(pin), "input");
    });
    vectorAt = spec.bank.pins.length;
  }

  // Slide switches, left to right — the upper half first, then the lower.
  const capacity = LAYOUT.switchCapacity(banked);
  const wanted = (spec.inputs ?? []).length + (spec.route ? 1 : 0);
  if (wanted > capacity) {
    throw new Error(
      `${spec.ref}: ${wanted} switches asked for, but only ${capacity} fit ` +
        `${banked ? "beside the DIP-switch bank" : "on the bench"}`,
    );
  }
  const switches = (spec.inputs ?? []).map((input, i) => {
    const sw = b.slideSwitch({
      ...LAYOUT.switchSlot(i, banked),
      label: input.label,
      name: `Input ${input.label}`,
      on: defaults[vectorAt + i],
    });
    for (const pin of input.pins) b.join(sw.hole, chip.holeOf(pin), "input");
    return { ...sw, label: input.label };
  });
  vectorAt += switches.length;

  // A routing switch hands ONE signal to one of two pins (a '193's two clocks).
  let route = null;
  if (spec.route) {
    const slot = LAYOUT.switchSlot(switches.length, banked);
    route = b.routeSwitch({
      ...slot,
      label: spec.route.label,
      name: spec.route.label,
      on: defaults[vectorAt],
    });
    switches.push({ id: route.id, label: spec.route.label });
  }

  for (const { pins, rail } of spec.ties ?? []) {
    for (const pin of pins) b.tie(chip.holeOf(pin), rail);
  }
  for (const [from, to] of spec.links ?? []) {
    b.join(chip.holeOf(from), chip.holeOf(to), "link");
  }
  // The clock brick has ONE `out` terminal, so a second clocked pin is
  // daisy-chained off the first, exactly as it would be on the bench — or,
  // with a routing switch, the clock goes to the switch and the switch to the
  // pins.
  if (spec.clock) {
    if (route) {
      b.wireClock(route.common);
      route.throws.forEach((hole, i) => {
        b.join(hole, chip.holeOf(spec.route.pins[i]), "clock");
      });
    }
    spec.clock.pins.forEach((pin, i) => {
      if (i === 0 && !route) b.wireClock(chip.holeOf(pin));
      else if (i > 0) b.join(chip.holeOf(spec.clock.pins[i - 1]), chip.holeOf(pin), "clock"); // prettier-ignore
    });
  }

  const leds = (spec.leds ?? []).map((led, i) => {
    const placed = b.led({
      half: i < 8 ? "upper" : "lower",
      col: LAYOUT.ledCol(i, chip.halfPins),
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
  const doc = centreDocument(normalizeDocument(b.document()));
  assertClean(b.document(), doc, spec.ref);
  assertPlaceable(doc, spec.ref);
  return { spec, doc, chipId: chip.id, switches, bank, leds, display, labels, defaults }; // prettier-ignore
}

/**
 * Slide a finished bench so it straddles the origin — the SAME rigid move
 * fit-to-screen makes (`DeskDoc.translateAll` over `deskBounds`), applied ONCE
 * here so the app never has to make it. A demo opened as an example desktop is
 * framed by a plain camera fit: the recentre half of ⌘F finds a zero delta and
 * returns without emitting, so nothing lands on the undo stack of a desk the
 * user has not touched yet. The bench is a fixed frame, so this is the same
 * delta for every spec — but it is DERIVED, not hardcoded, so a layout change
 * cannot quietly leave the demos off-centre.
 *
 * Rigid, so it can neither drop an entity nor illegalise a placement: the two
 * assertions below stay exactly as meaningful over the centred document.
 */
function centreDocument(doc) {
  const bounds = deskBounds(doc.boards, doc.components, doc.wires);
  if (!bounds) return doc;
  const deskDoc = new DeskDoc(doc);
  deskDoc.translateAll(
    -(bounds.minX + bounds.maxX) / 2,
    -(bounds.minY + bounds.maxY) / 2,
  );
  return deskDoc.toJSON();
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

/**
 * Apply one input vector: the bank's bits first, then each slide switch. This
 * is the ONE place the vector's ordering is interpreted — everything a spec
 * writes (`defaults`, `cases`, `expect`, `phases`) is in these terms.
 */
function applyInputs(built, values) {
  const find = (id) => built.doc.components.find((c) => c.id === id);
  const bankBits = built.bank ? built.spec.bank.pins.length : 0;
  if (built.bank) {
    find(built.bank.id).params = {
      states: values.slice(0, bankBits).map(Boolean),
    };
  }
  built.switches.forEach((sw, i) => {
    // Throw 1 is the +5 V side (or the first routed pin), throw 2 the other.
    find(sw.id).params = { pos: values[bankBits + i] ? "1" : "2" };
  });
}

/** The input vector with a phase's named overrides applied over `base`. */
function withOverrides(built, base, overrides) {
  const values = [...base];
  for (const [label, value] of Object.entries(overrides ?? {})) {
    const at = built.labels.indexOf(label);
    if (at < 0) {
      throw new Error(`${built.spec.ref}: no switched input named "${label}"`);
    }
    values[at] = Boolean(value);
  }
  return values;
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

/**
 * Check the LEDs against the spec for every input combination — or, when the
 * part has more switched inputs than an exhaustive sweep is worth (12 inputs
 * is 4096 settles), for the explicit `cases` it lists instead. An `expect`
 * that returns null skips that combination, which is how a part with a
 *16-function table can be pinned to the functions worth demonstrating.
 */
function checkTruthTable(built) {
  const { spec } = built;
  const n = built.labels.length;
  if (!spec.cases && n > 8) {
    throw new Error(
      `${spec.ref}: ${n} switched inputs — list explicit \`cases\` rather ` +
        `than sweeping ${1 << n} combinations`,
    );
  }
  const words =
    spec.cases ??
    Array.from({ length: 1 << n }, (_, word) =>
      Array.from({ length: n }, (_, i) => Boolean(word & (1 << i))),
    );

  let checked = 0;
  for (const values of words) {
    const expected = spec.expect(values);
    if (expected == null) continue; // a combination the spec doesn't pin down
    const { netlist, result } = settleWith(built, values);
    const actual = litLeds(built, result, netlist);
    if (bits(actual) !== bits(expected.map(Boolean))) {
      throw new Error(
        `${spec.ref}: with ${built.labels.join("")}=${bits(values)} ` +
          `expected LEDs ${bits(expected.map(Boolean))}, got ${bits(actual)}`,
      );
    }
    checked++;
  }
  return checked;
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
 * Run a clocked demo edge by edge, checking the LEDs after each RISING edge
 * (the phase handed to the engine alternates, exactly as the SimController's
 * timer drives it).
 *
 * `phases` optionally WORKS THE SWITCHES part-way through — `{ untilEdge,
 * inputs }` holds those overrides until that edge has been counted, which is
 * what makes a load-then-shift or a count-up-then-down demonstrable rather
 * than merely plausible. Changing a switch changes which pins conduct, so the
 * netlist is rebuilt exactly as the running app rebuilds it on a part-state
 * event.
 */
function checkSequential(built) {
  const { spec } = built;
  const phases = spec.sequential.phases ?? [];
  const edgesWanted = spec.sequential.edges ?? SEQUENTIAL_EDGES;

  let netlist = null;
  let applied = null;
  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  let edges = 0;

  /** The input vector in force for the edge about to be clocked. */
  const vectorFor = (edge) => {
    const phase = phases.find((p) => edge <= p.untilEdge);
    return withOverrides(built, built.defaults, phase?.inputs);
  };

  for (let i = 0; i < edgesWanted * 2 + 1; i++) {
    const clock = i % 2 === 1 ? H : L; // start LOW, so edge 1 is a rise
    // Whatever the clock is doing, the switches are set up for the edge that
    // is coming — a real hand flips them between edges, not during one.
    const values = vectorFor(edges + 1);
    if (bits(values) !== applied) {
      applyInputs(built, values);
      netlist = buildNetlist(built.doc);
      applied = bits(values);
    }
    const result = tick({
      document: built.doc,
      netlist,
      warmStart: warm,
      state,
      prevPinLevels: prev,
      clockPhase: new Map([["clk1", clock]]),
    });
    warm = result.netLevels;
    state = result.state;
    prev = result.pinLevels;
    assertQuiet(built, result, `clock phase ${clock} (tick ${i})`);
    if (clock !== H) continue;
    edges++;
    const expected = spec.sequential.expect(edges);
    if (expected == null) continue; // an edge the spec doesn't pin down
    const actual = litLeds(built, result, netlist);
    if (bits(actual) !== bits(expected.map(Boolean))) {
      throw new Error(
        `${spec.ref}: after ${edges} clock edge(s) expected LEDs ` +
          `${bits(expected.map(Boolean))}, got ${bits(actual)}`,
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
