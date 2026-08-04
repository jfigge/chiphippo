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

// website-downloads.test.js — the download cards on chiphippo.com
// (website/downloads.js).
//
// This file is progressive enhancement over static markup, which is exactly why
// it needs a test: EVERY failure mode here still renders a page. The fallback it
// destroys was invisible, the history it duplicated looked like a long list, and
// an architecture it mislabelled was a badge nobody proofreads. Nothing throws,
// nothing logs, and the page looks fine in every one of them.
//
// The four cases below the happy path are all real regressions found by reading
// this file; each is named for what it protects rather than for the function it
// calls.

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadPage, jsonFetch, settle, cardRows } from "./website-page.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const asset = (name, extra) => ({
  name,
  size: 110 * 1048576,
  url: "https://github.com/jfigge/chiphippo/releases/download/v0.9.1/" + name,
  ...extra,
});

/** The v0.9.1 release as build-versions.mjs really classifies it. */
const LIVE_ASSETS = [
  asset("Chip-Hippo-0.9.1-arm64.dmg", {
    platform: "mac",
    arch: "arm64",
    kind: "dmg",
    label: "Disk Image",
  }),
  asset("Chip-Hippo-0.9.1-x64.dmg", {
    platform: "mac",
    arch: "x64",
    kind: "dmg",
    label: "Disk Image",
  }),
  asset("Chip-Hippo-0.9.1-arm64.zip", {
    platform: "mac",
    arch: "arm64",
    kind: "zip",
    label: "ZIP Archive",
  }),
  asset("Chip-Hippo-Setup-0.9.1-x64.exe", {
    platform: "win",
    arch: "x64",
    kind: "setup",
    label: "Installer",
  }),
  asset("Chip-Hippo-0.9.1-x64.exe", {
    platform: "win",
    arch: "x64",
    kind: "portable",
    label: "Portable",
  }),
  asset("Chip-Hippo-Setup-0.9.1.exe", {
    platform: "win",
    arch: "universal",
    kind: "setup",
    label: "Installer",
  }),
  asset("Chip-Hippo-0.9.1-x86_64.AppImage", {
    platform: "linux",
    arch: "x64",
    kind: "appimage",
    label: "AppImage",
  }),
  asset("Chip-Hippo-0.9.1-arm64.AppImage", {
    platform: "linux",
    arch: "arm64",
    kind: "appimage",
    label: "AppImage",
  }),
  asset("Chip-Hippo-0.9.1-amd64.deb", {
    platform: "linux",
    arch: "x64",
    kind: "deb",
    label: "Debian Package",
  }),
];

const release = (version, extra = {}) => ({
  version,
  prerelease: true,
  publishedAt: "2026-08-01T12:00:00Z",
  url: "https://github.com/jfigge/chiphippo/releases/tag/v" + version,
  assets: [],
  ...extra,
});

const manifest = (extra = {}) => ({
  latest: "0.9.1",
  releases: [release("0.9.1", { assets: LIVE_ASSETS }), release("0.9.0")],
  ...extra,
});

const FALLBACK = "Download for macOS [no-badge]";

async function render(data, opts = {}) {
  const fetch = opts.fetch || jsonFetch(data);
  const page = loadPage({ fetch });
  page.run("downloads.js");
  await settle(opts.wait);
  return { ...page, fetch };
}

// ── The happy path ──────────────────────────────────────────────────────────

test("a normal release fills all three cards and the version labels", async (t) => {
  const page = await render(manifest());
  t.after(page.close);
  const { document } = page;

  assert.equal(document.getElementById("hero-version").textContent, "v0.9.1");
  assert.equal(document.getElementById("dl-version").textContent, "0.9.1");
  assert.equal(document.getElementById("footer-version").textContent, "v0.9.1");

  // Grouped by architecture, ordered installer-first inside each group.
  assert.deepEqual(cardRows(document, "dl-list-mac"), [
    "── Apple Silicon (M1 / M2 / M3)",
    "Disk Image [arm64]",
    "ZIP Archive [arm64]",
    "── Intel",
    "Disk Image [x64]",
  ]);
  assert.deepEqual(cardRows(document, "dl-list-linux"), [
    "── Intel / AMD (64-bit)",
    "AppImage [x64]",
    "Debian Package [x64]",
    "── ARM (arm64)",
    "AppImage [arm64]",
  ]);
});

test("the Windows combined installer gets its own group, and it goes last", async (t) => {
  // It is twice the size of a per-arch build (it holds both), so it must not
  // sit above them where it reads as the recommended download.
  const page = await render(manifest());
  t.after(page.close);
  assert.deepEqual(cardRows(page.document, "dl-list-win"), [
    "── Intel / AMD (64-bit)",
    "Installer [x64]",
    "Portable [x64]",
    "── Combined (x64 + ARM)",
    "Installer [universal]",
  ]);
});

test("a mac universal build leads, because it is the only build you need", async (t) => {
  const page = await render(
    manifest({
      releases: [
        release("1.0.0", {
          assets: [
            asset("Chip-Hippo-1.0.0-universal.dmg", {
              platform: "mac",
              arch: "universal",
              kind: "dmg",
              label: "Disk Image",
            }),
            asset("Chip-Hippo-1.0.0-arm64.dmg", {
              platform: "mac",
              arch: "arm64",
              kind: "dmg",
              label: "Disk Image",
            }),
          ],
        }),
      ],
      latest: "1.0.0",
    }),
  );
  t.after(page.close);
  assert.deepEqual(cardRows(page.document, "dl-list-mac"), [
    "── Apple Silicon & Intel (universal)",
    "Disk Image [universal]",
    "── Apple Silicon (M1 / M2 / M3)",
    "Disk Image [arm64]",
  ]);
});

// ── The regressions ─────────────────────────────────────────────────────────

test("an architecture outside the named groups is offered, never dropped", async (t) => {
  // This is the case that used to EMPTY the card: fillCard cleared the list
  // before calling the renderer and discarded the boolean it returned, so an
  // asset the group table did not name left the card with no downloads at all
  // and no error anywhere.
  //
  // Two independent things fix it and both are deliberate. The catch-all group
  // below means the asset still gets a row, so renderGroups can no longer come
  // back empty at all — which makes fillCard's render-into-a-fragment guard a
  // BACKSTOP rather than the thing under test here. It cannot be reached
  // through renderGroups any more, so it is not asserted directly; it stays
  // because a future renderer need not have a catch-all.
  const page = await render(
    manifest({
      latest: "1.0.0",
      releases: [
        release("1.0.0", {
          assets: [
            asset("Chip-Hippo-1.0.0-sparc.dmg", {
              platform: "mac",
              arch: "sparc",
              kind: "dmg",
              label: "Disk Image",
            }),
          ],
        }),
      ],
    }),
  );
  t.after(page.close);
  // "sparc" is not a named group, so it lands under the catch-all — the asset
  // is still offered rather than dropped.
  assert.deepEqual(cardRows(page.document, "dl-list-mac"), [
    "── Other architectures",
    "Disk Image [sparc]",
  ]);
});

test("an asset with no architecture at all renders without an empty badge", async (t) => {
  // build-versions.mjs answers null rather than guessing; an empty .dl-arch is
  // a styled grey pill with nothing in it.
  const page = await render(
    manifest({
      latest: "1.0.0",
      releases: [
        release("1.0.0", {
          assets: [
            asset("Chip-Hippo-1.0.0-riscv64.deb", {
              platform: "linux",
              arch: null,
              kind: "deb",
              label: "Debian Package",
            }),
          ],
        }),
      ],
    }),
  );
  t.after(page.close);
  assert.deepEqual(cardRows(page.document, "dl-list-linux"), [
    "── Other architectures",
    "Debian Package [no-badge]",
  ]);
  assert.equal(page.document.querySelector("#dl-list-linux .dl-arch"), null);
});

test("a throw while rendering is not retried, so the history cannot stack up", async (t) => {
  // apply() used to sit in the same promise chain as the fetch, so an exception
  // in it was caught by the retry handler and the whole render ran again —
  // renderHistory appends, so two releases came out as four rows, then six.
  const data = manifest();
  const page = loadPage({ fetch: jsonFetch(data) });
  // Poison the last step of apply(), after renderHistory has appended.
  const banner = page.document.querySelector(".prerelease-banner");
  Object.defineProperty(banner, "style", {
    get() {
      throw new Error("boom");
    },
  });
  page.run("downloads.js");
  await settle(1600); // past every backoff (300 + 600 + 900 ms)
  t.after(page.close);

  assert.equal(
    page.window.fetch.calls,
    1,
    "a render failure is not a transport failure",
  );
  assert.equal(
    page.document.querySelectorAll("#version-history-list .vh-row").length,
    1,
    "one row per PREVIOUS release (0.9.0), not one per attempt",
  );
});

test("an unreachable versions.json retries, then leaves the static links alone", async (t) => {
  let calls = 0;
  const page = await render(null, {
    fetch: () => {
      calls++;
      return Promise.reject(new Error("offline"));
    },
    wait: 2200,
  });
  t.after(page.close);

  assert.equal(calls, 4, "one attempt plus three backoff retries");
  assert.deepEqual(cardRows(page.document, "dl-list-mac"), [FALLBACK]);
  // The static version numbers in the markup are left as they are.
  assert.match(
    page.document.getElementById("hero-version").textContent,
    /^v\d/,
  );
});

// ── The href allowlist ──────────────────────────────────────────────────────

test("every href is forced onto a GitHub host", async (t) => {
  const RELEASES = "https://github.com/jfigge/chiphippo/releases";
  const hostile = [
    "javascript:alert(1)",
    "http://github.com/jfigge/chiphippo/releases/download/x.dmg", // not https
    "https://githubbcom.example.com/x.dmg",
    "https://evil.test/x.dmg",
    "not a url at all",
  ];
  const page = await render(
    manifest({
      latest: "1.0.0",
      releases: [
        release("1.0.0", {
          assets: hostile.map((url, i) =>
            asset("bad-" + i + "-x64.dmg", {
              platform: "mac",
              arch: "x64",
              kind: "dmg",
              label: "Disk Image",
              url,
            }),
          ),
        }),
      ],
    }),
  );
  t.after(page.close);

  const hrefs = [...page.document.querySelectorAll("#dl-list-mac .dl-row")].map(
    (a) => a.getAttribute("href"),
  );
  assert.equal(hrefs.length, hostile.length);
  for (const href of hrefs) assert.equal(href, RELEASES);
});

test("a genuine GitHub asset URL is left intact", async (t) => {
  const page = await render(manifest());
  t.after(page.close);
  const href = page.document
    .querySelector("#dl-list-mac .dl-row")
    .getAttribute("href");
  assert.equal(href, LIVE_ASSETS[0].url);
});

// ── The pre-release banner ──────────────────────────────────────────────────

test("the pre-release banner stays up for a 0.x release", async (t) => {
  const page = await render(manifest());
  t.after(page.close);
  assert.equal(
    page.document.querySelector(".prerelease-banner").style.display,
    "",
  );
});

test("the pre-release banner clears only at a stable 1.0", async () => {
  const stable = (version, prerelease) =>
    manifest({
      latest: version,
      releases: [release(version, { prerelease }), release("0.9.0")],
    });

  for (const [version, prerelease, shown] of [
    ["1.0.0", false, false],
    ["1.0.0", true, true], // flagged pre-release, whatever the number says
    ["0.9.1", false, true], // stable, but still pre-1.0
  ]) {
    const page = await render(stable(version, prerelease));
    const display =
      page.document.querySelector(".prerelease-banner").style.display;
    assert.equal(
      display === "none",
      !shown,
      `v${version} prerelease=${prerelease}`,
    );
    page.close();
  }
});

// ── Version history ─────────────────────────────────────────────────────────

test("the first release has no history behind it, so none is shown", async (t) => {
  const page = await render(
    manifest({ releases: [release("0.9.1", { assets: LIVE_ASSETS })] }),
  );
  t.after(page.close);
  assert.equal(page.document.getElementById("version-history").hidden, true);
});

test("the history lists the PREVIOUS releases, not the one on the cards", async (t) => {
  // The three cards above are the latest release, under a line that already
  // names its version — repeating it here said the same thing a third time and
  // made the newest row look like something you hadn't seen.
  const page = await render(manifest());
  t.after(page.close);
  const rows = [
    ...page.document.querySelectorAll("#version-history-list .vh-row"),
  ];
  assert.deepEqual(
    rows.map((a) => a.querySelector(".vh-ver").textContent),
    ["v0.9.0 · pre-release"],
  );
  assert.equal(page.document.getElementById("version-history").hidden, false);
});

test("the excluded release is the one the cards used, not one matched by name", async (t) => {
  // Identity, not version string: if two entries somehow carry the same version
  // the history must still drop exactly the object apply() rendered above.
  const dupe = manifest({
    latest: "0.9.1",
    releases: [
      release("0.9.1", { assets: LIVE_ASSETS }),
      release("0.9.1", { url: "https://github.com/jfigge/chiphippo/x" }),
      release("0.9.0"),
    ],
  });
  const page = await render(dupe);
  t.after(page.close);
  const rows = [
    ...page.document.querySelectorAll("#version-history-list .vh-row"),
  ];
  assert.equal(rows.length, 2, "only the rendered release is withheld");
});
