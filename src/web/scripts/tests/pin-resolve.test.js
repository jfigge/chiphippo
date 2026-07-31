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

// The corpus here is the real catalog, audited rather than assumed. The cases
// that matter are the ones where a plausible shortcut would produce a WRONG
// pin rather than an error — those are the silent-wrong-circuit failures.

import test from "node:test";
import assert from "node:assert/strict";

import { PALETTE_DEFS, partDef } from "../catalog/index.js";
import { parseMember, resolvePin } from "../model/pin-resolve.js";

const pin = (ref, token) => {
  const r = resolvePin(ref, token);
  assert.equal(r.ok, true, `${ref}.${token}: ${r.message ?? ""}`);
  return r.pin;
};
const err = (ref, token) => {
  const r = resolvePin(ref, token);
  assert.equal(r.ok, false, `${ref}.${token} should not resolve`);
  return r;
};

// ── parseMember ─────────────────────────────────────────────────────────────

test("parseMember splits part members and recognises rail tokens", () => {
  assert.deepEqual(parseMember("U1.A1"), {
    kind: "part",
    partId: "U1",
    pinToken: "A1",
  });
  assert.deepEqual(parseMember("VCC"), { kind: "rail", rail: "VCC" });
  assert.deepEqual(parseMember("gnd"), { kind: "rail", rail: "GND" });
  assert.deepEqual(parseMember(" GND "), { kind: "rail", rail: "GND" });
  // A pin that happens to be called VCC is still a part member.
  assert.deepEqual(parseMember("U1.VCC"), {
    kind: "part",
    partId: "U1",
    pinToken: "VCC",
  });
});

test("parseMember rejects what is not a member", () => {
  for (const bad of ["", "   ", ".", "U1.", ".A1", null, 42, undefined]) {
    assert.equal(
      parseMember(bad),
      null,
      `${JSON.stringify(bad)} is not a member`,
    );
  }
});

// ── The rungs ───────────────────────────────────────────────────────────────

test("integers resolve, and out-of-range integers are caught", () => {
  assert.equal(pin("74LS283", "7"), 7);
  const e = err("74LS283", "17");
  assert.equal(e.code, "PIN_OUT_OF_RANGE");
});

test("exact names resolve for the fixtures we build against", () => {
  assert.equal(pin("74LS283", "A1"), 5);
  assert.equal(pin("74LS283", "C0"), 7);
  assert.equal(pin("74LS283", "C4"), 9);
  assert.equal(pin("74LS283", "S1"), 4);
  assert.equal(pin("74LS161", "CLK"), 2);
  assert.equal(pin("74LS161", "QA"), 14);
  assert.equal(pin("bar8", "K"), 9);
  assert.equal(pin("sw-dip8", "1A"), 1);
});

test("power resolves by ROLE, so non-standard pinouts need no special case", () => {
  // The pair this exists for: electrically identical parts, different corners.
  assert.equal(pin("74LS283", "VCC"), 16);
  assert.equal(pin("74LS283", "GND"), 8);
  assert.equal(pin("74LS83", "VCC"), 5);
  assert.equal(pin("74LS83", "GND"), 12);
  // Aliases a datasheet might use.
  assert.equal(pin("74LS283", "VDD"), 16);
  assert.equal(pin("74LS283", "VSS"), 8);
});

test("case-distinguished names are NOT folded together", () => {
  // 74LS47's uppercase A is an input; its lowercase a is a segment output.
  // Folding case would make this ambiguous — or worse, silently pick one.
  assert.equal(pin("74LS47", "A"), 7, "uppercase A is the input");
  assert.equal(pin("74LS47", "a"), 13, "lowercase a is the segment output");
  assert.notEqual(pin("74LS47", "A"), pin("74LS47", "a"));

  // seg8ca: lowercase segments, uppercase common anode.
  assert.equal(pin("seg8ca", "a"), 1, "segment a");
  assert.equal(pin("seg8ca", "A"), 9, "the common anode");
});

test("duplicate names sharing one role are interchangeable, not ambiguous", () => {
  // AM27C1024 has two VSS pins — both ground, so both are the same net.
  const d = partDef("AM27C1024");
  const grounds = d.pins.filter((p) => p.role === "gnd").map((p) => p.n);
  assert.deepEqual(grounds, [11, 30], "the catalog really does declare two");
  assert.equal(pin("AM27C1024", "VSS"), 11, "lowest wins, deterministically");

  // NC pins likewise: plural, identical, and nobody wires to a specific one.
  assert.equal(pin("74LS20", "NC"), 3);
});

test("bus indexes resolve through the def's own pinGroups", () => {
  assert.equal(pin("rom-8k", "A[0]"), 1);
  assert.equal(pin("rom-8k", "Q[0]"), 9);
  const e = err("rom-8k", "Q[99]");
  assert.equal(e.code, "BUS_INDEX_OUT_OF_RANGE");
  assert.equal(err("rom-8k", "Z[0]").code, "UNKNOWN_BUS");
});

test("brick terminals live in their own namespace", () => {
  assert.deepEqual(resolvePin("clock", "out"), {
    ok: true,
    kind: "terminal",
    terminal: "out",
  });
  assert.deepEqual(resolvePin("psu", "+"), {
    ok: true,
    kind: "terminal",
    terminal: "+",
  });
  assert.equal(err("psu", "A1").code, "UNKNOWN_TERMINAL");
});

// ── Fail-closed ─────────────────────────────────────────────────────────────

test("an unknown ref or pin fails with something a repair turn can use", () => {
  assert.equal(err("74LS999", "1").code, "UNKNOWN_REF");
  const e = err("74LS283", "SUM0");
  assert.equal(e.code, "UNKNOWN_PIN");
  assert.ok(e.candidates.includes("S1"), "offers the real names back");
});

test("numerically NAMED pins are reported, not guessed", () => {
  // 74LS148 is a priority encoder whose inputs are named 0..7, and those names
  // do not line up with the pin numbers: the pin named "4" is pin 1, while pin
  // 4 is named "7". Either reading is defensible, so neither is assumed.
  const e = err("74LS148", "4");
  assert.equal(e.code, "AMBIGUOUS_PIN");
  assert.deepEqual(e.candidates, [4, 1], "both readings offered");

  // The escape hatch, and the unambiguous alternative.
  assert.equal(pin("74LS148", "#4"), 4, "#N is always the pin number");
  assert.equal(pin("74LS148", "EI"), 5, "a name with no numeric reading");

  // A numeric name with no competing pin number resolves cleanly: there is no
  // pin 0, so "0" can only mean the input named 0.
  assert.equal(pin("74LS148", "0"), 10);

  // Where name and number agree there is nothing to disambiguate.
  assert.equal(pin("bar8", "4"), 4);
  assert.equal(pin("rnet9", "8"), 8);
  assert.equal(pin("resistor", "2"), 2);
});

test("a near-miss is never silently repaired", () => {
  // The whole reason this module is fail-closed: S0 does not exist (the
  // datasheet numbers sums from 1), and quietly returning S1 would invert an
  // LSB in a circuit that then simulates perfectly.
  assert.equal(err("74LS283", "S0").code, "UNKNOWN_PIN");
  assert.equal(err("74LS161", "Q0").code, "UNKNOWN_PIN");
  assert.equal(err("74LS283", "CIN").code, "UNKNOWN_PIN");
});

// ── The whole catalog stays addressable ─────────────────────────────────────

test("the LCD is addressed by pin name, number, or power role", () => {
  // A board-seated module: its pins are holes, so every rung of the ordinary
  // pin resolver applies — which is one more than the brick's terminal path
  // offered, since VCC/GND now resolve by ROLE.
  for (const ref of ["lcd16x2", "lcd20x4"]) {
    assert.deepEqual(resolvePin(ref, "RS"), { ok: true, kind: "pin", pin: 4 });
    assert.equal(resolvePin(ref, "4").pin, 4, "pin 4 is RS");
    assert.equal(resolvePin(ref, "#4").pin, 4);
    assert.equal(resolvePin(ref, "DB7").pin, 14);
    assert.equal(
      resolvePin(ref, "A").pin,
      15,
      "exact case beats the role rung",
    );
    assert.equal(resolvePin(ref, "K").pin, 16);
    // The two the terminal path could never reach: VDD/VSS are named for the
    // datasheet, but they ARE the power pins.
    assert.equal(resolvePin(ref, "VCC").pin, 2);
    assert.equal(resolvePin(ref, "GND").pin, 1);
    assert.equal(err(ref, "NOPE").code, "UNKNOWN_PIN");
  }
});

test("every pin of every catalog part resolves by its own name and number", () => {
  for (const def of PALETTE_DEFS) {
    // A def with terminals is addressed through them (the PSU / clock bricks).
    if (def.terminals?.length) continue;
    for (const p of def.pins ?? []) {
      // A bare number is the pin number wherever nothing competes for it.
      const byNumber = resolvePin(def.id, String(p.n));
      if (byNumber.ok) {
        assert.equal(byNumber.pin, p.n, `${def.id} bare ${p.n}`);
      } else {
        assert.equal(
          byNumber.code,
          "AMBIGUOUS_PIN",
          `${def.id} bare ${p.n} — ${byNumber.message}`,
        );
      }

      // Every pin is reachable by an EXPLICIT number, always and everywhere.
      const explicit = resolvePin(def.id, `#${p.n}`);
      assert.equal(explicit.ok, true, `${def.id} pin ${p.n} by #number`);
      assert.equal(explicit.pin, p.n);

      const byName = resolvePin(def.id, p.name);
      const sameName = (def.pins ?? []).filter((q) => q.name === p.name);
      if (byName.ok) {
        // Duplicated names (NC, VSS) legitimately collapse to the lowest pin,
        // so assert the result is A pin carrying that name, not that exact one.
        assert.ok(
          sameName.some((q) => q.n === byName.pin),
          `${def.id} "${p.name}" resolved to pin ${byName.pin}`,
        );
      } else {
        // The only sanctioned refusal: a numeric name that collides with a
        // different pin number (74LS148 today). Anything else is a bug.
        assert.equal(
          byName.code,
          "AMBIGUOUS_PIN",
          `${def.id} "${p.name}" — ${byName.message}`,
        );
        assert.match(
          String(p.name),
          /^\d+$/,
          `${def.id} "${p.name}" is numeric`,
        );
      }
    }
    for (const t of def.terminals ?? []) {
      const r = resolvePin(def.id, t.id);
      assert.equal(r.ok, true, `${def.id} terminal ${t.id}`);
      assert.equal(r.terminal, t.id);
    }
  }
});
