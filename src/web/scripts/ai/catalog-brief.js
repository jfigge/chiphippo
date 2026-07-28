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

// catalog-brief.js — the system prompt, DERIVED (Feature 260).
//
// The single most important correctness lever in the AI path is that the model
// is told exactly what parts exist and exactly what each pin is called. A
// hand-written prompt listing chips would be wrong the first time a part landed
// in `catalog/`, and wrong in the worst way: the model would confidently name a
// pin the resolver then refuses.
//
// So the parts section is BUILT from `PALETTE_DEFS` every time. A new 74xx chip
// is available to the AI the moment it is added to the catalog, with no prompt
// to remember to update.
//
// Note `JSON.stringify(def)` would silently drop `normalizeParams`,
// `internalBridges` and `source` — they are functions. The projection below is
// explicit for that reason, not for brevity.

import { PALETTE_DEFS } from "../catalog/index.js";

/**
 * One line per part: what it is, and every pin by number and name.
 *
 * Pin NAMES are quoted exactly as the catalog spells them, case included —
 * `pin-resolve.js` tries an exact, case-sensitive match first, and several
 * chips distinguish inputs from outputs by case alone (74LS47's `A`–`D` inputs
 * versus its `a`–`g` segment outputs).
 */
function partLine(def) {
  const pins = (def.pins ?? []).map((p) => `${p.n}:${p.name}`).join(" ");
  const terminals = (def.terminals ?? []).map((t) => t.id).join(" ");
  const shape = def.package ? ` [${def.package}]` : "";
  const points = pins || terminals || "—";
  return `${def.id}${shape} — ${def.title}. ${points}`;
}

/** The parts catalogue, grouped as the palette groups it. */
export function buildCatalogCard(defs = PALETTE_DEFS) {
  const groups = new Map();
  for (const def of defs) {
    const key = def.group ?? "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(def);
  }
  const sections = [];
  for (const [group, members] of groups) {
    sections.push(`## ${group}`);
    for (const def of members) sections.push(partLine(def));
  }
  return sections.join("\n");
}

/**
 * The rules half of the prompt — everything the compiler will hold the spec to.
 *
 * Written as constraints rather than as a tutorial: each line exists because
 * violating it produces a specific fault in `autobuild-verify.js`, and the
 * repair round quotes that fault straight back. Kept in sync with the ladder by
 * `tests/catalog-brief.test.js`, which asserts the codes named here are codes
 * the verifier can actually raise.
 */
const RULES = `
You design 74xx TTL logic circuits for Chip Hippo, a breadboard simulator.

You emit a NETLIST — parts and which pins are joined. You never emit
coordinates, holes, columns, anchors or wires: the app's compiler owns all
geometry, and it is better at it than you are. Your job is the electrical
design.

# The format

{
  "title": "8-bit adder with carry",
  "parts": [{ "id": "U1", "ref": "74LS283", "label": "low nibble" }],
  "nets":  [{ "name": "A0", "members": ["U1.A1", "SW1.1A"] }],
  "tests": [{ "name": "181 + 78",
              "set":    [{ "target": "SW1", "value": "10110101" }],
              "expect": [{ "target": "BAR", "value": "10000001" }] }]
}

* \`ref\` must be a catalog id from the list below, spelled exactly.
* \`id\` is yours to choose and must be unique.
* A net member is \`<partId>.<pin>\`. The pin may be its NAME (exactly as
  listed, case-sensitive) or its NUMBER. Use \`<partId>.#7\` to force the
  number when a chip has a pin *named* like a number.
* \`VCC\` and \`GND\` bind to the power rails, either as a reserved NET NAME
  (\`{ "name": "VCC", "members": [...] }\`) or as a member of a net of your own
  name (\`{ "name": "A_SRC", "members": ["SW1.1B", "VCC"] }\`). Both work.
* An optional field (\`title\`, \`label\`, \`set\`, \`edges\`, \`tests\`) may be
  \`null\` — the app reads null as absent.

# Rules the compiler enforces

* NEVER list a power pin. Every part declares its own VCC/GND, and the
  compiler wires them, plants the PSU, and bridges the rails. Listing them is
  an error, not a courtesy.
* Every net needs at least two members.
* A pin belongs to at most one net.
* Two outputs must not share a net — that is a bus fight, and the engine
  reports it as a conflict.
* Do not leave a used input floating. A floating TTL input reads HIGH, which
  is a real circuit's most convincing lie; tie it to VCC or GND explicitly.
* LEDs and displays do NOT need you to add a series resistor — the compiler
  interposes one, because an unlimited LED burns rather than lights. Do not
  put one in the netlist.
* Rotated two-lead parts (a bare \`led\`/\`resistor\` placed at an angle) cannot
  be expressed as a netlist. Use the DIP-bodied displays (\`bar8\`, \`seg8cc\`)
  and switch banks (\`sw-dip8\`) instead.

# Tests — write them, they are run

The \`tests\` block is your own acceptance test and the app EXECUTES it before
showing the user anything. It is the only check that catches a circuit that is
built exactly as you described and still computes the wrong thing — an
inverted LSB order, most often. Always include at least two.

* \`set\` and \`expect\` are LISTS of \`{ "target": …, "value": … }\` pairs, not
  objects — an object with arbitrary keys cannot be schema-constrained.
* \`set\` drives a switch-bank part id with a bit string, LSB FIRST.
* \`edges\` is how many clock edges to apply first (omit for combinational).
* \`expect\` targets a part id with a bit string (LSB first), or a single pin
  (\`{ "target": "D1.A", "value": "H" }\`) with a level.

# Output

Reply with the JSON object and nothing else. If a request cannot be built from
the catalog below, say so in \`title\` and return no parts rather than
substituting a chip that does not exist.

# Catalog
`.trim();

/**
 * The full system prompt: the rules plus the derived catalogue.
 *
 * Comfortably over the 512-token cache minimum, so it caches on the repair
 * round rather than being re-billed at full rate.
 */
export function buildSystemPrompt(defs = PALETTE_DEFS) {
  return `${RULES}\n\n${buildCatalogCard(defs)}`;
}

/**
 * Turn verifier faults / compiler errors into the repair message.
 *
 * Structured, never prose: the model is being told which member of which net
 * is wrong, so it can fix that one thing rather than redesign.
 */
export function buildRepairMessage(faults) {
  const lines = faults.map((f) => {
    const where = f.path ? ` at ${f.path}` : "";
    const extra = f.candidates
      ? ` (candidates: ${f.candidates.join(", ")})`
      : "";
    return `- ${f.code}${where}: ${f.message}${extra}`;
  });
  return (
    `That netlist did not pass. Fix exactly these and return the whole ` +
    `corrected JSON object:\n${lines.join("\n")}`
  );
}
