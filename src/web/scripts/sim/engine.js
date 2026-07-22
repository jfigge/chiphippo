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

// engine.js — the simulation engine. `settle` (Feature 90) resolves a purely
// combinational circuit to its stable net levels; `tick` (Feature 100) adds
// the synchronous two-phase step for stateful parts. Both are pure and
// DOM-free: no DOM, no IPC, and NO timers — the clock's timer lives in the
// renderer's SimController, which merely hands `tick` each clock's current
// output level (`clockPhase`).
//
// Power: a chip is POWERED iff its VCC net carries a 5 V PSU `+` and its GND
// net a PSU `−`; 3 V → underpowered (inert); 12 V → damaged (magic smoke).
// Digital abstraction with drive strengths (resolve.js): supply beats chip
// output; a clock source drives at output strength; Z contributes nothing.
//
// Two-phase tick (the standard synchronous trick — all edges observed at once,
// then the combinational cloud settles):
//   ① pre-settle with the OLD sequential state (propagates the new clock phase
//      + any input change to every pin),
//   ② sample each sequential chip's inputs, detect its edges vs the previous
//      tick, and compute its next state via the def's `step`,
//   ③ post-settle with the NEW state driving sequential outputs.

import { H, L, Z, X } from "./levels.js";
import {
  evaluate,
  outputsOf,
  stepChip,
  inputLevels,
  initialState,
  hasBehavior,
  isSequential,
  isMemory,
  memoryOutputs,
  memoryWrite,
} from "./chip-eval.js";
import { resolveNet } from "./resolve.js";
import { partDef } from "../catalog/index.js";
import { partPinAddresses } from "../model/occupancy.js";
import { formatAddress } from "../model/breadboard.js";

/** Settle iteration cap — beyond this a still-changing net is oscillating. */
export const MAX_ITERATIONS = 200;

/** Chip power/health states. Only "ok" chips drive their outputs. */
export const CHIP_STATUS = Object.freeze({
  OK: "ok",
  UNPOWERED: "unpowered",
  UNDERPOWERED: "underpowered",
  REVERSED: "reversed",
  DAMAGED: "damaged",
});

/**
 * Reversal is STRICT — both power pins must be actively wrong: a PSU `−` on
 * the VCC pin's net AND a PSU `+` on the GND pin's net. One wrong pin (the
 * other floating) is ordinary `UNPOWERED`; calling that "backwards" would
 * accuse the user of a mistake they may not have made.
 */
function powerStatus({ vccVolts, vccMinus, gndVolts, gnd, damaged }) {
  if (damaged) return CHIP_STATUS.DAMAGED;
  if (vccMinus && gndVolts.length) return CHIP_STATUS.REVERSED;
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
 * Build the per-settle FIXED context from a document + netlist: supply drivers,
 * clock terminals, and the participating chips with their pin→net maps and
 * power status (all constant while the topology is frozen). Reused across a
 * tick's pre- and post-settles.
 */
function buildContext(doc, netlist) {
  const components = doc.components ?? [];
  const netOf = (address) => netlist.netOfPoint.get(address) ?? null;
  const netIds = [...netlist.nets.keys()];

  // Supply drivers per net.
  const supplyPlusVolts = new Map(); // netId → [volts…]
  const supplyMinus = new Set(); // netIds carrying a PSU `−`
  const clocks = []; // { id, outNet }
  for (const comp of components) {
    const def = partDef(comp.ref);
    if (comp.kind === "psu" && def?.terminals) {
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
    } else if (comp.kind === "clock" && def?.terminals) {
      clocks.push({
        id: comp.id,
        outNet: netOf(formatAddress(comp.id, "out")),
      });
    }
  }

  // Resistors: weak two-terminal couplers (pull-ups / pull-downs / series R).
  // They never merge nets (that's a wire's job) — each conducts one terminal's
  // STRONG level to the other at the weakest strength (resolveAll, below).
  const resistors = []; // { netA, netB }
  for (const comp of components) {
    const def = partDef(comp.ref);
    if (!def?.weakBridges || comp.board == null) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const addressOfPin = new Map(pins.map((p) => [p.pin, p.address]));
    for (const [a, b] of def.weakBridges(comp.params)) {
      const aa = addressOfPin.get(a);
      const ab = addressOfPin.get(b);
      // A lead resolving to nothing conducts nothing — the part stays, inert.
      if (!aa || !ab) continue;
      resistors.push({ netA: netOf(aa), netB: netOf(ab) });
    }
  }

  // Chips (combinational + sequential): pin→net maps + power status.
  const chips = [];
  const chipStatus = new Map();
  for (const comp of components) {
    const def = partDef(comp.ref);
    if (
      !def ||
      comp.kind === "psu" ||
      comp.kind === "clock" ||
      !hasBehavior(def)
    ) {
      continue;
    }
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const pinNet = new Map();
    for (const { pin, address } of pins) {
      // A floating lead maps to no net — the pin still exists, reading Z.
      pinNet.set(pin, address ? netOf(address) : null);
    }
    const vccPin = def.pins.find((p) => p.role === "vcc")?.n;
    const gndPin = def.pins.find((p) => p.role === "gnd")?.n;
    const vccNet = pinNet.get(vccPin);
    const gndNet = pinNet.get(gndPin);
    const status = powerStatus({
      vccVolts: (vccNet && supplyPlusVolts.get(vccNet)) || [],
      vccMinus: supplyMinus.has(vccNet),
      gndVolts: (gndNet && supplyPlusVolts.get(gndNet)) || [],
      gnd: supplyMinus.has(gndNet),
      damaged: comp.params?.damaged === true,
    });
    chipStatus.set(comp.id, { status });
    chips.push({
      comp,
      def,
      pinNet,
      status,
      sequential: isSequential(def),
      memory: isMemory(def),
    });
  }

  return {
    netIds,
    supplyPlusVolts,
    supplyMinus,
    clocks,
    resistors,
    chips,
    chipStatus,
  };
}

/** Every driver (clock sources + powered chip outputs) for a set of levels. */
function driversFor(ctx, levels, state, clockPhase, images) {
  const drivers = new Map(); // netId → [levels]
  const add = (net, level) => {
    if (!net) return;
    if (!drivers.has(net)) drivers.set(net, []);
    drivers.get(net).push(level);
  };

  // Clock sources drive their output net at output strength.
  for (const clk of ctx.clocks) add(clk.outNet, clockPhase.get(clk.id) ?? Z);

  for (const c of ctx.chips) {
    if (c.status !== CHIP_STATUS.OK) continue; // inert chips drive nothing
    const pinLevels = new Map();
    for (const [pin, net] of c.pinNet) {
      pinLevels.set(pin, net ? (levels.get(net) ?? Z) : Z);
    }
    let outMap;
    if (c.memory) {
      // A memory reads its image (a pure input) onto the data pins, or floats.
      outMap = memoryOutputs(
        c.def,
        inputLevels(c.def, pinLevels),
        images.get(c.comp.id),
      );
    } else if (c.sequential) {
      outMap = outputsOf(
        c.def,
        state.get(c.comp.id) ?? initialState(c.def),
        inputLevels(c.def, pinLevels),
      );
    } else {
      outMap = evaluate(c.def, pinLevels);
    }
    for (const [outPin, level] of outMap) add(c.pinNet.get(outPin), level);
  }
  return drivers;
}

/** Resolve every net once from supplies + the given drivers (+ resistor pulls). */
function resolveAll(ctx, drivers) {
  const resolveOne = (id, pullLevels) =>
    resolveNet({
      supplyPlus: ctx.supplyPlusVolts.has(id),
      supplyMinus: ctx.supplyMinus.has(id),
      chipLevels: drivers.get(id) ?? [],
      pullLevels,
    });

  // With resistors present, first compute each net's STRONG level (supplies +
  // chip outputs, no pulls) — that's what a resistor conducts — then let each
  // resistor weakly drive its OTHER end toward that level. One extra pass, and
  // only when resistors exist; the fixpoint loop folds it in like any driver.
  let pulls = null;
  let strong = null;
  if (ctx.resistors.length) {
    strong = new Map();
    for (const id of ctx.netIds) strong.set(id, resolveOne(id, []).level);
    pulls = new Map(); // netId → [levels]
    const addPull = (net, level) => {
      if (!net || (level !== H && level !== L)) return;
      if (!pulls.has(net)) pulls.set(net, []);
      pulls.get(net).push(level);
    };
    for (const r of ctx.resistors) {
      addPull(r.netA, strong.get(r.netB));
      addPull(r.netB, strong.get(r.netA));
    }
  }

  const next = new Map();
  const warnings = [];
  for (const id of ctx.netIds) {
    const res = resolveOne(id, pulls?.get(id) ?? []);
    next.set(id, res.level);
    if (res.warning) warnings.push({ type: res.warning, net: id });
  }
  // Without resistors nothing is weakly pulled, so the resolved level IS the
  // strong one. Callers use this to tell "driven directly" from "fed through a
  // resistor" — the difference between a lit LED and a burnt one.
  return { next, warnings, strong: strong ?? next };
}

/** Run the warm-started settle loop for a fixed state + clock phase + images. */
function solve(ctx, warmStart, state, clockPhase, images) {
  let levels = new Map();
  for (const id of ctx.netIds) levels.set(id, warmStart.get(id) ?? Z);

  let iterations = 0;
  let settled = false;
  let lastWarnings = [];
  let lastStrong = new Map();
  let prev = levels;
  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const { next, warnings, strong } = resolveAll(
      ctx,
      driversFor(ctx, levels, state, clockPhase, images),
    );
    lastWarnings = warnings;
    lastStrong = strong;
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
    const nets = ctx.netIds.filter((id) => prev.get(id) !== levels.get(id));
    for (const id of nets) levels.set(id, X);
    if (nets.length) warnings.push({ type: "oscillation", nets });
  }
  return { levels, iterations, settled, warnings, strong: lastStrong };
}

/** Assemble the public result: net levels, chip status, deduped warnings. */
function assemble(ctx, solved, extra = {}) {
  const warnings = [...solved.warnings];
  for (const c of ctx.chips) {
    if (c.status === CHIP_STATUS.UNDERPOWERED) {
      warnings.push({ type: "underpowered", chip: c.comp.id });
    } else if (c.status === CHIP_STATUS.REVERSED) {
      warnings.push({ type: "reversed", chip: c.comp.id });
    } else if (c.status === CHIP_STATUS.DAMAGED) {
      warnings.push({ type: "damaged", chip: c.comp.id });
    }
  }
  return {
    netLevels: solved.levels,
    strongLevels: solved.strong,
    chipStatus: ctx.chipStatus,
    warnings: dedupe(warnings),
    iterations: solved.iterations,
    settled: solved.settled,
    ...extra,
  };
}

/**
 * Settle a purely combinational circuit (Feature 90). Sequential parts, if
 * present, are driven from their initial state and never advanced — use `tick`
 * to clock them.
 *
 * @param {object} opts
 * @param {{boards:Array, components:Array, wires:Array}} opts.document
 * @param {{netOfPoint: Map, nets: Map}} opts.netlist
 * @param {Map<string,string>} [opts.warmStart] - previous stable net levels.
 * @param {Map<string,object>} [opts.state] - per-component sequential state.
 * @param {Map<string,string>} [opts.clockPhase] - clock id → output level.
 * @param {Map<string,Uint8Array|Uint16Array>} [opts.images] - per-memory byte
 *   images (read-only input; the engine never mutates them).
 * @returns {{netLevels:Map, chipStatus:Map, warnings:Array, iterations:number, settled:boolean}}
 */
export function settle({
  document: doc,
  netlist,
  warmStart = new Map(),
  state = new Map(),
  clockPhase = new Map(),
  images = new Map(),
}) {
  const ctx = buildContext(doc, netlist);
  return assemble(ctx, solve(ctx, warmStart, state, clockPhase, images));
}

/**
 * Advance the circuit one synchronous tick: pre-settle (old state) → sample +
 * step every sequential chip → post-settle (new state). A tick fires on a
 * clock transition OR any input event; edges are detected from the pre-settle
 * levels versus `prevPinLevels` (the previous tick's sampled inputs).
 *
 * @param {object} opts
 * @param {{boards:Array, components:Array, wires:Array}} opts.document
 * @param {{netOfPoint: Map, nets: Map}} opts.netlist
 * @param {Map<string,string>} [opts.warmStart] - previous stable net levels.
 * @param {Map<string,object>} [opts.state] - per-component sequential state.
 * @param {Map<string,Map<number,string>>} [opts.prevPinLevels] - last tick's
 *   sampled input levels per component (for edge detection; empty → no edges).
 * @param {Map<string,string>} [opts.clockPhase] - clock id → current output.
 * @param {Map<string,Uint8Array|Uint16Array>} [opts.images] - per-memory byte
 *   images (read-only input; writes are REPORTED via `memWrites`, not applied).
 * @returns {{netLevels, chipStatus, warnings, iterations, settled,
 *   state: Map, pinLevels: Map, memWrites: Array<{compId,addr,value}>}}
 */
export function tick({
  document: doc,
  netlist,
  warmStart = new Map(),
  state = new Map(),
  prevPinLevels = new Map(),
  clockPhase = new Map(),
  images = new Map(),
}) {
  const ctx = buildContext(doc, netlist);

  // ① Pre-settle: propagate the new clock phase / input changes with the OLD
  //    sequential state holding.
  const pre = solve(ctx, warmStart, state, clockPhase, images);

  // ② Sample + step: read each sequential chip's inputs from the pre-settled
  //    levels, detect edges vs the previous tick, compute the next state. A
  //    memory chip has no clocked state — instead it REPORTS a write op for the
  //    controller to apply after the tick (the engine never mutates the image).
  const newState = new Map(state);
  const pinLevels = new Map();
  const memWrites = [];
  for (const c of ctx.chips) {
    if (!c.sequential && !c.memory) continue;
    const raw = new Map();
    for (const [pin, net] of c.pinNet) {
      raw.set(pin, net ? (pre.levels.get(net) ?? Z) : Z);
    }
    const ins = inputLevels(c.def, raw);
    pinLevels.set(c.comp.id, ins);
    if (c.memory) {
      if (c.status === CHIP_STATUS.OK) {
        const op = memoryWrite(c.def, ins, images.get(c.comp.id));
        if (op) memWrites.push({ compId: c.comp.id, ...op });
      }
      continue; // memory carries no sequential state to advance
    }
    const current = state.get(c.comp.id) ?? initialState(c.def);
    if (c.status !== CHIP_STATUS.OK) {
      newState.set(c.comp.id, current); // inert chip holds; drives nothing
      continue;
    }
    newState.set(
      c.comp.id,
      stepChip(c.def, current, ins, prevPinLevels.get(c.comp.id) ?? null),
    );
  }

  // ③ Post-settle: let the combinational cloud settle around the NEW state.
  const post = solve(ctx, pre.levels, newState, clockPhase, images);
  return assemble(ctx, post, { state: newState, pinLevels, memWrites });
}
