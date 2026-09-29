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

// export-netlist.js — the ONE model every exporter reads (Feature 390).
//
// A desk is holes, strips, wires and bent leads; an export is PARTS and the
// NETS between them, which is what a schematic tool and a logic simulator both
// speak. This is that projection, done once, so KiCad and Digital can never
// disagree about which pins share a net, what a net is called, or which part
// is U3:
//
//   · connectivity by WIRING ALONE (`buildNetlist(…, {bridges: false})`): a
//     closed switch is a part in a schematic, not a wire — exporting it as a
//     short would bake the switch's current position into the circuit;
//   · every part pin and brick terminal as a PORT, on its net or on none (a
//     pin alone on its net is a no-connect, and says so);
//   · every net NAMED — the user's name first, then a bus member's name
//     (`D3` of bus `D[7:0]`), then a power rail's (`+5V`, `GND`), and only
//     then a plain `N<k>` in reading order. Names are sanitized to what both
//     targets accept and de-duplicated, because two nets sharing a label in a
//     schematic ARE one net;
//   · every part DESIGNATED (designators.js).
//
// Pure and DOM-free: the same document always yields the same model.

import { partDef } from "../../catalog/index.js";
import { buildNetlist } from "../../sim/netlist.js";
import { partNets } from "../part-nets.js";
import { netPolarity } from "../schematic-layout.js";
import { parseBusName } from "../desk-doc.js";
import { assignDesignators } from "./designators.js";

/**
 * A net name both targets accept. A KiCad label is MARKUP (`~{…}` overbars,
 * `_{…}` subscripts, `[…]` buses, `{…}` groups) and a space splits a bus
 * group, so anything but word characters and a few safe marks becomes `_`,
 * and a bit index in brackets folds into the name (`D[3]` → `D3`).
 *
 * An active-low name — a leading `/`, `~` or `!`, a trailing overbar — must
 * not lose that on the way, or `/CLR` and `CLR` would export as the same net.
 * It becomes an `n` prefix, the convention KiCad's own libraries use
 * (`nRESET`). A trailing `'` is kept as it is: it is as often a PRIME (the
 * '595's QH') as a complement, and a label can carry it.
 */
export function safeNetName(name) {
  let text = String(name ?? "").trim();
  let low = false;
  if (/^[/~!]/.test(text)) {
    low = true;
    text = text.slice(1);
  }
  if (/̄$/.test(text)) {
    low = true;
    text = text.slice(0, -1);
  }
  text = text
    .replace(/\[(\d+)\]/g, "$1")
    .replace(/[^A-Za-z0-9_+\-.']+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!text) return "";
  return low ? `n${text}` : text;
}

/** The label a PSU's rail goes by: `+5V`, `+3V`, `+12V`. */
function railName(volts) {
  return `+${Number.isFinite(volts) ? volts : 5}V`;
}

/**
 * @typedef {object} ExportPort
 * @property {string} key       pin number as a string, or a brick terminal id
 * @property {number} [pin]
 * @property {string} [terminal]
 * @property {string} name      the pin's catalog name (a terminal's id)
 * @property {string} role      the pin's catalog role; a terminal's is derived
 * @property {string|null} net  the net id, or null for a no-connect
 */

/**
 * @typedef {object} ExportPart
 * @property {string} id            the document's component id
 * @property {object} comp
 * @property {object} def
 * @property {string} designator
 * @property {ExportPort[]} ports
 */

/**
 * @typedef {object} ExportNet
 * @property {string} id
 * @property {string} name
 * @property {"VCC"|"GND"|null} polarity
 * @property {Array<{partId:string, key:string}>} ports
 */

/** A brick terminal's role, for the writers' pin typing. */
function terminalRole(def, terminal) {
  if (def.kind === "psu") return terminal === "+" ? "vcc" : "gnd";
  if (def.kind === "clock") return terminal === "out" ? "output" : "gnd";
  return "io";
}

/**
 * Project a document onto the export model.
 *
 * @param {object} doc - a plain desk document (`toJSON`).
 * @param {{netlist?: object}} [opts] - a wiring-only netlist, if the caller
 *   already has one (it must have been built with `bridges: false`).
 * @returns {{ parts: ExportPart[], nets: Map<string, ExportNet>,
 *   signals: Array<{signal:object, net:string|null}>,
 *   integrations: Array<object>, netlist: object }}
 */
export function exportNetlist(doc, opts = {}) {
  const netlist =
    opts.netlist ?? buildNetlist(doc, new Map(), { bridges: false });
  const components = (doc.components ?? []).filter((c) => partDef(c.ref));
  const designators = assignDesignators(components);

  // Which net each port is on.
  const netOfPort = new Map(); // `${compId}#${key}` → netId
  const membersOf = partNets(doc, netlist);
  for (const [netId, members] of membersOf) {
    for (const m of members) {
      const key = m.terminal != null ? m.terminal : String(m.pin);
      netOfPort.set(`${m.comp.id}#${key}`, netId);
    }
  }

  // A planted signal flag drives the net its apex is in (Feature 370).
  const signals = (doc.signals ?? []).map((signal) => ({
    signal,
    net: signal.flag?.anchor
      ? (netlist.netOfPoint.get(signal.flag.anchor) ?? null)
      : null,
  }));
  const signalCount = new Map();
  for (const s of signals) {
    if (s.net) signalCount.set(s.net, (signalCount.get(s.net) ?? 0) + 1);
  }

  // The parts, every port listed whether or not it is wired.
  const parts = components.map((comp) => {
    const def = partDef(comp.ref);
    const ports = [];
    if (def.terminals && comp.board == null) {
      for (const t of def.terminals) {
        ports.push({
          key: t.id,
          terminal: t.id,
          name: t.id,
          role: terminalRole(def, t.id),
          net: netOfPort.get(`${comp.id}#${t.id}`) ?? null,
        });
      }
    }
    for (const p of def.pins ?? []) {
      ports.push({
        key: String(p.n),
        pin: p.n,
        name: p.name,
        role: p.role,
        net: netOfPort.get(`${comp.id}#${p.n}`) ?? null,
      });
    }
    return {
      id: comp.id,
      comp,
      def,
      designator: designators.get(comp.id),
      ports,
    };
  });

  // Every net some port is on.
  const nets = new Map();
  for (const part of parts) {
    for (const port of part.ports) {
      if (!port.net) continue;
      if (!nets.has(port.net)) {
        nets.set(port.net, {
          id: port.net,
          name: "",
          polarity: netPolarity(netlist.nets.get(port.net) ?? emptyNet()),
          ports: [],
        });
      }
      nets.get(port.net).ports.push({ partId: part.id, key: port.key });
    }
  }

  // A signal net nothing else is on: one pin alone with nothing to meet is a
  // no-connect, and exporting a label for it would state a connection that is
  // not there.
  for (const [id, net] of [...nets]) {
    if (net.polarity || net.ports.length + (signalCount.get(id) ?? 0) > 1) {
      continue;
    }
    nets.delete(id);
  }
  for (const part of parts) {
    for (const port of part.ports) {
      if (port.net && !nets.has(port.net)) port.net = null;
    }
  }

  nameNets(doc, netlist, parts, nets);

  const integrations = [];
  for (const element of doc.integrations ?? []) {
    integrations.push(element);
  }
  return { parts, nets, signals, integrations, netlist };
}

function emptyNet() {
  return { terminals: [], rails: [], pins: [] };
}

/** Give every net its name, in the precedence the file note states. */
function nameNets(doc, netlist, parts, nets) {
  const taken = new Set();
  const claim = (base) => {
    if (!base) return "";
    let name = base;
    for (let n = 2; taken.has(name); n += 1) name = `${base}_${n}`;
    taken.add(name);
    return name;
  };

  // The PSU volts on each supply net, for `+5V`.
  const voltsOn = new Map();
  for (const part of parts) {
    if (part.def.kind !== "psu") continue;
    const plus = part.ports.find((p) => p.terminal === "+");
    if (plus?.net) voltsOn.set(plus.net, part.comp.params?.volts);
  }

  // A bus member's net, named for its bit.
  const busNames = new Map();
  for (const bus of doc.buses ?? []) {
    const parsed = parseBusName(bus.name);
    if (!parsed || parsed.width < 2) continue;
    bus.members.forEach((wireId, i) => {
      const wire = (doc.wires ?? []).find((w) => w.id === wireId);
      const net = wire ? netlist.netOfPoint.get(wire.from) : null;
      const bit = parsed.bits[i];
      if (net && nets.has(net) && bit != null && !busNames.has(net)) {
        busNames.set(net, `${parsed.base}${bit}`);
      }
    });
  }

  // Nets in READING order (by the first port on them, part by part), so an
  // unnamed net's number says roughly where on the sheet it starts.
  const ordered = [];
  const seen = new Set();
  for (const part of parts) {
    for (const port of part.ports) {
      if (port.net && nets.has(port.net) && !seen.has(port.net)) {
        seen.add(port.net);
        ordered.push(nets.get(port.net));
      }
    }
  }
  for (const net of nets.values()) {
    if (!seen.has(net.id)) ordered.push(net);
  }

  // User names first, so a user's `N1` is never renumbered out from under them.
  for (const net of ordered) {
    const user = safeNetName(netlist.names?.get(net.id));
    if (user) net.name = claim(user);
  }
  for (const net of ordered) {
    if (net.name) continue;
    if (net.polarity === "VCC") net.name = claim(railName(voltsOn.get(net.id)));
    else if (net.polarity === "GND") net.name = claim("GND");
    else if (busNames.has(net.id)) {
      net.name = claim(safeNetName(busNames.get(net.id)));
    }
  }
  let k = 1;
  for (const net of ordered) {
    if (net.name) continue;
    while (taken.has(`N${k}`)) k += 1;
    net.name = claim(`N${k}`);
  }
}
