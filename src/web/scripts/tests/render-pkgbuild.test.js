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

// render-pkgbuild.test.js — the AUR PKGBUILD the Release workflow pushes
// (scripts/render-pkgbuild.mjs), rendered from the committed template.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  pkgverOf,
  renderPkgbuild,
} from "../../../../scripts/render-pkgbuild.mjs";

const TEMPLATE = readFileSync(
  fileURLToPath(new URL("../../../packaging/aur/PKGBUILD.in", import.meta.url)),
  "utf8",
);
const SHA = {
  notice: "a".repeat(64),
  exception: "b".repeat(64),
  x64: "c".repeat(64),
  arm64: "d".repeat(64),
};

test("a release renders with every placeholder answered", () => {
  const out = renderPkgbuild(TEMPLATE, { tag: "v1.4.5", sha256: SHA });
  assert.doesNotMatch(out, /@[A-Z0-9_]+@/, "nothing left unfilled");
  assert.match(out, /^pkgname=chiphippo-bin$/m);
  assert.match(out, /^pkgver=1\.4\.5$/m);
  assert.match(out, /^_tag=1\.4\.5$/m);
  assert.match(out, new RegExp(`^sha256sums_x86_64=\\('${SHA.x64}'\\)$`, "m"));
  assert.match(
    out,
    new RegExp(`^sha256sums_aarch64=\\('${SHA.arm64}'\\)$`, "m"),
  );
  // The two arches fetch the release's own debs, named as electron-builder
  // names them (amd64 / arm64 — Debian's spelling, not pacman's).
  assert.match(out, /Chip-Hippo-\$_tag-amd64\.deb/);
  assert.match(out, /Chip-Hippo-\$_tag-arm64\.deb/);
});

test("the package switches the self-updater off, which is the point of the marker", () => {
  // src/app/store-build.js reads `resources/package-managed`; a PKGBUILD that
  // stopped writing it would ship an app that runs dpkg on Arch.
  assert.match(TEMPLATE, /touch "\$app\/resources\/package-managed"/);
  assert.match(TEMPLATE, /rm -f "\$app\/resources\/package-type"/);
});

test("a pre-release keeps its tag in the URLs and loses the hyphen in pkgver", () => {
  assert.equal(pkgverOf("1.5.0-beta.1"), "1.5.0_beta.1");
  const out = renderPkgbuild(TEMPLATE, { tag: "1.5.0-beta.1", sha256: SHA });
  assert.match(out, /^pkgver=1\.5\.0_beta\.1$/m);
  assert.match(out, /^_tag=1\.5\.0-beta\.1$/m);
});

test("anything that is not a release, or not a hash, is refused", () => {
  assert.throws(() => pkgverOf("main"), /not a release version/);
  assert.throws(() => pkgverOf("1.4"), /not a release version/);
  assert.throws(
    () =>
      renderPkgbuild(TEMPLATE, { tag: "1.4.5", sha256: { ...SHA, x64: "" } }),
    /SHA256_X64 is not a sha256/,
  );
  assert.throws(
    () => renderPkgbuild("@MYSTERY@", { tag: "1.4.5", sha256: SHA }),
    /unknown placeholder/,
  );
});
