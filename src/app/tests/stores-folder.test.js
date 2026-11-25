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

// A private store in a folder (app/stores/folder.js) served by the store
// service (app/stores/service.js) — two machines sharing one synced folder,
// as two Chip Hippos on two friends' computers would.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  FolderBackend,
  findStoreFolder,
  folderNameFor,
  isPackage,
  makeFolderStore,
} = require("../stores/folder");
const { StoreService } = require("../stores/service");

const ID = "s-0123456789abcdef";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("picture")]); // prettier-ignore

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-store-"));

/** One machine: its own service (its own cache), the one folder. */
function machine(dir, clock) {
  const store = { id: ID, name: "Lab", kind: "folder", where: { path: dir, grant: dir, provider: "other" } }; // prettier-ignore
  const service = new StoreService({
    backendFor: (s) => new FolderBackend(s.where.path),
    sha256Hex: (d) => crypto.createHash("sha256").update(d).digest("hex"),
    randomHex: (n) => crypto.randomBytes(n).toString("hex"),
    now: () => clock.t,
  });
  return { store, service };
}

const design = (n) => JSON.stringify({ version: 5, kind: "desktop", name: "D", doc: { version: 15, n } }); // prettier-ignore
const FIELDS = { title: "LED chaser", author: "Ann", description: "Eight LEDs", tags: ["555"] }; // prettier-ignore
const APP = { appVersion: "1.6.0", docVersion: 15 };

test("a new store is a folder named for it, holding its manifest", async () => {
  const parent = tmp();
  const dir = makeFolderStore(parent, { id: ID, name: "Bench: club", created: "2026-11-22T00:00:00.000Z" }); // prettier-ignore
  assert.equal(path.basename(dir), "Bench club");
  const again = makeFolderStore(parent, { id: "s-1111111111111111", name: "Bench: club" }); // prettier-ignore
  assert.equal(path.basename(again), "Bench club 2");
  assert.equal((await findStoreFolder(dir)).manifest.id, ID);
  // A friend who picks the folder ABOVE the share still finds it — by id.
  assert.equal((await findStoreFolder(parent, { expectId: ID })).path, dir);
  await assert.rejects(findStoreFolder(dir, { expectId: "s-2222222222222222" }), { code: "wrongStore" }); // prettier-ignore
  await assert.rejects(findStoreFolder(parent), { code: "ambiguous" });
  await assert.rejects(findStoreFolder(tmp(), { expectId: ID }), { code: "missing" }); // prettier-ignore
  assert.equal(folderNameFor("../.."), "Chip Hippo designs");
});

test("a store disguised as a program (a .app package) or reached by a symlink is never found", async () => {
  const parent = tmp();
  const app = path.join(parent, "Designs.app");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, "chiphippo-store.json"), JSON.stringify({ format: 1, id: ID, name: "x" })); // prettier-ignore
  await assert.rejects(findStoreFolder(parent, { expectId: ID }), { code: "missing" }); // prettier-ignore
  await assert.rejects(findStoreFolder(app), { code: "missing" });
  const real = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  fs.symlinkSync(real, path.join(parent, "Linked"));
  await assert.rejects(findStoreFolder(parent, { expectId: ID }), { code: "missing" }); // prettier-ignore
  assert.equal(isPackage("/x/Thing.APP"), true);
  assert.equal(isPackage("/x/Bench club"), false);
});

test("two machines on one folder: save, see, revise, and a fork is asked first", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const clock = { t: Date.UTC(2026, 10, 22, 10, 0, 0) };
  const ann = machine(dir, clock);
  const bob = machine(dir, clock);

  const first = await ann.service.save(ann.store, { design: design(1), fields: FIELDS, thumb: PNG, app: APP, note: "first" }); // prettier-ignore
  let view = await bob.service.view(bob.store);
  assert.equal(view.entries.length, 1);
  const [entry] = view.entries;
  assert.equal(entry.id, first.entry);
  assert.equal(entry.head.rev, first.rev);
  assert.equal(entry.head.note, "first");
  assert.equal(entry.revs[0].thumb, true);
  assert.match(await bob.service.thumb(bob.store, entry.id, first.rev), /^data:image\/png;base64,/); // prettier-ignore
  const { raw } = await bob.service.design(bob.store, entry.id, first.rev);
  assert.equal(raw.doc.n, 1);

  // Bob revises from the head: it simply follows.
  clock.t += 60_000;
  const second = await bob.service.save(bob.store, { design: design(2), fields: { ...FIELDS, author: "Bob" }, entry: entry.id, base: first.rev, app: APP }); // prettier-ignore
  view = await ann.service.view(ann.store);
  assert.equal(view.entries[0].head.rev, second.rev);
  assert.equal(view.entries[0].head.author, "Bob");
  assert.equal(view.entries[0].forked, false);

  // Ann saves from the revision she opened, which Bob has since built on:
  // refused as "behind", with whose save is newer — until she says fork.
  clock.t += 60_000;
  await assert.rejects(
    ann.service.save(ann.store, { design: design(3), fields: FIELDS, entry: entry.id, base: first.rev, app: APP }), // prettier-ignore
    (err) => err.code === "behind" && err.head.author === "Bob",
  );
  const third = await ann.service.save(ann.store, { design: design(3), fields: FIELDS, entry: entry.id, base: first.rev, fork: true, app: APP }); // prettier-ignore
  view = await bob.service.view(bob.store);
  assert.equal(view.entries[0].forked, true);
  assert.deepEqual(view.entries[0].leaves.map((r) => r.rev), [third.rev, second.rev]); // prettier-ignore

  // Nothing was ever written over: one file per write, none edited.
  const revs = fs.readdirSync(path.join(dir, "entries", entry.id, "revs"));
  assert.equal(revs.filter((f) => f.endsWith(".desktop.chiphippo")).length, 3);
});

test("a revision still syncing (its meta not here yet) is not shown", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const clock = { t: Date.UTC(2026, 10, 22, 10, 0, 0) };
  const ann = machine(dir, clock);
  const { entry, rev } = await ann.service.save(ann.store, { design: design(1), fields: FIELDS, app: APP }); // prettier-ignore
  fs.renameSync(path.join(dir, "entries", entry, "revs", `${rev}.json`), path.join(dir, "elsewhere.json")); // prettier-ignore
  const view = await machine(dir, clock).service.view(ann.store);
  assert.equal(view.entries.length, 0);
});

test("the folder backend refuses every path that is not a store's, and never writes over", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const backend = new FolderBackend(dir);
  await assert.rejects(backend.add("../escape.json", "x"), { code: "invalid" });
  await assert.rejects(backend.read("notes.txt", { max: 10 }), { code: "invalid" }); // prettier-ignore
  await assert.rejects(backend.add("chiphippo-store.json", "{}"), { code: "exists" }); // prettier-ignore
  await assert.rejects(backend.read("chiphippo-store.json", { max: 5 }), { code: "tooBig" }); // prettier-ignore
  assert.equal(await backend.read("entries/none-000000/entry.json", { max: 100 }), null); // prettier-ignore
  // Junk a sync client or a person leaves is listed as nothing.
  fs.mkdirSync(path.join(dir, "entries", "x-000000", "revs"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dir, "entries", "x-000000", "entry (1).json"),
    "{}",
  );
  fs.writeFileSync(path.join(dir, ".DS_Store"), "");
  assert.deepEqual(await backend.list(), ["chiphippo-store.json"]);
  await assert.rejects(new FolderBackend(tmp()).list(), { code: "missing" });
});

test("a symlink a friend plants in the shared folder leads nowhere: not read, not written through, not listed", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const outside = tmp();
  fs.writeFileSync(path.join(outside, "secret.json"), '{"kind":"desktop","doc":{"secret":1}}'); // prettier-ignore
  const revs = path.join(dir, "entries", "x-000000", "revs");
  fs.mkdirSync(revs, { recursive: true });
  const rel = "entries/x-000000/revs/20261122T000000Z-0000000000.desktop.chiphippo"; // prettier-ignore
  fs.symlinkSync(path.join(outside, "secret.json"), path.join(dir, ...rel.split("/"))); // prettier-ignore
  const backend = new FolderBackend(dir);
  assert.equal(await backend.read(rel, { max: 1e6 }), null, "a symlinked file is not read"); // prettier-ignore
  assert.ok(!(await backend.list()).includes(rel), "nor listed");
  // A whole folder on the way that is a symlink to elsewhere.
  fs.mkdirSync(path.join(outside, "revs"));
  fs.writeFileSync(path.join(outside, "revs", "20261122T000001Z-1111111111.json"), "{}"); // prettier-ignore
  fs.mkdirSync(path.join(dir, "entries", "y-000000"));
  fs.symlinkSync(path.join(outside, "revs"), path.join(dir, "entries", "y-000000", "revs")); // prettier-ignore
  assert.equal(await backend.read("entries/y-000000/revs/20261122T000001Z-1111111111.json", { max: 100 }), null); // prettier-ignore
  await assert.rejects(backend.add("entries/y-000000/revs/20261122T000002Z-2222222222.json", "{}"), { code: "invalid" }); // prettier-ignore
  assert.ok(!fs.existsSync(path.join(outside, "revs", "20261122T000002Z-2222222222.json")), "nothing written outside"); // prettier-ignore
  // A dangling symlink at a name a save will use is "exists", never written through.
  const dangling = "entries/x-000000/revs/20261122T000003Z-3333333333.json";
  fs.symlinkSync(path.join(outside, "planted.json"), path.join(dir, ...dangling.split("/"))); // prettier-ignore
  await assert.rejects(backend.add(dangling, "{}"), { code: "exists" });
  assert.ok(!fs.existsSync(path.join(outside, "planted.json")));
});

test("a meta read half-synced is asked again; a newer layout is refused; an orphan entry.json is stepped round", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const clock = { t: Date.UTC(2026, 10, 22, 10, 0, 0) };
  const ann = machine(dir, clock);
  const { entry, rev } = await ann.service.save(ann.store, { design: design(1), fields: FIELDS, app: APP }); // prettier-ignore
  const metaFile = path.join(dir, "entries", entry, "revs", `${rev}.json`);
  const whole = fs.readFileSync(metaFile, "utf8");
  // Bob looks while the meta is half written: the revision is not there yet…
  fs.writeFileSync(metaFile, whole.slice(0, 20));
  const bob = machine(dir, clock);
  assert.equal((await bob.service.view(bob.store)).entries.length, 0);
  // …and is, the next time he looks — the half file was not remembered.
  fs.writeFileSync(metaFile, whole);
  assert.equal((await bob.service.view(bob.store)).entries.length, 1);

  // An entry.json with no revision (a save cut off after its first file):
  // the same design saved again gets another id rather than "exists".
  const cut = await ann.service.save(ann.store, { design: design(7), fields: { ...FIELDS, title: "Cut" }, app: APP }); // prettier-ignore
  fs.rmSync(path.join(dir, "entries", cut.entry, "revs"), { recursive: true }); // only entry.json is left
  const retry = await machine(dir, clock).service.save(ann.store, { design: design(7), fields: { ...FIELDS, title: "Cut" }, app: APP }); // prettier-ignore
  assert.notEqual(retry.entry, cut.entry);

  // A store written by a newer layout is shown, never written into.
  const manifestFile = path.join(dir, "chiphippo-store.json");
  const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...m, format: 2 }));
  const later = machine(dir, clock);
  const view = await later.service.view(later.store);
  assert.equal(view.manifest.newer, true);
  await assert.rejects(later.service.save(later.store, { design: design(9), fields: FIELDS, app: APP }), { code: "newer" }); // prettier-ignore
});

test("a store named like a program (Synth.app) makes a folder anyone can still find", async () => {
  const parent = tmp();
  const dir = makeFolderStore(parent, { id: ID, name: "Synth.app" });
  assert.equal(path.basename(dir), "Synth app");
  assert.equal((await findStoreFolder(parent, { expectId: ID })).path, dir);
  assert.equal(folderNameFor("Kit.workflow"), "Kit workflow");
  assert.equal(folderNameFor("v1.2 board"), "v1.2 board");
});

test("a symlinked revs folder lists nothing, and an unreadable entries folder is said as denied", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const outside = tmp();
  fs.writeFileSync(
    path.join(outside, "20261122T000000Z-0000000000.json"),
    "{}",
  );
  fs.mkdirSync(path.join(dir, "entries", "x-000000"), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, "entries", "x-000000", "revs"));
  const backend = new FolderBackend(dir);
  assert.deepEqual(await backend.list(), ["chiphippo-store.json"]);
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    fs.chmodSync(path.join(dir, "entries"), 0o000);
    try {
      await assert.rejects(backend.list(), { code: "denied" });
    } finally {
      fs.chmodSync(path.join(dir, "entries"), 0o755);
    }
    // …and so is an unreadable revs folder (never quietly empty).
    fs.mkdirSync(path.join(dir, "entries", "y-000000", "revs"), { recursive: true }); // prettier-ignore
    fs.chmodSync(path.join(dir, "entries", "y-000000", "revs"), 0o000);
    try {
      await assert.rejects(backend.list(), { code: "denied" });
    } finally {
      fs.chmodSync(path.join(dir, "entries", "y-000000", "revs"), 0o755);
    }
  }
});
