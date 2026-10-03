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

// The CD4000 MSI parts (batch 2): every rule each one's TI datasheet states,
// one assertion (or one sweep) each, read off the sheet rather than off the
// catalog — the JK flip-flop, the shift-and-store register, the two decoders
// and the six counters.
//
// Their demo benches prove the same parts through the whole engine
// (gate-demos.test.js); this suite pins the corners a bench never reaches —
// a 4027 with SET and RESET both HIGH, a 4094 switched off, a 4510 preset to
// a code that is not a digit, a floating control on every one of them.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, Z, X } from "../sim/levels.js";
import {
  evaluate,
  inputLevels,
  initialState,
  outputsOf,
  stepChip,
} from "../sim/chip-eval.js";
import { chipDef } from "../catalog/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const levels = (obj) =>
  new Map(Object.entries(obj).map(([pin, lv]) => [Number(pin), lv]));

/**
 * A stateful chip on a bench of its own: every input starts at the level
 * `rest` gives it, and `set` changes some and steps the chip once, edges
 * detected against the sample before — the engine's contract for one tick.
 * `pulse` is one full clock: up (a rising edge), then down.
 */
function bench(ref, rest) {
  const def = chipDef(ref);
  const raw = levels(rest);
  let state = initialState(def);
  let ins = inputLevels(def, raw);
  const api = {
    set(changes) {
      for (const [pin, lv] of Object.entries(changes)) raw.set(Number(pin), lv);
      const prev = ins;
      ins = inputLevels(def, raw);
      state = stepChip(def, state, ins, prev);
      return api;
    },
    pulse(pin, times = 1) {
      for (let i = 0; i < times; i++) api.set({ [pin]: H }).set({ [pin]: L });
      return api;
    },
    out(pin) {
      return outputsOf(def, state, ins).get(pin);
    },
    outs(pins) {
      const o = outputsOf(def, state, ins);
      return pins.map((p) => o.get(p));
    },
  };
  return api;
}

/** A count → its bits, LSB first, as levels. */
const bitsOf = (value, count) =>
  Array.from({ length: count }, (_, i) => ((value >> i) & 1 ? H : L));

/** The levels on `pins` → their number, LSB first (null if any is not H/L). */
const valueOn = (b, pins) => {
  const lv = b.outs(pins);
  if (lv.some((v) => v !== H && v !== L)) return null;
  return lv.reduce((n, v, i) => n + (v === H ? 1 << i : 0), 0);
};

// ── CD4027B — dual JK flip-flop ─────────────────────────────────────────────

// FF1: J 10, K 11, CLOCK 13, SET 9, RESET 12, Q 15, Q̄ 14.
// FF2: J 6, K 5, CLOCK 3, SET 7, RESET 4, Q 1, Q̄ 2.
const JK_REST = {
  10: L,
  11: L,
  13: L,
  9: L,
  12: L, // prettier-ignore
  6: L,
  5: L,
  3: L,
  7: L,
  4: L, // prettier-ignore
};

test("CD4027B: J, K and the clock follow the sheet's functional-modes table", () => {
  const b = bench("CD4027B", JK_REST);
  assert.deepEqual(b.outs([15, 14]), [L, H], "powers up cleared");
  // J=1: set on the rising edge (the falling edge changes nothing).
  b.set({ 10: H }).set({ 13: H });
  assert.deepEqual(b.outs([15, 14]), [H, L], "J sets on the rise");
  // K=0 with Q=1: holds.
  b.set({ 10: L }).pulse(13);
  assert.equal(b.out(15), H, "J=0 K=0 holds");
  // K=1: reset on the next rise.
  b.set({ 11: H }).set({ 13: H });
  assert.deepEqual(b.outs([15, 14]), [L, H], "K resets");
  b.set({ 13: L });
  // J=K=1: toggles every rising edge.
  b.set({ 10: H });
  b.set({ 13: H });
  assert.equal(b.out(15), H, "toggle 1");
  b.set({ 13: L });
  assert.equal(b.out(15), H, "the falling edge does nothing");
  b.set({ 13: H });
  assert.equal(b.out(15), L, "toggle 2");
  // FF2 never moved: the halves are independent.
  assert.deepEqual(b.outs([1, 2]), [L, H]);
});

test("CD4027B: SET and RESET are active HIGH and asynchronous", () => {
  const b = bench("CD4027B", JK_REST);
  b.set({ 7: H });
  assert.deepEqual(b.outs([1, 2]), [H, L], "SET, no clock");
  b.set({ 7: L }).set({ 4: H });
  assert.deepEqual(b.outs([1, 2]), [L, H], "RESET, no clock");
  // RESET held overrides the clocked path: J=1 on a rising edge does nothing.
  b.set({ 6: H }).set({ 3: H });
  assert.deepEqual(b.outs([1, 2]), [L, H], "RESET beats the clock");
});

test("CD4027B: SET and RESET both HIGH drive Q AND Q̄ HIGH", () => {
  // The wrong-wiring case the sheet's last row states: S=1, R=1 → Q=1, Q̄=1.
  const b = bench("CD4027B", JK_REST);
  b.set({ 9: H, 12: H });
  assert.deepEqual(b.outs([15, 14]), [H, H], "both outputs HIGH");
  // Clocking changes nothing while both are held.
  b.set({ 10: H, 11: H }).pulse(13);
  assert.deepEqual(b.outs([15, 14]), [H, H], "and the clock cannot move it");
  // Releasing RESET leaves SET in charge.
  b.set({ 12: L });
  assert.deepEqual(b.outs([15, 14]), [H, L]);
});

test("CD4027B: a floating J or K is unknown only where it could change Q", () => {
  // Q=0, K=0, J floating: hold (0) or set (1) — unknown.
  const b = bench("CD4027B", { ...JK_REST, 10: Z });
  b.set({ 13: H });
  assert.deepEqual(b.outs([15, 14]), [X, X], "J floating from Q=0");
  // A clean RESET recovers it; then J=1 sets cleanly.
  b.set({ 13: L, 12: H }).set({ 12: L });
  assert.equal(b.out(15), L);
  // From Q=1 with K=0, set and hold agree: Q stays a known HIGH.
  b.set({ 9: H }).set({ 9: L });
  b.set({ 13: H });
  assert.equal(b.out(15), H, "J floating from Q=1 with K=0 cannot matter");
  // A floating SET makes the state unknown at once.
  const c = bench("CD4027B", { ...JK_REST, 7: Z });
  c.set({ 6: L });
  assert.deepEqual(c.outs([1, 2]), [X, X], "a floating SET");
});

// ── CD4094B — 8-stage shift-and-store bus register ──────────────────────────

// STROBE 1, DATA 2, CLOCK 3, OE 15; Q1–Q8 4 5 6 7 14 13 12 11; QS 9, Q'S 10.
const Q94 = [4, 5, 6, 7, 14, 13, 12, 11];
const SR_REST = { 1: L, 2: L, 3: L, 15: H };

test("CD4094B: data shifts on the RISING clock edge, stage 1 first", () => {
  const b = bench("CD4094B", { ...SR_REST, 1: H }); // strobe HIGH: transparent
  b.set({ 2: H }).set({ 3: H });
  assert.deepEqual(b.outs(Q94), [H, L, L, L, L, L, L, L], "one rise, one bit");
  b.set({ 2: L }).set({ 3: L });
  assert.deepEqual(
    b.outs(Q94),
    [H, L, L, L, L, L, L, L],
    "the fall shifts nothing",
  );
  b.pulse(3, 2);
  assert.deepEqual(b.outs(Q94), [L, L, H, L, L, L, L, L], "it walks along");
});

test("CD4094B: STROBE HIGH lets the latches follow; STROBE LOW holds them", () => {
  const b = bench("CD4094B", { ...SR_REST, 2: H });
  b.pulse(3, 3); // three ones shifted in behind a closed latch
  assert.deepEqual(b.outs(Q94), Array(8).fill(L), "nothing shows yet");
  b.set({ 1: H });
  assert.deepEqual(b.outs(Q94), [H, H, H, L, L, L, L, L], "strobed through");
  b.set({ 1: L }).set({ 2: L }).pulse(3, 2);
  assert.deepEqual(b.outs(Q94), [H, H, H, L, L, L, L, L], "and held");
});

test("CD4094B: OUTPUT ENABLE LOW floats Q1–Q8 — and only them", () => {
  // The sheet's "OC" (open circuit) rows: with OE LOW the parallel outputs
  // are high impedance, while the shift goes on and QS/Q'S keep driving.
  const b = bench("CD4094B", { ...SR_REST, 1: H, 2: H });
  b.pulse(3, 8);
  assert.deepEqual(b.outs(Q94), Array(8).fill(H));
  b.set({ 15: L });
  assert.deepEqual(b.outs(Q94), Array(8).fill(Z), "every parallel output Z");
  assert.equal(b.out(9), H, "QS still drives");
  assert.equal(b.out(10), H, "Q'S still drives");
  b.set({ 2: L }).pulse(3);
  b.set({ 15: H });
  assert.deepEqual(
    b.outs(Q94),
    [L, H, H, H, H, H, H, H],
    "it shifted meanwhile",
  );
  // A floating OE might be either: the outputs are unknown, not floating.
  b.set({ 15: Z });
  assert.deepEqual(b.outs(Q94), Array(8).fill(X));
});

test("CD4094B: QS changes on the rising edge, Q'S on the next falling edge", () => {
  const b = bench("CD4094B", { ...SR_REST, 2: H });
  b.pulse(3, 7);
  assert.deepEqual(b.outs([9, 10]), [L, L], "stage 8 still empty");
  b.set({ 3: H });
  assert.deepEqual(b.outs([9, 10]), [H, L], "the 8th rise reaches QS");
  b.set({ 3: L });
  assert.deepEqual(b.outs([9, 10]), [H, H], "and Q'S half a clock later");
});

test("CD4094B: a floating DATA shifts in as unknown", () => {
  const b = bench("CD4094B", { ...SR_REST, 1: H, 2: Z });
  b.set({ 3: H });
  assert.deepEqual(b.outs(Q94), [X, L, L, L, L, L, L, L]);
  b.set({ 2: L, 3: L }).pulse(3);
  assert.deepEqual(b.outs(Q94), [L, X, L, L, L, L, L, L], "and walks along");
});

// ── CD4028B — BCD-to-decimal decoder ────────────────────────────────────────

// A 10, B 13, C 12, D 11 → outputs 0–9 on 3 14 2 15 1 6 7 4 9 5.
const OUT28 = [3, 14, 2, 15, 1, 6, 7, 4, 9, 5];
const IN28 = [10, 13, 12, 11];

test("CD4028B: Table I — one output HIGH for codes 0–9, none for 10–15", () => {
  const def = chipDef("CD4028B");
  for (let code = 0; code < 16; code++) {
    const bits = bitsOf(code, 4);
    const out = evaluate(def, new Map(IN28.map((p, i) => [p, bits[i]])));
    const want = OUT28.map((_, k) => (k === code ? H : L));
    assert.deepEqual(
      OUT28.map((p) => out.get(p)),
      want,
      `code ${code}`,
    );
  }
});

test("CD4028B: a floating input spoils only the outputs it could select", () => {
  // A=0 B=1 C=0, D floating: the code is 2 or 10 — output 2 is unknown, and
  // every other output is LOW either way.
  const out = evaluate(chipDef("CD4028B"), levels({ 10: L, 13: H, 12: L }));
  assert.equal(out.get(2), X, "output 2");
  for (const [k, p] of OUT28.entries()) {
    if (k !== 2) assert.equal(out.get(p), L, `output ${k}`);
  }
});

// ── CD4511B — BCD-to-7-segment latch/decoder/driver ─────────────────────────

// A 7, B 1, C 2, D 6; LT 3, BL 4, LE 5; a–g on 13 12 11 10 9 15 14.
const SEG11 = [13, 12, 11, 10, 9, 15, 14];
const BCD11 = [7, 1, 2, 6];
/** The truth table's segment columns, a…g, digit by digit. */
const FONT11 = [
  "1111110",
  "0110000",
  "1101101",
  "1111001",
  "0110011", // prettier-ignore
  "1011011",
  "0011111",
  "1110000",
  "1111111",
  "1110011", // prettier-ignore
];
const lit = (mask) => [...mask].map((c) => (c === "1" ? H : L));
const showing = (b) => b.outs(SEG11);
const DISPLAY_REST = { 3: H, 4: H, 5: L, 7: L, 1: L, 2: L, 6: L };
const setCode = (b, code) =>
  b.set(Object.fromEntries(BCD11.map((p, i) => [p, bitsOf(code, 4)[i]])));

test("CD4511B: decodes 0–9 to the sheet's segments (a 6 without a, a 9 without d)", () => {
  const b = bench("CD4511B", DISPLAY_REST);
  for (let code = 0; code < 10; code++) {
    setCode(b, code);
    assert.deepEqual(showing(b), lit(FONT11[code]), `digit ${code}`);
  }
});

test("CD4511B: a code above 9 blanks the display", () => {
  const b = bench("CD4511B", DISPLAY_REST);
  for (let code = 10; code < 16; code++) {
    setCode(b, code);
    assert.deepEqual(showing(b), Array(7).fill(L), `code ${code}`);
  }
});

test("CD4511B: lamp test lights everything; blanking darkens everything", () => {
  const b = bench("CD4511B", DISPLAY_REST);
  setCode(b, 2);
  b.set({ 4: L });
  assert.deepEqual(showing(b), Array(7).fill(L), "BL LOW blanks");
  b.set({ 3: L });
  assert.deepEqual(showing(b), Array(7).fill(H), "LT LOW beats BL");
  b.set({ 3: H, 4: H });
  assert.deepEqual(showing(b), lit(FONT11[2]), "back to the digit");
});

test("CD4511B: LE HIGH holds the code it had; LE LOW follows the inputs", () => {
  const b = bench("CD4511B", DISPLAY_REST);
  setCode(b, 7);
  b.set({ 5: H });
  setCode(b, 3);
  assert.deepEqual(showing(b), lit(FONT11[7]), "held at 7");
  // The latch is before the decoder: blanking and lamp test still act on it.
  b.set({ 4: L });
  assert.deepEqual(showing(b), Array(7).fill(L), "a held digit blanks");
  b.set({ 4: H });
  assert.deepEqual(showing(b), lit(FONT11[7]), "and comes back as 7");
  b.set({ 5: L });
  assert.deepEqual(showing(b), lit(FONT11[3]), "transparent again: 3");
});

test("CD4511B: a floating input leaves only the doubtful segments unknown", () => {
  // Code 8 or 9 (A floating, D=1): this 9 has no bottom bar, so they differ
  // in segments d and e — and only there.
  const b = bench("CD4511B", { ...DISPLAY_REST, 6: H, 7: Z });
  assert.deepEqual(showing(b), [H, H, H, X, X, H, H]);
  // A floating LT might be lighting everything: only lit segments are known.
  const c = bench("CD4511B", { ...DISPLAY_REST, 3: Z });
  setCode(c, 1);
  assert.deepEqual(showing(c), [X, H, H, X, X, X, X]);
});

// ── CD4029B — presettable up/down counter, binary or decade ─────────────────

// PE 1, JAM 1–4 on 4 12 13 3, CI 5, B/D 9, U/D 10, CLOCK 15; Q1–Q4 6 11 14 2;
// CARRY OUT 7.
const Q29 = [6, 11, 14, 2];
const JAM29 = [4, 12, 13, 3];
const COUNT_REST = { 1: L, 4: L, 12: L, 13: L, 3: L, 5: L, 9: H, 10: H, 15: L };
const count29 = (b) => valueOn(b, Q29);

test("CD4029B: binary, counting up on the RISING edge and wrapping at 16", () => {
  const b = bench("CD4029B", COUNT_REST);
  b.set({ 15: H });
  assert.equal(count29(b), 1, "the rise counts");
  b.set({ 15: L });
  assert.equal(count29(b), 1, "the fall does not");
  b.pulse(15, 14);
  assert.equal(count29(b), 15);
  assert.equal(b.out(7), L, "CARRY OUT LOW at 15, counting up");
  b.pulse(15);
  assert.equal(count29(b), 0, "wraps");
  assert.equal(b.out(7), H);
});

test("CD4029B: binary down — CARRY OUT LOW at 0, then 15", () => {
  const b = bench("CD4029B", { ...COUNT_REST, 10: L });
  assert.equal(b.out(7), L, "0 is the terminal count going down");
  b.pulse(15);
  assert.equal(count29(b), 15);
  assert.equal(b.out(7), H);
  b.pulse(15, 3);
  assert.equal(count29(b), 12);
});

test("CD4029B: decade mode counts 0–9 both ways (Fig. 12)", () => {
  const b = bench("CD4029B", { ...COUNT_REST, 9: L });
  const seen = [];
  for (let i = 0; i < 10; i++) {
    seen.push(count29(b));
    b.pulse(15);
  }
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(count29(b), 0, "9 → 0 going up");
  b.set({ 10: L }).pulse(15);
  assert.equal(count29(b), 9, "0 → 9 going down");
  // CARRY OUT follows UP/DOWN with no clock: 9 is terminal only going up.
  assert.equal(b.out(7), H, "9, counting down");
  b.set({ 10: H });
  assert.equal(b.out(7), L, "9, counting up");
});

test("CD4029B: CARRY IN HIGH inhibits counting and holds CARRY OUT HIGH", () => {
  const b = bench("CD4029B", { ...COUNT_REST, 5: H });
  b.pulse(15, 3);
  assert.equal(count29(b), 0, "no count");
  b.set({ 10: L });
  assert.equal(b.out(7), H, "terminal (0 down), but CARRY IN is HIGH");
  b.set({ 5: L });
  assert.equal(b.out(7), L, "…and LOW once it is LOW");
});

test("CD4029B: PRESET ENABLE jams the inputs in with no clock, and holds", () => {
  const b = bench("CD4029B", COUNT_REST);
  b.pulse(15, 3);
  // JAM = 1010 (10): a binary count may be jammed to anything.
  b.set({ 12: H, 3: H }).set({ 1: H });
  assert.equal(count29(b), 10, "asynchronous load");
  b.pulse(15, 2);
  assert.equal(count29(b), 10, "no count while PRESET ENABLE is HIGH");
  b.set({ 1: L }).pulse(15);
  assert.equal(count29(b), 11, "counts on from the preset");
  // "A low on each JAM line, when the PRESET-ENABLE signal is high, resets
  // the counter to its zero count."
  b.set({ 12: L, 3: L }).set({ 1: H });
  assert.equal(count29(b), 0);
});

test("CD4029B: a floating CARRY IN or PRESET ENABLE leaves the count unknown", () => {
  const b = bench("CD4029B", { ...COUNT_REST, 5: Z });
  b.pulse(15);
  assert.equal(count29(b), null, "maybe counted");
  assert.equal(b.out(7), X);
  // A clean preset recovers it.
  b.set({ 5: L, 1: H }).set({ 1: L });
  assert.equal(count29(b), 0);
  const c = bench("CD4029B", { ...COUNT_REST, 1: Z, 4: H });
  c.set({ 15: L });
  assert.equal(count29(c), null, "maybe preset to 1, maybe still 0");
});

// ── CD4510B / CD4516B — presettable up/down counters ────────────────────────

// Same pins as the 4029, with RESET on 9 and P1–P4 on 4 12 13 3.
const UD_REST = { 1: L, 4: L, 12: L, 13: L, 3: L, 5: L, 9: L, 10: H, 15: L };
const presetTo = (b, n) =>
  b
    .set(Object.fromEntries(JAM29.map((p, i) => [p, bitsOf(n, 4)[i]])))
    .set({ 1: H })
    .set({ 1: L });

test("CD4510B: the truth table — count up, count down, no count, preset, reset", () => {
  const b = bench("CD4510B", UD_REST);
  b.pulse(15, 3);
  assert.equal(count29(b), 3, "count up");
  b.set({ 10: L }).pulse(15);
  assert.equal(count29(b), 2, "count down");
  b.set({ 5: H }).pulse(15, 2);
  assert.equal(count29(b), 2, "CARRY IN HIGH: no count");
  b.set({ 5: L, 12: H, 13: H }).set({ 1: H });
  assert.equal(count29(b), 6, "PRESET ENABLE loads P1–P4");
  b.set({ 9: H });
  assert.equal(count29(b), 0, "RESET wins even with PRESET ENABLE HIGH");
});

test("CD4510B: Fig. 15 — up to 9 and over, down to 0, CARRY OUT at each end", () => {
  const b = bench("CD4510B", UD_REST);
  const seen = [];
  const co = [];
  for (let i = 0; i < 10; i++) {
    b.pulse(15);
    seen.push(count29(b));
    co.push(b.out(7));
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]);
  assert.deepEqual(co.indexOf(L), 8, "CARRY OUT LOW at 9 only");
  b.set({ 10: L });
  assert.equal(b.out(7), L, "0 counting down is terminal");
  b.pulse(15);
  assert.equal(count29(b), 9, "0 → 9");
});

test("CD4510B: leaves a non-BCD state within two clocks up and four down", () => {
  // The sheet's own guarantee, for every one of the six codes a preset can
  // load: what follows is the logic diagram's, and it must keep that promise.
  for (const [up, most] of [
    [H, 2],
    [L, 4],
  ]) {
    for (let start = 10; start < 16; start++) {
      const b = bench("CD4510B", { ...UD_REST, 10: up });
      presetTo(b, start);
      assert.equal(count29(b), start);
      let clocks = 0;
      while (count29(b) > 9) {
        b.pulse(15);
        clocks++;
        assert.ok(
          clocks <= most,
          `${start} counting ${up === H ? "up" : "down"}`,
        );
      }
    }
  }
  // The up paths the diagram's gates give: 10→11→6, 12→13→4, 14→15→2.
  const b = bench("CD4510B", UD_REST);
  presetTo(b, 10);
  b.pulse(15);
  assert.equal(count29(b), 11);
  b.pulse(15);
  assert.equal(count29(b), 6);
});

test("CD4510B: a floating RESET leaves the count unknown until a clean reset", () => {
  const b = bench("CD4510B", { ...UD_REST, 9: Z });
  b.pulse(15);
  assert.equal(count29(b), null);
  b.set({ 9: H }).set({ 9: L });
  assert.equal(count29(b), 0);
  b.pulse(15);
  assert.equal(count29(b), 1, "counting again");
});

test("CD4516B: binary, wrapping at 16, CARRY OUT LOW at 15 up and 0 down", () => {
  const b = bench("CD4516B", UD_REST);
  b.pulse(15, 15);
  assert.equal(count29(b), 15);
  assert.equal(b.out(7), L);
  b.pulse(15);
  assert.equal(count29(b), 0, "15 → 0");
  b.set({ 10: L });
  assert.equal(b.out(7), L, "0 counting down");
  b.pulse(15);
  assert.equal(count29(b), 15, "0 → 15");
  presetTo(b, 12);
  assert.equal(count29(b), 12, "presets any binary number");
  b.set({ 9: H });
  assert.equal(count29(b), 0, "RESET");
});

// ── CD4020B / CD4024B — ripple counters ─────────────────────────────────────

// CD4020B: φ 10, RESET 11; Q1 9, Q4–Q14 on 7 5 4 6 13 12 14 15 1 2 3.
const Q20 = [9, null, null, 7, 5, 4, 6, 13, 12, 14, 15, 1, 2, 3];

test("CD4020B: 14 stages on φ's FALLING edge — Q2 and Q3 have no pin", () => {
  const b = bench("CD4020B", { 10: L, 11: L });
  b.set({ 10: H });
  assert.equal(b.out(9), L, "the rise does not count");
  b.set({ 10: L });
  assert.equal(b.out(9), H, "the fall does");
  b.pulse(10, 7); // 8 counts in all
  const pinned = Q20.filter((p) => p != null);
  const want = bitsOf(8, 14).filter((_, i) => Q20[i] != null);
  assert.deepEqual(b.outs(pinned), want, "8 lights Q4 alone");
  b.pulse(10, 16384 - 8);
  assert.deepEqual(b.outs(pinned), Array(12).fill(L), "wraps at 2^14");
  b.pulse(10, 5).set({ 11: H });
  assert.deepEqual(b.outs(pinned), Array(12).fill(L), "RESET HIGH clears");
});

test("CD4024B: 7 stages in a 14-pin package, wrapping at 128", () => {
  const def = chipDef("CD4024B");
  assert.equal(def.package, "DIP-14");
  const Q24 = [12, 11, 9, 6, 5, 4, 3];
  const b = bench("CD4024B", { 1: L, 2: L });
  b.pulse(1, 100);
  assert.deepEqual(b.outs(Q24), bitsOf(100, 7));
  b.pulse(1, 28);
  assert.deepEqual(b.outs(Q24), Array(7).fill(L), "128 → 0");
  b.pulse(1, 3).set({ 2: H });
  assert.deepEqual(b.outs(Q24), Array(7).fill(L), "RESET");
  // A floating φ: maybe counted.
  const c = bench("CD4024B", { 1: L, 2: L });
  c.set({ 1: Z });
  assert.deepEqual(c.outs(Q24), Array(7).fill(X));
});

// ── CD4022B — octal counter, eight decoded outputs ──────────────────────────

// 0–7 on pins 2 1 3 7 11 4 5 10; CARRY OUT 12; INHIBIT 13; CLOCK 14; RESET 15.
const OUT22 = [2, 1, 3, 7, 11, 4, 5, 10];

test("CD4022B: one of 0–7 HIGH, CARRY OUT HIGH for 0–3, wrapping after 8", () => {
  const b = bench("CD4022B", { 13: L, 14: L, 15: L });
  for (let n = 0; n < 9; n++) {
    const want = OUT22.map((_, k) => (k === n % 8 ? H : L));
    assert.deepEqual(b.outs(OUT22), want, `count ${n}`);
    assert.equal(b.out(12), n % 8 < 4 ? H : L, `carry at ${n}`);
    b.pulse(14);
  }
});

test("CD4022B: CLOCK INHIBIT holds the count; RESET returns it to 0", () => {
  const b = bench("CD4022B", { 13: L, 14: L, 15: L });
  b.pulse(14, 3);
  b.set({ 13: H }).pulse(14, 2);
  assert.equal(b.out(7), H, "still 3");
  b.set({ 13: L, 15: H });
  assert.equal(b.out(2), H, "reset to 0");
});
