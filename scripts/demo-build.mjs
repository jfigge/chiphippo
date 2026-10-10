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

// demo-build.mjs — turn a demo spec into a laid-out desk document, and PROVE
// it works (and do the same for the few examples drawn by hand instead —
// HAND_BUILT, at the end). Split out from the make-gate-demos.mjs CLI so the
// shipped files' guard test (web/scripts/tests/gate-demos.test.js) exercises
// the very same build and the very same checks, rather than a second
// implementation of them.
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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Bench, LAYOUT } from "./demo-bench.mjs";
import {
  DeskDoc,
  DOC_VERSION,
  normalizeDocument,
} from "../src/web/scripts/model/desk-doc.js";
import { deskBounds } from "../src/web/scripts/model/part-geometry.js";
import {
  canPlacePart,
  partPinAddresses,
} from "../src/web/scripts/model/occupancy.js";
import { CHIP_DEFS, partDef } from "../src/web/scripts/catalog/index.js";
import {
  ledSeriesOhms,
  pullDownOhms,
} from "../src/web/scripts/catalog/families.js";
import { buildNetlist } from "../src/web/scripts/sim/netlist.js";
import { settle, tick } from "../src/web/scripts/sim/engine.js";
import { H, L } from "../src/web/scripts/sim/levels.js";

/** How many rising clock edges a sequential demo is run for by default. */
const SEQUENTIAL_EDGES = 20;

/**
 * Catalog groups whose parts cannot be demonstrated by flipping switches at
 * them — a RAM or a CPU needs a program, which is what demos/65xx-* are. They
 * get no group project, and no spec is expected for their chips. A CPU's
 * example is a whole computer running a program from its ROM
 * (demo-computers.mjs); a few Interface parts need no program and are drawn
 * by hand (HAND_BUILT).
 */
export const PROGRAM_ONLY = new Set(["Memory", "Interface", "PROCESSOR"]);

/**
 * Catalog groups whose parts keep TIME with an external resistor and capacitor
 * — the 555 and the CD4000 one-shots and multivibrator, all in Timer. A bench
 * states its truth table as LEVELS, and what these parts do is a PERIOD:
 * showing one needs a seated RC network and a check that steps simulated
 * time, and the bench builder has neither yet. So they get no group project
 * and no bench — though a part among them may ship an example drawn by hand
 * instead (HAND_BUILT, below). (The CD4060B keeps time too, but it is a
 * Counter, and its external-clock mode benches like any ripple counter.)
 */
export const TIMED_GROUPS = new Set(["Timer"]);

/**
 * Catalog groups whose parts are ANALOG — the op-amp: what one does is a
 * voltage its resistors set, which a bench's truth table of levels cannot
 * state. No bench and no group project; an example drawn by hand instead
 * (HAND_BUILT).
 */
export const ANALOG_GROUPS = new Set(["Op-amps"]);

/**
 * Parts whose example circuit is drawn BY HAND on the desk rather than built
 * from a spec: a part → its project under demos/, ONE DESKTOP PER THING THE
 * PART DOES. The bench cannot build what these need (see TIMED_GROUPS), and
 * the 555's three modes are three different circuits, not one bench.
 * make-gate-demos.mjs ships each as src/web/demos/<ref>.json in the
 * multi-desktop shape model/example-desktops.js reads, and each desktop's
 * name becomes part of its tab's ("NE555 Astable example") — so name the
 * desktops for what they show.
 */
export const HAND_BUILT = Object.freeze({
  NE555: "ne555.chiphippo",
  // The bench parts (features/chiphippo-bench-parts-feature-request.md): each
  // an example of its own. Their Interface chips (the ULN2003A and the
  // optocouplers) are PROGRAM_ONLY's group, but they need no program — a
  // switch and a lamp show what they do — and the discretes, the relay and
  // the load have no bench at all.
  LM358: "lm358.chiphippo",
  ULN2003A: "uln2003a.chiphippo",
  "4N35": "4n35.chiphippo",
  PC817: "pc817.chiphippo",
  LM7805: "lm7805.chiphippo",
  LM317: "lm317.chiphippo",
  relay: "relay.chiphippo",
  load: "load.chiphippo",
});

const DEMOS_ROOT = fileURLToPath(new URL("../demos/", import.meta.url));

/**
 * A benchable group's KEY — its logic family and its catalog group,
 * `74LS/NAND` — because the families never share a project (Feature 400): a
 * CMOS NAND and a TTL NAND are wired to different rules (every CMOS input
 * tied), and a project mixing them would invite exactly the mixed-family
 * circuit the engine warns about. A benchable chip always has a family; the
 * family-less parts (memory, peripherals, CPUs) are all PROGRAM_ONLY.
 */
export const groupKey = (family, group) => `${family}/${group}`;

/** The family and group a key names. */
export function splitGroupKey(key) {
  const slash = key.indexOf("/");
  return { family: key.slice(0, slash), group: key.slice(slash + 1) };
}

/** A group's demo file, relative to demos/: its family's folder, then the
    group's own name with spaces closed up — `74LS/Shift-register.chiphippo`. */
export const fileNameOf = (key) => {
  const { family, group } = splitGroupKey(key);
  return `${family}/${group.replace(/\s+/g, "-")}.chiphippo`;
};

/** A group project's NAME — what its window title says: `CD4000 NAND`. */
export const projectNameOf = (key) => {
  const { family, group } = splitGroupKey(key);
  return `${family} ${group}`;
};

/**
 * The catalog's benchable groups → the chip ids in each, in catalog order,
 * keyed by `groupKey` (family + group). This is the ONE definition of what the
 * demos must cover: the group set, the membership and the ordering all come
 * from the catalog itself, so a part added there shows up here as a missing
 * spec rather than as a silent gap.
 */
export function catalogGroups() {
  const groups = new Map();
  for (const def of CHIP_DEFS) {
    if (PROGRAM_ONLY.has(def.group) || TIMED_GROUPS.has(def.group)) continue;
    if (ANALOG_GROUPS.has(def.group)) continue;
    const key = groupKey(def.family ?? "other", def.group);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(def.id);
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
  // What every switched input is pulled down through: 1 kΩ on a 74LS input
  // (it sources current while low), 10 kΩ on a CMOS one (catalog/families.js).
  const pullOhms = pullDownOhms(partDef(spec.ref));
  // …and what its LEDs are lit through (a CD4000 output needs more, to stay
  // a HIGH its own inputs read).
  const ledOhms = ledSeriesOhms(partDef(spec.ref));

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
      pullOhms,
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
      pullOhms,
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
      ohms: ledOhms,
    });
    b.join(chip.holeOf(led.pin), placed.hole, "output");
    return { ...placed, label: led.label };
  });

  let display = null;
  if (spec.display) {
    display = b.segmentDisplay({ ref: spec.display.ref });
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
export function centreDocument(doc) {
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
export function assertClean(before, after, label) {
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
export function assertPlaceable(doc, label) {
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

/**
 * Check a display demo digit by digit: the first four switched inputs are the
 * BCD code (A first), and every other switch stays where the demo opens it —
 * the CD4511B's LT, BL and LE among them.
 */
function checkDisplay(built) {
  const { spec } = built;
  const comp = built.doc.components.find((c) => c.id === built.display.id);
  const def = partDef(comp.ref);
  const pins = partPinAddresses(built.doc, comp);
  const addressOf = (pin) => pins.find((p) => p.pin === pin).address;

  for (const [digit, wanted] of Object.entries(spec.digits)) {
    const value = Number(digit);
    const values = built.defaults.slice();
    for (const bit of [0, 1, 2, 3]) values[bit] = Boolean(value & (1 << bit));
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

// ── Hand-built examples ──────────────────────────────────────────────────

/**
 * One hand-built example (HAND_BUILT), ready to ship: `{ ref, title,
 * desktops: [{ name, description?, doc }] }`. Each desktop's document is
 * loaded the way the app loads it and CENTRED for the bench's reason (an
 * example desktop must be framed by a plain camera fit, leaving no undo step),
 * and must keep every entity and seat every part legally — the same two
 * checks a bench passes. What it DOES is validateHandBuilt's to prove.
 *
 * Only the project's desktops are read. A ROM's bytes are not carried — no
 * example ships memory, so a project holding some is refused rather than
 * shipped without them.
 */
export function buildHandBuilt(ref) {
  const file = HAND_BUILT[ref];
  const def = partDef(ref);
  if (!file || !def) throw new Error(`${ref}: no hand-built example`);
  const project = JSON.parse(readFileSync(`${DEMOS_ROOT}${file}`, "utf8"));
  if (Object.keys(project.images ?? {}).length) {
    throw new Error(`demos/${file}: an example cannot carry ROM images`);
  }
  const names = new Set();
  const desktops = (project.tabs ?? []).map((tab) => {
    const label = `demos/${file} "${tab.name}"`;
    if (typeof tab.name !== "string" || !tab.name.trim()) {
      throw new Error(`demos/${file}: a desktop has no name`);
    }
    if (names.has(tab.name)) throw new Error(`${label}: named twice`);
    names.add(tab.name);
    // A bundled document skips main's migrations, so it must already be at
    // the renderer's own version — re-saving the project in the app does it.
    if (tab.doc?.version !== DOC_VERSION) {
      throw new Error(
        `${label}: document version ${tab.doc?.version}, not ${DOC_VERSION} — ` +
          `open it in Chip Hippo and save it`,
      );
    }
    const doc = centreDocument(normalizeDocument(tab.doc));
    assertClean(tab.doc, doc, label);
    assertPlaceable(doc, label);
    return {
      name: tab.name,
      ...(tab.description ? { description: tab.description } : {}),
      doc,
    };
  });
  if (!desktops.length) throw new Error(`demos/${file}: no desktops`);
  return { ref, title: def.title, desktops };
}

/**
 * Prove one hand-built desktop, and say what it was proved to be: every chip
 * powered, every timed part reading its own wiring as a circuit it knows (the
 * 555: astable, monostable or bistable), and the engine reporting NO warning,
 * as a bench must not. Returns the modes found ("monostable").
 */
export function validateHandBuilt(desktop, label) {
  const { doc } = desktop;
  const result = tick({
    document: doc,
    netlist: buildNetlist(doc),
    warmStart: new Map(),
    state: new Map(),
    prevPinLevels: new Map(),
    signalLevels: new Map(),
    now: 0,
  });
  for (const [id, { status }] of result.chipStatus) {
    if (status !== "ok") throw new Error(`${label}: ${id} is ${status}`);
  }
  if (result.warnings.length) {
    const said = result.warnings.map((w) => w.type).join(", ");
    throw new Error(`${label}: the engine warns (${said})`);
  }
  const modes = [];
  for (const [id, analysis] of result.timing ?? []) {
    if (analysis.problems.length) {
      const codes = analysis.problems.map((p) => p.code).join(", ");
      throw new Error(`${label}: ${id} does not read its wiring (${codes})`);
    }
    modes.push(...analysis.sections.map((s) => s.mode));
  }
  return modes.join(", ") || "settles clean";
}
