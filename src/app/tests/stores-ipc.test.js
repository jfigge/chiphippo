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

// The private stores' IPC (app/ipc/stores.js) with fake Electron pieces: a
// folder store made, joined from its share link, saved to and opened — and
// the rules on which window may ask what, and that nothing answers in the
// web build.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { registerStoresIpc } = require("../ipc/stores");
const gate = require("../gallery/gate");
const { ProjectStore } = require("../store/project-store");
const { parseStoreLink } = require("../../web/scripts/stores/store-format.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-storeipc-"));
/** A store folder made directly (as a friend's sync would bring one). */
const makeFolderStoreFor = (parent, id, name) =>
  require("../stores/folder").makeFolderStore(parent, { id, name });

/** One Chip Hippo: its handlers, its settings, its two windows. */
function app({ pick, enabled = true } = {}) {
  const handlers = new Map();
  const settings = {};
  const sent = [];
  const mainWc = {};
  const browseWc = {};
  const win = (wc) => ({ isDestroyed: () => false, webContents: wc });
  const opened = [];
  const userData = tmp();
  const pruned = { n: 0 };
  registerStoresIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    dialog: { showOpenDialog: async () => pick() },
    shell: { openExternal: async (u) => opened.push(u), openPath: async (p) => opened.push(`OPEN ${p}`), showItemInFolder: (p) => opened.push(`SHOW ${p}`) }, // prettier-ignore
    enabled: () => enabled,
    getMainWindow: () => win(mainWc),
    getBrowseWindow: () => win(browseWc),
    getSettingsStore: () => ({ get: () => ({ ...settings }), set: (p) => Object.assign(settings, p) }), // prettier-ignore
    getBookmarks: () => ({ dialogOpts: (o) => o, captureOpen: () => {}, withAccess: (_p, fn) => fn() }), // prettier-ignore
    onStoresChanged: () => (pruned.n += 1),
    getCredentialStore: () => ({ available: () => true, keyFor: () => null, set: () => ({ ok: true }), clear: () => {} }), // prettier-ignore
    getProjectStore: () => new ProjectStore(userData, null),
    prepareShare: gate.prepareShare,
    plainImages: (i) => i,
    captureRect: async () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pic")]), // prettier-ignore
    sendToMain: (ch, payload) => sent.push([ch, payload]),
    showMainWindow: () => {},
    m: (_k, fallback) => fallback,
    appVersion: () => "1.6.0",
    docVersion: 15,
    // A build with no GitHub app — and no network, ever, from a test.
    githubClientId: "",
    fetch: async (url) => {
      throw new Error(`no network in tests: ${url}`);
    },
  });
  const call = (ch, ...args) => handlers.get(ch)({ sender: mainWc }, ...args);
  const callBrowse = (ch, ...args) => handlers.get(ch)({ sender: browseWc }, ...args); // prettier-ignore
  const callOther = (ch, ...args) => handlers.get(ch)({ sender: {} }, ...args);
  return {
    handlers,
    settings,
    sent,
    opened,
    pruned,
    call,
    callBrowse,
    callOther,
  };
}

const DOC = { version: 15, boards: [], components: [], wires: [] };
const FIELDS = { title: "Blinker", author: "Ann", description: "", tags: [] };

test("make a folder store, share its link, and a friend joins and opens what was saved", async () => {
  const parent = tmp();
  const ann = app({ pick: () => ({ canceled: false, filePaths: [parent] }) });
  const made = await ann.call("store:add-folder", { mode: "create", name: "Bench club", provider: "dropbox" }); // prettier-ignore
  assert.equal(made.ok, true);
  assert.equal(made.store.provider, "dropbox");
  assert.equal(path.dirname(made.store.path), parent);
  // The list is main's, in settings, and its path is the store's own folder.
  assert.equal(ann.settings.stores.length, 1);
  assert.equal(ann.settings.stores[0].where.grant, parent);

  const { web, app: appLink } = await ann.call("store:link", made.store.id);
  const ref = parseStoreLink(web);
  assert.deepEqual(ref, { id: made.store.id, name: "Bench club", kind: "folder", where: { provider: "dropbox" } }); // prettier-ignore
  assert.deepEqual(parseStoreLink(appLink), ref);
  // No path of Ann's machine is in the link.
  assert.ok(!Buffer.from(web.split("#")[1], "base64url").toString().includes(parent)); // prettier-ignore

  const { token } = await ann.call("store:capture-thumb", { x: 0, y: 0, width: 100, height: 80 }); // prettier-ignore
  const saved = await ann.call("store:save", { id: made.store.id, fields: FIELDS, note: "first go", desktop: { doc: DOC, customChips: [] }, derived: { engine: "logic", chips: 1 }, thumbToken: token }); // prettier-ignore
  assert.equal(saved.ok, true, JSON.stringify(saved));

  // Bob picks the folder the share landed in — or the one above it.
  const bob = app({ pick: () => ({ canceled: false, filePaths: [parent] }) });
  const joined = await bob.call("store:add-folder", { mode: "join", ref });
  assert.equal(joined.ok, true);
  assert.equal(joined.store.path, made.store.path);
  const view = await bob.callBrowse("store:view", joined.store.id);
  assert.equal(view.ok, true);
  assert.equal(view.entries[0].title, "Blinker");
  assert.equal(view.entries[0].head.note, "first go");
  assert.equal(view.entries[0].derived.chips, 1);
  const thumb = await bob.callBrowse("store:thumb", joined.store.id, saved.entry, saved.rev); // prettier-ignore
  assert.match(thumb.url, /^data:image\/png;base64,/);
  // The Browse window's Open goes to the app window, ids only.
  assert.equal(await bob.callBrowse("store:open", joined.store.id, saved.entry, saved.rev), true); // prettier-ignore
  assert.deepEqual(bob.sent.at(-1), ["store:host-inbound", { id: joined.store.id, entry: saved.entry, rev: saved.rev }]); // prettier-ignore
  const opened = await bob.call("store:open-entry", joined.store.id, saved.entry, saved.rev); // prettier-ignore
  assert.equal(opened.ok, true);
  assert.equal(opened.name, "Blinker");
  assert.deepEqual(opened.from, { store: joined.store.id, entry: saved.entry, rev: saved.rev }); // prettier-ignore

  // Bob saves from that revision; Ann, still on the first, is asked first.
  const next = await bob.call("store:save", { id: joined.store.id, entry: saved.entry, base: saved.rev, fields: { ...FIELDS, author: "Bob" }, desktop: { doc: DOC } }); // prettier-ignore
  assert.equal(next.ok, true, JSON.stringify(next));
  const behind = await ann.call("store:save", { id: made.store.id, entry: saved.entry, base: saved.rev, fields: FIELDS, desktop: { doc: DOC } }); // prettier-ignore
  assert.equal(behind.code, "behind");
  assert.equal(behind.head.author, "Bob");
});

test("a friend who picks the wrong folder is told so, and a cancelled dialog adds nothing", async () => {
  const parent = tmp();
  const ann = app({ pick: () => ({ canceled: false, filePaths: [parent] }) });
  const made = await ann.call("store:add-folder", { mode: "create", name: "Lab" }); // prettier-ignore
  const ref = parseStoreLink((await ann.call("store:link", made.store.id)).web);
  const lost = app({ pick: () => ({ canceled: false, filePaths: [tmp()] }) });
  assert.deepEqual(await lost.call("store:add-folder", { mode: "join", ref }), { ok: false, code: "missing" }); // prettier-ignore
  assert.equal(lost.pruned.n, 1, "the refused folder's bookmark is pruned");
  const other = app({ pick: () => ({ canceled: false, filePaths: [made.store.path] }) }); // prettier-ignore
  const wrong = { ...ref, id: "s-ffffffffffffffff" };
  assert.deepEqual(await other.call("store:add-folder", { mode: "join", ref: wrong }), { ok: false, code: "wrongStore" }); // prettier-ignore
  const cancel = app({ pick: () => ({ canceled: true, filePaths: [] }) });
  assert.equal(await cancel.call("store:add-folder", { mode: "create", name: "X" }), null); // prettier-ignore
  assert.equal(cancel.settings.stores, undefined);
});

test("which window may ask what, and nothing at all in the web build", async () => {
  const parent = tmp();
  const ann = app({ pick: () => ({ canceled: false, filePaths: [parent] }) });
  const made = await ann.call("store:add-folder", { mode: "create", name: "Lab" }); // prettier-ignore
  // The Browse window reads, but never writes or sets up.
  assert.equal((await ann.callBrowse("store:view", made.store.id)).ok, true);
  assert.equal((await ann.callBrowse("store:save", { id: made.store.id })).ok, false); // prettier-ignore
  assert.equal((await ann.callBrowse("store:add-folder", { mode: "create", name: "Y" })).ok, false); // prettier-ignore
  // Any other window, nothing.
  assert.equal((await ann.callOther("store:view", made.store.id)).ok, false);
  assert.deepEqual(await ann.callOther("store:list"), []);
  // A refusal never reads as a yes: the boolean handlers answer FALSE to any
  // window but the app's (never the truthy {ok: false} object), and the
  // link is the app window's alone, as ipc-guard.js has it.
  for (const ch of [
    "store:remove",
    "store:reveal",
    "store:guide",
    "store:github-sign-out",
    "store:github-sign-in-cancel",
  ]) {
    // prettier-ignore
    assert.equal(await ann.callBrowse(ch, made.store.id), false, ch);
    assert.equal(await ann.callOther(ch, made.store.id), false, ch);
  }
  assert.equal(ann.settings.stores.length, 1, "nothing was removed");
  assert.equal(await ann.callBrowse("store:link", made.store.id), null);
  assert.ok((await ann.call("store:link", made.store.id)).web);
  // A null or junk options argument is no options — refused, never a throw.
  assert.equal((await ann.call("store:add-folder", null)).code, "invalid");
  assert.equal((await ann.call("store:add-github", null)).code, "signedOut");
  assert.equal(await ann.call("store:reveal", made.store.id, null), true);
  assert.match(ann.opened.pop(), /^SHOW /);
  // A store is named by id; anything else is no store.
  assert.equal((await ann.call("store:view", "../etc")).code, "missing");
  assert.equal((await ann.call("store:thumb", made.store.id, "../x", "y")).code, "invalid"); // prettier-ignore
  assert.equal(await ann.call("store:guide", "https://evil.example"), false);
  assert.equal(await ann.call("store:guide", "github-signup"), true);
  assert.deepEqual(ann.opened, ["https://github.com/signup"]);
  // A GitHub store without a sign-in, or a sign-in with no app registered.
  assert.equal((await ann.call("store:add-github", { mode: "create", name: "Z" })).code, "signedOut"); // prettier-ignore
  assert.equal((await ann.call("store:github-sign-in")).code, "notConfigured");
  // Removing forgets the store here, and only here.
  assert.equal(await ann.call("store:remove", made.store.id), true);
  assert.equal(ann.settings.stores.length, 0);
  assert.ok(fs.existsSync(made.store.path));

  const off = app({ pick: () => ({ canceled: false, filePaths: [parent] }), enabled: false }); // prettier-ignore
  assert.deepEqual(await off.call("store:status"), { enabled: false });
  assert.equal((await off.call("store:add-folder", { mode: "create", name: "Lab" })).ok, false); // prettier-ignore
  assert.deepEqual(await off.call("store:list"), []);
});

test("Show folder SHOWS the store in the file manager — it never opens (or runs) the folder", async () => {
  const parent = tmp();
  const ann = app({ pick: () => ({ canceled: false, filePaths: [parent] }) });
  const made = await ann.call("store:add-folder", { mode: "create", name: "Lab" }); // prettier-ignore
  assert.equal(await ann.call("store:reveal", made.store.id), true);
  assert.deepEqual(ann.opened, [`SHOW ${path.join(made.store.path, "chiphippo-store.json")}`]); // prettier-ignore
  fs.rmSync(made.store.path, { recursive: true });
  assert.equal(await ann.call("store:reveal", made.store.id), false, "gone: nothing shown"); // prettier-ignore
});

test("a link whose folder copies a store's id can't re-point the store this computer already has", async () => {
  const mine = makeFolderStoreFor(tmp(), "s-1111111111111111", "Bench club");
  const theirs = makeFolderStoreFor(tmp(), "s-1111111111111111", "Bench club"); // same id, elsewhere
  let pick = mine;
  const ann = app({ pick: () => ({ canceled: false, filePaths: [pick] }) });
  const ref = { id: "s-1111111111111111", name: "Bench club", kind: "folder", where: { provider: "dropbox" } }; // prettier-ignore
  assert.equal((await ann.call("store:add-folder", { mode: "join", ref })).ok, true); // prettier-ignore
  // Added again from the SAME folder: fine.
  assert.equal((await ann.call("store:add-folder", { mode: "join", ref })).ok, true); // prettier-ignore
  pick = theirs;
  assert.equal((await ann.call("store:add-folder", { mode: "join", ref })).code, "alreadyAdded"); // prettier-ignore
  assert.equal(ann.settings.stores[0].where.path, mine, "still where it was");
});

test("a full list is said before any folder is made", async () => {
  const parent = tmp();
  const ann = app({ pick: () => ({ canceled: false, filePaths: [parent] }) });
  ann.settings.stores = Array.from({ length: 20 }, (_, n) => ({ id: `s-${String(n).padStart(16, "0")}`, name: `S${n}`, kind: "folder", where: { path: path.join(parent, `x${n}`), grant: parent, provider: "other" } })); // prettier-ignore
  assert.equal((await ann.call("store:add-folder", { mode: "create", name: "One more" })).code, "full"); // prettier-ignore
  assert.deepEqual(fs.readdirSync(parent), [], "no folder left behind");
});

test("a folder store's grant is kept as a bookmark (storeGrants); a GitHub store has none", () => {
  const { storeGrants } = require("../stores/registry");
  const list = [
    { id: "s-1111111111111111", name: "A", kind: "folder", where: { path: "/x/A", grant: "/x", provider: "dropbox" }, added: "2026-11-22T00:00:00.000Z" }, // prettier-ignore
    { id: "s-2222222222222222", name: "B", kind: "github", where: { repo: "ann/b" }, added: "2026-11-22T00:00:00.000Z" }, // prettier-ignore
  ];
  assert.deepEqual(storeGrants(list), ["/x"]);
});
