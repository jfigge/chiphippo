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

test("nobody can answer until the renderer says it is ready", () => {
  const g = new CloseGuard();
  // A window still loading — or one whose page never loaded — has no handler
  // registered: asking it would latch on a reply that cannot come.
  assert.equal(g.answerable, false);
  g.rendererReady();
  assert.equal(g.answerable, true);
});

test("a crashed renderer cannot be asked again — the close proceeds", () => {
  const g = new CloseGuard();
  g.rendererReady();
  g.ask();
  g.rendererGone(); // render-process-gone: webContents is NOT destroyed
  assert.equal(g.pending, false);
  assert.equal(g.answerable, false, "not re-asked: the page is dead");
  // A reload brings a new page, which says so for itself.
  g.rendererReady();
  assert.equal(g.answerable, true);
});

test("an answer to no question authorises nothing", () => {
  const g = new CloseGuard();
  g.rendererReady();
  assert.equal(g.reply(true), "stay");
  assert.equal(g.allows(), false);
  // Nor does a late reply from a page written off mid-question.
  g.ask();
  g.rendererGone();
  assert.equal(g.reply(true), "stay");
  assert.equal(g.allows(), false);
});

test("restart-to-update is a quit that answers as an INSTALL", () => {
  const g = new CloseGuard();
  g.rendererReady();
  g.ask({ installing: true });
  assert.equal(g.reply(true), "install");
  assert.equal(
    g.allows(),
    true,
    "the quit the installer triggers goes through",
  );
});

test("declining a restart-to-update forgets the install", () => {
  const g = new CloseGuard();
  g.ask({ installing: true });
  assert.equal(g.reply(false), "stay");
  // The next ⌘Q is a plain quit, not a delayed install.
  g.ask({ quitting: true });
  assert.equal(g.reply(true), "quit");
});

test('an install that never quit takes its "go" back', () => {
  const g = new CloseGuard();
  g.rendererReady();
  g.ask({ installing: true });
  assert.equal(g.reply(true), "install");
  g.installFailed();
  assert.equal(g.allows(), false, "the next ⌘Q asks again");
  g.ask({ quitting: true });
  assert.equal(g.reply(true), "quit", "a plain quit, not a delayed install");
});
