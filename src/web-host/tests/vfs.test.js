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

// vfs.test.js — the in-memory filesystem main runs on in the web build. Held
// to the sequences main's stores really make (io.js's atomic write: open a
// temp file, write, fsync, close, rename over the target), to Node's error
// codes, and to the change events storage and the visitor's files follow.

import test from "node:test";
import assert from "node:assert/strict";
import { Vfs } from "../vfs.js";

test("io.js's atomic write lands as one change, after the rename", () => {
  const fs = new Vfs();
  const seen = [];
  fs.onChange((c) => seen.push(c));
  fs.mkdirSync("/userData/saves", { recursive: true });
  const tmp = "/userData/saves/p.chiphippo.chiphippotmp-1.tmp";
  const fd = fs.openSync(tmp, "w");
  fs.fchmodSync(fd, 0o600);
  fs.writeFileSync(fd, '{"a":1}', "utf8");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, "/userData/saves/p.chiphippo");
  assert.equal(
    fs.readFileSync("/userData/saves/p.chiphippo", "utf8"),
    '{"a":1}',
  );
  assert.equal(fs.existsSync(tmp), false);
  assert.equal(fs.statSync("/userData/saves/p.chiphippo").mode & 0o7777, 0o600);
  assert.deepEqual(
    seen.map((c) => c.op),
    ["mkdir", "mkdir", "write", "rename"],
  );
  assert.equal(seen.at(-1).path, "/userData/saves/p.chiphippo");
});

test("errors carry Node's codes", () => {
  const fs = new Vfs();
  const code = (fn) => {
    try {
      fn();
    } catch (err) {
      return err.code;
    }
    return null;
  };
  assert.equal(
    code(() => fs.readFileSync("/nope")),
    "ENOENT",
  );
  assert.equal(
    code(() => fs.writeFileSync("/no/dir/file", "x")),
    "ENOENT",
  );
  fs.mkdirSync("/d");
  assert.equal(
    code(() => fs.mkdirSync("/d")),
    "EEXIST",
  );
  assert.equal(
    code(() => fs.readFileSync("/d")),
    "EISDIR",
  );
  assert.equal(
    code(() => fs.unlinkSync("/d")),
    "EISDIR",
  );
  assert.equal(
    code(() => fs.closeSync(999)),
    "EBADF",
  );
  assert.equal(fs.statSync("/nope", { throwIfNoEntry: false }), undefined);
});

test("a file keeps its identity across an overwrite, not across a new path", () => {
  const fs = new Vfs();
  fs.writeFileSync("/a", "1");
  const ino = fs.statSync("/a").ino;
  fs.writeFileSync("/a", "2");
  assert.equal(fs.statSync("/a").ino, ino);
  fs.writeFileSync("/b", "3");
  assert.notEqual(fs.statSync("/b").ino, ino);
  assert.equal(fs.statSync("/a").dev, fs.statSync("/b").dev);
});

test("readSync and readdirSync behave as mem-store and bookmark-store expect", () => {
  const fs = new Vfs();
  fs.mkdirSync("/m", { recursive: true });
  fs.writeFileSync("/m/x.bin", new Uint8Array([1, 2, 3, 4, 5]));
  fs.writeFileSync("/m/y.bin", new Uint8Array([9]));
  fs.mkdirSync("/m/sub");
  fs.writeFileSync("/m/sub/z", "z");
  assert.deepEqual(fs.readdirSync("/m"), ["sub", "x.bin", "y.bin"]);
  const fd = fs.openSync("/m/x.bin", 0 /* O_RDONLY */ | 0o4000);
  const buf = new Uint8Array(3);
  assert.equal(fs.readSync(fd, buf, 0, 3, 0), 3);
  assert.deepEqual([...buf], [1, 2, 3]);
  assert.equal(fs.readSync(fd, buf, 0, 3, null), 3);
  assert.equal(fs.readSync(fd, buf, 0, 3, null), 2);
  assert.equal(fs.fstatSync(fd).size, 5);
  assert.ok(fs.fstatSync(fd).isFile());
  fs.closeSync(fd);
});

test("a lazy node reads synchronously or asynchronously, once", async () => {
  const fs = new Vfs();
  let syncLoads = 0;
  let asyncLoads = 0;
  fs.registerLazy("/web/locales/en.json", {
    size: 2,
    loadSync: () => (syncLoads++, new TextEncoder().encode("{}")),
    load: async () => (asyncLoads++, new TextEncoder().encode("{}")),
  });
  assert.ok(fs.existsSync("/web/locales"));
  assert.equal(fs.statSync("/web/locales/en.json").size, 2);
  assert.equal(await fs.readFile("/web/locales/en.json", "utf8"), "{}");
  assert.equal(fs.readFileSync("/web/locales/en.json", "utf8"), "{}");
  assert.deepEqual([syncLoads, asyncLoads], [0, 1]);
  fs.registerLazy("/web/docs/x.md", {
    size: 1,
    loadSync: null,
    load: async () => null,
  });
  assert.throws(() => fs.readFileSync("/web/docs/x.md"), { code: "EACCES" });
  await assert.rejects(fs.readFile("/web/docs/x.md"), { code: "ENOENT" });
});

test("restoring is quiet; renaming a folder moves what is in it", () => {
  const fs = new Vfs();
  const seen = [];
  fs.onChange((c) => seen.push(c));
  fs.restoreFile("/userData/settings.json", "{}");
  assert.equal(seen.length, 0);
  fs.mkdirSync("/f/a", { recursive: true });
  fs.writeFileSync("/f/a/1", "x");
  fs.renameSync("/f/a", "/f/b");
  assert.equal(fs.readFileSync("/f/b/1", "utf8"), "x");
  assert.equal(fs.existsSync("/f/a/1"), false);
  fs.forget("/f");
  assert.equal(fs.existsSync("/f/b/1"), false);
});
