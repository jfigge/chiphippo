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

// union-find.js — a tiny disjoint-set forest over arbitrary string keys, the
// engine of the netlist. Path compression on find + union by size keep the
// whole build effectively linear. Pure and DOM-free (Feature 90 reuses it).

export class UnionFind {
  #parent = new Map(); // key → parent key
  #size = new Map(); // root key → set size

  /** Ensure `key` exists as its own singleton set. Returns `key`. */
  add(key) {
    if (!this.#parent.has(key)) {
      this.#parent.set(key, key);
      this.#size.set(key, 1);
    }
    return key;
  }

  /** The representative root of `key` (adds it if unseen). */
  find(key) {
    this.add(key);
    let root = key;
    while (this.#parent.get(root) !== root) root = this.#parent.get(root);
    // Path compression: point every node on the walk straight at the root.
    let node = key;
    while (this.#parent.get(node) !== root) {
      const next = this.#parent.get(node);
      this.#parent.set(node, root);
      node = next;
    }
    return root;
  }

  /** Merge the sets containing `a` and `b` (both added if unseen). */
  union(a, b) {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    // Union by size — attach the smaller tree under the larger.
    if (this.#size.get(ra) < this.#size.get(rb)) [ra, rb] = [rb, ra];
    this.#parent.set(rb, ra);
    this.#size.set(ra, this.#size.get(ra) + this.#size.get(rb));
    this.#size.delete(rb);
  }

  /** Every key added so far, in insertion order. */
  keys() {
    return [...this.#parent.keys()];
  }

  /**
   * Group every key by its final root: `Map<rootKey, memberKey[]>`. Members
   * keep insertion order within each group.
   */
  groups() {
    const out = new Map();
    for (const key of this.#parent.keys()) {
      const root = this.find(key);
      if (!out.has(root)) out.set(root, []);
      out.get(root).push(key);
    }
    return out;
  }
}
