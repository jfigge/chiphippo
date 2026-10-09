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

// spice/bench-parts.js — where the bench parts' devices sit on a desk: each
// optocoupler, op-amp unit, linear regulator and electronic load as the
// device record spice/voltages.js solves (spice/analog-devices.js), its nets
// and the holes its leads are in. Read off the catalog's data (`def.
// optocoupler`, `def.opAmps`, `def.regulator`) and a load brick's
// terminals; pure and DOM-free, computed once per netlist.

import { partDef } from "../../catalog/index.js";
import { partPinAddresses } from "../../model/occupancy.js";
import { formatAddress } from "../../model/breadboard.js";
import { IR_SPEC } from "./analog-devices.js";

/** Each netlist's bench devices. */
const TOPOLOGY = new WeakMap();

/** An optocoupler's CTR, as a fraction, from its params (`ctr`, percent). */
export function optoCtr(def, params) {
  const ctr = Number(params?.ctr);
  return (ctr > 0 ? ctr : def.optocoupler.ctr) / 100;
}

/**
 * Every bench device on a desk: `[{key, comp, kind, chip, nodes, …nets,
 * …At}]` — `nodes` the fields that are nets, each with its hole in `<field>At`.
 * A device with a lead over nothing is left out.
 * @param {object} doc
 * @param {{netOfPoint: Map}} netlist
 */
export function benchDevices(doc, netlist) {
  const cached = TOPOLOGY.get(netlist);
  if (cached) return cached;
  const out = [];
  const netOf = (address) =>
    address ? (netlist.netOfPoint.get(address) ?? null) : null;
  for (const comp of doc.components ?? []) {
    const def = partDef(comp.ref);
    if (!def) continue;
    if (comp.kind === "load") {
      const posAt = formatAddress(comp.id, "pos");
      const negAt = formatAddress(comp.id, "neg");
      const [pos, neg] = [netOf(posAt), netOf(negAt)];
      if (!pos || !neg || pos === neg) continue;
      const mode = comp.params?.mode === "cr" ? "cr" : "cc";
      out.push({ key: comp.id, comp: comp.id, kind: "e", chip: false, nodes: ["pos", "neg"], pos, neg, posAt, negAt, mode, amps: Number(comp.params?.amps) || 0, ohms: Number(comp.params?.ohms) || 0 }); // prettier-ignore
      continue;
    }
    if (comp.board == null) continue;
    if (!def.optocoupler && !def.opAmps && !def.regulator) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const at = new Map(pins.map((p) => [p.pin, p.address]));
    const lead = (pin) => {
      const address = at.get(pin) ?? null;
      return { net: netOf(address), at: address };
    };
    /** A device of `fields` (name → pin), or null with a lead unplaced. */
    const device = (key, kind, fields, extra) => {
      const rec = { key, comp: comp.id, kind, chip: def.kind === "chip", nodes: Object.keys(fields), ...extra }; // prettier-ignore
      for (const [name, pin] of Object.entries(fields)) {
        const { net, at: hole } = lead(pin);
        if (!net) return null;
        rec[name] = net;
        rec[`${name}At`] = hole;
      }
      return rec;
    };
    if (def.optocoupler) {
      const { a, k, c, e } = def.optocoupler;
      const rec = device(comp.id, "o", { a, k, c, e }, { ctr: optoCtr(def, comp.params), spec: IR_SPEC }); // prettier-ignore
      if (rec) out.push(rec);
    } else if (def.opAmps) {
      const vcc = def.pins.find((p) => p.role === "vcc")?.n;
      const gnd = def.pins.find((p) => p.role === "gnd")?.n;
      def.opAmps.units.forEach((u, i) => {
        const rec = device(`${comp.id}#${i}`, "a", { out: u.out, inp: u.inp, inn: u.inn, vcc, gnd }, { amp: def.opAmps.model }); // prettier-ignore
        if (rec) out.push(rec);
      });
    } else if (def.regulator) {
      const r = def.regulator;
      const rec = device(comp.id, "g", { inp: r.pins.inp, ref: r.pins.ref, out: r.pins.out }, { reg: r.model(comp.params) }); // prettier-ignore
      if (rec) out.push(rec);
    }
  }
  TOPOLOGY.set(netlist, out);
  return out;
}
