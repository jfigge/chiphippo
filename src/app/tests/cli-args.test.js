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

// Smoke tests for the pure launch-flag parser — also proves `make test`
// exercises the Node built-in test runner end to end.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseArgs } = require("../cli-args");

test("parseArgs: all flags default to off", () => {
  assert.deepEqual(parseArgs(["electron", "app/main.js"]), {
    dev: false,
    hotReload: false,
    devTools: false,
  });
});

test("parseArgs: recognizes each flag anywhere in argv", () => {
  const parsed = parseArgs([
    "electron",
    "app/main.js",
    "--hot-reload",
    "--user-data-dir=/tmp/data",
    "--devtools",
    "--dev",
  ]);
  assert.deepEqual(parsed, { dev: true, hotReload: true, devTools: true });
});

test("parseArgs: tolerates missing or non-array input", () => {
  assert.deepEqual(parseArgs(), {
    dev: false,
    hotReload: false,
    devTools: false,
  });
  assert.deepEqual(parseArgs(null), {
    dev: false,
    hotReload: false,
    devTools: false,
  });
});
