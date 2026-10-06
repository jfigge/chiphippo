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

// lexer.js — the Verilog subset's tokenizer (the custom chip designer). One
// pass over the module BODY the user writes (the header is generated — see
// header.js), producing tokens that carry their own source span, so the
// editor can highlight from the very same stream the parser reads and a
// diagnostic can point at the characters it is about.
//
// The lexer knows the WHOLE of Verilog-2001's surface — every keyword is
// reserved and every operator is recognised — because a construct the subset
// does not implement must be REJECTED by name ("loops aren't supported"),
// never misread as something it is not. Deciding what is unsupported is the
// parser's job; the lexer only refuses what is not Verilog at all.
//
// Diagnostics are language-neutral `{code, args, start, end, line, col}`
// records: the compiler runs under node --test and in two windows, and every
// sentence a user reads is the renderer's (`hdl.diag.<code>` in the locales).

/** Every Verilog-2001 reserved word (IEEE 1364-2001 Annex B). None may be a
    pin, a reg or a wire name — real tools would refuse the code. */
export const KEYWORDS = new Set([
  "always", "and", "assign", "automatic", "begin", "buf", "bufif0", "bufif1",
  "case", "casex", "casez", "cell", "cmos", "config", "deassign", "default",
  "defparam", "design", "disable", "edge", "else", "end", "endcase",
  "endconfig", "endfunction", "endgenerate", "endmodule", "endprimitive",
  "endspecify", "endtable", "endtask", "event", "for", "force", "forever",
  "fork", "function", "generate", "genvar", "highz0", "highz1", "if",
  "ifnone", "incdir", "include", "initial", "inout", "input", "instance",
  "integer", "join", "large", "liblist", "library", "localparam", "macromodule",
  "medium", "module", "nand", "negedge", "nmos", "nor", "noshowcancelled",
  "not", "notif0", "notif1", "or", "output", "parameter", "pmos", "posedge",
  "primitive", "pull0", "pull1", "pulldown", "pullup", "pulsestyle_onevent",
  "pulsestyle_ondetect", "rcmos", "real", "realtime", "reg", "release",
  "repeat", "rnmos", "rpmos", "rtran", "rtranif0", "rtranif1", "scalared",
  "showcancelled", "signed", "small", "specify", "specparam", "strong0",
  "strong1", "supply0", "supply1", "table", "task", "time", "tran", "tranif0",
  "tranif1", "tri", "tri0", "tri1", "triand", "trior", "trireg", "unsigned",
  "use", "vectored", "wait", "wand", "weak0", "weak1", "while", "wire", "wor",
  "xnor", "xor",
]); // prettier-ignore

/** Operators and punctuation, longest first so `<<<` wins over `<<` over `<`. */
const OPERATORS = [
  "<<<", ">>>", "===", "!==",
  "<<", ">>", "==", "!=", "<=", ">=", "&&", "||", "~&", "~|", "~^", "^~",
  "+:", "-:", "**",
  "+", "-", "*", "/", "%", "<", ">", "!", "~", "&", "|", "^", "?", ":",
  "=", "(", ")", "[", "]", "{", "}", ",", ";", "@", "#", ".",
]; // prettier-ignore

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

/**
 * A number literal, as written: `12`, `4'b10_1x`, `'hFF`, `8'd255`, `1'bz`.
 * Group 1 the size, 2 the signed flag, 3 the base, 4 the digits.
 */
const BASED_RE =
  /^([0-9][0-9_]*)?\s*'([sS]?)([bBoOdDhH])\s*([0-9a-fA-FxXzZ?_]+)/;
const DECIMAL_RE = /^[0-9][0-9_]*/;

/**
 * Tokenize a body. Whitespace is dropped; comments are KEPT as tokens (the
 * highlighter draws them) and filtered by the parser.
 * @param {string} source
 * @returns {{tokens: Array<{type: string, text: string, start: number,
 *   end: number, line: number, col: number}>, errors: object[]}}
 *   `type` is one of ident | keyword | number | op | comment | system |
 *   directive | string | error.
 */
export function tokenize(source) {
  const text = typeof source === "string" ? source : "";
  const tokens = [];
  const errors = [];
  let i = 0;
  const push = (type, start, end, extra) => {
    const token = {
      type,
      text: text.slice(start, end),
      start,
      end,
      line: lineAt(start),
      col: colAt(start),
      ...extra,
    };
    tokens.push(token);
    return token;
  };
  // Line/column of an offset: a binary search over the line starts.
  const lines = [0];
  for (let k = 0; k < text.length; k++) if (text[k] === "\n") lines.push(k + 1);
  const lineAt = (offset) => {
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const colAt = (offset) => offset - lines[lineAt(offset) - 1] + 1;

  while (i < text.length) {
    const ch = text[i];
    if (
      ch === " " ||
      ch === "\t" ||
      ch === "\r" ||
      ch === "\n" ||
      ch === "\f"
    ) {
      i++;
      continue;
    }
    const start = i;
    // Comments.
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      push("comment", start, i);
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 2;
      const token = push("comment", start, i);
      if (close < 0) errors.push(diag("unterminatedComment", token));
      continue;
    }
    // Identifiers and keywords.
    if (IDENT_START.test(ch)) {
      i++;
      while (i < text.length && IDENT_PART.test(text[i])) i++;
      const word = text.slice(start, i);
      push(KEYWORDS.has(word) ? "keyword" : "ident", start, i);
      continue;
    }
    // System tasks/functions ($display) and compiler directives (`define):
    // recognised so they can be refused by name.
    if (ch === "$" && IDENT_START.test(text[i + 1] ?? "")) {
      i++;
      while (i < text.length && IDENT_PART.test(text[i])) i++;
      push("system", start, i);
      continue;
    }
    if (ch === "`") {
      i++;
      while (i < text.length && IDENT_PART.test(text[i])) i++;
      push("directive", start, i);
      continue;
    }
    if (ch === "\\") {
      // An escaped identifier: Verilog, but not this subset.
      while (i < text.length && !/\s/.test(text[i])) i++;
      const token = push("error", start, i);
      errors.push(diag("escapedIdentifier", token));
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"' && text[i] !== "\n") {
        if (text[i] === "\\") i++;
        i++;
      }
      if (text[i] === '"') i++;
      push("string", start, i);
      continue;
    }
    // Numbers: a based literal (optionally sized), else a plain decimal.
    if (
      DIGIT.test(ch) ||
      (ch === "'" && /[sSbBoOdDhH]/.test(text[i + 1] ?? ""))
    ) {
      const rest = text.slice(i, i + 80);
      const based = BASED_RE.exec(rest);
      if (based) {
        i += based[0].length;
        push("number", start, i, {
          size: based[1] != null ? based[1].replace(/_/g, "") : null,
          signed: based[2] !== "",
          base: based[3].toLowerCase(),
          digits: based[4],
        });
        continue;
      }
      const dec = DECIMAL_RE.exec(rest);
      if (dec) {
        i += dec[0].length;
        // A real number (1.5) or an exponent is not this subset's.
        if (text[i] === "." && DIGIT.test(text[i + 1] ?? "")) {
          while (i < text.length && /[0-9_.eE+-]/.test(text[i])) i++;
          const token = push("error", start, i);
          errors.push(diag("realNumber", token));
          continue;
        }
        push("number", start, i, {
          size: null,
          signed: false,
          base: "d",
          digits: dec[0],
        });
        continue;
      }
    }
    const op = OPERATORS.find((o) => text.startsWith(o, i));
    if (op) {
      i += op.length;
      push("op", start, i);
      continue;
    }
    i++;
    const token = push("error", start, i);
    errors.push(diag("badCharacter", token, { char: ch }));
  }
  return { tokens, errors };
}

/**
 * A diagnostic about a token (or any `{start, end, line, col}` span).
 * @param {string} code - the `hdl.diag.<code>` key.
 * @param {{start: number, end: number, line: number, col: number}} at
 * @param {object} [args] - the sentence's {placeholders}.
 * @param {"error"|"warning"} [severity]
 */
export function diag(code, at, args = {}, severity = "error") {
  return {
    code,
    args,
    severity,
    start: at?.start ?? 0,
    end: at?.end ?? at?.start ?? 0,
    line: at?.line ?? 1,
    col: at?.col ?? 1,
  };
}

/** Is `name` a legal Verilog identifier this subset accepts (and not a
    reserved word)? Pin and module names are held to it. */
export function isIdentifier(name) {
  return (
    typeof name === "string" &&
    /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) &&
    !KEYWORDS.has(name)
  );
}
