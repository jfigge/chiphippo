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

// cli-args.js — pure parser for the launch flags Chip Hippo understands.
// Kept dependency-free and side-effect-free so it is trivially unit-testable
// (see app/tests/cli-args.test.js). main.js calls parseArgs(process.argv).
"use strict";

/**
 * Parse Chip Hippo's recognized launch flags out of an argv array.
 *
 * @param {string[]} argv - typically process.argv (the leading node/electron
 *   and script entries are ignored; we only look for known flags anywhere).
 * @returns {{ dev: boolean, hotReload: boolean, devTools: boolean }}
 */
function parseArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  return {
    dev: args.includes("--dev"),
    hotReload: args.includes("--hot-reload"),
    // Open DevTools on launch. Kept separate from --hot-reload so the primary
    // dev workflow can reload without the panel popping open every time.
    devTools: args.includes("--devtools"),
  };
}

module.exports = { parseArgs };
