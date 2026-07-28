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
//     is planted automatically; a kit's two rail strips are bridged, because
//     they share no node and the bottom one is otherwise dead.
//   * LEDs NEED A RESISTOR. Per sim/junction.js an LED conducting between two
//     strongly driven nets burns rather than lights. That is physics, not
//     logic, so the netlist should not have to mention it: when a display's
//     common leg heads for a rail, a series resistor is interposed.
//   * ONE COLUMN-HALF, ONE PART. Enforced by column-allocator.js.
//
// The output is a plain document so it can go straight through
// normalizeDocument → buildNetlist → settle. Wrapping it as a design clip for
// the paste path is the caller's job.

import { partDef } from "../catalog/index.js";
import { BREADBOARD_KITS } from "./board-types.js";
import { createAllocator } from "./column-allocator.js";
import { captureDesign } from "./design-clip.js";
import { DIP_PACKAGES } from "./footprints.js";
import { RAIL_TOKENS, parseMember, resolvePin } from "./pin-resolve.js";

const GAP = 1; // blank columns between parts, so nothing reads as one block
const KIT_PITCH = 22; // vertical spacing when a design needs a second kit

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
  return assemble(resolved, spec?.title);
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

function assemble(resolved, title) {
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

  // ── Boards. One pin-board's worth of columns per kit; spill to more kits.
  const budget = seated.reduce((n, p) => n + spanOf(p.def) + GAP, 0);
  const kitKey = budget <= 30 ? "half" : "full";
  const perKit = kitKey === "half" ? 30 : 63;
  const kitCount = Math.max(1, Math.ceil(budget / perKit));

  const boards = [];
  const kits = [];
  let boardSeq = 0;
  for (let k = 0; k < kitCount; k++) {
    const kit = { rails: [], pins: null };
    for (const strip of BREADBOARD_KITS[kitKey].strips) {
      const id = `bb${++boardSeq}`;
      boards.push({
        id,
        type: strip.type,
        x: strip.dx,
        y: k * KIT_PITCH + strip.dy,
        rot: 0,
        group: null,
      });
      if (strip.type.startsWith("rail")) kit.rails.push(id);
      else kit.pins = id;
    }
    kits.push(kit);
  }

  const alloc = createAllocator(boards);
  const components = [];
  const wires = [];
  let wireSeq = 0;
  let compSeq = 0;
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

  // A NAMED line, which is what the bridges need — their whole job is to join
  // one particular strip to another, so they cannot take just any free hole.
  const railOf = (k, strip, polarity) =>
    alloc.freeRail(kits[k].rails[strip], polarity);

  // Top strip carries +, bottom carries − — a convention, then bridged so both
  // polarities are reachable from either strip.
  powerWire("psu1.+", railOf(0, 0, "+"), "red", "the PSU's + terminal");
  powerWire("psu1.-", railOf(0, 1, "-"), "black", "the PSU's − terminal");
  for (let k = 0; k < kits.length; k++) {
    // Within a kit the two strips share no node, so bridge them…
    powerWire(railOf(k, 0, "+"), railOf(k, 1, "+"), "red", `kit ${k + 1}'s +`);
    powerWire(
      railOf(k, 1, "-"),
      railOf(k, 0, "-"),
      "black",
      `kit ${k + 1}'s −`,
    );
    // …and across kits, so a second board is powered too.
    if (k > 0) {
      powerWire(railOf(0, 0, "+"), railOf(k, 0, "+"), "red", `kit ${k + 1}`);
      powerWire(railOf(0, 1, "-"), railOf(k, 1, "-"), "black", `kit ${k + 1}`);
    }
  }

  // …and now that they are bridged, the supply is ONE node spread across every
  // rail strip on the desk. Taking every hole from the first of them wasted the
  // rest: a half kit ran dry after 25 taps with 25 identical holes sitting
  // empty on the strip below, which is what turned a wide power net into a
  // refusal (or, worse, a silent drop). Walk them all — the nearest free hole
  // on any bridged line is electrically the same point, and it is the one a
  // person reaches for.
  const supply = (polarity) => {
    for (const kit of kits) {
      for (const id of kit.rails) {
        const address = alloc.freeRail(id, polarity);
        if (address) return address;
      }
    }
    return null;
  };
  const plus = () => supply("+");
  const minus = () => supply("-");

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

  // ── Seat every board part, left to right, on the first kit that fits.
  const seatOf = new Map(); // specId → {compId, boardId, holes}
  for (const p of seated) {
    const span = spanOf(p.def);
    if (!span) {
      return {
        ok: false,
        errors: [
          err(
            "UNPLACEABLE",
            `"${p.ref}" has no footprint the compiler can seat.`,
            { kind: ABORT },
          ),
        ],
      };
    }
    const row = p.def.package ? "e" : "a";
    let placed = null;
    for (const kit of kits) {
      // Reserve a blank column after the part as well, so neighbours do not
      // read as one block — the same courtesy a person building this leaves.
      const start = alloc.reserveColumns(kit.pins, span + GAP);
      if (start == null) continue;
      const anchor = `${row}${start}`;
      const r = alloc.seat(kit.pins, p.ref, anchor, {});
      if (!r.ok) continue;
      placed = { boardId: kit.pins, anchor, holes: r.holes };
      break;
    }
    if (!placed) {
      return {
        ok: false,
        errors: [
          err(
            "NO_ROOM",
            `Ran out of board for "${p.id}" (${p.ref}); the design needs more columns.`,
            { kind: ABORT },
          ),
        ],
      };
    }
    const compId = `c${++compSeq}`;
    components.push({
      id: compId,
      kind: p.def.kind,
      ref: p.ref,
      board: placed.boardId,
      anchor: placed.anchor,
      params: {},
    });
    seatOf.set(p.id, { compId, ...placed });
  }

  // ── Power every behavioural part from the rails.
  for (const p of seated) {
    const seat = seatOf.get(p.id);
    const vcc = p.def.pins?.find((q) => q.role === "vcc");
    const gnd = p.def.pins?.find((q) => q.role === "gnd");
    if (vcc)
      powerWire(
        alloc.freeAt(seat.boardId, seat.holes.get(vcc.n)),
        plus(),
        "red",
        `${p.id} (${p.ref}) VCC`,
      );
    if (gnd)
      powerWire(
        alloc.freeAt(seat.boardId, seat.holes.get(gnd.n)),
        minus(),
        "black",
        `${p.id} (${p.ref}) GND`,
      );
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

  // ── Route.
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
  const portFor = (member) => {
    const brick = brickAt.get(member.partId);
    if (brick) {
      let spent = false;
      const address = `${brick}.${member.terminal}`;
      return {
        capacity: 1,
        next: () => (spent ? null : ((spent = true), address)),
      };
    }
    const seat = seatOf.get(member.partId);
    const hole = seat?.holes.get(member.pin);
    if (hole == null) return null;
    return { capacity: 4, next: () => alloc.freeAt(seat.boardId, hole) };
  };
  const railPort = (rail) => ({
    capacity: Infinity,
    next: () => (rail === "VCC" ? plus() : minus()),
  });

  for (const net of nets) {
    const ports = [];
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
      const from = ports[host].next();
      const to = ports[i].next();
      if (!from || !to) {
        return {
          ok: false,
          errors: [
            err("NO_FREE_HOLE", `Net "${net.name}" ran out of free holes.`, {
              kind: ABORT,
            }),
          ],
        };
      }
      wire(from, to, colour);
      room[host] -= 1;
      room[i] -= 1;
      joined.push(i);
    }
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
      annotations: [],
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
