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
//   · nothing is wider than 32 bits;
//   · an `inout` pin is driven by `assign` only (its value let go with z),
//     and reading it reads the PIN — what the board resolved;
//   · an array (a memory) is written only by clocked and initial blocks — a
//     memory written from always @(*) would be a latch — and holds at most
//     MAX_MEMORY_DEPTH words, MAX_MEMORY_WORDS in the whole module;
//   · a `for` or `repeat` loop's bounds are constants, so the analyzer runs
//     its counter to the end before anything executes: every evaluation is
//     proved to finish. In an always @(*) the loop is UNROLLED (each copy
//     sees its counter as a constant, which is what lets the latch and loop
//     checks see which bits each copy writes); in a clocked or initial block
//     it runs as written, at most the number of times it was proved to.
//
// SIGNEDNESS is IEEE 1364's (§5.5): a plain decimal, an `integer` and a
// parameter given a signed value are signed, everything else unsigned, and an
// expression is signed only when every operand it is made of is. It decides
// `<`, `/`, `%`, `>>>`, `**` and extension, and nothing else.
//
// Pure: no DOM, no time, no I/O. Diagnostics are `{code, args, …span}`
// records (lexer.js `diag`), worded by the renderer.

import { diag } from "./lexer.js";
import * as V from "./values.js";
import { readWord } from "./memory.js";

const { MAX_WIDTH } = V;

/** The most words one array may hold (a 62256's 32K × 8). */
export const MAX_MEMORY_DEPTH = 32768;
/** The most words all of a module's arrays may hold together. */
export const MAX_MEMORY_WORDS = 65536;
/** The most times an always @(*) may run a loop body — every copy is
    compiled, since the copies are what the latch and loop checks read. */
export const MAX_UNROLL = 1024;
/** The most times a clocked or initial block's loop may run its body (two
    full passes over the largest memory). */
export const MAX_LOOP = 65536;

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
 * Can an expression take a value past its SELF width when evaluated at a
 * wider context width? Zero-extension alone cannot (an identifier, a select,
 * a concatenation, a comparison); a complement, a negation, a carry or a
 * left shift can, and a bitwise operator can when either side can.
 */
function widensAtContext(e) {
  switch (e?.kind) {
    case "unary":
      if (e.op === "~" || e.op === "-") return true;
      return e.op === "+" ? widensAtContext(e.arg) : false;
    case "binary":
      if (["+", "-", "*", "**", "<<", "<<<", "~^", "^~"].includes(e.op)) return true; // prettier-ignore
      if (["&", "|", "^"].includes(e.op)) {
        return widensAtContext(e.left) || widensAtContext(e.right);
      }
      if (["/", "%", ">>", ">>>"].includes(e.op)) return widensAtContext(e.left); // prettier-ignore
      return false; // comparisons and logical operators: one bit
    case "cond":
      return widensAtContext(e.then) || widensAtContext(e.else);
    default:
      return false;
  }
}

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
  const symbols = new Map(); // name → symbol (the module's own scope)
  // The loop counters an unrolled loop has bound to constants right now
  // (slot → value): inside the copy of a body for one pass, reading the
  // counter IS reading that number.
  const loopEnv = new Map();
  const slots = []; // slot → symbol
  const addSlot = (sym) => {
    sym.slot = slots.length;
    slots.push(sym);
    return sym;
  };
  const addSignal = (sym) => {
    addSlot(sym);
    symbols.set(sym.name, sym);
    return sym;
  };
  for (const p of ports ?? []) {
    const w = Math.max(1, Math.min(MAX_WIDTH, p.width ?? 1));
    const kind = p.dir === "output" ? "output" : p.dir === "inout" ? "inout" : "input"; // prettier-ignore
    const sym = addSignal({ name: p.name, kind, w, msb: w - 1, lsb: 0, port: true, decl: null }); // prettier-ignore
    // An inout is two things behind one name: the PIN's level, which every
    // read sees (whatever the board resolved — this chip's own drive among
    // it), and the value the chip DRIVES onto it, a net of its own that only
    // `assign` sets. Keeping them apart is what makes `assign D = oe ? q :
    // 8'bz; assign y = D;` read the bus rather than loop on itself.
    if (kind === "inout") {
      sym.drive = addSlot({ name: p.name, kind: "drive", w, msb: w - 1, lsb: 0, port: false, hidden: true, decl: null, of: sym }); // prettier-ignore
    }
  }

  // Parameters first (in order — each may use the ones before it), then the
  // nets, so a range may name a parameter wherever it is declared. A
  // parameter with no range or type takes the type of its value — signed for
  // a plain number (§12.2); `parameter integer` is 32 signed bits; one with a
  // range is unsigned.
  for (const it of ast.items) {
    if (it.kind !== "param") continue;
    for (const a of it.assigns) {
      attempt(() => {
        if (symbols.has(a.name)) refuse("redeclared", a, { name: a.name });
        let value = constValue(a.value);
        let signed = selfSigned(a.value);
        // Its bits are numbered as declared (`parameter [8:1] P` has P[8]
        // for its top bit), else w-1 down to 0, as a vector's are.
        let msb = null;
        let lsb = 0;
        if (it.integer) {
          value = signed ? V.signExtend(value, 32) : V.resize(value, 32);
          signed = true;
        } else if (it.range) {
          const r = rangeOf(it.range, a);
          value = V.resize(value, r.w);
          signed = false;
          msb = r.msb;
          lsb = r.lsb;
        }
        msb ??= value.w - 1;
        symbols.set(a.name, { name: a.name, kind: "param", value, w: value.w, msb, lsb, signed, decl: a }); // prettier-ignore
      });
    }
  }
  const initialisers = []; // {sym, expr, at}
  const netAssigns = []; // `wire w = expr;` → a continuous assign
  let memoryWords = 0;

  /**
   * The symbols a declaration makes: `reg`/`wire` with their range, `integer`
   * as 32 signed bits, and a reg or integer with an array dimension as a
   * MEMORY of such words. `scope` is the named block it is declared in (null:
   * the module), whose path prefixes each name — `fill.i`.
   */
  function declare(it, scope) {
    const integer = it.net === "integer";
    const r = integer
      ? { w: 32, msb: 31, lsb: 0 }
      : it.range
        ? rangeOf(it.range, it)
        : { w: 1, msb: 0, lsb: 0 };
    const made = [];
    for (const n of it.names) {
      attempt(() => {
        const into = scope ? scope.names : symbols;
        const existing = into.get(n.name);
        if (existing?.port) {
          refuse({ output: "outputRedeclared", inout: "inoutRedeclared" }[existing.kind] ?? "inputRedeclared", n, { name: n.name }); // prettier-ignore
        }
        if (existing) refuse("redeclared", n, { name: n.name });
        const sym = {
          name: scope ? `${scope.path}.${n.name}` : n.name,
          kind: n.dims ? "memory" : integer ? "reg" : it.net,
          w: r.w,
          msb: r.msb,
          lsb: r.lsb,
          signed: integer,
          integer,
          local: Boolean(scope),
          port: false,
          decl: n,
        };
        if (n.dims) {
          const a = constInt(n.dims.a);
          const b = constInt(n.dims.b);
          sym.lo = Math.min(a, b);
          sym.hi = Math.max(a, b);
          sym.depth = sym.hi - sym.lo + 1;
          if (sym.depth > MAX_MEMORY_DEPTH) {
            refuse("memoryTooDeep", n.dims, { name: n.name, depth: sym.depth, max: MAX_MEMORY_DEPTH }); // prettier-ignore
          }
          if (memoryWords + sym.depth > MAX_MEMORY_WORDS) {
            refuse("memoryTooLarge", n.dims, { total: memoryWords + sym.depth, max: MAX_MEMORY_WORDS }); // prettier-ignore
          }
          memoryWords += sym.depth;
        }
        addSlot(sym);
        into.set(n.name, sym);
        made.push(sym);
        if (n.init) {
          if (it.net === "wire")
            netAssigns.push({ lhs: { kind: "id", name: n.name, ...spanOf(n) }, rhs: n.init, ...spanOf(n) }); // prettier-ignore
          else initialisers.push({ sym, expr: n.init, at: n });
        }
      });
    }
    return made;
  }

  for (const it of ast.items) {
    if (it.kind !== "decl") continue;
    attempt(() => declare(it, null));
  }

  // Named blocks' own variables, and every name inside a block resolved
  // against them (innermost first) before anything is compiled: the
  // statements are compiled more than once (the latch check walks them
  // again), and an annotated name means the same thing every time.
  const blockPaths = new Set();
  for (const it of ast.items) {
    if (it.kind === "always" || it.kind === "initial") {
      attempt(() => resolveScopes(it.body, null, []));
    }
  }

  function resolveScopes(stmt, path, scopes) {
    if (!stmt) return;
    const names = (e) => resolveNames(e, scopes);
    switch (stmt.kind) {
      case "block": {
        let inner = scopes;
        let innerPath = path;
        if (stmt.label != null) {
          innerPath = path ? `${path}.${stmt.label}` : stmt.label;
          if (blockPaths.has(innerPath)) {
            refuse("duplicateBlockName", stmt.labelAt ?? stmt, { name: stmt.label }); // prettier-ignore
          }
          blockPaths.add(innerPath);
          if (stmt.decls?.length) {
            const scope = { path: innerPath, names: new Map() };
            for (const d of stmt.decls) declare(d, scope);
            inner = [scope, ...scopes];
          }
        }
        for (const x of stmt.stmts) resolveScopes(x, innerPath, inner);
        return;
      }
      case "if":
        names(stmt.cond);
        resolveScopes(stmt.then, path, scopes);
        resolveScopes(stmt.else, path, scopes);
        return;
      case "case":
        names(stmt.subject);
        for (const item of stmt.items) {
          item.labels.forEach(names);
          resolveScopes(item.body, path, scopes);
        }
        resolveScopes(stmt.default, path, scopes);
        return;
      case "assign":
        names(stmt.lhs);
        names(stmt.rhs);
        return;
      case "for":
        [stmt.initLhs, stmt.initRhs, stmt.cond, stmt.stepLhs, stmt.stepRhs].forEach(names); // prettier-ignore
        resolveScopes(stmt.body, path, scopes);
        return;
      case "repeat":
        names(stmt.count);
        resolveScopes(stmt.body, path, scopes);
        return;
      default:
    }
  }

  /** Mark each name in an expression (or target) that a block declares. */
  function resolveNames(e, scopes) {
    if (!e || !scopes.length) return;
    switch (e.kind) {
      case "id":
        for (const scope of scopes) {
          const sym = scope.names.get(e.name);
          if (sym) {
            e._sym = sym;
            return;
          }
        }
        return;
      case "index":
        resolveNames(e.base, scopes);
        resolveNames(e.index, scopes);
        return;
      case "range":
        resolveNames(e.base, scopes);
        resolveNames(e.msb, scopes);
        resolveNames(e.lsb, scopes);
        return;
      case "ipsel":
        resolveNames(e.base, scopes);
        resolveNames(e.from, scopes);
        resolveNames(e.width, scopes);
        return;
      case "concat":
      case "repl":
        resolveNames(e.count, scopes);
        e.parts.forEach((p) => resolveNames(p, scopes));
        return;
      case "unary":
        resolveNames(e.arg, scopes);
        return;
      case "binary":
        resolveNames(e.left, scopes);
        resolveNames(e.right, scopes);
        return;
      case "cond":
        resolveNames(e.cond, scopes);
        resolveNames(e.then, scopes);
        resolveNames(e.else, scopes);
        return;
      default:
    }
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
  /** A constant as a number — a signed one (a plain `-4`) as a negative
      number, so a range like `[3:-4]` means what it says. */
  function constInt(expr) {
    const v = constValue(expr);
    if (v.x) refuse("unknownConstant", expr);
    return selfSigned(expr) ? V.toSigned(v.v, v.w) : v.v;
  }

  // ── Expressions ────────────────────────────────────────────────────────

  /** The symbol a name means where it is: a named block's own first. */
  function symbolOf(id) {
    return id._sym ?? symbols.get(id.name);
  }

  /** A name read in an expression. */
  function lookup(id, opts) {
    const sym = symbolOf(id);
    if (!sym) refuse("undeclared", id, { name: id.name });
    if (opts?.constant && sym.kind !== "param") {
      refuse("notConstant", id, { name: id.name });
    }
    return sym;
  }

  /** A declared bit index → its position from bit 0, or null when out of
      range. */
  function bitPosition(sym, index) {
    const pos = linearPosition(sym, index);
    return pos >= 0 && pos < sym.w ? pos : null;
  }
  /** The same, unbounded — where a declared index WOULD sit (an indexed
      part-select may run off either end of its vector). */
  function linearPosition(sym, index) {
    return sym.msb >= sym.lsb ? index - sym.lsb : sym.lsb - index;
  }
  /** An array index → the word's 0-based address, or -1 when there is none. */
  function addressOf(sym, index) {
    return index >= sym.lo && index <= sym.hi ? index - sym.lo : -1;
  }
  /** An index VALUE as the number it names (a signed index read as such). */
  function indexNumber(value, signed) {
    return signed ? V.toSigned(value.v, value.w) : value.v;
  }

  /**
   * An expression's own signedness (§5.5.1), before any context: a plain
   * decimal, an integer, a parameter given a signed value and an integer
   * array's word are signed; selects, concatenations, comparisons,
   * reductions and logical results are not; an operator is signed when all
   * of its context-determined operands are. Memoised on the node.
   */
  function selfSigned(e) {
    if (e._ss != null) return e._ss;
    let s = false;
    switch (e.kind) {
      case "num":
        s = !e.token.based;
        break;
      case "id":
        s = symbolOf(e)?.signed === true;
        break;
      case "index": {
        const sym = symbolOf(e.base);
        s = sym?.kind === "memory" && sym.signed === true;
        break;
      }
      case "unary":
        s = ["+", "-", "~"].includes(e.op) && selfSigned(e.arg);
        break;
      case "binary":
        if (ARITH_BITWISE.has(e.op))
          s = selfSigned(e.left) && selfSigned(e.right); // prettier-ignore
        else if (SHIFT.has(e.op) || e.op === "**") s = selfSigned(e.left);
        break;
      case "cond":
        s = selfSigned(e.then) && selfSigned(e.else);
        break;
      default:
    }
    e._ss = s;
    return s;
  }

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
        if (sym.kind === "memory") refuse("wholeArray", e, { name: e.name });
        w = sym.w;
        break;
      }
      case "index": {
        const sym = lookup(e.base, opts);
        selfWidth(e.index, opts);
        // A memory's index picks a WORD; any other a bit.
        w = sym.kind === "memory" ? sym.w : 1;
        break;
      }
      case "range": {
        const sym = lookup(e.base, opts);
        if (sym.kind === "param") refuse("selectOfParameter", e);
        if (sym.kind === "memory") refuse("wholeArray", e, { name: e.base.name }); // prettier-ignore
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
      case "ipsel": {
        const sym = lookup(e.base, opts);
        if (sym.kind === "param") refuse("selectOfParameter", e);
        if (sym.kind === "memory") refuse("wholeArray", e, { name: e.base.name }); // prettier-ignore
        selfWidth(e.from, opts);
        const n = constValue(e.width);
        const width = n.x
          ? 0
          : selfSigned(e.width)
            ? V.toSigned(n.v, n.w)
            : n.v;
        if (width < 1 || width > MAX_WIDTH) refuse("badSelectWidth", e.width, { max: MAX_WIDTH }); // prettier-ignore
        w = width;
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
        else if (SHIFT.has(e.op) || e.op === "**") w = l;
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
   * into `{w, fn, reads, loop}` — `fn(vals)` a closure returning a value of
   * width `w`, `reads` the `{slot, mask}` bits it reads (a variable index
   * reads the whole vector), `loop` whether an unrolled loop's counter was
   * read as a constant in it. Its signedness is its own: the left-hand side
   * of an assignment never changes it (§5.5.1).
   */
  function compileExpr(e, ctx, opts) {
    const sw = selfWidth(e, opts);
    const w = ctx == null ? sw : Math.max(sw, ctx);
    const reads = [];
    const meta = { loop: false };
    const fn = build(e, w, reads, opts, selfSigned(e), meta);
    return { w, fn, reads, loop: meta.loop };
  }

  /** A self-determined operand inside `build`: compiled on its own, its
      reads and loop use joining the enclosing expression's. */
  function operand(e, reads, opts, meta) {
    const c = compileExpr(e, null, opts);
    reads.push(...c.reads);
    if (c.loop) meta.loop = true;
    return c;
  }

  /** Widen a leaf to the expression's width — sign-extending when the
      EXPRESSION is signed (§5.5.2), zero-extending otherwise. */
  function widen(v, w, signed) {
    if (v.w === w) return v;
    return signed ? V.signExtend(v, w) : V.resize(v, w);
  }

  /** The closure for `e` evaluated at width `w` (already ≥ its own) as a
      `signed` or unsigned expression. */
  function build(e, w, reads, opts, signed, meta) {
    switch (e.kind) {
      case "num": {
        const value = widen(literalValue(e.token), w, signed);
        return () => value;
      }
      case "id": {
        const sym = lookup(e, opts);
        if (sym.kind === "param") {
          const value = widen(sym.value, w, signed);
          return () => value;
        }
        if (!opts?.constant && loopEnv.has(sym.slot)) {
          meta.loop = true;
          const value = widen(loopEnv.get(sym.slot), w, signed);
          return () => value;
        }
        reads.push({ slot: sym.slot, mask: V.mask(sym.w) });
        const slot = sym.slot;
        if (sym.w === w) return (vals) => vals[slot];
        return (vals) => widen(vals[slot], w, signed);
      }
      case "index": {
        const sym = lookup(e.base, opts);
        const idx = operand(e.index, reads, opts, meta);
        const idxSigned = selfSigned(e.index);
        if (sym.kind === "memory") {
          // A word of an array: any address may be the one, so the whole
          // array is read (a memory is never a combinational signal, so
          // this only ever feeds the sensitivity a block reads).
          reads.push({ slot: sym.slot, mask: 1 });
          const slot = sym.slot;
          return (vals) => {
            const i = idx.fn(vals);
            const word = i.x ? V.allX(sym.w) : readWord(vals[slot], addressOf(sym, indexNumber(i, idxSigned))); // prettier-ignore
            return widen(word, w, signed);
          };
        }
        // A constant index is checked here and reads one bit; a variable one
        // reads the whole vector (any bit of it may be the one). A loop
        // counter's copy is constant too, but out of range it reads x, as the
        // loop would have read it running.
        if (!idx.reads.length) {
          const index = idx.fn([]);
          if (index.x) {
            if (!idx.loop) refuse("unknownConstant", e.index);
            const value = V.resize(V.allX(1), w);
            return () => value;
          }
          const n = indexNumber(index, idxSigned);
          if (sym.kind === "param") {
            const pos = bitPosition(sym, n);
            const value = V.resize(pos == null ? V.allX(1) : V.bit(sym.value, pos), w); // prettier-ignore
            return () => value;
          }
          const pos = bitPosition(sym, n);
          if (pos == null) {
            if (!idx.loop) refuse("selectOutOfRange", e, { name: sym.name, msb: sym.msb, lsb: sym.lsb }); // prettier-ignore
            const value = V.resize(V.allX(1), w);
            return () => value;
          }
          reads.push({ slot: sym.slot, mask: 2 ** pos });
          const slot = sym.slot;
          return (vals) => V.resize(V.bit(vals[slot], pos), w);
        }
        if (sym.kind === "param") {
          const value = sym.value;
          return (vals) => {
            const i = idx.fn(vals);
            const pos = i.x
              ? null
              : bitPosition(sym, indexNumber(i, idxSigned));
            return V.resize(pos == null ? V.allX(1) : V.bit(value, pos), w);
          };
        }
        reads.push({ slot: sym.slot, mask: V.mask(sym.w) });
        const slot = sym.slot;
        return (vals) => {
          const i = idx.fn(vals);
          const pos = i.x ? null : bitPosition(sym, indexNumber(i, idxSigned));
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
      case "ipsel": {
        // `v[b +: n]` is bits b … b+n-1 of v by its declared numbering, and
        // `v[b -: n]` bits b-n+1 … b — whichever way v is declared. Bits off
        // either end read x (§5.2.1).
        const sym = lookup(e.base, opts);
        const width = e._sw;
        const start = operand(e.from, reads, opts, meta);
        const startSigned = selfSigned(e.from);
        const loOf = (b) => {
          const first = e.dir === "+" ? b : b - width + 1;
          return Math.min(linearPosition(sym, first), linearPosition(sym, first + width - 1)); // prettier-ignore
        };
        const slot = sym.slot;
        if (!start.reads.length) {
          const b = start.fn([]);
          if (b.x) {
            if (!start.loop) refuse("unknownConstant", e.from);
            const value = V.resize(V.allX(width), w);
            return () => value;
          }
          const lo = loOf(indexNumber(b, startSigned));
          if (!start.loop && (lo < 0 || lo + width > sym.w)) {
            refuse("selectOutOfRange", e, { name: sym.name, msb: sym.msb, lsb: sym.lsb }); // prettier-ignore
          }
          const m = bitsMask(lo, width, sym.w);
          if (m) reads.push({ slot, mask: m });
          return (vals) => V.resize(V.slice(vals[slot], lo, width), w);
        }
        reads.push({ slot, mask: V.mask(sym.w) });
        return (vals) => {
          const b = start.fn(vals);
          if (b.x) return V.resize(V.allX(width), w);
          return V.resize(V.slice(vals[slot], loOf(indexNumber(b, startSigned)), width), w); // prettier-ignore
        };
      }
      case "concat":
      case "repl": {
        const parts = e.parts.map((p) => operand(p, reads, opts, meta));
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
          const arg = build(e.arg, w, reads, opts, signed, meta);
          if (e.op === "+") return arg;
          if (e.op === "-") return (vals) => V.negate(arg(vals));
          return (vals) => V.not(arg(vals));
        }
        // Reductions and `!`: a self-determined operand, a 1-bit result.
        const arg = operand(e.arg, reads, opts, meta);
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
          const l = build(e.left, w, reads, opts, signed, meta);
          const r = build(e.right, w, reads, opts, signed, meta);
          const op = {
            "+": V.add,
            "-": V.sub,
            "*": V.mul,
            "/": signed ? V.sdiv : V.div,
            "%": signed ? V.smod : V.mod,
            "&": V.and,
            "|": V.or,
            "^": V.xor,
            "~^": V.xnor,
            "^~": V.xnor,
          }[e.op];
          return (vals) => op(l(vals), r(vals));
        }
        if (COMPARISON.has(e.op)) {
          // The operands size and sign each other, not the result (§5.5.1):
          // a signed comparison only when both sides are signed.
          const inner = Math.max(e.left._sw, e.right._sw);
          const both = selfSigned(e.left) && selfSigned(e.right);
          const l = build(e.left, inner, reads, opts, both, meta);
          const r = build(e.right, inner, reads, opts, both, meta);
          const op = {
            "==": V.eq,
            "!=": V.ne,
            "===": V.caseEq,
            "!==": V.caseNe,
            "<": both ? V.slt : V.lt,
            "<=": both ? V.sle : V.le,
            ">": both ? V.sgt : V.gt,
            ">=": both ? V.sge : V.ge,
          }[e.op];
          return (vals) => V.resize(op(l(vals), r(vals)), w);
        }
        if (LOGICAL.has(e.op)) {
          const l = operand(e.left, reads, opts, meta);
          const r = operand(e.right, reads, opts, meta);
          const op = e.op === "&&" ? V.logicalAnd : V.logicalOr;
          return (vals) => V.resize(op(l.fn(vals), r.fn(vals)), w);
        }
        if (SHIFT.has(e.op)) {
          const l = build(e.left, w, reads, opts, signed, meta);
          const r = operand(e.right, reads, opts, meta);
          const op =
            e.op === "<<" || e.op === "<<<"
              ? V.shl
              : e.op === ">>>" && signed
                ? V.ashr
                : V.shr;
          return (vals) => op(l(vals), r.fn(vals));
        }
        if (e.op === "**") {
          // The exponent is self-determined: its own signedness says whether
          // it can be negative (Table 5-6).
          const l = build(e.left, w, reads, opts, signed, meta);
          const r = operand(e.right, reads, opts, meta);
          const rSigned = selfSigned(e.right);
          return (vals) => V.pow(l(vals), r.fn(vals), signed, rSigned);
        }
        return refuse("unexpected", e, { found: e.op });
      }
      case "cond": {
        const c = operand(e.cond, reads, opts, meta);
        const a = build(e.then, w, reads, opts, signed, meta);
        const b = build(e.else, w, reads, opts, signed, meta);
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

  /** The bits [lo, lo + width) that exist in a `w`-bit vector, as a mask. */
  function bitsMask(lo, width, w) {
    let m = 0;
    for (let b = Math.max(0, lo); b < Math.min(w, lo + width); b++) m += 2 ** b;
    return m;
  }

  // ── Assignment targets ─────────────────────────────────────────────────

  /**
   * Compile an lvalue: `{w, segments(vals), parts}` — `segments` the
   * `{slot, lo, w}` runs it writes this time, most significant first (a
   * variable index with an unknown or out-of-range value writes nothing, as
   * Verilog's does; an array word is `{slot, mem: true, addr, w}`); `parts`
   * the static `{sym, mask}` view the driver checks use (a variable index
   * claims the whole vector, an array word the whole array).
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
    const named = symbolOf(id);
    if (!named) refuse("undeclared", id, { name: id.name });
    if (named.kind === "param")
      refuse("assignToParameter", id, { name: id.name });
    if (named.kind === "input") refuse("assignToInput", id, { name: id.name });
    // An inout is assigned through the value it DRIVES.
    const sym = named.kind === "inout" ? named.drive : named;
    const slot = sym.slot;
    if (sym.kind === "memory") {
      if (lv.kind !== "index") refuse("wholeArray", lv, { name: id.name });
      const idx = compileExpr(lv.index, null);
      const idxSigned = selfSigned(lv.index);
      return {
        w: sym.w,
        parts: [{ sym, mask: 1, at: lv, variable: true }],
        indexReads: idx.reads,
        resolve: (vals) => {
          const i = idx.fn(vals);
          const addr = i.x ? -1 : addressOf(sym, indexNumber(i, idxSigned));
          return [addr < 0 ? { slot: -1, lo: 0, w: sym.w } : { slot, mem: true, addr, w: sym.w }]; // prettier-ignore
        },
      };
    }
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
    if (lv.kind === "ipsel") {
      const width = selfWidth(lv);
      const start = compileExpr(lv.from, null);
      const startSigned = selfSigned(lv.from);
      const loOf = (b) => {
        const first = lv.dir === "+" ? b : b - width + 1;
        return Math.min(linearPosition(sym, first), linearPosition(sym, first + width - 1)); // prettier-ignore
      };
      // Bits off either end are written nowhere: the value's bits for them
      // go to `slot: -1` segments, most significant first.
      const segmentsAt = (lo) => {
        const segs = [];
        const top = lo + width;
        if (top > sym.w) segs.push({ slot: -1, lo: 0, w: Math.min(width, top - Math.max(lo, sym.w)) }); // prettier-ignore
        const from = Math.max(lo, 0);
        const to = Math.min(top, sym.w);
        if (to > from) segs.push({ slot, lo: from, w: to - from });
        if (lo < 0) segs.push({ slot: -1, lo: 0, w: Math.min(width, -lo) });
        return segs;
      };
      if (!start.reads.length) {
        const b = start.fn([]);
        if (b.x && !start.loop) refuse("unknownConstant", lv.from);
        const lo = b.x ? null : loOf(indexNumber(b, startSigned));
        if (lo != null && !start.loop && (lo < 0 || lo + width > sym.w)) {
          refuse("selectOutOfRange", lv, { name: sym.name, msb: sym.msb, lsb: sym.lsb }); // prettier-ignore
        }
        const segs = lo == null ? [{ slot: -1, lo: 0, w: width }] : segmentsAt(lo); // prettier-ignore
        const mask = lo == null ? 0 : bitsMask(lo, width, sym.w);
        return {
          w: width,
          parts: mask ? [{ sym, mask, at: lv }] : [],
          resolve: () => segs,
        };
      }
      return {
        w: width,
        parts: [{ sym, mask: V.mask(sym.w), at: lv, variable: true }],
        indexReads: start.reads,
        resolve: (vals) => {
          const b = start.fn(vals);
          if (b.x) return [{ slot: -1, lo: 0, w: width }];
          return segmentsAt(loOf(indexNumber(b, startSigned)));
        },
      };
    }
    // A bit select, constant or variable.
    const idx = compileExpr(lv.index, null);
    const idxSigned = selfSigned(lv.index);
    if (!idx.reads.length) {
      const index = idx.fn([]);
      if (index.x && !idx.loop) refuse("unknownConstant", lv.index);
      const pos = index.x ? null : bitPosition(sym, indexNumber(index, idxSigned)); // prettier-ignore
      if (pos == null) {
        if (!idx.loop) {
          refuse("selectOutOfRange", lv, { name: sym.name, msb: sym.msb, lsb: sym.lsb }); // prettier-ignore
        }
        // A loop counter's copy off the end of the vector: as the loop
        // running would, it writes nothing.
        return { w: 1, parts: [], resolve: () => [{ slot: -1, lo: 0, w: 1 }] };
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
        const pos = i.x ? null : bitPosition(sym, indexNumber(i, idxSigned));
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
      case "for":
        return compileFor(s, ctx);
      case "repeat":
        return compileRepeat(s, ctx);
      default:
        return refuse("unexpected", s, { found: s.kind });
    }
  }

  // ── Loops ──────────────────────────────────────────────────────────────
  // A loop is accepted only when the analyzer can run it to its end before
  // anything executes: its counter's sequence (a `for`) or its count (a
  // `repeat`) follows from constants alone, and nothing in the body moves
  // it. `ctx.cost` counts every body execution, nested loops included, so a
  // nest of loops is held to the block's one limit (`ctx.cap`).

  /** A `for`'s counter: ONE plain variable, set by both the first and the
      last part, that the body never sets. */
  function loopCounter(s) {
    if (s.initLhs.kind !== "id" || s.stepLhs.kind !== "id") {
      refuse("loopCounterForm", s.header);
    }
    const sym = symbolOf(s.initLhs);
    if (!sym) refuse("undeclared", s.initLhs, { name: s.initLhs.name });
    if (symbolOf(s.stepLhs) !== sym) refuse("loopCounterForm", s.header);
    const moved = assignmentTo(s.body, sym);
    if (moved) refuse("loopCounterAssigned", moved, { name: s.initLhs.name });
    return sym;
  }

  /** The first assignment in `stmt` that sets any bit of `sym`, or null. */
  function assignmentTo(stmt, sym) {
    if (!stmt) return null;
    const hits = (lv) =>
      lv.kind === "concat"
        ? lv.parts.some(hits)
        : symbolOf(lv.kind === "id" ? lv : lv.base) === sym;
    switch (stmt.kind) {
      case "assign":
        return hits(stmt.lhs) ? stmt : null;
      case "block":
        for (const x of stmt.stmts) {
          const found = assignmentTo(x, sym);
          if (found) return found;
        }
        return null;
      case "if":
        return assignmentTo(stmt.then, sym) ?? assignmentTo(stmt.else, sym);
      case "case":
        for (const item of stmt.items) {
          const found = assignmentTo(item.body, sym);
          if (found) return found;
        }
        return assignmentTo(stmt.default, sym);
      case "for":
        if (hits(stmt.initLhs)) return stmt;
        return assignmentTo(stmt.body, sym);
      case "repeat":
        return assignmentTo(stmt.body, sym);
      default:
        return null;
    }
  }

  /**
   * Run a `for`'s counter to the end: `{values, exit}` — the value it holds
   * for each pass through the body, and the one it is left with. Its first
   * part may read only constants, its condition and last part only the
   * counter itself. Memoised on the node (the latch check walks it again).
   */
  function loopSequence(s, sym, cap) {
    if (s._seq) return s._seq;
    const init = compileExpr(s.initRhs, sym.w);
    if (init.loop || init.reads.length) refuse("loopNotStatic", s.initRhs);
    const onlyCounter = (c, at) => {
      if (c.loop || c.reads.some((r) => r.slot !== sym.slot)) {
        refuse("loopNotStatic", at);
      }
    };
    const cond = compileExpr(s.cond, null);
    onlyCounter(cond, s.cond);
    const step = compileExpr(s.stepRhs, sym.w);
    onlyCounter(step, s.stepRhs);
    const scratch = [];
    let value = V.resize(init.fn(scratch), sym.w);
    const values = [];
    for (;;) {
      scratch[sym.slot] = value;
      // An unknown condition ends a loop, as a false one does (§9.6).
      if (V.truthOf(cond.fn(scratch)) !== "1") break;
      values.push(value);
      if (values.length > cap) refuse("loopTooLong", s.header, { max: cap });
      value = V.resize(step.fn(scratch), sym.w);
    }
    s._seq = { values, exit: value, init, cond, step };
    return s._seq;
  }

  function compileFor(s, ctx) {
    const header = locOf(s.header);
    const counter = loopCounter(s);
    const target = compileTarget(s.initLhs);
    for (const p of target.parts) {
      p.counter = true;
      ctx.writeTarget(p, s.initLhs);
    }
    const seq = loopSequence(s, counter, ctx.cap);
    const n = seq.values.length;
    const saved = ctx.cost;
    ctx.cost = 0;
    let node;
    let total;
    if (ctx.unroll) {
      // One copy of the body per pass, the counter a constant in each — with
      // the counter really SET before each copy and after the last, at the
      // loop's own line, as a loop running sets it (the watch panel shows
      // it; a breakpoint on the `for` line stops there).
      const set = (value) => ({
        kind: "assign",
        blocking: true,
        target,
        value: () => value,
        valueReads: [],
        w: counter.w,
        loc: header,
      });
      const stmts = [set(seq.values[0] ?? seq.exit)];
      seq.values.forEach((value, k) => {
        loopEnv.set(counter.slot, value);
        try {
          stmts.push(compileStmt(s.body, ctx));
        } finally {
          loopEnv.delete(counter.slot);
        }
        stmts.push(set(seq.values[k + 1] ?? seq.exit));
      });
      node = { kind: "block", stmts, loc: header };
      total = n + ctx.cost;
    } else {
      node = {
        kind: "for",
        target,
        init: seq.init.fn,
        cond: seq.cond.fn,
        step: seq.step.fn,
        w: counter.w,
        max: n,
        body: compileStmt(s.body, ctx),
        loc: header,
      };
      total = n * (1 + ctx.cost);
    }
    if (total > ctx.cap) refuse("loopTooLong", s.header, { max: ctx.cap });
    ctx.cost = saved + total;
    return node;
  }

  function compileRepeat(s, ctx) {
    const header = locOf(s.header);
    const count = compileExpr(s.count, null);
    if (count.loop || count.reads.length) refuse("loopNotStatic", s.count);
    const v = count.fn([]);
    // An unknown count runs nothing (§9.6), and so does a negative one.
    const n = v.x ? 0 : Math.max(0, selfSigned(s.count) ? V.toSigned(v.v, v.w) : v.v); // prettier-ignore
    if (n > ctx.cap) refuse("loopTooLong", s.header, { max: ctx.cap });
    s._times = n;
    const saved = ctx.cost;
    ctx.cost = 0;
    let node;
    let total;
    if (ctx.unroll) {
      const stmts = [{ kind: "mark", loc: header }];
      for (let k = 0; k < n; k++) {
        if (k) stmts.push({ kind: "mark", loc: header });
        stmts.push(compileStmt(s.body, ctx));
      }
      node = { kind: "block", stmts, loc: header };
      total = n + ctx.cost;
    } else {
      node = { kind: "repeat", times: n, body: compileStmt(s.body, ctx), loc: header }; // prettier-ignore
      total = n * (1 + ctx.cost);
    }
    if (total > ctx.cap) refuse("loopTooLong", s.header, { max: ctx.cap });
    ctx.cost = saved + total;
    return node;
  }

  // ── Drivers ────────────────────────────────────────────────────────────
  // Per signal: who drives it. `assign` drivers are per bit (a wire may be
  // assembled from several assigns); a procedural driver is one block.
  const assignBits = new Map(); // slot → mask driven by continuous assigns
  const blockOf = new Map(); // slot → index of the one always block driving it
  const initialOnly = new Set(); // slots written by initial blocks/initialisers

  const counterSlots = new Set(); // slots some `for` uses as its counter

  function claimAssign(part, at) {
    const { sym, mask } = part;
    if (sym.kind === "reg" || sym.kind === "memory") refuse("assignToReg", part.at ?? at, { name: sym.name }); // prettier-ignore
    if (blockOf.has(sym.slot)) refuse("mixedDrivers", part.at ?? at, { name: sym.name }); // prettier-ignore
    const had = assignBits.get(sym.slot) ?? 0;
    if ((had & mask) >>> 0) refuse("multipleDrivers", part.at ?? at, { name: sym.name }); // prettier-ignore
    assignBits.set(sym.slot, (had | mask) >>> 0);
  }

  /** Who may set a signal from a procedural block — the checks an always
      block and an initial block share. */
  function claimVariable(part, at) {
    const { sym } = part;
    if (sym.kind === "wire") refuse("proceduralToWire", part.at ?? at, { name: sym.name }); // prettier-ignore
    if (sym.kind === "drive") refuse("inoutProcedural", part.at ?? at, { name: sym.name }); // prettier-ignore
    if (assignBits.has(sym.slot)) refuse("mixedDrivers", part.at ?? at, { name: sym.name }); // prettier-ignore
  }

  function claimProcedural(part, at, blockIndex) {
    const { sym } = part;
    claimVariable(part, at);
    const owner = blockOf.get(sym.slot);
    if (owner != null && owner !== blockIndex) {
      // A counter shared between blocks gets its own sentence: the fix is a
      // counter declared inside each block.
      const code = part.counter || counterSlots.has(sym.slot) ? "loopCounterShared" : "multipleAlwaysDrivers"; // prettier-ignore
      refuse(code, part.at ?? at, { name: sym.name });
    }
    blockOf.set(sym.slot, blockIndex);
    if (part.counter) counterSlots.add(sym.slot);
  }

  // ── Items ──────────────────────────────────────────────────────────────

  const comb = []; // assigns and always @(*) — pure functions of their reads
  const edge = []; // edge-triggered always blocks
  const initial = []; // initialisers and initial blocks, in source order
  let alwaysIndex = 0;
  // Every procedural block's reads (`index` its always index, null for an
  // initial block), and the comb-block loop counters waiting on them.
  const blockReads = [];
  const counterLatches = [];

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
        for (const p of target.parts) {
          claimAssign(p, t);
          // A net is driven at a fixed bit or range (§6.1.1, Table 6-1): a
          // select chosen by a variable is a procedural thing.
          if (p.variable) refuse("assignVariableSelect", p.at ?? t, { name: p.sym.name }); // prettier-ignore
        }
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
          claimVariable(part, at);
          initialOnly.add(part.sym.slot);
        });
        const body = compileStmt(it.body, ctx);
        blockReads.push({ index: null, reads: ctx.reads });
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

  // A loop counter left unset on some path of its always @(*) is a latch
  // after all when another item reads it (an assign, another block, an
  // initial value would be a second driver and is refused already).
  for (const { slot, index, at } of counterLatches) {
    const readHere = (reads) => reads.some((r) => r.slot === slot);
    const elsewhere =
      comb.some((b) => b.kind === "assign" && readHere(b.reads)) ||
      blockReads.some((b) => b.index !== index && readHere(b.reads));
    if (elsewhere) attempt(() => refuse("latch", at, { name: slots[slot].name })); // prettier-ignore
  }

  /** A procedural block's compile context. A loop in it runs as written,
      at most MAX_LOOP times (an always @(*) unrolls it — compileAlways). */
  function procedural(onWrite) {
    return {
      procedural: true,
      unroll: false,
      cap: MAX_LOOP,
      cost: 0,
      reads: [],
      writes: [],
      writeTarget(part, at) {
        onWrite(part, at);
        this.writes.push({ slot: part.sym.slot, mask: part.mask, counter: part.counter === true }); // prettier-ignore
      },
    };
  }

  function compileAlways(it, index) {
    const sens = it.sens;
    const edges = sens.star ? [] : sens.list.filter((e) => e.edge);
    const levels = sens.star ? [] : sens.list.filter((e) => !e.edge);
    if (edges.length && levels.length) refuse("mixedSensitivity", it.sens);
    const combinational = !edges.length;
    const ctx = procedural((part, at) => {
      // An array set from always @(*) would hold its words between
      // evaluations — a latch the size of a memory.
      if (combinational && part.sym.kind === "memory") {
        refuse("memoryInComb", part.at ?? at, { name: part.sym.name });
      }
      claimProcedural(part, at, index);
    });
    if (combinational) {
      ctx.unroll = true;
      ctx.cap = MAX_UNROLL;
    }
    const body = compileStmt(it.body, ctx);
    blockReads.push({ index, reads: ctx.reads });
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
      if ((needed & ~assigned) >>> 0 === 0) continue;
      // A loop's counter, set by nothing but its `for` (in a branch, so not
      // on every path), holds nothing anybody sees — unless something reads
      // it where the loop may not have run: this block after the branch
      // (then it is in the block's outside reads), or another item (asked
      // once every item is compiled — counterLatches below).
      const counterOnly = writes.every((x) => x.slot !== w.slot || x.counter);
      if (counterOnly && !flow.reads.some((r) => r.slot === w.slot)) {
        counterLatches.push({ slot: w.slot, index, at: it });
        continue;
      }
      refuse("latch", it, { name: sym.name });
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
   *
   * The walk carries two views of "assigned": `all` counts every write (what
   * the latch check asks — a reg set on every path, by `=` or `<=`, holds
   * nothing), `now` only BLOCKING ones (what a later read sees). A `<=`
   * target read later in the same block still holds its OLD value there
   * (§9.2.2), so the block would run again on its own write — refused with a
   * sentence of its own rather than passed off as the block's own value.
   */
  function definiteFlow(stmt) {
    const reads = [];
    const readOutside = (rs, st, at) => {
      for (const r of rs) {
        const own = st.now.get(r.slot) ?? 0;
        const outside = (r.mask & ~own) >>> 0;
        if (!outside) continue;
        if ((outside & (st.all.get(r.slot) ?? 0)) >>> 0) {
          refuse("nonblockingReadBack", at, { name: slots[r.slot].name });
        }
        reads.push({ slot: r.slot, mask: outside });
      }
    };
    const meet = (a, b) => {
      const out = new Map();
      for (const [slot, m] of a) {
        const n = b.get(slot);
        if (n != null && m & n) out.set(slot, (m & n) >>> 0);
      }
      return out;
    };
    const merge = (a, b) => ({ all: meet(a.all, b.all), now: meet(a.now, b.now) }); // prettier-ignore
    const copy = (st) => ({ all: new Map(st.all), now: new Map(st.now) });
    const set = (map, slot, mask) =>
      map.set(slot, ((map.get(slot) ?? 0) | mask) >>> 0);
    const walk = (s, st) => {
      switch (s.kind) {
        case "null":
          return st;
        case "block": {
          let cur = st;
          for (const x of s.stmts) cur = walk(x, cur);
          return cur;
        }
        case "if": {
          readOutside(compileExpr(s.cond, null).reads, st, s.cond);
          const a = walk(s.then, copy(st));
          const b = s.else ? walk(s.else, copy(st)) : st;
          return merge(a, b);
        }
        case "case": {
          let w = selfWidth(s.subject);
          for (const item of s.items) {
            for (const l of item.labels) w = Math.max(w, selfWidth(l));
          }
          readOutside(compileExpr(s.subject, w).reads, st, s.subject);
          for (const item of s.items) {
            for (const l of item.labels)
              readOutside(compileExpr(l, w).reads, st, l);
          }
          const branches = s.items.map((item) => walk(item.body, copy(st)));
          if (s.default) branches.push(walk(s.default, copy(st)));
          else if (!caseIsFull(s, w)) branches.push(st);
          return branches.reduce((acc, b) => merge(acc, b));
        }
        case "assign": {
          const target = compileTarget(s.lhs);
          const value = compileExpr(s.rhs, target.w);
          readOutside([...value.reads, ...(target.indexReads ?? [])], st, s);
          const next = copy(st);
          for (const p of target.parts) {
            if (p.variable) continue; // which bit it writes is not known
            set(next.all, p.sym.slot, p.mask);
            if (s.blocking) set(next.now, p.sym.slot, p.mask);
          }
          return next;
        }
        case "for": {
          // As it was unrolled: the counter is set before anything else, and
          // each pass's copy sees its counter as a constant.
          const sym = symbolOf(s.initLhs);
          let cur = copy(st);
          set(cur.all, sym.slot, V.mask(sym.w));
          set(cur.now, sym.slot, V.mask(sym.w));
          for (const value of s._seq?.values ?? []) {
            loopEnv.set(sym.slot, value);
            try {
              cur = walk(s.body, cur);
            } finally {
              loopEnv.delete(sym.slot);
            }
          }
          return cur;
        }
        case "repeat": {
          let cur = st;
          for (let k = 0; k < (s._times ?? 0); k++) cur = walk(s.body, cur);
          return cur;
        }
        default:
          return st;
      }
    };
    const { all } = walk(stmt, { all: new Map(), now: new Map() });
    return { assigned: all, reads };
  }

  /**
   * Does a case without a default still cover every value of its subject?
   * Counted over the SUBJECT's own width (at most 8 bits; no narrow signed
   * leaf exists, so such a subject is unsigned and zero-extended): a 2-bit
   * subject is covered by `0: 1: 2: 3:` — plain decimals, 32 bits wide — as
   * surely as by `2'd0…2'd3`. Each label is compared at the case's width `w`,
   * as the case compares it; in a casez its z/? bits match anything, in a
   * casex its x bits too, and any other unknown bit matches no known value.
   */
  function caseIsFull(s, w) {
    // A subject that is an OPERATION is evaluated at the case's width, not its
    // own (§5.4.1): `~S` or `A + B` compared against plain decimal labels is a
    // 32-bit value, which reaches past every value of S's own width. Counted
    // at the self width, `case (~S) 0: 1: 2: 3:` read as full and drove x for
    // every input; counted at the case's width it is the latch it is.
    const sw = widensAtContext(s.subject) ? w : selfWidth(s.subject);
    if (sw > 8) return false;
    const values = 2 ** sw;
    const seen = new Set();
    for (const item of s.items) {
      for (const l of item.labels) {
        const c = compileExpr(l, w);
        if (c.reads.length) return false;
        const v = c.fn([]);
        const wild = s.type === "casex" ? v.x : s.type === "casez" ? v.z : 0;
        if ((v.x & ~wild) >>> 0) continue; // an x matches only an x
        for (let u = 0; u < values; u++) {
          if (((u ^ v.v) & ~wild) >>> 0 === 0) seen.add(u);
        }
      }
    }
    return seen.size === values;
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
      (sym.kind === "reg" || sym.kind === "memory") &&
      !blockOf.has(sym.slot) &&
      !initialOnly.has(sym.slot)
    ) {
      // prettier-ignore
      warnings.push(diag("regUnassigned", sym.decl, { name: sym.name }, "warning")); // prettier-ignore
    }
  }

  // What each slot IS at run time: STATE persists between evaluations (an
  // edge-driven reg, one only ever set by `initial`, and every array);
  // everything else is COMBINATIONAL, recomputed from the inputs and the
  // state every time.
  const edgeSlots = new Set();
  for (const b of edge) for (const w of b.writes) edgeSlots.add(w.slot);
  const combSlots = new Set();
  for (const b of comb) for (const w of b.writes) combSlots.add(w.slot);
  const state = [];
  for (const sym of slots) {
    if (sym.kind !== "reg" && sym.kind !== "memory" && !(sym.kind === "output" && outputKind.get(sym.name) === "reg")) continue; // prettier-ignore
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
        signed: s.signed === true,
        integer: s.integer === true,
        local: s.local === true,
        // An inout's driven value: a slot of its own, named for the pin.
        hidden: s.hidden === true,
        // An array's index range and size.
        ...(s.kind === "memory" ? { lo: s.lo, hi: s.hi, depth: s.depth } : {}), // prettier-ignore
      })),
      // In port order; an inout names its pin's slot and its driven one.
      ports: slots.filter((s) => s.port).map((s) => ({ name: s.name, dir: s.kind, w: s.w, slot: s.slot, drive: s.drive?.slot ?? null })), // prettier-ignore
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
