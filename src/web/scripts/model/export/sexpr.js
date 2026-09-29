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

// sexpr.js — the S-expressions KiCad files are made of, built as plain arrays
// and printed the way KiCad prints them (one list per line, tab-indented, a
// short all-atom list kept on one line).
//
// A node is an ARRAY (a list) whose items are nodes, numbers, bare ATOMS
// (plain JS strings: `kicad_sch`, `yes`, `input`) or QUOTED strings, made with
// `q()`. The split matters: KiCad keywords are bare and every name, value and
// uuid is quoted, and a writer that guessed from the text would quote `yes`
// one day and fail to quote a net called `input` the next.
//
// Numbers print with at most four decimals and no trailing zeros — millimetres
// on KiCad's 1.27 mm grid never need more, and a float's binary tail
// (`2.5400000000000005`) must never reach a file a diff will be read against.

/** A quoted string node. */
export function q(text) {
  return { quoted: String(text ?? "") };
}

/** A number as KiCad writes one. */
export function num(n) {
  const r = Math.round(Number(n) * 10000) / 10000;
  return Object.is(r, -0) ? "0" : String(r);
}

function atom(item) {
  if (typeof item === "number") return num(item);
  if (item && typeof item === "object" && "quoted" in item) {
    return `"${item.quoted
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")}"`;
  }
  return String(item);
}

/** Lists short and flat enough to keep on one line. */
function inline(node) {
  return (
    node.length <= 6 &&
    node.every((item) => !Array.isArray(item)) &&
    node.map(atom).join(" ").length <= 100
  );
}

/**
 * Print a node.
 * @param {Array} node
 * @param {number} [depth]
 * @returns {string}
 */
export function formatSexpr(node, depth = 0) {
  const pad = "\t".repeat(depth);
  if (inline(node)) return `${pad}(${node.map(atom).join(" ")})`;
  // The head keeps its leading atoms on the opening line — `(symbol "U1"`,
  // `(pin input line` — and every nested list goes on a line of its own.
  const head = [];
  let i = 0;
  while (i < node.length && !Array.isArray(node[i])) head.push(atom(node[i++]));
  const lines = [`${pad}(${head.join(" ")}`];
  for (; i < node.length; i++) {
    const item = node[i];
    lines.push(
      Array.isArray(item)
        ? formatSexpr(item, depth + 1)
        : `${"\t".repeat(depth + 1)}${atom(item)}`,
    );
  }
  lines.push(`${pad})`);
  return lines.join("\n");
}

/**
 * Parse S-expression text back into nodes (quoted strings as `q()` objects,
 * numbers left as their text). Used by the tests to read a written file the
 * way KiCad would, and by nothing else.
 * @param {string} text
 * @returns {Array}
 */
export function parseSexpr(text) {
  let i = 0;
  const skip = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const read = () => {
    skip();
    if (text[i] === "(") {
      i++;
      const list = [];
      for (;;) {
        skip();
        if (i >= text.length) throw new Error("unbalanced: missing )");
        if (text[i] === ")") {
          i++;
          return list;
        }
        list.push(read());
      }
    }
    if (text[i] === '"') {
      i++;
      let out = "";
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") {
          i++;
          out += text[i] === "n" ? "\n" : text[i];
        } else out += text[i];
        i++;
      }
      if (text[i] !== '"') throw new Error("unterminated string");
      i++;
      return q(out);
    }
    const start = i;
    while (i < text.length && !/[\s()]/.test(text[i])) i++;
    if (start === i) throw new Error(`unexpected ${text[i]} at ${i}`);
    return text.slice(start, i);
  };
  const node = read();
  skip();
  if (i !== text.length) throw new Error("trailing text after the root list");
  return node;
}
