#!/usr/bin/env node
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

// Render the AUR's `chiphippo-bin` PKGBUILD for one release.
//
// src/packaging/aur/PKGBUILD.in names the release's two .deb files and the
// NOTICE / LICENSE-EXCEPTION at its tag; this fills in the version and the
// four sha256s — computed from the very files the Release just published, so
// makepkg's check is against the bytes on GitHub, not a guess — and writes the
// directory the AUR repository mirrors (PKGBUILD + the .install script). The
// Release workflow's `aur` job runs it, then pushes; run it locally to try a
// PKGBUILD in an Arch container first:
//
//   node scripts/render-pkgbuild.mjs --version 1.4.5 \
//     --deb-x64 Chip-Hippo-1.4.5-amd64.deb --deb-arm64 Chip-Hippo-1.4.5-arm64.deb \
//     --out build/aur
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUR_DIR = path.join(ROOT, "src", "packaging", "aur");
const INSTALL_FILE = "chiphippo-bin.install";

// A release tag's version, as the URLs spell it: what `make release` tags
// (1.4.5), or a pre-release (1.5.0-beta.1). Nothing else is a release.
const TAG_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/**
 * The pacman `pkgver` for a release tag. pkgver may not hold a hyphen (it is
 * the separator before pkgrel), so a pre-release's becomes an underscore; the
 * URLs keep the tag as written (`_tag` in the template).
 * @param {string} tag "1.4.5" or "v1.4.5"
 */
export function pkgverOf(tag) {
  const t = String(tag).replace(/^v/, "");
  if (!TAG_RE.test(t)) throw new Error(`not a release version: ${tag}`);
  return t.replace(/-/g, "_");
}

const SHA_RE = /^[0-9a-f]{64}$/;

/**
 * Fill the template. Every placeholder must be answered and every hash must
 * BE one — a PKGBUILD pushed with a blank checksum is a package nobody can
 * install, found by the first user rather than by CI.
 * @param {string} template PKGBUILD.in's text
 * @param {{tag: string, sha256: {notice: string, exception: string, x64: string, arm64: string}}} opts
 */
export function renderPkgbuild(template, { tag, sha256 }) {
  const t = String(tag).replace(/^v/, "");
  const values = {
    PKGVER: pkgverOf(t),
    TAG: t,
    SHA256_NOTICE: sha256.notice,
    SHA256_EXCEPTION: sha256.exception,
    SHA256_X64: sha256.x64,
    SHA256_ARM64: sha256.arm64,
  };
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith("SHA256_") && !SHA_RE.test(value ?? "")) {
      throw new Error(`${key} is not a sha256: ${value}`);
    }
  }
  const out = template.replace(/@([A-Z0-9_]+)@/g, (whole, key) => {
    if (!(key in values)) throw new Error(`unknown placeholder ${whole}`);
    return values[key];
  });
  return out;
}

async function sha256Of(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

function arg(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || !process.argv[i + 1]) {
    throw new Error(`missing ${flag} (see the usage at the top of this file)`);
  }
  return process.argv[i + 1];
}

const IS_MAIN =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (IS_MAIN) {
  const tag = arg("--version");
  const out = arg("--out");
  const template = await readFile(path.join(AUR_DIR, "PKGBUILD.in"), "utf8");
  const pkgbuild = renderPkgbuild(template, {
    tag,
    sha256: {
      notice: await sha256Of(path.join(ROOT, "NOTICE")),
      exception: await sha256Of(path.join(ROOT, "LICENSE-EXCEPTION")),
      x64: await sha256Of(arg("--deb-x64")),
      arm64: await sha256Of(arg("--deb-arm64")),
    },
  });
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "PKGBUILD"), pkgbuild);
  await copyFile(
    path.join(AUR_DIR, INSTALL_FILE),
    path.join(out, INSTALL_FILE),
  );
  console.log(`Wrote ${out}/PKGBUILD for chiphippo-bin ${pkgverOf(tag)}`);
}
