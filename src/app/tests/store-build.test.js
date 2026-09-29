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
