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

// rc-trace.js — the ONE way a timing part reads its R and C off the wiring.
// Pure and DOM-free.
//
// A capacitor joins no net: it is an electrical non-connect everywhere,
// across the rails included (a charged capacitor blocks DC, so that is
// honest), and a resistor stays a weak coupler, exactly as before. What a
// timing part needs is not a connection but a READING: "from my pin, across a
// capacitor, which net is on the far side, and how many farads did it take to
// get there?" — and the same for a resistor and its ohms. This module answers
// both, once, for every part that keeps time (the 555, the CD4047B/4060B/
// 4098B/4528B/4538B/4541B); each part then decides for itself what its wiring
// means, by its own datasheet.
//
// Components in PARALLEL between the same two nets combine, because that is
// arithmetic and not interpretation: capacitances add, conductances add. So do
// resistors in SERIES through a BARE net — one that holds nothing but
// resistive parts' leads (a resistor, a pot) and wires: a pot in series with
// the 1 kΩ that stops it shorting a 555 at zero is one resistance from DISCH,
// whatever the pot is set to (`resistance` solves the network of bare nets
// between the two ends, so any series-parallel mix reads exactly). A bare
// network that also reaches some third net is not followed — current could
// leave by it, so it is no resistance between the two, and a timing part
// reports wiring it does not recognise rather than guess at a network it was
// never drawn for.

import { partDef } from "../catalog/index.js";
import { EARTHED_AC } from "../catalog/ac-parts.js";
import { floatingGrounds } from "./floating-grounds.js";
import { partPinAddresses } from "../model/occupancy.js";
import { formatAddress } from "../model/breadboard.js";
import { drivesPins } from "../model/integration.js";
import { isTimed } from "./chip-eval.js";
import { regulatorFacts, regulatorSupplies } from "./regulators.js";

/**
 * @typedef {object} TraceLink
 * @property {string} id      the component's id
 * @property {number} value   farads (a capacitor) or ohms (a resistor)
 * @property {string|null} far  the net on the other side, or null when that
 *   lead floats
 * @property {boolean} [polarized]  an electrolytic
 * @property {string|null} [plus]   which net its + lead is in
 */

/**
 * Index a document's capacitors and resistors by the nets they touch.
 * @param {{components?: Array}} doc
 * @param {{netOfPoint: Map, nets: Map}} netlist
 */
/** A part's value as a number it can time by: a stored number, finite. Text
    the value parser refused is kept as typed (`"0x10"`, `"Infinity"`) and
    names no value — read through `Number`, it timed a 555 on 16 F, or on
    Infinity, a schedule walked forever. */
const valueOf = (x) => (typeof x === "number" && Number.isFinite(x) ? x : NaN);

export function rcTrace(doc, netlist) {
  const netOf = (address) =>
    address ? (netlist.netOfPoint.get(address) ?? null) : null;
  const plus = new Set(); // nets carrying a PSU `+`
  const plusVolts = new Map(); // a `+` net → the highest supply on it, volts
  const minus = new Set(); // nets carrying a PSU `−`
  // A floating circuit's ground (an AC adapter's), a − like a PSU's.
  for (const net of floatingGrounds(doc, netlist).values()) minus.add(net);
  const caps = new Map(); // netId → TraceLink[]
  const res = new Map(); // netId → TraceLink[]
  // Nets a lead of a part that COUNTS AS A CONNECTION sits in (a capacitor,
  // a diode, an inductor, a transistor — catalog/discretes.js): a pin there
  // is wired whether or not that part conducts right now.
  const byPart = new Set();
  // Every resistive part (a `weakBridges` def: a resistor, a pot), for
  // telling a BARE net — nothing in it but their leads.
  const resistive = new Set();
  // Nets a planted signal flag, or an Input's or data bus's tag, drives:
  // off-board stimulus is a connection like a wire is, though the netlist
  // counts neither.
  const flagged = new Set();
  for (const sig of doc.signals ?? []) {
    const net = netOf(sig?.flag?.anchor);
    if (net) flagged.add(net);
  }
  for (const element of doc.integrations ?? []) {
    if (!drivesPins(element)) continue;
    for (const [key, tag] of Object.entries(element.tags ?? {})) {
      const net = key === "T" ? null : netOf(tag?.anchor);
      if (net) flagged.add(net);
    }
  }
  const push = (map, net, link) => {
    if (!net) return;
    if (!map.has(net)) map.set(net, []);
    map.get(net).push(link);
  };

  for (const comp of doc.components ?? []) {
    const def = partDef(comp.ref);
    if (!def) continue;
    if (comp.kind === "psu" && def.terminals) {
      for (const t of def.terminals) {
        const net = netOf(formatAddress(comp.id, t.id));
        if (net) (t.id === "+" ? plus : minus).add(net);
        const volts = Number(comp.params?.volts);
        if (net && t.id === "+" && volts > 0) {
          plusVolts.set(net, Math.max(volts, plusVolts.get(net) ?? 0));
        }
      }
      continue;
    }
    // The mains' N is a ground, as a PSU's − is
    // (spice/ac-supplies.js).
    if (EARTHED_AC[comp.kind]) {
      const net = netOf(formatAddress(comp.id, EARTHED_AC[comp.kind].neutral));
      if (net) minus.add(net);
      continue;
    }
    if (comp.board == null) continue;
    const isCap = Boolean(def.capacitor);
    const isRes = typeof def.weakBridges === "function";
    const connects = def.countsAsConnection === true;
    if (!isCap && !isRes && !connects) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const netOfPin = new Map(pins.map((p) => [p.pin, netOf(p.address)]));
    if (connects) {
      for (const net of netOfPin.values()) if (net) byPart.add(net);
    }
    if (isCap) {
      const farads = valueOf(comp.params?.farads);
      if (!(farads > 0)) continue;
      const a = netOfPin.get(1) ?? null;
      const b = netOfPin.get(2) ?? null;
      const polarized = def.capacitor.polarized === true;
      // An electrolytic's + is pin 1 (parts.js).
      const plusNet = polarized ? a : null;
      push(caps, a, { id: comp.id, value: farads, far: b, polarized, plus: plusNet }); // prettier-ignore
      push(caps, b, { id: comp.id, value: farads, far: a, polarized, plus: plusNet }); // prettier-ignore
    }
    if (isRes) {
      resistive.add(comp.id);
      // Each coupled pair is the part's `ohms` — unless the pair states its
      // own (a third element): a potentiometer's two sides divide one track.
      for (const [pa, pb, own] of def.weakBridges(comp.params)) {
        const ohms = valueOf(own ?? comp.params?.ohms);
        if (!(ohms > 0)) continue;
        const a = netOfPin.get(pa) ?? null;
        const b = netOfPin.get(pb) ?? null;
        push(res, a, { id: comp.id, value: ohms, far: b });
        push(res, b, { id: comp.id, value: ohms, far: a });
      }
    }
  }

  // The supplies a timing part reads, a regulator's OUT among them (below,
  // once the trace that reads an LM317's R1/R2 is built).
  const fedPlus = new Set();
  const fedVolts = new Map();

  /** `to` as a predicate over a far net: a net id, or a function. */
  const matcher = (to) =>
    typeof to === "function" ? to : (net) => net != null && net === to;

  /** A net that holds nothing but resistive parts' leads and wires — no
      pin of anything else, no terminal, no capacitor, no flag, no rail: a
      point a series chain only passes through. */
  const bare = (net) => {
    const info = net ? netlist.nets.get(net) : null;
    if (!info || plus.has(net) || minus.has(net) || caps.has(net) || flagged.has(net)) return false; // prettier-ignore
    return info.counts.terminals === 0 && info.pins.every((p) => resistive.has(p.componentId)); // prettier-ignore
  };

  /**
   * The conductance from `net` to the nets `match` accepts through BARE nets
   * (series chains and any network of them), siemens: each network of bare
   * nets `net`'s resistors reach, solved with `net` at 1 V and the far ends
   * at 0 — skipped where it reaches any third net.
   */
  const throughBare = (net, match) => {
    const links = (x) => res.get(x) ?? [];
    const seen = new Set();
    let total = 0;
    for (const first of links(net)) {
      const start = first.far;
      if (start === net || seen.has(start) || match(start) || !bare(start)) continue; // prettier-ignore
      // The network of bare nets through `start`.
      const nodes = [start];
      const index = new Map([[start, 0]]);
      let foreign = false;
      for (let k = 0; k < nodes.length; k++) {
        for (const l of links(nodes[k])) {
          const y = l.far;
          if (y == null || y === nodes[k] || y === net || match(y)) continue;
          if (!bare(y)) foreign = true;
          else if (!index.has(y)) {
            index.set(y, nodes.length);
            nodes.push(y);
          }
        }
      }
      for (const x of nodes) seen.add(x);
      if (foreign) continue;
      // Nodal: Σ g·(v_i − v_far) = 0 at each bare net.
      const n = nodes.length;
      const a = nodes.map(() => new Float64Array(n));
      const b = new Float64Array(n);
      nodes.forEach((x, i) => {
        for (const l of links(x)) {
          const y = l.far;
          if (y == null || y === x) continue;
          const g = 1 / l.value;
          a[i][i] += g;
          if (y === net) b[i] += g;
          else if (!match(y)) a[i][index.get(y)] -= g;
        }
      });
      const v = solveLinear(a, b);
      if (!v) continue;
      for (const l of links(net)) {
        const i = index.get(l.far);
        if (i != null) total += (1 - v[i]) / l.value;
      }
    }
    return total;
  };

  const trace = {
    /** "+" for a net a PSU's + reaches, "-" for its −, else null. */
    rail(net) {
      if (!net) return null;
      if (plus.has(net)) return "+";
      if (minus.has(net)) return "-";
      return null;
    },
    /** The supply on a `+` net, volts (the highest, should two PSUs meet on
        it) — or null for any other net. What a part whose timing depends on
        its supply (the CD4528B's ln(VDD − VSS)) reads its VDD pin with. A
        regulator's OUT is one (`fedPlus`, above). */
    supplyVolts(net) {
      return (net && fedVolts.get(net)) ?? null;
    },
    /** A predicate matching any net on one supply ("+" — a regulator's OUT
        among them — or "-"). */
    toRail(sign) {
      return (net) => net != null && (sign === "+" ? fedPlus : minus).has(net);
    },
    /** Every capacitor touching `net`, each with its far side. */
    capacitors(net) {
      return net ? (caps.get(net) ?? []) : [];
    },
    /** Every resistor element touching `net`, each with its far side. */
    resistors(net) {
      return net ? (res.get(net) ?? []) : [];
    },
    /** Does any capacitor lead sit in `net`? */
    hasCapacitor(net) {
      return Boolean(net && caps.has(net));
    },
    /**
     * Does a lead of a part that counts as a connection sit in `net`
     * (`def.countsAsConnection` — every one of the discretes)? The
     * question every floating-input check asks before calling a pin
     * unconnected: a pin whose only company is a capacitor, a reversed diode
     * or an off transistor is WIRED, whatever level it settles at.
     */
    connectedByPart(net) {
      return Boolean(net && byPart.has(net));
    },
    /**
     * The capacitance straight from `net` to `to` (a net id or a predicate
     * over far nets), parallel capacitors summed — 0 when there is none. A
     * capacitor with both leads in one net (shorted) counts for nothing.
     */
    capacitance(net, to) {
      const match = matcher(to);
      let total = 0;
      for (const link of this.capacitors(net)) {
        if (link.far !== net && match(link.far)) total += link.value;
      }
      return total;
    },
    /**
     * The resistance from `net` to `to`: parallel resistors combined
     * (1/R = Σ 1/Rᵢ), and those in series through bare nets
     * (`throughBare`) — or null when no resistor runs there.
     */
    resistance(net, to) {
      const match = matcher(to);
      let conductance = 0;
      for (const link of this.resistors(net)) {
        if (link.far !== net && match(link.far)) conductance += 1 / link.value;
      }
      if (net) conductance += throughBare(net, match);
      return conductance > 0 ? 1 / conductance : null;
    },
    /** Does `net` reach anything beyond a single point — a wire, a terminal,
        a second pin (the question the build guide asks of a power pin) — or
        have a signal flag or an Input's tag planted in it? */
    connected(net) {
      const info = net ? netlist.nets.get(net) : null;
      if (!info) return false;
      if (flagged.has(net)) return true;
      const { counts } = info;
      return counts.wires > 0 || counts.terminals > 0 || counts.pins > 1;
    },
  };

  // To a timing part a regulator's OUT is a supply `+` as a PSU's is, while
  // its IN feeds it (sim/regulators.js — what the logic engine powers its
  // chips from): a 555 on a 7805's rail read "no resistor to VCC" and stood
  // LOW. Not a RAIL (`rail`): under Spice Lite the solve holds it. An LM317's
  // volts are read off R1/R2 through THIS trace, as the engine reads them —
  // without it an R2 of two resistors in series set nothing, and a 555 the
  // engine powered off its rail read "no resistor to VCC".
  const fed = new Map([...plusVolts].map(([net, v]) => [net, [v]]));
  for (const net of plus) if (!fed.has(net)) fed.set(net, []);
  regulatorSupplies(regulatorFacts(doc, netlist, trace), fed, minus);
  for (const [net, volts] of fed) {
    fedPlus.add(net);
    if (volts.length) fedVolts.set(net, Math.max(...volts));
  }
  return trace;
}

/** Solve `a·x = b` (a small dense system, Gaussian elimination with partial
    pivoting), or null when it is singular. */
function solveLinear(a, b) {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r; // prettier-ignore
    if (!(Math.abs(m[p][c]) > 0)) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / m[c][c];
      if (f) for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let sum = m[r][n];
    for (let k = r + 1; k < n; k++) sum -= m[r][k] * x[k];
    x[r] = sum / m[r][r];
  }
  return x;
}

/**
 * A trace seen from ONE part: the trace's questions plus `net(pin)`, that
 * part's pin → net. What every timing part's `logic.timing` is handed.
 * @param {ReturnType<typeof rcTrace>} trace
 * @param {Map<number, string|null>} pinNet
 */
export function timingProbe(trace, pinNet) {
  return Object.assign(Object.create(trace), {
    net: (pin) => pinNet.get(pin) ?? null,
  });
}

/**
 * One timed part's reading of its own wiring, outside a run — what its
 * Properties card shows before anything has been simulated. The same `timing`
 * the engine takes each tick (sim/engine.js buildContext), so the two cannot
 * read one circuit two ways. Null for a part that keeps no time.
 * @param {object} doc
 * @param {{netOfPoint: Map, nets: Map}} netlist
 * @param {object} comp
 * @param {ReturnType<typeof rcTrace>} [trace]
 */
export function timingOf(doc, netlist, comp, trace = rcTrace(doc, netlist)) {
  const def = partDef(comp?.ref);
  if (!isTimed(def)) return null;
  const pins = partPinAddresses(doc, comp);
  if (!pins) return null;
  const pinNet = new Map(
    pins.map(({ pin, address }) => [
      pin,
      address ? (netlist.netOfPoint.get(address) ?? null) : null,
    ]),
  );
  return def.logic.timing(timingProbe(trace, pinNet));
}
