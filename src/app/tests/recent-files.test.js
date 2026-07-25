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

/**
 * tests/recent-files.test.js — the pure MRU arithmetic behind File ▸ Open
 * Recent: most recent first, no duplicates, capped at MAX_RECENT, and never
 * mutating the list it was handed (settings-store's DEFAULTS array is frozen).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_RECENT,
  sanitizeRecent,
  rememberRecent,
  forgetRecent,
} = require("../store/recent-files");

test("a remembered file leads the list", () => {
  assert.deepEqual(rememberRecent([], "/a.chiphippo"), ["/a.chiphippo"]);
  assert.deepEqual(rememberRecent(["/a.chiphippo"], "/b.chiphippo"), [
    "/b.chiphippo",
    "/a.chiphippo",
  ]);
});

test("re-opening a known file MOVES it to the front, never duplicates it", () => {
  const list = ["/c.chiphippo", "/b.chiphippo", "/a.chiphippo"];
  assert.deepEqual(rememberRecent(list, "/a.chiphippo"), [
    "/a.chiphippo",
    "/c.chiphippo",
    "/b.chiphippo",
  ]);
});

test("the list is capped at MAX_RECENT, dropping the oldest", () => {
  let list = [];
  for (let i = 0; i < MAX_RECENT + 5; i += 1) {
    list = rememberRecent(list, `/f${i}.chiphippo`);
  }
  assert.equal(list.length, MAX_RECENT);
  assert.equal(list[0], `/f${MAX_RECENT + 4}.chiphippo`);
  assert.equal(
    list.includes("/f0.chiphippo"),
    false,
    "the oldest entry fell off the end",
  );
});

test("the input list is never mutated (settings' DEFAULTS array is frozen)", () => {
  const frozen = Object.freeze(["/a.chiphippo"]);
  assert.deepEqual(rememberRecent(frozen, "/b.chiphippo"), [
    "/b.chiphippo",
    "/a.chiphippo",
  ]);
  assert.deepEqual(forgetRecent(frozen, "/a.chiphippo"), []);
  assert.deepEqual(frozen, ["/a.chiphippo"]);
});

test("forgetting drops just that entry; an unknown path is a no-op", () => {
  const list = ["/a.chiphippo", "/b.chiphippo"];
  assert.deepEqual(forgetRecent(list, "/a.chiphippo"), ["/b.chiphippo"]);
  assert.deepEqual(forgetRecent(list, "/nope.chiphippo"), list);
});

test("junk is sanitized away — non-strings, blanks, duplicates, overflow", () => {
  assert.deepEqual(sanitizeRecent(null), []);
  assert.deepEqual(sanitizeRecent("not-an-array"), []);
  assert.deepEqual(
    sanitizeRecent(["/a.chiphippo", "", null, 7, "/a.chiphippo", "/b"]),
    ["/a.chiphippo", "/b"],
  );
  assert.equal(
    sanitizeRecent(Array.from({ length: 40 }, (_, i) => `/f${i}`)).length,
    MAX_RECENT,
  );
});

test("remembering a junk path leaves the (sanitized) list alone", () => {
  const list = ["/a.chiphippo"];
  assert.deepEqual(rememberRecent(list, ""), list);
  assert.deepEqual(rememberRecent(list, null), list);
  assert.deepEqual(rememberRecent(list, 42), list);
});
