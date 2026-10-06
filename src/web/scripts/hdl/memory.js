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

// memory.js — the contents of a reg ARRAY (`reg [7:0] mem [0:32767];`) for
// the custom chip designer's interpreter: up to 32K four-state words, held so
// that a chip's state can stay plain, immutable data however big it is.
//
// A memory is a small persistent TRIE — 32-way, at most three levels for
// 32,768 words — whose leaves hold 32 words as `[v, x, z]` triples. A write
// copies the one path from the root to its leaf (three short arrays) and
// shares everything else, so:
//
//   · a memory nobody wrote is the SAME object it was, and the engine's
//     structural state comparison (sim/engine.js `sameState`) stops at the
//     first identical node — a 32K memory costs nothing per clock edge until
//     it is written;
//   · a fresh memory is all x and shares one frozen all-x subtree, as an
//     uninitialised Verilog array reads;
//   · a debugger frame can hold the memory as it stood at that statement just
//     by keeping a reference.
//
// Writing thousands of words at once (a `for` loop clearing the memory on
// reset) would copy a path per word, so a write may name a TRANSACTION
// (`newTx()`): nodes the transaction made are its own, and further writes
// into them happen in place. A transaction belongs to one evaluation and is
// dropped when it ends, which is what keeps every memory anyone else can see
// immutable. Pure: no DOM, no I/O.

import * as V from "./values.js";

const FAN = 32;
const LEAF = FAN * 3;

/** The all-x leaf and the all-x subtrees above it — shared by every fresh
    memory, and frozen, so nothing can ever write into them. */
const X_LEAF = Object.freeze(
  Array.from({ length: LEAF }, (_v, i) => (i % 3 === 1 ? 0xffffffff : 0)),
);
const X_TREE = [X_LEAF];
X_TREE.push(Object.freeze(Array(FAN).fill(X_TREE[0])));
X_TREE.push(Object.freeze(Array(FAN).fill(X_TREE[1])));

/** A transaction: writes under it may mutate the nodes it created. */
export function newTx() {
  return { owned: new WeakSet() };
}

/**
 * A fresh memory of `depth` words of `w` bits, every word x.
 * @param {number} w - 1…32.
 * @param {number} depth - 1…32,768.
 */
export function newMemory(w, depth) {
  const levels = depth <= FAN ? 1 : depth <= FAN * FAN ? 2 : 3;
  return { mem: true, w, depth, levels, root: X_TREE[levels - 1] };
}

/** Is this a memory (rather than a vector value)? */
export const isMemory = (m) => m?.mem === true;

/** Word `addr` (0-based), or x when there is no such word. */
export function readWord(m, addr) {
  if (!Number.isInteger(addr) || addr < 0 || addr >= m.depth) {
    return V.allX(m.w);
  }
  let node = m.root;
  for (let l = m.levels - 1; l >= 1; l--) node = node[(addr >>> (5 * l)) & 31];
  const k = (addr & 31) * 3;
  return V.make(m.w, node[k], node[k + 1], node[k + 2]);
}

/**
 * The memory with word `addr` set to `value` (already the word's width). An
 * address that is no word writes nothing, and a write that changes nothing
 * returns the memory itself.
 * @param {object} m
 * @param {number} addr
 * @param {object} value
 * @param {object|null} [tx] - a transaction (newTx), or null for a plain
 *   copy-on-write.
 */
export function writeWord(m, addr, value, tx = null) {
  if (!Number.isInteger(addr) || addr < 0 || addr >= m.depth) return m;
  const word = V.resize(value, m.w);
  if (V.same(readWord(m, addr), word)) return m;
  const owned = tx ? tx.owned : null;
  const own = (node) => {
    if (owned?.has(node)) return node;
    const copy = node.slice();
    owned?.add(copy);
    return copy;
  };
  let out = m;
  if (!owned?.has(m)) {
    out = { ...m };
    owned?.add(out);
  }
  out.root = own(m.root);
  let node = out.root;
  for (let l = m.levels - 1; l >= 1; l--) {
    const i = (addr >>> (5 * l)) & 31;
    node[i] = own(node[i]);
    node = node[i];
  }
  const k = (addr & 31) * 3;
  node[k] = word.v;
  node[k + 1] = word.x;
  node[k + 2] = word.z;
  return out;
}

/** Do two memories hold the same words? (Shared nodes are not looked into.) */
export function sameMemory(a, b) {
  if (a === b) return true;
  if (!isMemory(a) || !isMemory(b)) return false;
  if (a.depth !== b.depth || a.w !== b.w || a.levels !== b.levels) return false;
  return sameNode(a.root, b.root, V.mask(a.w));
}

/** Two nodes the same — a leaf's numbers compared within the word's width
    (the shared all-x leaf holds 32 bits of x for every width). */
function sameNode(a, b, m) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = b[i];
    if (p === q) continue;
    if (typeof p === "number" || typeof q === "number") {
      if ((p & m) >>> 0 !== (q & m) >>> 0) return false;
      continue;
    }
    if (!sameNode(p, q, m)) return false;
  }
  return true;
}

/** Words `from`… (at most `count`), as values — what a memory view shows. */
export function readWords(m, from, count) {
  const out = [];
  const end = Math.min(m.depth, from + count);
  for (let a = Math.max(0, from); a < end; a++) out.push(readWord(m, a));
  return out;
}

/**
 * The addresses at which two memories of one shape differ, each with the
 * word `b` holds there — the writes that took `a` to `b`. Shared subtrees
 * are skipped, so this costs what was written, not the memory's size.
 */
export function changedWords(a, b) {
  const out = [];
  if (!isMemory(a) || !isMemory(b) || a === b) return out;
  const m = V.mask(b.w);
  const differ = (x, y) => (x & m) >>> 0 !== (y & m) >>> 0;
  const walk = (p, q, level, base) => {
    if (p === q) return;
    if (level === 0) {
      for (let i = 0; i < FAN; i++) {
        const k = i * 3;
        if (
          differ(p[k], q[k]) ||
          differ(p[k + 1], q[k + 1]) ||
          differ(p[k + 2], q[k + 2])
        ) {
          // prettier-ignore
          const addr = base + i;
          if (addr < b.depth) out.push([addr, V.make(b.w, q[k], q[k + 1], q[k + 2])]); // prettier-ignore
        }
      }
      return;
    }
    const span = FAN ** level;
    for (let i = 0; i < FAN; i++) walk(p[i], q[i], level - 1, base + i * span);
  };
  walk(a.root, b.root, a.levels - 1, 0);
  return out;
}
