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
// arithmetic and not interpretation: capacitances add, conductances add. A
// path THROUGH an intermediate net (two resistors in series) is deliberately
// not followed — a timing part reports wiring it does not recognise rather
// than guess at a network it was never drawn for.

import { partDef } from "../catalog/index.js";
import { partPinAddresses } from "../model/occupancy.js";
import { formatAddress } from "../model/breadboard.js";
import { isTimed } from "./chip-eval.js";

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
export function rcTrace(doc, netlist) {
  const netOf = (address) =>
    address ? (netlist.netOfPoint.get(address) ?? null) : null;
  const plus = new Set(); // nets carrying a PSU `+`
  const plusVolts = new Map(); // a `+` net → the highest supply on it, volts
  const minus = new Set(); // nets carrying a PSU `−`
  const caps = new Map(); // netId → TraceLink[]
  const res = new Map(); // netId → TraceLink[]
  // Nets a lead of a part that COUNTS AS A CONNECTION sits in (a capacitor,
  // a diode, an inductor, a transistor — catalog/discretes.js): a pin there
  // is wired whether or not that part conducts right now.
  const byPart = new Set();
  // Nets a planted signal flag or an Arduino Input's tag drives: off-board
  // stimulus is a connection like a wire is, though the netlist counts neither.
  const flagged = new Set();
  for (const sig of doc.signals ?? []) {
    const net = netOf(sig?.flag?.anchor);
    if (net) flagged.add(net);
  }
  for (const element of doc.integrations ?? []) {
    if (element?.kind !== "input") continue;
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
      const farads = Number(comp.params?.farads);
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
      // Each coupled pair is the part's `ohms` — unless the pair states its
      // own (a third element): a potentiometer's two sides divide one track.
      for (const [pa, pb, own] of def.weakBridges(comp.params)) {
        const ohms = Number(own ?? comp.params?.ohms);
        if (!(ohms > 0)) continue;
        const a = netOfPin.get(pa) ?? null;
        const b = netOfPin.get(pb) ?? null;
        push(res, a, { id: comp.id, value: ohms, far: b });
        push(res, b, { id: comp.id, value: ohms, far: a });
      }
    }
  }

  /** `to` as a predicate over a far net: a net id, or a function. */
  const matcher = (to) =>
    typeof to === "function" ? to : (net) => net != null && net === to;

  return {
    /** "+" for a net a PSU's + reaches, "-" for its −, else null. */
    rail(net) {
      if (!net) return null;
      if (plus.has(net)) return "+";
      if (minus.has(net)) return "-";
      return null;
    },
    /** The supply on a `+` net, volts (the highest, should two PSUs meet on
        it) — or null for any other net. What a part whose timing depends on
        its supply (the CD4528B's ln(VDD − VSS)) reads its VDD pin with. */
    supplyVolts(net) {
      return (net && plusVolts.get(net)) ?? null;
    },
    /** A predicate matching any net on one rail ("+" or "-"). */
    toRail(sign) {
      return (net) => net != null && (sign === "+" ? plus : minus).has(net);
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
     * The resistance straight from `net` to `to`, parallel resistors combined
     * (1/R = Σ 1/Rᵢ) — or null when no resistor runs there.
     */
    resistance(net, to) {
      const match = matcher(to);
      let conductance = 0;
      for (const link of this.resistors(net)) {
        if (link.far !== net && match(link.far)) conductance += 1 / link.value;
      }
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
}

/**
 * A trace seen from ONE part: the trace's questions plus `net(pin)`, that
 * part's pin → net. What every timing part's `logic.timing` is handed.
 * `extra` carries what the engine says about HOW to time: Spice Light hands
 * `{curves: true}`, asking a part that can to time by its capacitor's real
 * charge curve (sim/spice/rc-curve.js) rather than its datasheet constant.
 * @param {ReturnType<typeof rcTrace>} trace
 * @param {Map<number, string|null>} pinNet
 * @param {object|null} [extra]
 */
export function timingProbe(trace, pinNet, extra = null) {
  return Object.assign(Object.create(trace), extra, {
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
