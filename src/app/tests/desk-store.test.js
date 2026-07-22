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

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DeskStore } = require("../store/desk-store");
const {
  DESK_DOC_VERSION,
  defaultDeskDocument,
  migrateDeskDocument,
} = require("../store/migrations");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-desk-"));
  return { dir, store: new DeskStore(dir) };
}

test("load on first run returns the default empty desk", () => {
  const { dir, store } = freshStore();
  try {
    assert.deepEqual(store.load(), defaultDeskDocument());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("save → load round-trips a document across store instances", () => {
  const { dir, store } = freshStore();
  try {
    const doc = {
      version: DESK_DOC_VERSION,
      boards: [{ id: "bb1", type: "pins-full", x: 2, y: 3, group: null }],
      components: [],
      wires: [],
      buses: [],
      netNames: [],
      annotations: [],
      nextBoardId: 2,
      nextGroupId: 1,
      nextComponentId: 1,
      nextPsuId: 1,
      nextClockId: 1,
      nextLcdId: 1,
      nextWireId: 1,
      nextBusId: 1,
      nextAnnotationId: 1,
    };
    store.save(doc);
    assert.deepEqual(new DeskStore(dir).load(), doc);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("save rejects non-object documents", () => {
  const { dir, store } = freshStore();
  try {
    for (const bad of [null, undefined, "desk", 7, [1]]) {
      assert.throws(() => store.save(bad), { code: "INVALID_ARG" });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt desk.json degrades to the default document", () => {
  const { dir, store } = freshStore();
  try {
    fs.writeFileSync(path.join(dir, "desk.json"), "{ not json");
    assert.deepEqual(store.load(), defaultDeskDocument());
    // The corrupt bytes were quarantined, not deleted.
    const quarantined = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("desk.json.corrupt-"));
    assert.equal(quarantined.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── named schematic files (Open / Save As / Save) ─────────────────────────────

test("writeFile → readFile round-trips a named schematic anywhere", () => {
  const { dir, store } = freshStore();
  try {
    const file = path.join(dir, "my circuit.chiphippo");
    const doc = {
      version: DESK_DOC_VERSION,
      boards: [{ id: "bb1", type: "pins-half", x: 0, y: 0, group: null }],
      components: [],
      wires: [],
      buses: [],
      netNames: [],
      annotations: [],
      nextBoardId: 2,
      nextGroupId: 1,
      nextComponentId: 1,
      nextPsuId: 1,
      nextClockId: 1,
      nextLcdId: 1,
      nextWireId: 1,
      nextBusId: 1,
      nextAnnotationId: 1,
    };
    assert.equal(store.writeFile(file, doc), file);
    assert.deepEqual(store.readFile(file), doc);
    // The working desk.json is a SEPARATE file — writeFile never touches it.
    assert.equal(fs.existsSync(path.join(dir, "desk.json")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readFile migrates an older/partial schematic to the current schema", () => {
  const { dir, store } = freshStore();
  try {
    const file = path.join(dir, "old.chiphippo");
    fs.writeFileSync(file, JSON.stringify({ version: DESK_DOC_VERSION }));
    assert.deepEqual(store.readFile(file), defaultDeskDocument());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readFile on a missing/corrupt schematic degrades to the default", () => {
  const { dir, store } = freshStore();
  try {
    assert.deepEqual(
      store.readFile(path.join(dir, "gone.chiphippo")),
      defaultDeskDocument(),
    );
    const bad = path.join(dir, "bad.chiphippo");
    fs.writeFileSync(bad, "{ not json");
    assert.deepEqual(store.readFile(bad), defaultDeskDocument());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFile rejects a junk path or document", () => {
  const { dir, store } = freshStore();
  try {
    const doc = defaultDeskDocument();
    for (const badPath of ["", null, 7]) {
      assert.throws(() => store.writeFile(badPath, doc), {
        code: "INVALID_ARG",
      });
    }
    const file = path.join(dir, "x.chiphippo");
    for (const badDoc of [null, "desk", [1]]) {
      assert.throws(() => store.writeFile(file, badDoc), {
        code: "INVALID_ARG",
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── migrations stub ───────────────────────────────────────────────────────────

test("migrateDeskDocument: junk → default; missing fields filled", () => {
  assert.deepEqual(migrateDeskDocument(null), defaultDeskDocument());
  assert.deepEqual(migrateDeskDocument([1]), defaultDeskDocument());
  const patched = migrateDeskDocument({ version: DESK_DOC_VERSION });
  assert.deepEqual(patched, defaultDeskDocument());
});

test("migrateDeskDocument: a current-version document passes through", () => {
  const doc = {
    version: DESK_DOC_VERSION,
    boards: [{ id: "bb1", type: "pins-tiny", x: 0, y: 0, group: null }],
    components: [],
    wires: [],
    buses: [],
    netNames: [],
    annotations: [],
    nextBoardId: 5,
    nextGroupId: 2,
    nextComponentId: 3,
    nextPsuId: 2,
    nextClockId: 1,
    nextLcdId: 1,
    nextWireId: 2,
    nextBusId: 1,
    nextAnnotationId: 1,
  };
  assert.deepEqual(migrateDeskDocument(doc), doc);
});

test("migrateDeskDocument: never downgrades a newer document", () => {
  const future = { ...defaultDeskDocument(), version: DESK_DOC_VERSION + 1 };
  assert.equal(migrateDeskDocument(future).version, DESK_DOC_VERSION + 1);
});
