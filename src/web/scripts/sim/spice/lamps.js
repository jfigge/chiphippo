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

// spice/lamps.js — the LEDs, diodes and resistive elements of a desk as the
// voltage solve sees them (features/spice-lite-leds.md). Pure and DOM-free.
//
// The digital engine asks only whether an LED's legs are strongly driven (a
// supply or an output on both sides burns it; a resistor anywhere saves it).
// Spice Lite asks what a bench would: how many milliamps flow. Every LED,
// display segment, diode and Zener is a JUNCTION branch of the one network
// solve (spice/voltages.js, through spice/network.js), and every resistor,
// pot side and rnet9 element a resistive one — this file reads them off the
// desk once per netlist (`lampTopology`), with the HOLE each lead is in:
//
//   · an LED or a segment (spice/leds.js: nothing below its knee, then its
//     dynamic resistance — each colour its own datasheet's), and a character
//     LCD's backlight (its colour's LED behind the board's resistor);
//   · a diode or a Zener (spice/diodes.js: the one common silicon junction,
//     a Zener also conducting backwards past its voltage);
//   · a resistive element, its ohms (a pot's side its own share).
//
// What the solve then says of each junction — its current, the voltage
// across it — is its verdict (lit, how bright, overdriven, reversed, and
// BURNT past its maximum junction temperature: opened, and the solve run
// again without it, until nothing more burns — spice/engine.js), and the
// current through every lead is what the probe reads out.
//
// Also here: what a HIGH from a bench SOURCE is (`sourceVolts`) — a clock
// brick or a signal flag, an ideal source the solve holds a net at.

import { partDef } from "../../catalog/index.js";
import { partPinAddresses } from "../../model/occupancy.js";
import { backlightSpec, ledSpec } from "./leds.js";
import { diodeSpec } from "./diodes.js";
import { resistorKey } from "./supply.js";

// The Newton machinery is the shared one; the solver's own entry points stay
// importable from here, where they began.
export { gaussSolve } from "./network.js";

/** Each netlist's lamp topology (`lampTopology`), for the reason
    spice/supply.js caches its own: a netlist lives exactly as long as the
    facts below. */
const TOPOLOGY = new WeakMap();

/**
 * What a HIGH from a BENCH SOURCE is, volts, by the net it drives — an ideal
 * source that draws nothing (Jason, 2026-10-07):
 *   · a clock brick: the supply on its own `vcc` terminal (an unpowered one
 *     drives no net, and is not here);
 *   · a signal flag, or a serial Input tag: the LOWEST supply among the chips
 *     reading that net, the one level every one of them can take (a flag on
 *     a 5 V circuit is a 5 V source on a desk that also holds 12 V) — null
 *     when no chip reads it, for the caller's own fallback.
 * @param {object} ctx - sim/engine.js's context
 * @returns {Map<string, number|null>}
 */
export function sourceVolts(ctx) {
  const out = new Map();
  for (const clk of ctx.clocks ?? []) {
    if (clk.outNet) out.set(clk.outNet, clk.volts ?? null);
  }
  const signalNets = new Set((ctx.signals ?? []).map((sig) => sig.net).filter(Boolean)); // prettier-ignore
  if (!signalNets.size) return out;
  const lowest = new Map(); // net → the lowest reader's supply
  for (const c of ctx.chips ?? []) {
    const volts = ctx.chipStatus?.get(c.comp.id)?.volts ?? c.supplyVolts;
    if (!(volts > 0)) continue;
    for (const p of c.def.pins) {
      if (p.role !== "input" && p.role !== "io") continue;
      const net = c.pinNet.get(p.n);
      if (!signalNets.has(net)) continue;
      lowest.set(net, Math.min(lowest.get(net) ?? Infinity, volts));
    }
  }
  for (const net of signalNets) {
    if (!out.has(net)) out.set(net, lowest.get(net) ?? null);
  }
  return out;
}

/** The key one junction is reported under: an LED's component id, or a
    display's id and segment (`c4#a`). */
export function junctionKey(compId, segId = null) {
  return segId == null ? compId : `${compId}#${segId}`;
}

/**
 * Every LED junction and every resistive element on a desk, by net — what a
 * run cannot change. Computed once per netlist.
 * @param {object} doc
 * @param {{netOfPoint: Map}} netlist
 */
export function lampTopology(doc, netlist) {
  const cached = TOPOLOGY.get(netlist);
  if (cached) return cached;
  const netOf = (address) =>
    address ? (netlist.netOfPoint.get(address) ?? null) : null;
  const junctions = []; // {key, comp, seg, spec, anode, cathode, anodeAt, cathodeAt}
  const resistors = []; // {key, a, b, aAt, bAt, ohms}
  const outputsAt = new Map(); // chip id → pin → the hole its lead is in
  for (const comp of doc.components ?? []) {
    const def = partDef(comp.ref);
    if (!def || comp.board == null) continue;
    const led = typeof def.polarity === "function" && Boolean(def.colors);
    const segments = Array.isArray(def.segments) ? def.segments : null;
    const resistive = typeof def.weakBridges === "function";
    const drives = Boolean(def.logic) && def.pins?.some((p) => p.role === "output" || p.role === "io"); // prettier-ignore
    const diode = Boolean(def.diode) && typeof def.oneWayBridges === "function"; // prettier-ignore
    const backlight = def.backlight ?? null;
    if (!led && !segments && !diode && !resistive && !drives && !backlight) continue; // prettier-ignore
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const at = new Map(pins.map((p) => [p.pin, p.address]));
    if (drives) outputsAt.set(comp.id, at);
    const junction = (
      key,
      seg,
      anodePin,
      cathodePin,
      isDiode = false,
      spec = null,
    ) => {
      // prettier-ignore
      const anodeAt = at.get(anodePin) ?? null;
      const cathodeAt = at.get(cathodePin) ?? null;
      junctions.push({
        key,
        comp: comp.id,
        seg,
        diode: isDiode,
        spec: spec ?? (isDiode ? diodeSpec(def, comp.params) : ledSpec(comp.params?.color)), // prettier-ignore
        anode: netOf(anodeAt),
        cathode: netOf(cathodeAt),
        anodeAt,
        cathodeAt,
      });
    };
    if (diode) {
      // A diode or Zener (spice/diodes.js): its one-way pair is anode →
      // cathode.
      for (const [anodePin, cathodePin] of def.oneWayBridges(comp.params)) {
        junction(junctionKey(comp.id), null, anodePin, cathodePin, true);
      }
    } else if (led) {
      const { anodePin, cathodePin } = def.polarity(comp.params);
      junction(junctionKey(comp.id), null, anodePin, cathodePin);
    } else if (segments) {
      for (const seg of segments) {
        junction(junctionKey(comp.id, seg.id), seg.id, seg.anodePin, seg.cathodePin); // prettier-ignore
      }
    }
    if (backlight) {
      // A character LCD's backlight: its colour's LED behind the board's
      // resistor (catalog/parts.js LCD_BACKLIGHT).
      const { anodePin, cathodePin, ohms } = backlight;
      junction(junctionKey(comp.id, "backlight"), "backlight", anodePin, cathodePin, false, backlightSpec(comp.params?.color, ohms)); // prettier-ignore
    }
    if (resistive) {
      for (const [pa, pb, own] of def.weakBridges(comp.params)) {
        const ohms = Number(own ?? comp.params?.ohms);
        const aAt = at.get(pa) ?? null;
        const bAt = at.get(pb) ?? null;
        const a = netOf(aAt);
        const b = netOf(bAt);
        if (!(ohms > 0) || !a || !b || a === b) continue;
        resistors.push({ key: resistorKey(aAt, bAt), a, b, aAt, bAt, ohms });
      }
    }
  }
  const topo = { junctions, resistors, outputsAt };
  TOPOLOGY.set(netlist, topo);
  return topo;
}
