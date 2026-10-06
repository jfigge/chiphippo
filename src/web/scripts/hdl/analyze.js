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

// analyze.js — the Verilog subset's elaboration: a parsed body (parser.js)
// and the chip's port list into a COMPILED module — every name resolved to a
// slot, every expression sized by IEEE 1364's rules and turned into a
// closure, every statement into a small tree the interpreter walks — or into
// the diagnostics that say why not.
//
// The checks are the ones a synthesis tool and a careful simulator would
// both make, because the subset promises code that reads as real Verilog:
//
//   · a name is declared before it is used (no implicit nets);
//   · a wire is driven only by `assign`, a reg only by always/initial, an
//     input never, and each signal by ONE always block (a wire's bits may be
//     split across several assigns, never shared);
//   · an output pin driven by an always block is an `output reg` in the
//     generated header, one driven by `assign` an `output wire`;
//   · an `always @(*)` assigns every reg it writes on every path — anything
//     less is a LATCH, refused rather than half-simulated;
//   · no combinational loop, bit by bit (a ripple carry through one vector is
//     fine; `assign a = ~a` is not);
//   · an edge-triggered block is clocked from an INPUT pin, and the module has
//     ONE clock (asynchronous set/reset beside it allowed, read off the
//     block's leading if-chain the way synthesis reads it);
//   · nothing is wider than 32 bits.
//
// Pure: no DOM, no time, no I/O. Diagnostics are `{code, args, …span}`
// records (lexer.js `diag`), worded by the renderer.

import { diag } from "./lexer.js";
import * as V from "./values.js";

const { MAX_WIDTH } = V;

/** Thrown to abandon one construct; carries its diagnostic. */
class Refusal extends Error {
  constructor(d) {
    super(d.code);
    this.diag = d;
  }
}
const refuse = (code, at, args) => {
  throw new Refusal(diag(code, at, args));
};

// ── Number literals ───────────────────────────────────────────────────────

const BITS_PER_DIGIT = { b: 1, o: 3, h: 4 };

/**
 * A number token as a value: `12` (32 bits), `4'b10x1`, `8'hzz`, `'d7`.
 * Throws a Refusal for one the subset cannot hold.
 */
export function literalValue(token) {
  const sized = token.size != null;
  const w = sized ? Number(token.size) : MAX_WIDTH;
  if (sized && (!Number.isInteger(w) || w < 1)) refuse("badSize", token);
  if (w > MAX_WIDTH) refuse("tooWide", token, { width: w, max: MAX_WIDTH });
  const digits = token.digits.replace(/_/g, "");
  if (!digits) refuse("badNumber", token);
  if (token.base === "d") {
    if (/^[xXzZ?]$/.test(digits)) {
      return /[xX]/.test(digits) ? V.allX(w) : V.allZ(w);
    }
    if (!/^[0-9]+$/.test(digits)) refuse("badDigit", token, { base: "decimal" }); // prettier-ignore
    const n = Number(digits);
    if (n > 0xffffffff) refuse("numberTooBig", token);
    return V.known(w, n % 2 ** w);
  }
  const per = BITS_PER_DIGIT[token.base];
  const valid = { b: /^[01xXzZ?]+$/, o: /^[0-7xXzZ?]+$/, h: /^[0-9a-fA-FxXzZ?]+$/ }[token.base]; // prettier-ignore
  if (!valid.test(digits)) {
    refuse("badDigit", token, { base: { b: "binary", o: "octal", h: "hex" }[token.base] }); // prettier-ignore
  }
  let v = 0;
  let x = 0;
  let z = 0;
  let pos = 0;
  for (let k = digits.length - 1; k >= 0 && pos < MAX_WIDTH; k--) {
    const ch = digits[k];
    const full = 2 ** per - 1;
    const place = 2 ** pos;
    if (/[xX]/.test(ch)) x += full * place;
    else if (/[zZ?]/.test(ch)) {
      x += full * place;
      z += full * place;
    } else v += parseInt(ch, 16) * place;
    pos += per;
  }
  // A leftmost x or z digit pads the rest of the width with itself.
  const lead = digits[0];
  if (pos < w && /[xXzZ?]/.test(lead)) {
    const pad = (V.mask(w) - V.mask(Math.min(pos, w))) >>> 0;
    x = (x | pad) >>> 0;
    if (/[zZ?]/.test(lead)) z = (z | pad) >>> 0;
  }
  const clip = (n) => n % 2 ** 32;
  return V.make(w, clip(v), clip(x), clip(z));
}

// ── Sizing (IEEE 1364-2005 §5.4) ──────────────────────────────────────────

const ARITH_BITWISE = new Set(["+", "-", "*", "/", "%", "&", "|", "^", "~^", "^~"]); // prettier-ignore
const COMPARISON = new Set(["==", "!=", "===", "!==", "<", "<=", ">", ">="]);
const LOGICAL = new Set(["&&", "||"]);
const SHIFT = new Set(["<<", ">>", "<<<", ">>>"]);
const REDUCTION = new Set(["&", "~&", "|", "~|", "^", "~^", "^~"]);

/**
 * Compile a module body.
 *
 * @param {{items: object[]}} ast - parser.js output.
 * @param {Array<{name: string, dir: "input"|"output", width: number}>} ports
 * @returns {{errors: object[], warnings: object[], module: object|null}}
 */
export function analyze(ast, ports) {
  const errors = [];
  const warnings = [];
  const attempt = (fn) => {
    try {
      return fn();
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      errors.push(err.diag);
      return null;
    }
  };

  // ── Symbols ────────────────────────────────────────────────────────────
  const symbols = new Map(); // name → symbol
  const slots = []; // slot → symbol
  const addSignal = (sym) => {
    sym.slot = slots.length;
    slots.push(sym);
    symbols.set(sym.name, sym);
    return sym;
  };
  for (const p of ports ?? []) {
    const w = Math.max(1, Math.min(MAX_WIDTH, p.width ?? 1));
    addSignal({
      name: p.name,
      kind: p.dir === "output" ? "output" : "input",
      w,
      msb: w - 1,
      lsb: 0,
      port: true,
      decl: null,
    });
  }

  // Parameters first (in order — each may use the ones before it), then the
  // nets, so a range may name a parameter wherever it is declared.
  for (const it of ast.items) {
    if (it.kind !== "param") continue;
    for (const a of it.assigns) {
      attempt(() => {
        if (symbols.has(a.name)) refuse("redeclared", a, { name: a.name });
        let value = constValue(a.value);
        if (it.range) {
          const { w } = rangeOf(it.range, a);
          value = V.resize(value, w);
        }
        symbols.set(a.name, { name: a.name, kind: "param", value, w: value.w, decl: a }); // prettier-ignore
      });
    }
  }
  const initialisers = []; // {sym, expr, at}
  const netAssigns = []; // `wire w = expr;` → a continuous assign
  for (const it of ast.items) {
    if (it.kind !== "decl") continue;
    attempt(() => {
      const r = it.range ? rangeOf(it.range, it) : { w: 1, msb: 0, lsb: 0 };
      for (const n of it.names) {
        attempt(() => {
          const existing = symbols.get(n.name);
          if (existing?.port) {
            refuse(existing.kind === "output" ? "outputRedeclared" : "inputRedeclared", n, { name: n.name }); // prettier-ignore
          }
          if (existing) refuse("redeclared", n, { name: n.name });
          const sym = addSignal({
            name: n.name,
            kind: it.net,
            w: r.w,
            msb: r.msb,
            lsb: r.lsb,
            port: false,
            decl: n,
          });
          if (n.init) {
            if (it.net === "wire")
              netAssigns.push({ lhs: { kind: "id", name: n.name, ...spanOf(n) }, rhs: n.init, ...spanOf(n) }); // prettier-ignore
            else initialisers.push({ sym, expr: n.init, at: n });
          }
        });
      }
    });
  }

  /** `[msb:lsb]` → `{w, msb, lsb}` (constant, at most 32 bits wide). */
  function rangeOf(range, at) {
    const msb = constInt(range.msb);
    const lsb = constInt(range.lsb);
    const w = Math.abs(msb - lsb) + 1;
    if (w > MAX_WIDTH) refuse("tooWide", at, { width: w, max: MAX_WIDTH });
    return { w, msb, lsb };
  }

  /** A constant expression's value (literals and parameters only). */
  function constValue(expr) {
    const node = compileExpr(expr, null, { constant: true });
    return node.fn([]);
  }
  function constInt(expr) {
    const v = constValue(expr);
    if (v.x) refuse("unknownConstant", expr);
    return v.v;
  }

  // ── Expressions ────────────────────────────────────────────────────────

  /** A name read in an expression. */
  function lookup(id, opts) {
    const sym = symbols.get(id.name);
    if (!sym) refuse("undeclared", id, { name: id.name });
    if (opts?.constant && sym.kind !== "param") {
      refuse("notConstant", id, { name: id.name });
    }
    return sym;
  }

  /** A declared bit index → its position from bit 0, or null when out of
      range. */
  const bitPosition = (sym, index) => {
    const pos = sym.msb >= sym.lsb ? index - sym.lsb : sym.lsb - index;
    return pos >= 0 && pos < sym.w ? pos : null;
  };

  /**
   * The self-determined width of an expression (§5.4.1, Table 5-22), and
   * every name it reads. Memoised on the node.
   */
  function selfWidth(e, opts) {
    if (e._sw != null) return e._sw;
    let w;
    switch (e.kind) {
      case "num":
        w = literalValue(e.token).w;
        break;
      case "id": {
        const sym = lookup(e, opts);
        w = sym.w;
        break;
      }
      case "index":
        lookup(e.base, opts);
        selfWidth(e.index, opts);
        w = 1;
        break;
      case "range": {
        const sym = lookup(e.base, opts);
        if (sym.kind === "param") refuse("selectOfParameter", e);
        const m = constInt(e.msb);
        const l = constInt(e.lsb);
        const pm = bitPosition(sym, m);
        const pl = bitPosition(sym, l);
        if (pm == null || pl == null) {
          refuse("selectOutOfRange", e, { name: sym.name, msb: sym.msb, lsb: sym.lsb }); // prettier-ignore
        }
        if (pm < pl) refuse("reversedSelect", e, { name: sym.name });
        w = pm - pl + 1;
        e._lo = pl;
        break;
      }
      case "concat": {
        w = 0;
        for (const p of e.parts) {
          if (p.kind === "num" && p.token.size == null) refuse("unsizedInConcat", p); // prettier-ignore
          w += selfWidth(p, opts);
        }
        break;
      }
      case "repl": {
        const n = constInt(e.count);
        if (n < 1) refuse("badReplication", e.count);
        let inner = 0;
        for (const p of e.parts) {
          if (p.kind === "num" && p.token.size == null) refuse("unsizedInConcat", p); // prettier-ignore
          inner += selfWidth(p, opts);
        }
        w = n * inner;
        e._count = n;
        break;
      }
      case "unary":
        selfWidth(e.arg, opts);
        w = ["+", "-", "~"].includes(e.op) ? e.arg._sw : 1;
        break;
      case "binary": {
        const l = selfWidth(e.left, opts);
        const r = selfWidth(e.right, opts);
        if (ARITH_BITWISE.has(e.op)) w = Math.max(l, r);
        else if (SHIFT.has(e.op)) w = l;
        else w = 1; // comparisons and logical operators
        break;
      }
      case "cond":
        selfWidth(e.cond, opts);
        w = Math.max(selfWidth(e.then, opts), selfWidth(e.else, opts));
        break;
      default:
        refuse("unexpected", e, { found: e.kind });
    }
    if (w > MAX_WIDTH) refuse("tooWide", e, { width: w, max: MAX_WIDTH });
    e._sw = w;
    return w;
  }

  /**
   * Compile an expression evaluated at width `ctx` (null: self-determined)
   * into `{w, fn, reads}` — `fn(vals)` a closure returning a value of width
   * `w`, `reads` the `{slot, mask}` bits it reads (a variable index reads the
   * whole vector).
   */
  function compileExpr(e, ctx, opts) {
    const sw = selfWidth(e, opts);
    const w = ctx == null ? sw : Math.max(sw, ctx);
    const reads = [];
    const fn = build(e, w, reads, opts);
    return { w, fn, reads };
  }

  /** The closure for `e` evaluated at width `w` (already ≥ its own). */
  function build(e, w, reads, opts) {
    switch (e.kind) {
      case "num": {
        const value = V.resize(literalValue(e.token), w);
        return () => value;
      }
      case "id": {
        const sym = lookup(e, opts);
        if (sym.kind === "param") {
          const value = V.resize(sym.value, w);
          return () => value;
        }
        reads.push({ slot: sym.slot, mask: V.mask(sym.w) });
        const slot = sym.slot;
        return sym.w === w ? (vals) => vals[slot] : (vals) => V.resize(vals[slot], w); // prettier-ignore
      }
      case "index": {
        const sym = lookup(e.base, opts);
        const idx = compileExpr(e.index, null, opts);
        reads.push(...idx.reads);
        // A constant index is checked here and reads one bit; a variable one
        // reads the whole vector (any bit of it may be the one).
        if (!idx.reads.length) {
          const index = idx.fn([]);
          if (index.x) refuse("unknownConstant", e.index);
          if (sym.kind === "param") {
            const pos = index.v < sym.w ? index.v : null;
            const value = V.resize(pos == null ? V.allX(1) : V.bit(sym.value, pos), w); // prettier-ignore
            return () => value;
          }
          const pos = bitPosition(sym, index.v);
          if (pos == null) {
            refuse("selectOutOfRange", e, { name: sym.name, msb: sym.msb, lsb: sym.lsb }); // prettier-ignore
          }
          reads.push({ slot: sym.slot, mask: 2 ** pos });
          const slot = sym.slot;
          return (vals) => V.resize(V.bit(vals[slot], pos), w);
        }
        if (sym.kind === "param") {
          const value = sym.value;
          return (vals) => {
            const i = idx.fn(vals);
            return V.resize(i.x || i.v >= value.w ? V.allX(1) : V.bit(value, i.v), w); // prettier-ignore
          };
        }
        reads.push({ slot: sym.slot, mask: V.mask(sym.w) });
        const slot = sym.slot;
        return (vals) => {
          const i = idx.fn(vals);
          const pos = i.x ? null : bitPosition(sym, i.v);
          return V.resize(pos == null ? V.allX(1) : V.bit(vals[slot], pos), w);
        };
      }
      case "range": {
        const sym = lookup(e.base, opts);
        const lo = e._lo;
        const width = e._sw;
        reads.push({
          slot: sym.slot,
          mask: (V.mask(width) * 2 ** lo) % 2 ** 32,
        });
        const slot = sym.slot;
        return (vals) => V.resize(V.slice(vals[slot], lo, width), w);
      }
      case "concat":
      case "repl": {
        const parts = e.parts.map((p) => compileExpr(p, null, opts));
        for (const p of parts) reads.push(...p.reads);
        const count = e.kind === "repl" ? e._count : 1;
        return (vals) => {
          const values = parts.map((p) => p.fn(vals));
          const all = [];
          for (let k = 0; k < count; k++) all.push(...values);
          return V.resize(V.concat(all), w);
        };
      }
      case "unary": {
        if (["+", "-", "~"].includes(e.op)) {
          const arg = build(e.arg, w, reads, opts);
          if (e.op === "+") return arg;
          if (e.op === "-") return (vals) => V.negate(arg(vals));
          return (vals) => V.not(arg(vals));
        }
        // Reductions and `!`: a self-determined operand, a 1-bit result.
        const arg = compileExpr(e.arg, null, opts);
        reads.push(...arg.reads);
        const op = {
          "!": V.logicalNot,
          "&": V.reduceAnd,
          "~&": (a) => V.not(V.reduceAnd(a)),
          "|": V.reduceOr,
          "~|": (a) => V.not(V.reduceOr(a)),
          "^": V.reduceXor,
          "~^": (a) => V.not(V.reduceXor(a)),
          "^~": (a) => V.not(V.reduceXor(a)),
        }[e.op];
        if (!REDUCTION.has(e.op) && e.op !== "!") refuse("unexpected", e, { found: e.op }); // prettier-ignore
        return (vals) => V.resize(op(arg.fn(vals)), w);
      }
      case "binary": {
        if (ARITH_BITWISE.has(e.op)) {
          const l = build(e.left, w, reads, opts);
          const r = build(e.right, w, reads, opts);
          const op = {
            "+": V.add,
            "-": V.sub,
            "*": V.mul,
            "/": V.div,
            "%": V.mod,
            "&": V.and,
            "|": V.or,
            "^": V.xor,
            "~^": V.xnor,
            "^~": V.xnor,
          }[e.op];
          return (vals) => op(l(vals), r(vals));
        }
        if (COMPARISON.has(e.op)) {
          const inner = Math.max(e.left._sw, e.right._sw);
          const l = build(e.left, inner, reads, opts);
          const r = build(e.right, inner, reads, opts);
          const op = {
            "==": V.eq,
            "!=": V.ne,
            "===": V.caseEq,
            "!==": V.caseNe,
            "<": V.lt,
            "<=": V.le,
            ">": V.gt,
            ">=": V.ge,
          }[e.op];
          return (vals) => V.resize(op(l(vals), r(vals)), w);
        }
        if (LOGICAL.has(e.op)) {
          const l = compileExpr(e.left, null, opts);
          const r = compileExpr(e.right, null, opts);
          reads.push(...l.reads, ...r.reads);
          const op = e.op === "&&" ? V.logicalAnd : V.logicalOr;
          return (vals) => V.resize(op(l.fn(vals), r.fn(vals)), w);
        }
        if (SHIFT.has(e.op)) {
          const l = build(e.left, w, reads, opts);
          const r = compileExpr(e.right, null, opts);
          reads.push(...r.reads);
          const op = e.op === "<<" || e.op === "<<<" ? V.shl : V.shr;
          return (vals) => op(l(vals), r.fn(vals));
        }
        return refuse("unexpected", e, { found: e.op });
      }
      case "cond": {
        const c = compileExpr(e.cond, null, opts);
        reads.push(...c.reads);
        const a = build(e.then, w, reads, opts);
        const b = build(e.else, w, reads, opts);
        return (vals) => {
          const t = V.truthOf(c.fn(vals));
          if (t === "1") return a(vals);
          if (t === "0") return b(vals);
          return V.choose(V.allX(1), a(vals), b(vals));
        };
      }
      default:
        return refuse("unexpected", e, { found: e.kind });
    }
  }

  // ── Assignment targets ─────────────────────────────────────────────────

  /**
   * Compile an lvalue: `{w, segments(vals), parts}` — `segments` the
   * `{slot, lo, w}` runs it writes this time, most significant first (a
   * variable index with an unknown or out-of-range value writes nothing, as
   * Verilog's does); `parts` the static `{sym, mask}` view the driver checks
   * use (a variable index claims the whole vector).
   */
  function compileTarget(lv) {
    if (lv.kind === "concat") {
      const parts = lv.parts.map(compileTarget);
      const w = parts.reduce((s, p) => s + p.w, 0);
      if (w > MAX_WIDTH) refuse("tooWide", lv, { width: w, max: MAX_WIDTH });
      return {
        w,
        parts: parts.flatMap((p) => p.parts),
        // A part writing nothing (an unknown index) still takes its width
        // out of the value: `resolve` answers a `slot: -1` segment for it.
        resolve: (vals) => parts.flatMap((p) => p.resolve(vals)),
        indexReads: parts.flatMap((p) => p.indexReads ?? []),
      };
    }
    const id = lv.kind === "id" ? lv : lv.base;
    const sym = symbols.get(id.name);
    if (!sym) refuse("undeclared", id, { name: id.name });
    if (sym.kind === "param")
      refuse("assignToParameter", id, { name: id.name });
    if (sym.kind === "input") refuse("assignToInput", id, { name: id.name });
    const slot = sym.slot;
    if (lv.kind === "id") {
      const seg = { slot, lo: 0, w: sym.w };
      return {
        w: sym.w,
        parts: [{ sym, mask: V.mask(sym.w), at: lv }],
        resolve: () => [seg],
      };
    }
    if (lv.kind === "range") {
      selfWidth(lv);
      const seg = { slot, lo: lv._lo, w: lv._sw };
      return {
        w: lv._sw,
        parts: [
          { sym, mask: (V.mask(lv._sw) * 2 ** lv._lo) % 2 ** 32, at: lv },
        ],
        resolve: () => [seg],
      };
    }
    // A bit select, constant or variable.
    const idx = compileExpr(lv.index, null);
    if (!idx.reads.length) {
      const index = idx.fn([]);
      if (index.x) refuse("unknownConstant", lv.index);
      const pos = bitPosition(sym, index.v);
      if (pos == null) {
        refuse("selectOutOfRange", lv, { name: sym.name, msb: sym.msb, lsb: sym.lsb }); // prettier-ignore
      }
      const seg = { slot, lo: pos, w: 1 };
      return {
        w: 1,
        parts: [{ sym, mask: 2 ** pos, at: lv }],
        resolve: () => [seg],
      };
    }
    return {
      w: 1,
      parts: [{ sym, mask: V.mask(sym.w), at: lv, variable: true }],
      indexReads: idx.reads,
      resolve: (vals) => {
        const i = idx.fn(vals);
        const pos = i.x ? null : bitPosition(sym, i.v);
        return [
          pos == null ? { slot: -1, lo: 0, w: 1 } : { slot, lo: pos, w: 1 },
        ];
      },
    };
  }

  // ── Statements ─────────────────────────────────────────────────────────

  /**
   * Compile a statement. `ctx` carries what the enclosing block allows and
   * collects: `procedural` writes, the reads (for sensitivity), and the
   * block's own bookkeeping.
   */
  function compileStmt(s, ctx) {
    switch (s.kind) {
      case "null":
        return { kind: "null", loc: locOf(s) };
      case "block":
        return {
          kind: "block",
          stmts: s.stmts.map((x) => compileStmt(x, ctx)),
          loc: locOf(s),
        };
      case "if": {
        const cond = compileExpr(s.cond, null);
        ctx.reads.push(...cond.reads);
        return {
          kind: "if",
          cond: cond.fn,
          condReads: cond.reads,
          then: compileStmt(s.then, ctx),
          else: s.else ? compileStmt(s.else, ctx) : null,
          loc: locOf(s, s.cond),
        };
      }
      case "case": {
        // Every expression of a case is sized to the widest of them (§9.5).
        let w = selfWidth(s.subject);
        for (const item of s.items) {
          for (const label of item.labels) w = Math.max(w, selfWidth(label));
        }
        const subject = compileExpr(s.subject, w);
        ctx.reads.push(...subject.reads);
        const items = s.items.map((item) => {
          const labels = item.labels.map((label) => {
            const c = compileExpr(label, w);
            ctx.reads.push(...c.reads);
            return c;
          });
          return {
            labels: labels.map((c) => c.fn),
            labelReads: labels.flatMap((c) => c.reads),
            body: compileStmt(item.body, ctx),
            loc: locOf(item),
          };
        });
        return {
          kind: "case",
          mode: s.type,
          subject: subject.fn,
          subjectReads: subject.reads,
          items,
          default: s.default ? compileStmt(s.default, ctx) : null,
          width: w,
          loc: locOf(s, s.subject),
        };
      }
      case "assign": {
        if (!ctx.procedural) refuse("unexpected", s, { found: "=" });
        const target = compileTarget(s.lhs);
        for (const p of target.parts) ctx.writeTarget(p, s);
        const value = compileExpr(s.rhs, target.w);
        ctx.reads.push(...value.reads, ...(target.indexReads ?? []));
        return {
          kind: "assign",
          blocking: s.blocking,
          target,
          value: value.fn,
          valueReads: value.reads,
          w: target.w,
          loc: locOf(s),
        };
      }
      default:
        return refuse("unexpected", s, { found: s.kind });
    }
  }

  // ── Drivers ────────────────────────────────────────────────────────────
  // Per signal: who drives it. `assign` drivers are per bit (a wire may be
  // assembled from several assigns); a procedural driver is one block.
  const assignBits = new Map(); // slot → mask driven by continuous assigns
  const blockOf = new Map(); // slot → index of the one always block driving it
  const initialOnly = new Set(); // slots written by initial blocks/initialisers

  function claimAssign(part, at) {
    const { sym, mask } = part;
    if (sym.kind === "reg") refuse("assignToReg", part.at ?? at, { name: sym.name }); // prettier-ignore
    if (blockOf.has(sym.slot)) refuse("mixedDrivers", part.at ?? at, { name: sym.name }); // prettier-ignore
    const had = assignBits.get(sym.slot) ?? 0;
    if ((had & mask) >>> 0) refuse("multipleDrivers", part.at ?? at, { name: sym.name }); // prettier-ignore
    assignBits.set(sym.slot, (had | mask) >>> 0);
  }

  function claimProcedural(part, at, blockIndex) {
    const { sym } = part;
    if (sym.kind === "wire") refuse("proceduralToWire", part.at ?? at, { name: sym.name }); // prettier-ignore
    if (assignBits.has(sym.slot)) refuse("mixedDrivers", part.at ?? at, { name: sym.name }); // prettier-ignore
    const owner = blockOf.get(sym.slot);
    if (owner != null && owner !== blockIndex) {
      refuse("multipleAlwaysDrivers", part.at ?? at, { name: sym.name });
    }
    blockOf.set(sym.slot, blockIndex);
  }

  // ── Items ──────────────────────────────────────────────────────────────

  const comb = []; // assigns and always @(*) — pure functions of their reads
  const edge = []; // edge-triggered always blocks
  const initial = []; // initialisers and initial blocks, in source order
  let alwaysIndex = 0;

  const contAssigns = [
    ...netAssigns.map((t) => ({ targets: [t], at: t, net: true })),
  ];
  for (const it of ast.items) {
    if (it.kind === "assign") contAssigns.push({ targets: it.targets, at: it });
  }
  for (const { targets } of contAssigns) {
    for (const t of targets) {
      attempt(() => {
        const target = compileTarget(t.lhs);
        for (const p of target.parts) claimAssign(p, t);
        const value = compileExpr(t.rhs, target.w);
        const stmt = {
          kind: "assign",
          blocking: true,
          target,
          value: value.fn,
          valueReads: value.reads,
          w: target.w,
          loc: locOf(t),
        };
        comb.push({
          kind: "assign",
          body: stmt,
          reads: [...value.reads, ...(target.indexReads ?? [])],
          writes: target.parts.map((p) => ({ slot: p.sym.slot, mask: p.mask })),
          loc: locOf(t),
        });
      });
    }
  }

  for (const it of ast.items) {
    if (it.kind === "always") {
      const index = alwaysIndex++;
      attempt(() => compileAlways(it, index));
    } else if (it.kind === "initial") {
      attempt(() => {
        const ctx = procedural((part, at) => {
          if (part.sym.kind === "wire") refuse("proceduralToWire", part.at ?? at, { name: part.sym.name }); // prettier-ignore
          if (assignBits.has(part.sym.slot)) refuse("mixedDrivers", part.at ?? at, { name: part.sym.name }); // prettier-ignore
          initialOnly.add(part.sym.slot);
        });
        const body = compileStmt(it.body, ctx);
        initial.push({ kind: "initial", body, loc: locOf(it) });
      });
    }
  }
  // Declaration initialisers run first, in declaration order, then the
  // initial blocks in source order.
  const inits = [];
  for (const { sym, expr, at } of initialisers) {
    attempt(() => {
      const value = compileExpr(expr, sym.w);
      initialOnly.add(sym.slot);
      inits.push({
        kind: "init",
        body: {
          kind: "assign",
          blocking: true,
          target: {
            w: sym.w,
            parts: [{ sym, mask: V.mask(sym.w) }],
            resolve: () => [{ slot: sym.slot, lo: 0, w: sym.w }],
          },
          value: value.fn,
          valueReads: value.reads,
          w: sym.w,
          loc: locOf(at),
        },
        loc: locOf(at),
      });
    });
  }
  initial.unshift(...inits);

  function procedural(onWrite) {
    return {
      procedural: true,
      reads: [],
      writes: [],
      writeTarget(part, at) {
        onWrite(part, at);
        this.writes.push({ slot: part.sym.slot, mask: part.mask });
      },
    };
  }

  function compileAlways(it, index) {
    const sens = it.sens;
    const edges = sens.star ? [] : sens.list.filter((e) => e.edge);
    const levels = sens.star ? [] : sens.list.filter((e) => !e.edge);
    if (edges.length && levels.length) refuse("mixedSensitivity", it.sens);
    const ctx = procedural((part, at) => claimProcedural(part, at, index));
    const body = compileStmt(it.body, ctx);
    if (edges.length) {
      const events = edges.map((e) => edgeEvent(e));
      edge.push({
        kind: "edge",
        body,
        events,
        clock: clockOf(events, it.body),
        writes: ctx.writes,
        loc: locOf(it, it.sens),
        index,
      });
      return;
    }
    // A combinational block: what it reads from OUTSIDE itself (a reg it has
    // already assigned on this path is its own) is its sensitivity.
    const flow = definiteFlow(it.body);
    const writes = ctx.writes;
    for (const w of writes) {
      const sym = slots[w.slot];
      const assigned = flow.assigned.get(w.slot) ?? 0;
      const needed = blockMask(writes, w.slot);
      if ((needed & ~assigned) >>> 0 !== 0) {
        refuse("latch", it, { name: sym.name });
      }
    }
    if (!sens.star) {
      // An explicit level list must name everything the block reads.
      const listed = new Set();
      for (const e of levels) {
        if (e.signal.kind !== "id") refuse("sensitivityNotName", e);
        const sym = lookup(e.signal);
        listed.add(sym.slot);
      }
      const missing = [...new Set(flow.reads.map((r) => r.slot))]
        .filter((s) => !listed.has(s))
        .map((s) => slots[s].name);
      if (missing.length) {
        refuse("incompleteSensitivity", it.sens, { names: missing.join(", ") });
      }
    }
    comb.push({
      kind: "always",
      body,
      reads: flow.reads,
      writes,
      loc: locOf(it, it.sens),
      index,
    });
  }

  /** The mask of `slot`'s bits a block's writes cover. */
  function blockMask(writes, slot) {
    let m = 0;
    for (const w of writes) if (w.slot === slot) m = (m | w.mask) >>> 0;
    return m;
  }

  /** `posedge CLK` / `negedge CTRL[2]` → `{edge, slot, pos, name}`. Only an
      input pin (or one bit of a vector input) can clock a block. */
  function edgeEvent(e) {
    const sig = e.signal;
    const id = sig.kind === "id" ? sig : sig.kind === "index" ? sig.base : null;
    if (!id) refuse("edgeNotInput", e);
    const sym = lookup(id);
    if (sym.kind !== "input") refuse("edgeNotInput", e, { name: sym.name });
    let pos = 0;
    if (sig.kind === "index") {
      const idx = compileExpr(sig.index, null);
      if (idx.reads.length)
        refuse("notConstant", sig.index, { name: sym.name });
      const index = idx.fn([]);
      pos = index.x ? null : bitPosition(sym, index.v);
      if (pos == null) refuse("selectOutOfRange", sig, { name: sym.name, msb: sym.msb, lsb: sym.lsb }); // prettier-ignore
    } else if (sym.w > 1) {
      refuse("edgeNeedsBit", e, { name: sym.name });
    }
    const name = sig.kind === "index" ? `${sym.name}[${sig.index.token?.digits ?? pos}]` : sym.name; // prettier-ignore
    return { edge: e.edge, slot: sym.slot, pos, name, at: locOf(e) };
  }

  /**
   * Which of a block's edge events is its CLOCK: the only one, or — beside
   * asynchronous controls — the one its leading if / else-if chain does not
   * test (`if (!RST_N) … else …` makes RST_N a reset, not a clock), the way
   * synthesis reads it.
   */
  function clockOf(events, body) {
    if (events.length === 1) return events[0];
    const tested = new Set();
    let s = body;
    for (;;) {
      while (s?.kind === "block" && s.stmts.length === 1) s = s.stmts[0];
      if (s?.kind !== "if") break;
      for (const r of compileExpr(s.cond, null).reads) tested.add(r.slot);
      s = s.else;
    }
    const clocks = events.filter((e) => !tested.has(e.slot));
    if (clocks.length !== 1) refuse("clockAmbiguous", events[0].at);
    return clocks[0];
  }

  /**
   * Definite assignment through a combinational block: which bits of each
   * reg are assigned on EVERY path (`assigned`), and what the block reads
   * that it has not itself assigned first on that path (`reads`) — its
   * true inputs.
   */
  function definiteFlow(stmt) {
    const reads = [];
    const readOutside = (rs, assigned) => {
      for (const r of rs) {
        const own = assigned.get(r.slot) ?? 0;
        const outside = (r.mask & ~own) >>> 0;
        if (outside) reads.push({ slot: r.slot, mask: outside });
      }
    };
    const merge = (a, b) => {
      const out = new Map();
      for (const [slot, m] of a) {
        const n = b.get(slot);
        if (n != null && m & n) out.set(slot, (m & n) >>> 0);
      }
      return out;
    };
    const walk = (s, assigned) => {
      switch (s.kind) {
        case "null":
          return assigned;
        case "block": {
          let cur = assigned;
          for (const x of s.stmts) cur = walk(x, cur);
          return cur;
        }
        case "if": {
          readOutside(compileExpr(s.cond, null).reads, assigned);
          const a = walk(s.then, new Map(assigned));
          const b = s.else ? walk(s.else, new Map(assigned)) : assigned;
          return merge(a, b);
        }
        case "case": {
          let w = selfWidth(s.subject);
          for (const item of s.items) {
            for (const l of item.labels) w = Math.max(w, selfWidth(l));
          }
          readOutside(compileExpr(s.subject, w).reads, assigned);
          for (const item of s.items) {
            for (const l of item.labels)
              readOutside(compileExpr(l, w).reads, assigned);
          }
          const branches = s.items.map((item) =>
            walk(item.body, new Map(assigned)),
          );
          if (s.default) branches.push(walk(s.default, new Map(assigned)));
          else if (!caseIsFull(s, w)) branches.push(assigned);
          return branches.reduce((acc, b) => merge(acc, b));
        }
        case "assign": {
          const target = compileTarget(s.lhs);
          const value = compileExpr(s.rhs, target.w);
          readOutside([...value.reads, ...(target.indexReads ?? [])], assigned);
          const next = new Map(assigned);
          for (const p of target.parts) {
            if (p.variable) continue; // which bit it writes is not known
            next.set(p.sym.slot, ((next.get(p.sym.slot) ?? 0) | p.mask) >>> 0);
          }
          return next;
        }
        default:
          return assigned;
      }
    };
    const assigned = walk(stmt, new Map());
    return { assigned, reads };
  }

  /** Does a case without a default still cover every value of its subject?
      (A plain `case` over a narrow subject with every constant listed.) */
  function caseIsFull(s, w) {
    if (s.type !== "case" || w > 8) return false;
    const seen = new Set();
    for (const item of s.items) {
      for (const l of item.labels) {
        const c = compileExpr(l, w);
        if (c.reads.length) return false;
        const v = c.fn([]);
        if (v.x) continue;
        seen.add(v.v);
      }
    }
    return seen.size === 2 ** w;
  }

  // ── Whole-module checks ────────────────────────────────────────────────

  // One clock for the module.
  const clocks = new Map();
  for (const b of edge) {
    const key = `${b.clock.slot}:${b.clock.pos}`;
    if (!clocks.has(key)) clocks.set(key, b.clock);
  }
  if (clocks.size > 1) {
    const [first, second] = [...clocks.values()];
    errors.push(
      diag("multipleClocks", second.at, { first: first.name, second: second.name }), // prettier-ignore
    );
  }

  // Outputs: which kind each is, and whether anything drives it.
  const outputKind = new Map();
  for (const sym of slots) {
    if (sym.kind !== "output") continue;
    if (blockOf.has(sym.slot) || initialOnly.has(sym.slot)) {
      outputKind.set(sym.name, "reg");
    } else {
      outputKind.set(sym.name, "wire");
      const driven = assignBits.get(sym.slot) ?? 0;
      if (driven !== V.mask(sym.w) >>> 0) {
        warnings.push(diag("outputUndriven", headerSpan(), { name: sym.name }, "warning")); // prettier-ignore
      }
    }
  }

  // Declared signals nobody drives.
  for (const sym of slots) {
    if (sym.port || !sym.decl) continue;
    if (sym.kind === "wire" && !assignBits.has(sym.slot)) {
      warnings.push(diag("wireUndriven", sym.decl, { name: sym.name }, "warning")); // prettier-ignore
    }
    if (
      sym.kind === "reg" &&
      !blockOf.has(sym.slot) &&
      !initialOnly.has(sym.slot)
    ) {
      // prettier-ignore
      warnings.push(diag("regUnassigned", sym.decl, { name: sym.name }, "warning")); // prettier-ignore
    }
  }

  // What each slot IS at run time: STATE persists between evaluations (an
  // edge-driven reg, or one only ever set by `initial`); everything else is
  // COMBINATIONAL, recomputed from the inputs and the state every time.
  const edgeSlots = new Set();
  for (const b of edge) for (const w of b.writes) edgeSlots.add(w.slot);
  const combSlots = new Set();
  for (const b of comb) for (const w of b.writes) combSlots.add(w.slot);
  const state = [];
  for (const sym of slots) {
    if (sym.kind !== "reg" && !(sym.kind === "output" && outputKind.get(sym.name) === "reg")) continue; // prettier-ignore
    if (combSlots.has(sym.slot)) continue;
    state.push(sym.slot);
  }

  // A combinational loop, bit by bit.
  if (!errors.length) {
    const loop = combLoop(comb, combSlots);
    if (loop) {
      const names = [];
      for (const { slot, bit } of loop.cycle) {
        const sym = slots[slot];
        const name = sym.w > 1 ? `${sym.name}[${sym.msb >= sym.lsb ? sym.lsb + bit : sym.lsb - bit}]` : sym.name; // prettier-ignore
        if (names[names.length - 1] !== name) names.push(name);
      }
      names.push(names[0]);
      errors.push(diag("combLoop", loop.at, { names: names.join(" → ") }));
    }
  }

  if (errors.length) return { errors, warnings, module: null };
  return {
    errors,
    warnings,
    module: {
      slots: slots.map((s) => ({
        name: s.name,
        kind: s.kind,
        w: s.w,
        msb: s.msb,
        lsb: s.lsb,
        port: s.port,
      })),
      ports: slots.filter((s) => s.port).map((s) => ({ name: s.name, dir: s.kind, w: s.w, slot: s.slot })), // prettier-ignore
      params: [...symbols.values()]
        .filter((s) => s.kind === "param")
        .map((s) => ({ name: s.name, value: s.value })),
      outputKind,
      comb: orderComb(comb),
      edge,
      initial,
      state,
      combSlots: [...combSlots],
      clock: clocks.size === 1 ? [...clocks.values()][0] : null,
    },
  };

  function headerSpan() {
    return { start: 0, end: 0, line: 0, col: 0 };
  }
}

/**
 * A combinational loop among the comb blocks, if there is one: a bit whose
 * value depends, through blocks, on itself. Bit-level, so a carry rippling
 * up one vector (`assign c[1] = c[0] & a;`) is no loop. Within one block,
 * every bit it writes depends on every bit it reads from outside — a block
 * reading its own output from outside is a loop.
 */
function combLoop(comb, combSlots) {
  // Nodes are `slot:bit`; an edge read → written for each block.
  const edges = new Map();
  const key = (slot, bit) => `${slot}:${bit}`;
  const bitsOf = (mask) => {
    const out = [];
    for (let b = 0; b < 32; b++) if ((mask >>> b) & 1) out.push(b);
    return out;
  };
  const blockAt = new Map();
  for (const block of comb) {
    const reads = [];
    for (const r of block.reads) {
      if (!combSlots.has(r.slot)) continue;
      for (const b of bitsOf(r.mask)) reads.push(key(r.slot, b));
    }
    const writes = [];
    for (const w of block.writes) {
      for (const b of bitsOf(w.mask)) writes.push(key(w.slot, b));
    }
    for (const r of reads) {
      if (!edges.has(r)) edges.set(r, new Set());
      for (const w of writes) {
        edges.get(r).add(w);
        if (!blockAt.has(w)) blockAt.set(w, block);
      }
    }
  }
  const state = new Map(); // 1 visiting, 2 done
  const stack = [];
  const visit = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const s = state.get(next);
      if (s === 1) {
        const cycle = stack.slice(stack.indexOf(next));
        return cycle;
      }
      if (s == null) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };
  for (const node of edges.keys()) {
    if (state.get(node) != null) continue;
    const cycle = visit(node);
    if (cycle) {
      return {
        cycle: cycle.map((n) => {
          const [slot, bit] = n.split(":").map(Number);
          return { slot, bit };
        }),
        at: blockAt.get(cycle[0])?.loc,
      };
    }
  }
  return null;
}

/**
 * The comb blocks in an order where a block comes after the blocks it reads
 * from (Kahn's algorithm, source order among equals) — so one pass usually
 * settles them, and the bounded fixpoint in program.js is a safety net.
 */
function orderComb(comb) {
  const writers = new Map(); // slot → blocks writing it
  comb.forEach((b, i) => {
    for (const w of b.writes) {
      if (!writers.has(w.slot)) writers.set(w.slot, new Set());
      writers.get(w.slot).add(i);
    }
  });
  const deps = comb.map((b, i) => {
    const d = new Set();
    for (const r of b.reads) {
      for (const j of writers.get(r.slot) ?? []) if (j !== i) d.add(j);
    }
    return d;
  });
  const done = new Set();
  const order = [];
  while (order.length < comb.length) {
    let picked = -1;
    for (let i = 0; i < comb.length; i++) {
      if (done.has(i)) continue;
      if ([...deps[i]].every((j) => done.has(j))) {
        picked = i;
        break;
      }
    }
    if (picked < 0) {
      // A block-level cycle with no bit-level loop: source order.
      picked = [...comb.keys()].find((i) => !done.has(i));
    }
    done.add(picked);
    order.push(comb[picked]);
  }
  return order;
}

/** A node's span, narrowed to `to` when given (an `if` points at its `if
    (cond)`, not its whole body). */
function locOf(node, to = null) {
  const end = to ? to.end : node.end;
  return { start: node.start, end, line: node.line, col: node.col };
}

function spanOf(node) {
  return { start: node.start, end: node.end, line: node.line, col: node.col };
}
