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

// part-nets.js — the desk as a PART-LEVEL netlist: which part pins and brick
// terminals each electrical net joins, with every hole, wire and rail left out.
//
// It is the one projection two consumers share: the AI desk review's brief
// (ai/desk-brief.js, which prints it for the model) and the exporters under
// model/export/ (which hand it to KiCad and Digital). Both want the circuit as
// a schematic sees it — parts and the nets between them — and neither may
// derive it a second way, since two derivations can disagree about a floating
// lead or a brick terminal and the two outputs would then describe different
// circuits.
//
// Pins resolve through `partPinAddresses`, exactly as the netlist seated them:
// a rotated part's bent lead may land on a NEIGHBOURING strip, and a lead over
// nothing resolves to null and joins no net at all.

import { partDef } from "../catalog/index.js";
import { partPinAddresses } from "./occupancy.js";

/**
 * @typedef {object} PartNetMember
 * @property {object} comp               the document component
 * @property {object|null} def           its catalog def
 * @property {number} [pin]              a seated part's pin number, or…
 * @property {string} [terminal]         …a desk brick's terminal id
 */

/**
 * Every part pin and brick terminal on the desk, grouped by the net it joins —
 * in document order (component by component, a brick's terminals then a
 * seated part's pins), so the same desk always lists the same way.
 *
 * @param {{components?: Array}} doc - a plain desk document.
 * @param {{netOfPoint: Map<string,string>}} netlist - from buildNetlist.
 * @returns {Map<string, PartNetMember[]>} net id → its members.
 */
export function partNets(doc, netlist) {
  const byNet = new Map();
  const add = (netId, member) => {
    if (netId == null) return;
    if (!byNet.has(netId)) byNet.set(netId, []);
    byNet.get(netId).push(member);
  };

  for (const comp of doc.components ?? []) {
    const def = partDef(comp.ref) ?? null;
    for (const t of def?.terminals ?? []) {
      add(netlist.netOfPoint.get(`${comp.id}.${t.id}`), {
        comp,
        def,
        terminal: t.id,
      });
    }
    if (!def?.pins?.length) continue;
    for (const p of partPinAddresses(doc, comp) ?? []) {
      if (p.address == null) continue; // a floating lead is on no net
      add(netlist.netOfPoint.get(p.address), { comp, def, pin: p.pin });
    }
  }
  return byNet;
}
