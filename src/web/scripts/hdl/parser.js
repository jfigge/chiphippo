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

// parser.js — the Verilog subset's parser: a module BODY's tokens (lexer.js)
// into a small AST of declarations, continuous assigns and always/initial
// blocks. The module header is generated from the chip's package (header.js),
// so the body is all there is to parse.
//
// THE SUBSET, and its rule: what is implemented is real Verilog-2001 with real
// Verilog semantics, and what is not implemented is REFUSED BY NAME, never
// approximated — a `for` loop is "loops aren't supported", not a syntax error
// three tokens later. So the parser recognises the constructs it rejects as
// carefully as the ones it accepts.
//
//   items       reg / wire / integer declarations (an optional [msb:lsb]
//               range, an initialiser, and for a reg or integer an array
//               dimension), localparam / parameter, `assign`, `always`,
//               `initial`
//   statements  begin…end (a named block may declare its own reg and
//               integer variables), if / else, case / casez / casex with
//               default, blocking `=` and non-blocking `<=`, and the two
//               loops whose bounds can be constants: `for` and `repeat`
//   expressions every Verilog operator, bit, part and indexed part selects,
//               an array's word, concatenation and replication, the ternary
//
// No `while` or `forever` (every evaluation must finish — the analyzer proves
// a for or repeat does), no delays, no event controls inside statements, no
// functions, tasks or instances.
//
// An error abandons the item it is in (one diagnostic per item — the first is
// the one worth reading) and parsing resumes at the next item keyword.

import { diag } from "./lexer.js";

/** The keywords an item may start with — where parsing resumes after an
    error. */
const ITEM_START = new Set([
  "assign",
  "always",
  "initial",
  "reg",
  "wire",
  "integer",
  "localparam",
  "parameter",
]);

/** Item-position keywords that are Verilog but not this subset, by the
    diagnostic they earn. */
const ITEM_REFUSED = {
  module: "headerInBody",
  endmodule: "headerInBody",
  macromodule: "headerInBody",
  input: "portInBody",
  output: "portInBody",
  inout: "portInBody",
  real: "realUnsupported",
  realtime: "realUnsupported",
  time: "realUnsupported",
  genvar: "generateUnsupported",
  generate: "generateUnsupported",
  function: "functionUnsupported",
  task: "functionUnsupported",
  event: "unsupportedConstruct",
  defparam: "unsupportedConstruct",
  specify: "unsupportedConstruct",
  specparam: "unsupportedConstruct",
  primitive: "unsupportedConstruct",
  tri: "netTypeUnsupported",
  tri0: "netTypeUnsupported",
  tri1: "netTypeUnsupported",
  triand: "netTypeUnsupported",
  trior: "netTypeUnsupported",
  trireg: "netTypeUnsupported",
  wand: "netTypeUnsupported",
  wor: "netTypeUnsupported",
  supply0: "netTypeUnsupported",
  supply1: "netTypeUnsupported",
};

/** Gate primitives: an instance of one is a netlist, not behaviour. */
const GATE_PRIMITIVES = new Set([
  "and", "nand", "or", "nor", "xor", "xnor", "not", "buf", "bufif0", "bufif1",
  "notif0", "notif1", "nmos", "pmos", "cmos", "rnmos", "rpmos", "rcmos",
  "tran", "tranif0", "tranif1", "rtran", "rtranif0", "rtranif1", "pullup",
  "pulldown",
]); // prettier-ignore

/** Statement-position keywords that are Verilog but not this subset. */
const STATEMENT_REFUSED = {
  while: "loopUnsupported",
  forever: "loopUnsupported",
  wait: "waitUnsupported",
  fork: "unsupportedStatement",
  disable: "unsupportedStatement",
  force: "unsupportedStatement",
  release: "unsupportedStatement",
  assign: "proceduralAssign",
  deassign: "proceduralAssign",
};

/** Binary operators by precedence level, loosest first (IEEE 1364-2005
    §5.1.2 — every one left-associative, `**` included). */
const BINARY_LEVELS = [
  ["||"],
  ["&&"],
  ["|"],
  ["^", "~^", "^~"],
  ["&"],
  ["==", "!=", "===", "!=="],
  ["<", "<=", ">", ">="],
  ["<<", ">>", "<<<", ">>>"],
  ["+", "-"],
  ["*", "/", "%"],
  ["**"],
];

const UNARY_OPS = new Set(["+", "-", "!", "~", "&", "~&", "|", "~|", "^", "~^", "^~"]); // prettier-ignore

/** Thrown to abandon an item; carries its diagnostic. */
class ParseError extends Error {
  constructor(d) {
    super(d.code);
    this.diag = d;
  }
}

/**
 * Parse a token list (comments included — they are skipped here).
 * @param {object[]} allTokens - lexer.js `tokenize(...).tokens`.
 * @returns {{items: object[], errors: object[]}}
 */
export function parse(allTokens) {
  const tokens = allTokens.filter((t) => t.type !== "comment");
  const errors = [];
  const items = [];
  let pos = 0;

  const peek = (k = 0) => tokens[pos + k] ?? null;
  const atEnd = () => pos >= tokens.length;
  const is = (text, k = 0) => {
    const t = peek(k);
    return t != null && (t.type === "op" || t.type === "keyword") && t.text === text; // prettier-ignore
  };
  const lastEnd = () => tokens[pos - 1] ?? tokens[tokens.length - 1] ?? null;
  const fail = (code, at, args) => {
    throw new ParseError(diag(code, at ?? endSpan(), args));
  };
  const endSpan = () => {
    const t = lastEnd();
    return t
      ? { start: t.end, end: t.end, line: t.line, col: t.col + t.text.length }
      : { start: 0, end: 0, line: 1, col: 1 };
  };
  const next = () => {
    const t = tokens[pos];
    if (!t) fail("unexpectedEnd");
    pos += 1;
    return t;
  };
  const expect = (text) => {
    const t = peek();
    if (!t) fail("expected", null, { what: text });
    if ((t.type === "op" || t.type === "keyword") && t.text === text) {
      pos += 1;
      return t;
    }
    return fail("expectedFound", t, { what: text, found: t.text });
  };
  const span = (from, to = lastEnd()) => ({
    start: from.start,
    end: to?.end ?? from.end,
    line: from.line,
    col: from.col,
  });

  // A token the subset refuses outright wherever it appears.
  const refuseToken = (t) => {
    if (t.type === "system") fail("systemTask", t, { name: t.text });
    if (t.type === "directive") fail("directive", t, { name: t.text });
    if (t.type === "string") fail("stringUnsupported", t);
    if (t.type === "error") fail("unexpected", t, { found: t.text });
  };

  // ── Expressions ────────────────────────────────────────────────────────

  function expression() {
    const cond = binary(0);
    if (is("?")) {
      next();
      const then = expression();
      expect(":");
      const otherwise = expression();
      return { kind: "cond", cond, then, else: otherwise, ...span(cond, lastEnd()) }; // prettier-ignore
    }
    return cond;
  }

  function binary(level) {
    if (level >= BINARY_LEVELS.length) return unary();
    let left = binary(level + 1);
    for (;;) {
      const t = peek();
      if (!t || t.type !== "op" || !BINARY_LEVELS[level].includes(t.text)) {
        return left;
      }
      next();
      const right = binary(level + 1);
      left = { kind: "binary", op: t.text, left, right, ...span(left, lastEnd()) }; // prettier-ignore
    }
  }

  function unary() {
    const t = peek();
    if (t?.type === "op" && UNARY_OPS.has(t.text)) {
      next();
      const arg = unary();
      return { kind: "unary", op: t.text, arg, ...span(t) };
    }
    return primary();
  }

  function primary() {
    const t = peek();
    if (!t) fail("unexpectedEnd");
    refuseToken(t);
    if (t.type === "number") {
      next();
      if (t.signed) fail("signedUnsupported", t);
      return { kind: "num", token: t, ...span(t) };
    }
    if (t.type === "ident") {
      next();
      if (is("(")) fail("functionCall", t, { name: t.text });
      return selectAfter({ kind: "id", name: t.text, ...span(t) });
    }
    if (is("(")) {
      next();
      const inner = expression();
      expect(")");
      return inner;
    }
    if (is("{")) return concatenation();
    if (t.type === "keyword") fail("keywordInExpression", t, { word: t.text });
    return fail("unexpected", t, { found: t.text });
  }

  /** `name[i]`, `name[m:l]` or `name[b +: w]` / `name[b -: w]` after an
      identifier (one select only — an array's word is `name[i]` too). */
  function selectAfter(id) {
    if (!is("[")) return id;
    next();
    const first = expression();
    if (is("+:") || is("-:")) {
      const dir = next().text[0];
      const width = expression();
      expect("]");
      if (is("[")) fail("multiDimensional", peek());
      return { kind: "ipsel", base: id, from: first, width, dir, ...span(id) }; // prettier-ignore
    }
    if (is(":")) {
      next();
      const second = expression();
      expect("]");
      if (is("[")) fail("multiDimensional", peek());
      return { kind: "range", base: id, msb: first, lsb: second, ...span(id) };
    }
    expect("]");
    if (is("[")) fail("multiDimensional", peek());
    return { kind: "index", base: id, index: first, ...span(id) };
  }

  /** `{a, b}` or `{n{a, b}}`. */
  function concatenation() {
    const open = expect("{");
    const first = expression();
    if (is("{")) {
      // Replication: the first expression is the count.
      next();
      const parts = [expression()];
      while (is(",")) {
        next();
        parts.push(expression());
      }
      expect("}");
      expect("}");
      return { kind: "repl", count: first, parts, ...span(open) };
    }
    const parts = [first];
    while (is(",")) {
      next();
      parts.push(expression());
    }
    expect("}");
    return { kind: "concat", parts, ...span(open) };
  }

  /** An assignment target: a name, a select of one, or a concatenation. */
  function lvalue() {
    const t = peek();
    if (!t) fail("unexpectedEnd");
    refuseToken(t);
    if (is("{")) {
      const open = next();
      const parts = [lvalue()];
      while (is(",")) {
        next();
        parts.push(lvalue());
      }
      expect("}");
      return { kind: "concat", parts, ...span(open) };
    }
    if (t.type !== "ident") {
      if (t.type === "keyword") fail("keywordAsName", t, { word: t.text });
      fail("expectedTarget", t, { found: t.text });
    }
    next();
    return selectAfter({ kind: "id", name: t.text, ...span(t) });
  }

  // ── Statements ─────────────────────────────────────────────────────────

  function statement() {
    const t = peek();
    if (!t) fail("unexpectedEnd");
    refuseToken(t);
    if (t.type === "keyword" && STATEMENT_REFUSED[t.text]) {
      fail(STATEMENT_REFUSED[t.text], t, { word: t.text });
    }
    if (is("#")) fail("delayUnsupported", t);
    if (is("@")) fail("eventInStatement", t);
    if (is(";")) {
      next();
      return { kind: "null", ...span(t) };
    }
    if (is("begin")) {
      next();
      let label = null;
      let labelTok = null;
      if (is(":")) {
        next();
        const name = next();
        if (name.type !== "ident") fail("expectedName", name, { found: name.text }); // prettier-ignore
        label = name.text;
        labelTok = name;
      }
      const decls = [];
      const stmts = [];
      while (!is("end")) {
        if (atEnd()) fail("expected", null, { what: "end" });
        const inner = peek();
        if (
          inner.type === "keyword" &&
          (inner.text === "reg" || inner.text === "integer")
        ) {
          // prettier-ignore
          // A NAMED block may declare variables of its own, ahead of its
          // statements (IEEE 1364-2001 §9.8.1); an unnamed one may not.
          // (The keyword is consumed first, so recovery resumes past it
          // rather than reading it as a declaration of the module's own.)
          if (label == null || stmts.length) {
            next();
            fail(label == null ? "declarationInBlock" : "declarationAfterStatement", inner, { word: inner.text }); // prettier-ignore
          }
          decls.push(declaration(true));
          continue;
        }
        if (
          inner.type === "keyword" &&
          ["wire", "localparam", "parameter"].includes(inner.text)
        ) {
          // prettier-ignore
          next();
          fail("declarationAtTop", inner, { word: inner.text });
        }
        stmts.push(statement());
      }
      next();
      return { kind: "block", label, labelAt: labelTok ? span(labelTok) : null, decls, stmts, ...span(t) }; // prettier-ignore
    }
    if (is("for")) {
      next();
      expect("(");
      // `for (integer i = 0; …)` is SystemVerilog: Verilog declares the
      // counter beforehand — in the module, or in a named block.
      const first = peek();
      if (
        (first?.type === "keyword" && ["integer", "reg", "genvar"].includes(first.text)) || // prettier-ignore
        (first?.type === "ident" && peek(1)?.type === "ident")
      ) {
        next();
        fail("loopHeaderDeclaration", first, { word: first.text });
      }
      const initLhs = lvalue();
      expect("=");
      const initRhs = expression();
      expect(";");
      const cond = expression();
      expect(";");
      const stepLhs = lvalue();
      expect("=");
      const stepRhs = expression();
      const close = expect(")");
      const header = span(t, close);
      const body = statement();
      return { kind: "for", initLhs, initRhs, cond, stepLhs, stepRhs, body, header, ...span(t) }; // prettier-ignore
    }
    if (is("repeat")) {
      next();
      expect("(");
      const count = expression();
      const close = expect(")");
      const header = span(t, close);
      const body = statement();
      return { kind: "repeat", count, body, header, ...span(t) };
    }
    if (is("if")) {
      next();
      expect("(");
      const cond = expression();
      expect(")");
      const then = statement();
      let otherwise = null;
      if (is("else")) {
        next();
        otherwise = statement();
      }
      return { kind: "if", cond, then, else: otherwise, ...span(t) };
    }
    if (is("case") || is("casez") || is("casex")) {
      next();
      expect("(");
      const subject = expression();
      expect(")");
      const items = [];
      let fallback = null;
      while (!is("endcase")) {
        if (atEnd()) fail("expected", null, { what: "endcase" });
        if (is("default")) {
          const d = next();
          if (is(":")) next();
          if (fallback) fail("duplicateDefault", d);
          fallback = statement();
          continue;
        }
        const labels = [expression()];
        while (is(",")) {
          next();
          labels.push(expression());
        }
        expect(":");
        const body = statement();
        items.push({ labels, body, ...span(labels[0]) });
      }
      next();
      return { kind: "case", type: t.text, subject, items, default: fallback, ...span(t) }; // prettier-ignore
    }
    if (t.type === "ident" && is("(", 1)) fail("taskCall", t, { name: t.text });
    if (t.type === "ident" || is("{")) {
      const lhs = lvalue();
      const op = peek();
      if (is("=") || is("<=")) {
        next();
        if (is("#")) fail("delayUnsupported", peek());
        if (is("@")) fail("eventInStatement", peek());
        const rhs = expression();
        expect(";");
        return { kind: "assign", blocking: op.text === "=", lhs, rhs, ...span(t) }; // prettier-ignore
      }
      return fail("expectedAssignment", op ?? null, { found: op?.text ?? "" });
    }
    if (t.type === "keyword") fail("keywordAsStatement", t, { word: t.text });
    return fail("unexpected", t, { found: t.text });
  }

  // ── Items ──────────────────────────────────────────────────────────────

  function range() {
    if (!is("[")) return null;
    next();
    const msb = expression();
    expect(":");
    const lsb = expression();
    expect("]");
    return { msb, lsb };
  }

  /**
   * `reg [7:0] a, b = 1;`, `wire w;`, `integer i;`, `reg [7:0] mem [0:255];`
   * — at the top of the body, or (`inBlock`) at the head of a named block,
   * where a variable takes no initialiser (IEEE 1364-2001 §9.8.1).
   */
  function declaration(inBlock) {
    const t = next();
    const net = t.text;
    if (is("signed")) fail("signedUnsupported", peek());
    const r = net === "integer" ? null : range();
    const names = [];
    do {
      if (names.length) next(); // the comma
      const n = peek();
      if (!n) fail("unexpectedEnd");
      if (n.type !== "ident") {
        if (n.type === "keyword") fail("keywordAsName", n, { word: n.text });
        fail("expectedName", n, { found: n.text });
      }
      next();
      // An array (a memory): one dimension, of reg or integer words.
      let dims = null;
      if (is("[")) {
        if (net === "wire") fail("arrayUnsupported", peek());
        const open = next();
        const a = expression();
        expect(":");
        const b = expression();
        expect("]");
        dims = { a, b, ...span(open) };
        if (is("[")) fail("multiDimensional", peek());
      }
      let init = null;
      if (is("=")) {
        if (dims) fail("arrayInitialiser", peek(), { name: n.text });
        if (inBlock) fail("blockInitialiser", peek(), { name: n.text });
        next();
        init = expression();
      }
      names.push({ name: n.text, init, dims, ...span(n) });
    } while (is(","));
    expect(";");
    return { kind: "decl", net, range: r, names, ...span(t) };
  }

  function item() {
    const t = peek();
    refuseToken(t);
    if (is(";")) {
      next();
      return null;
    }
    if (t.type === "keyword" && ITEM_REFUSED[t.text]) {
      fail(ITEM_REFUSED[t.text], t, { word: t.text });
    }
    if (t.type === "keyword" && GATE_PRIMITIVES.has(t.text)) {
      fail("gateUnsupported", t, { word: t.text });
    }
    if (is("reg") || is("wire") || is("integer")) return declaration(false);
    if (is("localparam") || is("parameter")) {
      next();
      if (is("signed")) fail("signedUnsupported", peek());
      // `parameter integer N = 4;` — a 32-bit signed parameter.
      let integer = false;
      if (is("integer")) {
        next();
        integer = true;
      }
      const r = integer ? null : range();
      const assigns = [];
      do {
        if (assigns.length) next();
        const n = peek();
        if (!n) fail("unexpectedEnd");
        if (n.type !== "ident") fail("expectedName", n, { found: n.text });
        next();
        expect("=");
        assigns.push({ name: n.text, value: expression(), ...span(n) });
      } while (is(","));
      expect(";");
      return { kind: "param", range: r, integer, assigns, ...span(t) };
    }
    if (is("assign")) {
      next();
      if (is("#")) fail("delayUnsupported", peek());
      if (is("(")) fail("strengthUnsupported", peek());
      const targets = [];
      do {
        if (targets.length) next();
        const lhs = lvalue();
        expect("=");
        targets.push({ lhs, rhs: expression(), ...span(lhs) });
      } while (is(","));
      expect(";");
      return { kind: "assign", targets, ...span(t) };
    }
    if (is("always")) {
      next();
      if (!is("@")) {
        if (is("#")) fail("delayUnsupported", peek());
        fail("alwaysNeedsEvent", t);
      }
      const sens = eventControl();
      const body = statement();
      return { kind: "always", sens, body, ...span(t) };
    }
    if (is("initial")) {
      next();
      const body = statement();
      return { kind: "initial", body, ...span(t) };
    }
    if (t.type === "ident") {
      // `name name (...)` is a module instance; anything else is a stray.
      if (peek(1)?.type === "ident" || is("#", 1)) {
        fail("instanceUnsupported", t, { name: t.text });
      }
      fail("expectedItem", t, { found: t.text });
    }
    return fail("expectedItem", t, { found: t.text });
  }

  /** `@*`, `@(*)`, or `@( [posedge|negedge] sig {or|, ...} )`. */
  function eventControl() {
    const at = expect("@");
    if (is("*")) {
      next();
      return { star: true, ...span(at) };
    }
    expect("(");
    if (is("*")) {
      next();
      expect(")");
      return { star: true, ...span(at) };
    }
    const list = [];
    for (;;) {
      const e = peek();
      if (!e) fail("unexpectedEnd");
      let edge = null;
      if (is("posedge") || is("negedge")) {
        edge = next().text;
      } else if (is("edge")) {
        fail("edgeUnsupported", e);
      }
      const signal = expression();
      list.push({ edge, signal, ...span(e) });
      if (is(",") || is("or")) {
        next();
        continue;
      }
      break;
    }
    expect(")");
    return { star: false, list, ...span(at) };
  }

  while (!atEnd()) {
    const start = pos;
    try {
      const it = item();
      if (it) items.push(it);
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      errors.push(err.diag);
      // Resume at the next item keyword — never before the token that failed,
      // so a bad item cannot loop.
      pos = Math.max(pos, start + 1);
      while (!atEnd()) {
        const t = peek();
        if (t.type === "keyword" && ITEM_START.has(t.text)) break;
        pos += 1;
      }
    }
  }
  return { items, errors };
}
