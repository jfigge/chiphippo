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

// highlight.js — what the designer's code editor colours, from the very token
// stream the compiler reads (lexer.js), so a highlight can never disagree
// with how the code is parsed. Pure: the editor turns these runs into spans.
//
// An identifier that names a PIN (a port of the module) is marked as one —
// that is what the editor's two-way hover linking keys on: a pin name in the
// code lights the pin on the package, and a pin on the package lights its
// names in the code.

import { tokenize } from "./lexer.js";

/**
 * The coloured runs of a body, in order and non-overlapping.
 * @param {string} source
 * @param {{pins?: Set<string>|string[], signals?: Set<string>|string[]}}
 *   [names] - the port names, and the body's own reg/wire/param names.
 * @returns {Array<{start: number, end: number, cls: string, name?: string,
 *   bit?: number|null}>} `cls` one of keyword | number | comment | operator |
 *   pin | signal | name | bad | string.
 */
export function highlightRuns(source, names = {}) {
  const pins = new Set(names.pins ?? []);
  const signals = new Set(names.signals ?? []);
  const { tokens } = tokenize(source);
  const runs = [];
  tokens.forEach((t, i) => {
    let cls;
    switch (t.type) {
      case "keyword":
        cls = "keyword";
        break;
      case "number":
        cls = "number";
        break;
      case "comment":
        cls = "comment";
        break;
      case "op":
        cls = "operator";
        break;
      case "string":
        cls = "string";
        break;
      case "ident":
        cls = pins.has(t.text)
          ? "pin"
          : signals.has(t.text)
            ? "signal"
            : "name";
        break;
      default:
        cls = "bad";
    }
    const run = { start: t.start, end: t.end, cls };
    if (t.type === "ident") {
      run.name = t.text;
      // `Q[2]` names one bit of a vector pin — the package lights that pin.
      run.bit = constantIndexAfter(tokens, i);
    }
    runs.push(run);
  });
  return runs;
}

/** The constant index of `name[ N ]` right after token `i`, or null. */
function constantIndexAfter(tokens, i) {
  const open = tokens[i + 1];
  const num = tokens[i + 2];
  const close = tokens[i + 3];
  if (open?.text !== "[" || close?.text !== "]" || num?.type !== "number") {
    return null;
  }
  if (num.base !== "d" || !/^[0-9_]+$/.test(num.digits)) return null;
  return Number(num.digits.replace(/_/g, ""));
}

/**
 * The run under a character offset, or null — the editor's hover lookup.
 * @param {ReturnType<typeof highlightRuns>} runs
 * @param {number} offset
 */
export function runAt(runs, offset) {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = runs[mid];
    if (offset < r.start) hi = mid - 1;
    else if (offset >= r.end) lo = mid + 1;
    else return r;
  }
  return null;
}

/**
 * The names a body DECLARES — its regs, wires, integers, arrays and
 * parameters, a named block's own among them — read straight
 * off the tokens, so the editor can colour them even while the code does not
 * compile (when the analyzer has nothing to say).
 * @param {string} source
 * @returns {string[]}
 */
export function declaredNames(source) {
  const tokens = tokenize(source).tokens.filter((t) => t.type !== "comment");
  const names = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "keyword") continue;
    if (!["reg", "wire", "integer", "localparam", "parameter"].includes(t.text)) continue; // prettier-ignore
    let depth = 0;
    let expectName = true;
    for (let j = i + 1; j < tokens.length; j++) {
      const u = tokens[j];
      if (u.text === ";" && depth === 0) break;
      if (u.text === "[" || u.text === "(" || u.text === "{") depth += 1;
      else if (u.text === "]" || u.text === ")" || u.text === "}") depth -= 1;
      else if (depth === 0 && u.text === ",") expectName = true;
      else if (depth === 0 && expectName && u.type === "ident") {
        names.push(u.text);
        expectName = false;
      } else if (depth === 0 && u.text === "=") expectName = false;
    }
  }
  return names;
}
