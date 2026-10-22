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

// website-releases.test.js — website/releases.html, the release notes, is
// GENERATED from website/release-notes.json by scripts/build-release-notes.mjs.
// These hold the notes to their shape, the committed page to the generator,
// and `make release`'s --add to what it may write.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

import {
  OUT,
  readNotes,
  releaseEntry,
  renderReleasesPage,
  withRelease,
} from "../../../../scripts/build-release-notes.mjs";

const semver = (v) => v.split(".").map(Number);
const newer = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

test("the notes run newest first from 1.0.0, every release with its lines", () => {
  const { repo, releases } = readNotes();
  assert.equal(repo, "jfigge/chiphippo");
  assert.equal(releases.at(-1).version, "1.0.0", "the notes start at 1.0.0");
  for (let i = 1; i < releases.length; i++) {
    assert.ok(
      newer(releases[i - 1].version, releases[i].version),
      `${releases[i - 1].version} before ${releases[i].version}`,
    );
    assert.ok(releases[i - 1].date >= releases[i].date);
  }
  for (const r of releases) {
    assert.match(r.version, /^\d+\.\d+\.\d+$/);
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(r.commits.length > 0, `${r.version} lists its commits`);
    for (const c of r.commits) {
      assert.match(c.hash, /^[0-9a-f]{7,40}$/, `${r.version}: ${c.hash}`);
      assert.ok(c.summary.length > 0 && !c.summary.includes("\n"));
    }
  }
  const hashes = releases.flatMap((r) => r.commits.map((c) => c.hash));
  assert.equal(hashes.length, new Set(hashes).size, "a commit listed twice");
});

test("the committed page is what the generator writes", () => {
  assert.equal(
    readFileSync(OUT, "utf8"),
    renderReleasesPage(readNotes()),
    "website/releases.html is stale — run `make docs`",
  );
});

test("the page lists every release and every line, each linked", () => {
  const notes = readNotes();
  const doc = new JSDOM(renderReleasesPage(notes)).window.document;
  const sections = [...doc.querySelectorAll("section.release")];
  assert.deepEqual(
    sections.map((s) => s.id),
    notes.releases.map((r) => `v${r.version}`),
  );
  notes.releases.forEach((r, i) => {
    const items = sections[i].querySelectorAll("li");
    assert.equal(items.length, r.commits.length, r.version);
    assert.equal(
      sections[i].querySelector(".release-link").getAttribute("href"),
      `https://github.com/jfigge/chiphippo/releases/tag/v${r.version}`,
    );
    r.commits.forEach((c, j) => {
      assert.equal(items[j].querySelector("span").textContent, c.summary);
      assert.match(
        items[j].querySelector("a.commit").getAttribute("href"),
        new RegExp(`/commit/${c.hash}$`),
      );
    });
  });
});

test("--add's entry is the commits since the last tag, the version bump left out", () => {
  const entry = releaseEntry("1.5.0", "2026-10-20", [
    "8294f76 Added 2 switches that cross the trench",
    "",
    "1a2b3c4 Release v1.4.9",
    "5d6e7f8 Release notes page",
  ]);
  assert.deepEqual(entry, {
    version: "1.5.0",
    date: "2026-10-20",
    commits: [
      { hash: "8294f76", summary: "Added 2 switches that cross the trench" },
      { hash: "5d6e7f8", summary: "Release notes page" },
    ],
  });
});

test("--add puts the new release first and never overwrites one", () => {
  const notes = { repo: "jfigge/chiphippo", releases: [{ version: "1.4.3", date: "2026-10-14", commits: [] }] }; // prettier-ignore
  const next = withRelease(notes, { version: "1.5.0", date: "2026-10-20", commits: [] }); // prettier-ignore
  assert.deepEqual(
    next.releases.map((r) => r.version),
    ["1.5.0", "1.4.3"],
  );
  assert.equal(
    notes.releases.length,
    1,
    "the notes it was given are untouched",
  );
  assert.throws(() => withRelease(next, { version: "1.5.0", date: "x", commits: [] }), /already lists 1\.5\.0/); // prettier-ignore
  assert.throws(() => withRelease(next, { version: "v1.6", date: "x", commits: [] }), /x\.y\.z/); // prettier-ignore
});
