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
  initialState,
  channelStates,
  memoryOutputs,
} from "./chip-eval.js";
import { resolveNet } from "./resolve.js";
import { UnionFind } from "./union-find.js";
import { CHIP_STATUS } from "./chip-status.js";

/** Two maps with the same keys and values. */
export function mapsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * One powered, non-switch chip's own outputs for a set of net levels — before
 * Spice Lite's `outputs` hook holds any back. Its pins are read as the chip
 * reads them (`hooks.input`); a memory reads its image, a sequential chip its
 * state (a WATCHED one is told to the observer), a can its clock phase, and
 * anything else is evaluated from its logic units. The map is never mutated
 * afterwards, by anyone: it may be handed out again unchanged.
 */
export function chipOutputs(
  c,
  levels,
  state,
  clockPhase,
  images,
  observer,
  hooks,
) {
  // prettier-ignore
  const pinLevels = new Map();
  for (const [pin, net] of c.pinNet) {
    const level = net ? (levels.get(net) ?? Z) : Z;
    pinLevels.set(pin, hooks?.input ? hooks.input(c, pin, net, level) : level); // prettier-ignore
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
    const own = state.get(c.comp.id) ?? initialState(c.def);
    const ins = inputLevels(c.def, pinLevels);
    outMap = outputsOf(c.def, own, ins);
    if (observer?.watch.has(c.comp.id)) observer.chip(c.comp.id, ins, own);
  } else if (c.oscillator) {
    // A board-seated crystal can: same free-running source as a clock
    // brick's terminal, but only while powered (the caller's status check).
    outMap = new Map([[c.outputPin, clockPhase.get(c.comp.id) ?? Z]]);
  } else {
    outMap = evaluate(c.def, pinLevels);
  }
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
      add(c.pinNet.get(outPin), level, c.limitsLevel.has(level));
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
 * output is computed). Only a POWERED switch conducts; `state` is the
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
 * the one reading IS `definite`.
 */
export function channelGroups(ctx, levels, state = new Map()) {
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
      for (const [pin, net] of c.pinNet) {
        const level = net ? (levels.get(net) ?? Z) : Z;
        pinLevels.set(pin, overrides?.get(controlKey(c, pin)) ?? level);
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
  const unknown = new Set();
  const base = pairsFor(null, unknown);
  if (!base.on.length && !base.maybe.length) return null;
  const definite = reading(base.on);
  if (!base.maybe.length) return { definite, readings: [definite] };
  const keys = [...unknown];
  if (keys.length > MAX_UNKNOWN_CONTROLS) {
    return {
      definite,
      readings: [definite, reading([...base.on, ...base.maybe])],
    };
  }
  const readings = [];
  for (let bits = 0; bits < 2 ** keys.length; bits++) {
    const overrides = new Map(
      keys.map((key, i) => [key, (bits >> i) & 1 ? H : L]),
    );
    // A channel still answering X with every unknown control set has a
    // reason of its own; it is closed, the conservative reading.
    const { on, maybe } = pairsFor(overrides, null);
    readings.push(reading([...on, ...maybe]));
  }
  return { definite, readings };
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
function withExtraHighs(drivers, extra) {
  if (!extra.size) return drivers;
  return {
    get: (net) =>
      extra.has(net)
        ? [...(drivers.get(net) ?? []), ...Array(extra.get(net)).fill(H)]
        : drivers.get(net),
  };
}

/**
 * The DIODES' strong drive for one pass: every diode whose anode net is
 * STRONGLY HIGH — from a supply or an output, never a pull — drives its
 * cathode net HIGH at output strength, to a fixpoint (a chain of diodes passes
 * a level down it, one diode a round). It starts from no diode driving at all
 * and only ever adds a HIGH, so it is monotone, cannot hold itself up, and
 * settles within one round per diode.
 *
 * Returns the drivers with every diode's HIGH added, and the strong levels
 * they resolve to — or `levels: null` when there are no diodes, so a desk
 * without one pays nothing. `scope` (see `resolveAll`) limits it to some nets
 * and the diodes among them; the round cap stays the desk's.
 */
function diodeDrive(ctx, drivers, groups, wide, scope = null) {
  if (!ctx.diodes.length) return { drivers, levels: null };
  const { netIds, diodes } = scope ?? ctx;
  let extra = new Map();
  let merged = drivers;
  let levels = null;
  for (let round = 0; round <= ctx.diodes.length; round++) {
    levels = new Map();
    for (const id of netIds) {
      levels.set(id, resolveIn(ctx, merged, groups, id, noPulls).level);
    }
    const next = new Map();
    for (const d of diodes) {
      if (!feedsCathode(ctx, d) || !passesHigh(levels.get(d.anode), wide)) {
        continue;
      }
      next.set(d.cathode, (next.get(d.cathode) ?? 0) + 1);
    }
    if (mapsEqual(next, extra)) break;
    extra = next;
    merged = withExtraHighs(drivers, extra);
  }
  return { drivers: merged, levels };
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
      const addPull = (net, level) => {
        if (!net || (level !== H && level !== L)) return;
        if (!p.has(net)) p.set(net, []);
        p.get(net).push(level);
      };
      for (const r of resistors) {
        addPull(r.netA, basisOf(r.netB));
        addPull(r.netB, basisOf(r.netA));
      }
      for (const d of diodes) {
        if (feedsCathode(ctx, d) && passesHigh(basisOf(d.anode), wide)) {
          addPull(d.cathode, H);
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
  const uncertain = !wide && diodes.some((d) => next.get(d.anode) === X);
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
