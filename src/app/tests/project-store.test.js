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

test("the desk padlock travels in the file, and only while it is shut", () => {
  withStore((store, dir) => {
    const shut = path.join(dir, `shut${PROJECT_EXT}`);
    store.write(shut, { ...store.newProject(), wheelLocked: true });
    assert.equal(JSON.parse(fs.readFileSync(shut, "utf8")).wheelLocked, true);
    assert.equal(store.read(shut).wheelLocked, true);

    // Open is the default, and a default is not written — so a project that
    // never touched the padlock keeps exactly the bytes it always had.
    const open = path.join(dir, `open${PROJECT_EXT}`);
    store.write(open, { ...store.newProject(), wheelLocked: false });
    assert.equal(
      "wheelLocked" in JSON.parse(fs.readFileSync(open, "utf8")),
      false,
    );
    assert.equal(store.read(open).wheelLocked, false);
    assert.equal(
      store.newProject().wheelLocked,
      undefined,
      "a new project is open",
    );
  });
});

test("the CPU monitor's breakpoints travel in the file, held to their shape", () => {
  withStore((store, dir) => {
    const file = path.join(dir, `breaks${PROJECT_EXT}`);
    const meta = store.newProject();
    const tab = meta.tabs[0].id;
    store.write(file, {
      ...meta,
      cpuBreakpoints: {
        [tab]: {
          c1: [0x8021, 0x8008, 0x8008, 0x10000, -1, 1.5, "x"],
          c2: [],
          "../c3": [1],
        },
        t99: { c1: [1] }, // no such desktop
      },
    });
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(written.cpuBreakpoints, { [tab]: { c1: [0x8008, 0x8021] } }); // prettier-ignore
    assert.deepEqual(store.read(file).cpuBreakpoints, { [tab]: { c1: [0x8008, 0x8021] } }); // prettier-ignore

    // None set: no key, so a project that never used them keeps its bytes.
    const plain = path.join(dir, `plain${PROJECT_EXT}`);
    store.write(plain, { ...meta, cpuBreakpoints: { [tab]: { c1: [] } } });
    assert.equal("cpuBreakpoints" in JSON.parse(fs.readFileSync(plain, "utf8")), false); // prettier-ignore
  });
});

test("a renderer's padlock is taken only when it says, exactly, true", () => {
  withStore((store, dir) => {
    const target = path.join(dir, `odd${PROJECT_EXT}`);
    store.write(target, { ...store.newProject(), wheelLocked: "yes" });
    assert.equal(
      "wheelLocked" in JSON.parse(fs.readFileSync(target, "utf8")),
      false,
    );
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

test("importing from a copy of the OPEN project leaves its ROM files alone", () => {
  withStore((store, dir) => {
    // The open project's chip, reprogrammed since the copy was taken.
    seedRom(store, GUID_A, [1, 2, 3]);
    const meta = store.newProject();
    meta.tabs[0].doc = docWithRom(GUID_A);
    const backup = path.join(dir, `backup${PROJECT_EXT}`);
    store.write(backup, meta);
    seedRom(store, GUID_A, [9, 9, 9]); // the live bytes now differ from the file

    const snap = store.readDesktopSnapshot(backup);
    // The import did not write the file's bytes over the live chip's sidecar…
    assert.deepEqual(romBytes(store, GUID_A), [9, 9, 9]);
    // …and the copy still arrives with the bytes the file holds.
    reseatImages(snap.doc, store.memoryDir, snap.images);
    const guid = snap.doc.components[0].params.storage.guid;
    assert.notEqual(guid, GUID_A);
    assert.deepEqual(romBytes(store, guid), [1, 2, 3]);
  });
});

test("a corrupt project the user chose is left where it is", () => {
  withStore((store, dir) => {
    const mine = path.join(dir, `mine${PROJECT_EXT}`);
    fs.writeFileSync(mine, '{"version": 5, "tabs": [');
    assert.equal(store.read(mine), null);
    assert.equal(store.readDesktopSnapshot(mine), null);
    assert.equal(fs.readFileSync(mine, "utf8"), '{"version": 5, "tabs": [');
  });
});

test("a corrupt WORKING SLOT is still quarantined — it is the app's own file", () => {
  withStore((store) => {
    fs.mkdirSync(path.dirname(store.defaultProjectPath), { recursive: true });
    fs.writeFileSync(store.defaultProjectPath, "{ half");
    assert.equal(store.read(store.defaultProjectPath), null);
    assert.equal(fs.existsSync(store.defaultProjectPath), false);
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

test("a v3 desktop whose file is not JSON opens empty and is NOT renamed", () => {
  withStore((store, dir) => {
    const { target, theirs } = seedLegacy(store, dir);
    // The user's own file, truncated: a read must never quarantine it (rename
    // it to .corrupt-…) — it is not one of the app's files.
    fs.writeFileSync(theirs, "{ truncated");
    const read = store.read(target);
    assert.deepEqual(read.tabs[1].doc, defaultDeskDocument());
    assert.match(read.warnings?.[0] ?? "", /"Theirs" could not be read/);
    assert.equal(fs.readFileSync(theirs, "utf8"), "{ truncated");
    assert.deepEqual(
      fs
        .readdirSync(path.dirname(theirs))
        .filter((f) => f.includes(".corrupt")),
      [],
    );
  });
});

test("a corrupt APP-KEPT v3 desktop is quarantined before the upgrade removes it", () => {
  withStore((store, dir) => {
    const { target, appKept } = seedLegacy(store, dir);
    fs.writeFileSync(appKept, "{ truncated");
    const read = store.read(target);
    assert.match(read.warnings?.[0] ?? "", /"Kept" could not be read/);
    const kept = fs.readdirSync(path.dirname(appKept)).filter((f) => f.includes(".corrupt")); // prettier-ignore
    assert.equal(kept.length, 1, "its bytes survive as a .corrupt copy");
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

test("the upgrade never deletes an app-kept file it could not read", () => {
  withStore((store, dir) => {
    const { target, appKept } = seedLegacy(store, dir);
    fs.renameSync(target, store.legacyDefaultProjectPath);
    fs.chmodSync(appKept, 0o000); // unreadable — not corrupt: nothing to quarantine
    try {
      const warnings = store.upgradeLegacyDefault();
      assert.match(warnings.join(" "), /"Kept" could not be read/);
      assert.ok(fs.existsSync(appKept), "all that is left of it stays");
    } finally {
      fs.chmodSync(appKept, 0o644);
    }
  });
});

test("a stray v3 file never overwrites a working slot that already exists", () => {
  withStore((store, dir) => {
    const { target, appKept } = seedLegacy(store, dir);
    fs.renameSync(target, store.legacyDefaultProjectPath);
    // The newer work: a v4 slot already there (an older build ran again).
    fs.writeFileSync(store.defaultProjectPath, JSON.stringify({ version: 5, name: "", activeTab: "t1", nextIndex: 2, tabs: [{ id: "t1", name: "Mine", doc: { boards: [] } }] })); // prettier-ignore
    const before = fs.readFileSync(store.defaultProjectPath, "utf8");
    const warnings = store.upgradeLegacyDefault();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /kept as .*v3-backup/);
    assert.equal(fs.readFileSync(store.defaultProjectPath, "utf8"), before, "untouched"); // prettier-ignore
    assert.ok(fs.existsSync(`${store.legacyDefaultProjectPath}.v3-backup`));
    assert.ok(fs.existsSync(appKept), "nothing it points at is deleted");
    assert.equal(
      store.upgradeLegacyDefault(),
      null,
      "and it does not come back",
    );
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
  assert.equal(suggestFileName("aux", PROJECT_EXT), "_aux.chiphippo");
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

test("a project's connections keep their language — and never a port", () => {
  withStore((store, dir) => {
    const meta = store.newProject();
    meta.connections = [
      {
        id: "conn-pico",
        name: "Pico",
        port: "/dev/cu.usbmodem1",
        baud: 115200,
        dataBits: 8,
        parity: "none",
        stopBits: 1,
        flowControl: "none",
        language: "python",
      },
    ];
    const target = path.join(dir, `Bench${PROJECT_EXT}`);
    store.write(target, meta);
    const [conn] = store.read(target).connections;
    assert.equal(conn.language, "python");
    assert.equal(conn.port, undefined);
  });
});

// ── Custom chips (the chip designer) ────────────────────────────────────────

/** A designed chip as the renderer would hand it over. */
function customChip(id, extra = {}) {
  return {
    id,
    name: "MYNAND",
    description: "",
    family: "74LS",
    pinsPerSide: 7,
    wide: false,
    ports: [
      { name: "A", dir: "input", width: 1 },
      { name: "B", dir: "input", width: 1 },
      { name: "Y", dir: "output", width: 1 },
    ],
    units: [{ A: [1], B: [2], Y: [3] }],
    vcc: 14,
    gnd: 7,
    code: "assign Y = ~(A & B);\n",
    ...extra,
  };
}

test("a project's designed chips travel in its file, and nothing else does", () => {
  withStore((store, dir) => {
    const meta = store.newProject();
    meta.customChips = [
      customChip("custom-0000beef"),
      customChip("custom-0000beef", { name: "DUPLICATE" }),
      customChip("../../etc/passwd"),
      "junk",
      customChip("custom-0000cafe", {
        name: "A-NAME-FAR-TOO-LONG-FOR-A-PART",
        family: "ECL",
        pinsPerSide: 99,
        ports: [{ name: "A", dir: "sideways", width: 40 }],
        units: [{ A: [1, 2, 99] }],
      }),
    ];
    const target = path.join(dir, `chips${PROJECT_EXT}`);
    store.write(target, meta);

    const read = store.read(target);
    assert.deepEqual(
      read.customChips.map((c) => c.id),
      ["custom-0000beef", "custom-0000cafe"],
    );
    assert.equal(read.customChips[0].name, "MYNAND", "first wins");
    // Held to its shape: a name cut to length, and a number out of range
    // falls back to the default rather than to a guess at what was meant.
    const held = read.customChips[1];
    assert.equal(held.name.length, 16);
    assert.equal(held.family, "74LS");
    assert.equal(held.pinsPerSide, 7);
    assert.deepEqual(held.ports, [{ name: "A", dir: "input", width: 1 }]);
    assert.deepEqual(held.units, [{ A: [1] }]);
  });
});

test("a project that designs no chips writes no customChips key", () => {
  withStore((store, dir) => {
    const target = path.join(dir, `plain${PROJECT_EXT}`);
    store.write(target, store.newProject());
    const onDisk = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal("customChips" in onDisk, false);
  });
});

test("a desktop snapshot brings the chips its design was made with", () => {
  withStore((store, dir) => {
    const file = path.join(dir, `bench${DESKTOP_EXT}`);
    store.writeDesktopSnapshot(file, {
      name: "Bench",
      description: "",
      doc: defaultDeskDocument(),
      customChips: [customChip("custom-0000beef")],
    });
    withStore((elsewhere) => {
      const snap = elsewhere.readDesktopSnapshot(file);
      assert.deepEqual(
        snap.customChips.map((c) => c.id),
        ["custom-0000beef"],
      );
    });
  });
});

test("importing from a whole project brings that project's chips", () => {
  withStore((store, dir) => {
    const meta = store.newProject();
    meta.customChips = [customChip("custom-0000beef")];
    const target = path.join(dir, `donor${PROJECT_EXT}`);
    store.write(target, meta);
    assert.deepEqual(
      store.readDesktopSnapshot(target).customChips.map((c) => c.id),
      ["custom-0000beef"],
    );
  });
});
