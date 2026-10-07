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

// incremental.js — the settle loop, doing only the work a pass's changes
// call for (features/event-driven-simulation.md). Pure and DOM-free.
//
// THE PASSES ARE THE FULL LOOP'S, EXACTLY. Same number, same starting levels,
// same fixpoint test, same oscillation marking, same warnings in the same
// order, same observer record, same hook calls — sim/engine.js `solve` with
// `mode: "full"` is the reference, and tests/engine-incremental.test.js holds
// every result field of every tick to it. A pass simply skips the chips whose
// inputs did not change and the nets whose drivers did not ("selective
// trace": the zero-delay, delta-cycle form of an event model).
//
//   CHIPS.  A chip is evaluated again only when a net it READS changed
//     (settle-index.js `readers`), its sequential state object is not the one
//     it was evaluated with, or it is a sequential chip the debugger WATCHES
//     (its recorder needs a record of it on every pass). Everything else
//     reuses its last outputs — exact, because within one solve a chip's
//     outputs are a pure function of its pins and of what the solve holds
//     fixed (state, clock phase, images, signals). Spice Lite's `input` hook
//     is pure within one digital tick (its readings change only between
//     them), so a cached evaluation stays right under it too. Its `outputs`
//     hook is NOT pure: it counts each held output down once per CALL and
//     books each switching spike, so every powered chip still goes through it
//     every pass, in `ctx.chips` order, cached outputs or fresh — and what it
//     RETURNS is what drives (a hold can expire on a pass where nothing at
//     that chip's pins changed).
//
//   NETS.  A net's driver list is rebuilt only when a chip's driven outputs
//     on it changed; a net is re-resolved only when its own drivers changed,
//     or its channel joins did, together with everything it is coupled to
//     (settle-index.js's static components, through settle-pass.js
//     `resolveAll`'s `scope`). What is cached is the CERTAIN channels'
//     resolution (`definite`, the narrow reading) — level, warning and
//     strong level per net.
//
//   FALLBACKS.  A pass resolves every net the full loop's way
//     (`resolveReadings`) and refreshes the cache from it when piecewise
//     resolution would need more care than it is worth:
//       readings   the channels have more than the one certain reading — an
//                  unknown control is read every way it could be, which no
//                  per-component cache follows;
//       uncertain  a diode's anode is unknown, so the WIDE reading — a whole
//                  desk's — is needed beside the narrow one.
//     And nothing is cached at all before a tick's first pass (the cold
//     pass): every chip is evaluated and every net resolved, through the same
//     piecewise code with everything dirty.
//
//   MAPS.  Each pass's starting levels are handed to the observer by
//     reference (the debugger's recorder keeps them), so with an observer —
//     or with Spice Lite's `levels` hook, which is handed a whole map and
//     returns one — every pass gets fresh complete maps (copy mode).
//     Without either, one working map is updated in place and a pass costs
//     only what it changed. One quirk of the full loop is kept on purpose:
//     on a desk with no resistor, no diode and no LED-limiting part, a
//     pass's strong levels ARE its level map (`resolveAll`'s `strong ??
//     next`), so the oscillation marking reaches both.
//
//   ACROSS A TICK'S SOLVES.  `tick` re-solves after each step of its
//     sequential chips; the work (outputs, drivers, resolutions) is handed
//     from one solve to the next as `carry`, with `pending` — the nets whose
//     levels moved since the outputs were read: the last pass's changes,
//     marked X when a solve hit its cap — and `stale`, the nets whose level
//     is not the cache's (a fallback's disagreeing readings, an X mark). A
//     chip whose state the step replaced is re-evaluated by the state rule.
//     The step pass itself produces no net levels, so nothing else moves.
//     Nothing is ever carried from one TICK to the next: the engine keeps no
//     state between calls.

import { X, Z } from "./levels.js";
import { CHIP_STATUS } from "./chip-status.js";
import {
  channelGroups,
  chipOutputs,
  groupShorts,
  mapsEqual,
  resolveAll,
  resolveReadings,
} from "./settle-pass.js";
import { mergeScopes } from "./settle-index.js";

/** Marks a pass whose strong levels are the cache's, built only if asked. */
const FROM_CACHE = Symbol("strong levels from the cache");

/** `loneLevel`'s answer for a net two drivers fight over: X, and a conflict. */
const CONFLICT = "conflict";

/**
 * A lone net's level (settle-index.js: no resistor, diode or channel touches
 * it, and it is no rail) from its drivers — `resolveNet` for chip levels and
 * nothing else, without its allocations: no non-Z level floats it, one level
 * is that level, two are a CONFLICT (X). The cold pass resolves every lone net
 * this way, once a tick.
 */
function loneLevel(levels = []) {
  let level = Z;
  for (const lv of levels) {
    if (lv === Z || lv === level) continue;
    if (level !== Z) return CONFLICT;
    level = lv;
  }
  return level;
}

/** Two output maps that drive the same levels. */
function sameOutputs(a, b) {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const [pin, level] of a) if (b.get(pin) !== level) return false;
  return true;
}

/** Add `stats[key] += n`, when the caller asked for counters. */
const count = (stats, key, n = 1) => {
  if (stats) stats[key] = (stats[key] ?? 0) + n;
};

/**
 * The working state of a tick's solves: what each chip last drove, every
 * net's drivers, and the cached resolution. The clock and signal drivers are
 * fixed for the tick, so they are read once, here.
 */
function openWork(ctx, clockPhase, signalLevels) {
  const ix = ctx.index;
  const base = new Map(); // net → the clock/signal levels driving it
  for (const [net, list] of ix.sources) {
    base.set(
      net,
      list.map((s) =>
        s.clock != null
          ? (clockPhase.get(s.clock) ?? Z)
          : (signalLevels.get(s.signal) ?? Z),
      ),
    );
  }
  const work = {
    ctx,
    base,
    raw: new Array(ctx.chips.length), // a chip's own outputs
    fin: new Array(ctx.chips.length), // …as the outputs hook let them through
    used: new Array(ctx.chips.length), // the state object they were read with
    drivers: new Map(),
    hard: null,
    // The certain reading's level and strong (LED rule) level by net INDEX
    // (netIds order), and its warning by net for the nets that have one —
    // the rails and the components no driver reaches already resolved
    // (settle-index.js `start`).
    level: ix.start.level.slice(),
    strong: ix.start.strong.slice(),
    warn: new Map(ix.start.warn),
    channels: null,
    sig: [], // channel component → the joins it was resolved with
    valid: false,
    version: 0, // bumped by each solve that takes the work on
  };
  work.hard = ctx.limitsLed ? new Map() : work.drivers;
  return work;
}

/** Write one net's resolution into the cache: net `id`, index `i`. */
function setCache(work, i, id, level, warning, strong) {
  work.level[i] = level;
  work.strong[i] = strong;
  if (warning) work.warn.set(id, warning);
  else if (work.warn.size) work.warn.delete(id);
}

/** Every driver, from scratch — `driversFor`'s lists, from the outputs the
    chips last drove. */
function rebuildAll(ctx, work) {
  const drivers = new Map();
  const hard = ctx.limitsLed ? new Map() : drivers;
  const add = (net, level, limited = false) => {
    if (!net) return;
    if (!drivers.has(net)) drivers.set(net, []);
    drivers.get(net).push(level);
    if (hard === drivers || limited) return;
    if (!hard.has(net)) hard.set(net, []);
    hard.get(net).push(level);
  };
  for (const [net, levels] of work.base) for (const lv of levels) add(net, lv);
  ctx.chips.forEach((c, i) => {
    const fin = work.fin[i];
    if (!fin) return;
    for (const [pin, level] of fin) {
      add(c.pinNet.get(pin), level, c.limitsLevel.has(level));
    }
  });
  work.drivers = drivers;
  work.hard = hard;
}

/** One net's drivers, again (resolve.js reads them as a set, so the order
    they are listed in cannot matter). */
function rebuildNet(ctx, work, net) {
  const list = [...(work.base.get(net) ?? [])];
  const hard = ctx.limitsLed ? [...list] : null;
  for (const i of ctx.index.contributors.get(net) ?? []) {
    const fin = work.fin[i];
    if (!fin) continue;
    const c = ctx.chips[i];
    for (const [pin, level] of fin) {
      if (c.pinNet.get(pin) !== net) continue;
      list.push(level);
      if (hard && !c.limitsLevel.has(level)) hard.push(level);
    }
  }
  work.drivers.set(net, list);
  if (hard) work.hard.set(net, hard);
}

/** The joins one channel component was resolved with. */
function joinsOf(comp, channels) {
  const on = channels?.definite?.on?.byNet;
  const hardOn = channels?.definite?.hardOn?.byNet;
  return comp.nets
    .map(
      (id) =>
        `${on?.get(id)?.members.join(",") ?? ""}|${hardOn?.get(id)?.members.join(",") ?? ""}`,
    ) // prettier-ignore
    .join(";");
}

/**
 * Run the warm-started settle loop incrementally — `solve`'s contract
 * (sim/engine.js), plus `carry`: the previous solve of the same tick's work,
 * or null. Returns `{levels, iterations, settled, warnings, strong, carry}`.
 * `stats`, when given, counts what was done (tests and the bench only).
 */
export function solveIncremental(
  ctx,
  warmStart,
  state,
  clockPhase,
  images,
  signalLevels,
  observer,
  hooks,
  cap,
  carry,
  stats,
) {
  const ix = ctx.index;
  const copy = Boolean(observer || hooks?.levels);
  const work =
    carry?.work?.ctx === ctx
      ? carry.work
      : openWork(ctx, clockPhase, signalLevels);
  const carried = work === carry?.work;
  const version = ++work.version;
  count(stats, "solves");

  // Where this solve starts. In place, a carried solve takes over the map
  // the last one finished with: nobody else holds it.
  let levels;
  if (!copy && carried && carry.final === warmStart) {
    levels = warmStart;
  } else {
    levels = new Map();
    for (const id of ctx.netIds) levels.set(id, warmStart.get(id) ?? Z);
  }
  // The nets that changed since the cached outputs were read (null: there
  // are none cached — everything), and the nets whose level is not the
  // cache's (in place only; a copy is rebuilt from the cache every pass).
  let delta = work.valid ? new Set(carried ? carry.pending : []) : null;
  let stale = copy ? null : new Set(carried ? carry.stale : []);
  const alias = !ctx.resistors.length && !ctx.diodes.length && !ctx.limitsLed;
  const burnOf = (joins) =>
    ctx.limitsLed ? { drivers: work.hard, groups: joins ?? null } : null;
  const watched = observer
    ? ctx.chips.flatMap((c, i) => (c.sequential && observer.watch.has(c.comp.id) ? [i] : [])) // prettier-ignore
    : [];
  const { netIds } = ctx;
  const levelOf = (id) => work.level[ix.netIndex.get(id)];
  const strongMap = () => {
    const out = new Map();
    for (let i = 0; i < netIds.length; i++) out.set(netIds[i], work.strong[i]);
    return out;
  };

  let iterations = 0;
  let settled = false;
  let lastStrong = new Map();
  let prev = levels;
  while (iterations < cap) {
    // The pass's starting levels, and the strong levels that go with them
    // (resolved alongside them by the pass before — none yet on the first).
    observer?.round("settle", levels, iterations ? lastStrong : null);
    const first = iterations === 0;
    iterations++;
    hooks?.pass?.();
    count(stats, "passes");
    const everything = delta === null;
    if (everything) count(stats, "coldPasses");

    // ① The chips. Every one when nothing is cached, on a solve's first pass
    //    (a step may have replaced a state) and under the outputs hook (it
    //    hears every chip, every pass); otherwise only those whose inputs
    //    moved, and the watched.
    let marked = null;
    // The chips Spice Lite says read something new on a net whose level did
    // not move (a voltage crossed a threshold).
    const again = hooks?.reread?.() ?? null;
    if (!everything && (delta.size || again)) {
      marked = new Set();
      for (const net of delta) {
        for (const i of ix.readers.get(net) ?? []) marked.add(i);
      }
      if (again) {
        ctx.chips.forEach((c, i) => {
          if (again.has(c.comp.id)) marked.add(i);
        });
      }
    }
    let order;
    if (everything || first || hooks?.outputs) {
      order = ctx.chips.keys();
    } else {
      const some = new Set(watched);
      for (const i of marked ?? []) some.add(i);
      order = [...some].sort((a, b) => a - b);
    }
    const touched = everything ? null : new Set(); // nets whose drivers moved
    for (const i of order) {
      const c = ctx.chips[i];
      if (c.status !== CHIP_STATUS.OK || c.analogSwitch) continue;
      const own = c.sequential ? state.get(c.comp.id) : undefined;
      let raw = work.raw[i];
      if (
        everything ||
        raw === undefined ||
        marked?.has(i) ||
        (c.sequential && (work.used[i] !== own || observer?.watch.has(c.comp.id))) // prettier-ignore
      ) {
        raw = chipOutputs(c, levels, state, clockPhase, images, observer, hooks); // prettier-ignore
        work.raw[i] = raw;
        work.used[i] = own;
        count(stats, "evaluations");
      }
      const fin = hooks?.outputs ? hooks.outputs(c, raw) : raw;
      const old = work.fin[i];
      if (fin === old) continue;
      work.fin[i] = fin;
      if (!touched || sameOutputs(fin, old)) continue;
      for (const [pin, level] of fin) {
        if (old?.get(pin) === level) continue;
        const net = c.pinNet.get(pin);
        if (net) touched.add(net);
      }
      for (const pin of old?.keys() ?? []) {
        if (fin.has(pin)) continue;
        const net = c.pinNet.get(pin);
        if (net) touched.add(net);
      }
    }
    if (everything) rebuildAll(ctx, work);
    else for (const net of touched) rebuildNet(ctx, work, net);

    // ② The channels — re-read when a control moved (and on a solve's first
    //    pass, a MOSFET's held gate being state); a channel component whose
    //    joins changed is re-resolved.
    const dirty = new Set(); // components to re-resolve
    const controlMoved =
      !everything && !first && [...delta].some((id) => ix.controlNets.has(id));
    if (ix.hasChannels && (everything || first || controlMoved)) {
      work.channels = channelGroups(ctx, levels, state);
      for (const k of ix.channelComps) {
        const sig = joinsOf(ix.comps[k], work.channels);
        if (sig !== work.sig[k]) dirty.add(k);
        work.sig[k] = sig;
      }
    }
    const channels = work.channels;

    // ③ The nets.
    let full = null; // this pass's whole-desk resolution, when it falls back
    let changed = everything ? null : new Set(); // nets whose cache moved
    const fallBack = (kind) => {
      count(stats, kind);
      const r = resolveReadings(ctx, work.drivers, work.hard, channels);
      const said = new Map(r.definite.netWarnings.map((w) => [w.net, w.type]));
      for (let i = 0; i < netIds.length; i++) {
        const id = netIds[i];
        setCache(work, i, id, r.definite.next.get(id), said.get(id), r.definite.strong.get(id)); // prettier-ignore
      }
      count(stats, "resolutions", ctx.netIds.length);
      changed = null;
      return r;
    };
    const exact =
      !channels ||
      (channels.readings.length === 1 &&
        channels.readings[0] === channels.definite);
    if (!exact) {
      full = fallBack("readingsFallbacks");
    } else {
      const put = (i, id, level, warning, strong) => {
        if (changed && work.level[i] !== level) changed.add(id);
        setCache(work, i, id, level, warning, strong);
      };
      let lone = [];
      if (everything) {
        lone = ix.loneIdx;
        ix.comps.forEach((comp, k) => {
          if (!comp.fixed) dirty.add(k);
        });
      } else {
        for (const id of touched) {
          const k = ix.compOf.get(id);
          if (k != null) dirty.add(k);
          else if (!ix.railRes.has(id)) lone.push(ix.netIndex.get(id));
        }
      }
      for (const i of lone) {
        const id = netIds[i];
        const level = loneLevel(work.drivers.get(id));
        const hard = ctx.limitsLed ? loneLevel(work.hard.get(id)) : level;
        const strong = hard === CONFLICT ? X : hard;
        if (level === CONFLICT) put(i, id, X, "conflict", strong);
        else put(i, id, level, undefined, strong);
      }
      count(stats, "resolutions", lone.length);
      if (dirty.size) {
        const comps = [...dirty].sort((a, b) => a - b).map((k) => ix.comps[k]);
        const scope = mergeScopes(comps);
        const def = channels?.definite;
        const r = resolveAll(ctx, work.drivers, def?.on ?? null, burnOf(def?.hardOn), false, scope); // prettier-ignore
        const said = new Map(r.netWarnings.map((w) => [w.net, w.type]));
        for (const comp of comps) {
          comp.nets.forEach((id, j) => {
            put(comp.idx[j], id, r.next.get(id), said.get(id), r.strong.get(id)); // prettier-ignore
          });
          count(stats, "resolutions", comp.nets.length);
        }
      }
      // An unknown anode: the wide reading belongs to the whole desk.
      if (ix.anodes.some((i) => work.level[i] === X)) {
        full = fallBack("uncertainFallbacks");
      }
    }
    if (!full) count(stats, everything ? "coldResolves" : "incrementalPasses");
    work.valid = true;

    // ④ The levels the next pass starts from.
    if (copy) {
      let pre;
      let strong;
      if (full) {
        pre = full.next;
        strong = full.strong;
      } else {
        pre = new Map();
        for (let i = 0; i < netIds.length; i++) pre.set(netIds[i], work.level[i]); // prettier-ignore
        strong = alias ? pre : observer ? strongMap() : FROM_CACHE;
      }
      const next = hooks?.levels ? hooks.levels(pre, { start: levels, state }) : pre; // prettier-ignore
      lastStrong = strong;
      if (mapsEqual(next, levels) && !hooks?.busy?.()) {
        levels = next;
        settled = true;
        break;
      }
      delta = new Set();
      for (const id of ctx.netIds) {
        if (next.get(id) !== levels.get(id)) delta.add(id);
      }
      prev = levels;
      levels = next;
    } else if (full) {
      const next = full.next;
      stale = new Set();
      for (let i = 0; i < netIds.length; i++) {
        if (next.get(netIds[i]) !== work.level[i]) stale.add(netIds[i]);
      }
      lastStrong = full.strong;
      if (mapsEqual(next, levels) && !hooks?.busy?.()) {
        levels = next;
        settled = true;
        break;
      }
      delta = new Set();
      for (const id of ctx.netIds) {
        if (next.get(id) !== levels.get(id)) delta.add(id);
      }
      prev = levels;
      levels = next;
    } else {
      const moved = new Map(); // net → its new level
      if (changed) {
        for (const id of new Set([...changed, ...stale])) {
          const level = levelOf(id);
          if (level !== levels.get(id)) moved.set(id, level);
        }
      } else {
        for (let i = 0; i < netIds.length; i++) {
          const level = work.level[i];
          if (level !== levels.get(netIds[i])) moved.set(netIds[i], level);
        }
      }
      stale = new Set();
      lastStrong = alias ? levels : FROM_CACHE;
      if (!moved.size && !hooks?.busy?.()) {
        settled = true;
        break;
      }
      // The capped pass: the marking compares where it began with where it
      // ended, so keep where it began.
      if (iterations >= cap) prev = new Map(levels);
      for (const [id, level] of moved) levels.set(id, level);
      delta = new Set(moved.keys());
    }
  }

  // The last pass's warnings: the certain channels' (a fallback's too), each
  // net's in netIds order, then the shorts its joins make.
  const warnings = [...work.warn.keys()]
    .sort((a, b) => ix.netIndex.get(a) - ix.netIndex.get(b))
    .map((id) => ({ type: work.warn.get(id), net: id }));
  warnings.push(...groupShorts(ctx, work.channels?.definite?.on ?? null));
  let marked = [];
  if (!settled) {
    count(stats, "cappedSolves");
    marked = ctx.netIds.filter((id) => prev.get(id) !== levels.get(id));
    for (const id of marked) levels.set(id, X);
    if (marked.length) warnings.push({ type: "oscillation", nets: marked });
  }
  const staleOut = copy
    ? null
    : new Set([...stale, ...marked.filter((id) => levelOf(id) !== X)]);
  const result = {
    levels,
    iterations,
    settled,
    warnings,
    carry: { work, final: levels, pending: marked, stale: staleOut ?? [] },
  };
  if (lastStrong !== FROM_CACHE) {
    result.strong = lastStrong;
  } else {
    // Built only when read: of a tick's solves, only the last one's strong
    // levels are ever wanted (`assemble`), the others' only by an observer —
    // whose passes always build theirs. Read after a later solve has moved
    // the cache on, they would be that solve's, so that is refused.
    let built = null;
    Object.defineProperty(result, "strong", {
      enumerable: true,
      get() {
        if (built) return built;
        if (work.version !== version) {
          throw new Error("incremental settle: strong levels read stale");
        }
        return (built = strongMap());
      },
    });
  }
  return result;
}
