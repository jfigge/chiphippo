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

// The one check of a name the user types for an Output, an Input, a Data bus
// or a field (model/integration-names.js): what no generated source could
// hold as written is refused; what the generator merely renames is not.

import test from "node:test";
import assert from "node:assert/strict";

import { integrationNameProblem as problem } from "../model/integration-names.js";

test("a control character is refused in any name", () => {
  for (const name of [
    "a\u0000b",
    "tab\there",
    "line\nbreak",
    "x\u007f",
    "\u0085",
    "a\u2028b",
  ]) {
    assert.deepEqual(problem(name), { code: "control" }, JSON.stringify(name));
    assert.deepEqual(problem(name, { field: true }), { code: "control" });
  }
});

test("a field may not be a word C++ or Python reserves for itself", () => {
  const cases = [
    ["int", "int", "C++"],
    ["errno", "errno", "C++"],
    ["requires", "requires", "C++"],
    ["co_await", "co_await", "C++"],
    ["char8_t", "char8_t", "C++"],
    ["__LINE__", "__LINE__", "C++"],
    ["_Pragma", "_Pragma", "C++"],
    ["__x", "__x", "C++"],
    // A spelling that only BECOMES one: punctuation and spaces drop out.
    [" in-t ", "int", "C++"],
    ["lambda", "lambda", "Python"],
    ["def", "def", "Python"],
    ["Yield", "yield", "Python"],
  ];
  for (const [name, word, language] of cases) {
    assert.deepEqual(
      problem(name, { field: true }),
      { code: "reserved", word, language },
      name,
    );
  }
});

test("what the generator only renames, and every element name, is fine", () => {
  // Names the sketch already uses, and capitals that may be a core's macro:
  // renamed (and reported) by planIdentifiers, never refused here.
  for (const name of [
    "delay",
    "max",
    "time",
    "HEX",
    "B0",
    "data",
    "_7",
    "value",
  ]) {
    assert.equal(problem(name, { field: true }), null, name);
  }
  // An element's name gains In/Out, so a keyword is not one any more.
  for (const name of ["int", "errno", "__LINE__", "lambda", "Output 1"]) {
    assert.equal(problem(name), null, name);
  }
  assert.equal(problem(""), null);
  assert.equal(problem("", { field: true }), null);
});
