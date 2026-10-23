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

// integration-names.js — the one check of a name the user types for an
// Output, an Input, a Data bus or one of their fields, made AS it is typed
// (the Properties card's Name box and the Pins editor turn red, saying why,
// and refuse the text at the field — a combo's rule).
//
// What is refused is what no generated source could hold as written:
//
//   · a CONTROL character, in any name (a NUL in a header is a broken file,
//     a pasted line break a broken comment) — a Data bus's too, though its
//     name never reaches code;
//   · for a FIELD — whose name becomes a parameter, in C++ and in Python — a
//     word either LANGUAGE reserves for itself: a keyword (C++20's and
//     Python's included), `errno` and its kind, or the implementation's own
//     spelling (`__LINE__`, `_Pragma`).
//
// Not refused: a name the generated code merely USES already (`delay`,
// `max`, the header's own members), or one in capitals that may be a core's
// macro — the generator renames those and says so (planIdentifiers'
// warnings), as it renames anything a file from an older version carries.
// An element's own name gains In/Out (`intIn`), so it is never a keyword.

import {
  CPP_WORDS,
  RESERVED_SPELLING,
  cIdentifier,
} from "./integration-codegen.js";
import { PY_WORDS, pyIdentifier } from "./integration-codegen-python.js";

/** C0 and C1 controls, DEL, and the two Unicode line separators. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

/**
 * What is wrong with a name, or null when it is fine.
 *
 * @param {string} name - the text as typed.
 * @param {{field?: boolean}} [opts] - `field`: it names a field (a
 *   parameter in the generated code), not an element.
 * @returns {null|{code: "control"}|{code: "reserved", word: string,
 *   language: string}} `language` is "C++" or "Python" — a format name,
 *   never translated.
 */
export function integrationNameProblem(name, { field = false } = {}) {
  const text = String(name ?? "");
  if (CONTROL.test(text)) return { code: "control" };
  if (!field) return null;
  const c = cIdentifier(text, "");
  if (c && (CPP_WORDS.has(c) || RESERVED_SPELLING.test(c))) {
    return { code: "reserved", word: c, language: "C++" };
  }
  const py = pyIdentifier(text, "");
  if (py && PY_WORDS.has(py)) {
    return { code: "reserved", word: py, language: "Python" };
  }
  return null;
}
