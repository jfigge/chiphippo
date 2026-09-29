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
import { outputEnables, partDef } from "../catalog/index.js";
import { normalizeDocument } from "./desk-doc.js";
import { canPlacePart, partPinAddresses } from "./occupancy.js";
import { resolvePin } from "./pin-resolve.js";
import { floatingInputs } from "./spec-lint.js";
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
  // Faults go back to the model that wrote the spec, so they name parts the
  // way IT does. The document says `c7`; the spec, and the model, say `U2` —
  // and with two 74LS244s in a design, "c7 (74LS244)" is not an instruction
  // anyone can act on.
  const nameOf = partNamer(compiled.partMap);

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
        fault("L3b", ABORT, "UNSEATED", `${nameOf(comp)} does not seat.`),
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
          `${nameOf(comp)} has pins over nothing: ${floating.join(", ")}.`,
        ),
      );
    }
    if (!canPlacePart(doc, { ...comp, ignoreId: comp.id })) {
      faults.push(
        fault(
          "L3b",
          ABORT,
          "ILLEGAL_SEAT",
          `${nameOf(comp)} is not legally placed.`,
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
  const where = electricalNamer(nameOf, doc, netIdOfDeclared);
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
        describeWarning(w, where),
      ),
    );
  }
  for (const [id, status] of first.chipStatus ?? []) {
    if (status?.status && status.status !== "ok") {
      faults.push(
        fault(
          "L5",
          REPAIR,
          "CHIP_NOT_OK",
          `${where.chip(id)} is ${status.status}.`,
          { chip: id },
        ),
      );
    }
  }
  // A burnt lamp is not an engine WARNING — the junction is physics the views
  // draw (sim/junction.js), and a settled net says nothing about it — so it is
  // asked for here. The resistor rule covers every leg the spec puts on a
  // rail; what is left burning has both legs on chip outputs.
  for (const burn of burntLamps(doc, netlist, first)) {
    faults.push(fault("L5", REPAIR, "LED_BURNS", describeBurn(burn, nameOf)));
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
  const disabledBy = tristateEnables(doc, netlist, first, nameOf);
  for (const net of compiled.nets ?? []) {
    if (net.rail) continue;
    const id = netIdOfDeclared.get(net.name);
    if (id == null) continue;
    const level = first.netLevels.get(id);
    if (level !== undefined && level !== "Z" && level !== "X") continue;
    // X is not "undriven": it is a net fought over or never settling, which
    // L5 has already reported as the conflict or oscillation it is. Saying
    // "nothing drives it" here sent a repair round looking for a missing wire
    // on a net that had one driver too many.
    if (level === "X") {
      faults.push(
        fault(
          "L6",
          REPAIR,
          "NET_UNRESOLVED",
          `Net "${net.name}" settles to X — it is driven to both levels at ` +
            `once or never settles; see the SIM_ faults for which.`,
          { net: net.name },
        ),
      );
      continue;
    }
    const off = disabledBy.get(id);
    // A BUS — several outputs that can each be switched off — floats when all
    // of them are, and "tie it to GND" is the wrong advice there: tie two
    // enables low and they fight. Say what a bus needs instead.
    const bus = outputsOn(net, compiled.partMap, doc) > 1;
    faults.push(
      off && bus
        ? fault(
            "L6",
            REPAIR,
            "OUTPUTS_DISABLED",
            `Net "${net.name}" floats because every output on it is switched ` +
              `off (${off.chip}'s ${off.pin} ${off.plural ? "are" : "is"} ` +
              `${off.level}, and the others likewise). A shared net needs ` +
              `exactly one of its drivers enabled — its active-LOW enable ` +
              `driven LOW — whenever it must carry a value.`,
            { net: net.name, chip: off.chip, pin: off.pin },
          )
        : off
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

  // An input the spec never connected does not show up as an undriven NET —
  // it is on no net at all — so the sweep above cannot see it, and it reads
  // HIGH: an enable left out disables its part, a clear left out holds it, and
  // every net still settles cleanly. `floatingInputs` knows which inputs a part
  // is actually USING (the spare gates of a 7400 may float; the enable of the
  // decoder whose outputs are wired may not).
  const specParts = [...(compiled.partMap ?? [])].flatMap(
    ([specId, compId]) => {
      const comp = doc.components.find((c) => c.id === compId);
      const def = comp && partDef(comp.ref);
      return def ? [{ id: specId, def }] : [];
    },
  );
  for (const loose of floatingInputs(specParts, compiled.nets ?? [])) {
    faults.push(
      fault(
        "L6",
        REPAIR,
        "INPUT_FLOATING",
        `${loose.partId} (${loose.ref}) leaves ` +
          `${loose.pins.length > 1 ? "inputs" : "input"} ` +
          `${loose.pins.map((p) => `${p.name} (pin ${p.n})`).join(", ")} ` +
          `unconnected. A floating TTL input reads HIGH, so the part does ` +
          `whatever HIGH means there — tie each one to VCC or GND, or wire it ` +
          `to the signal that should drive it.`,
        { part: loose.partId, pins: loose.pins.map((p) => p.n) },
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
    namer: (live) =>
      electricalNamer(nameOf, doc, declaredIds(compiled.nets, addressOf, live)),
  });
  for (const r of results) {
    if (!r.ok) {
      // A test that cannot be run as written is a different repair from a
      // circuit that fails it: fix the test, not the circuit.
      faults.push(
        fault(
          "L7",
          REPAIR,
          r.invalid ? "TEST_INVALID" : "TEST_FAILED",
          `${r.name}: ${r.detail}`,
          { test: r.name },
        ),
      );
    }
  }

  return { ok: faults.length === 0, faults, document: doc, netlist, results };
}

/** Engine warnings about a NET, as a sentence about the spec's nets. */
const NET_WARNINGS = Object.freeze({
  short: (nets) => `VCC and GND meet on ${nets}`,
  conflict: (nets) => `outputs drive opposite levels onto ${nets}`,
  oscillation: (nets) => `${nets} never settles — the circuit oscillates`,
});

/**
 * An engine warning in the spec's own terms. The engine names a chip by its
 * document id and a net by its smallest member ADDRESS (`bb1.a12`), neither of
 * which means anything to the model reading the repair — and an oscillation
 * names its nets in a `nets` list, which the old one-field reading dropped, so
 * the fault said "oscillation" and nothing else.
 */
function describeWarning(w, where) {
  if (w.chip != null) {
    return `${where ? where.chip(w.chip) : w.chip} is ${w.type}`;
  }
  const ids = w.nets ?? (w.net != null ? [w.net] : []);
  const nets = [...new Set(ids.map((id) => (where ? where.net(id) : id)))];
  const said = NET_WARNINGS[w.type];
  if (!nets.length) return w.type;
  return said ? said(nets.join(", ")) : `${w.type} on ${nets.join(", ")}`;
}

/** Component id → `U2 (74LS244)`, the spec's id with the part it names. */
function partNamer(partMap) {
  const specOf = new Map([...(partMap ?? [])].map(([s, c]) => [c, s]));
  return (comp) => `${specOf.get(comp.id) ?? comp.id} (${comp.ref})`;
}

/**
 * Names for what the engine reports: a chip by the spec's id, a net by the
 * declared name(s) it carries.
 *
 * @param {Function} nameOf  comp → name
 * @param {object} doc
 * @param {Map<string, string>} idOfDeclared  declared net name → net id
 */
function electricalNamer(nameOf, doc, idOfDeclared) {
  const byNet = new Map();
  for (const [name, id] of idOfDeclared ?? []) {
    if (!byNet.has(id)) byNet.set(id, []);
    byNet.get(id).push(name);
  }
  const comps = new Map(doc.components.map((c) => [c.id, c]));
  return {
    chip: (id) => (comps.has(id) ? nameOf(comps.get(id)) : String(id)),
    net: (id) =>
      byNet.has(id)
        ? byNet
            .get(id)
            .map((n) => `"${n}"`)
            .join(" / ")
        : "a net the spec does not name",
  };
}

/** Declared net name → its id in `live`, a netlist of the same document. */
function declaredIds(nets, addressOf, live) {
  const out = new Map();
  for (const net of nets ?? []) {
    for (const m of net.pins) {
      const id = live.netOfPoint.get(addressOf(m));
      if (id != null) {
        out.set(net.name, id);
        break;
      }
    }
  }
  return out;
}

/** How many `output`-role pins a declared net carries. */
function outputsOn(net, partMap, doc) {
  let n = 0;
  for (const m of net.pins) {
    if (m.kind !== "pin") continue;
    const comp = doc.components.find((c) => c.id === partMap?.get(m.partId));
    const role = comp && partDef(comp.ref)?.pins?.find((q) => q.n === m.pin);
    if (role?.role === "output") n++;
  }
  return n;
}

/**
 * Every lamp junction a settled circuit is BURNING — conducting across two
 * strongly driven nets with nothing to limit the current (sim/junction.js).
 *
 * @returns {Array<{comp:object, labels:string[], lamp:boolean}>}
 */
export function burntLamps(doc, netlist, result) {
  const burns = [];
  for (const comp of doc.components ?? []) {
    const def = partDef(comp.ref);
    const junctions = def?.segments?.length
      ? def.segments.map((s) => ({ ...s, label: s.id }))
      : typeof def?.polarity === "function"
        ? [{ ...def.polarity(comp.params ?? {}), label: null }]
        : [];
    if (!junctions.length) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const addressOf = new Map(pins.map((p) => [p.pin, p.address]));
    const at = (levels, pin) => {
      const address = addressOf.get(pin);
      return address == null
        ? undefined
        : levels?.get(netlist.netOfPoint.get(address));
    };
    const labels = junctions
      .filter(
        (j) =>
          junctionState({
            anode: at(result.netLevels, j.anodePin),
            cathode: at(result.netLevels, j.cathodePin),
            anodeStrong: at(result.strongLevels, j.anodePin),
            cathodeStrong: at(result.strongLevels, j.cathodePin),
          }).unlimited,
      )
      .map((j) => j.label);
    if (labels.length)
      burns.push({ comp, labels, lamp: !def.segments?.length });
  }
  return burns;
}

function describeBurn({ comp, labels, lamp }, nameOf) {
  const what = lamp
    ? `${nameOf(comp)} burns`
    : `${nameOf(comp)} segment${labels.length > 1 ? "s" : ""} ` +
      `${labels.join(", ")} burn${labels.length > 1 ? "" : "s"}`;
  return (
    `${what}: both legs are driven hard with nothing to limit the current. ` +
    `Put one leg on VCC or GND — the compiler adds the series resistor ` +
    `there — rather than between two outputs.`
  );
}

/**
 * Which floating nets are floating because a tri-state part is switched off.
 *
 * A part with output enables (`outputEnables`: declared on a tri-state logic
 * part, read off a memory's own chip and output enables) drives nothing at all
 * while any of those pins is not LOW — and an unwired one reads HIGH, so the
 * usual way to arrive here is to have forgotten the pin entirely. Every enable that is not asserted
 * is named, because a part with two of them ('244) may be missing either or
 * both, and "tie this pin low" is only useful if it is the right pin.
 *
 * Exported because it is a question about a DOCUMENT, not about a generated
 * one: `model/desk-review.js` asks it of the desk the user built by hand, where
 * the same omission produces the same dead circuit and the same wrong diagnosis
 * ("nothing drives this net") if it goes unasked.
 *
 * @param {Function} [nameOf]  comp → how `chip` names it; the verifier passes
 *   the spec's ids, the desk review the document's.
 * @returns {Map<string, {chip:string, pin:string, level:string}>} netId → blame
 */
export function tristateEnables(
  doc,
  netlist,
  settled,
  nameOf = (comp) => `${comp.id} (${comp.ref})`,
) {
  const out = new Map();
  for (const comp of doc.components ?? []) {
    const def = partDef(comp.ref);
    const enables = outputEnables(def);
    if (!enables.length) continue;
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
    const off = enables.filter((n) => levelOf(n) !== L);
    if (!off.length) continue;
    const name = (n) => {
      const p = def.pins.find((q) => q.n === n);
      return `${p?.name ?? n} (pin ${n})`;
    };
    const unwired = off.every(
      (n) => levelOf(n) === undefined || levelOf(n) === "Z",
    );
    const blame = {
      chip: nameOf(comp),
      // The id on its own, beside the pre-formatted `chip` string the repair
      // message quotes: `desk-review.js` names a part the way the rest of the
      // desk names it (ref first, then id) and needs the finding to carry an id
      // a caller can select by. Additive — nothing here reads it.
      componentId: comp.id,
      pin: off.map(name).join(" and "),
      plural: off.length > 1,
      // `level` is prose for the repair message; `unwired` is the same fact
      // as a flag, for a caller that has to TEST it rather than quote it.
      unwired,
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
 *           way, character i for position i+1, and must give EVERY position:
 *           a short string used to leave the rest open without a word, which
 *           is a test of something other than what its author wrote. That
 *           ordering is stated rather than inferred, because an off-by-one here
 *           is exactly the silent wrong-circuit failure everything else guards
 *           against.
 *   edges   how many clock pulses to apply before reading (default 0). Only a
 *           design with a `clock` has edges to give; asking one without is an
 *           invalid test, not a combinational one.
 *   expect  `{ "<partId>.<pin>": "H"|"L", "<partId>": "0101…" }` — a pin's
 *           level (the pin named as a net member may name it), or a display's
 *           LIT SEGMENTS as a bit string of exactly its width.
 *
 * Every test starts from the circuit AS BUILT — the switch positions of one
 * test are not left behind for the next — and every test state is checked
 * for what no expectation mentions: a short, a fight, an oscillation, a
 * burning lamp.
 *
 * A result is `{name, ok, detail}`, plus `invalid: true` when the test itself
 * could not be run as written (a bad target, a wrong-width pattern), which is
 * a different repair from a circuit that fails it.
 *
 * @returns {Array<{name:string, ok:boolean, detail:string, invalid?:boolean}>}
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
 * @param {object} args
 * @param {Function} [args.namer]  `(liveNetlist) → {chip(id), net(id)}`, to
 *   say which nets a state faults on in the spec's terms.
 * @yields {{gate:"L7", label:string, index:number, total:number}}
 * @returns {Array<{name:string, ok:boolean, detail:string, invalid?:boolean}>}
 */
export function* runFunctionalTestSteps({
  doc,
  netlist,
  partMap,
  tests,
  namer = null,
}) {
  if (!Array.isArray(tests) || !tests.length) return [];
  const results = [];
  // What each test starts from: the switch positions the circuit was BUILT
  // with. `runOne` writes a test's positions into the document; without this
  // the next test inherited them, and a test's meaning depended on its order.
  const built = new Map(doc.components.map((c) => [c.id, c.params]));

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
    for (const c of doc.components) c.params = built.get(c.id);
    try {
      results.push({
        name,
        ...runOne({ doc, netlist, partMap, test: t, namer }),
      });
    } catch (e) {
      results.push({ name, ok: false, detail: e.message, invalid: true });
    }
  }
  for (const c of doc.components) c.params = built.get(c.id);
  return results;
}

/** A test that cannot be run as written — thrown, and reported as invalid. */
class InvalidTest extends Error {}

/**
 * Bit `i` of a number or 0/1 string → switch position i+1 / segment i+1.
 * Exactly `width` bits: a pattern that is short, long or out of range is the
 * test's mistake, and guessing at the missing bits is how a wrong test passes.
 */
function bitsOf(value, width, what) {
  const positions = `${width} position${width === 1 ? "" : "s"}`;
  if (typeof value === "number" && Number.isInteger(value)) {
    if (value < 0 || value >= 2 ** width) {
      throw new InvalidTest(
        `${what} has ${positions}; ${value} does not fit in ${width} bits`,
      );
    }
    return Array.from({ length: width }, (_, i) => ((value >> i) & 1) === 1);
  }
  if (typeof value === "string" && /^[01]+$/.test(value)) {
    if (value.length !== width) {
      throw new InvalidTest(
        `${what} has ${positions}, and "${value}" gives ${value.length} ` +
          `— write all ${width}, LSB (position 1) first`,
      );
    }
    return Array.from({ length: width }, (_, i) => value[i] === "1");
  }
  throw new InvalidTest(
    `"${value}" is not a bit pattern (use a number or a 0/1 string)`,
  );
}

function runOne({ doc, netlist, partMap, test, namer }) {
  const expects = Object.entries(test?.expect ?? {});
  if (!expects.length) {
    throw new InvalidTest("it expects nothing, so it can never fail");
  }

  // ① Apply switch settings. Switch state is a NETLIST input — a closed
  //    position's internalBridges conduct — so the netlist is rebuilt, not
  //    merely re-settled.
  let live = netlist;
  const sets = test?.set && typeof test.set === "object" ? test.set : {};
  let touched = false;
  for (const [specId, value] of Object.entries(sets)) {
    const compId = partMap.get(specId);
    const comp = compId && doc.components.find((c) => c.id === compId);
    if (!comp) {
      throw new InvalidTest(
        `set names "${specId}", which is not in the circuit`,
      );
    }
    const def = partDef(comp.ref);
    const width = def?.switchBank ? def.pins.length / 2 : 1;
    if (!def?.switchBank && !Array.isArray(comp.params?.states)) {
      throw new InvalidTest(
        `"${specId}" (${comp.ref}) has no switch positions to set`,
      );
    }
    comp.params = {
      ...comp.params,
      states: bitsOf(value, width, `"${specId}" (${comp.ref})`),
    };
    touched = true;
  }
  if (touched) live = buildNetlist(doc);

  // ② Clock it, if the test asks for edges.
  const edges = test?.edges ?? 0;
  if (!Number.isInteger(edges) || edges < 0) {
    throw new InvalidTest(`edges must be a whole number, not ${edges}`);
  }
  const clocks = doc.components
    .filter((c) => c.kind === "clock")
    .map((c) => c.id);
  if (edges > 0 && !clocks.length) {
    // It used to settle instead and compare, so a sequential test passed
    // against the power-on state with no edge ever applied.
    throw new InvalidTest(
      `it asks for ${edges} clock edge${edges > 1 ? "s" : ""}, but the ` +
        `design has no clock source — add a "clock" part, or drop "edges"`,
    );
  }
  let result;
  const faults = [];
  const where = namer?.(live);
  const inspect = () => {
    for (const w of result.warnings ?? []) {
      if (w.chip == null) faults.push(describeWarning(w, where));
    }
    for (const burn of burntLamps(doc, live, result)) {
      faults.push(describeBurn(burn, (c) => where?.chip(c.id) ?? c.id));
    }
  };
  if (edges > 0) {
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
      inspect();
    };
    step();
    // One `edge` is one whole PULSE, LOW → HIGH → LOW, so a part triggered on
    // either edge sees `edges` of them. Stepping L then H from a LOW start
    // gave N rising edges but only N−1 falling ones: a falling-edge part
    // (74LS73/76/107/112, 7490) asked for one edge saw none, and a correct
    // design failed TEST_FAILED and was sent off to be "repaired".
    for (let e = 0; e < edges; e++) {
      for (const id of clocks) phase.set(id, H);
      step();
      for (const id of clocks) phase.set(id, L);
      step();
    }
  } else {
    result = settle({
      document: doc,
      netlist: live,
      clockPhase: new Map(clocks.map((id) => [id, L])),
    });
    inspect();
  }

  // ③ Read the expectations back.
  const addresses = pinAddresser(doc, partMap);
  const levelAt = (a) => result.netLevels.get(live.netOfPoint.get(a));
  const strongAt = (a) => result.strongLevels.get(live.netOfPoint.get(a));
  const mismatches = [...new Set(faults)];

  for (const [target, want] of expects) {
    const dot = target.indexOf(".");
    if (dot > 0) {
      const specId = target.slice(0, dot);
      const pinToken = target.slice(dot + 1);
      const compId = partMap.get(specId);
      const comp = compId && doc.components.find((c) => c.id === compId);
      if (!comp) {
        throw new InvalidTest(
          `expect names "${specId}", which is not in the circuit`,
        );
      }
      // The SAME resolver a net member goes through, so a pin the netlist
      // could name, the test can too.
      const r = resolvePin(comp.ref, pinToken);
      if (!r.ok || r.kind !== "pin") {
        throw new InvalidTest(
          r.message ?? `"${comp.ref}" has no pin "${pinToken}"`,
        );
      }
      const wanted = String(want).toUpperCase();
      if (wanted !== H && wanted !== L) {
        throw new InvalidTest(
          `expect ${target} is "${want}" — a pin is expected "H" or "L"`,
        );
      }
      const address = addresses({ partId: specId, kind: "pin", pin: r.pin });
      const got = levelAt(address) ?? "Z";
      if (wanted !== got) {
        mismatches.push(`${target} is ${got}, expected ${want}`);
      }
      continue;
    }
    // A whole display: which segments are LIT (not merely conducting — a burnt
    // one conducts and shows nothing, which is the failure worth catching).
    const compId = partMap.get(target);
    const comp = compId && doc.components.find((c) => c.id === compId);
    if (!comp) {
      throw new InvalidTest(
        `expect names "${target}", which is not in the circuit`,
      );
    }
    const def = partDef(comp.ref);
    if (!def?.segments?.length) {
      throw new InvalidTest(
        `"${target}" (${comp.ref}) is not a display; name a pin instead`,
      );
    }
    const wanted = bitsOf(
      want,
      def.segments.length,
      `"${target}" (${comp.ref})`,
    );
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
