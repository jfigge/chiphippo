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

// Projects are FILES. What matters here: a new project is blank-named,
// blank-located, and exactly one desktop; a desktop is minted as a GUID file
// in the app's saves folder and carries the flag saying so; a project file
// round-trips wherever it is written; and the app only ever deletes files it
// minted itself.
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
  PROJECT_VERSION,
  DESKTOP_EXT,
} = require("../store/project-store");
const { defaultDeskDocument } = require("../store/migrations");

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

const GUID_FILE = /^[0-9a-f-]{36}\.desktop\.chiphippo$/i;

test("a new project is blank-named, blank-located, and ONE desktop", () => {
  withStore((store, dir) => {
    const meta = store.newProject();
    assert.equal(meta.name, "", "no name until it is saved");
    assert.equal(meta.location, null, "and no home of its own");
    assert.equal(meta.tabs.length, 1, "always exactly one desktop");
    assert.equal(meta.tabs[0].name, "Desktop 1");
    assert.equal(meta.activeTab, meta.tabs[0].id);
    assert.equal(meta.nextIndex, 2);
    // Its desktop is an app-minted GUID file in the saves folder, flagged as
    // the app's own so Save As knows it may be renamed away and deleted.
    const file = meta.tabs[0].file;
    assert.equal(path.dirname(file), path.join(dir, "saves"));
    assert.ok(GUID_FILE.test(path.basename(file)), file);
    assert.equal(meta.tabs[0].defaultFile, true);
    assert.ok(fs.existsSync(file), "the document file exists");
    // And the project itself lives in the ONE default project file, which is
    // what the next launch looks for first.
    assert.ok(store.hasDefaultProject());
    assert.ok(fs.readFileSync(store.defaultProjectPath, "utf8").includes('"tabs"')); // prettier-ignore
  });
});

test("a new desktop's document is a real empty desk, not {}", () => {
  withStore((store) => {
    const meta = store.newProject();
    assert.deepEqual(store.readTab(meta.tabs[0].file), defaultDeskDocument());
  });
});

test("starting another project replaces the one working slot", () => {
  withStore((store) => {
    const first = store.newProject();
    const second = store.newProject();
    assert.notEqual(first.tabs[0].file, second.tabs[0].file);
    // The default project file now holds the SECOND project.
    const read = store.read(store.defaultProjectPath);
    assert.equal(read.tabs[0].file, second.tabs[0].file);
    assert.equal(read.location, null, "the default file means no location");
    // And the abandoned project's app-kept desktop went with it: nothing else
    // ever pointed at that file.
    assert.equal(fs.existsSync(first.tabs[0].file), false);
    assert.ok(fs.existsSync(second.tabs[0].file));
  });
});

test("abandoning the working project keeps the files the USER named", () => {
  withStore((store, dir) => {
    const meta = store.addTab(store.newProject());
    const theirs = path.join(dir, `theirs${DESKTOP_EXT}`);
    store.writeTab(theirs, defaultDeskDocument());
    const appKept = meta.tabs[0].file;
    meta.tabs[1].file = theirs;
    delete meta.tabs[1].defaultFile;
    store.write(store.defaultProjectPath, meta);

    assert.equal(store.discardDefaultProject(), true);
    assert.equal(fs.existsSync(appKept), false, "the app's own file goes");
    assert.ok(fs.existsSync(theirs), "the user's file is theirs");
    assert.equal(store.hasDefaultProject(), false);
    assert.equal(store.discardDefaultProject(), false, "nothing left to drop");
  });
});

test("saving a project out of the slot keeps its app-kept desktops", () => {
  withStore((store, dir) => {
    // `removeDefaultProject` is the OTHER half: the project moved to a real
    // location, so its desktops — app-kept ones included — go on being used.
    const meta = store.newProject();
    store.write(path.join(dir, "saved.project.chiphippo"), meta);
    assert.equal(store.removeDefaultProject(), true);
    assert.ok(fs.existsSync(meta.tabs[0].file));
  });
});

test("addTab appends the next desktop and makes it active", () => {
  withStore((store) => {
    const meta = store.addTab(store.newProject());
    assert.deepEqual(
      meta.tabs.map((t) => t.name),
      ["Desktop 1", "Desktop 2"],
    );
    assert.equal(meta.activeTab, meta.tabs[1].id);
    assert.equal(meta.nextIndex, 3);
    assert.ok(fs.existsSync(meta.tabs[1].file));
    assert.notEqual(meta.tabs[0].file, meta.tabs[1].file);
  });
});

test("desktop numbers only ever count up, even after a delete", () => {
  withStore((store) => {
    const three = store.addTab(store.addTab(store.newProject()));
    // Delete "Desktop 2" (the renderer owns the tab list; the store is handed
    // what is left) — the next desktop is still 4.
    three.tabs = three.tabs.filter((t) => t.name !== "Desktop 2");
    const next = store.addTab(three);
    assert.deepEqual(
      next.tabs.map((t) => t.name),
      ["Desktop 1", "Desktop 3", "Desktop 4"],
    );
  });
});

test("a project file round-trips wherever it is written", () => {
  withStore((store, dir) => {
    const meta = store.addTab(store.newProject());
    meta.name = "6502 SBC";
    meta.description = "the build";
    meta.tabs[1].name = "Scratch";
    meta.tabs[1].description = "trying things out";
    const target = path.join(dir, "elsewhere", "6502 SBC.project.chiphippo");
    store.write(target, meta);

    const read = store.read(target);
    assert.equal(read.version, PROJECT_VERSION);
    assert.equal(read.name, "6502 SBC");
    assert.equal(read.description, "the build");
    assert.equal(read.location, target, "a saved project knows where it is");
    assert.deepEqual(
      read.tabs.map((t) => [t.name, t.description, t.defaultFile]),
      [
        ["Desktop 1", undefined, true],
        ["Scratch", "trying things out", true],
      ],
    );
  });
});

test("a desktop the user named is stored as its own absolute path", () => {
  withStore((store, dir) => {
    const meta = store.newProject();
    const chosen = path.join(dir, "designs", `clock${DESKTOP_EXT}`);
    meta.tabs[0].file = chosen;
    delete meta.tabs[0].defaultFile;
    const target = path.join(dir, "clock.project.chiphippo");
    store.write(target, meta);

    const read = store.read(target);
    assert.equal(read.tabs[0].file, chosen);
    assert.equal(read.tabs[0].defaultFile, undefined);
  });
});

test("an app-kept desktop is rebased onto THIS machine's saves folder", () => {
  withStore((store, dir) => {
    // A project file written on another machine (or under a different
    // --user-data-dir) still finds the desktops the app keeps for it.
    const target = path.join(dir, "carried.project.chiphippo");
    fs.writeFileSync(
      target,
      JSON.stringify({
        version: PROJECT_VERSION,
        name: "Carried",
        activeTab: "t1",
        nextIndex: 2,
        tabs: [
          {
            id: "t1",
            name: "Desktop 1",
            file: "/somewhere/else/saves/abc.desktop.chiphippo",
            defaultFile: true,
          },
        ],
      }),
    );
    const read = store.read(target);
    assert.equal(
      read.tabs[0].file,
      path.join(dir, "saves", "abc.desktop.chiphippo"),
    );
  });
});

test("read returns null for a file that is not a project", () => {
  withStore((store, dir) => {
    assert.equal(store.read(path.join(dir, "gone.project.chiphippo")), null);
    const junk = path.join(dir, "junk.project.chiphippo");
    fs.writeFileSync(junk, JSON.stringify({ hello: "world" }));
    assert.equal(store.read(junk), null);
    const empty = path.join(dir, "empty.project.chiphippo");
    fs.writeFileSync(empty, JSON.stringify({ tabs: [] }));
    assert.equal(store.read(empty), null, "a project needs a desktop");
  });
});

test("a broken tab entry is dropped, and an id is never duplicated", () => {
  withStore((store, dir) => {
    const target = path.join(dir, "messy.project.chiphippo");
    fs.writeFileSync(
      target,
      JSON.stringify({
        version: PROJECT_VERSION,
        activeTab: "nope",
        tabs: [
          { id: "t1", name: "One", file: "/a/one.desktop.chiphippo" },
          { id: "t1", name: "Clash", file: "/a/two.desktop.chiphippo" },
          { id: "t2", name: "No file" },
          { name: "No id", file: "/a/three.desktop.chiphippo" },
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

test("write refuses a project with no desktops", () => {
  withStore((store, dir) => {
    assert.throws(
      () => store.write(path.join(dir, "x.project.chiphippo"), { tabs: [] }),
      { code: "INVALID_ARG" },
    );
  });
});

test("writeTab → readTab round-trips a desktop's document anywhere", () => {
  withStore((store, dir) => {
    const file = path.join(dir, "nested", `thing${DESKTOP_EXT}`);
    const doc = { ...defaultDeskDocument(), nextBoardId: 7 };
    assert.equal(store.writeTab(file, doc), file);
    assert.deepEqual(store.readTab(file), doc);
  });
});

test("a desktop file is deleted when — and only when — it is in saves", () => {
  withStore((store, dir) => {
    const meta = store.newProject();
    const minted = meta.tabs[0].file;
    assert.equal(store.removeDesktopFile(minted), true);
    assert.equal(fs.existsSync(minted), false);
    assert.equal(store.removeDesktopFile(minted), false, "gone already is fine"); // prettier-ignore

    // A file the user saved INTO the app's folder is the app's to clean up
    // too — the location decides, not how the file got its name.
    const named = path.join(store.savesDir, `Clock module${DESKTOP_EXT}`);
    store.writeTab(named, defaultDeskDocument());
    assert.equal(store.removeDesktopFile(named), true);
    assert.equal(fs.existsSync(named), false);

    // Anywhere else it is the user's: not an error, just not ours.
    const theirs = path.join(dir, `mine${DESKTOP_EXT}`);
    fs.writeFileSync(theirs, "{}");
    assert.equal(store.removeDesktopFile(theirs), false);
    assert.equal(store.removeDesktopFile(""), false);
    assert.ok(fs.existsSync(theirs), "and it is still there");

    // A project file is not a desktop, whatever it is asked of.
    assert.throws(() => store.removeDesktopFile(store.defaultProjectPath), {
      code: "INVALID_ARG",
    });
  });
});

test("a desktop reports app-kept from WHERE it is, not what is stored", () => {
  withStore((store, dir) => {
    const target = path.join(dir, "derived.project.chiphippo");
    const inside = path.join(store.savesDir, `Bench${DESKTOP_EXT}`);
    const outside = path.join(dir, `theirs${DESKTOP_EXT}`);
    store.write(target, {
      activeTab: "t1",
      nextIndex: 3,
      // Neither carries the flag on disk; one of them is in the saves folder.
      tabs: [
        { id: "t1", name: "In", file: inside },
        { id: "t2", name: "Out", file: outside },
      ],
    });
    const read = store.read(target);
    assert.deepEqual(
      read.tabs.map((t) => t.defaultFile),
      [true, undefined],
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

test("suggestFileName builds a readable file name, never a path", () => {
  assert.equal(
    suggestFileName("6502 SBC", ".project.chiphippo"),
    "6502 SBC.project.chiphippo",
  );
  // Anything an OS would choke on is stripped — including the separators that
  // would make it a path.
  assert.equal(
    suggestFileName("../secret/thing?", ".desktop.chiphippo"),
    "secret thing.desktop.chiphippo",
  );
  assert.equal(
    suggestFileName("   ", ".project.chiphippo", "project"),
    "project.project.chiphippo",
  );
});

test("discarding a project's changes removes only the desktops it added", () => {
  withStore((store, dir) => {
    // A saved project of one desktop...
    const saved = store.newProject();
    const target = path.join(dir, "saved.project.chiphippo");
    store.write(target, saved);
    const original = saved.tabs[0].file;

    // ...worked on since: one desktop added (app-kept), one saved somewhere of
    // the user's own. Neither is in the file the project would reload from.
    const live = store.addTab(store.read(target));
    const addedAppKept = live.tabs[1].file;
    const theirs = path.join(dir, `theirs${DESKTOP_EXT}`);
    store.writeTab(theirs, defaultDeskDocument());
    live.tabs.push({ id: "t9", name: "Theirs", file: theirs });

    const removed = store.discardChanges(live, target);
    assert.deepEqual(removed, [addedAppKept], "only the app-kept addition");
    assert.equal(fs.existsSync(addedAppKept), false);
    assert.ok(fs.existsSync(original), "the desktop it still lists is safe");
    assert.ok(fs.existsSync(theirs), "and a file the user keeps is theirs");
  });
});

test("discarding compares against the FILE, not what it is handed", () => {
  withStore((store, dir) => {
    const saved = store.newProject();
    const target = path.join(dir, "truth.project.chiphippo");
    store.write(target, saved);
    // A live project claiming a desktop it does not have cannot make the
    // store delete one the file still lists.
    assert.deepEqual(store.discardChanges({ tabs: [] }, target), []);
    assert.deepEqual(store.discardChanges(saved, target), []);
    assert.ok(fs.existsSync(saved.tabs[0].file));
  });
});
