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

// build-versions.test.js — the release-asset classifier behind the website's
// download buttons (scripts/build-versions.mjs).
//
// A misclassification here is INVISIBLE from every side. The file downloads, the
// page renders, the link works — it is only the badge and the heading above it
// that lie, and nobody proofreads a download page against a release they cannot
// see. The heuristic used to be `/arm64|aarch64/ ? "arm64" : "x64"`, whose else
// branch asserted that every non-arm64 artifact was Intel 64-bit: a universal
// mac build (which `make mas` already produces) was offered to Apple Silicon
// visitors under the heading "Intel".
//
// The names below are what electron-builder ACTUALLY writes for this repo's
// targets — `${arch}` is spelled differently per target, which is the whole
// reason a vocabulary is needed. artifactName templates live in
// src/package.json ("Chip-Hippo-${version}-${arch}.${ext}", nsis overridden to
// carry "Setup"), and the test derives its own expectations from none of that
// on purpose: a hand-written name is the only way to notice the template moving.
//
// Importing the module must not reach the network — that is what the IS_MAIN
// guard in build-versions.mjs is for, and this import is what proves it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classify } from "../../../../scripts/build-versions.mjs";

const arch = (name) => (classify(name) || {}).arch;

// ── The names this repo really publishes ────────────────────────────────────

test("every artifact the release workflow builds is classified", () => {
  const cases = [
    // macOS — dmg + zip, arm64 and x64 (src/package.json build.mac.target)
    [
      "Chip-Hippo-0.9.1-arm64.dmg",
      { platform: "mac", arch: "arm64", kind: "dmg" },
    ],
    ["Chip-Hippo-0.9.1-x64.dmg", { platform: "mac", arch: "x64", kind: "dmg" }],
    [
      "Chip-Hippo-0.9.1-arm64.zip",
      { platform: "mac", arch: "arm64", kind: "zip" },
    ],
    ["Chip-Hippo-0.9.1-x64.zip", { platform: "mac", arch: "x64", kind: "zip" }],
    // Windows — the nsis installer carries "Setup"; the portable one does not.
    [
      "Chip-Hippo-Setup-0.9.1-x64.exe",
      { platform: "win", arch: "x64", kind: "setup" },
    ],
    [
      "Chip-Hippo-Setup-0.9.1-arm64.exe",
      { platform: "win", arch: "arm64", kind: "setup" },
    ],
    [
      "Chip-Hippo-0.9.1-x64.exe",
      { platform: "win", arch: "x64", kind: "portable" },
    ],
    [
      "Chip-Hippo-0.9.1-arm64.exe",
      { platform: "win", arch: "arm64", kind: "portable" },
    ],
    // Linux — AppImage spells x64 "x86_64", deb spells it "amd64".
    [
      "Chip-Hippo-0.9.1-x86_64.AppImage",
      { platform: "linux", arch: "x64", kind: "appimage" },
    ],
    [
      "Chip-Hippo-0.9.1-arm64.AppImage",
      { platform: "linux", arch: "arm64", kind: "appimage" },
    ],
    [
      "Chip-Hippo-0.9.1-amd64.deb",
      { platform: "linux", arch: "x64", kind: "deb" },
    ],
    [
      "Chip-Hippo-0.9.1-arm64.deb",
      { platform: "linux", arch: "arm64", kind: "deb" },
    ],
  ];
  for (const [name, want] of cases) {
    const got = classify(name);
    assert.ok(got, `${name} should classify`);
    assert.equal(got.platform, want.platform, name);
    assert.equal(got.arch, want.arch, name);
    assert.equal(got.kind, want.kind, name);
    assert.ok(got.label, `${name} should carry a label`);
    // A ratchet against dead data. Every field here is spread into
    // versions.json and served to every visitor, so one nothing reads is both
    // bytes on the wire and a wrong turn for whoever reads the file next.
    // `primary` was exactly that: written on all six branches, read nowhere.
    assert.deepEqual(
      Object.keys(got).sort(),
      ["arch", "kind", "label", "platform"],
      `${name}: classify should emit these four fields and no others`,
    );
  }
});

// ── The regression this file exists for ─────────────────────────────────────

test("a universal mac build is universal, NOT x64", () => {
  // The old heuristic answered "x64" here and filed it under "Intel".
  assert.equal(arch("Chip-Hippo-1.0.0-universal.dmg"), "universal");
  assert.equal(arch("Chip-Hippo-1.0.0-universal.zip"), "universal");
});

test("the Windows COMBINED installer is not x64", () => {
  // These two are real: every published release carries them, and they weigh
  // ~219 MB against the per-arch ~110 MB because they hold both builds. The old
  // heuristic badged them x64 and listed them under "Intel / AMD (64-bit)",
  // which put four indistinguishable rows on the Windows card.
  assert.equal(arch("Chip-Hippo-0.9.1.exe"), "universal");
  assert.equal(arch("Chip-Hippo-Setup-0.9.1.exe"), "universal");
  // The kind still separates them, so ordering by installer-vs-portable holds.
  assert.equal(classify("Chip-Hippo-0.9.1.exe").kind, "portable");
  assert.equal(classify("Chip-Hippo-Setup-0.9.1.exe").kind, "setup");
  // The rule is about the TEMPLATE, so it does not care which platform it is.
  assert.equal(arch("Chip-Hippo-1.0.0.dmg"), "universal");
  // ...but digits alone are not a version: this is an unknown arch, not combined.
  assert.equal(arch("Chip-Hippo-1.0.0-arm-64.deb"), null);
});

test("an architecture the table cannot name is null, never a guess", () => {
  // The distinction that earns NO_ARCH_SLOT its own rule: a name ending at the
  // version has no arch slot (combined, above), while a name ending in a token
  // this table has not met is unknown — and unknown must not be answered.
  // null is not a failure either: downloads.js gives an unnamed arch its own
  // heading rather than dropping the asset. A wrong badge is worse than none.
  assert.equal(arch("Chip-Hippo-1.0.0-riscv64.AppImage"), null);
  assert.equal(arch("Chip-Hippo-1.0.0-ppc64le.deb"), null);
  // ...but the asset itself still classifies, so the site still offers it.
  assert.equal(classify("Chip-Hippo-1.0.0-riscv64.AppImage").platform, "linux");
});

test("x86_64 reads as x64 — the ia32 row must not see its x86 prefix", () => {
  assert.equal(arch("Chip-Hippo-1.0.0-x86_64.AppImage"), "x64");
  assert.equal(arch("Chip-Hippo-1.0.0-x86-64.AppImage"), "x64");
  assert.equal(arch("Chip-Hippo-1.0.0-x86.exe"), "ia32");
  assert.equal(arch("Chip-Hippo-1.0.0-ia32.exe"), "ia32");
  assert.equal(arch("Chip-Hippo-1.0.0-i386.deb"), "ia32");
});

test("32-bit ARM is not 64-bit ARM", () => {
  assert.equal(arch("Chip-Hippo-1.0.0-armv7l.deb"), "armv7l");
  assert.equal(arch("Chip-Hippo-1.0.0-armhf.deb"), "armv7l");
  assert.equal(arch("Chip-Hippo-1.0.0-aarch64.AppImage"), "arm64");
});

test("an architecture is a whole token, never a substring", () => {
  // A product or tag that merely CONTAINS the letters must not be read as one.
  // That is the whole invariant here; what these names come out as instead is
  // the combined rule's business, and both of them end at a version, so they
  // have no arch slot at all.
  assert.notEqual(arch("Chip-Hippo-x64bit-1.0.0.dmg"), "x64");
  assert.notEqual(arch("Amd64bitEdition-1.0.0.dmg"), "x64");
  // Put the near-miss in the arch slot and it is unknown, not combined.
  assert.equal(arch("Chip-Hippo-1.0.0-x64bit.dmg"), null);
});

// ── What must NOT reach the site ────────────────────────────────────────────

test("electron-updater metadata and blockmaps are dropped", () => {
  for (const name of [
    "latest.yml",
    "latest-mac.yml",
    "latest-linux.yml",
    "Chip-Hippo-0.9.1-arm64.dmg.blockmap",
    "Chip-Hippo-Setup-0.9.1-x64.exe.blockmap",
    "Chip-Hippo-0.9.1-arm64.zip.blockmap",
  ]) {
    assert.equal(
      classify(name),
      null,
      `${name} must not reach the download page`,
    );
  }
});

test("classification is case-insensitive", () => {
  assert.equal(classify("CHIP-HIPPO-0.9.1-ARM64.DMG").arch, "arm64");
  assert.equal(classify("Chip-Hippo-0.9.1-x86_64.AppImage").kind, "appimage");
});
