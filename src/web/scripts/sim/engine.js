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

// engine.js — the simulation engine v1: seed power from PSUs, gate each chip
// on its VCC/GND, evaluate powered chips against net levels, and RIPPLE
// outputs back through the nets until a fixpoint (warm-started from the
// previous stable state — which is exactly why cross-coupled NAND latches
// hold). Pure and DOM-free: consumes { document, netlist, warmStart } and
// returns { netLevels, chipStatus, warnings } — no DOM, no IPC, no timers.
//
// Digital abstraction with drive strengths (see resolve.js). Voltage matters
// only at the power checks: a chip is POWERED iff its VCC net carries a 5 V
// PSU `+` and its GND net a PSU `−`; 3 V → underpowered (inert); 12 V →
// damaged (magic smoke — persisted, inert until "Replace chip"). Zero-delay,
// combinational; propagation-delay ticks arrive with Feature 100's clock.

import { Z, X } from "./levels.js";
import { evaluate, hasLogic } from "./chip-eval.js";
import { resolveNet } from "./resolve.js";
import { partDef } from "../catalog/index.js";
import { partPinHoles } from "../model/occupancy.js";
import { formatAddress } from "../model/breadboard.js";

/** Settle iteration cap — beyond this a still-changing net is oscillating. */
export const MAX_ITERATIONS = 200;

/** Chip power/health states. Only "ok" chips drive their outputs. */
export const CHIP_STATUS = Object.freeze({
  OK: "ok",
  UNPOWERED: "unpowered",
  UNDERPOWERED: "underpowered",
  DAMAGED: "damaged",
});

function powerStatus({ vccVolts, gnd, damaged }) {
  if (damaged) return CHIP_STATUS.DAMAGED;
  if (vccVolts.includes(12)) return CHIP_STATUS.DAMAGED; // magic smoke
  if (gnd && vccVolts.includes(5)) return CHIP_STATUS.OK;
  if (gnd && vccVolts.includes(3)) return CHIP_STATUS.UNDERPOWERED;
  return CHIP_STATUS.UNPOWERED;
}

function mapsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** Collapse warnings so a net/chip is reported once per type. */
function dedupe(warnings) {
  const seen = new Set();
  const out = [];
  for (const w of warnings) {
    const key = `${w.type}:${w.net ?? w.chip ?? (w.nets ?? []).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/**
 * Settle a circuit to its stable net levels.
 *
 * @param {object} opts
 * @param {{boards:Array, components:Array, wires:Array}} opts.document
 * @param {{netOfPoint: Map, nets: Map}} opts.netlist - the Feature 70 netlist
 *   (already carries switch/button bridges via part state).
 * @param {Map<string,string>} [opts.warmStart] - previous stable net levels.
 * @returns {{
 *   netLevels: Map<string,string>,
 *   chipStatus: Map<string, {status:string}>,
 *   warnings: Array<object>,
 *   iterations: number,
 *   settled: boolean,
 * }}
 */
export function settle({ document: doc, netlist, warmStart = new Map() }) {
  const components = doc.components ?? [];
  const netOf = (address) => netlist.netOfPoint.get(address) ?? null;

  // ── Supply drivers per net (fixed for this settle) ──────────────────────
  const supplyPlusVolts = new Map(); // netId → [volts…]
  const supplyMinus = new Set(); // netIds carrying a PSU `−`
  for (const comp of components) {
    if (comp.kind !== "psu") continue;
    const def = partDef(comp.ref);
    if (!def?.terminals) continue;
    const volts = comp.params?.volts ?? 5;
    for (const t of def.terminals) {
      const net = netOf(formatAddress(comp.id, t.id));
      if (!net) continue;
      if (t.id === "+") {
        if (!supplyPlusVolts.has(net)) supplyPlusVolts.set(net, []);
        supplyPlusVolts.get(net).push(volts);
      } else {
        supplyMinus.add(net);
      }
    }
  }

  // ── Chips: pin→net maps + power status (only logic chips participate) ────
  const chips = [];
  const chipStatus = new Map();
  for (const comp of components) {
    const def = partDef(comp.ref);
    if (!def || comp.kind === "psu" || !hasLogic(def)) continue;
    const pins = partPinHoles(comp.ref, comp.anchor);
    if (!pins) continue;
    const pinNet = new Map();
    for (const { pin, hole } of pins) {
      pinNet.set(pin, netOf(formatAddress(comp.board, hole)));
    }
    const vccPin = def.pins.find((p) => p.role === "vcc")?.n;
    const gndPin = def.pins.find((p) => p.role === "gnd")?.n;
    const vccNet = pinNet.get(vccPin);
    const status = powerStatus({
      vccVolts: (vccNet && supplyPlusVolts.get(vccNet)) || [],
      gnd: supplyMinus.has(pinNet.get(gndPin)),
      damaged: comp.params?.damaged === true,
    });
    chipStatus.set(comp.id, { status });
    chips.push({ comp, def, pinNet, status });
  }

  const netIds = [...netlist.nets.keys()];

  // Chip output drivers for a given set of net levels.
  const chipDriversFor = (levels) => {
    const drivers = new Map(); // netId → [levels]
    for (const { def, pinNet, status } of chips) {
      if (status !== CHIP_STATUS.OK) continue; // unpowered chips drive nothing
      const pinLevels = new Map();
      for (const [pin, net] of pinNet) {
        pinLevels.set(pin, net ? (levels.get(net) ?? Z) : Z);
      }
      for (const [outPin, level] of evaluate(def, pinLevels)) {
        const net = pinNet.get(outPin);
        if (!net) continue;
        if (!drivers.has(net)) drivers.set(net, []);
        drivers.get(net).push(level);
      }
    }
    return drivers;
  };

  // Resolve every net once from supply + chip drivers.
  const resolveAll = (drivers) => {
    const next = new Map();
    const warnings = [];
    for (const id of netIds) {
      const res = resolveNet({
        supplyPlus: supplyPlusVolts.has(id),
        supplyMinus: supplyMinus.has(id),
        chipLevels: drivers.get(id) ?? [],
      });
      next.set(id, res.level);
      if (res.warning) warnings.push({ type: res.warning, net: id });
    }
    return { next, warnings };
  };

  // ── Settle loop (warm-started) ───────────────────────────────────────────
  let levels = new Map();
  for (const id of netIds) levels.set(id, warmStart.get(id) ?? Z);

  let iterations = 0;
  let settled = false;
  let lastWarnings = [];
  let prev = levels;
  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const { next, warnings } = resolveAll(chipDriversFor(levels));
    lastWarnings = warnings;
    if (mapsEqual(next, levels)) {
      levels = next;
      settled = true;
      break;
    }
    prev = levels;
    levels = next;
  }

  const warnings = [...lastWarnings];
  if (!settled) {
    // The nets still flipping between the last two passes are oscillating.
    const nets = netIds.filter((id) => prev.get(id) !== levels.get(id));
    for (const id of nets) levels.set(id, X);
    if (nets.length) warnings.push({ type: "oscillation", nets });
  }
  for (const { comp, status } of chips) {
    if (status === CHIP_STATUS.UNDERPOWERED) {
      warnings.push({ type: "underpowered", chip: comp.id });
    } else if (status === CHIP_STATUS.DAMAGED) {
      warnings.push({ type: "damaged", chip: comp.id });
    }
  }

  return {
    netLevels: levels,
    chipStatus,
    warnings: dedupe(warnings),
    iterations,
    settled,
  };
}
