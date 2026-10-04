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

import { PALETTE_DEFS, outputEnablePins } from "../catalog/index.js";
import { isAnalogSwitch, isTimed } from "../sim/chip-eval.js";
import { familyOf } from "../catalog/families.js";
import { MIN_TESTS } from "./generate.js";

/**
 * The parts the BUILDER may be offered: everything the compiler can seat. A
 * crystal-can oscillator (`can`) is refused by the compiler, so listing it only
 * spends a repair round learning that. Nor are the parts whose behaviour is a
 * VALUE — a capacitor, and the timers that read their R and C off the wiring
 * (`isTimed`): a netlist spec says which pins share a net and nothing about
 * ohms or farads, so the compiler could seat a 555 but never make it keep the
 * time asked for. The desk REVIEW still sees every part — a hand-built desk
 * can hold anything the palette has.
 */
export const BUILDABLE_DEFS = Object.freeze(
  PALETTE_DEFS.filter((d) => !d.can && !d.capacitor && !isTimed(d)),
);

/**
 * One line per part: what it is, and every pin by number and name.
 *
 * Pin NAMES are quoted exactly as the catalog spells them, case included —
 * `pin-resolve.js` tries an exact, case-sensitive match first, and several
 * chips distinguish inputs from outputs by case alone (74LS47's `A`–`D` inputs
 * versus its `a`–`g` segment outputs).
 */
/**
 * The one-character suffix a pin carries, or "" for a plain input.
 *
 * The card used to give the model a bare `n:name` list, which left it guessing
 * at two things it is then held to. Which pins are OUTPUTS decides whether a
 * net is a bus fight, and it is a rule the compiler enforces — asking the model
 * to obey it while withholding the answer is a trap. Which pin is an active-LOW
 * OUTPUT ENABLE is worse than a guess: nothing in the pin name says so (they
 * are called `1G`, `OE`, `M`, `N`, with no bar), the part floats every output
 * until it is tied LOW, and a floating enable reads HIGH — so the honest,
 * datasheet-following design comes up dead and the model has no way to see why.
 * The CD4094B's enable is the one active-HIGH one, and it gets its own mark
 * (`^`): telling the model "tie every enable LOW" would disable it.
 */
function pinMark(def, p) {
  const enable = outputEnablePins(def).find((e) => e.n === p.n);
  if (enable) return enable.on === "H" ? "^" : "!";
  if (p.role === "output") return ">";
  // An analog switch's terminal is bidirectional in a different sense: it does
  // not drive at all, it CONNECTS — told apart so the model never counts on it
  // as a source.
  if (p.role === "io") return isAnalogSwitch(def) ? "~" : "<>";
  return "";
}

function partLine(def) {
  const pins = (def.pins ?? [])
    .map((p) => `${p.n}:${p.name}${pinMark(def, p)}`)
    .join(" ");
  const terminals = (def.terminals ?? []).map((t) => t.id).join(" ");
  // A logic chip states its family (Feature 400) — the prompt's family rule
  // picks parts by it, so the model must never have to infer it from an id.
  const family = familyOf(def);
  const shape = def.package
    ? ` [${def.package}${family ? `, ${family}` : ""}]`
    : "";
  const points = pins || terminals || "—";
  // A part's named buses, so the `NAME[i]` member form the resolver accepts is
  // one the model can actually see.
  const buses = (def.pinGroups ?? [])
    .map((g) => `${g.name}[0-${g.pins.length - 1}]`)
    .join(" ");
  return `${def.id}${shape} — ${def.title}. ${points}${buses ? ` | buses ${buses}` : ""}`;
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
 * violating it produces a specific fault in the compiler (`autobuild.js`), the
 * verifier (`autobuild-verify.js`) or the suite check (`generate.js`), and the
 * repair round quotes that fault straight back. `tests/ai-generate.test.js`
 * holds this text to the rules those modules actually enforce.
 */
const RULES = `
You design logic circuits for Chip Hippo, a breadboard simulator — from two
logic families, 74LS TTL and CD4000 CMOS.

You emit a NETLIST — parts and which pins are joined. You never emit
coordinates, holes, columns, anchors or wires: the app's compiler owns all
geometry, and it is better at it than you are. Your job is the electrical
design.

# The format

{
  "title": "8-bit adder with carry",
  "notes": "Two 74LS283s in ripple-carry: the low nibble's C4 feeds …",
  "parts": [{ "id": "U1", "ref": "74LS283", "label": "low nibble" }],
  "nets":  [{ "name": "A0", "members": ["U1.A1", "SW1.1A"] }],
  "tests": [{ "name": "181 + 78",
              "set":    [{ "target": "SW1", "value": "10110101" }],
              "expect": [{ "target": "BAR", "value": "10000001" }] }]
}

* \`ref\` must be a catalog id from the list below, spelled exactly.
* \`id\` is yours to choose and must be unique.
* A net member is \`<partId>.<pin>\`. The pin may be its NAME (exactly as
  listed, case-sensitive, marks included: \`1Q̄\` is not \`1Q\`) or its NUMBER.
  Use \`<partId>.#7\` to force the number when a chip has a pin *named* like
  a number. A part that lists \`buses\` also takes \`<partId>.A[3]\` — index 0
  is the bus's first line.
* \`VCC\` and \`GND\` bind to the power rails, either as a reserved NET NAME
  (\`{ "name": "VCC", "members": [...] }\`) or as a member of a net of your own
  name (\`{ "name": "A_SRC", "members": ["SW1.1B", "VCC"] }\`). Both work.
* An optional field (\`title\`, \`notes\`, \`label\`, \`set\`, \`edges\`,
  \`tests\`) may be \`null\` — the app reads null as absent.

# Logic families

Every logic chip in the catalog belongs to ONE family, named in its bracket:
\`74LS\` (TTL, ids \`74LS…\`) or \`CD4000\` (CMOS, ids \`CD4…\`).

* A request that names CD4000, 4000-series or CMOS uses ONLY CD4000 parts.
* A request that names TTL or 74LS uses ONLY 74LS parts.
* A request that names neither uses 74LS parts.
* Never mix the two unless the request asks for it. If it does, every 74LS
  output that feeds a CD4000 input needs a \`resistor\` from that net to
  \`VCC\` (a pull-up): a 74LS HIGH is below what a CMOS input needs. And one
  CD4000 output can drive only ONE 74LS input — buffer more through a
  \`CD4050B\`.
* Memory, interface chips and processors belong to no family and go with
  either.

# Rules the compiler enforces

* NEVER list a power pin. Every part declares its own VCC/GND (VDD/VSS on a
  CD4000 part, and VEE as well on a CD4051B/52B/53B), and the compiler wires
  them, plants the PSU, and bridges the rails. Listing them is an error, not a
  courtesy.
* Every net needs at least two members.
* A pin belongs to at most one net.
* Two outputs must not share a net — that is a bus fight, and the engine
  reports it as a conflict. The one exception is a BUS of tri-state outputs
  (parts with a \`!\` or \`^\` enable): any number may share a net when EVERY
  one of them can be switched off, and at any moment exactly one is enabled.
* Never put an output in a VCC or GND net. The supply overrides it, so the
  output drives nothing at all.
* Every input of a part you use must be in a net — including the ones you
  have no use for, like a counter's load inputs while LOAD is held HIGH: tie
  those to VCC or GND. A floating TTL input reads HIGH, which is a real
  circuit's most convincing lie. The only inputs you may leave out are those
  of a gate or section whose outputs you do not use at all (the three spare
  gates of a 74LS00). An input fed from a switch is covered by the pull rule
  below.
* A CD4000 input is stricter: a floating CMOS input reads neither HIGH nor
  LOW, so EVERY input of a CD4000 gate or section you use must be in a net
  (tie a spare input of a gate you use HIGH on an AND/NAND, LOW on an
  OR/NOR). The inputs of a CD4000 gate or section you do not use at all are
  the compiler's job — it ties them to GND, so do not list them.
* Every \`!\` pin in the catalog needs wiring, and almost always to \`GND\`. It
  is an active-LOW output enable: leave it out and the part's outputs float,
  the circuit does nothing, and the fault you get back will name the pin. A
  \`^\` pin is the same thing active-HIGH (the CD4094B's OUTPUT ENABLE): wire
  it to \`VCC\`. Do NOT put either on a switch — a netlist cannot state which
  way a switch RESTS, so the part comes up disabled. A circuit that only works
  after the user finds the right switch is not one worth handing over.
* An analog switch (CD4066B, CD4051B/52B/53B — pins marked \`~\`) drives
  NOTHING. A channel that is ON joins its two pins, so whatever drives one side
  drives the other, either way; OFF, each side floats unless something else
  drives it. So the level it passes has to come from somewhere — a rail, an
  output, a switch — and a net hung only on an OFF channel floats.
* LEDs and displays do NOT need you to add a series resistor — the compiler
  interposes one in every lamp leg that goes to VCC or GND, because an
  unlimited LED burns rather than lights. Do not put one in the netlist, and
  do not wire a lamp between two outputs: no resistor can be put there.
* An ACTIVE-LOW output gets its LED the other way up: anode to \`VCC\`, cathode
  to the pin, so a LIT lamp still means "asserted". An active-high output takes
  the usual way round — anode to the pin, cathode to \`GND\`.
* Switches do NOT need a pull resistor either, and you should not add one. A
  switch is a passive CONTACT, not a source: closed it joins its two pins,
  open it joins nothing. So wire one side of each position to \`VCC\` and the
  other to the input net, and the compiler adds the pull-down that holds that
  input LOW while the switch is open (wire it to \`GND\` instead and it adds a
  pull-up). A closed switch then reads HIGH — which is exactly what a \`1\` in
  a \`set\` bit string means.
* A bare \`led\` or \`resistor\` is fine — wire its two pins like any other.
  For eight lamps or eight inputs, the DIP-bodied displays (\`bar8\`,
  \`seg8cc\`) and switch banks (\`sw-dip8\`) are tidier.
* A memory chip arrives EMPTY: a netlist cannot carry its contents. A RAM is
  written by the circuit; a ROM, EPROM or EEPROM must be programmed by the user
  afterwards, so say so in \`notes\` if the design needs one.

# Notes — one paragraph, written onto the desk

\`notes\` is stamped above the finished circuit as a caption the user reads on
the board, so write it for the person who is about to look at a circuit they
did not build and cannot ask about. ONE paragraph, plain prose, no lists and
no markdown.

There is real room on the desk for it — write four to eight sentences and
explain the thing properly. A one-line summary is a wasted caption: it tells
the reader what they could already see. Do not pad it either; stop when the
circuit is explained. Anything past about 1500 characters is trimmed.

Say what the design DOES and why it is wired that way — the part that is not
obvious from staring at it. Name the chips and the job each one has, say which
pins are the inputs and what the read-out shows, and call out anything that
would look arbitrary: an enable tied low, a carry chained between two adders,
an output that is active-low so its lamp is wired the other way up. Do not
describe the breadboard, the holes or the wire colours — the compiler chose
those and the user can see them.

# Tests — write them, they are run

The \`tests\` block is your own acceptance test and the app EXECUTES it before
showing the user anything. It is the only check that catches a circuit that is
built exactly as you described and still computes the wrong thing — an
inverted LSB order, most often. Always include at least ${MIN_TESTS}, each
with a different input state (or a different number of clock edges).

* \`set\` and \`expect\` are LISTS of \`{ "target": …, "value": … }\` pairs, not
  objects — an object with arbitrary keys cannot be schema-constrained.
* \`set\` drives a switch-bank part id with a bit string, LSB FIRST, giving
  EVERY position — a string exactly as long as the bank.
* Each test starts from the circuit as built, every switch at rest; nothing
  carries over from the test before.
* \`edges\` is how many clock PULSES to apply first — each one LOW → HIGH →
  LOW, so a rising-edge part and a falling-edge part both see that many
  (omit for combinational). It needs a \`clock\` part in the design.
* \`expect\` targets a display part id with a bit string of EVERY segment
  (LSB first), or a single pin (\`{ "target": "D1.A", "value": "H" }\`) with
  H or L. Every test must expect something.

# Output

Reply with the JSON object and nothing else. If a request cannot be built from
the catalog below, say so in \`title\` and return no parts rather than
substituting a chip that does not exist.

# Catalog

Every part, its package and (for a logic chip) its family, then its pins as
\`number:name\`. A pin's suffix says what it is:

    (none)  an input — or a passive pin: power, a switch contact, a lamp leg
    >       an output — it DRIVES. Two of these must never share a net.
    <>      bidirectional: it drives in one direction and listens in the other.
    ~       an analog switch terminal: it drives nothing, it CONNECTS — while
            its channel is on it is joined to the channel's other terminal.
    !       an ACTIVE-LOW OUTPUT ENABLE — the one thing here you could not
            guess from a pin name. The outputs it gates FLOAT, driving nothing
            at all, until it is LOW; left unwired it reads HIGH, so the part
            comes up dead and the netlist looks fine. Tie it to \`GND\` unless
            the design genuinely takes the part off a shared bus. Where a part
            has two, each may gate its own half (\`74LS244\`) or both may gate
            everything (\`74LS173\`) — so wire EVERY \`!\` pin the part has.
    ^       an ACTIVE-HIGH OUTPUT ENABLE: the same, the other way up. The
            outputs float until it is HIGH (and a floating CMOS input reads
            neither level). Tie it to \`VCC\`.
`.trim();

/**
 * The full system prompt: the rules plus the derived catalogue.
 *
 * Comfortably over the 512-token cache minimum, so it caches on the repair
 * round rather than being re-billed at full rate.
 */
export function buildSystemPrompt(defs = BUILDABLE_DEFS) {
  return `${RULES}\n\n${buildCatalogCard(defs)}`;
}

/**
 * The rules half of the REVIEW prompt (Feature 320).
 *
 * The builder's prompt is a specification: here is what you may emit and what
 * the compiler will hold you to. This one is the opposite — the app has already
 * decided what is wrong, using the same solver the desk runs on, and the model's
 * job starts at the sentence after the fault. So the whole prompt is really one
 * instruction repeated three ways: DO NOT RE-DIAGNOSE. A model asked to read a
 * netlist and judge whether something is shorted will answer confidently and
 * sometimes wrongly, and the user has no way to tell the two apart.
 */
const REVIEW_RULES = `
You are helping someone debug a logic circuit — 74LS TTL, CD4000 CMOS, or both
— they built on a virtual breadboard in Chip Hippo. They can see the circuit; you cannot. You are given a
description of what is on the desk, which pins are joined to which, and the
findings the app's own simulator produced.

# What you are for

The findings are FACTS. They come from the same engine that runs the circuit on
screen: a real netlist partition and a real settle of this exact desk. Your job
is the part the engine cannot do — say what a finding MEANS for this particular
circuit, which one to fix first, and what to do about it.

* Do NOT re-derive the faults. You cannot see the wiring the way the netlist
  does, and a fault you invent is indistinguishable, to the reader, from one the
  simulator found.
* Do NOT contradict a finding. If it says a net is shorted, it is shorted.
* You MAY say the circuit looks fine. If there are no findings, say so plainly
  and answer whatever was actually asked instead of hunting for something wrong.
* You MAY reason about INTENT, and that is where you are most useful: the
  findings know a pin floats, they do not know the design was meant to be a
  ripple counter and the carry never got wired.

# Answering

* Lead with the answer. If one finding explains the whole problem, say which and
  why, then the rest.
* Name parts the way the desk does — \`c1\`, \`74LS283\`, pin names as printed
  (\`1A\`, \`OE\`). Net ids look like \`bb2.a5\`; quoting one back is useful, since
  the user can find it with the probe tool.
* Never give hole positions, columns, rows or coordinates. You do not have them
  and the user does not need them — say "tie 1G to GND", not where to put a wire.
* Prose, no markdown headings and no code fences. A few short paragraphs.
* Say when you are unsure. "I can't tell from the netlist whether…" is a useful
  sentence; a confident guess is not.

# The parts catalogue

Every part Chip Hippo has, then its pins as \`number:name\`. A pin's suffix says
what it is:

    (none)  an input
    >       an output — it DRIVES.
    <>      bidirectional.
    ~       an analog switch terminal: it drives nothing; an ON channel joins
            it to the channel's other terminal, an OFF one leaves it floating.
    !       an ACTIVE-LOW OUTPUT ENABLE. The outputs it gates float until it is
            LOW, and an unwired input reads HIGH — so a part with one of these
            left unwired is dead while its wiring looks perfect.
    ^       an ACTIVE-HIGH OUTPUT ENABLE (the CD4094B's): the same, the other
            way up — its outputs float until it is HIGH.

A logic chip's bracket names its family. The two read a floating input
differently, which explains many findings: an unwired 74LS (TTL) input reads
HIGH, so the part works, just not as designed; an unwired CD4000 (CMOS) input
reads neither HIGH nor LOW, so what the part does is anybody's guess, and
every CMOS input — spare gates included — has to be tied.
`.trim();

/**
 * The review system prompt: the rules above plus the SAME derived catalogue the
 * builder gets. Separate from `buildSystemPrompt` so each caches on its own — a
 * session that both builds and reviews pays for two prefixes rather than
 * invalidating one.
 *
 * @param {Array} [defs]
 * @param {string} [language] the language to answer in, natively named
 *   (`getLocales()`'s `nativeName`). Omitted → the model answers in English.
 */
export function buildReviewSystemPrompt(defs = PALETTE_DEFS, language = "") {
  const answerIn = language
    ? `\n\n# Language\n\nAnswer in ${language}. Keep part refs, pin names, net ` +
      `ids and finding codes exactly as they are given — they are printed on ` +
      `the parts and shown on screen, and translating them makes them ` +
      `impossible to match up.`
    : "";
  return `${REVIEW_RULES}${answerIn}\n\n${buildCatalogCard(defs)}`;
}

/**
 * Compiler notes worth telling the model on a repair round: the ones that
 * CHANGE the circuit it wrote. A level it did not expect is often a pull or a
 * resistor it did not ask for, and it cannot reason about what it was never
 * told. Layout notes (wire crossings) and user-facing ones (an unprogrammed
 * ROM) say nothing it can act on.
 */
const CIRCUIT_NOTES = new Set([
  "RESISTOR_INSERTED",
  "PULL_INSERTED",
  "SPARE_INPUTS_TIED",
]);

/**
 * Turn verifier faults / compiler errors into the repair message.
 *
 * Structured, never prose: the model is being told which member of which net
 * is wrong, so it can fix that one thing rather than redesign.
 *
 * @param {Array} faults
 * @param {Array} [notes]  the compiler's warnings for the same build
 */
export function buildRepairMessage(faults, notes = []) {
  const lines = faults.map((f) => {
    const where = f.path ? ` at ${f.path}` : "";
    const extra = f.candidates
      ? ` (candidates: ${f.candidates.join(", ")})`
      : "";
    return `- ${f.code}${where}: ${f.message}${extra}`;
  });
  const context = (notes ?? [])
    .filter((w) => CIRCUIT_NOTES.has(w?.code))
    .map((w) => `- ${w.code}: ${w.message}`);
  return (
    `That netlist did not pass. Fix exactly these and return the whole ` +
    `corrected JSON object:\n${lines.join("\n")}` +
    (context.length
      ? `\n\nFor context, the compiler also changed the circuit as it built ` +
        `it (these are not faults, and you should not add them yourself):\n` +
        context.join("\n")
      : "")
  );
}
