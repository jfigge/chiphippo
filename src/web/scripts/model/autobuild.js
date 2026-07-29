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
//     logic, so the netlist should not have to mention it: when a display's
//     common leg heads for a rail, a series resistor is interposed.
//   * SWITCHES NEED A PULL. A switch is a contact, not a source: open, it
//     joins nothing, so an input fed from one FLOATS half the time. Same
//     class of fact as the LED's resistor, and handled the same way.
//   * ONE COLUMN-HALF, ONE PART. Enforced by column-allocator.js.
//
// The output is a plain document so it can go straight through
// normalizeDocument → buildNetlist → settle. Wrapping it as a design clip for
// the paste path is the caller's job.

import { partDef } from "../catalog/index.js";
import { BREADBOARD_KITS } from "./board-types.js";
import { boardSize, holePosition, nodeOf, parseAddress } from "./breadboard.js";
import { createAllocator } from "./column-allocator.js";
import { captureDesign } from "./design-clip.js";
import { DIP_PACKAGES } from "./footprints.js";
import { partPinHoles } from "./occupancy.js";
import { RAIL_TOKENS, parseMember, resolvePin } from "./pin-resolve.js";
import { boxOf, crossingCount } from "./wire-crossing.js";

const GAP = 1; // blank columns between parts, so nothing reads as one block

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
  return assemble(resolved, spec?.title, spec?.notes);
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
          errors.push(
            err(
              "POWER_PIN_LISTED",
              `"${m}" is ${part.ref}'s ${role.toUpperCase()} pin. The compiler ` +
                `wires power itself — drop it from net "${name}".`,
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
    // Two outputs on one net is a driver conflict the engine would only report
    // at run time; naming it here points at the spec line instead.
    const drivers = pins.filter((p) => {
      const def = parts.get(p.partId).def;
      return def.pins?.find((q) => q.n === p.pin)?.role === "output";
    });
    if (drivers.length > 1) {
      errors.push(
        err(
          "MULTIPLE_DRIVERS",
          `Net "${name}" ties ${drivers.length} outputs together ` +
            `(${drivers.map((d) => `${d.partId}.${d.pin}`).join(", ")}).`,
          { path },
        ),
      );
    }
    nets.push({ name, pins, rail: [...rails][0] ?? null });
  });

  return errors.length ? { ok: false, errors } : { ok: true, parts, nets };
}

// ── Assemble: layout, power, the resistor rule, routing ─────────────────────

/** Columns a board-seated part occupies. */
function spanOf(def) {
  if (def.package) return DIP_PACKAGES[def.package].pins / 2;
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
  const type = boardType.get(host.boardId);

  // The pack's own pin 1 fixes the anchor: same column as the host pin it is
  // equal to, and the row furthest from the trench so the two never collide.
  const first = links.find((l) => l.pin === 1);
  const seed = first && host.holes.get(first.hostPin);
  const m = seed && GRID_HOLE_RE.exec(seed);
  if (!m) return null;
  const anchor = `${isLowerRow(m[1]) ? "a" : "j"}${m[2]}`;

  const pins = partPinHoles(part.ref, anchor, {});
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

  const r = alloc.seat(host.boardId, part.ref, anchor, {}, hostId);
  if (!r.ok) return null;
  return { boardId: host.boardId, anchor, holes: r.holes };
}

/** The pin every segment of a display shares — its common anode or cathode. */
function commonLeg(def) {
  if (def.segments?.length) {
    const first = def.segments[0];
    if (def.segments.every((s) => s.cathodePin === first.cathodePin)) {
      return { pin: first.cathodePin, rail: "GND" };
    }
    if (def.segments.every((s) => s.anodePin === first.anodePin)) {
      return { pin: first.anodePin, rail: "VCC" };
    }
  }
  if (typeof def.polarity === "function") {
    const { cathodePin } = def.polarity({});
    return { pin: cathodePin, rail: "GND" };
  }
  return null;
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
  }

  // ── The resistor rule. A display whose common leg heads for a rail gets a
  //    series resistor interposed, because otherwise it burns rather than
  //    lights (sim/junction.js). One resistor per display covers every segment.
  const interposed = [];
  for (const p of seated) {
    const leg = commonLeg(p.def);
    if (!leg) continue;
    const net = nets.find(
      (n) =>
        n.rail === leg.rail &&
        n.pins.some((q) => q.partId === p.id && q.pin === leg.pin),
    );
    if (!net) continue;
    const rid = `${p.id}_R`;
    if (parts.has(rid)) continue;
    const rdef = partDef("resistor");
    const resistor = { id: rid, ref: "resistor", def: rdef, label: null };
    parts.set(rid, resistor);
    seated.push(resistor);
    interposed.push({ resistor, display: p, leg, net });
    // The display's common leg no longer reaches the rail DIRECTLY; it reaches
    // the resistor, and the resistor reaches the rail. The display stays in
    // this net — only the rail is detached from it.
    net.rail = null;
    net.pins.push({ partId: rid, kind: "pin", pin: 1 });
    nets.push({
      name: `${net.name}_LIMITED`,
      pins: [{ partId: rid, kind: "pin", pin: 2 }],
      rail: leg.rail,
    });
    warnings.push({
      code: "RESISTOR_INSERTED",
      message:
        `Added a series resistor between ${p.id} and ${leg.rail} — an LED ` +
        `across two strongly driven nets burns instead of lighting.`,
    });
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
    if (net.pins.some((q) => roleOf(q) === "output")) continue;
    if (net.pins.some((q) => parts.get(q.partId).def.weakBridges)) continue;
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
  for (const rail of ["GND", "VCC"]) {
    const group = pulls.filter((p) => p.rail === rail).map((p) => p.net);
    for (let i = 0; i < group.length; i += 8) {
      const chunk = group.slice(i, i + 8);
      const lone = chunk.length === 1;
      const ref = lone ? "resistor" : "rnet9";
      let rid = `PULL${++pullSeq}`;
      while (parts.has(rid)) rid = `PULL${++pullSeq}`;
      const part = { id: rid, ref, def: partDef(ref), label: null };
      parts.set(rid, part);
      seated.push(part);
      chunk.forEach((net, k) => {
        net.pins.push({ partId: rid, kind: "pin", pin: lone ? 1 : k + 1 });
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
                  pin: lone ? 1 : k + 1,
                  hostId: host.partId,
                  hostPin: host.pin,
                }
              : null;
          })
          .filter(Boolean),
      );
      nets.push({
        name: `${rid}_${rail}`,
        pins: [{ partId: rid, kind: "pin", pin: lone ? 2 : 9 }],
        rail,
      });
      warnings.push({
        code: "PULL_INSERTED",
        message:
          `Added a ${rail === "GND" ? "pull-down" : "pull-up"} on ` +
          `${chunk.map((n) => `"${n.name}"`).join(", ")} — a switch joins its ` +
          `pins, it does not drive them, so an open one leaves the input ` +
          `floating.`,
      });
    }
  }

  // ── Boards. One pin-board's worth of columns per kit; spill to more kits.
  // Deliberately PESSIMISTIC: it counts a pull pack's nine columns even though
  // companion seating will usually fold it into the switch bank's own, because
  // whether that succeeds is a geometric question this cannot answer yet.
  // Guessing high costs a board that `#pruneKits` then takes back; guessing low
  // costs a NO_ROOM refusal, and only one of those is recoverable.
  const budget = seated.reduce((n, p) => n + spanOf(p.def) + GAP, 0);
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
  const brickAt = new Map();
  let brickRow = 12;
  for (const b of bricks) {
    const kindSeq =
      { clock: "clk", lcd: "lcd", psu: "psu" }[b.def.kind] ?? "brk";
    const id = `${kindSeq}${brickAt.size + 1}`;
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
  const order = orderByConnectivity(seated, nets);
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
      const row = p.def.package ? "e" : "a";
      // A pull pack goes UNDER the switch bank it pulls, in the very columns
      // that bank owns — because its pins are already that bank's nets, so the
      // board does the connecting. Eight wires and nine columns become none.
      // It costs no columns of its own: it is IN its host's.
      let placed = seatCompanion(p, companionOf.get(p.id), {
        alloc,
        seatOf,
        boardType,
      });
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
        params: {},
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
    const companions = new Set(companionOf.keys());
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
  const partBoxes = new Map(); // specId → body box
  for (const [specId, seat] of seatOf) {
    const points = [];
    for (const hole of seat.holes.values()) {
      const at = worldOf(`${seat.boardId}.${hole}`);
      if (at) points.push(at);
    }
    const box = boxOf(points);
    if (box) partBoxes.set(specId, box);
  }
  // A wire ENDS on the part whose node it leaves from; that is attachment, not
  // crossing, so those two parts are excluded from its own hit test.
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
    const skip = new Set(
      [ownerOfNode.get(hostPort.node), ownerOfNode.get(port.node)].filter(
        Boolean,
      ),
    );
    let best = null;
    for (const from of froms) {
      const a = worldOf(from);
      for (const to of tos) {
        const b = worldOf(to);
        const cost =
          distance(a, b) + CROSSING_COST * crossingCount(a, b, partBoxes, skip);
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

  for (const p of seated) {
    const vcc = p.def.pins?.find((q) => q.role === "vcc");
    const gnd = p.def.pins?.find((q) => q.role === "gnd");
    if (vcc) railLink(p.id, vcc.n, "+", "red", `${p.id} (${p.ref}) VCC`);
    if (gnd) railLink(p.id, gnd.n, "-", "black", `${p.id} (${p.ref}) GND`);
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
    const a = {
      node: `bridge:${fromBoard}${polarity}`,
      capacity: Infinity,
      at: null,
      options: () => alloc.freeRailHoles(fromBoard, polarity),
      take: (address) => alloc.claim(address),
    };
    const b = { ...a, node: `bridge:${toBoard}${polarity}` };
    b.options = () => alloc.freeRailHoles(toBoard, polarity);
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
    if (net.rail) ports.push(railPort(net.rail));
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
    const skip = new Set(
      [ownerOfNode.get(nodeKey(w.from)), ownerOfNode.get(nodeKey(w.to))].filter(
        Boolean,
      ),
    );
    return crossingCount(a, b, partBoxes, skip) > 0;
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
      version: 6,
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
