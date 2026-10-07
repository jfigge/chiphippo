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

// spice/listeners.js — the input pins that read an RC node's curve, and when
// each next switches (features/spice-lite-2-plan.md §2). Pure and DOM-free.
//
// A pin READS a voltage against its own trip points: an ordinary input at its
// family's (spice/params.js `inputThresholds` — one point, or a Schmitt's
// two), a timing part's comparator at its silicon's (spice/silicon.js
// `sense`: a fixed voltage, or ANOTHER net's — a 555's THRES against CONT).
// spice/voltages.js reads every pin on a steady net once per pass. A pin
// whose reading an RC node moves is a LISTENER, read here instead, by its
// crossings: one ON a node's net; one a resistor or more away, in the node's
// network (a 4060's φI behind its Rs); and one whose trip point is a net the
// node moves (a 555's TRIG against the divider a capacitor on CONT holds).
// What it reads changes only when its voltage CROSSES a trip point — at a
// moment found in closed form, never stepped.
//
// A WINDOW (spice/silicon.js `sense`'s `window`: two comparators on one pin)
// is two listeners, one at each trip point — the upper under the pin's own
// key, the lower under `windowKey`'s — whose readings the pin reads together
// (`windowLevel`).
//
// Each listener's voltage, and its reference's, is stated in terms of the RC
// nodes (spice/voltages.js `affine`: a node's own net is itself; a net in a
// node's network a straight-line function of the nodes in it, between that
// network's corners; any other net its own voltage), so the difference it
// reads is a constant plus a sum of node curves. One curve — the commonest
// case by far — is inverted exactly (spice/rc-curve.js `crossingTime`); a sum
// is searched for its first root up to its curves' nearest corner.

import { readerKey } from "./voltages.js";
import { inputThresholds } from "./params.js";
import { CHIP_STATUS } from "../chip-status.js";
import { crossingTime, valueAt } from "./rc-curve.js";

/** Pin roles that READ a net. */
const LISTENING = new Set(["input", "io"]);

/** The key of a window pin's LOWER comparator (its upper is the pin's own). */
export const windowKey = (key) => `${key}<`;

/** What a window pin reads from its comparators — `above` the upper's
    reading, `aboveLow` the lower's: H above both, L below both, X between. */
export const windowLevel = (above, aboveLow) =>
  above ? "H" : aboveLow ? "X" : "L";

/**
 * Every listener on the desk: each powered part's reading pins (an analog
 * switch's controls included; a transistor's base or gate is part of its
 * device, and a switch's channel terminals carry rather than read) on or
 * against a node's network. `nodes` is the RC nodes' nets; `clusterOf` and
 * `nodeClusters` say which network a net is in and which networks hold a
 * node. Returns `{list, owned, viewNets, watch, windows}`: the listeners
 * (`{key, comp, pin, net, ref, up, down}` — `ref` the net a comparator is read
 * against, or null; `up`/`down` its trip points, against it or absolute); the
 * keys of the pins they are; each node-network net (not a rail) with the keys
 * reading it, whose shown level is theirs (a window's are not: what it reads
 * is no level); every net whose voltage they need; and each window pin's key
 * → its lower comparator's.
 * @param {object} ctx - sim/engine.js's context
 * @param {object} config - normalized spice config
 * @param {Set<string>|Map<string, *>} nodes
 * @param {Map<string, number>} clusterOf
 * @param {Set<number>} nodeClusters
 * @param {Set<string>} rails
 */
export function listenersOf(
  ctx,
  config,
  nodes,
  clusterOf,
  nodeClusters,
  rails,
) {
  // prettier-ignore
  const onNetwork = (net) =>
    net != null &&
    !rails.has(net) &&
    (nodes.has(net) || nodeClusters.has(clusterOf.get(net)));
  const list = [];
  const owned = new Set();
  const viewNets = new Map();
  const watch = new Set();
  const windows = new Map();
  for (const c of ctx.chips) {
    if (c.status !== CHIP_STATUS.OK || c.passive) continue;
    const vcc = ctx.chipStatus.get(c.comp.id)?.volts ?? c.supplyVolts ?? 5;
    const sense = c.def.logic?.sense ?? null;
    let ordinary = null;
    for (const p of c.def.pins) {
      const s = sense?.[p.n] ?? null;
      const reads = (LISTENING.has(p.role) && !(c.analogSwitch && p.role === "io")) || s; // prettier-ignore
      if (!reads) continue;
      const net = c.pinNet.get(p.n);
      if (!net) continue;
      let ref = null;
      let up;
      let down;
      if (s) {
        if (s.ref != null) {
          ref = typeof s.ref === "number" ? (c.pinNet.get(s.ref) ?? null) : `${c.comp.id}#${s.ref}`; // prettier-ignore
          if (ref == null) continue;
        }
        up = s.up ? s.up(vcc) : 0;
        down = s.down ? s.down(vcc) : up;
      } else {
        ordinary ??= inputThresholds(config, c.def, vcc);
        up = ordinary.up;
        down = ordinary.down;
      }
      if (!onNetwork(net) && !(ref && onNetwork(ref))) continue;
      const key = readerKey(c.comp.id, p.n);
      owned.add(key);
      watch.add(net);
      if (ref) watch.add(ref);
      if (s?.window) {
        const low = windowKey(key);
        list.push({ key, comp: c.comp.id, pin: p.n, net, ref, up, down: up });
        list.push({ key: low, comp: c.comp.id, pin: p.n, net, ref, up: down, down }); // prettier-ignore
        windows.set(key, low);
        continue;
      }
      list.push({ key, comp: c.comp.id, pin: p.n, net, ref, up, down });
      if (onNetwork(net)) {
        if (!viewNets.has(net)) viewNets.set(net, []);
        viewNets.get(net).push(key);
      }
    }
  }
  return { list, owned, viewNets, watch, windows };
}

/**
 * What one listener reads, given the voltage difference `d` it compares (its
 * net's, less its reference's) and what it read before — `true` above,
 * `false` below. Past a trip point it switches; between two (a Schmitt
 * trigger's, or a comparator's) it holds; a first reading between them takes
 * the nearer. `eps` is how far past a trip point a voltage must be to count.
 */
export function readingFor({ up, down }, d, before, eps) {
  if (before === undefined) {
    return d >= up ? true : d <= down ? false : d >= (up + down) / 2;
  }
  if (!before && d >= up + eps) return true;
  if (before && d <= down - eps) return false;
  return before;
}

/**
 * The difference a listener reads, as a constant and the node curves it
 * moves with: `{c, terms: Map<node net, coef>}`, d(t) = c + Σ coef·V_node(t).
 * `signal(net)` answers a net's own map (spice/voltages.js `affine`, or a
 * node's `{c0: 0, terms: {net: 1}}`); null when the listener's net or its
 * reference has no voltage.
 */
export function differenceOf(l, signal) {
  const a = signal(l.net);
  if (!a) return null;
  const terms = new Map(a.terms);
  let c = a.c0;
  if (l.ref) {
    const b = signal(l.ref);
    if (!b) return null;
    c -= b.c0;
    for (const [node, coef] of b.terms) {
      const sum = (terms.get(node) ?? 0) - coef;
      if (Math.abs(sum) > 1e-12) terms.set(node, sum);
      else terms.delete(node);
    }
  }
  return { c, terms };
}

/** A difference's value at `t`, its node curves read by `curveOf`. */
export function differenceAt({ c, terms }, t, curveOf) {
  let d = c;
  for (const [node, coef] of terms) d += coef * curveOf(node, t);
  return d;
}

/** How many points the search for a sum's first root samples. */
const SAMPLES = 96;

/**
 * When, after `t`, a difference first reaches `target` going the way `dir`
 * says (+1 up, −1 down) — or Infinity. `nodeAt(node)` is the node as it
 * stands: `{curve}` while it runs along one, `{value}` while something holds
 * it; `horizon` the time the search may stop at (its curves' nearest corner:
 * past it they are other curves, and the corner comes first anyway). One
 * moving curve is inverted exactly; a sum is sampled and bisected.
 * @param {{c: number, terms: Map<string, number>}} diff
 * @param {number} target
 * @param {1|-1} dir
 * @param {number} t
 * @param {(node: string) => {curve?: object, value?: number}|null} nodeAt
 * @param {number} horizon
 * @param {number} eps - how far past the target the difference must get
 */
export function firstCrossing(diff, target, dir, t, nodeAt, horizon, eps) {
  let c = diff.c - target;
  const moving = [];
  for (const [node, coef] of diff.terms) {
    const n = nodeAt(node);
    if (!n) continue;
    const still = !n.curve || (!n.curve.rate && !Number.isFinite(n.curve.tau));
    if (still) c += coef * (n.value ?? valueAt(n.curve, t));
    else moving.push({ curve: n.curve, coef });
  }
  if (!moving.length) return Number.POSITIVE_INFINITY;
  if (moving.length === 1) {
    // d = c + coef·V(t): the node must reach −c/coef, and get past it.
    const [{ curve, coef }] = moving;
    const v = -c / coef;
    if (!curve.rate) {
      // An exponential must clear the point in the right direction.
      const far = (curve.vInf - v) * Math.sign(coef) * dir;
      if (!(far > eps / Math.abs(coef))) return Number.POSITIVE_INFINITY;
    } else if (!(curve.rate * Math.sign(coef) * dir > 0)) {
      return Number.POSITIVE_INFINITY;
    }
    return t + crossingTime(curve, t, v);
  }
  const at = (u) => {
    let d = c;
    for (const { curve, coef } of moving) d += coef * valueAt(curve, u);
    return d * dir;
  };
  if (at(t) >= 0) return Number.POSITIVE_INFINITY;
  let end = horizon;
  if (!Number.isFinite(end)) {
    let span = 0;
    for (const { curve } of moving) {
      span = Math.max(span, curve.rate ? 0 : curve.tau * 50);
    }
    end = t + (span > 0 ? span : 1);
  }
  let prev = t;
  for (let i = 1; i <= SAMPLES; i++) {
    // Denser near `t`: the first crossing of a sum of exponentials is where
    // its fastest term still moves.
    const u = t + (end - t) * (i / SAMPLES) ** 3;
    if (at(u) >= eps) {
      let lo = prev;
      let hi = u;
      for (
        let k = 0;
        k < 200 && hi - lo > 1e-15 * Math.max(1, Math.abs(hi));
        k++
      ) {
        // prettier-ignore
        const mid = (lo + hi) / 2;
        if (at(mid) >= 0) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    prev = u;
  }
  return Number.POSITIVE_INFINITY;
}
