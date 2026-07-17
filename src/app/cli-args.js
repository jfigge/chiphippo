/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
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
