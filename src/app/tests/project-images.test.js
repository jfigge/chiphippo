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

// The ROM bytes that travel INSIDE a project file. What matters: only a
// PROGRAMMED chip is collected (noise does not need to travel), a hydrate
// refills the cache so a project opens whole on a machine that has never seen
// it, and a COPIED desktop is reseated onto its own guids and its own files —
// two chips sharing one backing file is the bug this exists to prevent.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  collectImages,
  hydrateImages,
  reseatImages,
} = require("../store/project-images");

const GUID_A = "11111111-2222-3333-4444-555555555555";
const GUID_B = "66666666-7777-8888-9999-aaaaaaaaaaaa";

function withMemDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-images-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const seed = (dir, guid, bytes) =>
  fs.writeFileSync(path.join(dir, `${guid}.bin`), Buffer.from(bytes));

const bytesOf = (dir, guid) =>
  Array.from(fs.readFileSync(path.join(dir, `${guid}.bin`)));

/** A desk document whose components are `[guid, programmed]` pairs. */
const docOf = (...chips) => ({
  components: chips.map(([guid, programmed], i) => ({
    id: `c${i + 1}`,
    ref: "rom-8k",
    params: { storage: { guid }, programmed },
  })),
});

test("collect takes the programmed chips' bytes and nothing else", () => {
  withMemDir((dir) => {
    seed(dir, GUID_A, [1, 2]);
    seed(dir, GUID_B, [3, 4]);
    const meta = {
      tabs: [
        { doc: docOf([GUID_A, true]) },
        { doc: docOf([GUID_B, false]) }, // unprogrammed: noise stays home
      ],
    };
    const images = collectImages(meta, dir);
    assert.deepEqual(Object.keys(images), [GUID_A]);
    assert.deepEqual(Array.from(Buffer.from(images[GUID_A], "base64")), [1, 2]);
  });
});

test("collect walks a bare {doc} snapshot too", () => {
  withMemDir((dir) => {
    seed(dir, GUID_A, [7]);
    assert.deepEqual(Object.keys(collectImages({ doc: docOf([GUID_A, true]) }, dir)), [GUID_A]); // prettier-ignore
  });
});

test("a missing or hostile sidecar is skipped, never a failed save", () => {
  withMemDir((dir) => {
    const meta = {
      tabs: [
        { doc: docOf([GUID_A, true]) }, // no file on disk at all
        { doc: docOf(["../../etc/passwd", true]) }, // not a guid
      ],
    };
    assert.deepEqual(collectImages(meta, dir), {});
  });
});

test("hydrate refills the cache, overwriting a stale entry", () => {
  withMemDir((dir) => {
    seed(dir, GUID_A, [0, 0, 0]);
    const written = hydrateImages(
      {
        [GUID_A]: Buffer.from([1, 2, 3, 4]).toString("base64"),
        "not-a-guid": Buffer.from([9]).toString("base64"),
      },
      dir,
    );
    assert.equal(written, 1);
    assert.deepEqual(bytesOf(dir, GUID_A), [1, 2, 3, 4]);
    assert.equal(fs.existsSync(path.join(dir, "not-a-guid.bin")), false);
  });
});

test("collect → hydrate is a round trip", () => {
  withMemDir((from) => {
    seed(from, GUID_A, [10, 20, 30]);
    const images = collectImages({ doc: docOf([GUID_A, true]) }, from);
    withMemDir((to) => {
      hydrateImages(images, to);
      assert.deepEqual(bytesOf(to, GUID_A), [10, 20, 30]);
    });
  });
});

test("a copied desktop gets its own guids and its own files", () => {
  withMemDir((dir) => {
    seed(dir, GUID_A, [1, 1]);
    seed(dir, GUID_B, [2, 2]);
    const doc = docOf([GUID_A, true], [GUID_B, true]);
    const remap = reseatImages(doc, dir, null);

    const guids = doc.components.map((c) => c.params.storage.guid);
    assert.equal(guids.length, 2);
    assert.notEqual(guids[0], GUID_A);
    assert.notEqual(guids[1], GUID_B);
    assert.equal(remap.get(GUID_A), guids[0]);
    // Each copy's file holds what its source held — and the sources are
    // untouched, so neither chip is writing the other's bytes.
    assert.deepEqual(bytesOf(dir, guids[0]), [1, 1]);
    assert.deepEqual(bytesOf(dir, guids[1]), [2, 2]);
    assert.deepEqual(bytesOf(dir, GUID_A), [1, 1]);
  });
});

test("two chips sharing a guid stay one chip's worth of memory", () => {
  withMemDir((dir) => {
    seed(dir, GUID_A, [5]);
    // The same guid twice (a document that should not exist, but must not be
    // made worse): both land on ONE new guid, not two diverging copies.
    const doc = docOf([GUID_A, true], [GUID_A, true]);
    reseatImages(doc, dir, null);
    const [one, two] = doc.components.map((c) => c.params.storage.guid);
    assert.equal(one, two);
    assert.deepEqual(bytesOf(dir, one), [5]);
  });
});

test("an imported desktop is reseated from the SNAPSHOT's own bytes", () => {
  withMemDir((dir) => {
    // The cache has never seen this guid: everything comes from the file.
    const doc = docOf([GUID_A, true]);
    const images = { [GUID_A]: Buffer.from([8, 8, 8]).toString("base64") };
    reseatImages(doc, dir, images);
    const guid = doc.components[0].params.storage.guid;
    assert.notEqual(guid, GUID_A);
    assert.deepEqual(bytesOf(dir, guid), [8, 8, 8]);
  });
});

test("a chip with no bytes anywhere is reseated with no file at all", () => {
  withMemDir((dir) => {
    const doc = docOf([GUID_A, false]);
    reseatImages(doc, dir, null);
    const guid = doc.components[0].params.storage.guid;
    // Un-programmed: the controller provisions it as noise on placement, and
    // an empty copy is exactly right.
    assert.equal(fs.existsSync(path.join(dir, `${guid}.bin`)), false);
  });
});

test("a document with no memory chips is left alone", () => {
  withMemDir((dir) => {
    const doc = { components: [{ id: "c1", ref: "7400", params: {} }] };
    assert.equal(reseatImages(doc, dir, null).size, 0);
    assert.deepEqual(doc.components[0].params, {});
  });
});
