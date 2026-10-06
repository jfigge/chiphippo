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

// compile.js — the Verilog subset's front door: a module body and the chip's
// port list in, a runnable Program (program.js) and every diagnostic out.
// lexer → parser → analyze → Program, cached on the source and the ports,
// since the same body is compiled by the catalog, the debugger and the
// designer window, and the engine asks for a chip's def on every settle.

import { tokenize, isIdentifier, diag } from "./lexer.js";
import { parse } from "./parser.js";
import { analyze } from "./analyze.js";
import { Program } from "./program.js";
import { moduleHeader } from "./header.js";

const CACHE_LIMIT = 64;
const cache = new Map();

/**
 * Compile a module body against its ports.
 *
 * @param {string} source - the body the user wrote (no module header).
 * @param {Array<{name: string, dir: "input"|"output", width: number}>} ports
 * @param {{name?: string}} [opts] - the module's name, for the header.
 * @returns {{ok: boolean, errors: object[], warnings: object[],
 *   program: Program|null, header: string, outputKind: Map<string,string>}}
 *   Errors and warnings are `{code, args, severity, start, end, line, col}`,
 *   ordered by position; a header problem (line 0) leads.
 */
export function compileModule(source, ports, opts = {}) {
  const key = JSON.stringify([source, ports, opts.name ?? ""]);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const result = build(source, ports, opts);
  cache.set(key, result);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return result;
}

function build(source, ports, opts) {
  const errors = [];
  const warnings = [];
  // The ports themselves first: a name the generated header could not
  // declare is no module at all.
  const seen = new Set();
  for (const p of ports ?? []) {
    if (!isIdentifier(p.name)) {
      errors.push(diag("badPortName", { start: 0, end: 0, line: 0, col: 0 }, { name: p.name })); // prettier-ignore
    } else if (seen.has(p.name)) {
      errors.push(diag("duplicatePort", { start: 0, end: 0, line: 0, col: 0 }, { name: p.name })); // prettier-ignore
    }
    seen.add(p.name);
  }
  const lexed = tokenize(source);
  errors.push(...lexed.errors);
  const parsed = parse(lexed.tokens);
  errors.push(...parsed.errors);
  let module = null;
  let outputKind = new Map();
  if (!errors.length) {
    const analysed = analyze(parsed, ports);
    errors.push(...analysed.errors);
    warnings.push(...analysed.warnings);
    module = analysed.module;
    if (module) outputKind = module.outputKind;
  }
  const byPosition = (a, b) => a.line - b.line || a.col - b.col;
  errors.sort(byPosition);
  warnings.sort(byPosition);
  const ok = errors.length === 0 && module != null;
  return {
    ok,
    errors,
    warnings,
    program: ok ? new Program(module) : null,
    header: moduleHeader(opts.name ?? "chip", ports ?? [], outputKind),
    outputKind,
    tokens: lexed.tokens,
  };
}
