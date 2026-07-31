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

// pin-resolve.js — turning "U1.A1" into a pin number, fail-closed.
//
// A generated netlist names pins the way a datasheet does; the model needs pin
// NUMBERS. That translation is the single most dangerous step in the pipeline,
// because a wrong-but-plausible answer produces a circuit that simulates
// happily and computes the wrong thing. Quietly resolving `S0` to `S1` because
// it looks close would invert an LSB and nothing downstream would notice. So
// every rung here either resolves exactly or reports why it could not.
//
// What the catalog actually looks like (audited, not assumed):
//
//   * Pin names are CASE-DISTINGUISHED and case-sensitively unique. 74LS47 has
//     uppercase inputs A,B,C,D and lowercase segment outputs a,b,c,d,e,f,g;
//     seg8ca has lowercase segments a..g,dp and an uppercase A common anode.
//     Matching case-insensitively would MANUFACTURE an ambiguity that the
//     catalog does not have, so exact case is tried first and usually wins.
//   * The only genuinely duplicated names are `NC` (74LS20/30/90, rom-8k,
//     ram-8k) and `VSS` (AM27C1024). Every duplicate shares one role, so the
//     duplicates are electrically interchangeable — not ambiguous, just plural.
//   * Power pins are declared by ROLE, not by name, which is what lets 74LS83
//     (VCC=5, GND=12) resolve with no special-casing beside 74LS283 (16/8).
//
// Desk bricks (psu, clock) carry `terminals` rather than `pins`, so a member
// like `clk1.out` resolves to a terminal id instead of a pin number.

import { partDef, pinGroupsOf } from "../catalog/index.js";

/** Net members that name a supply rail rather than a part pin. */
export const RAIL_TOKENS = Object.freeze({
  VCC: "VCC",
  "+": "VCC",
  GND: "GND",
  "-": "GND",
  VSS: "GND",
  VDD: "VCC",
});

const ROLE_TOKENS = Object.freeze({
  VCC: "vcc",
  VDD: "vcc",
  GND: "gnd",
  VSS: "gnd",
});

/** `R0(1)` → `R01`, `A=B` → `AB` — punctuation a datasheet uses, we don't. */
const normalise = (s) =>
  String(s)
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();

const fail = (code, message, extra = {}) => ({
  ok: false,
  code,
  message,
  ...extra,
});

/**
 * Split a net member into its addressable parts.
 *
 * `"VCC"` / `"GND"` → `{ kind: "rail", rail }`
 * `"U1.A1"`         → `{ kind: "part", partId, pinToken }`
 *
 * @param {string} token
 * @returns {object|null} null when the token is not a member at all
 */
export function parseMember(token) {
  if (typeof token !== "string") return null;
  const t = token.trim();
  if (!t) return null;

  const rail = RAIL_TOKENS[t.toUpperCase()];
  if (rail && !t.includes(".")) return { kind: "rail", rail };

  const dot = t.indexOf(".");
  if (dot <= 0 || dot === t.length - 1) return null;
  return {
    kind: "part",
    partId: t.slice(0, dot),
    pinToken: t.slice(dot + 1),
  };
}

/**
 * Resolve a pin token against a catalog ref.
 *
 * @param {string} ref       catalog id, e.g. "74LS283"
 * @param {string} pinToken  "7" | "A1" | "VCC" | "Q[3]" | "out"
 * @returns {{ok:true, kind:"pin", pin:number}
 *          |{ok:true, kind:"terminal", terminal:string}
 *          |{ok:false, code:string, message:string, candidates?:Array}}
 */
export function resolvePin(ref, pinToken) {
  const def = partDef(ref);
  if (!def) return fail("UNKNOWN_REF", `No catalog part with id "${ref}".`);
  if (typeof pinToken !== "string" || !pinToken.trim()) {
    return fail("BAD_PIN_TOKEN", `Empty pin on "${ref}".`);
  }
  const token = pinToken.trim();

  // A desk brick has terminals, not pins — a different namespace entirely.
  if (def.terminals?.length) return resolveTerminal(def, ref, token);

  const pins = def.pins ?? [];
  if (!pins.length) return fail("NO_PINS", `"${ref}" has no pins to address.`);

  // ⓪ `#4` is an explicit PIN NUMBER — the escape hatch for the one place a
  //    bare integer is ambiguous (see below).
  const explicit = /^#(\d+)$/.exec(token);
  if (explicit) {
    const n = Number(explicit[1]);
    if (pins.some((p) => p.n === n)) return { ok: true, kind: "pin", pin: n };
    return fail(
      "PIN_OUT_OF_RANGE",
      `"${ref}" has no pin ${n} (it has ${pins.length}).`,
    );
  }

  // ① A bare integer usually IS the pin number — but a handful of parts name
  //    their pins numerically too. For bar8/rnet9/resistor/switches the two
  //    readings agree, so nothing is at stake. For 74LS148 — a priority
  //    encoder whose inputs are NAMED 0..7 — they disagree: `74LS148.4` could
  //    mean pin 4 (which is named "7") or the input named "4" (which is pin
  //    1). Guessing there would silently mis-wire an encoder, so both readings
  //    are reported and the caller picks with `#4` or an unambiguous name.
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    const byNumber = pins.find((p) => p.n === n);
    const byName = pins.filter((p) => p.name === token);
    if (byNumber && byName.length && !byName.some((p) => p.n === n)) {
      return fail(
        "AMBIGUOUS_PIN",
        `"${ref}" reads "${token}" two ways: pin ${n} (named "${byNumber.name}") ` +
          `or the pin named "${token}" (pin ${byName[0].n}). ` +
          `Use "#${n}" for the pin number, or an unambiguous name.`,
        { candidates: [n, byName[0].n] },
      );
    }
    if (byNumber) return { ok: true, kind: "pin", pin: n };
    if (byName.length) return oneOf(byName, ref, token);
    return fail(
      "PIN_OUT_OF_RANGE",
      `"${ref}" has no pin ${n} (it has ${pins.length}).`,
    );
  }

  // ② Exact, case-sensitive. This is the rung that resolves essentially every
  //    real member, and doing it BEFORE any case folding is what keeps
  //    74LS47's `A` (input) distinct from its `a` (segment output).
  const exact = pins.filter((p) => p.name === token);
  if (exact.length) return oneOf(exact, ref, token);

  // ③ Role. Power pins are declared by role, so this is how a chip with
  //    non-standard power pins resolves without knowing which chip it is.
  const role = ROLE_TOKENS[token.toUpperCase()];
  if (role) {
    const byRole = pins.filter((p) => p.role === role);
    if (byRole.length) return oneOf(byRole, ref, token);
  }

  // ④ Case-insensitive. Only reached when exact case missed, so a hit here
  //    means the model got the case wrong. Fine when it is unambiguous;
  //    reported when it is not, because guessing between an input and an
  //    output is exactly the silent-wrong-circuit case.
  const loose = pins.filter(
    (p) => p.name.toLowerCase() === token.toLowerCase(),
  );
  if (loose.length) return oneOf(loose, ref, token);

  // ⑤ Punctuation-insensitive: `R0(1)` written as `R01`, `A=B` as `AB`.
  const wanted = normalise(token);
  const normalised = pins.filter((p) => normalise(p.name) === wanted);
  if (normalised.length) return oneOf(normalised, ref, token);

  // ⑥ Bus index — `Q[3]`, `A[12]` — against the def's own pinGroups, which is
  //    catalog data rather than a naming heuristic.
  const bus = /^([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(\d+)\s*\]$/.exec(token);
  if (bus) {
    const groups = pinGroupsOf(ref) ?? [];
    const group = groups.find(
      (g) => g.name.toLowerCase() === bus[1].toLowerCase(),
    );
    if (!group) {
      return fail("UNKNOWN_BUS", `"${ref}" has no bus "${bus[1]}".`, {
        candidates: groups.map((g) => g.name),
      });
    }
    const idx = Number(bus[2]);
    if (idx < 0 || idx >= group.pins.length) {
      return fail(
        "BUS_INDEX_OUT_OF_RANGE",
        `"${ref}" bus ${group.name} has ${group.pins.length} lines; ${idx} is out of range.`,
      );
    }
    return { ok: true, kind: "pin", pin: group.pins[idx] };
  }

  // ⑦ Give up — but say what was available, so a repair turn has something
  //    to work with rather than a bare rejection.
  return fail("UNKNOWN_PIN", `"${ref}" has no pin named "${token}".`, {
    candidates: pins.map((p) => p.name),
  });
}

/**
 * Collapse a set of matched pins to one answer.
 *
 * Several pins CAN share a name — `NC` and `VSS` do — but only when they share
 * a role, which makes them interchangeable rather than ambiguous: two grounds
 * are the same net, and nobody wires to a particular NC. Differing roles is the
 * real ambiguity, and it is reported rather than guessed.
 */
function oneOf(matches, ref, token) {
  if (matches.length === 1) return { ok: true, kind: "pin", pin: matches[0].n };
  const roles = new Set(matches.map((p) => p.role));
  if (roles.size === 1) {
    // Deterministic: lowest pin number, so a rebuild never shifts.
    return {
      ok: true,
      kind: "pin",
      pin: Math.min(...matches.map((p) => p.n)),
    };
  }
  return fail(
    "AMBIGUOUS_PIN",
    `"${ref}" has ${matches.length} pins named "${token}" with different roles ` +
      `(${matches.map((p) => `${p.n}:${p.role}`).join(", ")}). Use the pin number.`,
    { candidates: matches.map((p) => p.n) },
  );
}

/**
 * Brick terminals (`psu1.+`, `clk1.out`) — a small, exact namespace.
 *
 * The numeric branch is the generic escape hatch for a part declaring BOTH
 * pins and terminals: a brick is addressed by TERMINAL, but a datasheet pin
 * NUMBER should still get you there. No shipped def is that shape today (the
 * HD44780 LCD was, until it became two board-seated modules whose pins are
 * holes), so the branch is unexercised by the catalog — kept because the cost
 * is three lines and the alternative is a confusing failure for the next brick
 * that grows a datasheet pin table.
 */
function resolveTerminal(def, ref, token) {
  const exact = def.terminals.find((t) => t.id === token);
  if (exact) return { ok: true, kind: "terminal", terminal: exact.id };
  const loose = def.terminals.find(
    (t) => t.id.toLowerCase() === token.toLowerCase(),
  );
  if (loose) return { ok: true, kind: "terminal", terminal: loose.id };

  const numeric = /^#?(\d+)$/.exec(token);
  if (numeric && def.pins?.length) {
    const named = def.pins.find((p) => p.n === Number(numeric[1]));
    const viaPin = named && def.terminals.find((t) => t.id === named.name);
    if (viaPin) return { ok: true, kind: "terminal", terminal: viaPin.id };
  }

  return fail("UNKNOWN_TERMINAL", `"${ref}" has no terminal "${token}".`, {
    candidates: def.terminals.map((t) => t.id),
  });
}
