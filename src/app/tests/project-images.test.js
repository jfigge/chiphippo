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
// PROGRAMMED chip is collected (noise does not need to travel), identical
// bytes are stored ONCE however many chips hold them (and bytes that differ
// never share a blob), a hydrate refills the cache so a project opens whole on
// a machine that has never seen it — from a v5 file OR a v4 one — and a COPIED
// desktop is reseated onto its own guids and its own files, two chips sharing
// one backing file being the bug this exists to prevent.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  collectImages,
  imagesOf,
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

/** The bytes one collected chip points at, through the blob table. */
const blobFor = ({ images, blobs }, guid) =>
  Array.from(Buffer.from(blobs[images[guid].blob], "base64"));

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
    const collected = collectImages(meta, dir);
    assert.deepEqual(Object.keys(collected.images), [GUID_A]);
    assert.deepEqual(blobFor(collected, GUID_A), [1, 2]);
  });
});

test("collect walks a bare {doc} snapshot too", () => {
  withMemDir((dir) => {
    seed(dir, GUID_A, [7]);
    assert.deepEqual(Object.keys(collectImages({ doc: docOf([GUID_A, true]) }, dir).images), [GUID_A]); // prettier-ignore
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
    assert.deepEqual(collectImages(meta, dir), { images: {}, blobs: {} });
  });
});

test("two desktops holding the same image store it ONCE", () => {
  withMemDir((dir) => {
    // Two chips, two guids, identical bytes — the reason the table exists.
    seed(dir, GUID_A, [4, 5, 6]);
    seed(dir, GUID_B, [4, 5, 6]);
    const meta = {
      tabs: [{ doc: docOf([GUID_A, true]) }, { doc: docOf([GUID_B, true]) }],
    };
    const { images, blobs } = collectImages(meta, dir);
    assert.deepEqual(Object.keys(images).sort(), [GUID_A, GUID_B].sort());
    assert.equal(Object.keys(blobs).length, 1);
    assert.equal(images[GUID_A].blob, images[GUID_B].blob);
  });
});

test("the same file MODIFIED between two loads is two blobs", () => {
  withMemDir((dir) => {
    // One desktop loaded rom.bin, the other loaded it after an edit. The
    // bytes decide, so nothing has to remember which file either came from.
    seed(dir, GUID_A, [4, 5, 6]);
    seed(dir, GUID_B, [4, 5, 7]);
    const meta = {
      tabs: [{ doc: docOf([GUID_A, true]) }, { doc: docOf([GUID_B, true]) }],
    };
    const { images, blobs } = collectImages(meta, dir);
    assert.equal(Object.keys(blobs).length, 2);
    assert.notEqual(images[GUID_A].blob, images[GUID_B].blob);
    assert.deepEqual(blobFor({ images, blobs }, GUID_A), [4, 5, 6]);
    assert.deepEqual(blobFor({ images, blobs }, GUID_B), [4, 5, 7]);
  });
});

test("a blob key is the content's digest, stable across saves", () => {
  withMemDir((dir) => {
    seed(dir, GUID_A, [0x68, 0x69]); // "hi"
    const once = collectImages({ doc: docOf([GUID_A, true]) }, dir);
    const twice = collectImages({ doc: docOf([GUID_A, true]) }, dir);
    // Content-addressed, so re-saving an unchanged project is byte-identical.
    assert.deepEqual(once, twice);
    // Pinned, so changing the digest is a deliberate act and not a surprise.
    assert.equal(
      once.images[GUID_A].blob,
      "sha256-8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4",
    );
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
    const written = collectImages({ doc: docOf([GUID_A, true]) }, from);
    withMemDir((to) => {
      hydrateImages(imagesOf(written), to);
      assert.deepEqual(bytesOf(to, GUID_A), [10, 20, 30]);
    });
  });
});

test("imagesOf resolves a v5 file's chips through the blob table", () => {
  const encoded = Buffer.from([1, 2]).toString("base64");
  const flat = imagesOf({
    images: { [GUID_A]: { blob: "sha256-x" }, [GUID_B]: { blob: "sha256-x" } },
    blobs: { "sha256-x": encoded },
  });
  assert.deepEqual(flat, { [GUID_A]: encoded, [GUID_B]: encoded });
  // The shared blob is ALIASED, not copied: dedup survives in memory too.
  assert.equal(flat[GUID_A], flat[GUID_B]);
});

test("imagesOf reads a v4 file's inline block unchanged", () => {
  const images = { [GUID_A]: Buffer.from([9]).toString("base64") };
  assert.deepEqual(imagesOf({ version: 4, images }), images);
});

test("imagesOf answers null for a file carrying no images", () => {
  // `_asSnapshot` hands this straight on as its documented `object|null`.
  assert.equal(imagesOf({ version: 5, tabs: [] }), null);
  assert.equal(imagesOf(null), null);
});

test("imagesOf drops an entry no blob answers, rather than emptying a ROM", () => {
  // A dangling reference or a shape from some later version: writing nothing
  // would read back as a programmed chip full of zeros, which is a lie. The
  // chip keeps its flag and the renderer's own "file is missing" warning is
  // what tells the user.
  const flat = imagesOf({
    images: { [GUID_A]: { blob: "sha256-gone" }, [GUID_B]: "just-a-string" },
    blobs: {},
  });
  assert.deepEqual(flat, {});
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

test("a reseated chip still knows which file its bytes came from", () => {
  withMemDir((dir) => {
    seed(dir, GUID_A, [1]);
    const doc = docOf([GUID_A, true]);
    doc.components[0].params.storage.source = "/roms/blink.bin";
    reseatImages(doc, dir, null);
    const { guid, source } = doc.components[0].params.storage;
    // Only the GUID is re-minted: an imported desktop's chip is a new chip
    // with its own file, but it holds the same image and came from the same
    // place, so the label travels with it.
    assert.notEqual(guid, GUID_A);
    assert.equal(source, "/roms/blink.bin");
  });
});

test("a document with no memory chips is left alone", () => {
  withMemDir((dir) => {
    const doc = { components: [{ id: "c1", ref: "7400", params: {} }] };
    assert.equal(reseatImages(doc, dir, null).size, 0);
    assert.deepEqual(doc.components[0].params, {});
  });
});
