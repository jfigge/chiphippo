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
// call for (features/done/event-driven-simulation.md). Pure and DOM-free.
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
//     books each switching spike, and what it RETURNS is what drives (a hold
//     can expire on a pass where nothing at that chip's pins changed). So the
//     chips evaluated again AND the ones it says are holding (`holding`) go
//     through it every pass, in `ctx.chips` order; for any other the call
//     would change nothing, and is not made (features/06-sparse-outputs-
//     hook.md, `SPICE_ASSERT_OUTPUTS`).
//
//   NETS.  A net's driver list is rebuilt only when a chip's driven outputs
//     on it changed; a net is re-resolved only when its own drivers changed,
//     or its channel joins did, together with everything it is coupled to
//     (settle-index.js's static components, through settle-pass.js
//     `resolveAll`'s `scope`). What is cached is the CERTAIN channels'
//     resolution (`definite`, the narrow reading) — level, warning and
//     strong level per net.
//
//   MORE THAN ONE READING.  The cache is the certain reading's. Where the
//     full loop (`resolveReadings`) reads a pass more than one way, the
//     other readings are read on the components they can differ on alone,
//     the rest the cache's (`scopedReading`; each once a whole-desk
//     fallback):
//       channels   an unknown control is read every way it could be — on
//                  the components of the channels whose joins differ
//                  between the readings (`channelGroups`' `maybeNets`);
//       diodes     a diode's unknown end (`uncertain`) needs the WIDE
//                  reading beside the narrow one — on the components such
//                  a diode is in.
//     And nothing is cached at all before a tick's first pass (the cold
//     pass): every chip is evaluated and every net resolved, through the same
//     piecewise code with everything dirty.
//
//   MAPS.  Each pass's starting levels are handed to the observer by
//     reference (the debugger's recorder keeps them), so with an observer —
//     or with a `levels` hook that only takes and returns whole maps — every
//     pass gets fresh complete maps (copy mode). Without either, one working
//     map is updated in place and a pass costs only what it changed. Spice
//     Lite's hook also comes as `levelsDelta` — only the nets it shows
//     otherwise than the pass resolved — which is applied in place, a net it
//     overrides kept STALE (not the cache's) until it is reconsidered
//     (features/07-delta-level-maps.md, `SPICE_ASSERT_DELTA`). One quirk of the full loop is kept on purpose:
//     on a desk with no resistor, no diode and no LED-limiting part, a
//     pass's strong levels ARE its level map (`resolveAll`'s `strong ??
//     next`), so the oscillation marking reaches both.
//
//   ACROSS A TICK'S SOLVES.  `tick` re-solves after each step of its
//     sequential chips; the work (outputs, drivers, resolutions) is handed
//     from one solve to the next as `carry`, with `pending` — the nets whose
//     levels moved since the outputs were read: the last pass's changes,
//     marked X when a solve hit its cap — and `stale`, the nets whose level
//     is not the cache's (the readings' disagreements, an X mark). A
//     chip whose state the step replaced is re-evaluated by the state rule.
//     The step pass itself produces no net levels, so nothing else moves.
//     Nothing is ever carried from one TICK to the next: the engine keeps no
//     state between calls.

import { L, OC_X, X, Z } from "./levels.js";
import { CHIP_STATUS } from "./chip-status.js";
import {
  channelGroups,
  chipOutputs,
  groupShorts,
  mapsEqual,
  resolveAll,
  agreeing,
  selfFedNets,
  biasedNets,
} from "./settle-pass.js";
import { mergeScopes } from "./settle-index.js";
import { resolveNet } from "./resolve.js";
import { driverLevel } from "./chip-eval.js";
import {
  ASSERT_DELTA,
  ASSERT_OUTPUTS,
  ASSERT_WARM,
  COLD_SETTLE,
} from "./assert-modes.js";

/** Each context's chips by id, and its sequential chips' indices. */
const INDEX = new WeakMap();
export function chipIndex(ctx) {
  let index = INDEX.get(ctx);
  if (!index) {
    index = new Map(ctx.chips.map((c, i) => [c.comp.id, i]));
    index.sequential = ctx.chips.flatMap((c, i) => (c.sequential ? [i] : []));
    index.switches = ctx.chips.flatMap((c, i) => (c.analogSwitch ? [i] : []));
    // (The tick's own walks — engine.js `tick`, features/digital-event-
    // tick.md A3: memories and timed parts, in `ctx.chips` order.)
    index.memory = ctx.chips.flatMap((c, i) => (c.memory ? [i] : []));
    index.timed = ctx.chips.flatMap((c, i) => (c.timing ? [i] : []));
    // The chips whose outputs are a plain evaluation of their units — no
    // state, image, phase or open-collector copy behind them — so an
    // evaluation may be written into a spare map (`work.spare`).
    index.pooled = ctx.chips.map(
      (c) => !c.memory && !c.sequential && !c.oscillator && !c.analogSwitch && !c.def.openCollector?.length, // prettier-ignore
    );
    INDEX.set(ctx, index);
  }
  return index;
}

/** From this pass on, a solve that has not settled looks for its levels
    coming round again (`solveIncremental`'s cycle skip). */
const CYCLE_FROM = 4;

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
  let maybe = false; // an open-collector output that may sink (`OC_X`)
  for (const lv of levels) {
    if (lv === OC_X) {
      maybe = true;
      continue;
    }
    if (lv === Z || lv === level) continue;
    if (level !== Z) return CONFLICT;
    level = lv;
  }
  return maybe && level !== L ? X : level;
}

/** Two output maps that drive the same levels. */
function sameOutputs(a, b) {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const pin of a.keys()) if (b.get(pin) !== a.get(pin)) return false;
  return true;
}

/** Whether any of `ids` is in `nets` (no array spread of either). */
function anyIn(ids, nets) {
  for (const id of ids) if (nets.has(id)) return true;
  return false;
}

/** A new set of what is in `a` or `b`, `a`'s first. */
function union(a, b) {
  const out = new Set(a);
  for (const id of b) out.add(id);
  return out;
}

/** No nets — the stale set of a pass whose readings were the cache's
    (shared: a stale set is only ever read, never added to). */
const NO_NETS = new Set();

/** Add `stats[key] += n`, when the caller asked for counters. */
const count = (stats, key, n = 1) => {
  if (stats) stats[key] = (stats[key] ?? 0) + n;
};

/**
 * The working state of a tick's solves: what each chip last drove, every
 * net's drivers, and the cached resolution. The clock and signal drivers are
 * fixed for the tick, so they are read once, here.
 */
function openWork(ctx, clockPhase, signalLevels, maybeSinks) {
  const ix = ctx.index;
  const base = sourcesBase(ctx, clockPhase, signalLevels);
  const work = {
    ctx,
    base,
    maybeSinks, // an open-collector X may sink (`driverLevel`): no hooks
    raw: new Array(ctx.chips.length), // a chip's own outputs
    fin: new Array(ctx.chips.length), // …as the outputs hook let them through
    used: new Array(ctx.chips.length), // the state object they were read with
    // A combinational chip's map that is in neither `raw` nor `fin` — the
    // one its outputs last were, or an evaluation that came out as they
    // are — written into by its next evaluation instead of a new one (the
    // logic engine only: no observer keeps an evaluation, no outputs hook
    // holds one). Held nowhere else, by anyone.
    spare: new Array(ctx.chips.length),
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
    // channel component → its readings' agreement, while a channel might be
    // on: `{channels, key, levels}` (incremental.js `scopedReading`)
    readings: new Map(),
    switchState: [], // a channel part's state the channels were read with
    valid: false,
    version: 0, // bumped by each solve that takes the work on
    spareLevels: null, // a taken warm's levels, for the next one (`warmStartOf`)
    beforeChange: null, // told before it does (`strongLater`)
  };
  work.hard = ctx.limitsLed ? new Map() : work.drivers;
  return work;
}

/** Each bench-source net's clock/signal levels driving it — a clock only
    while this context powers it (`outNet`; the index lists it by the net it
    is wired to, as `driversFor` adds it by its powered one). */
function sourcesBase(ctx, clockPhase, signalLevels) {
  const base = new Map(); // net → the clock/signal levels driving it
  for (const net of ctx.index.sources.keys()) {
    const list = ctx.index.sources.get(net);
    const levels = [];
    for (const s of list) {
      if (s.clock == null) levels.push(signalLevels.get(s.signal) ?? Z);
      else if (ctx.clocks[s.at]?.outNet != null) levels.push(clockPhase.get(s.clock) ?? Z); // prettier-ignore
    }
    base.set(net, levels);
  }
  return base;
}

/**
 * The work a tick's FIRST solve may start from instead of cold
 * (features/08-warm-incremental-cache.md): the last tick's, when it ended
 * settled on this very context — `warm` is `{work, levels, stale}` (`tick`'s
 * `result.warm`: the work, the levels its final pass ended on, by net index,
 * and the nets shown otherwise than its cache). Every cached evaluation is
 * then right but for what changed OUTSIDE a solve since; the rule, and what
 * each thing dirties:
 *   · a net's level — `warmStart` is not the level the work ended on (a
 *     tick's own assembly, Spice Lite's replayed segments, …): the net, so
 *     its readers are evaluated again;
 *   · the bench sources (clock levels, signals): their nets' drivers are
 *     rebuilt and resolved again;
 *   · a sequential chip's state replaced (a step, a replay): the state rule
 *     evaluates it, as within a tick;
 *   · a memory's image, a can's clock phase: every memory and can is
 *     evaluated again;
 *   · how a pin READS its net — `hooks.input` (Spice Lite's listeners, view,
 *     voltage readings, relays) — and what an outputs hook was last told a
 *     chip drives: the hook's own `warmDirty()` says which chips and nets
 *     (null: start cold); a hook without it starts cold;
 *   · power, the document, the netlist, a part's def: a new context — cold.
 * An observer, or `SPICE_COLD_SETTLE`, starts cold. `SPICE_ASSERT_WARM`
 * evaluates every chip the rule leaves clean and rebuilds every driver, and
 * throws if either differs from the cache.
 */
function warmStartOf(
  ctx,
  warm,
  warmStart,
  clockPhase,
  signalLevels,
  observer,
  hooks,
) {
  // prettier-ignore
  if (!warm || warm.work?.ctx !== ctx || observer || COLD_SETTLE) return null;
  // The work is taken over and changed in place: only ONE tick may start
  // from it. A caller that ticks twice from one result (a test branching a
  // run) gets a cold start the second time.
  if (warm.taken) return null;
  warm.taken = true;
  const dirty = hooks ? (hooks.warmDirty?.() ?? null) : { chips: [], nets: [] }; // prettier-ignore
  if (!dirty) return null;
  const work = warm.work;
  const base = sourcesBase(ctx, clockPhase, signalLevels);
  const touched = new Set(); // bench-source nets whose drivers moved
  for (const net of base.keys()) {
    const list = base.get(net);
    const was = work.base.get(net);
    if (!was || was.length !== list.length || list.some((lv, k) => lv !== was[k])) touched.add(net); // prettier-ignore
  }
  work.base = base;
  // (…and a capped solve's marked nets, its last pass's changes: the
  // cache read them where they began that pass — as `carry.pending`.)
  const delta = new Set([...dirty.nets, ...(warm.pending ?? [])]);
  // The solve's starting levels, copied in the same walk (`levels`).
  let levels;
  const { netIds } = ctx;
  const out = warm.levelsOut;
  if (out && warmStart === out) {
    // The very map the last tick ended on, handed back as it was (the logic
    // engine's SimController): no net moved since, so nothing to diff — the
    // delta is what the work already tracks (features/digital-event-tick.md
    // A1). Copied, not reused: a caller keeps the last tick's map.
    // Under `inPlace` (A2) it is updated in place, no copy at all: what this
    // tick overwrites is written down first (`work.journal`, into the last
    // tick's record), so that tick's levels can still be read whole later
    // (engine.js `levelsOfRecord`).
    levels = warm.inPlace ? out : new Map(out);
    if (warm.inPlace && warm.record) {
      warm.record.passed = true;
      work.journal = { map: out, undo: (warm.record.undo ??= new Map()) };
    }
  } else {
    levels = new Map();
    for (let i = 0; i < netIds.length; i++) {
      const level = warmStart.get(netIds[i]) ?? Z;
      levels.set(netIds[i], level);
      const was = out ? (out.get(netIds[i]) ?? Z) : warm.levels[i];
      if (level !== was) delta.add(netIds[i]);
    }
  }
  // Read for the last time (the warm is taken): the array this tick's own
  // `warm` is written into (engine.js `tick`), not a new one.
  work.spareLevels = warm.levels ?? null;
  const index = chipIndex(ctx);
  const chips = new Set();
  for (const id of dirty.chips) {
    const i = index.get(id);
    if (i != null) chips.add(i);
  }
  ctx.chips.forEach((c, i) => {
    if (c.memory || c.oscillator) chips.add(i);
  });
  return { work, delta, chips, touched, stale: warm.stale, levels };
}

/** Before `ids` are written into `levels`: where it is the map a tick's
    journal watches (the last tick's, updated in place — A2), each one's
    level as that tick left it, the first write only. */
export function noteLevels(journal, levels, ids) {
  if (journal.map !== levels) return;
  const { undo } = journal;
  for (const id of ids) if (!undo.has(id)) undo.set(id, levels.get(id));
}

/** `SPICE_ASSERT_WARM`: a warm start's first pass, held to a cold one's —
    every chip's cached outputs what it evaluates to now, every net's
    drivers what they are rebuilt from scratch. */
function assertWarm(ctx, work, levels, state, clockPhase, images, hooks) {
  const fail = (what) => {
    throw new Error(`SPICE_ASSERT_WARM: ${what}`);
  };
  ctx.chips.forEach((c, i) => {
    if (c.status !== CHIP_STATUS.OK || c.analogSwitch) return;
    const fresh = chipOutputs(c, levels, state, clockPhase, images, null, hooks); // prettier-ignore
    if (!sameOutputs(fresh, work.raw[i])) fail(`${c.comp.id}'s cached outputs are not what it evaluates to`); // prettier-ignore
  });
  const cold = { base: work.base, fin: work.fin, maybeSinks: work.maybeSinks }; // prettier-ignore
  rebuildAll(ctx, cold);
  const same = (a = [], b = []) =>
    a.length === b.length && [...a].sort().join() === [...b].sort().join();
  for (const id of ctx.netIds) {
    if (!same(cold.drivers.get(id), work.drivers.get(id))) fail(`${id}'s drivers differ`); // prettier-ignore
    if (!same(cold.hard.get(id), work.hard.get(id))) fail(`${id}'s hard drivers differ`); // prettier-ignore
  }
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
      add(c.pinNet.get(pin), driverLevel(c.def, pin, level, work.maybeSinks), c.limitsLevel.has(level)); // prettier-ignore
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
    // (Keys and a lookup, as everywhere a pass walks a map: a Map's
    // `[pin, level]` entries are an array each.)
    for (const pin of fin.keys()) {
      if (c.pinNet.get(pin) !== net) continue;
      const level = fin.get(pin);
      const driven = driverLevel(c.def, pin, level, work.maybeSinks);
      list.push(driven);
      if (hard && !c.limitsLevel.has(level)) hard.push(driven);
    }
  }
  work.drivers.set(net, list);
  if (hard) work.hard.set(net, hard);
}

/** The joins one channel component is resolved with in a reading
    (`channelGroups`' `definite`, or one of its `readings`). */
function joinsOf(comp, reading) {
  const on = reading?.on?.byNet;
  const hardOn = reading?.hardOn?.byNet;
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
  warm = null,
  owned = false,
) {
  const ix = ctx.index;
  // Spice Lite's levels hook, as only what it changes (`levelsDelta`):
  // applied to the map in place, no copy of every net every pass
  // (features/07-delta-level-maps.md). An observer keeps every pass's maps.
  const sparse = !observer && Boolean(hooks?.levelsDelta);
  const copy = Boolean(observer || (hooks?.levels && !sparse));
  const fromWarm =
    carry?.work?.ctx === ctx ? null : warmStartOf(ctx, warm, warmStart, clockPhase, signalLevels, observer, hooks); // prettier-ignore
  const work =
    carry?.work?.ctx === ctx
      ? carry.work
      : (fromWarm?.work ?? openWork(ctx, clockPhase, signalLevels, !hooks));
  const carried = work === carry?.work;
  if (fromWarm) count(stats, "warmSolves");
  // (A tick's result still to build its strong levels from the cache
  // copies them first — `strongLater`.)
  work.beforeChange?.();
  work.beforeChange = null;
  const version = ++work.version;
  count(stats, "solves");

  // Where this solve starts. In place, a carried solve takes over the map
  // the last one finished with, and a tie-break's its seed (`owned`):
  // nobody else holds them. A warm start's copy is taken as it is compared.
  let levels;
  if (!copy && (owned || (carried && carry.final === warmStart))) {
    levels = warmStart;
  } else if (fromWarm) {
    levels = fromWarm.levels;
  } else {
    levels = new Map();
    for (const id of ctx.netIds) levels.set(id, warmStart.get(id) ?? Z);
  }
  // The nets that changed since the cached outputs were read (null: there
  // are none cached — everything), and the nets whose level is not the
  // cache's (in place only; a copy is rebuilt from the cache every pass).
  let delta = fromWarm ? fromWarm.delta : work.valid ? new Set(carried ? carry.pending : []) : null; // prettier-ignore
  let stale = copy ? null : new Set(carried ? carry.stale : (fromWarm?.stale ?? [])); // prettier-ignore
  // Every net whose level this solve moved from where the last one on this
  // work ended, for the tick's step (engine.js `tick`, features/digital-
  // event-tick.md B1) — known only in place, on the logic engine, starting
  // warm or carried; null (unknown) otherwise.
  const moves = !copy && !hooks && (fromWarm || carried) ? new Set(delta) : null; // prettier-ignore
  const alias = !ctx.resistors.length && !ctx.diodes.length && !ctx.limitsLed;
  const burnOf = (joins) =>
    ctx.limitsLed ? { drivers: work.hard, groups: joins ?? null } : null;
  const watched = observer
    ? ctx.chips.flatMap((c, i) => (c.sequential && observer.watch.has(c.comp.id) ? [i] : [])) // prettier-ignore
    : [];
  const { netIds } = ctx;
  const levelOf = (id) => work.level[ix.netIndex.get(id)];
  // The strong levels the readings agreed on where they are not the
  // cache's (the last pass's; null when it had the one certain reading).
  let overStrong = null;
  const strongOf = (strong, over) => {
    const out = new Map();
    for (let i = 0; i < netIds.length; i++) out.set(netIds[i], strong[i]);
    for (const [id, level] of over ?? []) out.set(id, level);
    return out;
  };
  const strongMap = () => strongOf(work.strong, overStrong);

  let iterations = 0;
  let settled = false;
  let lastStrong = new Map();
  let prev = levels;
  let capMoved = null; // (in place: the nets the capped pass moved)
  // A pass is a function of the levels it starts from (the state, clocks
  // and signals stand still through a solve), so levels that come round
  // again come round for good: a ring oscillator's capped solve repeats
  // its period to the cap. Once it has (Brent's search, from `CYCLE_FROM`:
  // a snapshot at doubling distances — kept as each net's level there,
  // taken as it first moves, and how many nets now differ from it), the
  // whole periods left are skipped and the last few run, so the capped
  // pass — its levels, the one before it, its warnings — is the very one
  // the cap would reach (the regrade, 2026-10-26: a ring of three beside
  // the busy fixture ran two solves of 200 passes a tick). In place and
  // with no hooks or observer only: they hear every pass.
  let cyclic = !copy && !sparse && !hooks && !observer;
  let snapAt = 0; // the pass the snapshot was taken after (0: none yet)
  let power = 2;
  const snap = new Map(); // net → its level at the snapshot, once it moved
  let differ = 0; // nets whose level is not the snapshot's
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
    const warmChips = first && fromWarm ? fromWarm.chips : null;
    if (!everything && (delta.size || again || warmChips?.size)) {
      marked = new Set(warmChips ?? []);
      for (const net of delta) {
        for (const i of ix.readers.get(net) ?? []) marked.add(i);
      }
      if (again) {
        ctx.chips.forEach((c, i) => {
          if (again.has(c.comp.id)) marked.add(i);
        });
      }
    }
    // Under Spice Lite's outputs hook (features/06-sparse-outputs-hook.md),
    // a chip whose outputs were not evaluated again and who has no hold in
    // flight is a call that changes nothing — its hook would hand back the
    // very outputs it handed back last (held or not), book no spike (the
    // outputs it compares with are those) and tell the voltage side nothing
    // (`outputs` there ignores the same map) — so it is not made: only the
    // chips evaluated again, the watched and those holding (`holding`) go
    // through it, in `ctx.chips` order, as the full walk would visit them
    // (each spike is added to its supply's sum in the same order).
    // `SPICE_ASSERT_OUTPUTS` makes every other call too, flagged `quiet`,
    // and the hook throws if one does anything.
    let order;
    if (everything || (hooks?.outputs && !hooks.holding)) {
      order = ctx.chips.keys();
    } else if (first && !hooks?.outputs) {
      order = ctx.chips.keys();
    } else {
      const some = new Set(watched);
      for (const i of marked ?? []) some.add(i);
      if (hooks?.outputs) {
        const index = chipIndex(ctx);
        for (const id of hooks.holding().keys()) some.add(index.get(id));
        // A solve's first pass evaluates every sequential chip whose state
        // the step replaced (the state rule, below).
        if (first) for (const i of index.sequential) some.add(i);
      }
      order = [...some].sort((a, b) => a - b);
    }
    let quiet = null; // (the chips the sparse walk visits, in assert mode)
    if (ASSERT_OUTPUTS && hooks?.outputs && Array.isArray(order)) {
      quiet = new Set(order);
      order = ctx.chips.keys();
    }
    // The nets whose drivers moved (a warm start's bench sources first).
    const touched = everything ? null : new Set(first && fromWarm ? fromWarm.touched : []); // prettier-ignore
    const pool = hooks || observer ? null : chipIndex(ctx).pooled;
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
        if (pool?.[i]) {
          // Into the spare map; kept as the spare again when it came out as
          // the outputs already are (so `fin === old` below, as an equal
          // fresh map's `sameOutputs` would have it — nothing rebuilt).
          const fresh = chipOutputs(c, levels, state, clockPhase, images, observer, hooks, work.spare[i] ?? null); // prettier-ignore
          if (raw !== undefined && sameOutputs(fresh, raw)) {
            work.spare[i] = fresh;
          } else {
            work.spare[i] = raw ?? null;
            raw = fresh;
          }
        } else {
          raw = chipOutputs(c, levels, state, clockPhase, images, observer, hooks); // prettier-ignore
        }
        work.raw[i] = raw;
        work.used[i] = own;
        count(stats, "evaluations");
      }
      const fin = hooks?.outputs ? hooks.outputs(c, raw, quiet != null && !quiet.has(i)) : raw; // prettier-ignore
      const old = work.fin[i];
      if (fin === old) continue;
      work.fin[i] = fin;
      if (!touched || sameOutputs(fin, old)) continue;
      for (const pin of fin.keys()) {
        if (old?.get(pin) === fin.get(pin)) continue;
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
    if (ASSERT_WARM && first && fromWarm) assertWarm(ctx, work, levels, state, clockPhase, images, hooks); // prettier-ignore

    // ② The channels — re-read when a control moved (and when a MOSFET's
    //    held gate, being state, may have); a channel component whose joins
    //    changed is re-resolved.
    const dirty = new Set(); // components to re-resolve
    // …or when Spice Lite says a switch reads its control anew on a net
    // whose level did not move (a voltage crossed its threshold: `again`).
    // …or, under the logic engine, when anything a self-fed transistor's
    // reading hears moved — its level or its drivers (settle-pass.js
    // `selfFedNets`).
    // …or what a biased BJT's reading hears (`biasedNets`).
    const fed = hooks?.input ? null : selfFedNets(ctx);
    const biased = hooks?.input ? null : biasedNets(ctx);
    const hears = (nets) =>
      nets?.size > 0 && (anyIn(delta, nets) || anyIn(touched, nets));
    const controlMoved =
      !everything &&
      (anyIn(delta, ix.controlNets) ||
        (again != null &&
          ctx.chips.some((c) => c.analogSwitch && again.has(c.comp.id))) ||
        hears(fed) ||
        hears(biased));
    // A solve's first pass re-reads them where a channel part's state (a
    // MOSFET's held gate) is not the one they were read with — or always
    // under Spice Lite, whose reading of a control is its own. Every solve's
    // first pass re-reading them cost a CD4066B with its controls floating
    // sixteen readings a solve for nothing (the 2026-10-26 review).
    const switches = ix.hasChannels ? chipIndex(ctx).switches : [];
    const restate =
      first &&
      (Boolean(hooks?.input) ||
        switches.some((i) => work.switchState[i] !== state.get(ctx.chips[i].comp.id))); // prettier-ignore
    if (ix.hasChannels && (everything || restate || controlMoved)) {
      work.channels = channelGroups(ctx, levels, state, hooks?.input, work.drivers); // prettier-ignore
      for (const i of switches) work.switchState[i] = state.get(ctx.chips[i].comp.id); // prettier-ignore
      for (const k of ix.channelComps) {
        const sig = joinsOf(ix.comps[k], work.channels?.definite);
        if (sig !== work.sig[k]) dirty.add(k);
        work.sig[k] = sig;
      }
    }
    const channels = work.channels;

    // ③ The nets.
    let full = null; // this pass's levels, where the cache alone is not them
    let changed = everything ? null : new Set(); // nets whose cache moved
    /** The pass's levels where it is more than the one certain reading
        the cache holds — what `resolveReadings` gives, read on the
        components it can differ on alone, the rest the cache's:
          · a channel that might be on (`maybe`, the readings' differing
            terminals): every reading, each with its wide reading beside it
            where a diode's end is unknown, agreed on the components those
            terminals are in;
          · a diode's unknown end elsewhere: the certain reading (the cache)
            agreed with the wide one on each component such an end is in.
        A scope is closed (settle-index.js), and outside them every reading
        IS the certain one. `{over, overStrong}`: each net's level and
        strong level where they are not the cache's. */
    const scopedReading = (maybe) => {
      const over = new Map();
      const strongOver = new Map();
      const now = (id) => (over.has(id) ? over.get(id) : levelOf(id));
      const nowStrong = (id) => (strongOver.has(id) ? strongOver.get(id) : work.strong[ix.netIndex.get(id)]); // prettier-ignore
      const set = (id, level, strong) => {
        const i = ix.netIndex.get(id);
        if (level !== work.level[i]) over.set(id, level);
        else over.delete(id);
        if (strong !== work.strong[i]) strongOver.set(id, strong);
        else strongOver.delete(id);
      };
      const read = (r, wide, scope) => resolveAll(ctx, work.drivers, r?.on ?? null, burnOf(r?.hardOn), wide, scope); // prettier-ignore
      const switched = new Set();
      for (const id of maybe ?? []) {
        const k = ix.compOf.get(id);
        if (k != null) switched.add(k);
      }
      if (switched.size) count(stats, "scopedReadings");
      for (const k of [...switched].sort((a, b) => a - b)) {
        // Each component on its own (a scope is closed), and each reading
        // that joins its nets the same way read once: of a CD4066B's
        // sixteen readings, a channel's component sees two. Kept while
        // neither its drivers nor those joins change (`work.readings`).
        const comp = ix.comps[k];
        let kept = work.readings.get(k);
        if (kept?.channels !== channels) {
          const distinct = new Map(); // its joins → a reading joining so
          for (const r of channels.readings) {
            const sig = joinsOf(comp, r);
            if (!distinct.has(sig)) distinct.set(sig, r);
          }
          const key = [...distinct.keys()].join("\n");
          if (kept?.key === key) {
            kept.channels = channels;
          } else {
            let agreed = null;
            let agreedStrong = null;
            for (const r of distinct.values()) {
              const narrow = read(r, false, comp.scope);
              const tried = narrow.uncertain ? [narrow, read(r, true, comp.scope)] : [narrow]; // prettier-ignore
              for (const t of tried) {
                agreed = agreed ? agreeing(agreed, t.next) : t.next;
                agreedStrong = agreedStrong ? agreeing(agreedStrong, t.strong) : t.strong; // prettier-ignore
              }
              count(stats, "resolutions", tried.length * comp.scope.netIds.length); // prettier-ignore
            }
            const levels = comp.scope.netIds.map((id) => [id, agreed.get(id), agreedStrong.get(id)]); // prettier-ignore
            kept = { channels, key, levels };
            work.readings.set(k, kept);
          }
        }
        for (const [id, level, strong] of kept.levels) set(id, level, strong);
      }
      const ks = new Set();
      for (const i of ix.anodes) {
        if (work.level[i] !== X) continue;
        const k = ix.compOf.get(netIds[i]);
        if (k != null) {
          ks.add(k);
          continue;
        }
        // A rail is in no component (a shorted supply's, X): its diodes'
        // cathodes' are what the wide reading might lift.
        for (const d of ctx.diodes) {
          const kc = d.anode === netIds[i] ? ix.compOf.get(d.cathode) : null;
          if (kc != null) ks.add(kc);
        }
      }
      for (const k of switched) ks.delete(k);
      if (ks.size) {
        count(stats, "uncertainReadings");
        const scope = mergeScopes([...ks].sort((a, b) => a - b).map((k) => ix.comps[k])); // prettier-ignore
        const def = channels?.definite;
        const narrow = read(def, false, scope);
        if (narrow.uncertain) {
          const wide = read(def, true, scope);
          for (const id of scope.netIds) {
            const level = wide.next.get(id) !== now(id) ? X : now(id);
            const strong = wide.strong.get(id) !== nowStrong(id) ? X : nowStrong(id); // prettier-ignore
            set(id, level, strong);
          }
          count(stats, "resolutions", 2 * scope.netIds.length);
        }
      }
      return { over, overStrong: strongOver };
    };
    const exact =
      !channels ||
      (channels.readings.length === 1 &&
        channels.readings[0] === channels.definite);
    {
      const put = (i, id, level, warning, strong) => {
        if (changed && work.level[i] !== level) changed.add(id);
        setCache(work, i, id, level, warning, strong);
      };
      let lone = [];
      // A rail's level is its supply's whatever drives it, but an output
      // driving it the other way is a fight (resolve.js) — said as the full
      // loop says it, so a rail with drivers is read again when they move.
      let railed = [];
      if (everything) {
        lone = ix.loneIdx;
        railed = [...ix.railRes.keys()];
        ix.comps.forEach((comp, k) => {
          if (!comp.fixed) dirty.add(k);
        });
      } else {
        for (const id of touched) {
          const k = ix.compOf.get(id);
          if (k != null) dirty.add(k);
          else if (ix.railRes.has(id)) railed.push(id);
          else lone.push(ix.netIndex.get(id));
        }
      }
      for (const id of railed) {
        const { level } = ix.railRes.get(id);
        const { warning } = resolveNet({
          supplyPlus: ctx.supplyPlusVolts.has(id),
          supplyMinus: ctx.supplyMinus.has(id),
          chipLevels: work.drivers.get(id) ?? [],
        });
        put(ix.netIndex.get(id), id, level, warning, level);
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
      for (const k of dirty) work.readings.delete(k);
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
      // A channel that might be on, or an unknown diode end: every reading
      // (the narrow and the wide one beside it, for a diode), kept where
      // they agree — only on the components those are in. The wide reading
      // moves nothing a diode with a known anode does not, a channel joins
      // nothing outside its component, and a scope is closed (settle-
      // index.js), so the rest of the desk reads as its cache does. Read
      // whole, one CMOS output left floating into a diode cost every pass
      // two whole-desk resolutions (the fourth regrade, 2026-10-22: the busy
      // fixture 0.26 → 1.9 ms a tick), and one powered CD4066B with its
      // controls floating sixteen (the 2026-10-26 review: 0.27 → 10.7).
      if (!exact || ix.anodes.some((i) => work.level[i] === X)) {
        full = scopedReading(exact ? null : channels.maybeNets);
      }
    }
    count(stats, everything ? "coldResolves" : "incrementalPasses");
    work.valid = true;
    // This pass's levels: the cache's, but where the readings agreed on
    // something else.
    const passOf = full
      ? (id) => (full.over.has(id) ? full.over.get(id) : levelOf(id))
      : levelOf;
    overStrong = full?.overStrong ?? null;

    // ④ The levels the next pass starts from.
    if (copy) {
      const pre = new Map();
      for (let i = 0; i < netIds.length; i++) pre.set(netIds[i], work.level[i]); // prettier-ignore
      let strong;
      if (full) {
        // (Several readings agreed: the strong map is its own, as the full
        // loop's `agreeing` makes it.)
        for (const [id, level] of full.over) pre.set(id, level);
        strong = strongMap();
      } else {
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
    } else if (sparse) {
      // What the hook shows, on top of what this pass resolved (the cache,
      // or the readings' agreement): its overrides, else that level. A
      // net is STALE where that is not the cache's — reconsidered next pass.
      const over = hooks.levelsDelta({ get: passOf }, { start: levels, state }); // prettier-ignore
      const moved = new Map(); // net → its new level
      const nextStale = new Set();
      const consider = (id) => {
        const level = over?.has(id) ? over.get(id) : passOf(id);
        if (level !== levels.get(id)) moved.set(id, level);
        if (level !== levelOf(id)) nextStale.add(id);
      };
      if (!changed) {
        for (const id of netIds) consider(id);
        for (const id of over?.keys() ?? []) if (!levels.has(id)) consider(id); // prettier-ignore
      } else {
        const ids = union(changed, stale);
        for (const id of full?.over.keys() ?? []) ids.add(id);
        for (const id of over?.keys() ?? []) ids.add(id);
        for (const id of ids) consider(id);
      }
      stale = nextStale;
      // (Where the hook changes nothing a pass's strong levels ARE its map,
      // as copy mode's were — `alias` — unless several readings agreed.)
      lastStrong = alias && over === null && !full ? levels : FROM_CACHE; // prettier-ignore
      if (!moved.size && !hooks?.busy?.()) {
        settled = true;
        break;
      }
      if (iterations >= cap) prev = new Map(levels);
      for (const id of moved.keys()) levels.set(id, moved.get(id));
      delta = new Set(moved.keys());
      if (ASSERT_DELTA) {
        for (const id of netIds) {
          const want = over?.has(id) ? over.get(id) : passOf(id);
          if (levels.get(id) !== want) throw new Error(`SPICE_ASSERT_DELTA: ${id} is ${levels.get(id)}, the hook shows ${want}`); // prettier-ignore
        }
      }
    } else {
      const moved = new Map(); // net → its new level
      if (changed) {
        const ids = union(changed, stale);
        for (const id of full?.over.keys() ?? []) ids.add(id);
        for (const id of ids) {
          const level = passOf(id);
          if (level !== levels.get(id)) moved.set(id, level);
        }
      } else {
        for (let i = 0; i < netIds.length; i++) {
          const level = passOf(netIds[i]);
          if (level !== levels.get(netIds[i])) moved.set(netIds[i], level);
        }
      }
      // (The readings' agreement is not the cache's: reconsidered next pass.)
      stale = full ? new Set(full.over.keys()) : NO_NETS;
      lastStrong = alias && !full ? levels : FROM_CACHE;
      if (!moved.size && !hooks?.busy?.()) {
        settled = true;
        break;
      }
      // The capped pass: the marking compares where it began with where it
      // ended — the nets it moved, in netIds order.
      if (iterations >= cap) capMoved = moved;
      if (snapAt) {
        for (const id of moved.keys()) {
          const level = moved.get(id);
          const was = levels.get(id);
          if (!snap.has(id)) {
            snap.set(id, was);
            differ++;
          } else {
            const at = snap.get(id);
            if (was === at) differ++;
            else if (level === at) differ--;
          }
        }
      }
      if (work.journal) noteLevels(work.journal, levels, moved.keys());
      for (const id of moved.keys()) levels.set(id, moved.get(id));
      delta = new Set(moved.keys());
      if (moves) for (const id of delta) moves.add(id);
      if (cyclic && iterations >= CYCLE_FROM) {
        if (snapAt && !differ) {
          const period = iterations - snapAt;
          const skip = Math.floor((cap - 1 - iterations) / period) * period;
          iterations += skip;
          count(stats, "skippedPasses", skip);
          cyclic = false;
          snapAt = 0;
        } else if (!snapAt || iterations - snapAt === power) {
          if (snapAt) power *= 2;
          snap.clear();
          differ = 0;
          snapAt = iterations;
        }
      }
    }
  }

  // The last pass's warnings: the certain channels', each
  // net's in netIds order, then the shorts its joins make.
  const warnings = [...work.warn.keys()]
    .sort((a, b) => ix.netIndex.get(a) - ix.netIndex.get(b))
    .map((id) => ({ type: work.warn.get(id), net: id }));
  warnings.push(...groupShorts(ctx, work.channels?.definite?.on ?? null));
  let marked = [];
  if (!settled) {
    count(stats, "cappedSolves");
    marked = capMoved
      ? [...capMoved.keys()].sort((a, b) => ix.netIndex.get(a) - ix.netIndex.get(b)) // prettier-ignore
      : ctx.netIds.filter((id) => prev.get(id) !== levels.get(id));
    if (work.journal) noteLevels(work.journal, levels, marked);
    for (const id of marked) levels.set(id, X);
    if (moves) for (const id of marked) moves.add(id);
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
    changed: moves,
    forced: work.channels?.forced ?? null,
    biased: work.channels?.biased ?? null,
  };
  if (lastStrong !== FROM_CACHE) {
    result.strong = lastStrong;
  } else {
    // Built only when read: of a tick's solves, only the last one's strong
    // levels are ever wanted (`assemble`), the others' only by an observer —
    // whose passes always build theirs. Read after a later solve has moved
    // the cache on, they would be that solve's, so that is refused.
    let built = null;
    const fresh = () => {
      if (work.version !== version) {
        throw new Error("incremental settle: strong levels read stale");
      }
    };
    Object.defineProperty(result, "strong", {
      enumerable: true,
      get() {
        if (built) return built;
        fresh();
        return (built = strongMap());
      },
    });
    // …and, for a tick's result (engine.js `assemble`), a builder of them
    // for whenever they are read: from the cache, or — once the next solve
    // on this work (the next tick's warm start) is about to change it in
    // place — from a copy of its strong levels it takes first
    // (`beforeChange`). Most ticks' strong levels are never read (an LED's
    // rule is their reader), and an array's copy is a twelfth of a map's.
    result.strongLater = () => {
      if (built) return () => built;
      fresh();
      const over = overStrong;
      let snap = null;
      work.beforeChange = () => {
        if (!built) snap = work.strong.slice();
      };
      const build = () => (built ??= strongOf(snap ?? work.strong, over));
      // One net's, read where the map would have it, never building the map
      // (engine.js `strongAt` — the lamps read a few hundred nets of thousands).
      build.at = (id) => {
        if (built) return built.get(id);
        if (over?.has(id)) return over.get(id);
        const i = ix.netIndex.get(id);
        return i === undefined ? undefined : (snap ?? work.strong)[i];
      };
      return build;
    };
  }
  return result;
}
