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

// settle-pass.js — one settle PASS, piece by piece: what every chip drives
// (`driversFor`, one chip at a time `chipOutputs`), which nets the analog
// switches join (`channelGroups`), and the resolution of every net from its
// drivers, pulls, joins and diodes (`resolveAll`, every reading of it
// `resolveReadings`). Pure and DOM-free. The full settle (sim/engine.js
// `solve`) runs them over the whole desk each pass; the incremental one
// (sim/incremental.js) runs them over what a pass changed — the same code,
// which is what keeps the two identical.

import { H, L, Z, X } from "./levels.js";
import {
  evaluate,
  outputsOf,
  inputLevels,
  PinScratch,
  initialState,
  channelStates,
  memoryOutputs,
  openCollectorDrive,
  driverLevel,
} from "./chip-eval.js";
import { resolveNet } from "./resolve.js";
import { UnionFind } from "./union-find.js";
import { CHIP_STATUS } from "./chip-status.js";
import { floatsUnknown } from "../catalog/families.js";
import { transistorCustom, transistorGrade } from "../catalog/discretes.js";
import { transistorModelFor } from "./spice/transistor-figures.js";

/** Two maps with the same keys and values. */
export function mapsEqual(a, b) {
  if (a.size !== b.size) return false;
  // (Keys and a lookup: a Map's entries are an array each, every walk.)
  for (const k of a.keys()) if (b.get(k) !== a.get(k)) return false;
  return true;
}

/**
 * One powered, non-switch chip's own outputs for a set of net levels — before
 * Spice Lite's `outputs` hook holds any back. Its pins are read as the chip
 * reads them (`hooks.input`); a memory reads its image, a sequential chip its
 * state (a WATCHED one is told to the observer), a can its clock phase, and
 * anything else is evaluated from its logic units. The map is never mutated
 * afterwards, by anyone: it may be handed out again unchanged — but for
 * `into`, a combinational chip's map from an earlier evaluation that its
 * caller holds nowhere else (sim/incremental.js's spare), filled again.
 */
export function chipOutputs(
  c,
  levels,
  state,
  clockPhase,
  images,
  observer,
  hooks,
  into = null,
) {
  // Each pin's reading, into the chip's own scratch map (engine.js
  // `reads`): nothing below keeps it — `evaluate` and `inputLevels` read it
  // and build maps of their own — but an observer, which is handed it.
  const pinLevels = observer ? new Map() : (c.reads ??= new PinScratch());
  const rails = c.railReads; // (a chip on a span of its own — engine.js)
  const { pinList, netList } = c; // (`pinNet` as arrays: no entry arrays)
  for (let k = 0; k < pinList.length; k++) {
    const pin = pinList[k];
    const net = netList[k];
    const level = net ? (rails?.get(net) ?? levels.get(net) ?? Z) : Z;
    pinLevels.set(pin, hooks?.input ? hooks.input(c, pin, net, level) : level); // prettier-ignore
  }
  let outMap;
  if (c.memory) {
    // A memory reads its image (a pure input) onto the data pins, or floats.
    // (Its last reading itself when the pins read the same: `inputLevels`'
    // `prev` — a reading is never mutated, so it may be shared.)
    const ins = (c.lastIns = inputLevels(c.def, pinLevels, c.lastIns, hooks ? null : c.sampled)); // prettier-ignore
    outMap = memoryOutputs(c.def, ins, images.get(c.comp.id));
  } else if (c.sequential) {
    const own = state.get(c.comp.id) ?? initialState(c.def);
    // (The step's last sample of it, `sampled`, read again rather than
    // built again when it is what the pins read: engine.js `samplePins`.)
    const ins = (c.lastIns = inputLevels(c.def, pinLevels, c.lastIns, hooks ? null : c.sampled)); // prettier-ignore
    outMap = outputsOf(c.def, own, ins);
    if (observer?.watch.has(c.comp.id)) observer.chip(c.comp.id, ins, own);
  } else if (c.oscillator) {
    // A board-seated crystal can: same free-running source as a clock
    // brick's terminal, but only while powered (the caller's status check).
    outMap = new Map([[c.outputPin, clockPhase.get(c.comp.id) ?? Z]]);
  } else {
    outMap = into ? evaluate(c.def, pinLevels, into) : evaluate(c.def, pinLevels); // prettier-ignore
  }
  // An open-collector output's HIGH drives nothing.
  outMap = openCollectorDrive(c.def, outMap);
  observer?.evaluated?.(c.comp.id, pinLevels, outMap);
  return outMap;
}

/**
 * Every driver (clock + signal sources, and powered chip outputs) for a set
 * of levels: `drivers` netId → [levels], and `hard`, the same minus each
 * output whose drive cannot burn an LED (the very same map when no part on
 * the desk limits one — `ctx.limitsLed`).
 */
export function driversFor(
  ctx,
  levels,
  state,
  clockPhase,
  images,
  signalLevels,
  observer = null,
  hooks = null,
) {
  const drivers = new Map(); // netId → [levels]
  const hard = ctx.limitsLed ? new Map() : drivers;
  const add = (net, level, limited = false) => {
    if (!net) return;
    if (!drivers.has(net)) drivers.set(net, []);
    drivers.get(net).push(level);
    if (hard === drivers || limited) return;
    if (!hard.has(net)) hard.set(net, []);
    hard.get(net).push(level);
  };

  // Clock sources drive their output net at output strength.
  for (const clk of ctx.clocks) add(clk.outNet, clockPhase.get(clk.id) ?? Z);

  // A planted signal flag drives its net at OUTPUT strength — the same tier
  // and the same sentence as a clock source, because it is the same thing: a
  // lead from the bench holding a level. Being CHIP-tier rather than a fourth
  // strength of its own is what makes two signals fighting over one net, or a
  // signal fighting a chip output, report a conflict with no new code in
  // resolve.js. A level it has not been given contributes nothing.
  for (const sig of ctx.signals) add(sig.net, signalLevels.get(sig.id) ?? Z);

  for (const c of ctx.chips) {
    if (c.status !== CHIP_STATUS.OK) continue; // inert chips drive nothing
    if (c.analogSwitch) continue; // it joins nets (channelGroups); drives none
    let outMap = chipOutputs(c, levels, state, clockPhase, images, observer, hooks); // prettier-ignore
    if (hooks?.outputs) outMap = hooks.outputs(c, outMap);
    for (const [outPin, level] of outMap) {
      add(c.pinNet.get(outPin), driverLevel(c.def, outPin, level, !hooks), c.limitsLevel.has(level)); // prettier-ignore
    }
  }
  return { drivers, hard };
}

/**
 * The most unknown channel controls one pass tries every way round (2⁴
 * readings — a 405x's A, B, C and INH). Past it, every channel that MIGHT be
 * on is closed at once in one wide reading: more X than the truth, never less.
 */
export const MAX_UNKNOWN_CONTROLS = 4;

/** A control pin's identity across parts: its net, or the pin itself when it
    is wired to nothing. */
const controlKey = (c, pin) => c.pinNet.get(pin) ?? `${c.comp.id}#${pin}`;

/**
 * Which nets the analog switches' channels JOIN for one pass, read off the
 * levels on their control pins (`levels`, the previous pass's — as every chip
 * output is computed), each read as the part reads it (`read`, Spice Lite's
 * `hooks.input`: the pin's own voltage through its own thresholds, as its
 * sequential state is sampled — not the net's shown level, which is X where
 * two families' readers disagree). Only a POWERED switch conducts; `state` is the
 * per-part state map, read by the one channel part that keeps any (a
 * MOSFET's gate charge). Returns null when no channel conducts, else
 * `{ definite, readings }`, each reading a `{ on, hardOn }` pair of
 * `groupsOf` joins (`hardOn` minus the channels whose on-resistance limits an
 * LED's current: what the LED rule's resolution joins).
 *
 * `definite` closes only the channels that are certainly ON. A channel whose
 * control is UNKNOWN (floating, or fought over) might be either, so the
 * `readings` are every way those controls could read — each a real switch
 * position, so a mux with a floating select is never read as every channel
 * closed at once (two channels no select value joins, joined through COM).
 * The pass keeps the levels all readings agree on; with no unknown control
 * the one reading IS `definite`. With more, `maybeNets` names the channel
 * terminals whose joins differ between them (sim/incremental.js reads the
 * readings on those nets' components alone).
 *
 * `drivers` (this pass's, `driversFor`) lets the logic engine read a
 * SELF-FED transistor (`selfFedControls`) — one whose base or gate its own
 * channel would join to that channel; with `read` (Spice Lite, which reads
 * such a control off its solve) it is never needed. The controls it set are
 * returned as `forced` (controlKey → level), for the settle to publish its
 * channels by — and a biased transistor's (`biasedControls`) as `biased`
 * (compId → level), for the settle to publish and step it by.
 */
export function channelGroups(
  ctx,
  levels,
  state = new Map(),
  read = null,
  drivers = null,
) {
  const parts = ctx.chips.filter(
    (c) => c.analogSwitch && c.status === CHIP_STATUS.OK,
  );
  if (!parts.length) return null;
  // The pairs one reading joins: `overrides` sets controls (controlKey → H/L);
  // `unknown` collects the controls behind every channel that answered X.
  const pairsFor = (overrides, unknown) => {
    const on = [];
    const maybe = [];
    for (const c of parts) {
      const pinLevels = new Map();
      const rails = c.railReads;
      for (const [pin, net] of c.pinNet) {
        const level = net ? (rails?.get(net) ?? levels.get(net) ?? Z) : Z;
        pinLevels.set(pin, overrides?.get(controlKey(c, pin)) ?? biased?.get(c.comp.id) ?? (read ? read(c, pin, net, level) : level)); // prettier-ignore
      }
      const own = state.get(c.comp.id) ?? initialState(c.def);
      channelStates(c.def, pinLevels, own).forEach((ch, i) => {
        const a = c.pinNet.get(ch.a);
        const b = c.pinNet.get(ch.b);
        if (!a || !b || a === b || ch.on === L) return;
        const pair = {
          a,
          b,
          limited: c.limitsChannel,
          transistor: c.transistor,
          comp: c.comp.id,
        };
        if (ch.on === H) {
          on.push(pair);
          return;
        }
        maybe.push(pair);
        for (const pin of c.def.logic.channels[i].inputs) {
          const level = pinLevels.get(pin);
          if (level !== H && level !== L) unknown?.add(controlKey(c, pin));
        }
      });
    }
    return { on, maybe };
  };
  const reading = (pairs) => ({
    on: groupsOf(ctx, pairs),
    hardOn: groupsOf(
      ctx,
      pairs.filter((p) => !p.limited),
    ),
  });
  // A transistor's base or gate held only by resistors from fixed sources,
  // read by the divider's voltage against its emitter (`biasedControls`).
  const biased = read ? null : biasedControls(ctx, levels, drivers);
  let unknown = new Set();
  let base = pairsFor(null, unknown);
  const forced =
    !read && drivers ? selfFedControls(ctx, levels, drivers, base) : null;
  if (forced) {
    unknown = new Set();
    base = pairsFor(forced, unknown);
  }
  if (!base.on.length && !base.maybe.length) return null;
  const definite = reading(base.on);
  if (!base.maybe.length) return { definite, readings: [definite], forced, biased }; // prettier-ignore
  // `maybeNets`: the terminals of every channel some reading joins and the
  // certain one does not (or the other way round) — the only nets the
  // readings can resolve otherwise than `definite` does, so the incremental
  // settle reads them on those nets' components alone.
  const maybeNets = new Set();
  const certain = new Set(base.on.map((p) => `${p.comp}|${p.a}|${p.b}`));
  const differing = (pairs) => {
    const keys = new Set();
    for (const p of pairs) {
      const key = `${p.comp}|${p.a}|${p.b}`;
      keys.add(key);
      if (!certain.has(key)) maybeNets.add(p.a).add(p.b);
    }
    for (const p of base.on) {
      if (!keys.has(`${p.comp}|${p.a}|${p.b}`)) maybeNets.add(p.a).add(p.b);
    }
  };
  const keys = [...unknown];
  if (keys.length > MAX_UNKNOWN_CONTROLS) {
    differing([...base.on, ...base.maybe]);
    return {
      definite,
      readings: [definite, reading([...base.on, ...base.maybe])],
      maybeNets,
      forced,
      biased,
    };
  }
  const readings = [];
  for (let bits = 0; bits < 2 ** keys.length; bits++) {
    const overrides = new Map(forced ?? []);
    keys.forEach((key, i) => overrides.set(key, (bits >> i) & 1 ? H : L));
    // A channel still answering X with every unknown control set has a
    // reason of its own; it is closed, the conservative reading.
    const { on, maybe } = pairsFor(overrides, null);
    differing([...on, ...maybe]);
    readings.push(reading([...on, ...maybe]));
  }
  return { definite, readings, maybeNets, forced, biased };
}

/** How far a BJT's base must stand past its emitter to turn it on, volts —
    the silicon junction drop of the textbook (`biasedControls`). The logic
    abstraction's own: how far on it is is Spice Lite's question. (A
    MOSFET's gate turns it on past its Grade's own threshold, `vgsOn`.) */
const VBE_ON_V = 0.7;

/** A MOSFET's gate threshold, volts: its Grade's (a 2N7000's 2.1 V, an
    IRF540N's 3.63 — the TO-220 a MOSFET is placed as), as Spice Lite
    simulates it (spice/transistor-figures.js `transistorModelFor`). */
const vgsOn = (c) =>
  transistorModelFor(c.def.transistor.type, transistorGrade(c.def, c.comp.params), transistorCustom(c.def, c.comp.params)).vtoV; // prettier-ignore

/** Each context's `biasCandidates`. */
const BIASED = new WeakMap();

/**
 * The discrete transistors whose base or gate only resistors reach — no
 * diode, no channel end, no supply on that net, and not self-fed
 * (`selfFedCandidates`): `[{id, base, emitter, nType, onV, pulls: [{far,
 * siemens}]}]` (a MOSFET's gate as `base`, its source as `emitter`), every
 * resistor on the base with a known value and a far end of its own.
 */
function biasCandidates(ctx) {
  let found = BIASED.get(ctx);
  if (found) return found;
  found = [];
  const isSupply = (id) =>
    ctx.supplyPlusVolts.has(id) || ctx.supplyMinus.has(id);
  const ends = new Set();
  for (const c of ctx.chips) {
    if (!c.analogSwitch) continue;
    for (const ch of c.def.logic.channels) {
      for (const pin of [ch.a, ch.b]) {
        const net = c.pinNet.get(pin);
        if (net) ends.add(net);
      }
    }
  }
  for (const d of ctx.diodes) {
    if (d.anode) ends.add(d.anode);
    if (d.cathode) ends.add(d.cathode);
  }
  const selfFed = new Set(selfFedCandidates(ctx).map((t) => t.id));
  for (const c of ctx.chips) {
    const t = c.def.transistor;
    if (!t || c.status !== CHIP_STATUS.OK || selfFed.has(c.comp.id)) continue; // prettier-ignore
    const [ch] = c.def.logic.channels;
    const base = c.pinNet.get(ch.inputs[0]);
    const emitter = c.pinNet.get(ch.a);
    if (!base || !emitter || isSupply(base) || ends.has(base)) continue;
    const pulls = [];
    let whole = true;
    for (const r of ctx.resistors) {
      if (r.netA !== base && r.netB !== base) continue;
      const far = r.netA === base ? r.netB : r.netA;
      if (!far || far === base || !(r.siemens > 0)) whole = false;
      else pulls.push({ far, siemens: r.siemens });
    }
    if (!whole || !pulls.length) continue;
    const nType = t.type === "npn" || t.type === "nmos";
    // (Its channel's ends off the rails: an emitter on GND is no feedback —
    // read with it, any driver with a base pull-down to GND looked like a
    // flip-flop partner, and the read-through was off; the regrade.)
    const channel = [c.pinNet.get(ch.a), c.pinNet.get(ch.b)].filter((n) => n && !isSupply(n)); // prettier-ignore
    found.push({ id: c.comp.id, base, emitter, channel, nType, onV: t.holds ? vgsOn(c) : VBE_ON_V, pulls }); // prettier-ignore
  }
  BIASED.set(ctx, found);
  return found;
}

/** Each context's diode ends and analog-switch channel ends (`netParts`). */
const NET_PARTS = new WeakMap();

/** Every net a diode lead is on (`diodeEnds`), and the switches and
    transistors with a channel end on each net (`channelEnds`, net →
    chips) — what `biasedControls` reads a far end through. */
function netParts(ctx) {
  let parts = NET_PARTS.get(ctx);
  if (parts) return parts;
  const diodeEnds = new Set();
  for (const d of ctx.diodes) {
    if (d.anode) diodeEnds.add(d.anode);
    if (d.cathode) diodeEnds.add(d.cathode);
  }
  const channelEnds = new Map();
  for (const c of ctx.chips) {
    if (!c.analogSwitch) continue;
    for (const ch of c.def.logic.channels) {
      for (const pin of [ch.a, ch.b]) {
        const net = c.pinNet.get(pin);
        if (!net) continue;
        if (!channelEnds.has(net)) channelEnds.set(net, new Set());
        channelEnds.get(net).add(c);
      }
    }
  }
  parts = { diodeEnds, channelEnds };
  NET_PARTS.set(ctx, parts);
  return parts;
}

/** Each context's `biasedNets`. */
const BIASED_NETS = new WeakMap();

/**
 * Every net a biased transistor's reading (`biasedControls`) hears: its
 * base, its emitter and the far end of each resistor on its base. The incremental
 * settle reads the channels again when one of these moves.
 */
export function biasedNets(ctx) {
  let nets = BIASED_NETS.get(ctx);
  if (nets) return nets;
  nets = new Set();
  for (const t of biasCandidates(ctx)) {
    nets.add(t.base);
    nets.add(t.emitter);
    for (const p of t.pulls) {
      nets.add(p.far);
      // …and what a far end no source holds is read through: the far ends
      // of its own resistors, and the pins of the channels on it.
      for (const r of ctx.resistors) {
        if (r.netA === p.far && r.netB) nets.add(r.netB);
        else if (r.netB === p.far && r.netA) nets.add(r.netA);
      }
      for (const c of netParts(ctx).channelEnds.get(p.far) ?? []) {
        for (const net of c.pinNet.values()) if (net) nets.add(net);
      }
    }
    // …and the sources the emitter is read by (`biasedControls`).
    for (const r of ctx.resistors) {
      if (r.netA === t.emitter && r.netB) nets.add(r.netB);
      else if (r.netB === t.emitter && r.netA) nets.add(r.netA);
    }
    for (const d of ctx.diodes) if (d.cathode === t.emitter && d.anode) nets.add(d.anode); // prettier-ignore
  }
  BIASED_NETS.set(ctx, nets);
  return nets;
}

/**
 * The logic engine's reading of a transistor whose base only resistors from FIXED
 * sources reach — a rail, or a net a chip, clock or signal drives: the
 * voltage the divider holds the base at (each source at its supply's volts,
 * a driven HIGH at the desk's highest), against its emitter's (a rail's, or
 * its level's). Read at the base net's level, a divider is a level only past
 * two thirds of the way to one side (resolve.js `DIVIDER_SIDE`): 10 k/10 k
 * off 5 V read X and the switch stood OFF, silently, and 47 k/10 k read LOW,
 * where 2.5 V and 0.88 V both turn it on. On past `VBE_ON_V` — the base
 * reads its on level, else its off one. A MOSFET's gate likewise, against
 * its source, past its Grade's threshold (`vgsOn`): 10 k/10 k read X, and
 * its gate held whatever it last was. The emitter (or source) is read off
 * fixed sources too — a rail, what drives it, the fixed sources its
 * resistors and diodes reach — never at its level: a follower's is the HIGH
 * its own channel lifts it to, which turned it off, its emitter fell, it
 * turned on again — X and an oscillation every pass where the bench has it
 * on (the regrade, 2026-10-23). Returns compId → level, or null; one whose
 * base or gate something drives, whose emitter or source no fixed source
 * holds, or whose base a source only pulled reaches, reads as every control
 * does.
 */
function biasedControls(ctx, levels, drivers) {
  const candidates = biasCandidates(ctx);
  if (!candidates.length) return null;
  let top = 0;
  for (const volts of ctx.supplyPlusVolts.values()) top = Math.max(top, ...volts); // prettier-ignore
  // A fixed source's volts: a rail's, or a driven net's at its level.
  const sourceVolts = (net) => {
    if (ctx.supplyPlusVolts.has(net)) return Math.max(...ctx.supplyPlusVolts.get(net)); // prettier-ignore
    if (ctx.supplyMinus.has(net)) return 0;
    const level = levels.get(net);
    if (level !== H && level !== L) return null;
    if (!(drivers?.get(net) ?? []).includes(level)) return null;
    return level === H ? top : 0;
  };
  /** The emitter as its fixed sources hold it, volts, or null. */
  const emitterVolts = (net) => {
    const fixed = sourceVolts(net);
    if (fixed != null) return fixed;
    const pullLevels = [];
    for (const r of ctx.resistors) {
      const far = r.netA === net ? r.netB : r.netB === net ? r.netA : null;
      const v = far && far !== net ? sourceVolts(far) : null;
      if (v != null) pullLevels.push({ level: v > 0 ? H : L, siemens: r.siemens }); // prettier-ignore
    }
    for (const d of ctx.diodes) {
      if (d.cathode === net && d.anode && sourceVolts(d.anode) > 0) pullLevels.push(H); // prettier-ignore
    }
    const { level } = resolveNet({ supplyPlus: false, supplyMinus: false, chipLevels: drivers?.get(net) ?? [], pullLevels }); // prettier-ignore
    return level === H ? top : level === L ? 0 : null;
  };
  let out = null;
  /** A far end no fixed source holds, read through what does: the
      resistors from it to fixed sources, as one source behind their
      parallel resistance — `{v, ohms}` — where nothing drives it, no diode
      is on it and every channel on it is OFF (a collector pulled up while
      its transistor is off); else null. One step out: a resistor from it
      to another such net is no source. */
  const byId = new Map(candidates.map((t) => [t.id, t]));
  const throughNet = (net, t) => {
    const base = t.base;
    if ((drivers?.get(net) ?? []).some((level) => level !== Z)) return null;
    const { diodeEnds, channelEnds } = netParts(ctx);
    if (diodeEnds.has(net)) return null;
    // …and the last pass left it HIGH: a channel the base's own reading
    // says is off may be one this pass reads ON (its base, too, read
    // through) — a ring of five RTL inverters read every other stage on,
    // a LOW collector into an ON neighbour, settled (the regrade).
    if (levels.get(net) !== H) return null;
    for (const c of channelEnds.get(net) ?? []) {
      // A transistor this one's own channel feeds the base of — two
      // switching each other, a flip-flop — is a loop the tie-break settles
      // (`solve`), the same way round as Spice Lite falls; read through
      // whenever it could be, the pair came up the other way. So only a
      // base its divider leaves X is read through it, and only while the
      // last pass left that collector HIGH: with 10 k base pull-downs both
      // bases stood X, both transistors OFF, silent (the regrade,
      // 2026-10-23).
      const other = byId.get(c.comp.id);
      if (other?.pulls.some((p) => t.channel.includes(p.far))) {
        if (levels.get(base) !== X) return null;
        continue;
      }
      const pinLevels = new Map();
      for (const [pin, n] of c.pinNet) pinLevels.set(pin, out?.get(c.comp.id) ?? (n ? (levels.get(n) ?? Z) : Z)); // prettier-ignore
      const states = channelStates(c.def, pinLevels, initialState(c.def));
      if (states.some((ch) => ch.on !== L && (c.pinNet.get(ch.a) === net || c.pinNet.get(ch.b) === net))) return null; // prettier-ignore
    }
    let g = 0;
    let gv = 0;
    for (const r of ctx.resistors) {
      const far = r.netA === net ? r.netB : r.netB === net ? r.netA : null;
      if (!far || far === base) continue;
      const v = far === net ? null : sourceVolts(far);
      if (v == null || !(r.siemens > 0)) return null;
      g += r.siemens;
      gv += r.siemens * v;
    }
    return g > 0 ? { v: gv / g, ohms: 1 / g } : null;
  };
  for (const t of candidates) {
    if ((drivers?.get(t.base) ?? []).some((level) => level !== Z)) continue;
    const ve = emitterVolts(t.emitter);
    if (ve == null) continue;
    let g = 0;
    let gv = 0;
    for (const p of t.pulls) {
      let v = sourceVolts(p.far);
      let siemens = p.siemens;
      // (Read at the far end's level, a base fed from a pulled-up
      // collector stood X or LOW: 1 k up, 10 k across, 10 k down puts
      // 2.4 V on it, and the second transistor stayed off — RTL; the
      // grade, 2026-10-23.)
      if (v == null) {
        const th = throughNet(p.far, t);
        if (th) {
          v = th.v;
          siemens = 1 / (1 / p.siemens + th.ohms);
        }
      }
      if (v == null) {
        g = 0;
        break;
      }
      g += siemens;
      gv += siemens * v;
    }
    if (!(g > 0)) continue;
    const vb = gv / g;
    const on = t.nType ? vb - ve > t.onV : ve - vb > t.onV;
    out ??= new Map();
    out.set(t.id, on === t.nType ? H : L);
  }
  return out;
}

/** Each context's discrete transistors that could feed themselves
    (`selfFedCandidates`). */
const SELF_FED = new WeakMap();

/**
 * The discrete transistors whose base or gate their OWN channel could join to
 * that channel — tied straight to its collector (diode-connected, a mirror's
 * reference) or reaching it through other channels (a Darlington's second
 * transistor, its base on the first one's emitter and the two collectors
 * tied): `[{id, key, control, a, b}]`, `key` its control's controlKey. Every
 * other channel counts, on or off; a rail joins nothing (`groupsOf`).
 */
function selfFedCandidates(ctx) {
  let found = SELF_FED.get(ctx);
  if (found) return found;
  found = [];
  const isSupply = (id) =>
    ctx.supplyPlusVolts.has(id) || ctx.supplyMinus.has(id);
  const channels = [];
  for (const c of ctx.chips) {
    if (!c.analogSwitch) continue;
    for (const ch of c.def.logic.channels) {
      channels.push({ id: c.comp.id, a: c.pinNet.get(ch.a), b: c.pinNet.get(ch.b) }); // prettier-ignore
    }
  }
  for (const c of ctx.chips) {
    if (!c.def.transistor) continue;
    const [ch] = c.def.logic.channels;
    const pin = ch.inputs[0];
    const control = c.pinNet.get(pin);
    const a = c.pinNet.get(ch.a);
    const b = c.pinNet.get(ch.b);
    if (!control || !a || !b || isSupply(control)) continue;
    const uf = new UnionFind();
    uf.add(control);
    for (const o of channels) {
      if (o.id === c.comp.id || !o.a || !o.b) continue;
      if (isSupply(o.a) || isSupply(o.b)) continue;
      uf.union(o.a, o.b);
    }
    const reaches = (end) =>
      end === control || (!isSupply(end) && uf.find(end) === uf.find(control)); // prettier-ignore
    if (reaches(a) || reaches(b)) {
      found.push({ id: c.comp.id, key: controlKey(c, pin), control, a, b });
    }
  }
  SELF_FED.set(ctx, found);
  return found;
}

/** Each context's `selfFedNets`. */
const SELF_FED_NETS = new WeakMap();

/**
 * Every net a self-fed transistor's reading (`selfFedControls`) can hear:
 * its control and whatever any channel could join to it, and what a resistor
 * or a diode feeds into those. The incremental settle reads the channels again
 * when one of these moves — its level or its drivers — since such a control
 * can turn with no change on its own net (it sits LOW while its transistor
 * conducts, whatever pulls it up).
 */
export function selfFedNets(ctx) {
  let nets = SELF_FED_NETS.get(ctx);
  if (nets) return nets;
  nets = new Set();
  const candidates = selfFedCandidates(ctx);
  if (candidates.length) {
    const isSupply = (id) =>
      ctx.supplyPlusVolts.has(id) || ctx.supplyMinus.has(id);
    const uf = new UnionFind();
    for (const c of ctx.chips) {
      if (!c.analogSwitch) continue;
      for (const ch of c.def.logic.channels) {
        const [a, b] = [c.pinNet.get(ch.a), c.pinNet.get(ch.b)];
        if (a && b && !isSupply(a) && !isSupply(b)) uf.union(a, b);
      }
    }
    const roots = new Set(candidates.map((t) => uf.find(t.control)));
    for (const id of ctx.netIds) {
      if (!isSupply(id) && roots.has(uf.find(id))) nets.add(id);
    }
    for (const r of ctx.resistors) {
      if (nets.has(r.netA) && r.netB) nets.add(r.netB);
      else if (nets.has(r.netB) && r.netA) nets.add(r.netA);
    }
    for (const d of ctx.diodes) if (nets.has(d.cathode)) nets.add(d.anode);
  }
  SELF_FED_NETS.set(ctx, nets);
  return nets;
}

/**
 * The logic engine's reading of a SELF-FED transistor's control: its control
 * net as it resolves WITHOUT the transistor's own channel. Read at its net's
 * level, it has no answer at all as a switch: on, its channel joins its base
 * to its emitter's LOW and turns it off; off, the base is pulled HIGH again
 * and turns it on — every pass to the iteration cap, X and an oscillation
 * (a diode-connected transistor, a Darlington of two discretes). On the bench
 * it conducts, its base a junction drop above its emitter: what pulls the
 * base up with the transistor out of the way is what turns it on. Resolved
 * from this pass's drivers across the other channels' joins (`base`, the
 * pairs read off `levels`), the resistors' pulls taken from `levels`. Only
 * where its own channel WOULD join the base to itself — anywhere else its
 * control reads as every other does. Returns controlKey → level, or null.
 */
function selfFedControls(ctx, levels, drivers, base) {
  const candidates = selfFedCandidates(ctx);
  if (!candidates.length) return null;
  const all = [...base.on, ...base.maybe];
  const pulls = new Map();
  const addPull = (net, level, siemens = null) => {
    if (!net || (level !== H && level !== L)) return;
    if (!pulls.has(net)) pulls.set(net, []);
    pulls.get(net).push(siemens == null ? level : { level, siemens });
  };
  for (const r of ctx.resistors) {
    addPull(r.netA, levels.get(r.netB), r.siemens);
    addPull(r.netB, levels.get(r.netA), r.siemens);
  }
  for (const d of ctx.diodes) {
    if (feedsCathode(ctx, d) && levels.get(d.anode) === H) addPull(d.cathode, H); // prettier-ignore
  }
  const pullsOf = (net) => pulls.get(net) ?? [];
  let forced = null;
  for (const t of candidates) {
    const others = all.filter((p) => p.comp !== t.id);
    const groups = groupsOf(ctx, others);
    const members = groups?.byNet.get(t.control)?.members;
    const fed =
      t.control === t.a ||
      t.control === t.b ||
      Boolean(members?.includes(t.a) || members?.includes(t.b));
    if (!fed) continue;
    const { level } = resolveIn(ctx, drivers, groups, t.control, pullsOf);
    if (level !== H && level !== L) continue;
    forced ??= new Map();
    forced.set(t.key, level);
  }
  return forced;
}

/**
 * Net pairs → the joined groups: `{ byNet, all }`, `byNet` netId → its
 * group, `all` every group. A group is `{ members, via }` — its member nets
 * (one shared record per group) and whether a transistor's channel is among
 * its joins ("transistor") or only switches' ("switch").
 *
 * A SUPPLY net is never a union point. It is stiff: a net a channel joins to
 * a rail hears the rail (at output strength), but two nets each joined to the
 * same rail are not thereby joined to each other — a fight on one stays on
 * that one. So a rail is a MEMBER of each group that touches it (never a key:
 * it resolves as itself), and a channel straight between two rails is a group
 * of its own, there to be reported as the short it is.
 */
export function groupsOf(ctx, pairs) {
  if (!pairs.length) return null;
  const isSupply = (id) =>
    ctx.supplyPlusVolts.has(id) || ctx.supplyMinus.has(id);
  const uf = new UnionFind();
  const rails = new Map(); // net → the supply nets channels join it to
  const all = [];
  for (const p of pairs) {
    const railA = isSupply(p.a);
    const railB = isSupply(p.b);
    if (railA && railB) {
      all.push({
        members: [p.a, p.b],
        via: p.transistor ? "transistor" : "switch",
      });
    } else if (railA || railB) {
      const [net, rail] = railA ? [p.b, p.a] : [p.a, p.b];
      uf.add(net);
      if (!rails.has(net)) rails.set(net, new Set());
      rails.get(net).add(rail);
    } else {
      uf.union(p.a, p.b);
    }
  }
  const viaTransistor = new Set(
    pairs
      .filter((p) => p.transistor)
      .map((p) => (isSupply(p.a) ? p.b : p.a))
      .filter((id) => !isSupply(id))
      .map((id) => uf.find(id)),
  );
  const byNet = new Map();
  for (const [root, members] of uf.groups()) {
    const supplies = new Set();
    for (const id of members) {
      for (const rail of rails.get(id) ?? []) supplies.add(rail);
    }
    const group = {
      members: [...members, ...supplies],
      via: viaTransistor.has(root) ? "transistor" : "switch",
    };
    all.push(group);
    for (const id of members) byNet.set(id, group);
  }
  return { byNet, all };
}

/** Two candidate level maps → what they agree on, X where they differ. */
export function agreeing(a, b) {
  const out = new Map();
  for (const [id, lv] of a) out.set(id, b.get(id) === lv ? lv : X);
  return out;
}

/**
 * Resolve ONE net from supplies + `drivers` (+ the pulls `pullsOf` names),
 * across the channels `groups` joins (`groupsOf`; null for none). A joined
 * net hears every member's drivers and pulls — but a member RAIL only as its
 * supply, at OUTPUT strength: it arrives through a switch, so a rail through
 * a 4066 FIGHTS an output on the far side (a conflict there), where the same
 * rail wired straight on would simply win. (Whatever else sits on a rail is
 * overruled by it, so it travels no further.)
 */
export function resolveIn(ctx, drivers, groups, id, pullsOf) {
  const group = groups?.byNet.get(id);
  if (!group) {
    return resolveNet({
      supplyPlus: ctx.supplyPlusVolts.has(id),
      supplyMinus: ctx.supplyMinus.has(id),
      chipLevels: drivers.get(id) ?? [],
      pullLevels: pullsOf(id),
    });
  }
  const chipLevels = [];
  const pullLevels = [];
  for (const member of group.members) {
    if (ctx.supplyPlusVolts.has(member)) chipLevels.push(H);
    else if (ctx.supplyMinus.has(member)) chipLevels.push(L);
    else {
      chipLevels.push(...(drivers.get(member) ?? []));
      pullLevels.push(...pullsOf(member));
    }
  }
  return resolveNet({
    supplyPlus: ctx.supplyPlusVolts.has(id),
    supplyMinus: ctx.supplyMinus.has(id),
    chipLevels,
    pullLevels,
  });
}

export const noPulls = () => [];

/** Does a diode whose anode net reads `level` pass a HIGH on? In the WIDE
    reading an unknown anode might be HIGH, so it does. */
const passesHigh = (level, wide) => level === H || (wide && level === X);

/**
 * Does a diode feed anything at all into its cathode net? Not when that net
 * is a supply's: the rail decides its own level, and a HIGH added to it
 * would only travel on — through a transistor or a switch joined to the
 * rail — as a driver the rail itself overrules. (One forward into ground is
 * burning, which the LED rule's levels still say: its anode is strongly HIGH,
 * its cathode the rail's LOW.)
 */
export const feedsCathode = (ctx, d) =>
  !ctx.supplyPlusVolts.has(d.cathode) && !ctx.supplyMinus.has(d.cathode);

/**
 * `drivers` plus `extra` (netId → how many diodes drive a HIGH onto it), as a
 * view with the one method every reader of a driver map uses (`get`) — not a
 * copy of the whole map: a scoped resolve (`resolveAll`'s `scope`) touches a
 * handful of nets, and copying hundreds of others per round would cost what
 * the scope saves.
 */
function withExtraHighs(drivers, extra, lows = null) {
  if (!extra.size && !lows?.size) return drivers;
  return {
    get: (net) =>
      extra.has(net) || lows?.has(net)
        ? [...(drivers.get(net) ?? []), ...Array(extra.get(net) ?? 0).fill(H), ...(lows?.get(net) ?? "")] // prettier-ignore
        : drivers.get(net),
  };
}

/** Does a diode whose cathode net reads `level` pull its anode LOW? In the
    WIDE reading an unknown cathode might be LOW, so it does. */
const passesLow = (level, wide) => level === L || (wide && level === X);

const FED = new WeakMap();

/**
 * The nets something pushes current INTO — so that a diode from one to a
 * LOW conducts and holds it a drop above it, a LOW: a resistor's end (a
 * pull-up), or a TTL input (it sources its own 1.6 mA). A net with only a
 * CMOS input on it floats, whatever the diode's cathode does. Once per
 * context.
 */
function fedNets(ctx) {
  let fed = FED.get(ctx);
  if (fed) return fed;
  fed = new Set();
  for (const r of ctx.resistors) {
    if (r.netA) fed.add(r.netA);
    if (r.netB) fed.add(r.netB);
  }
  for (const c of ctx.chips) {
    if (c.status !== CHIP_STATUS.OK || floatsUnknown(c.def)) continue;
    for (const p of c.def.pins ?? []) {
      if (p.role !== "input" && p.role !== "io") continue;
      const net = c.pinNet.get(p.n);
      if (net) fed.add(net);
    }
  }
  FED.set(ctx, fed);
  return fed;
}

/**
 * The nets a diode pulls DOWN at output strength (netId → how many): every
 * anode whose cathode is LOW — a − rail, an output's LOW, a channel to one —
 * and that something feeds (`fedNets`), or an output drives HIGH into a −
 * rail (an output's HIGH into anything else passes on as a HIGH, and the
 * fight is said at the cathode, as it always was). That is a
 * diode-AND (the anode pulled up, any cathode LOW takes it down, a drop
 * above the LOW it reads as one) and a diode-isolated wired-AND; against an
 * output's HIGH it is that output shorted through the diode, a fight, said
 * as one (`conflict`). A diode only ever passed a HIGH, so a diode-AND read
 * HIGH whatever its inputs (the regrade, 2026-10-22). The LOW must be the
 * cathode's own — a − rail, or an output's — never one a diode pulled it
 * to: two drops up is not a LOW. A diode across the rails is the supply's
 * own business, and is left out.
 */
function diodeLows(ctx, drivers, diodes, levels, wide, prior) {
  const fed = fedNets(ctx);
  const lows = new Map(); // anode → the levels its diodes add ("L", "X")
  const depth = new Map(); // anode → how many drops above a LOW it stands
  for (const d of diodes) {
    if (!d.anode || ctx.supplyMinus.has(d.anode) || ctx.supplyPlusVolts.has(d.anode)) continue; // prettier-ignore
    // A + rail is never a LOW cathode, whatever drives it: an output's LOW
    // on it is a fight the rail wins (said there). Counted as one it pulled
    // the anode LOW — and the incremental settle, whose components never
    // join a rail, did not read the anode again when that output let go
    // (the 2026-10-26 review). A rail that is both — the supplies shorted —
    // is a − rail still, as it is to the cathode's `own` LOW below.
    if (ctx.supplyPlusVolts.has(d.cathode) && !ctx.supplyMinus.has(d.cathode)) continue; // prettier-ignore
    const own = ctx.supplyMinus.has(d.cathode) || (drivers.get(d.cathode) ?? []).includes(L); // prettier-ignore
    // (A cathode a chain holds drops up is low enough to count, whatever
    // its readers make of it: it reads X, but it is no HIGH.)
    const low = own || passesLow(levels?.get(d.cathode), wide) || prior.depth.has(d.cathode); // prettier-ignore
    if (!low) continue;
    // An output's HIGH on the anode passes on to a cathode that is no rail,
    // and the fight is said there; into a − rail it can go no further.
    const driven = (drivers.get(d.anode) ?? []).includes(H);
    if (driven ? !ctx.supplyMinus.has(d.cathode) : !fed.has(d.anode)) continue;
    // Drops counted from the cathode's own LOW: one a diode pulled down is
    // one more drop up.
    const drops = (own ? 0 : (prior.depth.get(d.cathode) ?? 0)) + 1;
    depth.set(d.anode, Math.min(depth.get(d.anode) ?? Infinity, drops));
    lows.set(d.anode, (lows.get(d.anode) ?? "") + L);
  }
  // A chain's later anodes stand drops up: a LOW to what reads them only
  // where each reader takes that many drops as one (`readsLowAt`), else X.
  for (const [anode, drops] of depth) {
    if (drops > 1 && !readsLowAt(ctx, anode, drops)) lows.set(anode, X.repeat(lows.get(anode).length)); // prettier-ignore
  }
  return { lows, depth };
}

const NONE = new Set();

/** A diode's forward drop as the logic engine counts drops, volts. */
const DIODE_DROP_V = 0.7;

const READERS = new WeakMap();

/**
 * Whether every input on `net` reads `drops` diode drops over ground as
 * LOW: a TTL one (or any family-less part) up to its VIL, 0.8 V — one drop;
 * a CMOS one up to 30 % of its supply — two drops at 5 V, five at 12 (the
 * regrade, 2026-10-22: two drops was never a LOW, where a CD4069 at 12 V
 * reads 1.3 V as one). A net nothing reads passes it on.
 */
function readsLowAt(ctx, net, drops) {
  let readers = READERS.get(ctx);
  if (!readers) {
    readers = new Map();
    for (const c of ctx.chips) {
      if (c.status !== CHIP_STATUS.OK) continue;
      const cmos = floatsUnknown(c.def);
      for (const p of c.def.pins ?? []) {
        if (p.role !== "input" && p.role !== "io") continue;
        const at = c.pinNet.get(p.n);
        if (!at) continue;
        if (!readers.has(at)) readers.set(at, []);
        readers.get(at).push(cmos ? 0.3 * (c.supplyVolts ?? 5) : 0.8);
      }
    }
    READERS.set(ctx, readers);
  }
  const v = drops * DIODE_DROP_V;
  return (readers.get(net) ?? []).every((vil) => v <= vil);
}

/**
 * The DIODES' strong drive for one pass: every diode whose anode net is
 * STRONGLY HIGH — from a supply or an output, never a pull — drives its
 * cathode net HIGH at output strength, and every one whose cathode is LOW
 * pulls a fed anode LOW (`diodeLows`), to a fixpoint (a chain of diodes
 * passes a HIGH down it, one diode a round). It starts from no diode driving
 * at all and settles within one round per diode (capped there).
 *
 * Returns the drivers with every diode's HIGH and LOW added, and the strong
 * levels they resolve to — or `levels: null` when there are no diodes, so a
 * desk without one pays nothing. `scope` (see `resolveAll`) limits it to some
 * nets and the diodes among them; the round cap stays the desk's.
 */
function diodeDrive(ctx, drivers, groups, wide, scope = null) {
  if (!ctx.diodes.length) return { drivers, levels: null, notHigh: NONE };
  const { netIds, diodes } = scope ?? ctx;
  let low = diodeLows(ctx, drivers, diodes, null, wide, { depth: new Map() });
  let lows = low.lows;
  // An anode a chain holds drops up is X to its readers, but no HIGH: it
  // passes none on, in any reading.
  const notHighOf = (m) => new Set([...m].filter(([, v]) => v.includes(X)).map(([k]) => k)); // prettier-ignore
  let notHigh = notHighOf(lows);
  let extra = new Map();
  let merged = withExtraHighs(drivers, extra, lows);
  let levels = null;
  for (let round = 0; round <= ctx.diodes.length; round++) {
    levels = new Map();
    for (const id of netIds) {
      levels.set(id, resolveIn(ctx, merged, groups, id, noPulls).level);
    }
    const next = new Map();
    for (const d of diodes) {
      if (!feedsCathode(ctx, d) || notHigh.has(d.anode) || !passesHigh(levels.get(d.anode), wide)) continue; // prettier-ignore
      next.set(d.cathode, (next.get(d.cathode) ?? 0) + 1);
    }
    const nextLow = diodeLows(ctx, drivers, diodes, levels, wide, low);
    if (mapsEqual(next, extra) && mapsEqual(nextLow.lows, lows)) break;
    extra = next;
    low = nextLow;
    lows = low.lows;
    notHigh = notHighOf(lows);
    merged = withExtraHighs(drivers, extra, lows);
  }
  return { drivers: merged, levels, notHigh };
}

/** The conductance a net's HIGH pulls reach it through, summed — null
    where one of them has none known, or none pulls it HIGH. */
function highSiemens(list) {
  let g = 0;
  for (const pull of list ?? []) {
    if ((pull.level ?? pull) !== H) continue;
    if (!(pull.siemens > 0)) return null;
    g += pull.siemens;
  }
  return g > 0 ? g : null;
}

/**
 * The nets a resistor pull can change the resolution of, for one set of
 * channel joins: each resistor's two ends, each diode's cathode (where a pull
 * is all a merely-pulled anode passes on), and every net joined to one of
 * those through a channel — a joined net hears its members' pulls too
 * (`resolveIn`). Every other net resolves exactly as it does with no pulls at
 * all, so the resistor relaxation need not resolve it again.
 */
function pullReach(ctx, groups, scope = null) {
  const { resistors, diodes } = scope ?? ctx;
  const reach = new Set();
  for (const r of resistors) {
    if (r.netA) reach.add(r.netA);
    if (r.netB) reach.add(r.netB);
  }
  for (const d of diodes) {
    if (d.cathode && feedsCathode(ctx, d)) reach.add(d.cathode);
  }
  if (groups) {
    for (const id of [...reach]) {
      for (const m of groups.byNet.get(id)?.members ?? []) reach.add(m);
    }
  }
  return reach;
}

/**
 * Resolve every net once (`resolveIn`) from supplies + the given drivers +
 * resistor pulls, across the channels `groups` joins, with every diode passing
 * its anode's HIGH on (`diodeDrive` for the strong half; the resistor
 * relaxation below for a HIGH that only arrived by a pull). A channel joining
 * the two rails themselves is a short through the switch, and said so.
 *
 * `burn` (null when no part limits an LED's current) is the `{drivers,
 * groups}` the LED rule's resolution reads instead: the drivers and joins
 * that could burn one (`driversFor`'s `hard`, `channelGroups`' `hardOn`).
 *
 * `wide` is the reading where an UNKNOWN anode passes its HIGH too. The
 * narrow reading reports `uncertain` when any anode was unknown, so the
 * caller resolves both and keeps what they agree on — as it does for a
 * channel that might be on.
 *
 * `scope` (`{netIds, resistors, diodes}`, null for the whole desk) resolves
 * only those nets, with only those resistors and diodes — the incremental
 * settle's way of re-resolving the few nets a pass changed (sim/incremental.js).
 * It is exact when the scope is closed: every net a resistor, a diode or a
 * possible channel join couples to one of its nets is in it, or is a rail
 * (sim/settle-index.js builds such scopes). Every FLAG and CAP stays the
 * desk's — whether there are resistors or diodes at all, the diode rounds,
 * the relaxation's passes — so a scoped net takes exactly the code path, and
 * exactly the number of relaxation passes, it takes in a whole-desk resolve:
 * that count is what a pull loop that never settles (VCC–R–A–R–B–R–GND
 * alternates) ends on. A scoped resolve says nothing of the group shorts,
 * which belong to the whole desk (`groupShorts`). `netWarnings` is
 * `warnings` without them.
 */
export function resolveAll(
  ctx,
  drivers,
  groups = null,
  burn = null,
  wide = false,
  scope = null,
) {
  const { netIds, resistors, diodes } = scope ?? ctx;
  const firm = diodeDrive(ctx, drivers, groups, wide, scope);
  const all = firm.drivers;
  const resolveOne = (id, pullsOf) => resolveIn(ctx, all, groups, id, pullsOf);

  // With resistors present, first compute each net's STRONG level (supplies +
  // chip outputs + the diodes they feed, no pulls) — that's what a resistor
  // conducts, and (unless a part limits an LED's current — `burn`) it's also
  // what callers use to tell "driven directly" from "fed through a resistor"
  // (a lit LED vs. a burnt one), so it must never itself include a pull.
  let pulls = null;
  let strong = firm.levels;
  // Only the nets a pull can reach (`pullReach`) are resolved again by the
  // relaxation and the final pass; every other net keeps its no-pulls
  // resolution (`plainRes`), which is exactly what resolving it with pulls
  // would give. On a desk where a resistor touches a few nets of hundreds,
  // that was most of the engine's time (make bench).
  let plainRes = null;
  let reach = null;
  let reached = null;
  if (ctx.resistors.length) {
    plainRes = new Map();
    const plain = new Map();
    for (const id of netIds) {
      const res = resolveOne(id, noPulls);
      plainRes.set(id, res);
      plain.set(id, res.level);
    }
    if (!strong) strong = plain;
    reach = [...pullReach(ctx, groups, scope)].filter((id) => plain.has(id));
    reached = new Set(reach);

    // Relax the resistor network to a fixpoint: a net one resistor just
    // pulled to H/L can itself feed the NEXT resistor down the chain (R1
    // pulling netMid, netMid's own resistor R2 pulling netFar, and so on) —
    // a single pass off the bare `strong` levels only ever sees one hop.
    // `basis` starts at the strong levels and is refined each pass; a
    // resistor chain of N resistors fully propagates in at most N passes. A
    // diode whose anode is only PULLED high passes that on as a pull — the
    // resistor still limits it — so it is a link in the same chain.
    //
    // After the first pass the basis is the plain levels with the reached
    // nets' overlaid (`relaxed`) — an unreached net cannot move, so neither
    // the copy nor the comparison need visit it.
    let relaxed = null; // reached net → level; null on the first pass
    const basisOf = (id) =>
      relaxed?.has(id) ? relaxed.get(id) : (relaxed ? plain : strong).get(id);
    const links = ctx.resistors.length + ctx.diodes.length;
    for (let pass = 0; pass <= links; pass++) {
      const p = new Map(); // netId → [levels]
      const addPull = (net, level, siemens = null) => {
        // (An X pulls too: an unknown level through a resistor is unknown.)
        if (!net || (level !== H && level !== L && level !== X)) return;
        if (!p.has(net)) p.set(net, []);
        p.get(net).push(siemens == null ? level : { level, siemens });
      };
      for (const r of resistors) {
        addPull(r.netA, basisOf(r.netB), r.siemens);
        addPull(r.netB, basisOf(r.netA), r.siemens);
      }
      for (const d of diodes) {
        if (
          feedsCathode(ctx, d) &&
          !firm.notHigh.has(d.anode) &&
          passesHigh(basisOf(d.anode), wide)
        ) {
          // Through what pulls its anode up (last pass's), so a divider
          // past it weighs it too — a DTL gate's 4.7 k through two diodes
          // against its base's 10 k to ground.
          addPull(d.cathode, H, highSiemens(pulls?.get(d.anode)));
        }
      }
      const next = new Map();
      for (const id of reach) {
        next.set(id, resolveOne(id, (net) => p.get(net) ?? []).level);
      }
      pulls = p;
      // Settled when nothing moved: every reached net as the basis had it,
      // and — the first pass only, whose basis is the diodes' strong levels
      // rather than the plain ones — every unreached net too.
      const settled =
        reach.every((id) => next.get(id) === basisOf(id)) &&
        (relaxed || strong === plain || netIds.every((id) => reached.has(id) || plain.get(id) === strong.get(id))); // prettier-ignore
      if (settled) break;
      relaxed = next;
    }
  }

  const next = new Map();
  const warnings = [];
  // A joined group's fight is ONE fight, whichever member nets report it.
  const said = new Map(); // warning type → the groups it was said for
  for (const id of netIds) {
    const res =
      reached && !reached.has(id)
        ? plainRes.get(id)
        : resolveOne(id, (net) => pulls?.get(net) ?? []);
    next.set(id, res.level);
    if (!res.warning) continue;
    const group = groups?.byNet.get(id);
    if (group) {
      if (!said.has(res.warning)) said.set(res.warning, new Set());
      if (said.get(res.warning).has(group)) continue;
      said.get(res.warning).add(group);
    }
    warnings.push({ type: res.warning, net: id });
  }
  const netWarnings = scope ? warnings : [...warnings];
  if (!scope) warnings.push(...groupShorts(ctx, groups));
  // What the LED rule reads (sim/junction.js): the level each net would have
  // from the sources that can burn an LED. Without a limiting part that is
  // the strong level — and without resistors nothing is weakly pulled, so
  // the resolved level IS the strong one. With one, it is resolved again
  // from the hard drivers across the hard joins (diodes passing what THOSE
  // give them): a CD4000 output, or a channel, that limits the current is no
  // more a burn than a resistor is.
  let burning = strong ?? next;
  if (burn) {
    const hard = diodeDrive(ctx, burn.drivers, burn.groups, wide, scope);
    burning =
      hard.levels ??
      new Map(
        netIds.map((id) => [
          id,
          resolveIn(ctx, burn.drivers, burn.groups, id, noPulls).level,
        ]),
      );
  }
  // An unknown anode passed nothing in this reading — it might have passed a
  // HIGH, so the caller has to try that too.
  const uncertain = !wide && diodes.some((d) => (next.get(d.anode) === X && !firm.notHigh.has(d.anode)) || (next.get(d.cathode) === X && fedNets(ctx).has(d.anode))); // prettier-ignore
  return { next, warnings, netWarnings, strong: burning, uncertain };
}

/** The shorts a set of channel joins makes: each group holding both a `+`
    rail and a `−` rail, said once, on its `+` rail. */
export function groupShorts(ctx, groups) {
  const out = [];
  for (const { members, via } of groups?.all ?? []) {
    const plus = members.find((id) => ctx.supplyPlusVolts.has(id));
    if (plus && members.some((id) => ctx.supplyMinus.has(id))) {
      out.push({ type: "short", net: plus, via });
    }
  }
  return out;
}

/**
 * One pass's resolution of every net, for a set of drivers and channel
 * joins: each way the channels could be set (`channelGroups`), and for each a
 * diode whose anode MIGHT be HIGH tried both ways — keeping only what every
 * reading agrees on. The warnings are the certain channels' alone. Returns
 * `{definite, next, strong, warnings}`, `definite` the certain channels'
 * narrow reading (`resolveAll`'s answer). The full settle runs this every
 * pass; the incremental one whenever it cannot resolve a pass piecemeal.
 */
export function resolveReadings(ctx, drivers, hard, channels) {
  const burn = (joins) =>
    ctx.limitsLed ? { drivers: hard, groups: joins ?? null } : null;
  const readingOf = (r, wide = false) =>
    resolveAll(ctx, drivers, r?.on ?? null, burn(r?.hardOn), wide);
  const definite = readingOf(channels?.definite);
  let next = null;
  let strong = null;
  for (const r of channels?.readings ?? [null]) {
    const narrow = r === (channels?.definite ?? null) ? definite : readingOf(r);
    const tried = narrow.uncertain ? [narrow, readingOf(r, true)] : [narrow];
    for (const t of tried) {
      next = next ? agreeing(next, t.next) : t.next;
      strong = strong ? agreeing(strong, t.strong) : t.strong;
    }
  }
  return { definite, next, strong, warnings: definite.warnings };
}
