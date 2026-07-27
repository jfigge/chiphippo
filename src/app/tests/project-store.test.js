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

// Projects (Feature 240): a named workspace of desktops in an app-managed
// folder. What matters here is the uniqueness rule, that a name can never
// become a path outside the projects root, and the tab lifecycle.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DeskStore } = require("../store/desk-store");
const {
  ProjectStore,
  slugify,
  WORKING_SLUG,
} = require("../store/project-store");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-project-"));
  return { dir, store: new ProjectStore(dir, new DeskStore(dir)) };
}

/**
 * A project with TWO desktops — what most of the lifecycle tests need. A new
 * project is always exactly one desk, so the second is added the only way
 * there is.
 */
function twoDesktops(store, firstDoc = null) {
  return store.addTab(store.createUntitled(firstDoc).id);
}

/** Run `fn` against a throwaway userData dir, cleaning up either way. */
function withStore(fn) {
  const { dir, store } = freshStore();
  try {
    fn(store, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("list on first run is empty (no projects folder yet)", () => {
  withStore((store) => assert.deepEqual(store.list(), []));
});

test("a new project is UNTITLED and is ALWAYS exactly one desktop", () => {
  withStore((store, dir) => {
    const meta = store.createUntitled({ boards: [] });
    // Nothing was asked for and nothing was named — it lives in the one
    // reserved working folder until the user saves it.
    assert.equal(meta.id, WORKING_SLUG);
    assert.equal(meta.untitled, true);
    assert.equal(meta.name, "Untitled");
    // One desk, numbering starting over — and no kind, because every desktop
    // is the same thing.
    assert.deepEqual(
      meta.tabs.map((t) => [t.name, t.file, t.kind]),
      [["Desktop 1", "desktop-1.chiphippo", undefined]],
    );
    assert.equal(meta.nextIndex, 2);
    const folder = path.join(dir, "projects", WORKING_SLUG);
    assert.ok(fs.existsSync(path.join(folder, "project.json")));
    assert.ok(fs.existsSync(path.join(folder, "desktop-1.chiphippo")));
    assert.equal(
      fs.readdirSync(folder).filter((f) => f.endsWith(".chiphippo")).length,
      1,
      "no other desktop was written",
    );
    // It is NOT one of the user's saved projects.
    assert.deepEqual(store.list(), []);
  });
});

test("saveAs names an untitled project: the folder MOVES, documents and all", () => {
  withStore((store, dir) => {
    const doc = { boards: [{ id: "bb1", type: "pins-full", x: 0, y: 0 }] };
    const untitled = twoDesktops(store, doc);
    const saved = store.saveAs(untitled.id, "6502 SBC");

    assert.equal(saved.id, "6502-sbc");
    assert.equal(saved.name, "6502 SBC");
    assert.equal("untitled" in saved, false, "it is a real project now");
    assert.deepEqual(
      saved.tabs.map((t) => t.id),
      untitled.tabs.map((t) => t.id),
      "same tabs — nothing is re-minted, so per-tab state survives",
    );
    const root = path.join(dir, "projects");
    assert.equal(fs.existsSync(path.join(root, WORKING_SLUG)), false, "moved");
    assert.equal(store.readTab(saved.id, "desktop-1.chiphippo").boards.length, 1); // prettier-ignore
    assert.deepEqual(
      store.list().map((p) => p.name),
      ["6502 SBC"],
    );
    assert.deepEqual(store.load(saved.id), saved, "and reloads as written");
  });
});

test("saveAs refuses a name already saved, leaving the project where it is", () => {
  withStore((store) => {
    store.saveAs(store.createUntitled(null).id, "Clock");
    const second = store.createUntitled(null);
    assert.throws(() => store.saveAs(second.id, "clock"), {
      code: "NAME_TAKEN",
    });
    assert.equal(store.load(WORKING_SLUG).untitled, true, "still untitled");
    assert.equal(store.list().length, 1);
  });
});

test("starting another untitled project resets to one desktop, in the one slot", () => {
  withStore((store) => {
    // Three desktops deep, with work on the first.
    const first = twoDesktops(store, { boards: [{ id: "bb1" }] });
    store.addTab(first.id);
    assert.equal(store.load(first.id).tabs.length, 3);
    assert.equal(store.readTab(first.id, "desktop-1.chiphippo").boards.length, 1); // prettier-ignore

    const second = store.createUntitled(null);
    assert.equal(second.id, first.id, "one slot, not two");
    assert.deepEqual(
      second.tabs.map((t) => t.name),
      ["Desktop 1"],
      "always back to a single desk, numbering started over",
    );
    assert.deepEqual(
      store.readTab(second.id, "desktop-1.chiphippo").boards,
      [],
    );
    assert.equal(store.load(second.id).tabs.length, 1, "on disk too");
  });
});

test("the first desktop adopts the desk it was created from", () => {
  withStore((store) => {
    const doc = { boards: [{ id: "bb1", type: "pins-full", x: 0, y: 0 }] };
    const meta = twoDesktops(store, doc);
    const first = store.readTab(meta.id, "desktop-1.chiphippo");
    assert.equal(first.boards.length, 1);
    assert.equal(first.boards[0].id, "bb1");
    // The others start empty.
    assert.deepEqual(store.readTab(meta.id, "desktop-2.chiphippo").boards, []);
  });
});

test("a name already saved is refused, however it is spelled", () => {
  withStore((store) => {
    store.saveAs(store.createUntitled(null).id, "Clock Module");
    assert.equal(store.exists("Clock Module"), true);
    assert.equal(store.exists("clock  module"), true, "same project to a user");
    const next = store.createUntitled(null).id;
    assert.throws(() => store.saveAs(next, "clock module"), { code: "NAME_TAKEN" }); // prettier-ignore
    assert.equal(store.list().length, 1);
  });
});

test("a name with no letters or digits is refused (there is no folder to make)", () => {
  withStore((store) => {
    const id = store.createUntitled(null).id;
    assert.throws(() => store.saveAs(id, "   "), { code: "INVALID_ARG" });
    assert.throws(() => store.saveAs(id, "***"), { code: "INVALID_ARG" });
    assert.throws(() => store.saveAs(id, "x".repeat(200)), {
      code: "INVALID_ARG",
    });
  });
});

test("a project id can never escape the projects root", () => {
  withStore((store) => {
    for (const bad of ["..", "../..", "/etc", "a/b", "Main", ""]) {
      assert.throws(() => store.load(bad), { code: "INVALID_ARG" }, `id: ${bad}`); // prettier-ignore
    }
  });
});

test("a tab file must be a bare .chiphippo inside the project folder", () => {
  withStore((store) => {
    const meta = twoDesktops(store);
    for (const bad of [
      "../desk.json",
      "/etc/passwd",
      "nested/sub.chiphippo",
      "desktop-1.txt",
    ]) {
      assert.throws(() => store.readTab(meta.id, bad), { code: "INVALID_ARG" });
    }
  });
});

test("load returns null for a project that isn't there", () => {
  withStore((store) => assert.equal(store.load("nothing-here"), null));
});

test("addTab appends the next desktop and makes it active", () => {
  withStore((store) => {
    const created = twoDesktops(store);
    const after = store.addTab(created.id);
    assert.deepEqual(
      after.tabs.map((t) => t.name),
      ["Desktop 1", "Desktop 2", "Desktop 3"],
    );
    assert.equal(after.activeTab, after.tabs[2].id);
    // Reloading sees exactly what was written.
    assert.deepEqual(store.load(created.id), after);
  });
});

test("desktop numbers only ever count up, even after a delete", () => {
  withStore((store) => {
    const created = twoDesktops(store); // 1 + 2
    const three = store.addTab(created.id); // 3
    const removed = store.removeTab(created.id, three.tabs[2].id);
    assert.deepEqual(
      removed.tabs.map((t) => t.name),
      ["Desktop 1", "Desktop 2"],
    );
    const next = store.addTab(created.id);
    assert.equal(next.tabs[2].name, "Desktop 4", "never reuses 3");
  });
});

test("removeTab deletes the tab's document — ANY desktop, first one included", () => {
  withStore((store, dir) => {
    const created = twoDesktops(store);
    const [first, second] = created.tabs;
    const file = path.join(dir, "projects", created.id, first.file);
    assert.ok(fs.existsSync(file));
    // The first desktop is no longer privileged: it goes like any other.
    const after = store.removeTab(created.id, first.id);
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(
      after.tabs.map((t) => t.id),
      [second.id],
    );
    assert.throws(() => store.removeTab(created.id, "no-such-tab"), {
      code: "NOT_FOUND",
    });
  });
});

test("the last desktop can never be removed — a project needs one", () => {
  withStore((store) => {
    const created = twoDesktops(store);
    const left = store.removeTab(created.id, created.tabs[0].id);
    assert.equal(left.tabs.length, 1);
    assert.throws(() => store.removeTab(created.id, left.tabs[0].id), {
      code: "INVALID_ARG",
    });
    assert.equal(store.load(created.id).tabs.length, 1, "still there");
  });
});

test("removing the active tab moves the active mark to a surviving one", () => {
  withStore((store) => {
    const created = twoDesktops(store);
    const second = created.tabs[1];
    const after = store.removeTab(created.id, second.id);
    assert.equal(after.activeTab, created.tabs[0].id);
  });
});

test("saveMeta persists renames and the active tab — and only those", () => {
  withStore((store) => {
    const created = twoDesktops(store);
    const saved = store.saveMeta(created.id, {
      name: "Renamed",
      activeTab: created.tabs[1].id,
      tabs: [
        { id: created.tabs[0].id, name: "Desktop 1" },
        // A renamed desktop, trying to smuggle a path in with it.
        {
          id: created.tabs[1].id,
          name: "Clock",
          file: "../../escape.chiphippo",
        },
      ],
    });
    assert.equal(saved.name, "Renamed");
    assert.equal(saved.activeTab, created.tabs[1].id);
    assert.equal(saved.tabs[1].name, "Clock");
    assert.equal(saved.tabs[1].file, "desktop-2.chiphippo", "file is never taken from the caller"); // prettier-ignore
  });
});

test("saveMeta stores a tab description, keeps it, and clears it on empty", () => {
  withStore((store) => {
    const created = twoDesktops(store);
    const [first, second] = created.tabs;
    const patch = (description) => ({
      tabs: [{ id: first.id, name: first.name }, { id: second.id, name: second.name, description }], // prettier-ignore
    });

    let saved = store.saveMeta(created.id, patch("  The clock module  "));
    assert.equal(saved.tabs[1].description, "The clock module", "trimmed");
    assert.equal(saved.tabs[0].description, undefined, "only the tab patched");

    // An absent key leaves what is stored — a rename must not drop it.
    saved = store.saveMeta(created.id, {
      tabs: [{ id: first.id }, { id: second.id, name: "Clock" }],
    });
    assert.equal(saved.tabs[1].name, "Clock");
    assert.equal(saved.tabs[1].description, "The clock module");

    // An empty string is the way to clear it (omit-when-empty on disk).
    saved = store.saveMeta(created.id, patch("   "));
    assert.equal("description" in saved.tabs[1], false);
    assert.equal(store.load(created.id).tabs[1].description, undefined);
  });
});

test("saveMeta ignores tabs this store never minted, and needs at least one", () => {
  withStore((store) => {
    const created = twoDesktops(store);
    const saved = store.saveMeta(created.id, {
      activeTab: "ghost",
      tabs: [{ id: created.tabs[0].id, name: "Desktop 1" }, { id: "ghost", name: "Ghost" }], // prettier-ignore
    });
    assert.equal(saved.tabs.length, 1);
    assert.equal(saved.activeTab, created.tabs[0].id, "falls back to a real tab"); // prettier-ignore
    assert.throws(() => store.saveMeta(created.id, { tabs: [] }), {
      code: "INVALID_ARG",
    });
  });
});

test("writeTab → readTab round-trips a tab's document", () => {
  withStore((store) => {
    const created = twoDesktops(store);
    const doc = {
      version: 6,
      boards: [{ id: "bb1", type: "pins-half", x: 4, y: 5, group: null }],
      components: [],
      wires: [],
    };
    store.writeTab(created.id, created.tabs[1].file, doc);
    const read = store.readTab(created.id, created.tabs[1].file);
    assert.equal(read.boards[0].type, "pins-half");
    assert.equal(read.boards[0].x, 4);
  });
});

test("list reports every SAVED project by name — never the working one", () => {
  withStore((store) => {
    store.saveAs(twoDesktops(store).id, "Zeta");
    store.saveAs(twoDesktops(store).id, "Alpha");
    store.createUntitled(null); // untitled: not the user's, not listed
    assert.deepEqual(
      store.list().map((p) => p.name),
      ["Alpha", "Zeta"],
    );
    assert.equal(store.list()[0].tabs, 2);
  });
});

test("a v1 project comes forward: kinds dropped, Main deletable, names kept", () => {
  withStore((store, dir) => {
    // A project.json exactly as v1 wrote it (Main + one sub-desktop).
    const folder = path.join(dir, "projects", "legacy");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, "project.json"),
      JSON.stringify({
        version: 1,
        name: "Legacy",
        activeTab: "t1",
        nextSubIndex: 2,
        tabs: [
          { id: "t1", name: "Main", kind: "main", file: "main.chiphippo" },
          { id: "t2-1", name: "Sub-Desktop #1", kind: "sub", file: "sub-1.chiphippo" }, // prettier-ignore
        ],
      }),
    );
    for (const f of ["main.chiphippo", "sub-1.chiphippo"]) {
      fs.writeFileSync(path.join(folder, f), JSON.stringify({ boards: [] }));
    }

    const meta = store.load("legacy");
    assert.equal(meta.version, 2);
    assert.equal(meta.nextSubIndex, undefined, "the old counter is gone");
    assert.equal(meta.nextIndex, 2, "picking up where the old one left off");
    // The user's names and files are theirs — untouched by the upgrade.
    assert.deepEqual(
      meta.tabs.map((t) => [t.name, t.file, t.kind]),
      [
        ["Main", "main.chiphippo", undefined],
        ["Sub-Desktop #1", "sub-1.chiphippo", undefined],
      ],
    );

    // A new desktop steps past ids/files the old scheme already used.
    const added = store.addTab("legacy");
    assert.deepEqual(added.tabs[2], {
      id: "t2",
      name: "Desktop 2",
      file: "desktop-2.chiphippo",
    });

    // And Main is now just another desktop.
    const after = store.removeTab("legacy", "t1");
    assert.equal(fs.existsSync(path.join(folder, "main.chiphippo")), false);
    assert.deepEqual(
      after.tabs.map((t) => t.id),
      ["t2-1", "t2"],
    );
  });
});

test("slugify folds case and punctuation to one folder name", () => {
  assert.equal(slugify("6502 SBC"), "6502-sbc");
  assert.equal(slugify("  Trim/Me  "), "trim-me");
  assert.equal(slugify("../escape"), "escape");
  assert.equal(slugify("***"), "");
});
