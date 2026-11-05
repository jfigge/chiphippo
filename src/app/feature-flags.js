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

// feature-flags.js — which unfinished features this launch switches on. Pure
// and dependency-free (app/tests/feature-flags.test.js), like cli-args.js.
//
// A FLAG HIDES WORK IN PROGRESS, it is not a preference: nothing in the app
// turns one on, there is no Settings row for it, and a shipped build with none
// set behaves exactly as if the feature had never been written. Three places
// can name one, all of them the developer's:
//
//   · the command line — `--features=<name>` (`make debug FEATURES=<name>`);
//   · the environment — `CHIPHIPPO_FEATURES=<name>`;
//   · settings.json's `features` list, edited by hand (a packaged build has no
//     command line worth the name). MAIN_OWNED, so the renderer can never
//     write it: a flagged feature may reach the network, and a renderer that
//     could switch a flag on could switch that on.
//
// The web build has no command line either: its `process.argv` stand-in
// carries `?features=` from the page's own address (web-host/node/globals.js).
//
// Resolved ONCE per launch (main.js `features()`), so a flag cannot change
// under a running session — the IPC handlers it gates are registered once.
// A name not in FEATURES is ignored rather than refused: a flag retired
// after its feature ships must not stop an old settings file from loading.
//
// None today: the gallery's flag was retired when it shipped (Jason,
// 2026-11-05), so a stored or typed `gallery` is now ignored. The machinery
// stays for the next unfinished feature — add its name to FEATURES and read
// it in main as `features().includes(name)`, in the renderer as
// `featureEnabled(name)`.
"use strict";

/** Every flag this build knows, and what it hides. */
const FEATURES = Object.freeze([]);

const ARG_PREFIX = "--features=";

/** The known flags named in a comma- or space-separated list (or array). */
function parseFeatureList(value, known = FEATURES) {
  const words = Array.isArray(value)
    ? value.filter((v) => typeof v === "string")
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];
  const named = new Set(words.map((w) => w.trim().toLowerCase()));
  return known.filter((f) => named.has(f));
}

/**
 * The flags a launch switches on: the union of the command line, the
 * environment and the stored list, in FEATURES order.
 * @param {{argv?: string[], env?: object, stored?: unknown,
 *   known?: readonly string[]}} [sources] - `known` is FEATURES but for the
 *   tests, which need a flag to switch.
 * @returns {readonly string[]}
 */
function resolveFeatures({
  argv = [],
  env = {},
  stored = null,
  known = FEATURES,
} = {}) {
  const on = new Set(parseFeatureList(stored, known));
  for (const arg of Array.isArray(argv) ? argv : []) {
    if (typeof arg === "string" && arg.startsWith(ARG_PREFIX)) {
      for (const f of parseFeatureList(arg.slice(ARG_PREFIX.length), known)) {
        on.add(f);
      }
    }
  }
  for (const f of parseFeatureList(env?.CHIPHIPPO_FEATURES, known)) on.add(f);
  return Object.freeze(known.filter((f) => on.has(f)));
}

module.exports = { FEATURES, parseFeatureList, resolveFeatures };
