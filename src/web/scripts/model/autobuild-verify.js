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

// autobuild-verify.js — nothing reaches the user unproven.
//
// A generated circuit fails in two very different ways, and only one of them
// looks like a failure:
//
//   OUR BUG (abort).  A severed net, an accidental short, a part that did not
//   seat. These produce documents that load clean and simulate perfectly while
//   computing something else. Counting entities does not find them; only
//   comparing what the compiler MEANT against what the netlist DERIVED does.
//
//   THE SPEC'S MISTAKE (repair). The circuit is built exactly as described and
//   the description was wrong — an input left floating, a chip unpowered, an
//   LSB the wrong way round. These go back to the author as structured errors.
//
// The gates, in order. L1/L2 live in autobuild.js (they are about the spec, and
// it cannot compile without them); L3 onwards are here because they need the
// built document:
//
//   L3a  the loader dropped nothing            abort
//   L3b  every part actually seated            abort
//   L4   declared nets === derived nets        abort   ← the important one
//   L5   powered, settled, no warnings         repair
//   L6   no declared signal net floating       repair
//   L7   the spec's own tests pass             repair
//
// L7 is the only gate that checks INTENT rather than internal consistency, and
// it is the reason the DSL carries a `tests` block at all: a circuit can be
// perfectly built, perfectly settled, and still add wrong.
//
// ── Why the ladder is a GENERATOR ──────────────────────────────────────────
//
// L5 settles the whole circuit and L7 runs every acceptance test (each its own
// settle, plus a tick per clock edge on a sequential design). Run in one task
// that is seconds of frozen UI under a single unchanging label, so the panel
// needs to report which gate is running.
//
// It could not take a progress CALLBACK: everything here happens inside one
// synchronous task, so the DOM would not repaint until the whole thing was
// over and the callback would fire into a frozen window. Yielding is the only
// thing that actually lets a paint happen between gates.
//
// So `verifySteps` is the implementation and `verifyBuild` drains it. That
// keeps this module pure and DOM-free — it knows nothing about the panel, the
// event loop, or how long a caller waits between `next()` calls — while the
// twelve existing synchronous callers are completely unaffected. Deliberately
// NOT two code paths: a second copy of the ladder is free to drift from this
// one, and the drift would be silent.

import { tf } from "../i18n.js";
import { partDef } from "../catalog/index.js";
import { normalizeDocument } from "./desk-doc.js";
import { canPlacePart, partPinAddresses } from "./occupancy.js";
import { buildNetlist } from "../sim/netlist.js";
import { settle, tick } from "../sim/engine.js";
import { isLit, junctionState } from "../sim/junction.js";
import { H, L } from "../sim/levels.js";

const ABORT = "abort";
const REPAIR = "repair";

const fault = (gate, kind, code, message, extra = {}) => ({
  gate,
  kind,
  code,
  message,
  ...extra,
});

/**
 * Drain a step generator to its return value.
 *
 * The one place the sync/stepped split is bridged, so every synchronous caller
 * runs the SAME generator a stepping caller does.
 */
function drain(iterator) {
  let step = iterator.next();
  while (!step.done) step = iterator.next();
  return step.value;
}

/**
 * Run the ladder over a compiled build.
 *
 * @param {object} compiled  the `compileNetlist` result (ok: true)
 * @param {object} [spec]    the original spec, for its `tests` block
 * @returns {{ok:boolean, faults:Array, document:object, netlist:object, results:Array}}
 */
export function verifyBuild(compiled, spec = null) {
  return drain(verifySteps(compiled, spec));
}

/**
 * The ladder, one gate at a time.
 *
 * Yields `{gate, label}` BEFORE each gate runs — the label describes what is
 * about to happen, so a caller that paints it and then hands back control shows
 * the right thing while the work is in flight. The return value is exactly what
 * `verifyBuild` returns; an early `return` inside still resolves as the drained
 * value, which is what keeps the L3a and L4 short-circuits intact.
 *
 * @param {object} compiled  the `compileNetlist` result (ok: true)
 * @param {object} [spec]    the original spec, for its `tests` block
 * @yields {{gate:string, label:string}}
 * @returns {{ok:boolean, faults:Array, document:object, netlist:object, results:Array}}
 */
export function* verifySteps(compiled, spec = null) {
  const faults = [];
  const raw = compiled.document;
  const doc = normalizeDocument(raw);

  yield { gate: "L3", label: tf("ai.gate.l3", "Checking the build…") };

  // ── L3a: the loader is a silent filter, so compare counts. ────────────────
  for (const key of ["boards", "components", "wires"]) {
    if (doc[key].length !== raw[key].length) {
      faults.push(
        fault(
          "L3a",
          ABORT,
          "LOADER_DROPPED",
          `The loader kept ${doc[key].length} of ${raw[key].length} ${key} — ` +
            `the compiler emitted something malformed.`,
        ),
      );
    }
  }
  if (faults.length) return { ok: false, faults, document: doc };

  // ── L3b: seating. A part whose pins resolve to nothing is electrically
  //    dead while still looking present on the desk. ─────────────────────────
  for (const comp of doc.components) {
    if (!comp.board) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) {
      faults.push(
        fault(
          "L3b",
          ABORT,
          "UNSEATED",
          `${comp.id} (${comp.ref}) does not seat.`,
        ),
      );
      continue;
    }
    const floating = pins.filter((p) => p.address == null).map((p) => p.pin);
    if (floating.length) {
      faults.push(
        fault(
          "L3b",
          ABORT,
          "FLOATING_PINS",
          `${comp.id} (${comp.ref}) has pins over nothing: ${floating.join(", ")}.`,
        ),
      );
    }
    if (!canPlacePart(doc, { ...comp, ignoreId: comp.id })) {
      faults.push(
        fault(
          "L3b",
          ABORT,
          "ILLEGAL_SEAT",
          `${comp.id} (${comp.ref}) is not legally placed.`,
        ),
      );
    }
  }

  yield { gate: "L4", label: tf("ai.gate.l4", "Checking connectivity…") };

  const netlist = buildNetlist(doc);

  // ── L4: declared vs derived. ──────────────────────────────────────────────
  //
  // Compared by WIRING ALONE (`bridges: false`), because that is the only
  // partition the compiler is answerable for. A switch is a contact: throw one
  // to a rail — the ordinary way to source a logic input, and what all 52 demo
  // benches do — and the conducting netlist quite correctly reports its signal
  // net AS the rail. Held against the declared topology that reads as
  // NET_SHORTED_TO_RAIL, so every slide-switch design aborted as a compiler
  // fault the model could neither cause nor fix. What L4 exists to catch is a
  // severed net or two parts sharing a column-half, and both are facts about
  // wiring, which no switch position can hide or invent.
  //
  // L5 onwards keeps the CONDUCTING netlist: a real short is an electrical
  // fact, and `settle` reports it as one.
  const wiring = buildNetlist(doc, new Map(), { bridges: false });
  const addressOf = pinAddresser(doc, compiled.partMap);
  const netIdOfDeclared = new Map(); // declared name → conducting netId (L6)
  const wiredIdOfDeclared = new Map(); // declared name → wiring-only netId (L4)
  for (const net of compiled.nets ?? []) {
    const ids = new Set();
    let unreachable = false;
    for (const m of net.pins) {
      const address = addressOf(m);
      if (!address) {
        unreachable = true;
        continue;
      }
      const id = wiring.netOfPoint.get(address);
      if (id == null) unreachable = true;
      else ids.add(id);
      const live = netlist.netOfPoint.get(address);
      if (live != null && !netIdOfDeclared.has(net.name)) {
        netIdOfDeclared.set(net.name, live);
      }
    }
    if (unreachable) {
      faults.push(
        fault(
          "L4",
          ABORT,
          "MEMBER_UNREACHABLE",
          `Net "${net.name}" has a member with no address.`,
        ),
      );
      continue;
    }
    if (ids.size > 1) {
      faults.push(
        fault(
          "L4",
          ABORT,
          "NET_SEVERED",
          `Net "${net.name}" came out as ${ids.size} separate nets — a wire is missing.`,
        ),
      );
      continue;
    }
    if (ids.size === 1) wiredIdOfDeclared.set(net.name, [...ids][0]);
  }
  // Two DIFFERENT declared nets landing on one derived net is a short. Rail
  // nets legitimately merge (every VCC member is one net), so only non-rail
  // nets are held apart — and held apart from the rails too.
  const railIds = new Set();
  for (const net of compiled.nets ?? []) {
    if (net.rail && wiredIdOfDeclared.has(net.name)) {
      railIds.add(wiredIdOfDeclared.get(net.name));
    }
  }
  const seen = new Map(); // derived netId → declared name
  for (const net of compiled.nets ?? []) {
    if (net.rail) continue;
    const id = wiredIdOfDeclared.get(net.name);
    if (id == null) continue;
    if (railIds.has(id)) {
      faults.push(
        fault(
          "L4",
          ABORT,
          "NET_SHORTED_TO_RAIL",
          `Net "${net.name}" is shorted to a supply rail.`,
        ),
      );
      continue;
    }
    if (seen.has(id)) {
      faults.push(
        fault(
          "L4",
          ABORT,
          "NETS_SHORTED",
          `Nets "${seen.get(id)}" and "${net.name}" came out as one net — ` +
            `two parts are sharing a column-half.`,
        ),
      );
      continue;
    }
    seen.set(id, net.name);
  }
  if (faults.some((f) => f.kind === ABORT)) {
    return { ok: false, faults, document: doc, netlist };
  }

  yield { gate: "L5", label: tf("ai.gate.l5", "Simulating…") };

  // ── L5: does it actually run? ─────────────────────────────────────────────
  //
  // Settle with every clock idle-low rather than unspecified. A clock source
  // only drives its `out` net when it has a phase, so a bare settle leaves the
  // clock line at Z — which L6 would then report as an undriven net on a
  // perfectly good circuit. Idle-low is what the SimController starts from.
  const clockPhase = new Map(
    doc.components.filter((c) => c.kind === "clock").map((c) => [c.id, L]),
  );
  const first = settle({ document: doc, netlist, clockPhase });
  if (!first.settled) {
    faults.push(
      fault(
        "L5",
        REPAIR,
        "UNSETTLED",
        "The circuit never reached a stable state.",
      ),
    );
  }
  for (const w of first.warnings ?? []) {
    faults.push(
      fault(
        "L5",
        REPAIR,
        `SIM_${String(w.type).toUpperCase()}`,
        describeWarning(w),
      ),
    );
  }
  for (const [id, status] of first.chipStatus ?? []) {
    if (status?.status && status.status !== "ok") {
      faults.push(
        fault("L5", REPAIR, "CHIP_NOT_OK", `${id} is ${status.status}.`, {
          chip: id,
        }),
      );
    }
  }

  yield { gate: "L6", label: tf("ai.gate.l6", "Checking for undriven nets…") };

  // ── L6: a declared signal net that never resolves is a dangling input. ────
  //
  // …unless there IS a driver on it and the driver is switched off, which is a
  // different mistake with a different fix. "Nothing drives it" sent the model
  // hunting for a missing wire when what the design needed was one pin tied
  // LOW — and since a floating enable reads HIGH, the omission is invisible in
  // the netlist it wrote. So a net whose only driver is a tri-state output
  // names the enable pin instead, which is a fault a repair round can act on.
  const disabledBy = tristateEnables(doc, netlist, first);
  for (const net of compiled.nets ?? []) {
    if (net.rail) continue;
    const id = netIdOfDeclared.get(net.name);
    if (id == null) continue;
    const level = first.netLevels.get(id);
    if (level !== undefined && level !== "Z" && level !== "X") continue;
    const off = disabledBy.get(id);
    faults.push(
      off
        ? fault(
            "L6",
            REPAIR,
            "OUTPUTS_DISABLED",
            `Net "${net.name}" floats because ${off.chip}'s outputs are ` +
              `switched off: its active-LOW output ` +
              `${off.plural ? "enables" : "enable"} ${off.pin} ` +
              `${off.plural ? "are" : "is"} ${off.level}. ` +
              `Tie ${off.plural ? "them" : "it"} to GND.`,
            { net: net.name, chip: off.chip, pin: off.pin },
          )
        : fault(
            "L6",
            REPAIR,
            "NET_NOT_DRIVEN",
            `Net "${net.name}" settles to ${level ?? "nothing"} — nothing drives it.`,
            { net: net.name },
          ),
    );
  }

  // ── L7: the spec's own acceptance tests. ─────────────────────────────────
  //
  // `yield*` rather than a drain: L7 is the slowest gate — one settle per test,
  // and a tick per clock edge on top — so it is the one that most needs to
  // report per ITEM rather than going quiet for the whole block.
  const results = yield* runFunctionalTestSteps({
    doc,
    netlist,
    partMap: compiled.partMap,
    tests: spec?.tests,
  });
  for (const r of results) {
    if (!r.ok) {
      faults.push(
        fault("L7", REPAIR, "TEST_FAILED", `${r.name}: ${r.detail}`, {
          test: r.name,
        }),
      );
    }
  }

  return { ok: faults.length === 0, faults, document: doc, netlist, results };
}

function describeWarning(w) {
  const where = w.chip ?? w.net ?? "";
  return `${w.type}${where ? ` at ${where}` : ""}`;
}

/**
 * Which floating nets are floating because a tri-state part is switched off.
 *
 * A part declaring `outputEnable` (catalog data, proved against the evaluator
 * in tests/chips-tristate.test.js) drives nothing at all while any of those
 * pins is not LOW — and an unwired one reads HIGH, so the usual way to arrive
 * here is to have forgotten the pin entirely. Every enable that is not asserted
 * is named, because a part with two of them ('244) may be missing either or
 * both, and "tie this pin low" is only useful if it is the right pin.
 *
 * Exported because it is a question about a DOCUMENT, not about a generated
 * one: `model/desk-review.js` asks it of the desk the user built by hand, where
 * the same omission produces the same dead circuit and the same wrong diagnosis
 * ("nothing drives this net") if it goes unasked.
 *
 * @returns {Map<string, {chip:string, pin:string, level:string}>} netId → blame
 */
export function tristateEnables(doc, netlist, settled) {
  const out = new Map();
  for (const comp of doc.components ?? []) {
    const def = partDef(comp.ref);
    if (!def?.outputEnable?.length) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const addressOf = new Map(pins.map((p) => [p.pin, p.address]));
    const levelOf = (pin) => {
      const address = addressOf.get(pin);
      if (address == null) return undefined;
      return settled.netLevels.get(netlist.netOfPoint.get(address));
    };
    // An enable at Z is an enable nobody wired: it reads HIGH, and the part is
    // off. Anything but a solid L leaves the outputs floating.
    const off = def.outputEnable.filter((n) => levelOf(n) !== L);
    if (!off.length) continue;
    const name = (n) => {
      const p = def.pins.find((q) => q.n === n);
      return `${p?.name ?? n} (pin ${n})`;
    };
    const unwired = off.every(
      (n) => levelOf(n) === undefined || levelOf(n) === "Z",
    );
    const blame = {
      chip: `${comp.id} (${comp.ref})`,
      // The id on its own, beside the pre-formatted `chip` string the repair
      // message quotes: `desk-review.js` names a part the way the rest of the
      // desk names it (ref first, then id) and needs the finding to carry an id
      // a caller can select by. Additive — nothing here reads it.
      componentId: comp.id,
      pin: off.map(name).join(" and "),
      plural: off.length > 1,
      level: unwired ? "not wired at all" : "HIGH",
    };
    for (const p of pins) {
      const role = def.pins.find((q) => q.n === p.pin)?.role;
      if (role !== "output" && role !== "io") continue;
      if (p.address == null) continue;
      const netId = netlist.netOfPoint.get(p.address);
      if (netId != null && !out.has(netId)) out.set(netId, blame);
    }
  }
  return out;
}

/** Resolve a compiled net member to a desk address. */
function pinAddresser(doc, partMap) {
  const cache = new Map();
  return (member) => {
    const compId = partMap.get(member.partId);
    if (!compId) return null;
    if (member.kind === "terminal") return `${compId}.${member.terminal}`;
    let pins = cache.get(compId);
    if (!pins) {
      const comp = doc.components.find((c) => c.id === compId);
      pins = comp ? partPinAddresses(doc, comp) : null;
      cache.set(compId, pins);
    }
    return pins?.find((p) => p.pin === member.pin)?.address ?? null;
  };
}

// ── L7: the functional-test runner ──────────────────────────────────────────

/**
 * Run a spec's `tests` block against the built circuit.
 *
 * A test is `{ name, set, edges, expect }`:
 *
 *   set     `{ "<partId>": <number|"0101…"> }` — switch positions. A NUMBER is
 *           unambiguous (bit i sets position i+1); a STRING is read the same
 *           way, character i for position i+1. That ordering is stated rather
 *           than inferred, because an off-by-one here is exactly the silent
 *           wrong-circuit failure everything else guards against.
 *   edges   how many clock pulses to apply before reading (default 0).
 *   expect  `{ "<partId>.<pin>": "H"|"L", "<partId>": "0101…" }` — a pin's
 *           level, or a display's LIT SEGMENTS as a bit string, same indexing.
 *
 * @returns {Array<{name:string, ok:boolean, detail:string}>}
 */
export function runFunctionalTests(args) {
  return drain(runFunctionalTestSteps(args));
}

/**
 * The same runner, reporting each test before it runs.
 *
 * A spec with no `tests` block yields nothing at all — there is no work to
 * narrate, and a lone "Running 0 tests…" would be a label for an empty pause.
 *
 * @yields {{gate:"L7", label:string, index:number, total:number}}
 * @returns {Array<{name:string, ok:boolean, detail:string}>}
 */
export function* runFunctionalTestSteps({ doc, netlist, partMap, tests }) {
  if (!Array.isArray(tests) || !tests.length) return [];
  const results = [];

  for (const [i, t] of tests.entries()) {
    const name =
      typeof t?.name === "string" && t.name.trim() ? t.name : `tests[${i}]`;
    yield {
      gate: "L7",
      // A PROGRESS label, not a fault message — the ladder's faults stay
      // English because `buildRepairMessage` sends them back to the model as
      // its repair instruction, and this is never sent anywhere. It is the one
      // gate label that was left out when L3–L6 were localized; the file-level
      // exclusion in tests/no-hardcoded-strings.test.js is what hid it.
      label: tf("ai.gate.l7", "Running test {index} of {total}: {name}", {
        index: i + 1,
        total: tests.length,
        name,
      }),
      index: i,
      total: tests.length,
    };
    try {
      results.push({ name, ...runOne({ doc, netlist, partMap, test: t }) });
    } catch (e) {
      results.push({ name, ok: false, detail: e.message });
    }
  }
  return results;
}

/** Bit `i` of a number or 0/1 string → switch position i+1 / segment i+1. */
function bitsOf(value, width) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return Array.from({ length: width }, (_, i) => ((value >> i) & 1) === 1);
  }
  if (typeof value === "string" && /^[01]+$/.test(value)) {
    return Array.from({ length: width }, (_, i) => value[i] === "1");
  }
  throw new Error(
    `"${value}" is not a bit pattern (use a number or a 0/1 string)`,
  );
}

function runOne({ doc, netlist, partMap, test }) {
  // ① Apply switch settings. Switch state is a NETLIST input — a closed
  //    position's internalBridges conduct — so the netlist is rebuilt, not
  //    merely re-settled.
  let live = netlist;
  const sets = test?.set && typeof test.set === "object" ? test.set : {};
  let touched = false;
  for (const [specId, value] of Object.entries(sets)) {
    const compId = partMap.get(specId);
    const comp = compId && doc.components.find((c) => c.id === compId);
    if (!comp)
      throw new Error(`set names "${specId}", which is not in the circuit`);
    const def = partDef(comp.ref);
    const width = def?.switchBank ? def.pins.length / 2 : 1;
    if (!def?.switchBank && !Array.isArray(comp.params?.states)) {
      throw new Error(
        `"${specId}" (${comp.ref}) has no switch positions to set`,
      );
    }
    comp.params = { ...comp.params, states: bitsOf(value, width) };
    touched = true;
  }
  if (touched) live = buildNetlist(doc);

  // ② Clock it, if the test asks for edges.
  const edges = Number.isInteger(test?.edges) ? test.edges : 0;
  const clocks = doc.components
    .filter((c) => c.kind === "clock")
    .map((c) => c.id);
  let result;
  if (edges > 0 && clocks.length) {
    const phase = new Map(clocks.map((id) => [id, L]));
    let warm = new Map();
    let state = new Map();
    let prev = new Map();
    const step = () => {
      result = tick({
        document: doc,
        netlist: live,
        warmStart: warm,
        state,
        prevPinLevels: prev,
        clockPhase: phase,
      });
      warm = result.netLevels;
      state = result.state;
      prev = result.pinLevels;
    };
    step();
    for (let e = 0; e < edges; e++) {
      for (const id of clocks) phase.set(id, L);
      step();
      for (const id of clocks) phase.set(id, H);
      step();
    }
  } else {
    result = settle({ document: doc, netlist: live });
  }

  // ③ Read the expectations back.
  const addresses = pinAddresser(doc, partMap);
  const levelAt = (a) => result.netLevels.get(live.netOfPoint.get(a));
  const strongAt = (a) => result.strongLevels.get(live.netOfPoint.get(a));
  const mismatches = [];

  for (const [target, want] of Object.entries(test?.expect ?? {})) {
    const dot = target.indexOf(".");
    if (dot > 0) {
      const specId = target.slice(0, dot);
      const pinToken = target.slice(dot + 1);
      const compId = partMap.get(specId);
      const comp = compId && doc.components.find((c) => c.id === compId);
      if (!comp)
        throw new Error(
          `expect names "${specId}", which is not in the circuit`,
        );
      const def = partDef(comp.ref);
      const pin = def?.pins?.find(
        (p) => p.name === pinToken || String(p.n) === pinToken,
      );
      if (!pin) throw new Error(`"${comp.ref}" has no pin "${pinToken}"`);
      const address = addresses({ partId: specId, kind: "pin", pin: pin.n });
      const got = levelAt(address) ?? "Z";
      if (String(want).toUpperCase() !== got) {
        mismatches.push(`${target} is ${got}, expected ${want}`);
      }
      continue;
    }
    // A whole display: which segments are LIT (not merely conducting — a burnt
    // one conducts and shows nothing, which is the failure worth catching).
    const compId = partMap.get(target);
    const comp = compId && doc.components.find((c) => c.id === compId);
    if (!comp)
      throw new Error(`expect names "${target}", which is not in the circuit`);
    const def = partDef(comp.ref);
    if (!def?.segments?.length) {
      throw new Error(
        `"${target}" (${comp.ref}) is not a display; name a pin instead`,
      );
    }
    const wanted = bitsOf(want, def.segments.length);
    const got = def.segments.map((seg) => {
      const anode = addresses({
        partId: target,
        kind: "pin",
        pin: seg.anodePin,
      });
      const cathode = addresses({
        partId: target,
        kind: "pin",
        pin: seg.cathodePin,
      });
      return isLit(
        junctionState({
          anode: levelAt(anode),
          cathode: levelAt(cathode),
          anodeStrong: strongAt(anode),
          cathodeStrong: strongAt(cathode),
        }),
      );
    });
    for (let i = 0; i < wanted.length; i++) {
      if (wanted[i] !== got[i]) {
        mismatches.push(
          `${target} reads ${got.map((b) => (b ? 1 : 0)).join("")}, ` +
            `expected ${wanted.map((b) => (b ? 1 : 0)).join("")}`,
        );
        break;
      }
    }
  }

  return mismatches.length
    ? { ok: false, detail: mismatches.join("; ") }
    : { ok: true, detail: "" };
}
