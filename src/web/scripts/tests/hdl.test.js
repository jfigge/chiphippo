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
  refused("always @(*) for (i = 0; i < 4; i = i + 1) Y = A;", io, "loopUnsupported"); // prettier-ignore
  refused("assign #5 Y = A;", io, "delayUnsupported");
  refused("integer i;", io, "integerUnsupported");
  refused("initial $display(A);", io, "systemTask");
  refused("module t; endmodule", io, "headerInBody");
  refused("input B;", io, "portInBody");
  refused("assign Y = A ** 2;", io, "powerUnsupported");
  refused("and g1(Y, A, A);", io, "gateUnsupported");
  refused("reg [3:0] mem [0:7];", io, "arrayUnsupported");
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
