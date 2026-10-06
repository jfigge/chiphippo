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

// values.js — Verilog's four-state vectors (0, 1, x, z), for the custom chip
// designer's interpreter. A value is `{w, v, x, z}`: its width in bits
// (1…32 — the subset's ceiling, which keeps every operation in plain 32-bit
// integer arithmetic) and three bit masks — `v` the known value bits, `x` the
// bits that are UNKNOWN (x or z), and `z` the subset of those that are high
// impedance. A bit in `x` always has 0 in `v` (`norm` keeps it so), which is
// what lets the bitwise rules below be one line each.
//
// The rules are IEEE 1364-2005's: z reads as x in every operator, arithmetic
// with any unknown bit is all-x, a comparison with an unknown is x, `===`
// compares the four states exactly, and a ternary whose condition is unknown
// merges its two branches bit by bit. Values are immutable; every operation
// returns a new one.

/** The subset's widest vector — unsized constants are this wide, as
    Verilog's are (an integer). */
export const MAX_WIDTH = 32;

/** The all-ones mask for a width. */
export function mask(w) {
  return w >= 32 ? 0xffffffff : 2 ** w - 1;
}

/** Normalise a raw record: masks clipped to the width, value bits cleared
    under unknowns, z a subset of x. */
function norm(w, v, x, z) {
  const m = mask(w);
  const zz = (z & x & m) >>> 0;
  const xx = (x & m) >>> 0;
  return { w, v: (v & ~xx & m) >>> 0, x: xx, z: zz };
}

/** A fully known value. */
export function known(w, v) {
  return norm(w, v, 0, 0);
}

/** An all-x value. */
export function allX(w) {
  return norm(w, 0, 0xffffffff, 0);
}

/** An all-z value (an undriven wire). */
export function allZ(w) {
  return norm(w, 0, 0xffffffff, 0xffffffff);
}

/** Build a value from raw masks (normalising them). */
export function make(w, v, x = 0, z = 0) {
  return norm(w, v, x, z);
}

/** Any unknown bit at all? */
export const hasUnknown = (a) => a.x !== 0;

/** Zero-extend or truncate to `w` (Verilog's unsigned extension). */
export function resize(a, w) {
  if (a.w === w) return a;
  return norm(w, a.v, a.x, a.z);
}

/** One bit of a value, as a 1-bit value (an out-of-range bit is x). */
export function bit(a, pos) {
  if (pos < 0 || pos >= a.w) return allX(1);
  return norm(1, a.v >>> pos, a.x >>> pos, a.z >>> pos);
}

/** Bits [lo, lo + w) as a w-bit value. */
export function slice(a, lo, w) {
  if (lo < 0 || lo + w > a.w) {
    // Partly out of range: the bits that exist, x elsewhere.
    let out = allX(w);
    for (let k = 0; k < w; k++) {
      const b = bit(a, lo + k);
      out = withBits(out, k, b);
    }
    return out;
  }
  return norm(w, a.v >>> lo, a.x >>> lo, a.z >>> lo);
}

/** `a` with `b`'s bits written at position `lo` (bits past `a.w` dropped). */
export function withBits(a, lo, b) {
  if (lo >= a.w || lo + b.w <= 0) return a;
  const m = ((mask(b.w) * 2 ** lo) % 2 ** 32) >>> 0;
  const place = (bits) => ((bits * 2 ** lo) % 2 ** 32) >>> 0;
  return norm(
    a.w,
    (a.v & ~m) | (place(b.v) & m),
    (a.x & ~m) | (place(b.x) & m),
    (a.z & ~m) | (place(b.z) & m),
  );
}

/** Concatenate, most significant first. */
export function concat(parts) {
  let w = 0;
  let v = 0;
  let x = 0;
  let z = 0;
  for (let k = parts.length - 1; k >= 0; k--) {
    const p = parts[k];
    const shift = 2 ** w;
    v += p.v * shift;
    x += p.x * shift;
    z += p.z * shift;
    w += p.w;
  }
  return norm(Math.min(w, MAX_WIDTH), v % 2 ** 32, x % 2 ** 32, z % 2 ** 32);
}

// ── Bitwise ─────────────────────────────────────────────────────────────────
// Operands are already resized to the result width by the caller (sizing is
// the interpreter's: IEEE 1364's context-determined rules).

export function and(a, b) {
  const w = a.w;
  const zero = (~a.v & ~a.x) | (~b.v & ~b.x); // a known 0 on either side
  const x = (a.x | b.x) & ~zero;
  return norm(w, a.v & b.v, x, 0);
}

export function or(a, b) {
  const w = a.w;
  const one = a.v | b.v; // a known 1 on either side (unknowns carry v = 0)
  return norm(w, one, (a.x | b.x) & ~one, 0);
}

export function xor(a, b) {
  return norm(a.w, a.v ^ b.v, a.x | b.x, 0);
}

export function xnor(a, b) {
  return norm(a.w, ~(a.v ^ b.v), a.x | b.x, 0);
}

export function not(a) {
  return norm(a.w, ~a.v, a.x, 0);
}

// ── Reductions and truth (1-bit results) ───────────────────────────────────

const X1 = Object.freeze(norm(1, 0, 1, 0));
const ZERO1 = Object.freeze(known(1, 0));
const ONE1 = Object.freeze(known(1, 1));

/** A JS boolean as a 1-bit value. */
export const bool = (b) => (b ? ONE1 : ZERO1);

export function reduceAnd(a) {
  const m = mask(a.w);
  if ((~a.v & ~a.x & m) >>> 0) return ZERO1; // a known 0
  return a.x ? X1 : ONE1;
}

export function reduceOr(a) {
  if (a.v) return ONE1;
  return a.x ? X1 : ZERO1;
}

export function reduceXor(a) {
  if (a.x) return X1;
  let v = a.v;
  let p = 0;
  while (v) {
    p ^= v & 1;
    v >>>= 1;
  }
  return bool(p === 1);
}

/** A value's truth: 1 if any bit is a known 1, 0 if every bit is a known 0,
    else x. What `if`, `!`, `&&`, `||` and `?:` test. */
export function truth(a) {
  if (a.v) return ONE1;
  return a.x ? X1 : ZERO1;
}

/** "true" / "false" / "unknown" for a truth value. */
export function truthOf(a) {
  const t = truth(a);
  return t.x ? "x" : t.v ? "1" : "0";
}

export function logicalNot(a) {
  const t = truth(a);
  return t.x ? X1 : bool(!t.v);
}

export function logicalAnd(a, b) {
  const ta = truthOf(a);
  const tb = truthOf(b);
  if (ta === "0" || tb === "0") return ZERO1;
  if (ta === "1" && tb === "1") return ONE1;
  return X1;
}

export function logicalOr(a, b) {
  const ta = truthOf(a);
  const tb = truthOf(b);
  if (ta === "1" || tb === "1") return ONE1;
  if (ta === "0" && tb === "0") return ZERO1;
  return X1;
}

// ── Arithmetic (any unknown bit → all x) ───────────────────────────────────

const arith = (a, b, fn) =>
  a.x || b.x ? allX(a.w) : known(a.w, fn(a.v, b.v) >>> 0);

export const add = (a, b) => arith(a, b, (p, q) => p + q);
export const sub = (a, b) => arith(a, b, (p, q) => p - q);
export const mul = (a, b) => arith(a, b, (p, q) => Math.imul(p, q));
export function div(a, b) {
  if (a.x || b.x || b.v === 0) return allX(a.w);
  return known(a.w, Math.floor(a.v / b.v));
}
export function mod(a, b) {
  if (a.x || b.x || b.v === 0) return allX(a.w);
  return known(a.w, a.v % b.v);
}
export function negate(a) {
  return a.x ? allX(a.w) : known(a.w, -a.v >>> 0);
}

// ── Comparison (1-bit results) ─────────────────────────────────────────────

export function lt(a, b) {
  return a.x || b.x ? X1 : bool(a.v < b.v);
}
export function le(a, b) {
  return a.x || b.x ? X1 : bool(a.v <= b.v);
}
export function gt(a, b) {
  return a.x || b.x ? X1 : bool(a.v > b.v);
}
export function ge(a, b) {
  return a.x || b.x ? X1 : bool(a.v >= b.v);
}

/** `==`: 0 as soon as two KNOWN bits differ, x if any bit is unknown,
    else 1. */
export function eq(a, b) {
  const both = ~(a.x | b.x) & mask(a.w);
  if (((a.v ^ b.v) & both) >>> 0) return ZERO1;
  return a.x || b.x ? X1 : ONE1;
}
export function ne(a, b) {
  const r = eq(a, b);
  return r.x ? X1 : bool(!r.v);
}

/** `===`: the four states compared exactly — never x. */
export function caseEq(a, b) {
  return bool(a.v === b.v && a.x === b.x && a.z === b.z);
}
export function caseNe(a, b) {
  return bool(!(a.v === b.v && a.x === b.x && a.z === b.z));
}

// ── Shifts (an unknown amount → all x) ─────────────────────────────────────

export function shl(a, n) {
  if (n.x) return allX(a.w);
  const k = n.v;
  if (k >= a.w) return known(a.w, 0);
  const s = 2 ** k;
  return norm(a.w, (a.v * s) % 2 ** 32, (a.x * s) % 2 ** 32, (a.z * s) % 2 ** 32); // prettier-ignore
}

export function shr(a, n) {
  if (n.x) return allX(a.w);
  const k = n.v;
  if (k >= a.w) return known(a.w, 0);
  return norm(a.w, a.v >>> k, a.x >>> k, a.z >>> k);
}

// ── The ternary ─────────────────────────────────────────────────────────────

/** `c ? a : b` with c already reduced to its truth: an unknown condition
    keeps the bits both branches agree on and makes the rest x. */
export function choose(c, a, b) {
  const t = truthOf(c);
  if (t === "1") return a;
  if (t === "0") return b;
  const same = ~(a.v ^ b.v) & ~a.x & ~b.x;
  return norm(a.w, a.v & same, ~same, 0);
}

/** Exactly equal (all four states, same width)? */
export function same(a, b) {
  return a.w === b.w && a.v === b.v && a.x === b.x && a.z === b.z;
}

/** The value as plain data for a state snapshot: `[v, x, z]`. */
export const pack = (a) => [a.v, a.x, a.z];

/** A packed `[v, x, z]` back into a value of width `w`. */
export const unpack = (w, p) => norm(w, p?.[0] ?? 0, p?.[1] ?? mask(w), p?.[2] ?? 0); // prettier-ignore

/**
 * A value as Verilog would print it, for the watch panel: `1'b0`, `4'b10x1`,
 * `8'hA5`. Binary up to 8 bits (or whenever a bit is unknown — hex cannot
 * show a single x), hex beyond.
 */
export function format(a) {
  if (a.w <= 8 || a.x) {
    let s = "";
    for (let k = a.w - 1; k >= 0; k--) {
      const xb = (a.x >>> k) & 1;
      const zb = (a.z >>> k) & 1;
      s += xb ? (zb ? "z" : "x") : String((a.v >>> k) & 1);
    }
    return `${a.w}'b${s}`;
  }
  return `${a.w}'h${a.v.toString(16).toUpperCase().padStart(Math.ceil(a.w / 4), "0")}`; // prettier-ignore
}

/** The value as an unsigned decimal, or null when any bit is unknown. */
export function decimal(a) {
  return a.x ? null : a.v;
}
