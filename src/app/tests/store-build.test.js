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

// store-build.test.js — the runtime store-build predicate (Feature 280).
//
// Every store gate funnels through these four helpers (today: the self-updater,
// the omitted "Check for Updates…" menu item, and the About tab's hidden
// controls), so pinning their truth table is the highest-value coverage the
// feature has — the gate itself can only be proved by building for a store.
// They read Electron's process.mas / process.windowsStore globals, which are
// toggled directly here; Node sets neither, so the default is a direct build.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const sb = require("../store-build");

/** Run `fn` with the two Electron flags forced, restoring them afterwards. */
function withFlags({ mas, windowsStore }, fn) {
  const hadMas = "mas" in process ? process.mas : undefined;
  const hadWin = "windowsStore" in process ? process.windowsStore : undefined;
  try {
    process.mas = mas;
    process.windowsStore = windowsStore;
    fn();
  } finally {
    process.mas = hadMas;
    process.windowsStore = hadWin;
  }
}

test("direct build (neither flag set) is not a store build", () => {
  withFlags({ mas: undefined, windowsStore: undefined }, () => {
    assert.equal(sb.isMas(), false);
    assert.equal(sb.isAppx(), false);
    assert.equal(sb.isStoreBuild(), false);
    assert.equal(sb.distribution(), "direct");
  });
});

test("Mac App Store build (process.mas) is a store build, MAS-scoped", () => {
  withFlags({ mas: true, windowsStore: undefined }, () => {
    assert.equal(sb.isMas(), true);
    assert.equal(sb.isAppx(), false);
    assert.equal(sb.isStoreBuild(), true);
    assert.equal(sb.distribution(), "store");
  });
});

test("Microsoft Store build (process.windowsStore) is a store build, not MAS", () => {
  withFlags({ mas: undefined, windowsStore: true }, () => {
    assert.equal(sb.isMas(), false);
    assert.equal(sb.isAppx(), true);
    assert.equal(sb.isStoreBuild(), true);
    assert.equal(sb.distribution(), "store");
  });
});

test("flags are strict-true only (a truthy non-true value is not a store build)", () => {
  // Electron sets these to `true` or leaves them undefined. Anything else is
  // someone else's `process` property, and must not disable the updater.
  withFlags({ mas: 1, windowsStore: "yes" }, () => {
    assert.equal(sb.isMas(), false);
    assert.equal(sb.isAppx(), false);
    assert.equal(sb.isStoreBuild(), false);
    assert.equal(sb.distribution(), "direct");
  });
});
