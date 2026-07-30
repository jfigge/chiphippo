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

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { CloseGuard } = require("../close-guard");

test("a fresh guard asks rather than letting a close through", () => {
  const g = new CloseGuard();
  assert.equal(g.allows(), false);
  assert.equal(g.ask(), true);
  assert.equal(g.pending, true);
});

test("a second close while a question is out does not stack another", () => {
  const g = new CloseGuard();
  assert.equal(g.ask(), true);
  assert.equal(g.ask(), false);
});

test("declining leaves the guard exactly as it was", () => {
  const g = new CloseGuard();
  g.ask({ quitting: true });
  assert.equal(g.reply(false), "stay");
  assert.equal(g.allows(), false);
  assert.equal(g.pending, false);
  // The cancelled quit is forgotten: the NEXT question is about whatever asks
  // it, so a window-button close must not come back as "quit".
  g.ask();
  assert.equal(g.reply(true), "close");
});

test("the answer names the action that asked for it", () => {
  const byButton = new CloseGuard();
  byButton.ask();
  assert.equal(byButton.reply(true), "close");

  const byQuit = new CloseGuard();
  byQuit.ask({ quitting: true });
  assert.equal(byQuit.reply(true), "quit");
});

test("a quit arriving while a window question is out answers as a quit", () => {
  const g = new CloseGuard();
  assert.equal(g.ask(), true); // the window's own button
  assert.equal(g.ask({ quitting: true }), false); // ⌘Q, no second dialog
  assert.equal(g.reply(true), "quit"); // …but it is what the user last asked for
});

// THE REGRESSION THIS FILE EXISTS FOR. `confirmed` used to be a one-way latch,
// so on macOS — where closing the last window does NOT quit the app — a
// "discard" answered for one window was still set when the dock re-opened
// another, and every close and ⌘Q after that skipped the guard entirely.
test("the confirmation authorises ONE close and no other", () => {
  const g = new CloseGuard();
  g.ask();
  assert.equal(g.reply(true), "close");
  assert.equal(g.allows(), true); // the close it authorised may proceed

  g.closed(); // …and that window has now gone
  assert.equal(
    g.allows(),
    false,
    "a reopened window must be asked about again",
  );
  assert.equal(g.ask(), true);
});

test("a confirmed QUIT is likewise not inherited by the next window", () => {
  const g = new CloseGuard();
  g.ask({ quitting: true });
  assert.equal(g.reply(true), "quit");
  g.closed();
  // Closing the NEXT window is a close, not a quit — otherwise its red button
  // would take the whole app down with it.
  g.ask();
  assert.equal(g.reply(true), "close");
});

test("a dead renderer releases the latch so the next close can ask again", () => {
  const g = new CloseGuard();
  g.ask();
  assert.equal(g.ask(), false); // latched on a reply that will never come
  g.rendererGone();
  assert.equal(g.ask(), true);
  // Releasing the latch is NOT permission to close — that is still unanswered.
  assert.equal(g.allows(), false);
});
