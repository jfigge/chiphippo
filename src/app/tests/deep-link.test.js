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

// What the OS hands Chip Hippo (deep-link.js, the gallery work's Phase 4): a
// link is read for a gallery id and nothing else; argv yields links and
// `.chiphippo` files, every flag passed over.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { parseDeepLink, launchRequests } = require("../deep-link");

test("a gallery link is its entry id", () => {
  assert.deepEqual(parseDeepLink("chiphippo://gallery/two-tone-siren-3fa2c1"), { kind: "gallery", id: "two-tone-siren-3fa2c1" }); // prettier-ignore
  assert.deepEqual(parseDeepLink("chiphippo://gallery/two-tone-siren-3fa2c1/"), { kind: "gallery", id: "two-tone-siren-3fa2c1" }); // prettier-ignore
  // The scheme and host in any case (Windows hands them over as typed).
  assert.deepEqual(parseDeepLink("CHIPHIPPO://Gallery/nand-0a1b2c"), { kind: "gallery", id: "nand-0a1b2c" }); // prettier-ignore
});

test("anything that is not exactly a gallery id is no link", () => {
  for (const url of [
    "chiphippo://gallery/",
    "chiphippo://gallery/Not-An-Id",
    "chiphippo://gallery/nand-0a1b2c/extra",
    "chiphippo://gallery/nand-0a1b2c?x=1",
    "chiphippo://gallery/nand-0a1b2c#top",
    "chiphippo://gallery/..%2F..%2Fetc-0a1b2c",
    "chiphippo://gallery/../nand-0a1b2c",
    "chiphippo://evil.example/nand-0a1b2c",
    "chiphippo:gallery/nand-0a1b2c",
    "https://chiphippo.com/gallery/nand-0a1b2c",
    `chiphippo://gallery/${"a".repeat(300)}-0a1b2c`,
    "",
    null,
    42,
  ]) {
    assert.equal(parseDeepLink(url), null, String(url));
  }
});

test("argv: links and .chiphippo files, flags and the binary skipped", () => {
  const cwd = path.resolve("/work/here");
  const got = launchRequests(
    [
      "/opt/Chip Hippo/chiphippo",
      "--allow-file-access-from-files",
      "--features=demo",
      "chiphippo://gallery/nand-0a1b2c",
      "designs/Clock.chiphippo",
      path.resolve("/abs/Bench.desktop.chiphippo"),
      "notes.txt",
      "-psn_0_12345",
    ],
    { cwd },
  );
  assert.deepEqual(got, [
    { kind: "link", url: "chiphippo://gallery/nand-0a1b2c" },
    { kind: "file", path: path.join(cwd, "designs/Clock.chiphippo") },
    { kind: "file", path: path.resolve("/abs/Bench.desktop.chiphippo") },
  ]);
});

test("argv: a dev launch's own script and nothing at all ask for nothing", () => {
  assert.deepEqual(launchRequests(["electron", "app/main.js", "--hot-reload"]), []); // prettier-ignore
  assert.deepEqual(launchRequests([]), []);
  assert.deepEqual(launchRequests(undefined), []);
  // The binary itself is never a request, whatever its name.
  assert.deepEqual(launchRequests(["/tmp/odd.chiphippo"]), []);
});

test("argv: a Linux file manager's file: URL is decoded, never resolved against the cwd", () => {
  const { pathToFileURL } = require("node:url");
  const file = path.resolve("/home/ada/My Board.chiphippo");
  const url = pathToFileURL(file).href; // file:///home/ada/My%20Board.chiphippo
  assert.deepEqual(launchRequests(["bin", url], { cwd: path.resolve("/elsewhere") }), [{ kind: "file", path: file }]); // prettier-ignore
  // Not a project, or not a local file: nothing.
  assert.deepEqual(launchRequests(["bin", pathToFileURL(path.resolve("/home/ada/notes.txt")).href]), []); // prettier-ignore
  assert.deepEqual(launchRequests(["bin", "file:"]), []);
  // An encoded separator is refused, as fileURLToPath refuses it — never
  // decoded into a "..": segment the URL did not have.
  assert.deepEqual(launchRequests(["bin", "file:///home/u/a%2F..%2Fb.chiphippo"]), []); // prettier-ignore
  assert.deepEqual(launchRequests(["bin", "file:///home/u/a%2f..%2fb.chiphippo"]), []); // prettier-ignore
});
