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

// The custom chip designer's Verilog subset (scripts/hdl/): the four-state
// values, the lexer and parser, the analyzer's refusals, and the interpreter
// run the way a Verilog simulator runs it.

import test from "node:test";
import assert from "node:assert/strict";

import * as V from "../hdl/values.js";
import { tokenize, isIdentifier } from "../hdl/lexer.js";
import { literalValue } from "../hdl/analyze.js";
import { compileModule } from "../hdl/compile.js";
import { moduleHeader, moduleName } from "../hdl/header.js";
import { highlightRuns, runAt } from "../hdl/highlight.js";

const port = (name, dir = "input", width = 1) => ({ name, dir, width });
const k = (w, v) => V.known(w, v);
const bits = (v) => V.format(v).split("'b")[1] ?? V.format(v);

/** Compile, asserting it worked. */
function ok(source, ports, name = "t") {
  const r = compileModule(source, ports, { name });
  assert.deepEqual(
    r.errors.map((e) => e.code),
    [],
    `unexpected errors: ${JSON.stringify(r.errors)}`,
  );
  return r;
}
/** Compile, asserting the first error's code. */
function refused(source, ports, code) {
  const r = compileModule(source, ports, { name: "t" });
  assert.ok(r.errors.length, `expected ${code}, compiled clean`);
  assert.equal(r.errors[0].code, code, JSON.stringify(r.errors));
  return r.errors[0];
}
const outByName = (r, ins, state = null) => {
  const vals = r.program.evaluate(ins, state);
  const out = {};
  r.program.signals.forEach((s, slot) => (out[s.name] = vals[slot]));
  return out;
};

// ── Values ─────────────────────────────────────────────────────────────────

test("four-state AND/OR: a known 0 or 1 dominates an unknown", () => {
  const x = V.allX(1);
  assert.equal(bits(V.and(k(1, 0), x)), "0");
  assert.equal(bits(V.and(k(1, 1), x)), "x");
  assert.equal(bits(V.or(k(1, 1), x)), "1");
  assert.equal(bits(V.or(k(1, 0), x)), "x");
  assert.equal(bits(V.xor(k(1, 1), x)), "x");
  assert.equal(bits(V.not(V.allZ(1))), "x"); // z reads as x
});

test("arithmetic with an unknown bit is all x; comparisons are x", () => {
  const a = V.make(4, 0b0100, 0b0001);
  assert.equal(bits(V.add(a, k(4, 1))), "xxxx");
  assert.equal(bits(V.lt(a, k(4, 9))), "x");
  assert.equal(bits(V.add(k(4, 15), k(4, 1))), "0000"); // wraps
  assert.equal(bits(V.div(k(4, 7), k(4, 0))), "xxxx"); // ÷0
});

test("== is 0 on a known difference, x on an unknown; === is exact", () => {
  const a = V.make(2, 0b10, 0b01);
  assert.equal(bits(V.eq(a, k(2, 0b00))), "0");
  assert.equal(bits(V.eq(a, k(2, 0b10))), "x");
  assert.equal(bits(V.caseEq(V.allX(2), V.allX(2))), "1");
  assert.equal(bits(V.caseEq(V.allX(2), V.allZ(2))), "0");
});

test("an unknown ternary condition merges the branches bit by bit", () => {
  const r = V.choose(V.allX(1), k(4, 0b1100), k(4, 0b1010));
  assert.equal(bits(r), "1xx0");
});

test("concat, slice and withBits keep the four states", () => {
  const c = V.concat([k(2, 0b10), V.allZ(1), k(1, 1)]);
  assert.equal(V.format(c), "4'b10z1");
  assert.equal(V.format(V.slice(c, 1, 2)), "2'b0z");
  assert.equal(V.format(V.withBits(k(4, 0), 2, k(2, 0b11))), "4'b1100");
});

// ── Lexing and literals ────────────────────────────────────────────────────

test("tokens carry their spans; keywords are reserved; comments kept", () => {
  const { tokens, errors } = tokenize(
    "assign Y = A & 4'b1_0x0; // hi\n/* c */",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(
    tokens.map((t) => t.type),
    ["keyword", "ident", "op", "ident", "op", "number", "op", "comment", "comment"], // prettier-ignore
  );
  assert.equal(tokens[1].line, 1);
  assert.equal(tokens[8].line, 2);
  assert.equal(isIdentifier("CLK"), true);
  assert.equal(isIdentifier("reg"), false);
  assert.equal(isIdentifier("1A"), false);
});

test("number literals: sizes, bases, x/z padding, truncation", () => {
  const num = (src) => literalValue(tokenize(src).tokens[0]);
  assert.equal(V.format(num("4'b1010")), "4'b1010");
  assert.equal(V.format(num("8'hA5")), "8'b10100101");
  assert.equal(V.format(num("4'bx")), "4'bxxxx");
  assert.equal(V.format(num("4'bz1")), "4'bzzz1");
  assert.equal(V.format(num("4'hFF")), "4'b1111");
  assert.equal(num("12").w, 32);
  assert.equal(num("'d7").w, 32);
  assert.equal(num("3'd5").v, 5);
  assert.equal(V.format(num("2'b?1")), "2'bz1");
});

// ── Refusals ───────────────────────────────────────────────────────────────

test("unsupported constructs are refused by name, never approximated", () => {
  const io = [port("A"), port("Y", "output")];
  refused("always @(*) while (A) Y = A;", io, "loopUnsupported");
  refused("initial forever Y = A;", io, "loopUnsupported");
  refused("assign #5 Y = A;", io, "delayUnsupported");
  refused("real r;", io, "realUnsupported");
  refused("initial $display(A);", io, "systemTask");
  refused("module t; endmodule", io, "headerInBody");
  refused("input B;", io, "portInBody");
  refused("and g1(Y, A, A);", io, "gateUnsupported");
  refused("wire [3:0] w [0:7];", io, "arrayUnsupported");
  refused("reg [3:0] m [0:7][0:1];", io, "multiDimensional");
  refused("always Y = A;", io, "alwaysNeedsEvent");
  refused("wire signed [3:0] s;", io, "signedUnsupported");
  refused("sub u1 (.a(A));", io, "instanceUnsupported");
});

test("the analyzer's checks: names, drivers, latches, loops, clocks", () => {
  const io = [port("A"), port("B"), port("CLK"), port("Y", "output")];
  refused("assign Y = Z;", io, "undeclared");
  refused("assign A = B;", io, "assignToInput");
  refused("reg r; assign r = A;", io, "assignToReg");
  refused("wire w; always @(*) w = A;", io, "proceduralToWire");
  refused("assign Y = A; assign Y = B;", io, "multipleDrivers");
  refused("always @(*) Y = A; always @(*) Y = B;", io, "multipleAlwaysDrivers"); // prettier-ignore
  refused("assign Y = A; always @(*) Y = B;", io, "mixedDrivers");
  refused("always @(*) if (A) Y = B;", io, "latch");
  refused("wire w; assign w = ~w; assign Y = w;", io, "combLoop");
  refused("always @(posedge Y) ;", io, "edgeNotInput");
  refused("always @(a or B) Y = A & B;", io, "undeclared");
  refused("always @(B) Y = A & B;", io, "incompleteSensitivity");
  refused("always @(posedge CLK or A) Y <= A;", io, "mixedSensitivity");
  refused("reg Y;", io, "outputRedeclared");
  refused(
    "reg q, r; always @(posedge CLK) q <= A; always @(posedge A) r <= B; assign Y = q ^ r;", // prettier-ignore
    io,
    "multipleClocks",
  );
  refused("reg [40:0] r;", io, "tooWide");
});

test("a latch-free always @(*) — a default first, or every branch — is fine", () => {
  const io = [port("A"), port("B"), port("Y", "output")];
  ok("always @(*) begin Y = 0; if (A) Y = B; end", io);
  ok("always @(*) if (A) Y = B; else Y = ~B;", io);
  ok("always @(*) case ({A, B}) 2'b00: Y = 0; 2'b01: Y = 1; 2'b10: Y = 1; 2'b11: Y = 0; endcase", io); // prettier-ignore
});

test("a case is full over its SUBJECT's values, whatever width its labels are", () => {
  const io = [port("S", "input", 2), port("A"), port("B"), port("C"), port("D"), port("Y", "output")]; // prettier-ignore
  // Plain decimal labels are 32 bits wide; they still cover a 2-bit subject.
  const r = ok("always @(*) case (S) 0: Y = A; 1: Y = B; 2: Y = C; 3: Y = D; endcase", io); // prettier-ignore
  assert.equal(bits(outByName(r, [k(2, 2), k(1, 0), k(1, 0), k(1, 1), k(1, 0)]).Y), "1"); // prettier-ignore
  ok("localparam S0 = 0, S1 = 1, S2 = 2, S3 = 3; always @(*) case (S) S0: Y = A; S1: Y = B; S2: Y = C; S3: Y = D; endcase", io); // prettier-ignore
  ok("always @(*) case (A) 0: Y = B; 1: Y = C; endcase", io);
  // A casez's ? bits match anything; one value left out is still a latch.
  ok("always @(*) casez (S) 2'b0?: Y = A; 2'b1?: Y = B; endcase", io);
  ok("always @(*) casex (S) 2'b0x: Y = A; 2'b1x: Y = B; endcase", io);
  refused("always @(*) casez (S) 2'b0?: Y = A; 2'b10: Y = B; endcase", io, "latch"); // prettier-ignore
  refused("always @(*) case (S) 0: Y = A; 1: Y = B; 2: Y = C; endcase", io, "latch"); // prettier-ignore
  // -1 is all ones at the case's 32 bits — never a 2-bit subject's 3.
  refused("always @(*) case (S) 0: Y = A; 1: Y = B; 2: Y = C; -1: Y = D; endcase", io, "latch"); // prettier-ignore
  // In a plain case an x bit matches only an x: it covers no known value.
  refused("always @(*) case (S) 2'b0x: Y = A; 2'b1x: Y = B; endcase", io, "latch"); // prettier-ignore
  // An OPERATION as the subject is evaluated at the case's width: ~S against
  // 32-bit labels is never 0…3, so four decimal labels leave it a latch…
  refused("always @(*) case (~S) 0: Y = A; 1: Y = B; 2: Y = C; 3: Y = D; endcase", io, "latch"); // prettier-ignore
  refused("always @(*) case (S + 1) 0: Y = A; 1: Y = B; 2: Y = C; 3: Y = D; endcase", io, "latch"); // prettier-ignore
  // …while sized labels keep the case at the subject's own two bits.
  ok("always @(*) case (~S) 2'd0: Y = A; 2'd1: Y = B; 2'd2: Y = C; 2'd3: Y = D; endcase", io); // prettier-ignore
  // Zero-extension alone widens nothing: a concatenation or an AND is full.
  ok("always @(*) case (S & 2'b11) 0: Y = A; 1: Y = B; 2: Y = C; 3: Y = D; endcase", io); // prettier-ignore
  // What counts is the values the subject TAKES at that width: a carry of
  // two bits reaches 2 and no further; a complement ANDed with a zero-
  // extended bit is that bit's 0 or 1.
  ok("always @(*) case (A + B) 0: Y = A; 1: Y = B; 2: Y = C; endcase", io); // prettier-ignore
  ok("always @(*) case (A & ~B) 0: Y = C; 1: Y = D; endcase", io);
  refused("always @(*) case (A + B) 0: Y = A; 1: Y = B; endcase", io, "latch"); // prettier-ignore
});

test("a loop counter in a branch is no latch — unless something reads it", () => {
  const io = [port("EN"), port("A", "input", 8), port("Y", "output", 8), port("Z", "output", 8)]; // prettier-ignore
  const r = ok(
    "integer i; always @(*) begin Y = 0; if (EN) for (i = 0; i < 8; i = i + 1) Y[i] = A[7 - i]; end assign Z = 0;", // prettier-ignore
    io,
  );
  assert.equal(bits(outByName(r, [k(1, 1), k(8, 1), null, null]).Y), "10000000"); // prettier-ignore
  assert.equal(bits(outByName(r, [k(1, 0), k(8, 1), null, null]).Y), "00000000"); // prettier-ignore
  ok("always @(*) begin Y = 0; if (EN) begin : rev integer i; for (i = 0; i < 8; i = i + 1) Y[i] = A[7 - i]; end end assign Z = 0;", io); // prettier-ignore
  // Read where the loop may not have run, it holds a value: a latch.
  refused("integer i; always @(*) begin Y = 0; if (EN) for (i = 0; i < 8; i = i + 1) Y[i] = A[i]; Z = i; end", io, "latch"); // prettier-ignore
  refused("integer i; always @(*) begin Y = 0; if (EN) for (i = 0; i < 8; i = i + 1) Y[i] = A[i]; end assign Z = i;", io, "latch"); // prettier-ignore
});

test("a <= target read back in the same combinational block is refused", () => {
  const io = [port("A"), port("Y", "output")];
  // It would still read its OLD value there (§9.2.2) — neither the engine's
  // settled answer nor a sensitivity that leaves it out would be Verilog's.
  refused("reg t; always @(A) begin t <= A; Y = t; end", io, "nonblockingReadBack"); // prettier-ignore
  refused("reg t; always @(*) begin t <= A; Y = t; end", io, "nonblockingReadBack"); // prettier-ignore
  ok("always @(*) Y <= A;", io);
  ok("reg t; always @(*) begin t = A; Y = t; end", io);
});

test("assign drives a fixed bit or range, never one a variable picks", () => {
  const io = [port("S", "input", 2), port("A"), port("Y", "output", 4)];
  refused("assign Y[S] = A;", io, "assignVariableSelect");
  refused("assign Y[S +: 2] = {A, A};", io, "assignVariableSelect");
  ok("assign Y[1] = A; assign Y[0] = 0; assign Y[3:2] = 0;", io);
});

test("a ranged parameter's bits are numbered as declared", () => {
  const io = [port("Y", "output", 4)];
  const r = ok(
    "parameter [8:1] P = 8'h80; parameter [0:7] Q = 8'h80; assign Y = {2'b00, P[8], Q[0]};", // prettier-ignore
    io,
  );
  assert.equal(bits(outByName(r, []).Y), "0011");
});

test("a carry rippling up one vector is no loop", () => {
  const io = [port("A", "input", 3), port("Y", "output")];
  const r = ok(
    "wire [2:0] c; assign c[0] = A[0]; assign c[1] = c[0] & A[1]; assign c[2] = c[1] & A[2]; assign Y = c[2];", // prettier-ignore
    io,
  );
  assert.equal(bits(outByName(r, [k(3, 7)]).Y), "1");
  assert.equal(bits(outByName(r, [k(3, 5)]).Y), "0");
});

test("async controls beside one clock are not a second clock", () => {
  const io = [port("CLK"), port("RST_N"), port("D"), port("Q", "output")];
  ok(
    "always @(posedge CLK or negedge RST_N) if (!RST_N) Q <= 0; else Q <= D;",
    io,
  );
});

// ── The header ─────────────────────────────────────────────────────────────

test("the header declares each output reg or wire from what drives it", () => {
  const ports = [port("CLK"), port("D", "input", 4), port("Q", "output", 4), port("Z", "output")]; // prettier-ignore
  const r = ok("always @(posedge CLK) Q <= D; assign Z = ^Q;", ports, "REG4");
  assert.equal(
    r.header,
    [
      "module REG4 (",
      "  input  wire       CLK,",
      "  input  wire [3:0] D,",
      "  output reg  [3:0] Q,",
      "  output wire       Z",
      ");",
    ].join("\n"),
  );
  assert.equal(moduleHeader("E", []), "module E;");
  assert.equal(moduleName("74XX01"), "chip_74XX01");
  assert.equal(moduleName("MY-CHIP"), "MY_CHIP");
  assert.equal(moduleName("reg"), "chip_reg");
});

// ── Evaluation ─────────────────────────────────────────────────────────────

test("a NAND gate, x on an unknown input unless the other forces it", () => {
  const r = ok("assign Y = ~(A & B);", [port("A"), port("B"), port("Y", "output")]); // prettier-ignore
  const y = (a, b) => bits(r.program.outputValues([a, b])[0]);
  assert.equal(y(k(1, 1), k(1, 1)), "0");
  assert.equal(y(k(1, 0), k(1, 1)), "1");
  assert.equal(y(k(1, 0), V.allX(1)), "1");
  assert.equal(y(k(1, 1), V.allX(1)), "x");
});

test("context-determined widths keep an adder's carry", () => {
  const ports = [port("A", "input", 4), port("B", "input", 4), port("S", "output", 5)]; // prettier-ignore
  const r = ok("assign S = A + B;", ports);
  assert.equal(r.program.outputValues([k(4, 15), k(4, 1)])[0].v, 16);
  // …and a concatenation target splits the sum, most significant first.
  const r2 = ok("assign {C, S4} = A + B;", [port("A", "input", 4), port("B", "input", 4), port("C", "output"), port("S4", "output", 4)]); // prettier-ignore
  const [c, s] = r2.program.outputValues([k(4, 9), k(4, 8)]);
  assert.equal(c.v, 1);
  assert.equal(s.v, 1);
});

test("an undriven output floats (z) and says so", () => {
  const r = compileModule("", [port("A"), port("Y", "output")], { name: "t" });
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.warnings.map((w) => w.code),
    ["outputUndriven"],
  );
  assert.equal(V.format(r.program.outputValues([k(1, 1)])[0]), "1'bz");
});

test("a tri-state output: z when disabled", () => {
  const r = ok("assign Y = OE ? D : 1'bz;", [port("D"), port("OE"), port("Y", "output")]); // prettier-ignore
  assert.equal(V.format(r.program.outputValues([k(1, 1), k(1, 0)])[0]), "1'bz");
  assert.equal(V.format(r.program.outputValues([k(1, 1), k(1, 1)])[0]), "1'b1");
});

test("casez treats z/? as don't-care", () => {
  const ports = [port("S", "input", 3), port("Y", "output", 2)];
  const r = ok(
    "always @(*) casez (S) 3'b1??: Y = 2'd3; 3'b01?: Y = 2'd2; 3'b001: Y = 2'd1; default: Y = 2'd0; endcase", // prettier-ignore
    ports,
  );
  const y = (s) => r.program.outputValues([k(3, s)])[0].v;
  assert.deepEqual([0, 1, 2, 3, 4, 7].map(y), [0, 1, 2, 2, 3, 3]);
});

// ── Stepping ───────────────────────────────────────────────────────────────

test("a D flip-flop samples D on the rising edge only", () => {
  const r = ok("always @(posedge CLK) Q <= D;", [port("CLK"), port("D"), port("Q", "output")]); // prettier-ignore
  const p = r.program;
  let st = p.initialState();
  assert.equal(V.format(p.outputValues([k(1, 0), k(1, 1)], st)[0]), "1'bx");
  // No edge: the state comes back verbatim.
  assert.equal(p.step(st, [k(1, 0), k(1, 1)], [k(1, 0), k(1, 0)]), st);
  st = p.step(st, [k(1, 1), k(1, 1)], [k(1, 0), k(1, 1)]);
  assert.equal(p.outputValues([k(1, 1), k(1, 0)], st)[0].v, 1);
  const held = p.step(st, [k(1, 0), k(1, 0)], [k(1, 1), k(1, 0)]); // falling
  assert.equal(held, st);
  // No previous sample (the first tick): no edge.
  assert.equal(p.step(st, [k(1, 1), k(1, 0)], null), st);
});

test("non-blocking assignments swap; blocking ones do not", () => {
  const ports = [port("CLK"), port("A", "output"), port("B", "output")];
  const nb = ok("reg a = 1'b0, b = 1'b1; always @(posedge CLK) begin a <= b; b <= a; end assign A = a; assign B = b;", ports); // prettier-ignore
  let st = nb.program.step(nb.program.initialState(), [k(1, 1)], [k(1, 0)]);
  assert.deepEqual(nb.program.outputValues([k(1, 1)], st).map((v) => v.v), [1, 0]); // prettier-ignore
  const bl = ok("reg a = 1'b0, b = 1'b1; always @(posedge CLK) begin a = b; b = a; end assign A = a; assign B = b;", ports); // prettier-ignore
  st = bl.program.step(bl.program.initialState(), [k(1, 1)], [k(1, 0)]);
  assert.deepEqual(bl.program.outputValues([k(1, 1)], st).map((v) => v.v), [1, 1]); // prettier-ignore
});

test("a 4-bit counter with an asynchronous active-low reset", () => {
  const ports = [port("CLK"), port("RST_N"), port("Q", "output", 4)];
  const r = ok(
    "reg [3:0] count; always @(posedge CLK or negedge RST_N) if (!RST_N) count <= 0; else count <= count + 1; assign Q = count;", // prettier-ignore
    ports,
  );
  const p = r.program;
  let st = p.initialState();
  const q = () => V.format(p.outputValues([k(1, 0), k(1, 1)], st)[0]);
  assert.equal(q(), "4'bxxxx"); // a reg nobody initialised is x
  st = p.step(st, [k(1, 0), k(1, 0)], [k(1, 0), k(1, 1)]); // reset falls
  assert.equal(q(), "4'b0000");
  for (let n = 0; n < 17; n++) {
    st = p.step(st, [k(1, 1), k(1, 1)], [k(1, 0), k(1, 1)]);
  }
  assert.equal(q(), "4'b0001"); // 17 mod 16
});

test("initial blocks and declaration initialisers set the power-up state", () => {
  const r = ok(
    "reg [1:0] s = 2'd2; reg t; initial t = 1'b1; assign Y = {s, t};",
    [port("Y", "output", 3)],
  );
  assert.equal(
    r.program.outputValues([], r.program.initialState())[0].v,
    0b101,
  );
});

// ── Tracing ────────────────────────────────────────────────────────────────

test("traceComb runs only the blocks a change reaches, in order", () => {
  const ports = [port("A"), port("B"), port("C"), port("X", "output"), port("Y", "output")]; // prettier-ignore
  const r = ok("wire n; assign n = A & B; assign X = ~n; assign Y = C;", ports); // prettier-ignore
  const p = r.program;
  const before = p.evaluate([k(1, 0), k(1, 0), k(1, 0)], null);
  const { frames, vals } = p.traceComb(before, [k(1, 1), k(1, 1), k(1, 0)], null); // prettier-ignore
  // n's assign, then X's — never Y's (C did not change).
  assert.equal(frames.length, 2);
  assert.ok(frames.every((f) => f.phase === "comb"));
  const fresh = p.evaluate([k(1, 1), k(1, 1), k(1, 0)], null);
  assert.ok(vals.every((v, slot) => V.same(v, fresh[slot])));
});

test("traceStep: the edge block, its non-blocking updates, then the reaction", () => {
  const ports = [port("CLK"), port("Q", "output", 2)];
  const r = ok("reg [1:0] c = 0; always @(posedge CLK) c <= c + 1; assign Q = c;", ports); // prettier-ignore
  const p = r.program;
  const st = p.initialState();
  const t = p.traceStep(st, [k(1, 1)], [k(1, 0)]);
  assert.deepEqual(
    t.frames.map((f) => f.phase),
    ["edge", "nba", "comb"],
  );
  assert.ok(t.frames[1].pending.length > 0); // c → 1 is pending at the nba
  assert.equal(p.outputValues([k(1, 1)], t.state)[0].v, 1);
  // The reaction's frame is Q's assign, and the trace ends where a fresh
  // evaluation of the new state does.
  assert.equal(t.frames[2].loc.line, 1);
  const fresh = p.evaluate([k(1, 1)], t.state);
  assert.ok(t.vals.every((v, slot) => V.same(v, fresh[slot])));
});

// ── Highlighting ───────────────────────────────────────────────────────────

test("highlight runs mark pins, signals and a pin's constant bit", () => {
  const src = "reg r; assign Q[2] = r; // note";
  const runs = highlightRuns(src, { pins: ["Q"], signals: ["r"] });
  const q = runAt(runs, src.indexOf("Q"));
  assert.equal(q.cls, "pin");
  assert.equal(q.bit, 2);
  assert.equal(runAt(runs, src.indexOf("r;")).cls, "signal");
  assert.equal(runAt(runs, src.indexOf("//")).cls, "comment");
  assert.equal(runAt(runs, 0).cls, "keyword");
});

// ── Where a debugger can stop ─────────────────────────────────────────────

test("executableLines: every statement's first line, and nothing else", () => {
  const r = ok(
    [
      "// a register", //                 1  comment
      "reg [7:0] q = 8'd0;", //            2  declaration (an initialiser)
      "wire w;", //                         3  declaration
      "assign w = ~LOAD;", //               4  continuous assignment
      "always @(negedge CLK) begin", //     5  the block itself
      "  if (w)", //                        6  if
      "    q <= D;", //                      7  assignment
      "  case (q)", //                       8  case
      "    8'd0: q <= 8'd1;", //             9  an item's statement
      "    default: ;", //                  10  a null statement
      "  endcase", //                       11
      "end", //                             12
      "assign Q = q;", //                   13
      "initial q = 8'd5;", //               14  runs before anything is watched
    ].join("\n"),
    [port("D", "input", 8), port("CLK"), port("LOAD"), port("Q", "output", 8)],
  );
  assert.deepEqual(
    [...r.program.executableLines].sort((a, b) => a - b),
    [4, 6, 7, 8, 9, 13],
  );
});

// ── Round 2: signedness ───────────────────────────────────────────────────
// IEEE 1364 §5.5: a plain decimal, an integer and a parameter given a signed
// value are signed; an expression is signed only when every operand is.

const out8 = (source, ins = [k(8, 0)]) => {
  const r = ok(source, [port("A", "input", 8), port("Y", "output", 8)]);
  return V.format(r.program.outputValues(ins, r.program.initialState())[0]);
};

test("all-signed expressions compare, divide and shift as signed numbers", () => {
  assert.equal(out8("assign Y = ((0 - 1) < 2);"), "8'b00000001");
  assert.equal(out8("localparam N = 4; assign Y = (N - 5) < 0;"), "8'b00000001"); // prettier-ignore
  assert.equal(out8("assign Y = (0 - 7) / 2;"), "8'b11111101"); // -3
  assert.equal(out8("assign Y = (0 - 7) % 2;"), "8'b11111111"); // -1
  assert.equal(out8("assign Y = (0 - 8) >>> 1;"), "8'b11111100"); // -4
  // A condition does not take part: both branches are signed, so is this.
  assert.equal(out8("assign Y = (A[0] ? 0 - 1 : 2) < 0;", [k(8, 1)]), "8'b00000001"); // prettier-ignore
});

test("one unsigned operand makes the whole expression unsigned", () => {
  assert.equal(out8("assign Y = 4'd0 - 1 < 2;"), "8'b00000000"); // based: unsigned
  assert.equal(out8("assign Y = (A - 1) < 2;"), "8'b00000000");
  assert.equal(out8("localparam [7:0] P = 0; assign Y = (P - 1) < 2;"), "8'b00000000"); // prettier-ignore
  assert.equal(out8("assign Y = 'd0 - 1 < 2;"), "8'b00000000");
});

test("integer: 32 signed bits, a general variable", () => {
  const io = [port("CLK"), port("Y", "output", 8), port("N", "output")];
  const r = ok(
    "integer n = 0; always @(posedge CLK) n <= n - 1; assign Y = n; assign N = n < 0;", // prettier-ignore
    io,
  );
  const p = r.program;
  let st = p.initialState();
  st = p.step(st, [k(1, 1)], [k(1, 0)]);
  const [y, neg] = p.outputValues([k(1, 1)], st);
  assert.equal(V.format(y), "8'b11111111");
  assert.equal(neg.v, 1);
  const n = p.signals.find((s) => s.name === "n");
  assert.equal(n.signed, true);
  assert.equal(n.integer, true);
  assert.equal(n.w, 32);
  ok("parameter integer K = 4'd15; assign Y = K;", io);
});

test("signed values: helpers for division, modulo, shifts and extension", () => {
  assert.equal(V.format(V.signExtend(V.make(4, 0b1000), 8)), "8'b11111000");
  assert.equal(V.format(V.signExtend(V.make(4, 0b0000, 0b1000, 0b1000), 6)), "6'bzzz000"); // prettier-ignore
  assert.equal(V.format(V.ashr(V.make(4, 0b1010), k(4, 2))), "4'b1110");
  assert.equal(V.format(V.ashr(V.make(4, 0b0110), k(4, 9))), "4'b0000");
  assert.equal(V.format(V.sdiv(k(8, 0xf9), k(8, 2))), "8'b11111101");
  assert.equal(V.format(V.smod(k(8, 0xf9), k(8, 2))), "8'b11111111");
  assert.equal(bits(V.slt(k(8, 0xff), k(8, 1))), "1");
  assert.equal(bits(V.lt(k(8, 0xff), k(8, 1))), "0");
});

// ── Round 2: ** and indexed part-selects ───────────────────────────────────

test("** follows Table 5-6, negative exponents included", () => {
  assert.equal(out8("assign Y = 2 ** 5;"), "8'b00100000");
  assert.equal(out8("assign Y = A ** 2;", [k(8, 7)]), "8'b00110001");
  assert.equal(out8("assign Y = 3 ** 0;"), "8'b00000001");
  assert.equal(out8("assign Y = 2 ** (0 - 1);"), "8'b00000000");
  assert.equal(out8("assign Y = 1 ** (0 - 3);"), "8'b00000001");
  assert.equal(out8("assign Y = (0 - 1) ** (0 - 3);"), "8'b11111111");
  assert.equal(out8("assign Y = (0 - 1) ** (0 - 2);"), "8'b00000001");
  assert.equal(out8("assign Y = 0 ** (0 - 1);"), "8'bxxxxxxxx");
  // It binds tighter than * and associates left (§5.1.2).
  assert.equal(out8("assign Y = 2 * 2 ** 3;"), "8'b00010000");
  assert.equal(out8("assign Y = 2 ** 2 ** 3;"), "8'b01000000"); // (2**2)**3
  assert.equal(out8("localparam W = 2 ** 3; assign Y = W;"), "8'b00001000");
});

test("indexed part-selects read and write either way round, off the ends x / nothing", () => {
  const a = [k(8, 0b10110000)];
  assert.equal(out8("assign Y = A[3 +: 4];", a), "8'b00000110");
  assert.equal(out8("assign Y = A[7 -: 4];", a), "8'b00001011");
  // A vector declared [0:7] numbers its bits the other way round.
  assert.equal(
    out8("wire [0:7] r = A; assign Y = {r[0 +: 4], 4'b0};", a),
    "8'b10110000",
  );
  // A variable start may run off the end: those bits read x.
  assert.equal(
    out8("wire [2:0] s = A[2:0]; assign Y = A[s +: 4];", [k(8, 0b11000110)]),
    "8'b0000xx11",
  );
  // …and written there, they go nowhere.
  assert.equal(
    out8("always @(*) begin Y = 8'd0; Y[A[2:0] +: 2] = 2'b11; end", [k(8, 7)]),
    "8'b10000000",
  );
  const io = [port("A", "input", 8), port("Y", "output", 8)];
  refused("assign Y = A[6 +: 4];", io, "selectOutOfRange");
  refused("assign Y = A[2 +: 0];", io, "badSelectWidth");
  refused("assign Y = A[2 +: A];", io, "notConstant");
});

// ── Round 2: loops ─────────────────────────────────────────────────────────

test("a for loop in always @(*) is unrolled: bit reversal and a population count", () => {
  assert.equal(
    out8("integer i; always @(*) begin Y = 0; for (i = 0; i < 8; i = i + 1) Y[i] = A[7 - i]; end", [k(8, 0b10000011)]), // prettier-ignore
    "8'b11000001",
  );
  assert.equal(
    out8("integer i; always @(*) begin Y = 0; for (i = 0; i < 8; i = i + 1) Y = Y + A[i]; end", [k(8, 0b10110011)]), // prettier-ignore
    "8'b00000101",
  );
  // Every bit set by some pass, on every path: no latch.
  assert.equal(
    out8("integer i; always @(*) for (i = 0; i < 8; i = i + 1) if (A[i]) Y[i] = 1; else Y[i] = 0;", [k(8, 0b1010)]), // prettier-ignore
    "8'b00001010",
  );
  // A pass off the end of a vector writes nothing, as the loop running would.
  assert.equal(
    out8("integer i; always @(*) begin Y = 0; for (i = 0; i < 9; i = i + 1) Y[i] = A[0]; end", [k(8, 1)]), // prettier-ignore
    "8'b11111111",
  );
  assert.equal(out8("always @(*) begin Y = 0; repeat (3) Y = Y + 1; end"), "8'b00000011"); // prettier-ignore
  // Down-counting, and a loop that never runs.
  assert.equal(
    out8("integer i; always @(*) begin Y = 0; for (i = 7; i >= 0; i = i - 1) Y = {Y[6:0], A[i]}; end", [k(8, 0b00010111)]), // prettier-ignore
    "8'b00010111",
  );
  assert.equal(out8("integer i; always @(*) begin Y = 5; for (i = 0; i < 0; i = i + 1) Y = 0; end"), "8'b00000101"); // prettier-ignore
});

test("a counter declared in a named block is that block's own", () => {
  const io = [port("A", "input", 8), port("Y", "output", 8), port("Z", "output", 8)]; // prettier-ignore
  const r = ok(
    [
      "always @(*) begin : count",
      "  integer i;",
      "  Y = 0;",
      "  for (i = 0; i < 8; i = i + 1) Y = Y + A[i];",
      "end",
      "always @(*) begin : flip",
      "  integer i;",
      "  for (i = 0; i < 8; i = i + 1) Z[i] = A[7 - i];",
      "end",
    ].join("\n"),
    io,
  );
  const names = r.program.signals.map((s) => s.name);
  assert.ok(names.includes("count.i") && names.includes("flip.i"));
  const [y, z] = r.program.outputValues([k(8, 0b00000111)], null);
  assert.equal(y.v, 3);
  assert.equal(z.v, 0b11100000);
});

test("a loop runs in a clocked block as written: clearing a memory on reset", () => {
  const ports = [port("CLK"), port("RST"), port("A", "input", 3), port("Q", "output", 8)]; // prettier-ignore
  const r = ok(
    [
      "reg [7:0] mem [0:7];",
      "integer i;",
      "initial for (i = 0; i < 8; i = i + 1) mem[i] = i * 3;",
      "always @(posedge CLK) if (RST) begin : clr",
      "  integer j;",
      "  for (j = 0; j < 8; j = j + 1) mem[j] <= 8'hAA;",
      "end",
      "assign Q = mem[A];",
    ].join("\n"),
    ports,
  );
  const p = r.program;
  let st = p.initialState();
  const q = (a) => p.outputValues([k(1, 0), k(1, 0), k(3, a)], st)[0].v;
  assert.equal(q(5), 15);
  st = p.step(st, [k(1, 1), k(1, 1), k(3, 0)], [k(1, 0), k(1, 1), k(3, 0)]);
  assert.equal(q(5), 0xaa);
  assert.equal(q(0), 0xaa);
});

test("loops whose end cannot be known beforehand are refused by name", () => {
  const io = [port("A", "input", 8), port("Y", "output", 8)];
  refused("integer i; always @(*) for (i = 0; i < A; i = i + 1) Y = 1;", io, "loopNotStatic"); // prettier-ignore
  refused("integer i; always @(*) for (i = A; i < 8; i = i + 1) Y = 1;", io, "loopNotStatic"); // prettier-ignore
  refused("always @(*) begin Y = 0; repeat (A) Y = Y + 1; end", io, "loopNotStatic"); // prettier-ignore
  refused("integer i; always @(*) begin Y = 0; for (i = 0; i < 8; i = i + 1) begin Y[i] = 1; i = 3; end end", io, "loopCounterAssigned"); // prettier-ignore
  // A 4-bit counter never reaches 16: the loop would never end.
  refused("reg [3:0] i; always @(*) begin Y = 0; for (i = 0; i < 16; i = i + 1) Y = Y + 1; end", io, "loopTooLong"); // prettier-ignore
  refused("integer i, j; always @(*) for (i = 0; i < 8; j = j + 1) Y = 1;", io, "loopCounterForm"); // prettier-ignore
  refused("always @(*) for (integer i = 0; i < 8; i = i + 1) Y[i] = 1;", io, "loopHeaderDeclaration"); // prettier-ignore
  refused(
    "integer i; reg [7:0] a, b; always @(*) begin a = 0; for (i = 0; i < 8; i = i + 1) a[i] = A[i]; end always @(*) begin b = 0; for (i = 0; i < 8; i = i + 1) b[i] = A[i]; end assign Y = a & b;", // prettier-ignore
    io,
    "loopCounterShared",
  );
  // An always @(*) unrolls its loops, so it is held to fewer passes.
  refused("integer i; always @(*) begin Y = 0; for (i = 0; i < 2000; i = i + 1) Y = Y + 1; end", io, "loopTooLong"); // prettier-ignore
});

test("named blocks: declarations first, never initialised, names unique", () => {
  const io = [port("A"), port("Y", "output")];
  refused("always @(*) begin reg t; t = A; Y = t; end", io, "declarationInBlock"); // prettier-ignore
  refused("always @(*) begin : b Y = A; reg t; end", io, "declarationAfterStatement"); // prettier-ignore
  refused("always @(*) begin : b reg t = 1; Y = t; end", io, "blockInitialiser"); // prettier-ignore
  refused("always @(*) begin : b wire w; Y = A; end", io, "declarationAtTop");
  refused("always @(*) begin : b Y = A; end always @(*) begin : b end", io, "duplicateBlockName"); // prettier-ignore
  // A local shadows the module's own name inside its block only.
  const r = ok(
    "reg t; always @(*) begin : b reg t; t = ~A; Y = t; end initial t = 1'b0;",
    io,
  );
  assert.equal(r.program.outputValues([k(1, 1)], r.program.initialState())[0].v, 0); // prettier-ignore
});

test("a loop's own line is somewhere to stop, once per pass", () => {
  const r = ok(
    [
      "integer i;", //                                1
      "always @(posedge CLK) begin", //               2
      "  for (i = 0; i < 3; i = i + 1)", //           3
      "    q <= q + 1;", //                            4
      "end", //                                       5
      "assign Q = q;", //                              6
      "reg [7:0] q = 0;", //                           7
    ].join("\n"),
    [port("CLK"), port("Q", "output", 8)],
  );
  assert.deepEqual([...r.program.executableLines].sort((a, b) => a - b), [3, 4, 6]); // prettier-ignore
  const t = r.program.traceStep(r.program.initialState(), [k(1, 1)], [k(1, 0)]);
  const lines = t.frames.filter((f) => f.phase === "edge").map((f) => f.loc.line); // prettier-ignore
  assert.deepEqual(lines, [3, 4, 3, 4, 3, 4, 3]);
});

// ── Round 2: inout ─────────────────────────────────────────────────────────

test("an inout reads its pin and drives through assign, with no false loop", () => {
  const ports = [port("D", "inout", 4), port("OE"), port("Y", "output", 4)];
  const r = ok("assign D = OE ? 4'b1010 : 4'bz; assign Y = ~D;", ports, "BUS");
  assert.equal(
    r.header,
    [
      "module BUS (",
      "  inout  wire [3:0] D,",
      "  input  wire       OE,",
      "  output wire [3:0] Y",
      ");",
    ].join("\n"),
  );
  const p = r.program;
  assert.deepEqual(
    p.inputs.map((s) => s.kind),
    ["inout", "input"],
  );
  assert.deepEqual(
    p.outputs.map((s) => s.name),
    ["D", "Y"],
  );
  // Driving: the value goes out; what it READS is the pin, given here.
  const [drive, y] = p.outputValues([k(4, 0b0110), k(1, 1)]);
  assert.equal(V.format(drive), "4'b1010");
  assert.equal(V.format(y), "4'b1001");
  assert.equal(V.format(p.outputValues([k(4, 0), k(1, 0)])[0]), "4'bzzzz");
  refused("always @(*) D = 4'd1;", ports, "inoutProcedural");
  refused("reg D;", ports, "inoutRedeclared");
});

// ── Round 2: memories ──────────────────────────────────────────────────────

test("an SRAM with an inout data bus: written on WE's rising edge, read while enabled", () => {
  const ports = [port("A", "input", 5), port("D", "inout", 8), port("CE_N"), port("OE_N"), port("WE_N")]; // prettier-ignore
  const r = ok(
    "reg [7:0] mem [0:31];\nalways @(posedge WE_N) if (!CE_N) mem[A] <= D;\nassign D = (!CE_N && !OE_N && WE_N) ? mem[A] : 8'bz;", // prettier-ignore
    ports,
  );
  const p = r.program;
  const ins = (a, d, ce, oe, we) => [k(5, a), d, k(1, ce), k(1, oe), k(1, we)];
  let st = p.initialState();
  assert.equal(V.format(p.outputValues(ins(3, V.allZ(8), 0, 0, 1), st)[0]), "8'bxxxxxxxx"); // prettier-ignore
  st = p.step(st, ins(3, k(8, 0x3e), 0, 1, 1), ins(3, k(8, 0x3e), 0, 1, 0));
  assert.equal(p.outputValues(ins(3, V.allZ(8), 0, 0, 1), st)[0].v, 0x3e);
  assert.equal(V.format(p.outputValues(ins(3, V.allZ(8), 1, 0, 1), st)[0]), "8'bzzzzzzzz"); // prettier-ignore
  // While WE is low the chip lets go of the bus.
  assert.equal(V.format(p.outputValues(ins(3, k(8, 0x55), 0, 0, 0), st)[0]), "8'bzzzzzzzz"); // prettier-ignore
});

test("a memory: x until written, out-of-range addresses read x and write nothing", () => {
  const ports = [port("CLK"), port("A", "input", 4), port("D", "input", 8), port("Q", "output", 8)]; // prettier-ignore
  const r = ok("reg [7:0] mem [2:9]; always @(posedge CLK) mem[A] <= D; assign Q = mem[A];", ports); // prettier-ignore
  const p = r.program;
  let st = p.initialState();
  const write = (a, d) => {
    st = p.step(st, [k(1, 1), k(4, a), k(8, d)], [k(1, 0), k(4, a), k(8, d)]);
  };
  const read = (a) => V.format(p.outputValues([k(1, 0), k(4, a), k(8, 0)], st)[0]); // prettier-ignore
  assert.equal(read(2), "8'bxxxxxxxx");
  write(2, 0x11);
  write(9, 0x99);
  const before = st;
  write(12, 0x55); // no such word: nothing changes
  assert.equal(st, before);
  assert.equal(read(2), "8'b00010001");
  assert.equal(read(9), "8'b10011001");
  assert.equal(read(1), "8'bxxxxxxxx");
});

test("memories are refused where they cannot mean anything", () => {
  const io = [port("CLK"), port("A", "input", 4), port("Q", "output", 8)];
  refused("reg [7:0] mem [0:40000];", io, "memoryTooDeep");
  refused("reg [7:0] a [0:32767]; reg [7:0] b [0:32767]; reg c [0:3];", io, "memoryTooLarge"); // prettier-ignore
  refused("reg [7:0] mem [0:3]; always @(*) mem[A] = 8'd1;", io, "memoryInComb"); // prettier-ignore
  refused("reg [7:0] mem [0:3]; assign Q = mem;", io, "wholeArray");
  refused("reg [7:0] mem [0:3]; assign Q = mem[1:0];", io, "wholeArray");
  refused("reg [7:0] mem [0:3] = 0;", io, "arrayInitialiser");
  refused("reg [7:0] mem [0:3]; assign mem[0] = 8'd1;", io, "assignToReg");
  const r = compileModule("reg [7:0] rom [0:3]; assign Q = rom[A];", io, { name: "t" }); // prettier-ignore
  assert.deepEqual(
    r.warnings.map((w) => w.code),
    ["regUnassigned"],
  );
});

test("a 32K memory: a write copies a path, an idle edge copies nothing", () => {
  const ports = [port("CLK"), port("WE"), port("A", "input", 15), port("D", "input", 8), port("Q", "output", 8)]; // prettier-ignore
  const r = ok("reg [7:0] mem [0:32767]; always @(posedge CLK) if (WE) mem[A] <= D; assign Q = mem[A];", ports); // prettier-ignore
  const p = r.program;
  let st = p.initialState();
  const edge = (we, a, d) => {
    const next = p.step(st, [k(1, 1), k(1, we), k(15, a), k(8, d)], [k(1, 0), k(1, we), k(15, a), k(8, d)]); // prettier-ignore
    const changed = next !== st;
    st = next;
    return changed;
  };
  const t0 = performance.now();
  for (let a = 0; a < 200; a++) edge(1, a * 163, a & 0xff);
  const perWrite = (performance.now() - t0) / 200;
  assert.ok(perWrite < 1, `a write edge took ${perWrite.toFixed(3)} ms`);
  assert.equal(edge(0, 5, 1), false); // WE low: the state comes back as it was
  assert.equal(p.outputValues([k(1, 0), k(1, 0), k(15, 163 * 7), k(8, 0)], st)[0].v, 7); // prettier-ignore
  assert.equal(p.outputValues([k(1, 0), k(1, 0), k(15, 32767), k(8, 0)], st)[0].x, 0xff); // prettier-ignore
});

test("a traced memory write is pending until the non-blocking updates land", () => {
  const ports = [port("CLK"), port("Q", "output", 8)];
  const r = ok("reg [7:0] mem [0:3]; initial mem[1] = 8'd5; always @(posedge CLK) mem[1] <= mem[1] + 1; assign Q = mem[1];", ports); // prettier-ignore
  const p = r.program;
  const t = p.traceStep(p.initialState(), [k(1, 1)], [k(1, 0)]);
  const nba = t.frames.find((f) => f.phase === "nba");
  const [[slot, pend]] = nba.pending;
  assert.equal(p.signals[slot].name, "mem");
  assert.equal(pend.mem, true);
  assert.deepEqual(
    pend.writes.map(([addr, v]) => [addr, v.v]),
    [[1, 6]],
  );
  assert.equal(p.outputValues([k(1, 1)], t.state)[0].v, 6);
});

test("memory.js: a write shares everything but its path; a transaction writes in place", async () => {
  const M = await import("../hdl/memory.js");
  const a = M.newMemory(8, 32768);
  assert.equal(M.readWord(a, 7).x, 0xff);
  const b = M.writeWord(a, 1000, k(8, 0x42));
  assert.notEqual(a, b);
  assert.equal(M.readWord(b, 1000).v, 0x42);
  assert.equal(M.readWord(a, 1000).x, 0xff); // the old one untouched
  assert.equal(M.writeWord(b, 1000, k(8, 0x42)), b); // nothing changed
  assert.equal(M.writeWord(b, 99999, k(8, 1)), b); // no such word
  assert.equal(b.root[5], a.root[5]); // an untouched subtree is shared
  const tx = M.newTx();
  const c = M.writeWord(b, 1, k(8, 1), tx);
  const d = M.writeWord(c, 2, k(8, 2), tx);
  assert.equal(c, d); // the transaction's own memory, written in place
  assert.equal(M.readWord(b, 1).x, 0xff);
  assert.deepEqual(M.changedWords(b, d).map(([addr, v]) => [addr, v.v]), [[1, 1], [2, 2]]); // prettier-ignore
  assert.equal(M.sameMemory(b, M.writeWord(M.writeWord(b, 5, k(8, 9)), 5, V.allX(8))), true); // prettier-ignore
});

test("hexDigits prints words as %h does, x and z per nibble", () => {
  assert.equal(V.hexDigits(k(8, 0x3e)), "3E");
  assert.equal(V.hexDigits(V.allX(8)), "xx");
  assert.equal(V.hexDigits(V.allZ(12)), "zzz");
  assert.equal(V.hexDigits(V.make(8, 0x30, 0x01)), "3X");
  assert.equal(V.hexDigits(V.make(8, 0x30, 0x01, 0x01)), "3Z");
  assert.equal(V.hexDigits(k(5, 0x1f)), "1F");
});
