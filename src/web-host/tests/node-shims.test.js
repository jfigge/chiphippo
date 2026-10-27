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

// node-shims.test.js — the web build's stand-ins for Node's `path`, `Buffer`
// and `crypto` (src/web-host/node/), held to Node's own answers for the calls
// main makes. A stand-in that drifts from Node is a bug in code that was
// right on the desktop, so Node is the oracle throughout.

import test from "node:test";
import assert from "node:assert/strict";
import nodePath from "node:path";
import nodeCrypto from "node:crypto";
import { StringDecoder as NodeDecoder } from "node:string_decoder";

import * as path from "../node/path.js";
import { Buffer } from "../node/buffer.js";
import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
} from "../node/crypto.js";
import { StringDecoder } from "../node/string-decoder.js";

const P = nodePath.posix;

test("path agrees with Node's POSIX path on the shapes main uses", () => {
  const joins = [
    ["/app", "..", "web", "demos", "74LS00.json"],
    ["/userData", "saves", "default.chiphippo"],
    ["/a/b/", "./c", "../d"],
    ["a", "", "b"],
    ["/", "x"],
  ];
  for (const parts of joins)
    assert.equal(path.join(...parts), P.join(...parts), parts.join(","));
  const resolves = [
    ["/a/b", "../c"],
    ["x", "y"],
    ["/a", "/b", "c"],
    ["/a/./b/../c/"],
    ["/"],
  ];
  for (const parts of resolves) {
    // Node resolves a relative path against its own cwd; ours is "/".
    const want = P.resolve("/", ...parts);
    assert.equal(path.resolve(...parts), want, parts.join(","));
  }
  for (const p of [
    "/a/b/c.txt",
    "/a/b/",
    "/",
    "c",
    "/a/b.desktop.chiphippo",
    "a/b",
  ]) {
    assert.equal(path.dirname(p), P.dirname(p), `dirname ${p}`);
    assert.equal(path.basename(p), P.basename(p), `basename ${p}`);
    assert.equal(path.extname(p), P.extname(p), `extname ${p}`);
  }
  assert.equal(path.basename("/x/y.json", ".json"), "y");
  for (const [a, b] of [
    ["/web/docs", "/web/docs/x.md"],
    ["/web/demos", "/etc/passwd"],
    ["/a/b", "/a/b"],
  ]) {
    assert.equal(path.relative(a, b), P.relative(a, b), `${a} → ${b}`);
  }
  assert.equal(path.sep, "/");
});

test("Buffer encodes and decodes as Node's does", () => {
  const samples = ["", "hello", "naïve ☃ 漢字 🎛", "\u0000ÿ"];
  for (const s of samples) {
    for (const enc of ["utf8", "base64", "hex", "latin1"]) {
      const ours = Buffer.from(s).toString(enc);
      const theirs = globalThis.Buffer.from(s).toString(enc);
      assert.equal(ours, theirs, `${enc} of ${JSON.stringify(s)}`);
      assert.deepEqual(
        [...Buffer.from(theirs, enc)],
        [...globalThis.Buffer.from(theirs, enc)],
      );
    }
  }
  assert.equal(Buffer.byteLength("☃"), 3);
  assert.deepEqual(
    [...Buffer.concat([Buffer.from([1, 2]), Buffer.from([3])])],
    [1, 2, 3],
  );
  const b = Buffer.from([1, 2, 3, 4]);
  const view = b.slice(1, 3);
  view[0] = 9;
  assert.equal(b[1], 9, "slice is a view, as in Node");
  assert.ok(Buffer.isBuffer(view));
  assert.deepEqual(
    Buffer.from({ type: "Buffer", data: [5, 6] }),
    Buffer.from([5, 6]),
  );
});

test("Buffer decodes MALFORMED base64 as Node's does", () => {
  const NodeBuffer = globalThis.Buffer;
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\n -_\t.";
  let x = 12345;
  const next = () => (x = (x * 1103515245 + 12345) & 0x7fffffff);
  const cases = ["m5fBL", "CsP1H=jb", "j=e", "xy=-SDUSY", "AB= =", "-_-_", ""];
  for (let i = 0; i < 20000; i++) {
    let s = "";
    for (let n = next() % 14; n > 0; n--)
      s += alphabet[next() % alphabet.length];
    cases.push(s);
  }
  for (const s of cases) {
    assert.equal(
      NodeBuffer.from(Buffer.from(s, "base64")).toString("hex"),
      NodeBuffer.from(s, "base64").toString("hex"),
      JSON.stringify(s),
    );
  }
});

test("SHA-256 matches Node's at every padding boundary", () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 70_000]) {
    const bytes = nodeCrypto.randomBytes(n);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      nodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      `${n} bytes`,
    );
  }
  assert.throws(() => createHash("md5"));
});

test("the random helpers give what main asks for", () => {
  assert.equal(randomBytes(70_000).length, 70_000);
  assert.match(randomUUID(), /^[0-9a-f-]{36}$/);
  for (let i = 0; i < 500; i++) {
    const v = randomInt(1, 65536);
    assert.ok(v >= 1 && v < 65536);
  }
});

test("StringDecoder joins a character split across chunks", () => {
  const bytes = globalThis.Buffer.from("a☃b");
  const ours = new StringDecoder("utf8");
  const theirs = new NodeDecoder("utf8");
  const a =
    ours.write(bytes.subarray(0, 2)) +
    ours.write(bytes.subarray(2)) +
    ours.end();
  const b =
    theirs.write(bytes.subarray(0, 2)) +
    theirs.write(bytes.subarray(2)) +
    theirs.end();
  assert.equal(a, b);
});
