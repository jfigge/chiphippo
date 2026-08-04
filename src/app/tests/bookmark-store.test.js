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

// bookmark-store.test.js — security-scoped bookmarks for the Mac App Store
// build.
//
// Everything here can only be proved for real by running a signed, sandboxed
// build, so what these tests pin is the BOOKKEEPING around Electron's two
// calls: that a bookmark is minted from the right field of the right dialog
// result, that every started access is stopped exactly once (including down the
// throw and reject paths), and that a direct build touches nothing at all.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { BookmarkStore } = require("../store/bookmark-store");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-bm-"));

/**
 * A stand-in for Electron's `app`, recording every start and stop so a test can
 * assert the pairing. `fail` makes the next start throw, standing in for a
 * bookmark the OS refuses.
 */
function fakeApp({ fail = false } = {}) {
  const calls = { started: [], stopped: 0 };
  return {
    calls,
    fail,
    startAccessingSecurityScopedResource(blob) {
      if (this.fail) throw new Error("stale bookmark");
      calls.started.push(blob);
      return () => {
        calls.stopped += 1;
      };
    },
  };
}

/** A store with the MAS gate forced ON, so the tests run off a Mac too. */
const masStore = (dir, app) => new BookmarkStore(dir, app, { enabled: true });

const sidecar = (dir) => path.join(dir, "bookmarks.json");

/**
 * A REAL file to redeem a bookmark for. A scope is now proved by reading the
 * path (see `readable` in the module), so a redeem test cannot use an invented
 * name — an unreadable path is exactly what a stale bookmark looks like, which
 * is the case the tests below the minting section pin deliberately.
 */
function realFile(dir, name) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "{}");
  return file;
}

// ── The direct build touches nothing ─────────────────────────────────────────

test("outside a store build every method is inert", () => {
  const dir = tmpDir();
  const app = fakeApp();
  const store = new BookmarkStore(dir, app, { enabled: false });

  assert.equal(store.enabled(), false);
  // The dialog options come back byte-identical — no securityScopedBookmarks.
  const opts = { title: "Open", properties: ["openFile"] };
  assert.equal(store.dialogOpts(opts), opts);

  store.captureOpen({ filePaths: ["/tmp/a.chiphippo"], bookmarks: ["blob"] });
  store.captureSave({ filePath: "/tmp/b.chiphippo", bookmark: "blob" });
  assert.equal(store.has("/tmp/a.chiphippo"), false);
  assert.equal(fs.existsSync(sidecar(dir)), false, "no sidecar is written");

  // withAccess still runs the work, having started nothing.
  assert.equal(
    store.withAccess("/tmp/a.chiphippo", () => "ran"),
    "ran",
  );
  assert.deepEqual(app.calls, { started: [], stopped: 0 });
});

test("a MAS build with no Electron API present is inert too", () => {
  const store = new BookmarkStore(tmpDir(), {}, { enabled: true });
  assert.equal(store.enabled(), false);
});

// ── Minting ──────────────────────────────────────────────────────────────────

test("dialogOpts asks the panel for bookmarks without disturbing the rest", () => {
  const store = masStore(tmpDir(), fakeApp());
  assert.deepEqual(store.dialogOpts({ title: "Open", defaultPath: "/tmp" }), {
    title: "Open",
    defaultPath: "/tmp",
    securityScopedBookmarks: true,
  });
});

test("captureOpen pairs filePaths[i] with bookmarks[i]", () => {
  const dir = tmpDir();
  const store = masStore(dir, fakeApp());
  store.captureOpen({
    filePaths: ["/tmp/one.chiphippo", "/tmp/two.chiphippo"],
    bookmarks: ["blob-1", "blob-2"],
  });
  assert.equal(store.has("/tmp/one.chiphippo"), true);
  assert.equal(store.has("/tmp/two.chiphippo"), true);
  assert.equal(store.has("/tmp/three.chiphippo"), false);
});

test("captureSave reads the SINGULAR bookmark, not an array", () => {
  // The save panel returns `filePath`/`bookmark` where the open panel returns
  // `filePaths`/`bookmarks`. Reading the wrong shape stores nothing and fails
  // silently a launch later, which is exactly why this case is pinned.
  const store = masStore(tmpDir(), fakeApp());
  store.captureSave({ filePath: "/tmp/saved.chiphippo", bookmark: "blob" });
  assert.equal(store.has("/tmp/saved.chiphippo"), true);
});

test("an empty blob is not stored — that is what an unentitled build returns", () => {
  const dir = tmpDir();
  const store = masStore(dir, fakeApp());
  store.captureOpen({ filePaths: ["/tmp/a", "/tmp/b"], bookmarks: ["", null] });
  store.captureSave({ filePath: "/tmp/c", bookmark: "" });
  assert.equal(store.has("/tmp/a"), false);
  assert.equal(store.has("/tmp/b"), false);
  assert.equal(store.has("/tmp/c"), false);
  assert.equal(fs.existsSync(sidecar(dir)), false);
});

test("a short or missing bookmarks array is survived, not thrown over", () => {
  const store = masStore(tmpDir(), fakeApp());
  store.captureOpen({ filePaths: ["/tmp/a", "/tmp/b"], bookmarks: ["blob-a"] });
  assert.equal(store.has("/tmp/a"), true);
  assert.equal(store.has("/tmp/b"), false);
  store.captureOpen({ filePaths: ["/tmp/c"] });
  store.captureOpen(undefined);
  assert.equal(store.has("/tmp/c"), false);
});

test("bookmarks live in their own sidecar, never in settings.json", () => {
  const dir = tmpDir();
  const store = masStore(dir, fakeApp());
  store.captureSave({ filePath: "/tmp/x.chiphippo", bookmark: "blob" });
  assert.equal(fs.existsSync(sidecar(dir)), true);
  assert.equal(fs.existsSync(path.join(dir, "settings.json")), false);
  const doc = JSON.parse(fs.readFileSync(sidecar(dir), "utf8"));
  assert.equal(doc.version, 1);
  assert.equal(doc.bookmarks[path.resolve("/tmp/x.chiphippo")], "blob");
});

// ── Redeeming ────────────────────────────────────────────────────────────────

test("withAccess starts the stored blob and stops it exactly once", () => {
  const app = fakeApp();
  const dir = tmpDir();
  const store = masStore(dir, app);
  const file = realFile(dir, "p.chiphippo");
  store.captureSave({ filePath: file, bookmark: "the-blob" });

  const out = store.withAccess(file, () => "value");
  assert.equal(out, "value");
  assert.deepEqual(app.calls.started, ["the-blob"]);
  assert.equal(app.calls.stopped, 1);
  assert.equal(store.has(file), true, "a scope that worked is kept");
});

test("withAccess on a path with no bookmark starts nothing (userData)", () => {
  const app = fakeApp();
  const store = masStore(tmpDir(), app);
  assert.equal(
    store.withAccess("/inside/the/container.json", () => 42),
    42,
  );
  assert.deepEqual(app.calls, { started: [], stopped: 0 });
});

test("access is stopped when the work throws, and the error still lands", () => {
  const app = fakeApp();
  const dir = tmpDir();
  const store = masStore(dir, app);
  const file = realFile(dir, "p");
  store.captureSave({ filePath: file, bookmark: "blob" });

  assert.throws(
    () =>
      store.withAccess(file, () => {
        throw new Error("read failed");
      }),
    /read failed/,
  );
  assert.equal(app.calls.stopped, 1);
});

test("access is held across an await and stopped when the promise settles", async () => {
  const app = fakeApp();
  const dir = tmpDir();
  const store = masStore(dir, app);
  const file = realFile(dir, "p");
  store.captureSave({ filePath: file, bookmark: "blob" });

  // Resolution: the stop waits for the promise, which is what makes holding
  // access across `await shell.openPath(...)` work.
  const pending = store.withAccess(file, () => Promise.resolve("ok"));
  assert.equal(app.calls.stopped, 0, "not stopped while still in flight");
  assert.equal(await pending, "ok");
  assert.equal(app.calls.stopped, 1);

  // Rejection stops it too, and re-throws.
  await assert.rejects(
    store.withAccess(file, () => Promise.reject(new Error("nope"))),
    /nope/,
  );
  assert.equal(app.calls.stopped, 2);
});

test("a blob the OS refuses is dropped, and the work still runs", () => {
  const app = fakeApp();
  const store = masStore(tmpDir(), app);
  store.captureSave({ filePath: "/tmp/moved.chiphippo", bookmark: "blob" });
  assert.equal(store.has("/tmp/moved.chiphippo"), true);

  app.fail = true;
  // The caller's own existsSync is what reports "missing" — withAccess does not
  // invent a second failure mode, it just runs the work unscoped.
  assert.equal(
    store.withAccess("/tmp/moved.chiphippo", () => "ran anyway"),
    "ran anyway",
  );
  assert.equal(store.has("/tmp/moved.chiphippo"), false, "dead entry dropped");
  assert.equal(app.calls.stopped, 0);
});

// ── A scope is PROVED, not assumed ───────────────────────────────────────────
//
// The bug this section exists for: Electron hands back a stop function whether
// or not the blob resolved, so a STALE bookmark looked exactly like a live one
// and the caller found out several frames later, as an EPERM it could not
// attribute to anything. A save panel's bookmark is stale from the next launch
// (electron/electron#32544), so this was every project made with Save As.

test("a bookmark that does not actually grant access is stopped and dropped", () => {
  const app = fakeApp();
  const dir = tmpDir();
  const store = masStore(dir, app);
  // Minted, stored, and pointing at nothing readable — a stale blob exactly as
  // the save panel produces one.
  const gone = path.join(dir, "stale.chiphippo");
  store.captureSave({ filePath: gone, bookmark: "stale-blob" });
  assert.equal(store.has(gone), true);

  assert.equal(
    store.withAccess(gone, () => "ran unscoped"),
    "ran unscoped",
    "the work still runs — withAccess does not invent a failure",
  );
  assert.deepEqual(app.calls.started, ["stale-blob"], "it was tried");
  assert.equal(app.calls.stopped, 1, "and released rather than leaked");
  assert.equal(store.has(gone), false, "a blob that grants nothing is dropped");
});

test("canAccess separates a file that is gone from one that is merely denied", () => {
  const app = fakeApp();
  const dir = tmpDir();
  const store = masStore(dir, app);
  const live = realFile(dir, "live.chiphippo");
  store.captureSave({ filePath: live, bookmark: "good-blob" });

  assert.equal(store.canAccess(live), true);
  assert.equal(app.calls.stopped, 1, "the probe releases what it started");

  // No bookmark at all is the userData case: the read itself is the answer.
  const plain = realFile(dir, "plain.json");
  assert.equal(store.canAccess(plain), true);
  assert.equal(store.canAccess(path.join(dir, "never-existed")), false);
  assert.equal(store.canAccess(""), false);
});

test("canAccess is true for a readable DIRECTORY, which is what a folder bookmark is for", () => {
  // settings.datasheetDir is a folder, granted by an open panel; a file probe
  // would be the wrong call on it.
  const dir = tmpDir();
  const store = masStore(dir, fakeApp());
  assert.equal(store.canAccess(dir), true);
});

// ── Session holds ────────────────────────────────────────────────────────────

test("hold keeps access for a slot, and replacing it stops the previous once", () => {
  const app = fakeApp();
  const dir = tmpDir();
  const store = masStore(dir, app);
  const a = realFile(dir, "a.chiphippo");
  const b = realFile(dir, "b.chiphippo");
  store.captureOpen({ filePaths: [a, b], bookmarks: ["blob-a", "blob-b"] });

  store.hold("project", a);
  assert.deepEqual(app.calls.started, ["blob-a"]);
  assert.equal(app.calls.stopped, 0, "held for the session");

  // Re-holding the SAME path is a no-op — adoptProject calls this on every
  // open, including re-opening what is already open.
  store.hold("project", a);
  assert.deepEqual(app.calls.started, ["blob-a"]);
  assert.equal(app.calls.stopped, 0);

  store.hold("project", b);
  assert.deepEqual(app.calls.started, ["blob-a", "blob-b"]);
  assert.equal(app.calls.stopped, 1, "the previous hold was released");

  store.releaseAll();
  assert.equal(app.calls.stopped, 2);
  store.releaseAll();
  assert.equal(app.calls.stopped, 2, "releasing twice stops nothing twice");
});

test("holding a path with no bookmark still releases the previous one", () => {
  const app = fakeApp();
  const dir = tmpDir();
  const store = masStore(dir, app);
  const a = realFile(dir, "a");
  store.captureSave({ filePath: a, bookmark: "blob-a" });
  store.hold("project", a);
  store.hold("project", "/inside/the/container");
  assert.equal(app.calls.stopped, 1);
  store.releaseAll();
  assert.equal(app.calls.stopped, 1);
});

// ── Housekeeping ─────────────────────────────────────────────────────────────

test("prune keeps the named paths and forgets the rest, holds untouched", () => {
  const app = fakeApp();
  const dir = tmpDir();
  const store = masStore(dir, app);
  const keep = realFile(dir, "keep");
  const drop = realFile(dir, "drop");
  store.captureOpen({
    filePaths: [keep, drop],
    bookmarks: ["blob-keep", "blob-drop"],
  });
  store.hold("project", drop);

  store.prune([keep]);
  assert.equal(store.has(keep), true);
  assert.equal(store.has(drop), false);
  // Forgetting the bookmark is not revoking access already in use.
  assert.equal(app.calls.stopped, 0);
  store.releaseAll();
  assert.equal(app.calls.stopped, 1);
});
