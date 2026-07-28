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

// The prompt-history state machine, with no textarea in sight. Where the caret
// lands after a move is the panel's business (ai-panel.test.js); what the list
// and the cursor DO is all here.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_HISTORY,
  PromptHistory,
  rememberPrompt,
  sanitizeHistory,
} from "../ai/prompt-history.js";

// ── The list ────────────────────────────────────────────────────────────────

test("a prompt is remembered newest first", () => {
  let list = [];
  list = rememberPrompt(list, "a counter");
  list = rememberPrompt(list, "an adder");
  assert.deepEqual(list, ["an adder", "a counter"]);
});

test("it is a TIMELINE, not an MRU list", () => {
  // The difference that matters: `recent-files.js` would move the repeat to
  // the front and leave two entries. Arrowing back through that lands you on
  // the same text twice with a gap where the third prompt used to be.
  let list = [];
  for (const p of ["one", "two", "three", "one"])
    list = rememberPrompt(list, p);
  assert.deepEqual(list, ["one", "three", "two", "one"]);
});

test("asking the same thing twice in a row is one memory", () => {
  let list = rememberPrompt([], "a counter");
  list = rememberPrompt(list, "a counter");
  assert.deepEqual(list, ["a counter"], "consecutive repeats collapse");
});

test("blank and non-string prompts never enter the list", () => {
  let list = rememberPrompt([], "   ");
  assert.deepEqual(list, []);
  list = rememberPrompt(list, null);
  assert.deepEqual(list, []);
  assert.deepEqual(rememberPrompt([], "  padded  "), ["padded"], "trimmed");
});

test("the list is capped, dropping the OLDEST", () => {
  let list = [];
  for (let i = 0; i < MAX_HISTORY + 25; i++) {
    list = rememberPrompt(list, `prompt ${i}`);
  }
  assert.equal(list.length, MAX_HISTORY);
  assert.equal(list[0], `prompt ${MAX_HISTORY + 24}`, "newest kept");
  assert.equal(list.at(-1), `prompt ${25}`, "oldest fell off the end");
});

test("a junk settings value cannot poison the list", () => {
  // settings.json is a plain file a user can edit; nothing here may throw.
  assert.deepEqual(sanitizeHistory(null), []);
  assert.deepEqual(sanitizeHistory("not a list"), []);
  // Junk is not an entry, so the two survivors end up ADJACENT and collapse as
  // any consecutive repeat would.
  assert.deepEqual(sanitizeHistory([1, {}, null, "keep", "", "keep"]), [
    "keep",
  ]);
  assert.deepEqual(
    sanitizeHistory(["one", 7, "two", null, "one"]),
    ["one", "two", "one"],
    "a genuine repeat further down the timeline still survives",
  );
  assert.equal(sanitizeHistory(new Array(500).fill("x")).length, 1);
});

test("remembering never mutates the array it was given", () => {
  // settings-store.js hands out a FROZEN default array.
  const frozen = Object.freeze(["a counter"]);
  const next = rememberPrompt(frozen, "an adder");
  assert.deepEqual(frozen, ["a counter"]);
  assert.deepEqual(next, ["an adder", "a counter"]);
});

// ── The cursor ──────────────────────────────────────────────────────────────

const seeded = () => new PromptHistory(["third", "second", "first"]);

test("back walks towards older prompts and stops at the end", () => {
  const h = seeded();
  assert.equal(h.back(""), "third");
  assert.equal(h.back(), "second");
  assert.equal(h.back(), "first");
  assert.equal(h.back(), null, "nothing older — the box is left alone");
  assert.equal(h.back(), null, "and it stays there");
});

test("forward walks back towards the draft and stops there", () => {
  const h = seeded();
  h.back("");
  h.back();
  assert.equal(h.forward(), "third");
  assert.equal(h.forward(), "", "the draft, which was empty");
  assert.equal(h.forward(), null, "already home");
});

test("the half-written draft survives a round trip", () => {
  // The failure that makes people stop trusting arrow history: you are three
  // words into a prompt, press Up to check something, and it is gone.
  const h = seeded();
  assert.equal(h.back("a half-typed thou"), "third");
  h.back();
  assert.equal(h.forward(), "third");
  assert.equal(h.forward(), "a half-typed thou", "returned intact");
  assert.equal(h.atDraft, true);
});

test("only the FIRST step back parks a draft", () => {
  // Deeper steps pass the recalled text in as `current`; parking that would
  // overwrite the real draft with a history entry.
  const h = seeded();
  h.back("mine");
  h.back("third");
  h.back("second");
  h.forward();
  h.forward();
  assert.equal(h.forward(), "mine");
});

test("an empty history leaves the box alone in both directions", () => {
  const h = new PromptHistory([]);
  assert.equal(h.back("typing"), null);
  assert.equal(h.forward(), null);
  assert.equal(h.size, 0);
});

test("sending records the prompt AND returns the cursor home", () => {
  const h = seeded();
  h.back("");
  h.back();
  assert.equal(h.atDraft, false, "wandered back into the past");
  const entries = h.remember("a shift register");
  assert.equal(h.atDraft, true, "sending ends the navigation");
  assert.deepEqual(entries, ["a shift register", "third", "second", "first"]);
  assert.equal(
    h.back(""),
    "a shift register",
    "next Up starts from the newest",
  );
});

test("reset abandons a navigation without touching the list", () => {
  const h = seeded();
  h.back("mine");
  h.reset();
  assert.equal(h.atDraft, true);
  assert.equal(h.size, 3, "the list is the user's; only the cursor moved");
  assert.equal(h.back("fresh"), "third", "and Up starts over from the top");
});

test("entries hands out a copy, not the live list", () => {
  const h = seeded();
  h.entries.push("tampered");
  assert.equal(h.size, 3);
});
