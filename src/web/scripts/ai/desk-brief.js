/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
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

import { partDef } from "../catalog/index.js";
import { partPinAddresses } from "../model/occupancy.js";

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
  const bits = [`${comp.id}  ${comp.ref}`];
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
  if (comp.kind === "clock") {
    bits.push(comp.params?.hz ? `${comp.params.hz} Hz` : "manual");
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
  const byNet = new Map();
  const add = (netId, text) => {
    if (netId == null) return;
    if (!byNet.has(netId)) byNet.set(netId, []);
    byNet.get(netId).push(text);
  };

  for (const comp of doc.components ?? []) {
    const def = partDef(comp.ref);
    for (const t of def?.terminals ?? []) {
      add(netlist.netOfPoint.get(`${comp.id}.${t.id}`), `${comp.id}.${t.id}`);
    }
    if (!def?.pins?.length) continue;
    for (const p of partPinAddresses(doc, comp) ?? []) {
      if (p.address == null) continue;
      add(netlist.netOfPoint.get(p.address), member(comp.id, def, p.pin));
    }
  }

  const lines = [];
  for (const [netId, members] of byNet) {
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
