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
// Tick (Feature 100, extended for ripple in Feature 220):
//   ① pre-settle with the OLD sequential state (propagates the new clock phase
//      + any input change to every pin),
//   ② sample each sequential chip's inputs and `step` it, then RE-settle and
//      repeat until no chip's state changes (a bounded fixpoint) — so an
//      output→clock ripple (QA→CKB) cascades WITHIN one tick.
//   ③ the loop's final settle is the post-settle (NEW state drives outputs).
//
// Edge safety across the inner loop: every step detects edges against the
// tick's ENTRY inputs (`prevPinLevels`) plus a per-tick consumed-edge set — the
// external clock edge is consumed on the first pass (synchronous parts step
// exactly once, byte-for-byte the old two-phase result), yet a NEW internal
// edge that a just-updated output creates is still observed (ripple cascades).

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

/**
 * Sequential-step fixpoint cap within a single `tick` (Feature 220). A ripple
 * chain settles in ~depth iterations; beyond this a self-clocking loop is
 * oscillating — its still-changing sequential nets are marked `X` and reported,
 * mirroring the combinational settle cap.
 */
export const MAX_TICK_ITERATIONS = 200;

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

/**
 * The pin→address map for a behavioral desk BRICK (board == null — the HD44780
 * LCD): each `pins[].n` resolves to its terminal's wire address (`lcd1.RS`), or
 * null when a pin has no terminal. Board parts (chips/discretes) go through
 * occupancy's partPinAddresses instead. Generic — any future behavioral brick
 * with `pins` + `terminals` participates with no further engine change.
 */
function brickPinAddresses(comp, def) {
  if (!def.terminals) return null;
  return def.pins.map((p) => {
    const t = def.terminals.find((x) => x.pin === p.n);
    return { pin: p.n, address: t ? formatAddress(comp.id, t.id) : null };
  });
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
    // A desk-level brick (board == null) resolves its pins from terminal
    // addresses; a board part from its footprint/occupancy.
    const pins =
      comp.board == null
        ? brickPinAddresses(comp, def)
        : partPinAddresses(doc, comp);
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

/** Structural equality for plain-data sequential states (arrays/objects/scalars). */
function sameState(a, b) {
  if (a === b) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!sameState(a[k], b[k])) return false;
  return true;
}

/** Sample a chip's input pins from a settled net-level map (Z when floating). */
function samplePins(c, levels) {
  const raw = new Map();
  for (const [pin, net] of c.pinNet) {
    raw.set(pin, net ? (levels.get(net) ?? Z) : Z);
  }
  return inputLevels(c.def, raw);
}

/**
 * Advance the circuit one synchronous tick: pre-settle (old state), then iterate
 * sample→step→re-settle to a state fixpoint so an output→clock ripple cascades
 * within the tick, ending on the post-settle of the final state. A tick fires on
 * a clock transition OR any input event; each inner step detects edges against
 * the PREVIOUS inner iteration's sampled inputs (seeded, on the first pass, from
 * the tick's entry inputs `prevPinLevels`). An external clock net is fixed at
 * `clockPhase` for the whole tick, so its edge is seen once (byte-for-byte the
 * old two-phase result for synchronous designs); a clock net driven by another
 * chip's output re-transitions as that output updates, so a NEW internal edge
 * cascades the ripple (Feature 220).
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
  let solved = solve(ctx, warmStart, state, clockPhase, images);

  // ② Sequential-step fixpoint: sample each sequential chip from the current
  //    settled levels, `step` it (edges vs the previous inner iteration), and
  //    re-settle around the new state — repeating until no chip's state changes.
  //    The first pass reproduces the old two-phase result; a further pass only
  //    fires a NEW edge that a just-updated output created (the ripple cascade).
  // Seed the state with every sequential chip's current-or-initial state so the
  // returned map always has an entry per chip (a no-change pass returns this),
  // and seed the edge-detection "prev" from the tick's entry inputs.
  const curStateSeed = new Map(state);
  const prevIns = new Map(); // compId → previous inner iteration's sampled inputs
  for (const c of ctx.chips) {
    if (!c.sequential) continue;
    if (!curStateSeed.has(c.comp.id)) {
      curStateSeed.set(c.comp.id, initialState(c.def));
    }
    const entry = prevPinLevels.get(c.comp.id);
    if (entry) prevIns.set(c.comp.id, entry);
  }
  let curState = curStateSeed;
  const finalIns = new Map(); // compId → last-sampled input levels
  let iterations = 0;
  let oscillating = false;
  let lastChanged = new Set();
  for (;;) {
    const changed = new Set();
    const nextState = new Map(curState);
    const sampled = new Map();
    for (const c of ctx.chips) {
      if (!c.sequential) continue;
      const ins = samplePins(c, solved.levels);
      sampled.set(c.comp.id, ins);
      finalIns.set(c.comp.id, ins);
      const current = curState.get(c.comp.id) ?? initialState(c.def);
      const next =
        c.status === CHIP_STATUS.OK
          ? stepChip(c.def, current, ins, prevIns.get(c.comp.id) ?? null)
          : current; // inert chip holds; drives nothing
      if (!sameState(next, current)) changed.add(c.comp.id);
      nextState.set(c.comp.id, next);
    }
    // Advance the edge-detection baseline to this iteration's samples: a pin
    // that has reached its stable level shows no edge next pass (so the external
    // clock fires once), while a still-rippling output keeps producing edges.
    for (const [id, ins] of sampled) prevIns.set(id, ins);
    if (changed.size === 0) break; // state fixpoint reached
    iterations++;
    curState = nextState;
    lastChanged = changed;
    if (iterations >= MAX_TICK_ITERATIONS) {
      oscillating = true;
      break;
    }
    solved = solve(ctx, solved.levels, curState, clockPhase, images);
  }

  // Memory: no clocked state — read its inputs from the FINAL settled levels and
  // REPORT any write op for the controller to apply (the engine never mutates
  // the image). Populate its pin levels for parity with sequential chips.
  const memWrites = [];
  for (const c of ctx.chips) {
    if (!c.memory) continue;
    const ins = samplePins(c, solved.levels);
    finalIns.set(c.comp.id, ins);
    if (c.status === CHIP_STATUS.OK) {
      const op = memoryWrite(c.def, ins, images.get(c.comp.id));
      if (op) memWrites.push({ compId: c.comp.id, ...op });
    }
  }

  // A self-clocking ring that never settles: mark the still-changing sequential
  // nets `X` and report oscillation, exactly as the combinational settle does.
  const extraWarnings = [];
  if (oscillating) {
    const nets = new Set();
    for (const compId of lastChanged) {
      const c = ctx.chips.find((x) => x.comp.id === compId);
      if (!c) continue;
      const outs = outputsOf(
        c.def,
        curState.get(compId),
        finalIns.get(compId) ?? new Map(),
      );
      for (const pin of outs.keys()) {
        const net = c.pinNet.get(pin);
        if (net) nets.add(net);
      }
    }
    for (const id of nets) solved.levels.set(id, X);
    if (nets.size) extraWarnings.push({ type: "oscillation", nets: [...nets] });
  }

  const result = assemble(ctx, solved, {
    state: curState,
    pinLevels: finalIns,
    memWrites,
  });
  if (extraWarnings.length) {
    result.warnings = dedupe([...result.warnings, ...extraWarnings]);
    result.settled = false;
  }
  return result;
}
