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

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

test("the donation link is offered everywhere but the Mac App Store", () => {
  // Apple's Guideline 3.1.1 bars a link to a purchase mechanism other than
  // in-app purchase (a tip jar counts); the Microsoft Store permits one.
  withFlags({ mas: undefined, windowsStore: undefined }, () => {
    assert.equal(sb.allowsDonations(), true, "direct");
  });
  withFlags({ mas: true, windowsStore: undefined }, () => {
    assert.equal(sb.allowsDonations(), false, "Mac App Store");
  });
  withFlags({ mas: undefined, windowsStore: true }, () => {
    assert.equal(sb.allowsDonations(), true, "Microsoft Store");
  });
});

/** Run `fn` with `process.resourcesPath` at a fresh folder, holding the
    package manager's marker when `marked`. */
function withResources(marked, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-res-"));
  if (marked) fs.writeFileSync(path.join(dir, sb.PACKAGE_MARKER), "");
  const had = process.resourcesPath;
  try {
    process.resourcesPath = dir;
    fn();
  } finally {
    process.resourcesPath = had;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a package manager's copy (the marker) updates through it, not itself", () => {
  withFlags({ mas: undefined, windowsStore: undefined }, () => {
    withResources(true, () => {
      assert.equal(sb.isPackageManaged(), true);
      assert.equal(sb.isStoreBuild(), false, "not a store");
      assert.equal(sb.distribution(), "package");
      assert.equal(sb.selfUpdates(), false);
      assert.equal(sb.allowsDonations(), true, "the donation link stays");
    });
    withResources(false, () => {
      assert.equal(sb.isPackageManaged(), false);
      assert.equal(sb.distribution(), "direct");
      assert.equal(sb.selfUpdates(), true);
    });
  });
});

test("a store build stays a store build even beside the marker", () => {
  withFlags({ mas: true, windowsStore: undefined }, () => {
    withResources(true, () => {
      assert.equal(sb.distribution(), "store");
      assert.equal(sb.selfUpdates(), false);
    });
  });
});

test("no resources folder (node --test, a dev run) is a direct build", () => {
  const had = process.resourcesPath;
  try {
    process.resourcesPath = undefined;
    assert.equal(sb.isPackageManaged(), false);
    assert.equal(sb.selfUpdates(), true);
  } finally {
    process.resourcesPath = had;
  }
});

test("a Windows portable copy does not update itself", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const had = process.env.PORTABLE_EXECUTABLE_DIR;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.PORTABLE_EXECUTABLE_DIR = "C:\\Users\\me\\Downloads";
    withFlags({ mas: undefined, windowsStore: undefined }, () => {
      assert.equal(sb.isPortable(), true);
      assert.equal(sb.distribution(), "portable");
      assert.equal(sb.selfUpdates(), false);
    });
    delete process.env.PORTABLE_EXECUTABLE_DIR;
    withFlags({ mas: undefined, windowsStore: undefined }, () => {
      assert.equal(sb.isPortable(), false, "the installed (NSIS) copy");
      assert.equal(sb.selfUpdates(), true);
    });
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (had === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR;
    else process.env.PORTABLE_EXECUTABLE_DIR = had;
  }
});
