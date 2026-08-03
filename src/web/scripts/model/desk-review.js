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

// desk-review.js — what is wrong with the circuit that is on the desk RIGHT NOW
// (Feature 320).
//
// The AI builder proves a circuit it GENERATED, through the L3a–L7 ladder in
// autobuild-verify.js. Every gate above L4 is really a question about a
// DOCUMENT — does it settle, is a chip powered, does a declared net float — and
// only the plumbing that feeds them is generated-circuit-specific. This asks the
// same questions of a desk the user built by hand, where there is no declared
// topology to compare against and the only truth is what the engine resolves.
//
// THE ENGINE FINDS THE FAULTS. That is the whole reason this module exists and
// is not a prompt: whether a net is shorted, whether an input floats, whether a
// tri-state part is switched off are facts the solver settles, and a language
// model asked to read a wiring list and judge them would answer confidently and
// sometimes wrongly, with nothing to check it against. What the model is for is
// the sentence after the fault — what it means, and what to do. So this is
// DOM-free, network-free, and testable on its own; ai/desk-brief.js is what
// turns its output into something to say.
//
// It runs its OWN settle rather than reading the transport's, for two reasons.
// The SimController publishes state but keeps no accessor for it, and — the one
// that matters — a review that only worked while the circuit ran would be
// useless for the case it exists for: a stopped desk that does nothing. Clocks
// are pinned idle-low exactly as L5 pins them (autobuild-verify.js), and for the
// same stated reason: a bare settle leaves a clock line at Z, and every net it
// feeds would then be reported as undriven on a perfectly good circuit.

import { tf } from "../i18n.js";
import { partDef } from "../catalog/index.js";
import { partTitle } from "../catalog/labels.js";
import { partPinAddresses } from "./occupancy.js";
import { buildPlan } from "./build-plan.js";
import { tristateEnables } from "./autobuild-verify.js";
import { settle } from "../sim/engine.js";
import { junctionState } from "../sim/junction.js";
import { L, Z } from "../sim/levels.js";

/** A finding that stops the circuit working as built. */
export const FAULT = "fault";
/** A finding that is suspicious but could be deliberate. */
export const WARNING = "warning";

/** Severity order for display — faults first, source order within a severity. */
const RANK = { [FAULT]: 0, [WARNING]: 1 };

/**
 * @typedef {object} Finding
 * @property {string} code        stable, English, never translated — the model
 *   and the user both see it, and it is what a bug report quotes.
 * @property {"fault"|"warning"} severity
 * @property {string} message     localized, one sentence.
 * @property {string} [componentId]
 * @property {string} [netId]
 */

const finding = (code, severity, message, extra = {}) => ({
  code,
  severity,
  message,
  ...extra,
});

/**
 * How a part is named in a finding. A packaged part is named by its REF (the
 * number silkscreened on it is what the user is looking at); anything else by
 * its title, since "led" is not what the drawer calls it. Same rule build-plan.js
 * applies to its own warnings, so the two lists read as one.
 */
function label(comp) {
  const def = partDef(comp.ref);
  if (!def) return comp.ref;
  return def.package ? comp.ref : partTitle(def);
}

/** "1A (pin 3)" — the silkscreen name first, because that is what is printed. */
function pinLabel(def, n) {
  const name = def?.pins?.find((p) => p.n === n)?.name;
  return name && name !== String(n)
    ? tf("review.pinNamed", "{name} (pin {n})", { name, n })
    : tf("review.pinNumber", "pin {n}", { n });
}

/**
 * Review the document on the desk.
 *
 * @param {{boards:Array, components:Array, wires:Array}} document a PLAIN desk
 *   document (`DeskDoc.toJSON()`), never the live DeskDoc — nothing here mutates
 *   it, but taking the plain form is what keeps this module DOM-free.
 * @param {{netOfPoint:Map, nets:Map}} netlist the shared NetlistCache's result.
 * @returns {{findings:Finding[], stats:object, settled:object}}
 */
export function reviewDesk(document, netlist) {
  const doc = {
    boards: document?.boards ?? [],
    components: document?.components ?? [],
    wires: document?.wires ?? [],
    buses: document?.buses ?? [],
    netNames: document?.netNames ?? [],
  };
  const findings = [];

  // ── The document-shaped checks build-plan.js already derives ──────────────
  //
  // Floating leads, chips with an unconnected power pin, and one-member nets.
  // Taken whole rather than re-implemented: they are already localized, already
  // tested, and already what the build guide shows — a review that disagreed
  // with the guide about the same desk would be the worse bug.
  const planned = new Set(); // componentIds the plan already blamed for power
  for (const w of buildPlan(doc, netlist).warnings ?? []) {
    if (w.kind === "unpowered-chip") {
      planned.add(w.componentId);
      findings.push(
        finding("UNPOWERED_CHIP", FAULT, w.message, {
          componentId: w.componentId,
        }),
      );
    } else if (w.kind === "floating-lead") {
      findings.push(
        finding("FLOATING_LEAD", WARNING, w.message, {
          componentId: w.componentId,
        }),
      );
    } else if (w.kind === "single-member-net") {
      findings.push(
        finding("SINGLE_MEMBER_NET", WARNING, w.message, { netId: w.netId }),
      );
    }
  }

  // ── Is there a supply at all? ─────────────────────────────────────────────
  //
  // Ahead of the settle, because it explains every other silence: with no PSU
  // on the desk nothing is driven, every chip is unpowered, and a list of forty
  // floating inputs is one fact reported forty times.
  const hasSupply = doc.components.some((c) => c.kind === "psu");
  if (!hasSupply && doc.components.length) {
    findings.push(
      finding(
        "NO_SUPPLY",
        FAULT,
        tf(
          "review.noSupply",
          "There is no power supply on the desk, so nothing can run. Add one from the parts tray and wire it to the board's power rails.",
        ),
      ),
    );
  }

  // ── The engine's own verdict ──────────────────────────────────────────────
  const clockPhase = new Map(
    doc.components.filter((c) => c.kind === "clock").map((c) => [c.id, L]),
  );
  const settled = settle({ document: doc, netlist, clockPhase });

  for (const w of settled.warnings ?? []) {
    findings.push(engineFinding(w, doc));
  }
  // `unpowered` is a STATUS, not a warning — the engine reports it by omission,
  // because a chip with nothing on its power pins is inert rather than wrong.
  // On a desk somebody is asking about, it is exactly what they want told.
  for (const [id, status] of settled.chipStatus ?? []) {
    if (status?.status !== "unpowered" || planned.has(id)) continue;
    const comp = doc.components.find((c) => c.id === id);
    if (!comp) continue;
    findings.push(
      finding(
        "UNPOWERED_CHIP",
        FAULT,
        tf(
          "review.unpowered",
          "{ref} ({id}) is wired but never reaches a supply — its VCC/GND nets carry no power.",
          { ref: label(comp), id },
        ),
        { componentId: id },
      ),
    );
  }

  // ── Tri-state parts that are switched off ─────────────────────────────────
  //
  // Before the floating-input sweep, because it is the SAME fault seen from the
  // useful end: an unwired active-low enable reads HIGH, the part drives
  // nothing, and "this net is undriven" sends you hunting for a missing wire
  // that was never missing. `tristateEnables` already names the pin to tie LOW.
  //
  // AN UNWIRED ENABLE AND A HIGH ONE ARE NOT THE SAME FAULT. Nobody wired it is
  // an omission the desk cannot recover from: the part is dead and no switch
  // throw brings it back. Wired but currently HIGH is a part that is switched
  // OFF — which on a bench with an enable on a slide switch is a state, not a
  // mistake, and the shipped 74LS125 bench sits in exactly that state with its
  // switch at rest. So one is a fault and the other a warning, and they say
  // different things.
  //
  // Two message forms, two WHOLE SENTENCES rather than one assembled from
  // localized fragments: "enable/enables", "is/are" and "it/them" do not agree
  // the same way in seven languages, and a translator handed "{chip} ... its
  // {enables} {pin} {verb} {level}" cannot produce a correct sentence in any of
  // them. The count param picks the plural form of the whole sentence instead.
  const seenChips = new Set();
  for (const blame of tristateEnables(doc, netlist, settled).values()) {
    if (seenChips.has(blame.chip)) continue;
    seenChips.add(blame.chip);
    const comp = doc.components.find((c) => c.id === blame.componentId);
    const params = {
      chip: comp ? `${label(comp)} (${comp.id})` : blame.chip,
      pin: blame.pin,
      count: blame.plural ? 2 : 1,
    };
    const unwired = blame.level === "not wired at all";
    findings.push(
      finding(
        "OUTPUTS_DISABLED",
        unwired ? FAULT : WARNING,
        unwired
          ? tf(
              "review.outputsDisabledUnwired",
              "{chip} drives nothing: its active-low output enable {pin} is not wired at all, and an unwired input reads HIGH. Tie it to GND.",
              params,
            )
          : tf(
              "review.outputsDisabledHigh",
              "{chip} is switched off right now: its active-low output enable {pin} is HIGH, so its outputs float. Drive it LOW to enable them.",
              params,
            ),
        { componentId: blame.componentId },
      ),
    );
  }

  // ── Inputs nothing drives ─────────────────────────────────────────────────
  //
  // The highest-value check here and the one nothing in the app reported before:
  // a floating TTL input reads HIGH, which is a real circuit's most convincing
  // lie — the gate behaves, just not as designed, and the netlist looks fine.
  //
  // Gated on the chip being properly POWERED. An unpowered or 3 V part has
  // already been reported as such, and every one of its inputs would otherwise
  // be listed again underneath, which buries the fault that caused them.
  // Reported once per PART rather than once per pin, because "these four inputs
  // are floating" is one wiring mistake and four lines of the same sentence is
  // not more information.
  //
  // Output-enable pins are skipped outright: an unwired one is exactly the
  // OUTPUTS_DISABLED fault above, said less usefully, and a correctly tied one
  // resolves to L and never reaches here anyway.
  //
  // AND — the rule that decides whether this list is usable at all — only the
  // inputs of a unit that is actually IN USE are reported. A 74LS00 has four
  // gates and a design that needs one leaves six inputs floating; on a real
  // bench those want tying, but reporting them would bury every genuine fault
  // under six lines of housekeeping on every circuit, including the ones this
  // app generates and ships. So a gate whose OUTPUT drives nothing is idle, not
  // broken. `logic.units` is exactly that question asked per gate (each unit has
  // one `output` pin); a part with no units block — a counter, a latch, a
  // memory — is judged whole, on whether any of its outputs is wired to
  // anything.
  for (const comp of doc.components) {
    const def = partDef(comp.ref);
    if (!def?.pins?.length) continue;
    if (settled.chipStatus?.get(comp.id)?.status !== "ok") continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const addressOf = new Map(pins.map((p) => [p.pin, p.address]));
    const used = (n) => isConnected(netlist, addressOf.get(n));

    const units = def.logic?.units;
    const live = units
      ? new Set(units.filter((u) => used(u.output)).flatMap((u) => u.inputs))
      : def.pins.some((p) => p.role === "output" && used(p.n))
        ? null // no units block: the whole part is in use, judge every input
        : new Set();

    const floating = [];
    for (const p of def.pins) {
      if (p.role !== "input") continue;
      if (def.outputEnable?.includes(p.n)) continue;
      if (live && !live.has(p.n)) continue;
      const address = addressOf.get(p.n);
      const level =
        address == null
          ? Z
          : (settled.netLevels.get(netlist.netOfPoint.get(address)) ?? Z);
      if (level === Z) floating.push(pinLabel(def, p.n));
    }
    if (!floating.length) continue;
    findings.push(
      finding(
        "INPUT_FLOATING",
        WARNING,
        tf(
          "review.inputFloating",
          "{ref} ({id}) has inputs nothing drives: {pins}. A floating TTL input reads HIGH, so the chip works — just not as designed. Tie each one to VCC or GND, or wire it to whatever should drive it.",
          { ref: label(comp), id: comp.id, pins: floating.join(", ") },
        ),
        { componentId: comp.id },
      ),
    );
  }

  // ── Two outputs on one net ────────────────────────────────────────────────
  //
  // `settle` reports a driver conflict only when the two outputs DISAGREE, so a
  // bus fight that happens to be driving the same level today is invisible until
  // the day it isn't. This is a fact about wiring, so it is checked statically
  // and reported whatever the levels are doing.
  const drivers = new Map(); // netId → ["74LS00 (c1) 1Y (pin 3)", …]
  for (const comp of doc.components) {
    const def = partDef(comp.ref);
    if (!def?.pins?.length) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    for (const { pin, address } of pins) {
      if (address == null) continue;
      if (def.pins.find((p) => p.n === pin)?.role !== "output") continue;
      const netId = netlist.netOfPoint.get(address);
      if (netId == null) continue;
      if (!drivers.has(netId)) drivers.set(netId, []);
      drivers
        .get(netId)
        .push(`${label(comp)} (${comp.id}) ${pinLabel(def, pin)}`);
    }
  }
  for (const [netId, names] of drivers) {
    if (names.length < 2) continue;
    findings.push(
      finding(
        "BUS_FIGHT",
        FAULT,
        tf(
          "review.busFight",
          "{drivers} are wired to the same net ({net}). Two outputs must never share a net — one drives HIGH while the other drives LOW and they fight.",
          { drivers: names.join(" and "), net: netId },
        ),
        { netId },
      ),
    );
  }

  // ── Junctions with nothing limiting the current ───────────────────────────
  //
  // Not a logic rule — nothing about a netlist says a diode needs a resistor.
  // It is a fact about the bench this app models, and the one mistake that
  // destroys a part rather than merely misbehaving.
  for (const comp of doc.components) {
    const def = partDef(comp.ref);
    if (!def) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const at = (pin) => pins.find((p) => p.pin === pin)?.address;
    // A display declares its segments; a single LED declares which way up it is
    // (`polarity` swaps with the F-flip). Both are read by name — the pair is
    // not positional, and a flipped LED is exactly the case that would silently
    // invert if it were.
    const junctions = def.segments?.length
      ? def.segments.map((s) => [s.anodePin, s.cathodePin])
      : def.polarity
        ? [[def.polarity(comp.params).anodePin, def.polarity(comp.params).cathodePin]] // prettier-ignore
        : [];
    const burnt = junctions.some(([a, k]) =>
      junctionAt(netlist, settled, at(a), at(k)),
    );
    if (!burnt) continue;
    findings.push(
      finding(
        "LED_UNLIMITED",
        FAULT,
        tf(
          "review.ledUnlimited",
          "{ref} ({id}) is conducting with nothing limiting the current — on a real bench it would burn out rather than light. Put a resistor in series with it.",
          { ref: label(comp), id: comp.id },
        ),
        { componentId: comp.id },
      ),
    );
  }

  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity]);

  return { findings, settled, stats: statsOf(doc, netlist, settled) };
}

/**
 * Does a point's net reach anything beyond the pin itself — a wire, a terminal,
 * or a second pin? The same question `build-plan.js` asks of a power pin, which
 * is why the shape matches: a net with one member is a pin sitting in a hole,
 * not a connection.
 */
function isConnected(netlist, address) {
  if (address == null) return false;
  const netId = netlist?.netOfPoint?.get(address);
  const net = netId != null ? netlist.nets.get(netId) : null;
  if (!net) return false;
  return (
    net.counts.wires > 0 || net.counts.terminals > 0 || net.counts.pins > 1
  );
}

/** One junction's burn verdict from two resolved addresses. */
function junctionAt(netlist, settled, anodeAt, cathodeAt) {
  if (!anodeAt || !cathodeAt) return false;
  const level = (a) => settled.netLevels.get(netlist.netOfPoint.get(a));
  const strong = (a) => settled.strongLevels?.get(netlist.netOfPoint.get(a));
  return junctionState({
    anode: level(anodeAt),
    cathode: level(cathodeAt),
    anodeStrong: strong(anodeAt),
    cathodeStrong: strong(cathodeAt),
  }).unlimited;
}

/**
 * One engine warning as a finding.
 *
 * The wording is the SimController's own (`sim.*Message`) wherever the run
 * already has a sentence for it — a fault the user may have seen as a toast
 * mid-run should not be described differently when they ask about it.
 */
function engineFinding(w, doc) {
  const chipName = (id) => {
    const comp = doc.components.find((c) => c.id === id);
    return comp ? `${label(comp)} (${id})` : id;
  };
  switch (w.type) {
    case "short":
      return finding(
        "SHORT",
        FAULT,
        tf("sim.shortMessage", "Opposing supplies meet on one net ({net}).", {
          net: w.net,
        }),
        { netId: w.net },
      );
    case "conflict":
      return finding(
        "CONFLICT",
        FAULT,
        tf(
          "sim.conflictMessage",
          "Two outputs are fighting on one net ({net}).",
          { net: w.net },
        ),
        { netId: w.net },
      );
    case "oscillation":
      return finding(
        "OSCILLATION",
        FAULT,
        tf(
          "sim.oscillationMessage",
          "The circuit won't settle ({count} unstable nets).",
          { count: w.nets?.length ?? 0 },
        ),
      );
    case "underpowered":
      return finding(
        "UNDERPOWERED",
        WARNING,
        tf("sim.underpoweredMessage", "{chip} is at 3 V — running inert.", {
          chip: chipName(w.chip),
        }),
        { componentId: w.chip },
      );
    case "reversed":
      return finding(
        "REVERSED",
        FAULT,
        tf("sim.reversedMessage", "{chip} has VCC and GND swapped.", {
          chip: chipName(w.chip),
        }),
        { componentId: w.chip },
      );
    default:
      return finding(
        "DAMAGED",
        FAULT,
        tf(
          "sim.damagedMessage",
          "{chip} was damaged by 12 V. Delete it and place a fresh one to continue.",
          { chip: chipName(w.chip) },
        ),
        { componentId: w.chip },
      );
  }
}

/**
 * The one-line shape of the desk, for the summary and the brief's header.
 *
 * `nets` counts the nets something is actually ON, not the raw partition. Every
 * unused hole on a breadboard is its own net, so the partition of an empty 830
 * is over three hundred of them — a number that says nothing about the circuit
 * and, printed above a list of the sixteen nets that carry a signal, reads as
 * though the list were truncated.
 */
function statsOf(doc, netlist, settled) {
  let chips = 0;
  let powered = 0;
  for (const [, status] of settled.chipStatus ?? []) {
    chips += 1;
    if (status?.status === "ok") powered += 1;
  }
  let nets = 0;
  for (const [, net] of netlist?.nets ?? []) {
    if (net.counts.pins > 0 || net.counts.terminals > 0) nets += 1;
  }
  return {
    boards: doc.boards.length,
    parts: doc.components.length,
    wires: doc.wires.length,
    nets,
    chips,
    poweredChips: powered,
  };
}

/** Is there anything on this desk to review at all? */
export function isEmptyDesk(document) {
  return !(document?.components?.length || document?.boards?.length);
}
