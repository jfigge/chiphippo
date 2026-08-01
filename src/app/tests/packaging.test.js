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

// packaging.test.js — the Mac App Store build configuration.
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
