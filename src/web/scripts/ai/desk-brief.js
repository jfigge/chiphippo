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

// desk-brief.js — the circuit on the desk, described for the model (Feature 320).
//
// The exact inverse of catalog-brief.js: that one tells the model what parts
// EXIST, this one tells it what is actually on the bench. Between them the model
// has everything it needs to answer a question about a circuit it did not build.
//
// IT DESCRIBES CONNECTIVITY, NOT GEOMETRY. Not one hole, column, anchor or
// coordinate crosses into the prompt, for the same reason the builder never asks
// for one back: geometry is the compiler's, and a model reasoning about which
// row a chip sits in is reasoning about the wrong thing. What it gets is the
// vocabulary Build mode already taught it — `c1.1A`, a part id and a pin name —
// so anything it says can be matched back to the desk by the user.
//
// The one identifier that IS an address is a net's id (`bb2.a5`, the
// lexicographically smallest member — netlist.js). That is deliberate: the
// engine's own fault wording quotes it ("opposing supplies meet on one net
// (bb2.a5)"), the probe tool shows it, and a model that can quote it back gives
// the user something they can actually go and look at.
//
// The scaffolding words here are ENGLISH BY CONSTRUCTION, like the AI ladder's
// fault messages: this text is protocol, read by a model under an English system
// prompt, never rendered to anyone. The FINDINGS embedded in it are the
// exception — they are the same localized sentences the panel shows, because a
// user reading the list and a model reading the brief must be looking at the
// same claim.

import { chipMarking, partDef } from "../catalog/index.js";
import { partNets } from "../model/part-nets.js";
import { loadBadge } from "../catalog/bench-parts.js";

/** How much of a large desk reaches the prompt before it is trimmed. */
export const MAX_PARTS = 80;
export const MAX_NETS = 160;
/** Beyond this a net is a bus everybody taps; listing every member says less. */
const MAX_NET_MEMBERS = 24;

/** `c1.1A` — the member form Build mode's netlist DSL already uses. */
const member = (compId, def, pin) =>
  `${compId}.${def?.pins?.find((p) => p.n === pin)?.name ?? pin}`;

/**
 * A part's one-line description: what it is, and anything about its current
 * STATE that changes what the circuit does. A switch bank that is set one way
 * computes something different from the same bank set another way, and that is
 * invisible in a wiring list — so it is spelled out.
 */
function partLine(comp, def) {
  // A custom chip is named by its part number; its ref is an opaque id.
  const bits = [`${comp.id}  ${def?.custom ? chipMarking(def) : comp.ref}`];
  // The user's own Name/Description for the part (Properties…). Nothing else on
  // the desk says what a chip is FOR, so where somebody has bothered to write it
  // down it is the most valuable line in this whole brief.
  if (comp.name) bits.push(`"${comp.name}"`);
  if (comp.description) bits.push(`— ${comp.description}`);
  if (def?.switchBank && Array.isArray(comp.params?.states)) {
    const closed = comp.params.states
      .map((on, i) => (on ? i + 1 : 0))
      .filter(Boolean);
    bits.push(closed.length ? `closed: ${closed.join(",")}` : "all open");
  } else if (Array.isArray(comp.params?.states)) {
    bits.push(comp.params.states[0] ? "closed" : "open");
  }
  if (comp.kind === "psu") bits.push(`${comp.params?.volts ?? 5} V`);
  if (comp.kind === "load") bits.push(loadBadge(comp.params));
  if (comp.kind === "clock") {
    // `hz` is a number or the string "manual" — which is truthy, and used to
    // brief a click-to-toggle clock as running at "manual Hz".
    const hz = comp.params?.hz;
    bits.push(Number.isFinite(hz) ? `${hz} Hz` : "manual");
    // A PWM runs in both engines; any other wave is Spice Lite's alone (the
    // standard engine runs it square).
    const def = partDef("clock");
    const wave = def.waveOf(comp.params);
    if (wave === "pwm") {
      bits.push(`PWM, HIGH ${Math.round(def.dutyOf(comp.params) * 100)}%`);
    } else if (wave !== "square") bits.push(`${wave} wave under Spice Lite`);
  }
  return bits.join("  ");
}

/**
 * Every net on the desk as `<netId> ["name"] — member, member, …`.
 *
 * Members are component pins and brick terminals only. A bare hole with a wire
 * in it and nothing else on the net is not named: it is a wire going nowhere,
 * which the findings already report as a single-member net, and listing it here
 * as an anonymous address would be the one piece of geometry this brief avoids.
 */
function netLines(doc, netlist) {
  const lines = [];
  for (const [netId, parts] of partNets(doc, netlist)) {
    const members = parts.map((m) =>
      m.terminal != null
        ? `${m.comp.id}.${m.terminal}`
        : member(m.comp.id, m.def, m.pin),
    );
    if (members.length < 1) continue;
    const name = netlist.names?.get(netId);
    const shown =
      members.length > MAX_NET_MEMBERS
        ? `${members.slice(0, MAX_NET_MEMBERS).join(", ")}, … (${members.length} in all)`
        : members.join(", ");
    lines.push(`${netId}${name ? ` "${name}"` : ""} — ${shown}`);
  }
  return lines;
}

/**
 * The whole brief.
 *
 * @param {{boards:Array, components:Array, wires:Array}} doc a plain document.
 * @param {{netOfPoint:Map, nets:Map, names:Map}} netlist
 * @param {{findings:Array, stats:object}} review the `reviewDesk` result.
 * @param {{maxParts?:number, maxNets?:number}} [limits]
 * @returns {string}
 */
export function buildDeskBrief(doc, netlist, review, limits = {}) {
  const maxParts = limits.maxParts ?? MAX_PARTS;
  const maxNets = limits.maxNets ?? MAX_NETS;
  const { stats = {}, findings = [] } = review ?? {};
  const out = [];

  out.push("# The circuit currently on the desk");
  out.push("");
  out.push(
    `${stats.boards ?? 0} board strips, ${stats.parts ?? 0} parts, ` +
      `${stats.wires ?? 0} wires, ${stats.nets ?? 0} electrical nets, ` +
      `${stats.poweredChips ?? 0} of ${stats.chips ?? 0} chips powered.`,
  );

  const comps = doc.components ?? [];
  out.push("");
  out.push("## Parts");
  for (const comp of comps.slice(0, maxParts)) {
    out.push(partLine(comp, partDef(comp.ref)));
  }
  // A cap that hides what it hid reads as a complete list. Say so.
  if (comps.length > maxParts) {
    out.push(`… and ${comps.length - maxParts} more parts, not listed here.`);
  }

  const nets = netLines(doc, netlist);
  out.push("");
  out.push("## Nets");
  out.push(
    "One line per electrical net: its id, the user's name for it if it has " +
      "one, then every part pin joined to it.",
  );
  for (const line of nets.slice(0, maxNets)) out.push(line);
  if (nets.length > maxNets) {
    out.push(`… and ${nets.length - maxNets} more nets, not listed here.`);
  }

  out.push("");
  out.push("## What the simulator reports");
  if (!findings.length) {
    out.push(
      "Nothing. Every check the app runs passed: the circuit is powered, it " +
        "settles, no net is shorted or fought over, and no used input is left " +
        "floating.",
    );
  } else {
    out.push(
      "These are the app's own findings, derived from the netlist and a real " +
        "settle of this exact circuit. They are facts, not guesses.",
    );
    for (const f of findings) {
      out.push(`- [${f.severity}] ${f.code}: ${f.message}`);
    }
  }
  return out.join("\n");
}
