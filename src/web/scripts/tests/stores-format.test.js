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

// A private store's layout (stores/store-format.js): its names, the reading
// of a whole store into entries with heads and forks, and the share link.
import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_ENTRY_REVS,
  STORE_FILE,
  buildStoreView,
  entryPath,
  headOf,
  makeManifest,
  makeRevMeta,
  makeStoreEntry,
  normalizeManifest,
  normalizeRevMeta,
  normalizeStoreRef,
  parseStoreLink,
  parseStorePath,
  pathsToRead,
  revIdFor,
  revPath,
  revTime,
  saveVerdict,
  storeLink,
  storeName,
} from "../stores/store-format.js";

const ID = "s-0123456789abcdef";
const E = "led-chaser-3fa9c1";

test("every name a store holds is built and read back by one rule", () => {
  assert.equal(entryPath(E), `entries/${E}/entry.json`);
  const rev = revIdFor(Date.UTC(2026, 10, 22, 9, 5, 7), "abcdef0123456789");
  assert.equal(rev, "20261122T090507Z-abcdef0123");
  assert.equal(revTime(rev), Date.UTC(2026, 10, 22, 9, 5, 7));
  for (const part of ["design", "thumb", "meta"]) {
    assert.deepEqual(parseStorePath(revPath(E, rev, part)), { kind: "rev", entry: E, rev, part }); // prettier-ignore
  }
  assert.deepEqual(parseStorePath(entryPath(E)), { kind: "entry", entry: E });
  assert.deepEqual(parseStorePath(STORE_FILE), { kind: "manifest" });
});

test("what is not part of the store is not read as part of it", () => {
  for (const rel of [
    ".DS_Store",
    "entries/.DS_Store",
    `entries/${E}/entry (1).json`,
    `entries/${E}/revs/20261122T090507Z-abcdef0123 (conflicted copy).json`,
    `entries/${E}/revs/20261122T090507Z-abcdef0123.json.tmp`,
    "entries/Not An Id/entry.json",
    `entries/${E}/revs/nope.json`,
    `../${STORE_FILE}`,
    null,
  ]) {
    assert.equal(parseStorePath(rel), null, String(rel));
  }
  assert.throws(() => entryPath("../x"));
  assert.throws(() => revPath(E, "../../x", "meta"));
  assert.throws(() => revPath(E, "20261122T090507Z-abcdef0123", "exe"));
});

test("a manifest: made with an id, read leniently, newer layouts flagged", () => {
  const m = makeManifest({ id: ID, name: "  Our   lab ", created: "2026-11-22T10:00:00.000Z" }); // prettier-ignore
  assert.deepEqual(m, { format: 1, id: ID, name: "Our lab", created: "2026-11-22T10:00:00.000Z" }); // prettier-ignore
  assert.equal(normalizeManifest(m).newer, false);
  assert.equal(normalizeManifest({ ...m, format: 2 }).newer, true);
  assert.equal(normalizeManifest({ ...m, id: "nope" }), null);
  assert.equal(normalizeManifest("x"), null);
  assert.throws(() => makeManifest({ id: "bad" }));
});

const rev = (n, base = null, extra = {}) => ({
  ...makeRevMeta({
    rev: `2026112${n}T000000Z-${String(n).repeat(10)}`,
    base,
    author: "Ann",
    note: `rev ${n}`,
    at: `2026-11-2${n}T00:00:00.000Z`,
    ...extra,
  }),
});

test("a revision's meta must be named for itself, and its base another", () => {
  const r = rev(1);
  assert.equal(normalizeRevMeta(r, r.rev).rev, r.rev);
  assert.equal(normalizeRevMeta(r, "20261121T000000Z-2222222222"), null);
  assert.equal(normalizeRevMeta({ ...r, base: r.rev }, r.rev).base, null);
  assert.equal(normalizeRevMeta({ ...r, base: "junk" }, r.rev).base, null);
});

test("the head is the newest revision nothing is built on; two such is a fork", () => {
  const a = rev(1);
  const b = rev(2, a.rev);
  const c = rev(3, b.rev);
  assert.equal(headOf([a, b, c]).head.rev, c.rev);
  assert.equal(headOf([a, b, c]).leaves.length, 1);
  // Two friends both saved from b.
  const d = rev(4, b.rev);
  const { head, leaves } = headOf([a, b, c, d]);
  assert.equal(head.rev, d.rev);
  assert.deepEqual(
    leaves.map((r) => r.rev),
    [d.rev, c.rev],
  );
  // A base not (yet) synced is no ancestor of anything here.
  assert.equal(headOf([rev(5, "20261101T000000Z-9999999999")]).leaves.length, 1); // prettier-ignore
});

test("a save from the head follows it; from anything older it is asked about", () => {
  const a = rev(1);
  const b = rev(2, a.rev);
  const entry = { revs: [b, a], head: b };
  assert.equal(saveVerdict(null, null), "new");
  assert.equal(saveVerdict(entry, b.rev), "next");
  assert.equal(saveVerdict(entry, a.rev), "behind");
  assert.equal(saveVerdict(entry, null), "behind");
});

test("a whole store: only entries whose revisions have arrived whole", () => {
  const a = rev(1);
  const b = rev(2, a.rev);
  const lone = rev(3);
  const files = new Map([
    [entryPath(E), makeStoreEntry({ id: E, title: "LED chaser", author: "Ann", tags: ["555"], created: "2026-11-21T00:00:00.000Z" })], // prettier-ignore
    [revPath(E, a.rev, "meta"), a],
    [revPath(E, b.rev, "meta"), b],
    // An entry still syncing: its meta is here, its design is not.
    [entryPath("half-000001"), makeStoreEntry({ id: "half-000001", title: "Half" })], // prettier-ignore
    [revPath("half-000001", lone.rev, "meta"), lone],
  ]);
  const paths = [
    STORE_FILE,
    ...files.keys(),
    revPath(E, a.rev, "design"),
    revPath(E, b.rev, "design"),
    revPath(E, b.rev, "thumb"),
    // A design whose meta never came (a save cut off): no revision.
    revPath(E, "20261129T000000Z-0000000000", "design"),
  ];
  const toRead = pathsToRead(paths);
  assert.ok(toRead.includes(revPath(E, b.rev, "meta")));
  assert.ok(!toRead.includes(revPath("half-000001", lone.rev, "meta")));
  const view = buildStoreView({ paths, read: (rel) => files.get(rel) });
  assert.equal(view.entries.length, 1);
  const [entry] = view.entries;
  assert.equal(entry.title, "LED chaser");
  assert.equal(entry.head.rev, b.rev);
  assert.equal(entry.revs.length, 2);
  assert.equal(entry.revs[0].thumb, true);
  assert.equal(entry.revs[1].thumb, false);
  assert.equal(entry.forked, false);
  assert.equal(entry.derived.engine, "logic");
});

test("a share link round-trips in both forms, and carries no more than where", () => {
  const ref = { id: ID, name: "Bench club ⚡", kind: "github", where: { repo: "ann/chip-designs", token: "secret" } }; // prettier-ignore
  const web = storeLink(ref);
  assert.match(web, /^https:\/\/chiphippo\.com\/store\/#[A-Za-z0-9_-]+$/);
  const app = storeLink(ref, { web: false });
  assert.match(app, /^chiphippo:\/\/store\/add#/);
  const back = { id: ID, name: "Bench club ⚡", kind: "github", where: { repo: "ann/chip-designs" } }; // prettier-ignore
  assert.deepEqual(parseStoreLink(web), back);
  assert.deepEqual(parseStoreLink(` <${app}> `), back);
  assert.ok(!web.includes("secret") && !JSON.stringify(parseStoreLink(web)).includes("secret")); // prettier-ignore
  const folder = parseStoreLink(storeLink({ id: ID, name: "Lab", kind: "folder", where: { provider: "dropbox", path: "/Users/ann" } })); // prettier-ignore
  assert.deepEqual(folder, { id: ID, name: "Lab", kind: "folder", where: { provider: "dropbox" } }); // prettier-ignore
});

test("anything else is no store link", () => {
  for (const text of [
    "",
    "https://example.com/store/#e30",
    "https://chiphippo.com/store/",
    "chiphippo://store/add#!!!",
    `chiphippo://store/add#${btoa(JSON.stringify({ v: 2, id: ID, kind: "folder" }))}`,
    `chiphippo://store/add#${btoa(JSON.stringify({ v: 1, id: "nope", kind: "folder" }))}`,
    `https://chiphippo.com/store/#${"A".repeat(2000)}`,
  ]) {
    assert.equal(parseStoreLink(text), null, text.slice(0, 60));
  }
  assert.equal(normalizeStoreRef({ id: ID, kind: "github", where: { repo: "a/.." } }), null); // prettier-ignore
  assert.equal(normalizeStoreRef({ id: ID, kind: "s3" }), null);
});

test("a GitHub store kept in a folder of a repository: the link carries the folder, and only a safe one", () => {
  const ref = { id: ID, name: "Lab", kind: "github", where: { repo: "ann/site", dir: "designs/chiphippo" } }; // prettier-ignore
  assert.deepEqual(parseStoreLink(storeLink(ref)), ref);
  // The root is no folder at all.
  assert.deepEqual(normalizeStoreRef({ ...ref, where: { repo: "ann/site", dir: "" } }).where, { repo: "ann/site" }); // prettier-ignore
  for (const dir of ["../up", "a/../b", "a//b", "has space", "a/b/c/d/e"]) {
    assert.equal(normalizeStoreRef({ ...ref, where: { repo: "ann/site", dir } }), null, dir); // prettier-ignore
  }
});

test("a cycle of bases (anyone can write a store) cannot leave an entry headless", () => {
  const a = rev(1, "20261122T000000Z-2222222222");
  const b = rev(2, a.rev);
  // b names a (older): fine. a names b (NEWER): not an ancestor.
  const cyc = { ...a, base: b.rev };
  const { head, leaves } = headOf([cyc, b]);
  assert.equal(head.rev, b.rev);
  assert.deepEqual(
    leaves.map((r) => r.rev),
    [b.rev],
  );
  // Two revisions naming each other: both are leaves; the store still opens.
  const x = rev(3, "20261124T000000Z-4444444444");
  const y = rev(4, x.rev);
  const view = buildStoreView({
    paths: [STORE_FILE, entryPath(E), revPath(E, x.rev, "design"), revPath(E, x.rev, "meta"), revPath(E, y.rev, "design"), revPath(E, y.rev, "meta")], // prettier-ignore
    read: (rel) => (rel === entryPath(E) ? makeStoreEntry({ id: E, title: "T" }) : rel.includes(x.rev) ? x : y), // prettier-ignore
  });
  assert.equal(view.entries.length, 1);
  assert.equal(view.entries[0].head.rev, y.rev);
  // Two revisions naming each other within ONE second, beside an older
  // plain one: only one direction counts, so the cycle still has a leaf and
  // the older revision is not mistaken for the head.
  const old = rev(4, null);
  const p = { ...rev(6, null), rev: "20261125T000000Z-1111111111" };
  const q = { ...rev(7, null), rev: "20261125T000000Z-9999999999" };
  const pq = [old, { ...p, base: q.rev }, { ...q, base: p.rev }];
  assert.equal(headOf(pq).head.rev, q.rev);
});

test("saving from the other leaf of a fork just follows it — nothing is built on it", () => {
  const a = rev(1);
  const b = rev(2, a.rev);
  const c = rev(3, a.rev);
  const entry = { revs: [c, b, a], ...headOf([c, b, a]) };
  assert.equal(saveVerdict(entry, b.rev), "next", "b is a leaf");
  assert.equal(saveVerdict(entry, c.rev), "next");
  assert.equal(saveVerdict(entry, a.rev), "behind", "a is built on");
});

test("files that never complete (a design with no meta) cannot push a real revision out of view", () => {
  const real = rev(1, null);
  const paths = [STORE_FILE, entryPath(E), revPath(E, real.rev, "design"), revPath(E, real.rev, "meta")]; // prettier-ignore
  for (let n = 0; n < MAX_ENTRY_REVS + 10; n += 1) {
    paths.push(revPath(E, `20271201T${String(n).padStart(6, "0")}Z-0123456789`, "design")); // prettier-ignore
  }
  const view = buildStoreView({
    paths,
    read: (rel) => (rel === entryPath(E) ? makeStoreEntry({ id: E, title: "T" }) : real), // prettier-ignore
  });
  assert.equal(view.entries.length, 1);
  assert.deepEqual(
    view.entries[0].revs.map((r) => r.rev),
    [real.rev],
  );
});

test("a name cut to its length never splits an emoji in half", () => {
  const name = `${"a".repeat(59)}😀more`;
  const cut = storeName(name);
  assert.ok(!/[\uD800-\uDBFF]$/.test(cut), "no lone high surrogate");
  assert.equal(cut, "a".repeat(59));
});

test("a name, title or author can carry no bidi controls (they would reorder the text around it)", () => {
  assert.equal(storeName("Lab\u202Eevil\u2066x\u200F"), "Lab evil x");
  assert.equal(storeName("Lab\u061Cx"), "Lab x", "the Arabic letter mark too");
  // …and in a paragraph field (a revision's note), where a newline stays.
  const meta = normalizeRevMeta({ rev: "20261122T100000Z-0123456789", note: "one\u061C\u202Etwo\nthree" }, "20261122T100000Z-0123456789"); // prettier-ignore
  assert.equal(meta.note, "one  two\nthree");
});
