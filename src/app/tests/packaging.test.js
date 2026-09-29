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

// packaging.test.js — the Mac App Store build configuration, and what every
// mac build ships.
//
// Everything here fails LATE and expensively otherwise: a mistyped entitlements
// path surfaces as a codesign error minutes into `make mas`, and a wrong key in
// the plist surfaces as an App Store validation rejection or, worse, as a
// feature that silently stops working a launch after install. None of it needs
// a Mac to check — it is all a file that exists and a plist that says what it
// should — so it is checked here, on every `make test`, on every platform.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/** The electron-builder config, and the directory its paths are relative to. */
const SRC = path.join(__dirname, "..", "..");
const build = require("../../package.json").build;

/** Parse a plist's <key> names and the boolean each maps to. */
function readPlist(file) {
  const xml = fs.readFileSync(file, "utf8");
  const keys = {};
  const re = /<key>([^<]+)<\/key>\s*<(true|false)\s*\/>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    keys[m[1]] = m[2] === "true";
  }
  return keys;
}

const masPlist = () => readPlist(path.join(SRC, build.mas.entitlements));

test("the MAS build is configured at all", () => {
  assert.ok(
    build.mas,
    "build.mas is missing — `make mas` has nothing to build",
  );
  assert.ok(build.masDev, "build.masDev is missing — `make mas-dev` likewise");
  assert.equal(build.mas.type, "distribution");
  assert.equal(build.masDev.type, "development");
  // The .pkg the store takes, one binary for both architectures.
  assert.deepEqual(build.mas.target, [{ target: "pkg", arch: ["universal"] }]);
});

test("the App Sandbox and the hardened runtime are not both claimed", () => {
  // They are mutually exclusive; asking for both is a build that fails to sign.
  assert.equal(build.mas.hardenedRuntime, false);
  // The App Store notarizes what it accepts — asking electron-builder to do it
  // is an error, not a belt-and-braces.
  assert.equal(build.mas.notarize, false);
  assert.equal(build.masDev.notarize, false);
});

test("every file the mas/masDev blocks name resolves under src/", () => {
  // Paths in the build block are relative to src/ (where package.json lives).
  // A typo here costs a full build before codesign says "cannot read
  // entitlement data".
  for (const flavour of ["mas", "masDev"]) {
    for (const key of [
      "entitlements",
      "entitlementsInherit",
      "provisioningProfile",
    ]) {
      const rel = build[flavour][key];
      assert.ok(rel, `${flavour}.${key} is not set`);
      // The PROFILES are git-ignored Apple material, so a fresh clone has none
      // — the Makefile targets skip in that case, and so does this assertion.
      if (
        key === "provisioningProfile" &&
        !fs.existsSync(path.join(SRC, rel))
      ) {
        continue;
      }
      assert.ok(
        fs.existsSync(path.join(SRC, rel)),
        `${flavour}.${key} → ${rel} does not exist`,
      );
    }
  }
});

test("the sandbox entitlements ask for what the app needs, and no more", () => {
  const keys = masPlist();
  for (const required of [
    "com.apple.security.app-sandbox",
    "com.apple.security.cs.allow-jit",
    "com.apple.security.files.user-selected.read-write",
    // Without this one the dialogs hand back EMPTY bookmarks and Open Recent
    // plus the datasheet folder quietly stop working a launch after install —
    // the single most expensive thing on this list to discover in the wild.
    "com.apple.security.files.bookmarks.app-scope",
    "com.apple.security.network.client",
    // The Arduino serial integration opens a board's /dev/cu.* node while the
    // circuit runs; the sandbox refuses that without it.
    "com.apple.security.device.serial",
  ]) {
    assert.equal(keys[required], true, `${required} must be granted`);
  }
  for (const forbidden of [
    "com.apple.security.cs.disable-library-validation", // rejected outright
    "com.apple.security.cs.allow-unsigned-executable-memory", // hardened-runtime only
    "com.apple.security.network.server", // nothing listens
  ]) {
    assert.ok(!(forbidden in keys), `${forbidden} must not be requested`);
  }
});

test("the helper processes inherit the container and nothing else", () => {
  const keys = readPlist(path.join(SRC, build.mas.entitlementsInherit));
  assert.deepEqual(keys, {
    "com.apple.security.app-sandbox": true,
    "com.apple.security.inherit": true,
  });
});

test("the store build declares its encryption exemption once, for both macs", () => {
  // Stock TLS only, so the answer is the same either side and stating it in
  // the build stops App Store Connect asking per submission.
  for (const flavour of ["mac", "mas"]) {
    assert.equal(
      build[flavour].extendInfo?.ITSAppUsesNonExemptEncryption,
      false,
    );
  }
});

test("each desktop build ships only its own platform's build of the serial port's native module", () => {
  // @serialport/bindings-cpp carries a prebuilt .node for every platform, and
  // a build needs only its own: mac's is one universal binary for both
  // architectures (mas/masDev inherit mac's options), Windows' and Linux's
  // one per architecture. Each build's pattern must exclude every OTHER
  // platform present — so a platform a serialport update adds fails here
  // rather than riding along unnoticed — and must never exclude its own.
  const dir = path.join(SRC, "node_modules/@serialport/bindings-cpp/prebuilds");
  const present = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const platformOf = (p) => p.split("-")[0];
  const pattern = new RegExp(
    String.raw`^!node_modules/@serialport/bindings-cpp/prebuilds/\{([a-z0-9,]+)\}-\*/\*\*$`,
  );
  for (const [key, own] of [
    ["mac", "darwin"],
    ["win", "win32"],
    ["linux", "linux"],
  ]) {
    const files = build[key].files ?? [];
    assert.equal(files.length, 1, `${key}: one exclusion`);
    const m = pattern.exec(files[0]);
    assert.ok(m, `${key}: the exclusion is the prebuilds pattern`);
    const excluded = new Set(m[1].split(","));
    assert.ok(!excluded.has(own), `${key} must keep ${own}'s own binary`);
    for (const p of present) {
      if (platformOf(p) === own) continue;
      assert.ok(
        excluded.has(platformOf(p)),
        `${p}'s binary would ship in ${key}`,
      );
    }
    if (present.length) {
      assert.ok(
        present.some((p) => platformOf(p) === own),
        `and ${own}'s own binary is still there for ${key} to ship`,
      );
    }
  }
  assert.equal(build.mas.files, undefined, "mas inherits mac's");
  assert.equal(build.masDev.files, undefined, "masDev likewise");
});

test("the test suites stay out of the app", () => {
  // `app/**/*` and `web/**/*` take everything under them, so without these the
  // package carried ~70 K lines of tests and fixtures to every user. Nothing
  // at runtime reaches into a tests/ directory, so the exclusion costs nothing.
  for (const dir of ["app/tests/**", "web/scripts/tests/**"]) {
    assert.ok(build.files.includes(`!${dir}`), `excludes ${dir}`);
  }
});

test("the Linux packages start on a stock system", () => {
  // The legacy AppImage toolset's arm64 launcher links the UNVERSIONED
  // libz.so, which only zlib's -dev package provides, so it would not start
  // on a stock Raspberry Pi OS or Ubuntu; 1.0.2's launcher is static.
  assert.equal(build.toolsets?.appimage, "1.0.2");
  // A deb's `depends` REPLACES electron-builder's defaults, so they are all
  // restated, plus the two libraries Electron loads that the defaults leave
  // out: a minimal system installed the package and then could not start it
  // ("libasound.so.2" / "libgbm.so.1: cannot open shared object file").
  const defaults = [
    "libgtk-3-0",
    "libnotify4",
    "libnss3",
    "libxss1",
    "libxtst6",
    "xdg-utils",
    "libatspi2.0-0",
    "libuuid1",
    "libsecret-1-0",
  ];
  const depends = build.deb?.depends ?? [];
  for (const d of defaults) assert.ok(depends.includes(d), `deb keeps ${d}`);
  assert.ok(
    depends.includes("libasound2t64 | libasound2"),
    "sound (t64 or not)",
  );
  assert.ok(depends.includes("libgbm1"), "the GPU buffer library");
});
