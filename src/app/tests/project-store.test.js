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

// THE PROJECT IS THE DOCUMENT. What matters here: ONE file holds every desktop
// and every programmed ROM's bytes, so a project copied to another machine
// opens whole; a new project is blank-named, blank-located and exactly one
// desktop, living in the working slot; a v3 project (paths per tab) migrates
// forward without destroying anything of the user's; and a renderer meta is
// normalized on the way in, never trusted.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DeskStore } = require("../store/desk-store");
const {
  ProjectStore,
  suggestFileName,
  nameFromFile,
  PROJECT_VERSION,
  PROJECT_EXT,
  DESKTOP_EXT,
  LEGACY_PROJECT_EXT,
} = require("../store/project-store");
const { defaultDeskDocument } = require("../store/migrations");
const { reseatImages } = require("../store/project-images");

/** Run `fn` against a throwaway userData dir, cleaning up either way. */
function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-project-"));
  const store = new ProjectStore(dir, new DeskStore());
  try {
    fn(store, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A desk document carrying one file-backed ROM. */
function docWithRom(guid, { programmed = true } = {}) {
  return {
    ...defaultDeskDocument(),
    components: [
      {
        id: "c1",
        kind: "chip",
        ref: "rom-8k",
        board: "bb1",
        anchor: "e10",
        params: { storage: { guid }, ...(programmed ? { programmed } : {}) },
      },
    ],
    nextComponentId: 2,
  };
}

const GUID_A = "11111111-2222-3333-4444-555555555555";
const GUID_B = "66666666-7777-8888-9999-aaaaaaaaaaaa";

/** Put bytes in the memory cache, as a programmed chip's sidecar. */
function seedRom(store, guid, bytes) {
  fs.mkdirSync(store.memoryDir, { recursive: true });
  fs.writeFileSync(path.join(store.memoryDir, `${guid}.bin`), Buffer.from(bytes)); // prettier-ignore
}

const romBytes = (store, guid) =>
  Array.from(fs.readFileSync(path.join(store.memoryDir, `${guid}.bin`)));

// ── A project, and the working slot ─────────────────────────────────────────

test("a new project is blank-named, blank-located, and ONE desktop", () => {
  withStore((store, dir) => {
    const meta = store.newProject();
    assert.equal(meta.name, "", "no name until it is saved");
    assert.equal(meta.location, null, "and no home of its own");
    assert.equal(meta.tabs.length, 1, "always exactly one desktop");
    assert.equal(meta.tabs[0].name, "Desktop 1");
    assert.equal(meta.activeTab, meta.tabs[0].id);
    assert.equal(meta.nextIndex, 2);
    // Its desktop is a DOCUMENT, not a file — there is nothing beside the
    // project file at all.
    assert.deepEqual(meta.tabs[0].doc, defaultDeskDocument());
    assert.equal(meta.tabs[0].file, undefined);
    assert.deepEqual(
      fs.readdirSync(path.join(dir, "saves")),
      [`default${PROJECT_EXT}`],
      "one file, and only one",
    );
    assert.ok(store.hasDefaultProject());
  });
});

test("starting another project replaces the one working slot", () => {
  withStore((store, dir) => {
    store.newProject();
    const second = store.newProject();
    second.tabs[0].name = "Renamed";
    store.write(store.defaultProjectPath, second);

    const read = store.read(store.defaultProjectPath);
    assert.equal(read.tabs[0].name, "Renamed");
    assert.equal(read.location, null, "the default file means no location");
    assert.deepEqual(
      fs.readdirSync(path.join(dir, "saves")),
      [`default${PROJECT_EXT}`],
      "a project leaves nothing behind to collect",
    );
  });
});

test("dropping the default project empties the working slot", () => {
  withStore((store) => {
    store.newProject();
    assert.equal(store.hasDefaultProject(), true);
    assert.equal(store.removeDefaultProject(), true);
    assert.equal(store.hasDefaultProject(), false);
    assert.equal(store.removeDefaultProject(), false, "gone already is fine");
  });
});

// ── The file ────────────────────────────────────────────────────────────────

test("a project file round-trips WHOLE, wherever it is written", () => {
  withStore((store, dir) => {
    const meta = store.newProject();
    meta.name = "6502 SBC";
    meta.description = "the build";
    meta.tabs.push({
      id: "t2",
      name: "Scratch",
      description: "trying things out",
      doc: { ...defaultDeskDocument(), nextBoardId: 7 },
    });
    meta.nextIndex = 3;
    const target = path.join(dir, "elsewhere", `6502 SBC${PROJECT_EXT}`);
    store.write(target, meta);

    const read = store.read(target);
    assert.equal(read.version, PROJECT_VERSION);
    assert.equal(read.name, "6502 SBC");
    assert.equal(read.description, "the build");
    assert.equal(read.location, target, "a saved project knows where it is");
    assert.deepEqual(
      read.tabs.map((t) => [t.name, t.description]),
      [
        ["Desktop 1", undefined],
        ["Scratch", "trying things out"],
      ],
    );
    // The whole point: the designs came WITH it.
    assert.equal(read.tabs[1].doc.nextBoardId, 7);
  });
});

test("a project opens on another machine — nothing but the file is needed", () => {
  withStore((store, dir) => {
    // Written under one userData dir...
    seedRom(store, GUID_A, [1, 2, 3, 4]);
    const meta = store.newProject();
    meta.name = "Portable";
    meta.tabs[0].doc = docWithRom(GUID_A);
    const target = path.join(dir, `Portable${PROJECT_EXT}`);
    store.write(target, meta);

    // ...opened under another, with an empty memory cache.
    withStore((elsewhere) => {
      const read = elsewhere.read(target);
      assert.equal(read.name, "Portable");
      assert.equal(read.tabs.length, 1);
      assert.equal(read.tabs[0].doc.components[0].params.storage.guid, GUID_A);
      assert.deepEqual(
        romBytes(elsewhere, GUID_A),
        [1, 2, 3, 4],
        "the ROM's bytes travelled in the file and hydrated the cache",
      );
    });
  });
});

test("only a PROGRAMMED rom's bytes travel", () => {
  withStore((store, dir) => {
    seedRom(store, GUID_A, [9, 9]);
    seedRom(store, GUID_B, [7, 7]);
    const meta = store.newProject();
    meta.tabs[0].doc = docWithRom(GUID_A);
    meta.tabs.push({ id: "t2", name: "Two", doc: docWithRom(GUID_B, { programmed: false }) }); // prettier-ignore
    const target = path.join(dir, `noise${PROJECT_EXT}`);
    store.write(target, meta);

    const onDisk = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.deepEqual(Object.keys(onDisk.images), [GUID_A]);
    assert.equal(Object.keys(onDisk.blobs).length, 1);
  });
});

test("two desktops holding one image write it once, and both point at it", () => {
  withStore((store, dir) => {
    seedRom(store, GUID_A, [3, 1, 4, 1, 5]);
    seedRom(store, GUID_B, [3, 1, 4, 1, 5]); // the same image, a second chip
    const meta = store.newProject();
    meta.tabs[0].doc = docWithRom(GUID_A);
    meta.tabs.push({ id: "t2", name: "Two", doc: docWithRom(GUID_B) });
    const target = path.join(dir, `shared${PROJECT_EXT}`);
    store.write(target, meta);

    const onDisk = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(onDisk.version, 5);
    assert.equal(Object.keys(onDisk.blobs).length, 1, "stored once");
    assert.deepEqual(
      Object.keys(onDisk.images).sort(),
      [GUID_A, GUID_B].sort(),
    );
    // The per-chip entry is an OBJECT, deliberately: an older build decodes a
    // bare string as base64 and would write junk over a good sidecar, where a
    // non-string is simply skipped. See project-images.js.
    assert.equal(typeof onDisk.images[GUID_A].blob, "string");
    assert.equal(onDisk.images[GUID_A].blob, onDisk.images[GUID_B].blob);

    // ...and both chips still get their bytes back on another machine.
    withStore((elsewhere) => {
      elsewhere.read(target);
      assert.deepEqual(romBytes(elsewhere, GUID_A), [3, 1, 4, 1, 5]);
      assert.deepEqual(romBytes(elsewhere, GUID_B), [3, 1, 4, 1, 5]);
    });
  });
});

test("a v4 project's inline images still open", () => {
  withStore((store, dir) => {
    // Hand-written in the shape that shipped before the blob table: `images`
    // holding base64 directly, and no `blobs` at all.
    const target = path.join(dir, `old${PROJECT_EXT}`);
    fs.writeFileSync(
      target,
      JSON.stringify({
        version: 4,
        name: "Old",
        activeTab: "t1",
        nextIndex: 2,
        tabs: [{ id: "t1", name: "Desktop 1", doc: docWithRom(GUID_A) }],
        images: { [GUID_A]: Buffer.from([2, 7, 1, 8]).toString("base64") },
      }),
    );

    const read = store.read(target);
    assert.equal(read.name, "Old");
    assert.deepEqual(romBytes(store, GUID_A), [2, 7, 1, 8]);
    // ...and saving it again writes the file forward.
    store.write(target, read);
    const onDisk = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(onDisk.version, 5);
    assert.equal(typeof onDisk.images[GUID_A].blob, "string");
  });
});

test("a chip's source file survives a write and read", () => {
  withStore((store, dir) => {
    seedRom(store, GUID_A, [1]);
    const meta = store.newProject();
    const doc = docWithRom(GUID_A);
    doc.components[0].params.storage.source = "/roms/blink.bin";
    meta.tabs[0].doc = doc;
    const target = path.join(dir, `sourced${PROJECT_EXT}`);
    store.write(target, meta);

    const read = store.read(target);
    assert.equal(
      read.tabs[0].doc.components[0].params.storage.source,
      "/roms/blink.bin",
      "main stores the document whole and strips nothing from it",
    );
  });
});

test("write refuses a project with no desktops, and a tab with no document", () => {
  withStore((store, dir) => {
    assert.throws(
      () => store.write(path.join(dir, `x${PROJECT_EXT}`), { tabs: [] }),
      { code: "INVALID_ARG" },
    );
    assert.throws(
      () =>
        store.write(path.join(dir, `y${PROJECT_EXT}`), {
          tabs: [{ id: "t1", name: "No doc" }],
        }),
      { code: "INVALID_ARG" },
    );
  });
});

test("a broken tab entry is dropped, and an id is never duplicated", () => {
  withStore((store, dir) => {
    const target = path.join(dir, `messy${PROJECT_EXT}`);
    const doc = defaultDeskDocument();
    fs.writeFileSync(
      target,
      JSON.stringify({
        version: PROJECT_VERSION,
        activeTab: "nope",
        tabs: [
          { id: "t1", name: "One", doc },
          { id: "t1", name: "Clash", doc },
          { id: "t2", name: "No doc" },
          { name: "No id", doc },
        ],
      }),
    );
    const read = store.read(target);
    assert.deepEqual(
      read.tabs.map((t) => t.id),
      ["t1"],
    );
    assert.equal(read.activeTab, "t1", "an unknown active tab falls back");
    assert.equal(read.nextIndex, 2, "the counter clears what is taken");
  });
});

test("read returns null for a file that holds no project", () => {
  withStore((store, dir) => {
    assert.equal(store.read(path.join(dir, `gone${PROJECT_EXT}`)), null);
    const junk = path.join(dir, `junk${PROJECT_EXT}`);
    fs.writeFileSync(junk, JSON.stringify({ hello: "world" }));
    assert.equal(store.read(junk), null);
    const empty = path.join(dir, `empty${PROJECT_EXT}`);
    fs.writeFileSync(empty, JSON.stringify({ tabs: [] }));
    assert.equal(store.read(empty), null, "a project needs a desktop");
  });
});

test("a desk document is migrated on the way IN, never on the way out", () => {
  withStore((store, dir) => {
    const target = path.join(dir, `old${PROJECT_EXT}`);
    // A v1 document (one 830 breadboard) inside a project file comes forward.
    fs.writeFileSync(
      target,
      JSON.stringify({
        version: PROJECT_VERSION,
        activeTab: "t1",
        tabs: [
          {
            id: "t1",
            name: "Old",
            doc: { version: 1, boards: [{ id: "bb1", type: "full", x: 0, y: 0 }] }, // prettier-ignore
          },
        ],
      }),
    );
    const read = store.read(target);
    assert.ok(read.tabs[0].doc.version > 1, "brought forward on read");
    assert.ok(read.tabs[0].doc.boards.length > 1, "one board became strips");

    // A write stores what it was handed — no re-derivation behind the
    // renderer's back.
    const out = path.join(dir, `verbatim${PROJECT_EXT}`);
    const doc = { ...defaultDeskDocument(), somethingUnknown: true };
    store.write(out, { activeTab: "t1", tabs: [{ id: "t1", name: "A", doc }] });
    const onDisk = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(onDisk.tabs[0].doc.somethingUnknown, true);
  });
});

// ── Loose designs and desktop snapshots ─────────────────────────────────────

test("a loose desk document opens as a project of one desktop, unnamed", () => {
  withStore((store, dir) => {
    const loose = path.join(dir, `clock${PROJECT_EXT}`);
    fs.writeFileSync(
      loose,
      JSON.stringify({ ...defaultDeskDocument(), nextBoardId: 4 }),
    );
    const read = store.read(loose);
    assert.equal(read.tabs.length, 1);
    assert.equal(read.tabs[0].name, "clock");
    assert.equal(read.tabs[0].doc.nextBoardId, 4);
    assert.equal(
      read.location,
      null,
      "a design is not a project file: Save As is what gives it a home",
    );
  });
});

test("a desktop snapshot round-trips, ROM bytes included", () => {
  withStore((store, dir) => {
    seedRom(store, GUID_A, [5, 6, 7]);
    const file = path.join(dir, `clock module${DESKTOP_EXT}`);
    store.writeDesktopSnapshot(file, {
      name: "Clock module",
      description: "the divider",
      doc: docWithRom(GUID_A),
    });
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(onDisk.kind, "desktop");
    assert.deepEqual(Object.keys(onDisk.images), [GUID_A]);
    assert.equal(typeof onDisk.images[GUID_A].blob, "string");

    withStore((elsewhere) => {
      const snap = elsewhere.readDesktopSnapshot(file);
      assert.equal(snap.name, "Clock module");
      assert.equal(snap.description, "the divider");
      assert.equal(snap.doc.components[0].params.storage.guid, GUID_A);
      // Handed back FLAT, whichever shape the file was written in — that is
      // the contract `reseatImages` reads a snapshot's bytes through.
      assert.deepEqual(Object.keys(snap.images), [GUID_A]);
      assert.deepEqual(
        Array.from(Buffer.from(snap.images[GUID_A], "base64")),
        [5, 6, 7],
      );
    });
  });
});

test("a snapshot imports on a machine that has never seen it", () => {
  withStore((store, dir) => {
    seedRom(store, GUID_A, [1, 1, 2, 3]);
    const file = path.join(dir, `adder${DESKTOP_EXT}`);
    store.writeDesktopSnapshot(file, {
      name: "Adder",
      description: "",
      doc: docWithRom(GUID_A),
    });

    withStore((elsewhere) => {
      // The whole Import path: read the snapshot, then reseat it onto fresh
      // guids and fresh files sourced from the snapshot's OWN bytes.
      const snap = elsewhere.readDesktopSnapshot(file);
      reseatImages(snap.doc, elsewhere.memoryDir, snap.images);
      const guid = snap.doc.components[0].params.storage.guid;
      assert.notEqual(guid, GUID_A, "an import is a copy, never a link");
      assert.deepEqual(romBytes(elsewhere, guid), [1, 1, 2, 3]);
    });
  });
});

test("importing a whole project takes its active desktop", () => {
  withStore((store, dir) => {
    const meta = store.newProject();
    meta.tabs.push({ id: "t2", name: "Second", doc: defaultDeskDocument() });
    meta.activeTab = "t2";
    meta.nextIndex = 3;
    const target = path.join(dir, `two${PROJECT_EXT}`);
    store.write(target, meta);
    assert.equal(store.readDesktopSnapshot(target).name, "Second");
  });
});

test("readDesktopSnapshot refuses a file that holds no desk", () => {
  withStore((store, dir) => {
    const junk = path.join(dir, `junk${DESKTOP_EXT}`);
    fs.writeFileSync(junk, JSON.stringify({ hello: "world" }));
    assert.equal(store.readDesktopSnapshot(junk), null);
  });
});

// ── v3 → v4 ─────────────────────────────────────────────────────────────────

/** Write a v3 project (tabs naming FILES) and its desktop documents. */
function seedLegacy(store, dir, { missing = false } = {}) {
  store.ensureSaves();
  const appKept = path.join(store.savesDir, `abc${DESKTOP_EXT}`);
  const theirs = path.join(dir, "designs", `mine${DESKTOP_EXT}`);
  const desk = new DeskStore();
  desk.writeFile(appKept, { ...defaultDeskDocument(), nextBoardId: 2 });
  desk.writeFile(theirs, { ...defaultDeskDocument(), nextBoardId: 3 });
  const target = path.join(dir, `old${LEGACY_PROJECT_EXT}`);
  fs.writeFileSync(
    target,
    JSON.stringify({
      version: 3,
      name: "Legacy",
      activeTab: "t1",
      nextIndex: 4,
      tabs: [
        // A stored path from ANOTHER machine: an app-kept desktop is rebased
        // onto this one's saves folder, so it is still found.
        { id: "t1", name: "Kept", file: `/elsewhere/saves/abc${DESKTOP_EXT}`, defaultFile: true }, // prettier-ignore
        { id: "t2", name: "Theirs", file: theirs },
        ...(missing
          ? [{ id: "t3", name: "Gone", file: path.join(dir, `gone${DESKTOP_EXT}`) }] // prettier-ignore
          : []),
      ],
    }),
  );
  return { target, appKept, theirs };
}

test("a v3 project inlines its desktops and keeps the user's files", () => {
  withStore((store, dir) => {
    const { target, appKept, theirs } = seedLegacy(store, dir);
    const read = store.read(target);
    assert.deepEqual(
      read.tabs.map((t) => [t.name, t.doc.nextBoardId]),
      [
        ["Kept", 2],
        ["Theirs", 3],
      ],
    );
    assert.equal(read.nextIndex, 4, "the desktop counter carries over");
    assert.equal(read.warnings, undefined, "nothing was lost");
    // Reading is NON-DESTRUCTIVE: both files are still exactly where they were.
    assert.ok(fs.existsSync(appKept));
    assert.ok(fs.existsSync(theirs));
  });
});

test("a v3 desktop whose file is gone opens empty, and says which", () => {
  withStore((store, dir) => {
    const { target } = seedLegacy(store, dir, { missing: true });
    const read = store.read(target);
    assert.equal(read.tabs.length, 3);
    assert.deepEqual(read.tabs[2].doc, defaultDeskDocument());
    assert.equal(read.warnings.length, 1);
    assert.match(read.warnings[0], /"Gone" opens empty/);
    assert.match(read.warnings[0], /gone\.desktop\.chiphippo/);
  });
});

test("the working slot upgrades in place, taking only the app's own files", () => {
  withStore((store, dir) => {
    const { target, appKept, theirs } = seedLegacy(store, dir);
    // Put that v3 project in the slot the app boots from.
    fs.renameSync(target, store.legacyDefaultProjectPath);

    assert.deepEqual(store.upgradeLegacyDefault(), [], "nothing was lost");
    assert.equal(fs.existsSync(store.legacyDefaultProjectPath), false);
    assert.equal(fs.existsSync(appKept), false, "the app's own file goes");
    assert.ok(fs.existsSync(theirs), "the user's file is theirs");

    const read = store.read(store.defaultProjectPath);
    assert.equal(read.location, null, "still the unsaved project");
    assert.deepEqual(
      read.tabs.map((t) => t.doc.nextBoardId),
      [2, 3],
      "both designs came across before anything was deleted",
    );
    assert.equal(store.upgradeLegacyDefault(), null, "nothing left to do");
  });
});

test("the upgrade reports what it could not bring across", () => {
  withStore((store, dir) => {
    const { target } = seedLegacy(store, dir, { missing: true });
    fs.renameSync(target, store.legacyDefaultProjectPath);
    const warnings = store.upgradeLegacyDefault();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /"Gone" opens empty/);
    // The upgraded file itself says nothing — the warning belongs to the ONE
    // migration, so startup is the only chance the user has to be told.
    assert.equal(store.read(store.defaultProjectPath).warnings, undefined);
  });
});

// ── Naming ──────────────────────────────────────────────────────────────────

test("suggestFileName builds a readable file name, never a path", () => {
  assert.equal(suggestFileName("6502 SBC", PROJECT_EXT), "6502 SBC.chiphippo");
  // Anything an OS would choke on is stripped — including the separators that
  // would make it a path.
  assert.equal(
    suggestFileName("../secret/thing?", DESKTOP_EXT),
    "secret thing.desktop.chiphippo",
  );
  assert.equal(
    suggestFileName("   ", PROJECT_EXT, "project"),
    "project.chiphippo",
  );
});

test("nameFromFile strips whichever extension the file carries", () => {
  assert.equal(nameFromFile("/a/b/6502 SBC.chiphippo"), "6502 SBC");
  assert.equal(nameFromFile("/a/Clock module.desktop.chiphippo"), "Clock module"); // prettier-ignore
  assert.equal(nameFromFile("/a/Old.project.chiphippo"), "Old");
  assert.equal(nameFromFile("/a/plain"), "plain");
});
