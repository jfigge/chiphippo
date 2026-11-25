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

test("a friend whose clock runs ahead: a revision built on theirs is never stamped before it, so it is the head and a later save from theirs is asked first", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const annClock = { t: Date.UTC(2026, 10, 22, 12, 5, 0) }; // five minutes fast
  const bobClock = { t: Date.UTC(2026, 10, 22, 12, 2, 0) }; // right
  const ann = machine(dir, annClock);
  const bob = machine(dir, bobClock);
  const first = await ann.service.save(ann.store, { design: design(1), fields: FIELDS, app: APP }); // prettier-ignore
  const second = await bob.service.save(bob.store, { design: design(2), fields: { ...FIELDS, author: "Bob" }, entry: first.entry, base: first.rev, app: APP }); // prettier-ignore
  const view = await machine(dir, bobClock).service.view(bob.store);
  const [entry] = view.entries;
  assert.equal(entry.forked, false, "no false fork");
  assert.equal(entry.head.rev, second.rev, "Bob's change is the latest");
  // Ann saving from her first revision again is "behind" — never a silent fork.
  await assert.rejects(
    machine(dir, annClock).service.save(ann.store, { design: design(3), fields: FIELDS, entry: first.entry, base: first.rev, app: APP }), // prettier-ignore
    { code: "behind" },
  );
});

test("two friends saving the same untouched design make two entries, never one entry.json written on two machines", async () => {
  const clock = { t: Date.UTC(2026, 10, 22, 10, 0, 0) };
  // Each saves before the other's files have synced: two copies of one store.
  const ann = machine(makeFolderStore(tmp(), { id: ID, name: "Lab" }), clock);
  const bob = machine(makeFolderStore(tmp(), { id: ID, name: "Lab" }), clock);
  const a = await ann.service.save(ann.store, { design: design(1), fields: FIELDS, app: APP }); // prettier-ignore
  const b = await bob.service.save(bob.store, { design: design(1), fields: FIELDS, app: APP }); // prettier-ignore
  assert.notEqual(a.entry, b.entry);
});

test("past the listing cap the NEWEST entry folders are kept, and revisions are cut oldest-first", async () => {
  const { MAX_DIR_ITEMS } = require("../stores/folder");
  const {
    MAX_ENTRY_REVS,
  } = require("../../web/scripts/stores/store-format.js");
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const entries = path.join(dir, "entries");
  fs.mkdirSync(entries);
  const old = new Date(Date.UTC(2020, 0, 1));
  for (let n = 0; n <= MAX_DIR_ITEMS; n += 1) {
    const d = path.join(entries, `e${n}-abcdef`);
    fs.mkdirSync(d);
    fs.utimesSync(d, old, old);
  }
  // One real entry, made last: kept, however the folder lists.
  const live = path.join(entries, "live-abcdef");
  fs.mkdirSync(path.join(live, "revs"), { recursive: true });
  fs.writeFileSync(path.join(live, "entry.json"), "{}");
  const revs = [];
  const stamp = (n) => `2026${String(1 + Math.floor(n / 600)).padStart(2, "0")}01T${String(Math.floor(n / 60) % 24).padStart(2, "0")}${String(n % 60).padStart(2, "0")}00Z-0123456789`; // prettier-ignore
  for (let n = 0; n < MAX_ENTRY_REVS + 5; n += 1) {
    const rev = stamp(n);
    revs.push(rev);
    fs.writeFileSync(path.join(live, "revs", `${rev}.json`), "{}");
    fs.writeFileSync(path.join(live, "revs", `${rev}.desktop.chiphippo`), "{}");
  }
  // Saves that never completed (a design, no meta), all NEWER than every
  // real one: they must not push a real revision out of view.
  for (let n = 0; n < 20; n += 1) {
    fs.writeFileSync(path.join(live, "revs", `${stamp(1000 + n)}.desktop.chiphippo`), "{}"); // prettier-ignore
  }
  const listed = await new FolderBackend(dir).list();
  assert.ok(listed.includes("entries/live-abcdef/entry.json"));
  const kept = listed.filter((p) => p.startsWith("entries/live-abcdef/revs/"));
  assert.equal(
    kept.length,
    2 * MAX_ENTRY_REVS,
    "the newest complete revisions, design and meta each",
  );
  const newest = [...revs].sort().reverse();
  assert.ok(kept.includes(`entries/live-abcdef/revs/${newest[0]}.json`), "the newest revision is never the one cut"); // prettier-ignore
  assert.ok(!kept.includes(`entries/live-abcdef/revs/${newest.at(-1)}.json`));
});

test("a write never replaces what is there, also on a filesystem with no hard links", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const backend = new FolderBackend(dir);
  const rel = "entries/led-abcdef/entry.json";
  const realLink = fs.promises.link;
  fs.promises.link = async () => {
    throw Object.assign(new Error("no hard links here"), { code: "ENOTSUP" });
  };
  try {
    assert.equal(await backend.add(rel, '{"a":1}'), true);
    await assert.rejects(backend.add(rel, '{"a":2}'), { code: "exists" });
  } finally {
    fs.promises.link = realLink;
  }
  assert.equal(fs.readFileSync(path.join(dir, rel), "utf8"), '{"a":1}');
  // No temp file is left in the store.
  assert.deepEqual(fs.readdirSync(path.join(dir, "entries", "led-abcdef")), ["entry.json"]); // prettier-ignore
  // With hard links: the same, and a read gives the bytes back.
  await assert.rejects(backend.add(rel, "x"), { code: "exists" });
  assert.equal((await backend.read(rel, { max: 100 })).toString(), '{"a":1}');
  await assert.rejects(backend.read(rel, { max: 3 }), { code: "tooBig" });
});

test("a write that turns out to have landed outside the store (a folder swapped for a link meanwhile) is undone and refused", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const backend = new FolderBackend(dir);
  const rel = "entries/led-abcdef/entry.json";
  let asked = 0;
  backend._contained = async () => (asked += 1) === 1; // inside before, outside after
  await assert.rejects(backend.add(rel, "{}"), { code: "invalid" });
  assert.equal(
    fs.existsSync(path.join(dir, rel)),
    false,
    "what landed is removed",
  );
});

test("a read never follows a symlink planted at the file's own name, even one made after the check", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const outside = path.join(tmp(), "secret.json");
  fs.writeFileSync(outside, '{"secret":1}');
  const rel = "entries/led-abcdef/entry.json";
  fs.mkdirSync(path.join(dir, "entries", "led-abcdef"), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), "{}");
  const backend = new FolderBackend(dir);
  // Swapped for a link between the lstat and the open.
  const realOpen = fs.promises.open;
  fs.promises.open = async (file, flags) => {
    if (file === path.join(dir, rel)) {
      fs.rmSync(file);
      fs.symlinkSync(outside, file);
    }
    return realOpen(file, flags);
  };
  try {
    assert.equal(await backend.read(rel, { max: 100 }), null);
  } finally {
    fs.promises.open = realOpen;
  }
});

test("a revision built on one stamped 9999-12-31 (a broken clock) is still a revision — never an id that cannot be named", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const clock = { t: Date.UTC(2026, 10, 22, 10, 0, 0) };
  const ann = machine(dir, clock);
  const first = await ann.service.save(ann.store, { design: design(1), fields: FIELDS, app: APP }); // prettier-ignore
  const far = "99991231T235959Z-0123456789";
  const saved = await ann.service.save(ann.store, { design: design(2), fields: FIELDS, entry: first.entry, base: far, fork: true, app: APP }); // prettier-ignore
  assert.match(saved.rev, /^99991231T235959Z-[0-9a-f]{10}$/);
});

test("a whole view takes the folder's grant ONCE, however many files it reads", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const clock = { t: Date.UTC(2026, 10, 22, 10, 0, 0) };
  const ann = machine(dir, clock);
  for (let n = 0; n < 3; n += 1) {
    clock.t += 1000;
    await ann.service.save(ann.store, { design: design(n), fields: { ...FIELDS, title: `T${n}` }, app: APP }); // prettier-ignore
  }
  let grants = 0;
  const service = new StoreService({
    backendFor: (s) => new FolderBackend(s.where.path, { access: (fn) => ((grants += 1), fn()) }), // prettier-ignore
    sha256Hex: (d) => crypto.createHash("sha256").update(d).digest("hex"),
    randomHex: (n) => crypto.randomBytes(n).toString("hex"),
    now: () => clock.t,
  });
  const view = await service.view(ann.store);
  assert.equal(view.entries.length, 3);
  assert.equal(grants, 1);
});

test("a hard link refused as EISDIR (FAT32, exFAT, Google Drive's drive on Windows) falls back to an exclusive create", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const backend = new FolderBackend(dir);
  const realLink = fs.promises.link;
  fs.promises.link = async () => {
    throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
  };
  try {
    assert.equal(
      await backend.add("entries/led-abcdef/entry.json", "{}"),
      true,
    );
  } finally {
    fs.promises.link = realLink;
  }
});

test("a file that grows while it is read is not whole yet: read as not there", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const rel = "entries/led-abcdef/entry.json";
  fs.mkdirSync(path.join(dir, "entries", "led-abcdef"), { recursive: true });
  const file = path.join(dir, rel);
  fs.writeFileSync(file, "{}");
  const backend = new FolderBackend(dir);
  const realOpen = fs.promises.open;
  fs.promises.open = async (f, flags) => {
    const fh = await realOpen(f, flags);
    if (f === file) {
      const stat = fh.stat.bind(fh);
      fh.stat = async () => {
        const st = await stat();
        fs.appendFileSync(file, " ".repeat(50)); // grows after the stat
        return st;
      };
    }
    return fh;
  };
  try {
    assert.equal(await backend.read(rel, { max: 1000 }), null);
  } finally {
    fs.promises.open = realOpen;
  }
});

test("a new store's folder is MADE: a name something else took meanwhile is stepped past, never written into", async () => {
  const parent = tmp();
  const realMkdir = fs.mkdirSync;
  let first = true;
  fs.mkdirSync = (d, o) => {
    // A sync client brings a folder of that name between the look and the make.
    if (first && path.basename(d) === "Lab") {
      first = false;
      realMkdir(d);
      fs.writeFileSync(path.join(d, "chiphippo-store.json"), '{"theirs":1}');
    }
    return realMkdir(d, o);
  };
  let dir;
  try {
    dir = makeFolderStore(parent, { id: ID, name: "Lab" });
  } finally {
    fs.mkdirSync = realMkdir;
  }
  assert.equal(path.basename(dir), "Lab 2");
  assert.equal(fs.readFileSync(path.join(parent, "Lab", "chiphippo-store.json"), "utf8"), "{\"theirs\":1}"); // prettier-ignore
});

test("a revs folder filled by hand is read no further than its cap, name by name", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const revs = path.join(dir, "entries", "led-abcdef", "revs");
  fs.mkdirSync(revs, { recursive: true });
  fs.writeFileSync(path.join(dir, "entries", "led-abcdef", "entry.json"), "{}");
  const realOpendir = fs.promises.opendir;
  let yielded = 0;
  fs.promises.opendir = async (d) => {
    if (d !== revs) return realOpendir(d);
    return {
      async *[Symbol.asyncIterator]() {
        for (let n = 0; n < 1e7; n += 1) {
          yielded += 1;
          yield { name: `x${n}`, isSymbolicLink: () => false };
        }
      },
      close: async () => {},
    };
  };
  try {
    await new FolderBackend(dir).list();
  } finally {
    fs.promises.opendir = realOpendir;
  }
  const {
    MAX_ENTRY_REVS,
  } = require("../../web/scripts/stores/store-format.js");
  assert.equal(yielded, 50 * MAX_ENTRY_REVS, "stopped at the cap");
});

test("this app's own temp files left over an hour are swept from where a write lands — nothing else is touched", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const here = path.join(dir, "entries", "led-abcdef");
  fs.mkdirSync(here, { recursive: true });
  const old = path.join(here, "entry.json.chiphippotmp-123-deadbeef.tmp");
  const young = path.join(here, "x.json.chiphippotmp-123-cafef00d.tmp");
  const theirs = path.join(here, "notes.txt");
  for (const f of [old, young, theirs]) fs.writeFileSync(f, "x");
  const longAgo = new Date(Date.now() - 2 * 3600_000);
  fs.utimesSync(old, longAgo, longAgo);
  fs.utimesSync(theirs, longAgo, longAgo);
  await new FolderBackend(dir).add("entries/led-abcdef/entry.json", "{}");
  assert.equal(fs.existsSync(old), false, "the stale temp is gone");
  assert.equal(fs.existsSync(young), true, "one still being written stays");
  assert.equal(fs.existsSync(theirs), true, "never anything else");
});

test("a file that appears at the name between the check and the link is never written over", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const rel = "entries/led-abcdef/entry.json";
  const full = path.join(dir, rel);
  const realLink = fs.promises.link;
  fs.promises.link = async (from, to) => {
    fs.writeFileSync(to, '{"theirs":1}'); // a friend's copy syncs in now
    return realLink(from, to);
  };
  try {
    await assert.rejects(new FolderBackend(dir).add(rel, "{\"mine\":1}"), { code: "exists" }); // prettier-ignore
  } finally {
    fs.promises.link = realLink;
  }
  assert.equal(fs.readFileSync(full, "utf8"), '{"theirs":1}');
});

test("on Windows an online-only placeholder (a reparse point a listing calls a link) is still read; a real link is not", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const clock = { t: Date.UTC(2026, 10, 22, 10, 0, 0) };
  const ann = machine(dir, clock);
  const saved = await ann.service.save(ann.store, { design: design(1), fields: FIELDS, app: APP }); // prettier-ignore
  const entries = path.join(dir, "entries");
  const realReaddir = fs.promises.readdir;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  // Every name in `entries` listed as a "link", as Windows lists OneDrive's
  // Files On-Demand folders.
  fs.promises.readdir = async (d, opts) => {
    const items = await realReaddir(d, opts);
    if (d !== entries || !opts?.withFileTypes) return items;
    return items.map((it) => Object.assign(Object.create(Object.getPrototypeOf(it)), it, { isSymbolicLink: () => true })); // prettier-ignore
  };
  try {
    const listed = await new FolderBackend(dir).list();
    assert.ok(listed.includes(`entries/${saved.entry}/entry.json`), "the placeholder folder is read"); // prettier-ignore
  } finally {
    fs.promises.readdir = realReaddir;
    Object.defineProperty(process, "platform", platform);
  }
});

test("a drive that cannot resolve real paths (realpath answers EISDIR) is still a store", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const backend = new FolderBackend(dir);
  const realRealpath = fs.promises.realpath;
  fs.promises.realpath = async () => {
    throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
  };
  try {
    assert.equal(
      await backend.add("entries/led-abcdef/entry.json", "{}"),
      true,
    );
    assert.equal((await backend.read("entries/led-abcdef/entry.json", { max: 10 })).toString(), "{}"); // prettier-ignore
  } finally {
    fs.promises.realpath = realRealpath;
  }
});

test("a store named like a Windows device (CON, NUL, COM1…) gets a folder Windows can hold", () => {
  for (const name of ["CON", "nul", "Com1", "LPT9.txt", "COM\u00b9", "lpt\u00b3.log"]) assert.equal(folderNameFor(name), `${name} store`); // prettier-ignore
  assert.equal(folderNameFor("Console"), "Console");
});

test("an exclusive create that fails partway (a full disk) leaves no half file at the name", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const rel = "entries/led-abcdef/entry.json";
  const full = path.join(dir, rel);
  const realLink = fs.promises.link;
  const realOpen = fs.promises.open;
  fs.promises.link = async () => {
    throw Object.assign(new Error("no hard links"), { code: "ENOTSUP" });
  };
  fs.promises.open = async (file, flags) => {
    const fh = await realOpen(file, flags);
    if (file === full) {
      fh.writeFile = async () => {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      };
    }
    return fh;
  };
  try {
    await assert.rejects(new FolderBackend(dir).add(rel, "{}"));
  } finally {
    fs.promises.link = realLink;
    fs.promises.open = realOpen;
  }
  assert.equal(fs.existsSync(full), false);
});

test("a store at a drive's root (G:\\ or /) still resolves its own paths", () => {
  const root = path.parse(process.cwd()).root;
  const backend = new FolderBackend(root);
  assert.equal(backend._resolve("chiphippo-store.json"), path.join(root, "chiphippo-store.json")); // prettier-ignore
});

test("on Windows a friend's folder of online-only FILES (listed as links, not files) never crowds out the store's folder", async () => {
  const parent = tmp();
  for (let n = 0; n < 250; n += 1) fs.writeFileSync(path.join(parent, `a${String(n).padStart(3, "0")}.txt`), "x"); // prettier-ignore
  const dir = makeFolderStore(parent, { id: ID, name: "zed" });
  const realReaddir = fs.promises.readdir;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  // As libuv lists reparse points on Windows: a "link", neither file nor
  // folder — and in name order, so the 250 files come BEFORE the store's
  // folder (whatever order this disk would list them in).
  fs.promises.readdir = async (d, opts) => {
    const items = await realReaddir(d, opts);
    if (d !== parent || !opts?.withFileTypes) return items;
    items.sort((x, y) => x.name.localeCompare(y.name));
    return items.map((it) => ({ name: it.name, isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false })); // prettier-ignore
  };
  try {
    const found = await findStoreFolder(parent, { expectId: ID });
    assert.equal(found.path, dir);
  } finally {
    fs.promises.readdir = realReaddir;
    Object.defineProperty(process, "platform", platform);
  }
});

test("a read whose open file is not the one found at the path (swapped in between) reads nothing", async () => {
  const dir = makeFolderStore(tmp(), { id: ID, name: "Lab" });
  const rel = "entries/led-abcdef/entry.json";
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "{}");
  const realLstat = fs.promises.lstat;
  let seen = 0;
  fs.promises.lstat = async (f) => {
    const st = await realLstat(f);
    // The second look at the file (after the open) finds another one there.
    if (f === full && (seen += 1) === 2) return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: st.ino + 1 }); // prettier-ignore
    return st;
  };
  try {
    assert.equal(await new FolderBackend(dir).read(rel, { max: 100 }), null);
  } finally {
    fs.promises.lstat = realLstat;
  }
});

test("finding a store folder looks at no more than 200 folders (a cloud drive's root may hold thousands)", async () => {
  const parent = tmp();
  for (let n = 0; n < 210; n += 1) fs.mkdirSync(path.join(parent, `a${String(n).padStart(3, "0")}`)); // prettier-ignore
  makeFolderStore(parent, { id: ID, name: "zz" });
  const realReaddir = fs.promises.readdir;
  // Listed in name order, so the store's folder comes after the 200 others.
  fs.promises.readdir = async (d, o) => (await realReaddir(d, o)).sort((a, b) => String(a.name ?? a).localeCompare(String(b.name ?? b))); // prettier-ignore
  try {
    await assert.rejects(findStoreFolder(parent, { expectId: ID }), { code: "missing" }); // prettier-ignore
  } finally {
    fs.promises.readdir = realReaddir;
  }
});
