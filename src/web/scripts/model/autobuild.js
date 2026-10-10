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

// autobuild.js — a coordinate-free netlist in, a real desk document out.
//
// The spec names PARTS and which pins share a NET. It contains no hole, no
// column, no anchor and no wire: everything geometric is decided here, because
// geometry is where a generated circuit goes wrong in ways that still simulate.
//
//   spec ──▶ resolve ──▶ layout ──▶ route ──▶ { boards, components, wires }
//
// Three rules this encodes that a caller should not have to know:
//
//   * POWER IS DERIVED. Every def declares `role: "vcc"|"gnd"`, so the spec
//     never lists a power pin — the compiler finds them and wires them. A PSU
//     is planted automatically; a board's two rail strips are bridged, because
//     they share no node and the bottom one is otherwise dead. A design needing
//     more than one board gets them SNAPPED into a single run that shares the
//     rail between each pair, so those bridges chain and nothing has to be
//     wired from one board to the next.
//   * LEDs NEED A RESISTOR. Per sim/junction.js an LED conducting between two
//     strongly driven nets burns rather than lights. That is physics, not
//     logic, so the netlist should not have to mention it: whenever a lamp
//     leg — a display's common leg, an isolated segment, a bare LED's anode
//     or cathode — heads straight for a rail, a series resistor is interposed.
//     A bare LED's is its own and is PLUGGED IN, as on a bench: one lead in
//     the lamp's column, the other in the rail, and no wire to either.
//   * SWITCHES NEED A PULL. A switch is a contact, not a source: open, it
//     joins nothing, so an input fed from one FLOATS half the time. Same
//     class of fact as the LED's resistor, and handled the same way.
//   * ONE COLUMN-HALF, ONE PART. Enforced by column-allocator.js.
//
// The output is a plain document so it can go straight through
// normalizeDocument → buildNetlist → settle. Wrapping it as a design clip for
// the paste path is the caller's job.

import { openCollectorPins, partDef } from "../catalog/index.js";
import { pullDownOhms } from "../catalog/families.js";
import { isRomChip } from "../sim/chip-eval.js";
import { BREADBOARD_KITS } from "./board-types.js";
import {
  boardSize,
  holePosition,
  nodeOf,
  parseAddress,
  spec,
} from "./breadboard.js";
import { createAllocator } from "./column-allocator.js";
import { DOC_VERSION } from "./desk-doc.js";
import { captureDesign } from "./design-clip.js";
import { packageSpec } from "./footprints.js";
import { partPinAddresses, partPinHoles } from "./occupancy.js";
import { RAIL_TOKENS, parseMember, resolvePin } from "./pin-resolve.js";
import { netDrivers, pinLabel, spareCmosInputs } from "./spec-lint.js";
import { boxOf, drawnCrossings } from "./wire-crossing.js";

const GAP = 1; // blank columns between parts, so nothing reads as one block

const RAIL_INDEX_RE = /[+-](\d+)$/;

/**
 * Rail-hole addresses reordered as the SUPPLY SPINE wants them: the right-hand
 * end of the strip first, then the left-hand end, then in from the right
 * through the middle.
 *
 * This is a TIE-BREAK, and it is the whole of rule 2 (see CLAUDE.md, "Power
 * layout"). A rail-to-rail link's two ports both carry `at: null`, so
 * `shortlist` hands `bestPair` every free hole on both strips unpruned — and
 * the two strips are the same type at the same x, so hole `+k` sits EXACTLY
 * above hole `+k`. Every vertical pair therefore scores an identical
 * `distance`, the only thing that separates them is `drawnCrossings`, and
 * `bestPair` breaks a tie strictly — first enumerated wins. `freeRailHoles`
 * walks `k = 1…` upward, so the enumeration order WAS the decision, and it put
 * the supply down column 1: the far end from the PSU, and exactly where the
 * first chip is seated.
 *
 * Nothing else moves. The candidate SET is untouched (a rail line is 50 holes,
 * inside `shortlist`'s cap), and `bestPair` still scores every pair against the
 * same cost — so no link this reorders can come out longer, or cross more, than
 * it did before.
 *
 * "The end" is the line's last GROUP of holes, not its last hole. A strict
 * rightmost-then-leftmost zip ranks hole 49 BELOW hole 1, so one blocked column
 * would throw the link the whole width of the desk; a group of five is what the
 * part is actually drilled in, and what the eye reads as the end, so a blocked
 * hole 50 steps to 49 instead.
 *
 * @param {string[]} addresses - free rail-hole addresses, any order
 * @param {number} holes - holes per rail line (`spec(type).railHoles`)
 * @param {number} group - holes per drilled group (`spec(type).railGroup`)
 */
function railSpineOrder(addresses, holes, group) {
  const rank = (address) => {
    const k = Number(RAIL_INDEX_RE.exec(address)?.[1]);
    if (!Number.isFinite(k)) return [3, 0];
    if (k > holes - group) return [0, holes - k]; // right end, outward in
    if (k <= group) return [1, k]; // left end, outward in
    return [2, holes - k]; // the middle, in from the right
  };
  return addresses
    .map((address) => [rank(address), address])
    .sort((a, b) => a[0][0] - b[0][0] || a[0][1] - b[0][1])
    .map((entry) => entry[1]);
}

const REPAIR = "repair";
const ABORT = "abort";

// Compiler errors carry the same `kind` the verifier's faults do, so a repair
// round does not have to know which stage refused. The default is REPAIR — the
// spec's own mistake, which its author can fix. The GEOMETRY errors opt into
// ABORT, because a model that is never asked for a hole cannot be asked for a
// different one: sending "route it via a rail" back to something with no
// coordinates in its vocabulary spends the user's tokens on an unchanged answer.
const err = (code, message, extra = {}) => ({
  code,
  kind: REPAIR,
  message,
  ...extra,
});

/**
 * Compile a netlist spec into a document.
 *
 * @param {{parts:Array, nets:Array, title?:string}} spec
 * @returns {{ok:true, document:object, warnings:Array}
 *          |{ok:false, errors:Array}}
 */
export function compileNetlist(spec) {
  const resolved = resolveSpec(spec);
  if (!resolved.ok) return resolved;
  return assemble(powerClocks(resolved), spec?.title, spec?.notes);
}

/**
 * A clock source runs from the supply like any instrument (Jason,
 * 2026-10-07): its `vcc` terminal on the + rail and its `gnd` on the − rail.
 * Power is DERIVED, so the compiler wires both — a spec that already lists a
 * terminal in a net keeps it where it put it (the prompt has always let a
 * spec name `CLK.gnd` in its GND net).
 */
function powerClocks(resolved) {
  const { parts, nets } = resolved;
  const listed = new Set();
  for (const net of nets) {
    for (const q of net.pins) {
      if (q.kind === "terminal") listed.add(`${q.partId}.${q.terminal}`);
    }
  }
  const railNet = (rail) => {
    let net = nets.find((n) => n.rail === rail);
    if (!net) {
      net = { name: rail, pins: [], rail };
      nets.push(net);
    }
    return net;
  };
  for (const part of parts.values()) {
    if (part.def.kind !== "clock") continue;
    for (const [terminal, rail] of [
      ["vcc", "VCC"],
      ["gnd", "GND"],
    ]) {
      if (listed.has(`${part.id}.${terminal}`)) continue;
      railNet(rail).pins.push({ partId: part.id, kind: "terminal", terminal });
    }
  }
  return resolved;
}

// The design's own caption, above the boards. Matches the pitch and the muted
// body the demo benches use (scripts/demo-bench.mjs), because a generated
// circuit and a shipped demo should read the same way on the desk.
const CAPTION_LINE = 1.8; // vertical pitch between caption lines
const CAPTION_BOTTOM = -2; // the last line sits just above the top rail
// A label is nowrap, so the width is not a style choice — it is how wide a line
// may be drawn. 64 characters of 12 px sans is ~41 units, well inside a full
// pin-board's 63 columns, so the block stays over the design's own footprint.
const CAPTION_WIDTH = 64;
// A GUARD, not a budget: 30 lines is ~1900 characters, past anything the prompt
// asks for. It exists only so an essay cannot bury the circuit it explains, and
// when it does fire the last line is marked — see CAPTION_CUT.
const CAPTION_MAX = 30;
const CAPTION_CUT = "…"; // appended to the last line when the cap trims
const CAPTION_MUTED = "#808080";

/**
 * Break a paragraph into lines of at most `width` characters.
 *
 * An annotation is `white-space: nowrap` — what is written is what is drawn —
 * so a paragraph handed over whole would run off the desk in one line. A word
 * longer than the width overflows its own line rather than being cut: a part
 * number split down the middle is worse than a ragged edge.
 */
export function wrapText(text, width = CAPTION_WIDTH) {
  const words = String(text ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// ── Resolve: the spec's own semantics (L1) ──────────────────────────────────

function resolveSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return {
      ok: false,
      errors: [err("BAD_SPEC", "The spec must be an object.")],
    };
  }
  const rawParts = Array.isArray(spec.parts) ? spec.parts : [];
  const rawNets = Array.isArray(spec.nets) ? spec.nets : [];
  if (!rawParts.length) {
    errors.push(err("NO_PARTS", "The spec lists no parts.", { path: "parts" }));
  }

  const parts = new Map();
  rawParts.forEach((p, i) => {
    const path = `parts[${i}]`;
    if (!p || typeof p.id !== "string" || !p.id.trim()) {
      errors.push(err("BAD_PART_ID", "A part needs a string id.", { path }));
      return;
    }
    if (parts.has(p.id)) {
      errors.push(
        err("DUPLICATE_PART", `Two parts share the id "${p.id}".`, { path }),
      );
      return;
    }
    const def = partDef(p.ref);
    if (!def) {
      errors.push(
        err("UNKNOWN_REF", `No catalog part with id "${p.ref}".`, { path }),
      );
      return;
    }
    if (def.can) {
      errors.push(
        err(
          "UNSUPPORTED_PART",
          `"${p.ref}" is a multi-corner can — the compiler cannot place one yet.`,
          { path },
        ),
      );
      return;
    }
    parts.set(p.id, { id: p.id, ref: p.ref, def, label: p.label ?? null });
  });

  // Nets. A pin may appear in exactly one net: two nets sharing a pin are the
  // same net, and silently merging them would hide a real modelling mistake.
  const owner = new Map(); // "partId.pin" → net name
  const nets = [];
  rawNets.forEach((n, i) => {
    const path = `nets[${i}]`;
    const name = typeof n?.name === "string" ? n.name.trim() : "";
    const members = Array.isArray(n?.members) ? n.members : [];
    if (!name) {
      errors.push(err("BAD_NET_NAME", "A net needs a name.", { path }));
      return;
    }
    if (members.length < 2) {
      errors.push(
        err("NET_TOO_SMALL", `Net "${name}" needs at least two members.`, {
          path,
        }),
      );
      return;
    }
    const pins = [];
    const rails = new Set();
    // A supply binds by NET NAME as well as by member token. The system prompt
    // documents the name form (`{ "name": "VCC", members: [...] }`) and it is
    // the form a model reaches for, so honouring only the member form is the
    // worst kind of near-miss: a WIDE power net fails to route, and a NARROW
    // one quietly compiles into an island of pins tied to each other and to no
    // supply at all — which loads, settles, and passes the declared-vs-derived
    // gate while the switches hanging off it do nothing.
    const named = RAIL_TOKENS[name.toUpperCase()];
    if (named) rails.add(named);
    members.forEach((m, j) => {
      const mPath = `${path}.members[${j}]`;
      const parsed = parseMember(m);
      if (!parsed) {
        errors.push(
          err("BAD_MEMBER", `"${m}" is not a net member.`, { path: mPath }),
        );
        return;
      }
      if (parsed.kind === "rail") {
        rails.add(parsed.rail);
        return;
      }
      const part = parts.get(parsed.partId);
      if (!part) {
        errors.push(
          err(
            "UNKNOWN_PART",
            `Net "${name}" names part "${parsed.partId}", which is not declared.`,
            {
              path: mPath,
            },
          ),
        );
        return;
      }
      const r = resolvePin(part.ref, parsed.pinToken);
      if (!r.ok) {
        errors.push(
          err(r.code, r.message, { path: mPath, candidates: r.candidates }),
        );
        return;
      }
      // The prompt says never to list a power pin, and until now nothing held
      // the spec to it. Listing one is redundant at best — the compiler wires
      // every part's VCC/GND from the rails regardless — and a SHORT at worst,
      // when the pin lands in the net for the opposite rail. A brick's `gnd`
      // is a TERMINAL, not a role-bearing pin, and stays listable: nothing
      // powers a clock source but the netlist.
      if (r.kind === "pin") {
        const role = part.def.pins?.find((q) => q.n === r.pin)?.role;
        if (role === "vcc" || role === "gnd") {
          const pinName = part.def.pins.find((q) => q.n === r.pin)?.name;
          errors.push(
            err(
              "POWER_PIN_LISTED",
              `"${m}" is ${part.ref}'s ${role.toUpperCase()} pin` +
                (pinName && pinName !== role.toUpperCase()
                  ? ` (${pinName})`
                  : "") +
                `. The compiler wires power itself — drop it from net ` +
                `"${name}".`,
              { path: mPath },
            ),
          );
          return;
        }
      }
      const key = `${part.id}.${r.kind === "pin" ? r.pin : r.terminal}`;
      if (owner.has(key)) {
        errors.push(
          err(
            "PIN_IN_TWO_NETS",
            `${key} is in both "${owner.get(key)}" and "${name}".`,
            {
              path: mPath,
            },
          ),
        );
        return;
      }
      owner.set(key, name);
      pins.push({ partId: part.id, ...r });
    });
    if (rails.size > 1) {
      errors.push(
        err("NET_SHORTS_RAILS", `Net "${name}" joins VCC to GND.`, { path }),
      );
    }
    // A clock brick's supply terminals may be listed (the prompt has always
    // let a spec name `CLK.gnd` in its GND net), and the compiler then leaves
    // them where the spec put them — so one listed in any other net is the
    // spec's mistake, and it is said here, where a repair round can fix it,
    // rather than surfacing at L5 as a clock with no power.
    const rail = [...rails][0] ?? null;
    for (const q of pins) {
      if (q.kind !== "terminal" || parts.get(q.partId)?.def.kind !== "clock") {
        continue;
      }
      const want = { vcc: "VCC", gnd: "GND" }[q.terminal];
      if (!want || rail === want) continue;
      errors.push(
        err(
          "CLOCK_POWER_MISWIRED",
          `${q.partId}.${q.terminal} is the clock's ${want} terminal, but net ` +
            `"${name}" is not the ${want} net. List only the clock's \`out\` ` +
            `— the compiler wires its vcc and gnd to the rails itself.`,
          { path },
        ),
      );
    }
    const { hard, switchable } = netDrivers(pins, parts);
    const drivers = [...hard, ...switchable];
    // An output on a rail drives nothing: the engine gives the supply the net
    // (sim/resolve.js), so the circuit settles, verifies, and the output's
    // whole job has silently vanished. There is no reading of that which is
    // a design.
    if (rails.size && drivers.length) {
      const rail = [...rails][0];
      errors.push(
        err(
          "OUTPUT_ON_RAIL",
          `Net "${name}" ties ${drivers.map(pinLabel).join(", ")} straight ` +
            `to ${rail}. The supply overrides an output, so it would drive ` +
            `nothing at all — wire the output to what it should drive, and ` +
            `tie only inputs to ${rail}.`,
          { path },
        ),
      );
    } else if (drivers.length > 1 && hard.length) {
      // Two outputs on one net is a driver conflict the engine would only
      // report in a state where they disagree; naming it here points at the
      // spec line instead. Tri-state outputs are the exception that makes a
      // BUS: any number may share a net as long as every one of them can be
      // switched off, and it is then the engine's job to catch two switched on.
      errors.push(
        err(
          "MULTIPLE_DRIVERS",
          `Net "${name}" ties ${drivers.length} outputs together ` +
            `(${drivers.map(pinLabel).join(", ")}). Outputs may share a net ` +
            `only when every one of them can be switched off — a tri-state ` +
            `output behind a "!" or "^" enable, or an open-collector ">o" ` +
            `one — and ` +
            `${hard.map(pinLabel).join(", ")} cannot.`,
          { path },
        ),
      );
    }
    nets.push({ name, pins, rail });
  });

  return errors.length ? { ok: false, errors } : { ok: true, parts, nets };
}

// ── Assemble: layout, power, the resistor rule, routing ─────────────────────

/** Columns a board-seated part occupies. */
function spanOf(def) {
  if (def.package) return packageSpec(def.package).halfPins;
  if (def.footprint) {
    const offs = def.footprint.offsets;
    return offs[offs.length - 1] - offs[0] + 1;
  }
  return 0;
}

// Probe params for "every contact this part can ever close" / "every contact it
// can ever open". Each def normalizes its own, so one raw object covers every
// switch shape in the catalog: a bank's `states`, a slide switch's `pos`, a
// latching button's `on`. 64 is simply more positions than any bank has.
const ALL_CLOSED = Object.freeze({
  states: Object.freeze(Array.from({ length: 64 }, () => true)),
  pos: "2",
  on: true,
});
const ALL_OPEN = Object.freeze({
  states: Object.freeze([]),
  pos: "1",
  on: false,
});

/**
 * The pin PAIRS a part can bridge in any position — its contacts.
 *
 * `internalBridges` answers which pairs conduct RIGHT NOW, and a switch at rest
 * usually conducts nothing; what the pull rule needs is which pairs it could
 * EVER join. There is deliberately no second catalog field saying so — one fact
 * declared twice drifts — so the def's own function is probed at both extremes
 * of its own parameter domain, plus a button held down (its state, not its
 * params). A def that bridges nothing in any of them is not a switch, which is
 * the right answer for an LED, a resistor and every chip.
 */
function contactPairs(def) {
  if (typeof def?.internalBridges !== "function") return [];
  const pairs = new Map();
  for (const raw of [ALL_CLOSED, ALL_OPEN]) {
    const params = def.normalizeParams ? def.normalizeParams(raw) : raw;
    for (const state of [{ pressed: true }, {}]) {
      for (const [a, b] of def.internalBridges(params, state) ?? []) {
        pairs.set(a < b ? `${a}:${b}` : `${b}:${a}`, [a, b]);
      }
    }
  }
  return [...pairs.values()];
}

/**
 * Seat order: NEIGHBOURS FIRST, so a part lands beside what it wires to.
 *
 * Placement used to follow the order the spec happened to list parts in, with
 * the compiler's own interposed resistors appended after everything else. That
 * is the worst possible order for exactly the parts it applies to: a pull-down
 * array serves ONE switch bank and nothing else, so seating it last put it as
 * far from that bank as the board allows — and once a board filled, onto the
 * NEXT board entirely, turning eight short hops into eight wires across the
 * desk. The layout was legal, simulated correctly, and looked like nobody had
 * thought about it, because nobody had.
 *
 * So: greedy cluster growth. Start from the most connected part, then keep
 * taking whichever unplaced part shares the most nets with what is already
 * down. Since the seating loop fills one board before starting the next, an
 * order in which neighbours are adjacent also keeps a net's parts on ONE board
 * — the cross-board wires that remain are the genuinely least-connected seam,
 * which is the best place for a design too big for one board to be cut.
 *
 * RAIL nets are deliberately not adjacency. Every part touches power, so
 * counting VCC would make everything equally near everything else; and a rail
 * net routes to the nearest rail hole rather than between its members, so
 * sitting close buys it nothing.
 *
 * Ties break by the spec's own order, so the same spec always lays out the
 * same way.
 */
export function orderByConnectivity(seated, nets) {
  if (seated.length < 3) return seated;
  const rank = new Map(seated.map((p, i) => [p.id, i]));
  const shared = new Map(); // "a|b" → nets in common
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const neighbours = new Map(seated.map((p) => [p.id, new Set()]));
  for (const net of nets) {
    if (net.rail) continue;
    const ids = [...new Set(net.pins.map((q) => q.partId))].filter((id) =>
      neighbours.has(id),
    );
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = key(ids[i], ids[j]);
        shared.set(k, (shared.get(k) ?? 0) + 1);
        neighbours.get(ids[i]).add(ids[j]);
        neighbours.get(ids[j]).add(ids[i]);
      }
    }
  }
  const pull = (id, placed) => {
    let n = 0;
    for (const other of neighbours.get(id)) {
      if (placed.has(other)) n += shared.get(key(id, other)) ?? 0;
    }
    return n;
  };
  const degree = (id) => pull(id, new Set(neighbours.keys()));

  const placed = new Set();
  const order = [];
  while (order.length < seated.length) {
    let best = null;
    let score = -1;
    for (const p of seated) {
      if (placed.has(p.id)) continue;
      // Seeding from the busiest part gives the growth a hub to grow from;
      // after that it is pull toward what is already down.
      const s = order.length ? pull(p.id, placed) : degree(p.id);
      if (s > score || (s === score && rank.get(p.id) < rank.get(best.id))) {
        best = p;
        score = s;
      }
    }
    order.push(best);
    placed.add(best.id);
  }
  return order;
}

/**
 * Which board each part goes on, when a design needs more than one.
 *
 * Filling each board to its last column before starting the next leaves the
 * layout lopsided — one board crammed, the next holding three parts — and puts
 * everything that spilled as far from its neighbours as the desk allows. But
 * cutting purely for an even split is worse: it will happily sever a byte-wide
 * bus, and eight nets crossing the seam cost far more than a half-empty board.
 *
 * So the cut is chosen, not fallen into. Walking the connectivity order, every
 * position that leaves the current board reasonably filled is a CANDIDATE, and
 * the one that severs the fewest nets wins — a tie going to the evenest split.
 * A net is severed when it has parts on both sides of the cut, which is exactly
 * the wire that has to cross between boards.
 *
 * @param {Array} order parts, in connectivity order
 * @param {Array} nets the resolved nets
 * @param {(part:any) => number} costOf columns a part consumes
 * @param {{boards:number, capacity:number}} opts
 * @returns {Map<string, number>} spec part id → board index
 */
export function splitAcrossBoards(order, nets, costOf, { boards, capacity }) {
  const assignment = new Map(order.map((p) => [p.id, 0]));
  if (boards < 2 || order.length < 2) return assignment;

  // Which parts each net touches, as positions in the order — a net is severed
  // by a cut at i when it has a part before i and a part at or after it.
  const seen = new Map(order.map((p, i) => [p.id, i]));
  const spans = [];
  for (const net of nets) {
    if (net.rail) continue; // every part touches power; it severs nothing
    const at = [...new Set(net.pins.map((q) => q.partId))]
      .filter((id) => seen.has(id))
      .map((id) => seen.get(id));
    if (at.length > 1) spans.push([Math.min(...at), Math.max(...at)]);
  }
  const severed = (cut) =>
    spans.reduce((n, [lo, hi]) => n + (lo < cut && hi >= cut ? 1 : 0), 0);

  const cost = order.map(costOf);
  const total = cost.reduce((a, b) => a + b, 0);
  const target = total / boards;
  // A board is "reasonably filled" from here on. Below this the split is not
  // worth the nets it cuts; above `capacity` the parts do not fit at all.
  const FLOOR = 0.55;

  let start = 0;
  let used = 0;
  let board = 0;
  for (let i = 0; i < order.length; i++) {
    if (board >= boards - 1) break; // the last board takes whatever is left
    const next = used + cost[i];
    // Cutting BEFORE part i ends this board. Only worth weighing once the
    // board holds enough to be worth ending, and forced once it cannot hold
    // any more.
    const full = next > capacity;
    if (used >= target * FLOOR || full) {
      let bestCut = i;
      let bestScore = [severed(i), Math.abs(used - target)];
      // Look ahead while the board still has room: a slightly fuller board
      // that keeps a bus whole beats an even one that cuts it in half.
      let ahead = used;
      for (let j = i; j < order.length && !full; j++) {
        ahead += cost[j];
        if (ahead > capacity) break;
        const score = [severed(j + 1), Math.abs(ahead - target)];
        if (
          score[0] < bestScore[0] ||
          (score[0] === bestScore[0] && score[1] < bestScore[1])
        ) {
          bestCut = j + 1;
          bestScore = score;
        }
      }
      if (bestCut > start) {
        for (let k = start; k < bestCut; k++) {
          assignment.set(order[k].id, board);
        }
        start = bestCut;
        used = 0;
        board += 1;
        i = bestCut - 1; // the loop's i++ resumes at the first part of the next
        continue;
      }
    }
    used = next;
  }
  for (let k = start; k < order.length; k++) {
    assignment.set(order[k].id, Math.min(board, boards - 1));
  }
  return assignment;
}

const GRID_HOLE_RE = /^([a-j])([1-9]\d*)$/;
const isLowerRow = (row) => row >= "a" && row <= "e";

/**
 * Seat a pull pack IN the columns of the switch bank it pulls down.
 *
 * The bench move this reproduces: an rnet9 pushed into the same column-halves
 * as the DIP switch above it needs no wires at all, because the board is
 * already the connection. Eight wires and nine columns become zero — which for
 * the 8-bit adder is the difference between one breadboard and two.
 *
 * Sharing a column-half is otherwise the exact disaster column-allocator.js
 * exists to prevent, so nothing here is inferred:
 *
 *   * the NET EQUALITY is given, not guessed — the pull rule created one net
 *     per pack pin and put the switch contact in it;
 *   * the GEOMETRY is then PROVED, pin by pin, with `nodeOf` — the pack pin
 *     must land on the very node its host pin sits on, not merely nearby;
 *   * every column it touches must be free or the HOST's, so it can never
 *     wander into a third part.
 *
 * Any of those failing returns null and the caller seats it the ordinary way,
 * which is why this can only ever cost columns, never correctness. L4 checks
 * the result regardless.
 *
 * @returns {{boardId:string, anchor:string, holes:Map}|null}
 */
function seatCompanion(part, links, { alloc, seatOf, boardType }) {
  if (!links?.length) return null;
  const hostId = links[0].hostId;
  if (links.some((l) => l.hostId !== hostId)) return null; // one host only
  const host = seatOf.get(hostId);
  if (!host) return null; // not seated yet — take the ordinary path

  // A reversible part is tried BOTH WAYS ROUND, as it comes first.
  //
  // The bussed array is nine pins over a host of eight: COM has no switch
  // position to sit under, so one column falls outside the host's run, and
  // only the RIGHT-hand one is ever available — seating runs left to right, so
  // the column after a part is either its own blank courtesy column or not yet
  // spoken for, while the column before it belongs to the part already seated
  // there. So the array goes in turned round, dot and common at the right-hand
  // end, which is also how a person plugs one in: the marked end towards the
  // room the wire to the rail needs.
  //
  // It is TRIED rather than assumed. Each orientation is put through the same
  // node-by-node proof below, so an arrangement that does not line up is
  // refused rather than seated wrong — this can cost columns, never
  // correctness.
  const orientations =
    part.def.reversible === true ? [undefined, { rot: 180 }] : [undefined];
  for (const params of orientations) {
    const seat = companionSeat(part, links, {
      alloc,
      host,
      hostId,
      type: boardType.get(host.boardId),
      params,
    });
    if (seat) return seat;
  }
  return null;
}

/**
 * The seat itself: derive the anchor, prove every linked pin lands on its
 * host's node, prove the columns are free, the host's, or a blank courtesy
 * column, and claim it. Null if any of that fails — the caller then falls back
 * to the ordinary seating path, so this can cost columns, never correctness.
 */
function companionSeat(part, links, { alloc, host, hostId, type, params }) {
  // One linked pin fixes the anchor: it must land in the same COLUMN as the
  // host pin it is electrically equal to, in the row furthest from the trench
  // so the two never collide. The anchor is that column MINUS the pin's own
  // footprint offset AT THIS ORIENTATION — which is 0 only when pin 1 itself
  // is linked, and the array's is not. Any link serves; every one of them is
  // then proved against `nodeOf` below, so this only has to get the arithmetic
  // right, not the choice.
  const first = links[0];
  const seed = host.holes.get(first.hostPin);
  const m = seed && GRID_HOLE_RE.exec(seed);
  if (!m) return null;
  const offsets = part.def.footprint?.offsets;
  const idx = part.def.pins.findIndex((p) => p.n === first.pin);
  if (!offsets || idx < 0) return null;
  const offset = offsets[params?.rot === 180 ? offsets.length - 1 - idx : idx];
  if (offset == null) return null;
  const col = Number(m[2]) - offset;
  if (col < 1) return null; // it would start off the left of the board
  const anchor = `${isLowerRow(m[1]) ? "a" : "j"}${col}`;

  const pins = partPinHoles(part.ref, anchor, params);
  if (!pins) return null;
  const holeOf = new Map(pins.map((q) => [q.pin, q.hole]));

  // Prove the equality geometrically: same NODE, every linked pin.
  for (const link of links) {
    const mine = holeOf.get(link.pin);
    const theirs = host.holes.get(link.hostPin);
    if (!mine || !theirs) return null;
    if (nodeOf(type, mine) !== nodeOf(type, theirs)) return null;
  }
  // …and touch nobody else's columns, including the pack's own spare pins.
  // The array's COM is exactly such a spare: it has no switch position to sit
  // under, so it lands in the blank courtesy column the host reserved after
  // itself — the host's, hence allowed, and blank, hence connected to nothing.
  for (const { hole } of pins) {
    if (hole == null) continue;
    const g = GRID_HOLE_RE.exec(hole);
    if (!g) return null;
    const owner = alloc.columnOwner(
      host.boardId,
      Number(g[2]),
      isLowerRow(g[1]) ? "lower" : "upper",
    );
    if (owner != null && owner !== hostId) return null;
  }

  const r = alloc.seat(host.boardId, part.ref, anchor, params, hostId);
  if (!r.ok) return null;
  return { boardId: host.boardId, anchor, holes: r.holes, params };
}

/**
 * How far either side of the straight-down hole a plugged-in resistor may lean
 * to find the rail (columns). A rail is drilled in groups of five with a gap
 * between, so one column in six has no hole straight across it, and the line
 * does not start until the board's second or third column.
 */
const PLUG_LEAN = 2;
/** A rail hole this near a plugged-in resistor's lead lies under its body
    (half a pitch wide, discrete-view.js), so no wire may end in it. */
const PLUG_COVERS = 0.6;

/** Distance from point `p` to the segment `a`→`b`. */
function segmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Plug a lamp's resistor in: its top lead in row a of the column the lamp's
 * rail leg is in, its other lead bent straight down into the rail strip under
 * the board. The lamp sits in row b of that column, so the board joins lamp
 * and resistor, the rail joins resistor and supply, and neither needs a wire.
 *
 * The same proof as `seatCompanion`, for the same reason — it shares a
 * column-half with another part, which column-allocator.js otherwise forbids:
 * the net equality is GIVEN (the resistor rule created the LIMITED net holding
 * exactly the lamp's leg and pin 1), and the geometry is PROVED — the part is
 * resolved the way the loader resolves it, and both leads must land in exactly
 * the holes chosen, pin 1 on the lamp's own node.
 *
 * The lead goes straight down where the rail has a hole there, else leans a
 * column or two (`PLUG_LEAN`), away from the lamp's other leg first. The rail
 * holes under its body are claimed and left EMPTY, so no supply lead is later
 * planted beneath it.
 *
 * Null whenever any of that fails, and the caller seats the resistor the
 * ordinary way, wired — this can cost wires, never correctness. L4 checks the
 * result regardless.
 *
 * @returns {{boardId:string, anchor:string, holes:Map, params:object,
 *   rails:Map<number, {rail:string, address:string}>}|null}
 */
function seatPlug(part, plug, ctx) {
  const { alloc, seatOf, kits, boards, boardType, worldOf } = ctx;
  const host = seatOf.get(plug.hostId);
  const leg = host?.holes.get(plug.hostPin);
  const m = leg && GRID_HOLE_RE.exec(leg);
  const kit = kits.find((k) => k.pins === host?.boardId);
  if (!m || !isLowerRow(m[1]) || !kit) return null;
  const anchor = `a${m[2]}`;
  const top = `${host.boardId}.${anchor}`;
  const from = worldOf(top);
  if (!from || alloc.isClaimed(top)) return null;
  const type = boardType.get(host.boardId);
  if (nodeOf(type, anchor) !== nodeOf(type, leg)) return null;

  // Lean AWAY from the lamp's other leg: the resistor then hangs off the leg
  // it belongs to, clear of the column the lamp's driver is wired into.
  const other = [...host.holes.values()].find((h) => h !== leg);
  const otherAt = other && worldOf(`${host.boardId}.${other}`);
  const away = otherAt ? Math.sign(from.x - otherAt.x) : 1;
  const strip = kit.rails[1];
  const candidates = alloc
    .freeRailHoles(strip, plug.rail === "GND" ? "-" : "+")
    .map((address) => ({ address, at: worldOf(address) }))
    .filter((c) => c.at && Math.abs(c.at.x - from.x) <= PLUG_LEAN + 0.01)
    .sort((p, q) => {
      const dp = p.at.x - from.x;
      const dq = q.at.x - from.x;
      return (
        Math.abs(dp) - Math.abs(dq) ||
        Number(Math.sign(dq) === away) - Number(Math.sign(dp) === away)
      );
    });

  for (const { address, at } of candidates) {
    const params = part.def.normalizeParams({
      rot: 90,
      end: { dx: at.x - from.x, dy: at.y - from.y },
    });
    if (!params.end) continue;
    if (Math.hypot(params.end.dx, params.end.dy) < (part.def.minSpan ?? 0)) {
      continue;
    }
    const lands = partPinAddresses(
      { boards },
      { ref: part.ref, board: host.boardId, anchor, params },
    );
    const landed = new Map(lands?.map((q) => [q.pin, q.address]) ?? []);
    if (landed.get(1) !== top || landed.get(2) !== address) continue;
    // The column-half is the LAMP's, and stays so: it is the lamp's node.
    const r = alloc.seat(host.boardId, part.ref, anchor, params, plug.hostId);
    if (!r.ok) return null;
    alloc.claim(address);
    for (const polarity of ["+", "-"]) {
      for (const under of alloc.freeRailHoles(strip, polarity)) {
        const w = worldOf(under);
        if (w && segmentDistance(w, from, at) < PLUG_COVERS) alloc.claim(under);
      }
    }
    return {
      boardId: host.boardId,
      anchor,
      holes: r.holes,
      params,
      rails: new Map([[2, { rail: plug.rail, address }]]),
    };
  }
  return null;
}

/**
 * A single LED: one junction, two legs side by side — the lamp whose resistor
 * plugs in (`seatPlug`). A display or a bar has `segments` instead.
 */
const isBareLed = (def) => typeof def?.polarity === "function" && !def.segments;

/**
 * The junctions of a light-emitting part, as the legs a series resistor could
 * go in.
 *
 * A common-cathode display is ONE such leg (its K, which heads for GND) and a
 * common-anode one likewise (its A, for VCC): one resistor in the common leg
 * limits every segment. An isolated display (`bar8iso`) and a bare LED have a
 * junction per segment with BOTH legs free, and either may be the one on a
 * rail — the cathode on GND under an active-high output, or the anode on VCC
 * over an active-LOW one, which is exactly how the prompt tells the model to
 * wire a lamp for an active-low signal.
 *
 * @returns {{common: {pin, rail}|null, junctions: Array<{anodePin, cathodePin}>}}
 */
/** A part you operate while the circuit runs: anything with `contact` pins
    (a slide switch, a push button, a DIP switch bank). */
const operated = (def) => def?.pins?.some((p) => p.role === "contact") === true;

/**
 * The row a one-row part seats in: row a, along the bottom rail — except a
 * part you OPERATE, which seats in row h, the middle of the upper half.
 *
 * Wires draw ABOVE parts, and a switch under one cannot be clicked. Every
 * slide switch the demo corpus compiles (219 of them) had a wire over its knob
 * when they sat in row a: all four spare holes of their nodes were ABOVE them,
 * so the supply lead to the bottom rail ran straight across the knob, and
 * every run along rows b–e hung down over it (a drawn wire sags below its
 * chord). Row h is where the demo bench has always put them, for the reason
 * that holds here: two holes above (i, j) for the lead to the top rail, two
 * below (f, g) for the signal, so neither crosses the switch, and a run's sag
 * falls away from it. Row e (the trench side) was tried and is worse — it is
 * exactly where every wire crossing the trench passes. With the drawn-wire
 * router (`drawnCrossings`) it leaves 3 of 219 covered.
 *
 * Resistor networks, LEDs and bars keep row a — nobody clicks those — except
 * an LED whose resistor plugs in beneath it, which takes row b (`seatPlug`).
 * A DIP switch bank straddles the trench like any DIP, so it never asks.
 * @param {object} def
 * @returns {"a"|"h"}
 */
function seatRowOf(def) {
  return operated(def) ? "h" : "a";
}

/**
 * How far an operated part's routing box reaches past its pins (pitch): its
 * knob is ±0.45 about the pin row and a wire's hit stroke half a pitch either
 * side of the wire, so a wire nearer than this takes the click. Short of 1 so
 * the holes one row away — where the part's own wires leave — stay outside it.
 */
const OPERATED_MARGIN = 0.95;

/**
 * How far a bare LED's routing box reaches past its pins (pitch): its dome, as
 * the desk draws it (discrete-view.js, r 0.85), is wider than the box around
 * its two holes. Seated in row b it reaches up toward row c, where runs along
 * the board pass, and a wire drawn across the dome hides the lamp it is there
 * to show.
 */
const LAMP_DOME = 0.85;

function lampLegs(def) {
  if (def.segments?.length) {
    const first = def.segments[0];
    if (def.segments.every((s) => s.cathodePin === first.cathodePin)) {
      return { common: { pin: first.cathodePin, rail: "GND" }, junctions: [] };
    }
    if (def.segments.every((s) => s.anodePin === first.anodePin)) {
      return { common: { pin: first.anodePin, rail: "VCC" }, junctions: [] };
    }
    return { common: null, junctions: def.segments };
  }
  if (typeof def.polarity === "function") {
    const { anodePin, cathodePin } = def.polarity({});
    return { common: null, junctions: [{ anodePin, cathodePin }] };
  }
  return { common: null, junctions: [] };
}

function assemble(resolved, title, notes) {
  const { parts, nets } = resolved;
  const warnings = [];

  // Split into board-seated parts and desk bricks.
  const seated = [];
  const bricks = [];
  for (const p of parts.values()) {
    if (p.def.terminals?.length) bricks.push(p);
    else seated.push(p);
    // A netlist has nowhere to put memory CONTENTS, so a ROM arrives holding
    // whatever its fresh backing file holds — noise. Nothing downstream can
    // tell that from a program, so it is said here, to the person placing it.
    if (isRomChip(p.def)) {
      warnings.push({
        code: "ROM_UNPROGRAMMED",
        message:
          `${p.id} (${p.ref}) arrives unprogrammed — a netlist cannot carry ` +
          `memory contents. Load an image through its Properties before ` +
          `running the circuit.`,
      });
    }
  }

  // ── Spare CMOS inputs (Feature 400). A CD4000 input on no net floats, and a
  //    floating CMOS input reads UNKNOWN — so a spare gate the spec rightly
  //    says nothing about would make the engine warn about a correct design.
  //    The compiler ties every such input to GND, as a bench does, exactly as
  //    it interposes the resistor an LED needs: a netlist should not have to
  //    mention either. Only inputs nothing uses (spec-lint's
  //    `spareCmosInputs`) — one the part DOES use and the spec left out is a
  //    mistake for L6 to report, not something to paper over.
  const spare = spareCmosInputs([...parts.values()], nets);
  if (spare.length) {
    let gnd = nets.find((n) => n.rail === "GND");
    if (!gnd) {
      gnd = { name: "GND", pins: [], rail: "GND" };
      nets.push(gnd);
    }
    for (const s of spare) {
      for (const p of s.pins) {
        gnd.pins.push({ partId: s.partId, ok: true, kind: "pin", pin: p.n });
      }
    }
    warnings.push({
      code: "SPARE_INPUTS_TIED",
      message:
        `Tied the unused inputs of ` +
        spare
          .map(
            (s) =>
              `${s.partId} (${s.ref}: ${s.pins.map((p) => p.name).join(", ")})`,
          )
          .join("; ") +
        ` to GND — a floating CMOS input reads neither HIGH nor LOW.`,
    });
  }

  // ── The resistor rule. A lamp leg that goes STRAIGHT to a rail gets a series
  //    resistor interposed, because a junction across two strongly driven nets
  //    burns rather than lights (sim/junction.js).
  //
  //    Legs are limited per NODE. The lamp legs the spec puts in one rail net
  //    are joined to each other already — a display's common leg, or a row of
  //    LEDs whose cathodes share a net — so they are ONE common leg and take
  //    one resistor, exactly as a common-cathode bar does. Legs on different
  //    nets are different nodes and each needs its own; those are packed eight
  //    to a bussed `rnet9` (COM on the rail), however many parts they come from,
  //    because eight LEDs hanging off one rail is one resistor network on a
  //    bench, not eight loose resistors.
  //
  //    The legs are taken OUT of the rail net rather than the rail being taken
  //    off the net. The net may be the named `GND` holding everything else the
  //    spec tied low, and detaching its rail would hang all of that off the
  //    lamp's side of the resistor.
  //
  //    A bare LED is the exception to both of those groupings: it gets a
  //    resistor of its OWN, PLUGGED IN (`seatPlug`) — see below.
  const interposed = [];
  const netOf = (partId, pin, rail) =>
    nets.find(
      (n) =>
        n.rail === rail &&
        n.pins.some((q) => q.partId === partId && q.pin === pin),
    );
  const legs = []; // {part, pin, rail, net}
  const bareLegs = []; // …the same, for a bare LED
  for (const p of seated) {
    const { common, junctions } = lampLegs(p.def);
    if (common) {
      const net = netOf(p.id, common.pin, common.rail);
      if (net) legs.push({ part: p, ...common, net });
    }
    for (const j of junctions) {
      // One resistor per junction is enough, so a lamp tied across both rails
      // is limited once, in its cathode.
      const k = netOf(p.id, j.cathodePin, "GND");
      const a = k ? null : netOf(p.id, j.anodePin, "VCC");
      const leg = k
        ? { part: p, pin: j.cathodePin, rail: "GND", net: k }
        : a
          ? { part: p, pin: j.anodePin, rail: "VCC", net: a }
          : null;
      if (leg) (isBareLed(p.def) ? bareLegs : legs).push(leg);
    }
  }
  const nodes = new Map(); // rail net → its lamp legs, one node
  for (const leg of legs) {
    if (!nodes.has(leg.net)) nodes.set(leg.net, []);
    nodes.get(leg.net).push(leg);
  }
  let limitSeq = 0;
  const limiterId = (node) => {
    const owners = new Set(node.map((l) => l.part.id));
    let rid = owners.size === 1 ? `${node[0].part.id}_R` : "";
    while (!rid || parts.has(rid)) rid = `RLIM${++limitSeq}`;
    return rid;
  };
  for (const rail of ["GND", "VCC"]) {
    const group = [...nodes].filter(([net]) => net.rail === rail);
    for (let i = 0; i < group.length; i += 8) {
      const chunk = group.slice(i, i + 8);
      const pack = chunk.length > 1;
      const ref = pack ? "rnet9" : "resistor";
      const rid = pack ? limiterId([]) : limiterId(chunk[0][1]);
      const limiter = { id: rid, ref, def: partDef(ref), label: null };
      parts.set(rid, limiter);
      seated.push(limiter);
      interposed.push({ resistor: limiter });
      chunk.forEach(([net, node], k) => {
        const lamp = (q) =>
          node.some((l) => l.part.id === q.partId && l.pin === q.pin);
        nets.push({
          name: `${net.name}_LIMITED`,
          pins: [
            ...net.pins.filter(lamp),
            // A pack's elements are pins 2–9 (pin 1 is COM); a lone resistor's
            // lamp end is pin 1.
            { partId: rid, kind: "pin", pin: pack ? 2 + k : 1 },
          ],
          rail: null,
        });
        net.pins = net.pins.filter((q) => !lamp(q));
      });
      nets.push({
        name: `${rid}_${rail}`,
        pins: [{ partId: rid, kind: "pin", pin: pack ? 1 : 2 }],
        rail,
      });
      const owners = [
        ...new Set(chunk.flatMap(([, node]) => node.map((l) => l.part.id))),
      ].join(", ");
      warnings.push({
        code: "RESISTOR_INSERTED",
        message:
          `Added ${pack ? "a resistor network" : "a series resistor"} ` +
          `between ${owners} and ${rail} — an LED across two strongly ` +
          `driven nets burns instead of lighting.`,
      });
    }
  }

  // ── A bare LED's resistor is its OWN, and it PLUGS IN.
  //
  // The bench build: the resistor's top lead goes into the column the lamp's
  // rail leg is in, and its other lead straight into the rail — so the lamp,
  // the resistor and the rail are joined by the board alone. Routed like any
  // other part it came out as three wires (output → lamp → resistor → rail),
  // two of them doing nothing a resistor's own legs could not.
  //
  // So one resistor per LED, never a shared one and never a pack: a resistor
  // can only plug into ONE lamp's column, and a pack's nine pins lie along a
  // row that no two lying-down LEDs can line up with. That is also how a bench
  // does it — one resistor per LED, so each lamp's current is its own. The
  // LIMITED net is exactly what the board will join: the lamp's leg and the
  // resistor's pin 1, nothing else. `plugOf` is the "net equality proven
  // first" `seatPlug` relies on, created here as the pull rule creates its own.
  const plugOf = new Map(); // resistor id → {hostId, hostPin, rail}
  const netNames = new Set(nets.map((n) => n.name));
  const freshName = (...bases) => {
    let name = bases.find((b) => !netNames.has(b));
    for (let k = 2; !name; k++) {
      if (!netNames.has(`${bases[0]}_${k}`)) name = `${bases[0]}_${k}`;
    }
    netNames.add(name);
    return name;
  };
  for (const rail of ["GND", "VCC"]) {
    const mine = bareLegs.filter((leg) => leg.rail === rail);
    for (const leg of mine) {
      const rid = limiterId([leg]);
      const limiter = {
        id: rid,
        ref: "resistor",
        def: partDef("resistor"),
        label: null,
      };
      parts.set(rid, limiter);
      seated.push(limiter);
      interposed.push({ resistor: limiter });
      plugOf.set(rid, { hostId: leg.part.id, hostPin: leg.pin, rail });
      const isLeg = (q) => q.partId === leg.part.id && q.pin === leg.pin;
      nets.push({
        name: freshName(
          `${leg.net.name}_LIMITED`,
          `${leg.part.id}_${rail}_LIMITED`,
        ),
        pins: [
          ...leg.net.pins.filter(isLeg),
          { partId: rid, kind: "pin", pin: 1 },
        ],
        rail: null,
      });
      leg.net.pins = leg.net.pins.filter((q) => !isLeg(q));
      nets.push({
        name: freshName(`${rid}_${rail}`),
        pins: [{ partId: rid, kind: "pin", pin: 2 }],
        rail,
      });
    }
    if (mine.length) {
      const ids = mine.map((leg) => leg.part.id);
      warnings.push({
        code: "RESISTOR_INSERTED",
        message:
          (ids.length > 1
            ? `Added a series resistor to each of ${ids.join(", ")}, ` +
              `between the LED and ${rail}`
            : `Added a series resistor between ${ids[0]} and ${rail}`) +
          ` — an LED across two strongly driven nets burns instead of ` +
          `lighting.`,
      });
    }
  }

  // A rail net the lamps were the only members of is now just a rail.
  for (let i = nets.length - 1; i >= 0; i--) {
    if (nets[i].rail && !nets[i].pins.length) nets.splice(i, 1);
  }

  // ── The pull rule. A SWITCH DRIVES NOTHING.
  //
  // A switch is a CONTACT: closed it joins its two pins, open it joins nothing
  // at all. So an input fed from a switch that reaches VCC is HIGH while the
  // switch is closed and FLOATING while it is open — and a floating TTL input
  // reads HIGH too (sim/levels.js). The result is a switch that appears to do
  // nothing, which is the most convincing wrong answer this compiler can
  // produce; the honest version, an undriven net, is what L6 rejects.
  //
  // That is the same class of fact as the LED's series resistor above: bench
  // physics the netlist should not have to state, and the reason every real
  // build of this circuit has a resistor pack next to the switch bank. So a
  // signal net whose only path to a supply runs through a contact gets a pull
  // to the OPPOSITE rail.
  //
  // Which rail is DERIVED, never assumed: it is read off the far side of the
  // contact, so a GND-side switch gets a pull-UP and an active-high one a
  // pull-DOWN. A net whose switches disagree — or whose far side reaches no
  // rail at all — is left exactly as declared, for L6 to report against the
  // spec rather than for this to guess at.
  const netOfPin = new Map();
  for (const net of nets) {
    for (const q of net.pins) {
      if (q.kind === "pin") netOfPin.set(`${q.partId}.${q.pin}`, net);
    }
  }
  const roleOf = (q) =>
    parts.get(q.partId).def.pins?.find((r) => r.n === q.pin)?.role;
  const pulls = []; // { net, rail } — the rail the pull reaches
  const companionOf = new Map(); // pack id → [{pin, hostId, hostPin}]
  for (const net of [...nets]) {
    // Already tied to a supply, already driven, or already pulled: a spec that
    // brought its own resistor network keeps it, rather than getting a second
    // one in parallel doing the same job.
    if (net.rail) continue;
    // An OPEN-COLLECTOR output only ever pulls LOW: a net whose every output
    // is one floats whenever none of them is pulling, so it gets a pull-up
    // as surely as a switched input gets its pull — whatever reads it.
    const outs = net.pins.filter((q) => roleOf(q) === "output");
    const openOnly =
      outs.length > 0 &&
      outs.every((q) => openCollectorPins(parts.get(q.partId).def).has(q.pin));
    if (outs.length && !openOnly) continue;
    if (net.pins.some((q) => parts.get(q.partId).def.weakBridges)) continue;
    if (openOnly) {
      // …but only a net something READS: an open-collector output sinking a
      // lamp's cathode (a '47 into a common-anode digit) is pulled up by the
      // lamp and its resistor, and needs nothing more.
      if (net.pins.some((q) => roleOf(q) === "input")) {
        pulls.push({ net, rail: "VCC", openCollector: true });
      }
      continue;
    }
    const reaches = new Set();
    for (const q of net.pins) {
      if (q.kind !== "pin") continue;
      for (const [a, b] of contactPairs(parts.get(q.partId).def)) {
        const far = a === q.pin ? b : b === q.pin ? a : null;
        if (far == null) continue;
        const rail = netOfPin.get(`${q.partId}.${far}`)?.rail;
        if (rail) reaches.add(rail);
      }
    }
    if (reaches.size !== 1) continue;
    pulls.push({ net, rail: [...reaches][0] === "VCC" ? "GND" : "VCC" });
  }

  // Materialize them in packs, exactly as a person would: one bussed `rnet9`
  // per eight pulls to the same rail (its COM is the shared bus), and a bare
  // resistor when a lone signal would otherwise burn nine columns on one
  // element. Both are weak couplers, so a closed switch's supply still wins.
  let pullSeq = 0;
  const openNets = new Set(pulls.filter((p) => p.openCollector).map((p) => p.net)); // prettier-ignore
  for (const rail of ["GND", "VCC"]) {
    const group = pulls.filter((p) => p.rail === rail).map((p) => p.net);
    for (let i = 0; i < group.length; i += 8) {
      const chunk = group.slice(i, i + 8);
      const lone = chunk.length === 1;
      const ref = lone ? "resistor" : "rnet9";
      let rid = `PULL${++pullSeq}`;
      while (parts.has(rid)) rid = `PULL${++pullSeq}`;
      // A pull-down holds a 74LS input low only through 1 kΩ — the input
      // sources current while it is low — and a pack is as strong as the
      // weakest input on it needs (catalog/families.js `pullDownOhms`). A
      // pull-up is 10 kΩ on every family.
      const ohms =
        rail === "GND"
          ? Math.min(
              ...chunk.flatMap((net) =>
                net.pins
                  .filter((q) => q.kind === "pin" && roleOf(q) === "input")
                  .map((q) => pullDownOhms(parts.get(q.partId).def)),
              ),
              10000,
            )
          : 10000;
      const part = {
        id: rid,
        ref,
        def: partDef(ref),
        label: null,
        params: { ohms },
      };
      parts.set(rid, part);
      seated.push(part);
      // A pack's elements are pins 2–9 (pin 1 is COM, the shared bus); a lone
      // resistor's are 1 and 2.
      //
      // The elements are handed out BACKWARDS — net 0 to pin 9, net 7 to pin 2
      // — and they are interchangeable, so this costs nothing and buys the
      // seat: `seatCompanion` puts the array in TURNED ROUND, and numbering it
      // from the far end back is what then lands element k on net k. Why it
      // must go in turned round is argued there; the short version is that the
      // odd ninth pin can only overhang to the RIGHT, so COM has to be the
      // right-hand end.
      chunk.forEach((net, k) => {
        net.pins.push({ partId: rid, kind: "pin", pin: lone ? 1 : 9 - k });
      });
      // Which switch pin each pack pin is now electrically identical to. This
      // is the "net equality proven first" that column-allocator.js asks for
      // before one part may be seated in another's columns: these nets are not
      // matched by name or guessed at from geometry, they were CREATED here,
      // one per pack pin, each already holding that switch contact.
      companionOf.set(
        rid,
        chunk
          .map((net, k) => {
            const host = net.pins.find(
              (q) =>
                q.kind === "pin" &&
                q.partId !== rid &&
                contactPairs(parts.get(q.partId).def).length,
            );
            return host
              ? {
                  pin: lone ? 1 : 9 - k,
                  hostId: host.partId,
                  hostPin: host.pin,
                }
              : null;
          })
          .filter(Boolean),
      );
      nets.push({
        name: `${rid}_${rail}`,
        pins: [{ partId: rid, kind: "pin", pin: lone ? 2 : 1 }],
        rail,
      });
      const named = (nets) => nets.map((n) => `"${n.name}"`).join(", ");
      const switched = chunk.filter((n) => !openNets.has(n));
      const open = chunk.filter((n) => openNets.has(n));
      if (switched.length) {
        warnings.push({
          code: "PULL_INSERTED",
          message:
            `Added a ${rail === "GND" ? "pull-down" : "pull-up"} on ` +
            `${named(switched)} — a switch joins its pins, it does not ` +
            `drive them, so an open one leaves the input floating.`,
        });
      }
      if (open.length) {
        warnings.push({
          code: "PULL_INSERTED",
          message:
            `Added a pull-up on ${named(open)} — an open-collector output ` +
            `only pulls LOW, so without one its net floats instead of ` +
            `reading HIGH.`,
        });
      }
    }
  }

  // ── Boards. One pin-board's worth of columns per kit; spill to more kits.
  // Deliberately PESSIMISTIC: it counts a pull pack's nine columns even though
  // companion seating will usually fold it into the switch bank's own, because
  // whether that succeeds is a geometric question this cannot answer yet.
  // Guessing high costs a board that `#pruneKits` then takes back; guessing low
  // costs a NO_ROOM refusal, and only one of those is recoverable.
  //
  // A plugged-in resistor is the one part counted at NOTHING. It stands in its
  // lamp's own column with its other lead in the rail, so it never owns a
  // column — and unlike a pull pack's seat, which needs a host's geometry to
  // line up, it needs only a free rail hole within two columns of the lamp,
  // and nothing is wired to a rail until every part is seated. Counted at four
  // columns a lamp, eight LEDs would book a full board for a design that fits
  // on a half.
  const budget = seated.reduce(
    (n, p) => n + (plugOf.has(p.id) ? 0 : spanOf(p.def) + GAP),
    0,
  );
  const kitKey = budget <= 30 ? "half" : "full";
  const perKit = kitKey === "half" ? 30 : 63;
  const kitCount = Math.max(1, Math.ceil(budget / perKit));

  // The boards SNAP TOGETHER, and a stacked pair SHARES the rail between them.
  // That is what a bench does: dovetail two 830s and the strip in the middle
  // serves the board above it and the board below it — you do not fit a second
  // one against it. So the stack is one RUN of strips,
  //
  //   rail · pins · rail · pins · rail          (not rail·pins·rail  gap  rail·pins·rail)
  //
  // and the shared strip belongs to BOTH kits' `rails`. Everything downstream
  // falls out of that: the bridge loop chains R0–R1–R2 by itself, so the two
  // wires that used to run from kit 1 to kit 2 — the height of a whole
  // breadboard, over everything in between — are not needed at all.
  //
  // One `group` for the run, so it drags as a unit and the selection outline
  // traces the assembly rather than one strip of it. A kit added from the
  // palette arrives grouped the same way (`DeskDoc.addKit`); the compiler used
  // to leave every strip loose, so even a single generated kit came apart when
  // the pin-board was dragged. `pasteDesign` re-mints the id on the way in.
  const kitStrips = BREADBOARD_KITS[kitKey].strips;
  const railStrip = kitStrips.find((s) => s.type.startsWith("rail"));
  const pinsStrip = kitStrips.find((s) => !s.type.startsWith("rail"));

  const boards = [];
  const kits = [];
  let boardSeq = 0;
  let stackY = 0;
  const addStrip = (strip) => {
    const id = `bb${++boardSeq}`;
    boards.push({
      id,
      type: strip.type,
      x: strip.dx,
      y: stackY,
      rot: 0,
      group: "g1",
    });
    stackY += boardSize(strip.type).height;
    return id;
  };
  let above = addStrip(railStrip);
  for (let k = 0; k < kitCount; k++) {
    const pins = addStrip(pinsStrip);
    const below = addStrip(railStrip);
    kits.push({ pins, rails: [above, below] });
    above = below; // the next board's TOP rail is this one's bottom rail
  }

  const boardType = new Map(boards.map((b) => [b.id, b.type]));
  const boardAt = new Map(boards.map((b) => [b.id, b]));

  /** Desk position of any address the compiler can emit — hole or terminal. */
  const worldOf = (address) => {
    const parsed = parseAddress(address);
    if (!parsed) return null;
    const board = boardAt.get(parsed.boardId);
    if (board) {
      const at = holePosition(board.type, parsed.hole, board.rot ?? 0);
      return at ? { x: board.x + at.x, y: board.y + at.y } : null;
    }
    const brick = components.find((c) => c.id === parsed.boardId);
    const pad = partDef(brick?.ref)?.terminals?.find(
      (t) => t.id === parsed.hole,
    );
    return pad ? { x: brick.x + pad.dx, y: brick.y + pad.dy } : null;
  };
  const distance = (a, b) =>
    a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Infinity;
  const components = [];
  const wires = [];
  let wireSeq = 0;
  // Every generated wire is DIRECT, whatever Settings ▸ Appearance ▸ "Wire
  // layout" says: that setting seeds a wire the USER lays, and a routed wire's
  // shape is a hand gesture. The compiler decides holes; it has no opinion
  // about the path between them, and emitting one would be a route nobody
  // drew. So no `layout` field here — the default IS the omission.
  const wire = (from, to, color = "black") => {
    if (!from || !to || from === to) return false;
    wires.push({ id: `w${++wireSeq}`, from, to, color });
    return true;
  };

  // ── Power. A PSU brick, then bridge every rail strip to the first kit's.
  const boardRight = Math.max(...boards.map((b) => b.x + 64));
  components.push({
    id: "psu1",
    kind: "psu",
    ref: "psu",
    x: boardRight + 4,
    y: 0,
    params: { volts: 5 },
  });
  // A dropped POWER wire is the one failure here that would be invisible:
  // `wire` skips a null endpoint, so an exhausted supply leaves a chip
  // unpowered in a document that still loads and still settles. The verifier
  // catches it downstream at L5 — as CHIP_NOT_OK, kind REPAIR — and hands it
  // back to the model as the spec's mistake, which it is not: a netlist never
  // mentions power, so there is nothing there for anyone to fix. Recorded here,
  // where it happened, and fatal.
  const unpowered = [];
  const powerWire = (from, to, colour, what) => {
    if (!wire(from, to, colour)) unpowered.push(what);
  };

  // The bridges and the PSU's own leads are wired AFTER the parts are seated
  // (see `wirePower` below) — a bridge runs from the strip above the board to
  // the strip below it, straight across the pin-board, so which column it picks
  // decides whether it lands in a gap or straight over a chip. Before seating
  // there is nothing to avoid; hole 1 was taken every time, and column 1 is
  // exactly where the first part goes.

  // ── Bricks the spec declared (a clock, say) — to the right of the boards.
  // Each brick takes its OWN kind's next id — the prefix and numbering the
  // document's id rules expect (`psu<n>`, `clk<n>`, `load<n>`; desk-doc.js) —
  // counted per kind and after the `psu1` planted above. A shared counter
  // named a spec's PSU `psu1` a second time, and anything else `brk<n>`,
  // which the loader drops; the verifier then aborted as if the compiler
  // were broken.
  const brickAt = new Map();
  const brickSeq = new Map([["psu", 1]]);
  let brickRow = 12;
  for (const b of bricks) {
    const prefix = { clock: "clk", psu: "psu", load: "load" }[b.def.kind] ?? b.def.kind; // prettier-ignore
    const n = (brickSeq.get(prefix) ?? 0) + 1;
    brickSeq.set(prefix, n);
    const id = `${prefix}${n}`;
    components.push({
      id,
      kind: b.def.kind,
      ref: b.ref,
      x: boardRight + 4,
      y: brickRow,
      params: {},
    });
    brickAt.set(b.id, id);
    brickRow += 8;
  }

  // ── Seat every board part, left to right, in CONNECTIVITY order, so
  //    neighbours end up beside each other and a net's parts stay on one board.
  //
  // `assignment` names the board each part should go on. It is a PREFERENCE:
  // the assigned board is tried first, and if it will not take the part every
  // board is tried again ignoring it. So it can only change WHICH board a part
  // lands on, never whether it lands at all — the layout is a preference, the
  // fit is not.
  //
  // A plugged-in resistor stands in its lamp's column, so it has to come AFTER
  // its lamp: each is taken out and put back straight behind it.
  const order = orderByConnectivity(seated, nets).filter(
    (p) => !plugOf.has(p.id),
  );
  for (const [rid, plug] of plugOf) {
    const at = order.findIndex((p) => p.id === plug.hostId);
    order.splice(at < 0 ? order.length : at + 1, 0, parts.get(rid));
  }
  const lampsWithPlugs = new Set([...plugOf.values()].map((x) => x.hostId));
  const seatPass = (assignment = null, gap = GAP) => {
    const alloc = createAllocator(boards);
    const seatOf = new Map(); // specId → {compId, boardId, holes}
    const parts = [];
    let seq = 0;
    for (const p of order) {
      const span = spanOf(p.def);
      if (!span) {
        return {
          ok: false,
          error: err(
            "UNPLACEABLE",
            `"${p.ref}" has no footprint the compiler can seat.`,
            { kind: ABORT },
          ),
        };
      }
      // A DIP straddles the trench; everything else lies along one row. A
      // character-LCD module is the one part whose row is not a free choice:
      // its body reaches off the header edge, so a body-UP module (the 16×2,
      // header along its bottom edge) has to go on the TOP row or it buries
      // the board it is plugged into, and its own wiring holes with it.
      //
      // A lamp whose resistor plugs in goes one row up, in row b: row a of its
      // column is where that resistor's lead goes in (`seatPlug`).
      const row = p.def.package
        ? "e"
        : p.def.characterDisplay?.headerEdge === "bottom"
          ? "j"
          : lampsWithPlugs.has(p.id)
            ? "b"
            : seatRowOf(p.def);
      // A pull pack goes UNDER the switch bank it pulls, in the very columns
      // that bank owns — because its pins are already that bank's nets, so the
      // board does the connecting. Eight wires and nine columns become none.
      // It costs no columns of its own: it is IN its host's.
      //
      // A lamp's resistor plugs into the lamp's column the same way, and into
      // the rail below it: two wires and four columns become none.
      const plug = plugOf.get(p.id);
      let placed =
        seatCompanion(p, companionOf.get(p.id), {
          alloc,
          seatOf,
          boardType,
        }) ??
        (plug
          ? seatPlug(p, plug, {
              alloc,
              seatOf,
              kits,
              boards,
              boardType,
              worldOf,
            })
          : null);
      // Reserve a blank column after the part as well, so neighbours do not
      // read as one block — the same courtesy a person building this leaves.
      const cost = span + gap;
      for (const honour of placed ? [] : [true, false]) {
        if (placed) break;
        for (const [k, kit] of kits.entries()) {
          if (honour && assignment != null && assignment.get(p.id) !== k) {
            continue;
          }
          const start = alloc.reserveColumns(kit.pins, cost, "both", p.id);
          if (start == null) continue;
          const anchor = `${row}${start}`;
          const r = alloc.seat(kit.pins, p.ref, anchor, {}, p.id);
          if (!r.ok) continue;
          placed = { boardId: kit.pins, anchor, holes: r.holes };
          break;
        }
      }
      if (!placed) {
        return {
          ok: false,
          error: err(
            "NO_ROOM",
            `Ran out of board for "${p.id}" (${p.ref}); the design needs more columns.`,
            { kind: ABORT },
          ),
        };
      }
      const compId = `c${++seq}`;
      parts.push({
        id: compId,
        kind: p.def.kind,
        ref: p.ref,
        board: placed.boardId,
        anchor: placed.anchor,
        // A companion may have been seated turned END-FOR-END, and then the
        // orientation IS the seat: its pins land where they land because of it.
        // Every other path seats a part as it comes (`{}`).
        params: { ...(p.params ?? {}), ...(placed.params ?? {}) },
      });
      seatOf.set(p.id, { compId, ...placed });
    }
    const used = new Set([...seatOf.values()].map((s) => s.boardId));
    return { ok: true, alloc, seatOf, parts, used };
  };

  // TWO PASSES, and the second is what stops a spilled design reading as an
  // accident. Pass 1 fills each board before starting the next, which is the
  // only way to learn how many boards a design ACTUALLY needs — the budget
  // above cannot know, for the same reason the prune step below exists. Once
  // it IS known, pass 2 lays the same parts over exactly that many, cutting the
  // connectivity order where it severs the fewest nets rather than wherever the
  // first board happened to run out. A companion is seated in its host's own
  // columns, so it costs nothing to place and nothing to split away from.
  let seating = seatPass();
  if (!seating.ok) return { ok: false, errors: [seating.error] };
  let gap = GAP;

  // Before accepting a second board, TRY HARDER TO AVOID ONE. The blank column
  // between parts is a courtesy; a whole breadboard fetched to hold a single
  // resistor is not a courtesy to anybody, and that is exactly what it bought —
  // eight LEDs reserving a blank column each left two free at the right-hand
  // edge and the last part needed three. A person short of room packs tighter
  // rather than clipping on another board, so the gap is the first thing to go,
  // and only when it actually saves a board.
  if (seating.used.size > 1) {
    const tight = seatPass(null, 0);
    if (tight.ok && tight.used.size < seating.used.size) {
      seating = tight;
      gap = 0;
    }
  }

  if (seating.used.size > 1) {
    // A companion rides its host's columns, so it must not be counted — and it
    // must not be assigned a board of its own either; `seatCompanion` runs
    // before the assignment is consulted, so it simply follows its host.
    const companions = new Set([...companionOf.keys(), ...plugOf.keys()]);
    const laid = seatPass(
      splitAcrossBoards(
        order,
        nets,
        (p) => (companions.has(p.id) ? 0 : spanOf(p.def) + gap),
        { boards: seating.used.size, capacity: perKit },
      ),
      gap,
    );
    // An assignment is a preference, so it cannot refuse a part — but it can
    // shuffle the packing, and a layout that needed MORE boards is not better.
    if (laid.ok && laid.used.size <= seating.used.size) seating = laid;
  }
  const { alloc, seatOf } = seating;
  components.push(...seating.parts);

  // ── Give back the boards nothing landed on.
  //
  // How many kits a design needs cannot be KNOWN before it is placed: the
  // budget above has to assume a pull pack costs nine columns, and companion
  // seating then usually costs it none, so a design that fits comfortably on
  // one board can be handed two. The spare came out empty except for the
  // bridge wires stitched across it — a whole breadboard on the desk whose
  // only purpose was to be wired to.
  //
  // Nothing here tries to predict better. It books what it might need, seats,
  // and then keeps only what it used — and because the power wiring and the
  // routing both happen AFTER this point, the bridges and rail taps are never
  // built for a board that is about to go. A design with no seated parts at
  // all (a lone clock brick, say) keeps the first kit: the PSU still needs a
  // rail to reach.
  const usedBoards = new Set([...seatOf.values()].map((s) => s.boardId));
  const survivors = kits.filter((kit) => usedBoards.has(kit.pins));
  if (survivors.length && survivors.length < kits.length) {
    const keep = new Set(survivors.flatMap((kit) => [kit.pins, ...kit.rails]));
    for (const board of boards) {
      if (keep.has(board.id)) continue;
      boardAt.delete(board.id);
      boardType.delete(board.id);
    }
    const kept = boards.filter((b) => keep.has(b.id));
    boards.length = 0;
    boards.push(...kept);
    kits.length = 0;
    kits.push(...survivors);
  }

  // Every rail strip left standing, ONCE. Read off the boards rather than off
  // `kits`, whose lists now overlap: a shared strip sits in the kit above it
  // and the kit below it, so walking the kits would offer its holes twice.
  const railStripIds = boards
    .filter((b) => b.type.startsWith("rail"))
    .map((b) => b.id);

  // ── How a wire is routed — shared by the power wiring and the net router.
  //
  // A net is a TREE, and its shape is the subtle part: EVERY wire end needs its
  // own hole, the hub's included. A hub serving three spokes needs three free
  // holes on its node, not one address used three times — that would be three
  // leads in one hole, and the loader drops the extras silently, leaving a
  // circuit that is a quiet open rather than a loud error.
  //
  // So a member is modelled as a PORT that hands out fresh addresses, and how
  // many it can hand out is what decides the shape: a rail (one node of ~50
  // holes) beats a seated pin (five holes, one spent on the pin itself) beats a
  // brick terminal (exactly one point, and no more).
  //
  // The tree grows from the widest port, and every further member hangs off
  // whichever ALREADY-JOINED port still has the most room. A rail never runs
  // out, so a power net stays the plain star it has always been; a signal net
  // wider than a column-half's four spare holes becomes a chain — hopping pin
  // to pin, exactly as a person building it would — instead of a refusal.
  //
  // A port is keyed by its NODE, not by the pin that reached it. Two pins on
  // one node are already joined by the board itself, so a wire between them is
  // a wire from a node to itself: it consumes two holes, draws a loop, and
  // connects nothing. That never came up while every part owned its own
  // columns — and it is exactly what happens once a companion part is seated
  // deliberately IN another's columns (below), so the router has to understand
  // it before that is safe.
  //
  // Which hole of a node a wire leaves from is not a detail. The five holes of
  // a column-half are five ROWS, the discretes all sit along row a, and taking
  // "the first free hole" took row a every time — so wires ran the length of
  // the board through the very row the resistor networks and LED bars occupy.
  // A port therefore OFFERS its free holes and the router picks the pair, by
  // length plus a penalty for every part the wire would fly over.
  const partBoxes = new Map(); // specId → body box (the residual-crossing audit)
  const routeBoxes = new Map(); // …and as the router keeps wires clear of it
  const defOf = new Map(seated.map((p) => [p.id, p.def]));
  for (const [specId, seat] of seatOf) {
    const points = [];
    for (const hole of seat.holes.values()) {
      const at = worldOf(`${seat.boardId}.${hole}`);
      if (at) points.push(at);
    }
    // …and a lead plugged into a rail, so a wire is kept off the whole body.
    for (const { address } of seat.rails?.values() ?? []) {
      const at = worldOf(address);
      if (at) points.push(at);
    }
    const box = boxOf(points);
    if (!box) continue;
    partBoxes.set(specId, box);
    // A part you OPERATE is kept clear by a wire's whole width as well as its
    // knob: a stroke grazing the knob still takes the click (seatRowOf).
    routeBoxes.set(
      specId,
      operated(defOf.get(specId))
        ? boxOf(points, OPERATED_MARGIN)
        : isBareLed(defOf.get(specId))
          ? boxOf(points, LAMP_DOME)
          : box,
    );
  }
  // A wire ENDS on the part whose node it leaves from. The ROUTER does not
  // excuse that part (only an end inside its body is attachment): a lead from
  // beside a part back across it is drawn over it all the same — it was every
  // switch's supply lead, over its own knob (seatRowOf), and a chip's leads
  // over the chip. The residual-crossing REPORT below still excuses it, as it
  // always has: that is a count of wires over somebody ELSE's part.
  const ownerOfNode = new Map(); // "board:node" → specId
  for (const [specId, seat] of seatOf) {
    for (const hole of seat.holes.values()) {
      const node = nodeOf(boardType.get(seat.boardId), hole);
      if (node) ownerOfNode.set(`${seat.boardId}:${node}`, specId);
    }
  }
  /** The `ownerOfNode` key for an address, or "" for a brick terminal. */
  const nodeKey = (address) => {
    const parsed = parseAddress(address);
    const type = parsed && boardType.get(parsed.boardId);
    if (!type) return "";
    const node = nodeOf(type, parsed.hole);
    return node ? `${parsed.boardId}:${node}` : "";
  };
  /** The parts a wire between two nodes ends on. */
  const ownersOf = (nodeA, nodeB) =>
    new Set([ownerOfNode.get(nodeA), ownerOfNode.get(nodeB)].filter(Boolean));

  /** The four-ish spare holes electrically common with a seated pin. */
  const pinPort = (boardId, hole) => ({
    node: `${boardId}:${nodeOf(boardType.get(boardId), hole)}`,
    capacity: 4,
    at: worldOf(`${boardId}.${hole}`),
    options: () => alloc.freeHolesAt(boardId, hole),
    take: (address) => alloc.claim(address),
  });

  const portFor = (member) => {
    const brick = brickAt.get(member.partId);
    if (brick) {
      let spent = false;
      const address = `${brick}.${member.terminal}`;
      return {
        node: address,
        capacity: 1,
        at: worldOf(address),
        options: () => (spent ? [] : [address]),
        take: () => {
          spent = true;
        },
      };
    }
    const seat = seatOf.get(member.partId);
    // A lead plugged into a rail (`seatPlug`) IS the rail: the board already
    // joins it, so the net reaches it for nothing.
    const plugged = seat?.rails?.get(member.pin);
    if (plugged) return railPort(plugged.rail);
    const hole = seat?.holes.get(member.pin);
    if (hole == null) return null;
    return pinPort(seat.boardId, hole);
  };
  // Once bridged, the supply is ONE node spread across every rail strip on the
  // desk, so EVERY free hole on every one of them is a candidate. Offering only
  // the first strip's wasted the rest — a half kit ran dry after 25 taps with
  // 25 identical holes sitting empty on the strip below — and offering them in
  // order took the leftmost, which for a chip on the far right meant a supply
  // lead the width of the board. Nearest wins, and "nearest" reaches the strip
  // on the pin's own side of the trench without being told to.
  const railPort = (rail) => ({
    node: `rail:${rail}`,
    capacity: Infinity,
    at: null, // a rail runs the width of the desk; nearness decides the hole
    options: () =>
      railStripIds.flatMap((id) =>
        alloc.freeRailHoles(id, rail === "VCC" ? "+" : "-"),
      ),
    take: (address) => alloc.claim(address),
  });

  // How many candidates to weigh per end. A rail offers ~50 holes per strip
  // and every one is the same node, so the shortlist is by nearness to the
  // other end — beyond a dozen the extras are all further away and all equal.
  const SHORTLIST = 12;
  const CROSSING_COST = 20; // pitch units — worth a long detour, not any detour

  const shortlist = (port, toward) => {
    const options = port.options();
    if (!toward || options.length <= SHORTLIST) return options.slice(0, 64);
    return options
      .map((a) => [distance(worldOf(a), toward), a])
      .sort((p, q) => p[0] - q[0])
      .slice(0, SHORTLIST)
      .map((p) => p[1]);
  };

  /** The best (from, to) pair between two ports, or null when either is dry. */
  const bestPair = (hostPort, port) => {
    const froms = shortlist(hostPort, port.at);
    const tos = shortlist(port, hostPort.at);
    if (!froms.length || !tos.length) return null;
    let best = null;
    for (const from of froms) {
      const a = worldOf(from);
      for (const to of tos) {
        const b = worldOf(to);
        // As DRAWN, and against the parts it ends on too (`drawnCrossings`):
        // a sagging run, or a lead back across its own switch, covers that
        // switch's knob just as surely as a wire to somewhere else does.
        const cost =
          distance(a, b) + CROSSING_COST * drawnCrossings(a, b, routeBoxes);
        if (!best || cost < best.cost) best = { from, to, cost };
      }
    }
    return best;
  };

  // ── Power every behavioural part from the rails.
  //
  // Through the SAME chooser the net router uses, which matters more here than
  // anywhere: a kit has a rail strip above the board and one below, bridged, so
  // either will do electrically — and taking the first free hole on the first
  // strip sent a chip's ground lead up over the chip to the far rail, every
  // chip, every time. Nearest-that-flies-over-nothing picks the rail on the
  // pin's own side of the trench for free.
  const railLink = (specId, pin, polarity, colour, what) => {
    const seat = seatOf.get(specId);
    const hole = seat?.holes.get(pin);
    if (hole == null) {
      unpowered.push(what);
      return;
    }
    const from = pinPort(seat.boardId, hole);
    const to = railPort(polarity === "+" ? "VCC" : "GND");
    const pair = bestPair(from, to);
    if (!pair) {
      unpowered.push(what);
      return;
    }
    from.take(pair.from);
    to.take(pair.to);
    wire(pair.from, pair.to, colour);
  };

  // EVERY supply pin, not the first of each: a CD405x's VEE is a ground pin
  // beside its VSS (single-supply use ties it there), and the AM27C1024 has two
  // VSS pins — a part with one left off does not power up.
  for (const p of seated) {
    const supply = (role) => (p.def.pins ?? []).filter((q) => q.role === role);
    for (const q of supply("vcc")) {
      railLink(p.id, q.n, "+", "red", `${p.id} (${p.ref}) ${q.name}`);
    }
    for (const q of supply("gnd")) {
      railLink(p.id, q.n, "-", "black", `${p.id} (${p.ref}) ${q.name}`);
    }
  }

  // ── The supply's own plumbing: the PSU's two leads, and the bridges that
  //    make both polarities reachable from either strip of a kit.
  //
  // Deferred to here so the bridges can see the parts. A bridge crosses the
  // whole pin-board from the strip above to the strip below; run down column 1
  // it goes straight over the first chip, every single time. Choosing the pair
  // of rail holes the same way every other wire is chosen puts it in a gap.
  const strip = (k, n) => kits[k].rails[n];
  const bridge = (fromBoard, toBoard, polarity, colour, what) => {
    // Offered END-FIRST (`railSpineOrder`): right, then left, then in from the
    // right — rule 2. Both ends are `at: null`, so this ordering is the only
    // thing separating one vertical run from another; see the helper for why.
    const line = (boardId) => {
      const s = spec(boardType.get(boardId));
      return () =>
        railSpineOrder(
          alloc.freeRailHoles(boardId, polarity),
          s.railHoles,
          s.railGroup,
        );
    };
    const a = {
      node: `bridge:${fromBoard}${polarity}`,
      capacity: Infinity,
      at: null,
      options: line(fromBoard),
      take: (address) => alloc.claim(address),
    };
    const b = { ...a, node: `bridge:${toBoard}${polarity}` };
    b.options = line(toBoard);
    const pair = bestPair(a, b);
    if (!pair) return unpowered.push(what);
    a.take(pair.from);
    b.take(pair.to);
    return wire(pair.from, pair.to, colour) || unpowered.push(what);
  };

  // The PSU brick stands off the RIGHT of the boards, and a rail is one node
  // end to end, so its leads take the near end rather than hole 1.
  powerWire(
    "psu1.+",
    alloc.freeRail(strip(0, 0), "+", { fromEnd: true }),
    "red",
    "the PSU's + terminal",
  );
  powerWire(
    "psu1.-",
    alloc.freeRail(strip(0, 1), "-", { fromEnd: true }),
    "black",
    "the PSU's − terminal",
  );
  // The two strips of a kit share no node, so bridge them across the board.
  // Nothing runs BETWEEN kits: a stacked pair shares the rail between them, so
  // these bridges already chain — R0–R1 for the first board, R1–R2 for the
  // second — and every rail on the desk is one node without a wire the height
  // of a breadboard being dragged over everything on it.
  for (let k = 0; k < kits.length; k++) {
    bridge(strip(k, 0), strip(k, 1), "+", "red", `kit ${k + 1}'s +`);
    bridge(strip(k, 1), strip(k, 0), "-", "black", `kit ${k + 1}'s −`);
  }

  if (unpowered.length) {
    return {
      ok: false,
      errors: [
        err(
          "SUPPLY_EXHAUSTED",
          `Every rail hole on the desk is spoken for — ${unpowered.join(", ")} ` +
            `could not reach the supply.`,
          { kind: ABORT },
        ),
      ],
    };
  }

  for (const net of nets) {
    const ports = [];
    const onNode = new Set();
    for (const m of net.pins) {
      const port = portFor(m);
      if (!port) {
        return {
          ok: false,
          errors: [
            err(
              "UNREACHABLE_MEMBER",
              `Net "${net.name}" cannot reach ${m.partId} ${m.pin ?? m.terminal}.`,
              { kind: ABORT },
            ),
          ],
        };
      }
      // Already on a node this net has reached: the board is the wire.
      if (onNode.has(port.node)) continue;
      onNode.add(port.node);
      ports.push(port);
    }
    if (net.rail && !onNode.has(`rail:${net.rail}`)) {
      ports.push(railPort(net.rail));
    }
    if (ports.length < 2) continue;

    const colour = net.rail
      ? net.rail === "VCC"
        ? "red"
        : "black"
      : colourFor(net.name);

    // Widest first, so the best hosts are joined early and are available to
    // take the members behind them; index breaks a tie, so a rebuild of the
    // same spec lays out identically.
    const order = ports
      .map((_, i) => i)
      .sort((a, b) => ports[b].capacity - ports[a].capacity || a - b);
    const room = ports.map((p) => p.capacity);
    const joined = [order[0]];
    for (let k = 1; k < order.length; k++) {
      const i = order[k];
      let host = joined[0];
      for (const j of joined) if (room[j] > room[host]) host = j;
      if (room[host] < 1) {
        return {
          ok: false,
          errors: [
            err(
              "FANOUT_TOO_WIDE",
              `Net "${net.name}" joins ${ports.length} points that hold one ` +
                `lead each — there is nowhere left to hop through.`,
              { kind: ABORT },
            ),
          ],
        };
      }
      const pair = bestPair(ports[host], ports[i]);
      if (!pair) {
        return {
          ok: false,
          errors: [
            err("NO_FREE_HOLE", `Net "${net.name}" ran out of free holes.`, {
              kind: ABORT,
            }),
          ],
        };
      }
      ports[host].take(pair.from);
      ports[i].take(pair.to);
      wire(pair.from, pair.to, colour);
      room[host] -= 1;
      room[i] -= 1;
      joined.push(i);
    }
  }

  // ── What still flies over something, reported rather than hidden.
  //
  // Not every crossing can be routed away. A net joining a pin BELOW the trench
  // to one ABOVE it has to get across, and if both ends sit inside part
  // footprints there is no column left to cross in — a real bench routes the
  // lead around the end of the chip, which a straight run between two holes
  // cannot express. So this is a count, not a gate: the layout is honest about
  // what it could not avoid instead of quietly looking tidy.
  const crossed = wires.filter((w) => {
    const a = worldOf(w.from);
    const b = worldOf(w.to);
    if (!a || !b) return false;
    const excused = ownersOf(nodeKey(w.from), nodeKey(w.to));
    return drawnCrossings(a, b, partBoxes, excused) > 0;
  }).length;
  if (crossed) {
    warnings.push({
      code: "WIRES_CROSS_PARTS",
      message:
        `${crossed} of ${wires.length} wires still run over a part — nets ` +
        `that have to cross the trench where both ends sit under a chip.`,
    });
  }

  // ── The design's own note, written on the desk above it.
  //
  // A generated circuit arrives with no history: the user did not build it and
  // cannot ask it why it is wired the way it is. The model already knows —
  // it just had nowhere to say so. So the spec carries a paragraph and it is
  // stamped where a demo bench puts its caption, in the same pitch and the same
  // muted body, because a generated circuit and a shipped demo should read the
  // same way.
  //
  // ANCHORED to a seated part, and that is not decoration: `captureDesign`
  // carries only anchored labels, on the rule that a free-floating one belongs
  // to the desk it was written on rather than to the design. A note explaining
  // THIS circuit is the design's, so it has to ride a part of it — the leftmost
  // one, which puts the caption over the design's own left edge and keeps it
  // there if the part is later moved.
  const annotations = [];
  const leftmost = [...seatOf.values()].sort(
    (a, b) =>
      (worldOf(`${a.boardId}.${a.anchor}`)?.x ?? 0) -
      (worldOf(`${b.boardId}.${b.anchor}`)?.x ?? 0),
  )[0];
  const written = [...(title ? [String(title)] : []), ...wrapText(notes)];
  const caption = written.slice(0, CAPTION_MAX);
  // A trim SAYS SO. Stopping mid-clause reads as a note that was written badly
  // rather than one that was cut, and the reader has no way to tell which.
  if (written.length > caption.length) {
    caption[caption.length - 1] += CAPTION_CUT;
  }
  if (leftmost && caption.length) {
    const left = Math.min(...boards.map((b) => b.x));
    caption.forEach((line, i) => {
      annotations.push({
        id: `an${i + 1}`,
        kind: "label",
        x: left,
        y: CAPTION_BOTTOM - (caption.length - i) * CAPTION_LINE,
        text: line,
        anchor: leftmost.compId,
        // The title keeps the desk's text colour; the body is muted, so the
        // block reads as a caption rather than as part of the circuit.
        ...(i === 0 && title ? {} : { color: CAPTION_MUTED }),
      });
    });
  }

  return {
    ok: true,
    document: {
      // The renderer's current schema version, never a literal: this document
      // is handed to normalizeDocument and can reach a file through the clip
      // it becomes, and a stale number there is a migration re-running on a
      // document that was born current.
      version: DOC_VERSION,
      title: title ?? null,
      boards,
      components,
      wires,
      buses: [],
      netNames: [],
      annotations,
    },
    warnings,
    interposed: interposed.map((i) => i.resistor.id),
    // The resolved nets AFTER interposition — what the compiler actually set
    // out to build. autobuild-verify.js compares these against the partition
    // buildNetlist derives, which is the only way to catch a severed net or an
    // accidental short: both produce documents that simulate perfectly.
    nets: nets.map((n) => ({
      name: n.name,
      rail: n.rail,
      pins: n.pins.map((p) => ({ ...p })),
    })),
    // Spec id → the id it was given in the document. Every caller needs this:
    // the spec speaks in "U1", the document (and the engine) in "c1", and the
    // functional-test runner has to translate between them.
    partMap: new Map([
      ...[...seatOf].map(([specId, s]) => [specId, s.compId]),
      ...brickAt,
    ]),
  };
}

/**
 * A compiled document as a DESIGN CLIP — the shape the desk already knows how
 * to place atomically.
 *
 * This is deliberately `captureDesign` rather than a second converter: a clip
 * built any other way would be a parallel implementation of the same mapping,
 * free to drift from the one `pasteDesign` consumes. Selecting every board and
 * every brick captures the whole build, and the parts and wires follow from
 * their owners exactly as they do for a copy.
 *
 * @param {object} document  a `compileNetlist` document
 * @returns {object|null} the clip, or null when there is nothing to place
 */
export function designClipOf(document) {
  if (!document?.boards?.length) return null;
  return captureDesign(document, {
    boardIds: document.boards.map((b) => b.id),
    componentIds: (document.components ?? [])
      .filter((c) => c.board == null)
      .map((c) => c.id),
  });
}

/** Stable per-net colour, so a bus reads as one colour across a rebuild. */
const SIGNAL_COLOURS = ["blue", "green", "yellow", "orange", "white", "purple"];
function colourFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return SIGNAL_COLOURS[h % SIGNAL_COLOURS.length];
}
