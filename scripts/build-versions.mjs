#!/usr/bin/env node
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

// Build website/versions.json from the GitHub Releases API.
//
// The static site reads this file to render its download buttons and version
// history, so download links always track real release assets (whatever they
// are named) instead of hardcoded filenames. Run in CI with GITHUB_TOKEN set,
// or locally:  GITHUB_TOKEN=$(gh auth token) node scripts/build-versions.mjs
//
// Usage: node scripts/build-versions.mjs [--repo owner/name] [--out path]
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const repo = arg("--repo", process.env.REPO || "jfigge/chiphippo");
const out = arg("--out", "website/versions.json");
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

// The site links to only the most recent releases; older ones are dropped from
// versions.json entirely so no page can reference them. The GitHub API returns
// releases newest-first and we preserve that order, so these are the 3 newest.
const MAX_RELEASES = 3;

// Architecture, read off the artifact filename. electron-builder substitutes a
// DIFFERENT spelling per target — `${arch}` is x64 for a dmg, x86_64 for an
// AppImage, amd64 for a deb — so what this needs is a vocabulary, not a guess.
//
// IT USED TO BE `/arm64|aarch64/.test(n) ? "arm64" : "x64"`, and the `else` was
// the bug: every name that was not arm64 got ASSERTED to be Intel 64-bit. A
// universal mac build — which `make mas` already produces, and which a dmg could
// publish tomorrow — was filed under "Intel", so an Apple Silicon visitor was
// offered a download badged for the wrong machine. ia32 and armv7l would have
// been mislabelled the same way, and nothing anywhere would have said so.
//
// So: name every spelling, and answer NULL for anything not named. null is not a
// failure — downloads.js gives an unnamed arch its own heading rather than
// dropping the asset, which is the honest outcome for an architecture this table
// has not met yet. Being wrong in a badge is worse than being silent in one.
//
// ORDER MATTERS IN EXACTLY ONE PLACE: x86_64 must be read as x64 before the ia32
// row gets to see its `x86` prefix. Everything else is mutually exclusive.
const ARCH_SPELLINGS = [
  [/arm64|aarch64/, "arm64"],
  [/x86[_-]?64|x64|amd64/, "x64"],
  [/universal/, "universal"],
  [/armv7l|armhf/, "armv7l"],
  [/ia32|i[3-6]86|x86/, "ia32"],
];

// A name whose arch slot expanded to NOTHING, i.e. one ending at the version:
// "Chip-Hippo-0.9.1.exe" against "Chip-Hippo-0.9.1-x64.exe". artifactName always
// carries ${arch} (src/package.json), and electron-builder collapses it for the
// one artifact that is not arch-specific — the COMBINED multi-arch installer it
// emits alongside the per-arch ones. Both v0.9.0 and v0.9.1 publish two of them
// and they weigh 219 MB against the per-arch 110 MB, which is the two builds in
// one file. So this is a fact about the template, not a fallback: it is the
// difference between "no arch slot" (combined) and "an arch I do not know"
// (null), which is why it is a separate test from the vocabulary above.
// The trailing group must be a VERSION — at least one dot — and not merely
// digits, or a hypothetical "…-arm-64" would read as combined rather than as an
// architecture nobody has taught this table yet.
const NO_ARCH_SLOT = /[-.]\d+(?:\.\d+)+$/;

// Whole tokens only, so a product name or a version can never be read as an
// architecture. `name` is expected lowercased, extension included.
function archOf(name) {
  for (const [re, arch] of ARCH_SPELLINGS) {
    if (new RegExp(`(?:^|[^a-z0-9])(?:${re.source})(?![a-z0-9])`).test(name)) {
      return arch;
    }
  }
  return NO_ARCH_SLOT.test(name.replace(/\.[a-z0-9]+$/, ""))
    ? "universal"
    : null;
}

// Classify a release asset by filename. Returns null for non-installer assets
// (electron-updater metadata: *.blockmap, latest*.yml, etc.) so they're dropped.
// The electron-builder artifactName is Chip-Hippo-${version}-${arch}.${ext}, with
// the nsis installer overridden to include "Setup" so it never collides with the
// portable .exe (see src/package.json). Both macOS zips are archives, so any
// .zip is treated as the macOS ZIP regardless of a "mac" token in the name.
export function classify(name) {
  const n = name.toLowerCase();
  const arch = archOf(n);
  if (n.endsWith(".dmg"))
    return { platform: "mac", arch, kind: "dmg", label: "Disk Image" };
  if (n.endsWith(".zip"))
    return { platform: "mac", arch, kind: "zip", label: "ZIP Archive" };
  if (n.endsWith(".exe"))
    return n.includes("setup")
      ? { platform: "win", arch, kind: "setup", label: "Installer" }
      : { platform: "win", arch, kind: "portable", label: "Portable" };
  if (n.endsWith(".appimage"))
    return { platform: "linux", arch, kind: "appimage", label: "AppImage" };
  if (n.endsWith(".deb"))
    return { platform: "linux", arch, kind: "deb", label: "Debian Package" };
  return null;
}

async function gh(path) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "chiphippo-build-versions",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok)
    throw new Error(`GitHub API ${path} -> ${res.status} ${res.statusText}`);
  return res.json();
}

// ── Build ─────────────────────────────────────────────────────────────────────
// Only fetch and write when invoked directly (`node scripts/build-versions.mjs`),
// matching build-docs.mjs. Importing the module — which the classify() test does
// — must never reach the network or touch a file.
const IS_MAIN =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (IS_MAIN) {
  const raw = await gh(`/repos/${repo}/releases?per_page=100`);

  const releases = raw
    .filter((r) => !r.draft)
    .map((r) => ({
      version: String(r.tag_name || "").replace(/^v/, ""),
      tag: r.tag_name,
      name: r.name || r.tag_name,
      publishedAt: r.published_at,
      prerelease: !!r.prerelease,
      url: r.html_url,
      assets: (r.assets || [])
        .map((a) => {
          const c = classify(a.name);
          return c
            ? { name: a.name, size: a.size, url: a.browser_download_url, ...c }
            : null;
        })
        .filter(Boolean),
    }))
    .slice(0, MAX_RELEASES);

  const latest = releases.find((r) => !r.prerelease) || releases[0] || null;

  const data = {
    repo,
    generatedAt: new Date().toISOString(),
    latest: latest ? latest.version : null,
    releases,
  };

  await writeFile(out, JSON.stringify(data, null, 2) + "\n");
  console.log(
    `Wrote ${out}: ${releases.length} release(s), latest ${data.latest ?? "(none)"}`,
  );
}
