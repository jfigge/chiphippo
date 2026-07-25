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
const { ProjectStore, slugify } = require("../store/project-store");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-project-"));
  return { dir, store: new ProjectStore(dir, new DeskStore(dir)) };
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

test("create lays out the folder: a project file, Main, and one sub-desktop", () => {
  withStore((store, dir) => {
    const meta = store.create("6502 SBC", { boards: [] });
    assert.equal(meta.id, "6502-sbc");
    assert.equal(meta.name, "6502 SBC");
    assert.deepEqual(
      meta.tabs.map((t) => [t.kind, t.name, t.file]),
      [
        ["main", "Main", "main.chiphippo"],
        ["sub", "Sub-Desktop #1", "sub-1.chiphippo"],
      ],
    );
    const folder = path.join(dir, "projects", "6502-sbc");
    assert.ok(fs.existsSync(path.join(folder, "project.json")));
    assert.ok(fs.existsSync(path.join(folder, "main.chiphippo")));
    assert.ok(fs.existsSync(path.join(folder, "sub-1.chiphippo")));
  });
});

test("the Main tab adopts the desk it was created from", () => {
  withStore((store) => {
    const doc = { boards: [{ id: "bb1", type: "pins-full", x: 0, y: 0 }] };
    const meta = store.create("adopt", doc);
    const main = store.readTab(meta.id, "main.chiphippo");
    assert.equal(main.boards.length, 1);
    assert.equal(main.boards[0].id, "bb1");
    // A sub-desktop starts empty.
    assert.deepEqual(store.readTab(meta.id, "sub-1.chiphippo").boards, []);
  });
});

test("a name already saved is refused, however it is spelled", () => {
  withStore((store) => {
    store.create("Clock Module", null);
    assert.equal(store.exists("Clock Module"), true);
    assert.equal(store.exists("clock  module"), true, "same project to a user");
    assert.throws(() => store.create("clock module", null), { code: "NAME_TAKEN" }); // prettier-ignore
    assert.equal(store.list().length, 1);
  });
});

test("a name with no letters or digits is refused (there is no folder to make)", () => {
  withStore((store) => {
    assert.throws(() => store.create("   ", null), { code: "INVALID_ARG" });
    assert.throws(() => store.create("***", null), { code: "INVALID_ARG" });
    assert.throws(() => store.create("x".repeat(200), null), {
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
    const meta = store.create("guard", null);
    for (const bad of [
      "../desk.json",
      "/etc/passwd",
      "nested/sub.chiphippo",
      "sub-1.txt",
    ]) {
      assert.throws(() => store.readTab(meta.id, bad), { code: "INVALID_ARG" });
    }
  });
});

test("load returns null for a project that isn't there", () => {
  withStore((store) => assert.equal(store.load("nothing-here"), null));
});

test("addTab appends the next sub-desktop and makes it active", () => {
  withStore((store) => {
    const created = store.create("many", null);
    const after = store.addTab(created.id);
    assert.deepEqual(
      after.tabs.map((t) => t.name),
      ["Main", "Sub-Desktop #1", "Sub-Desktop #2"],
    );
    assert.equal(after.activeTab, after.tabs[2].id);
    // Reloading sees exactly what was written.
    assert.deepEqual(store.load(created.id), after);
  });
});

test("sub-desktop numbers only ever count up, even after a delete", () => {
  withStore((store) => {
    const created = store.create("counting", null); // #1
    const two = store.addTab(created.id); // #2
    const removed = store.removeTab(created.id, two.tabs[2].id);
    assert.deepEqual(
      removed.tabs.map((t) => t.name),
      ["Main", "Sub-Desktop #1"],
    );
    const next = store.addTab(created.id);
    assert.equal(next.tabs[2].name, "Sub-Desktop #3", "never reuses #2");
  });
});

test("removeTab deletes the tab's document; Main can never be removed", () => {
  withStore((store, dir) => {
    const created = store.create("removal", null);
    const sub = created.tabs[1];
    const file = path.join(dir, "projects", created.id, sub.file);
    assert.ok(fs.existsSync(file));
    store.removeTab(created.id, sub.id);
    assert.equal(fs.existsSync(file), false);
    assert.throws(() => store.removeTab(created.id, created.tabs[0].id), {
      code: "INVALID_ARG",
    });
    assert.throws(() => store.removeTab(created.id, "no-such-tab"), {
      code: "NOT_FOUND",
    });
  });
});

test("removing the active tab moves the active mark to a surviving one", () => {
  withStore((store) => {
    const created = store.create("active", null);
    const sub = created.tabs[1];
    const after = store.removeTab(created.id, sub.id);
    assert.equal(after.activeTab, created.tabs[0].id);
  });
});

test("saveMeta persists renames and the active tab — and only those", () => {
  withStore((store) => {
    const created = store.create("meta", null);
    const saved = store.saveMeta(created.id, {
      name: "Renamed",
      activeTab: created.tabs[1].id,
      tabs: [
        { id: created.tabs[0].id, name: "Main" },
        // A renamed sub-desktop, trying to smuggle a path in with it.
        {
          id: created.tabs[1].id,
          name: "Clock",
          file: "../../escape.chiphippo",
          kind: "main",
        },
      ],
    });
    assert.equal(saved.name, "Renamed");
    assert.equal(saved.activeTab, created.tabs[1].id);
    assert.equal(saved.tabs[1].name, "Clock");
    assert.equal(saved.tabs[1].file, "sub-1.chiphippo", "file is never taken from the caller"); // prettier-ignore
    assert.equal(saved.tabs[1].kind, "sub", "nor is kind");
  });
});

test("saveMeta stores a tab description, keeps it, and clears it on empty", () => {
  withStore((store) => {
    const created = store.create("described", null);
    const [main, sub] = created.tabs;
    const patch = (description) => ({
      tabs: [{ id: main.id, name: "Main" }, { id: sub.id, name: sub.name, description }], // prettier-ignore
    });

    let saved = store.saveMeta(created.id, patch("  The clock module  "));
    assert.equal(saved.tabs[1].description, "The clock module", "trimmed");
    assert.equal(saved.tabs[0].description, undefined, "only the tab patched");

    // An absent key leaves what is stored — a rename must not drop it.
    saved = store.saveMeta(created.id, {
      tabs: [{ id: main.id }, { id: sub.id, name: "Clock" }],
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
    const created = store.create("strict", null);
    const saved = store.saveMeta(created.id, {
      activeTab: "ghost",
      tabs: [{ id: created.tabs[0].id, name: "Main" }, { id: "ghost", name: "Ghost" }], // prettier-ignore
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
    const created = store.create("round", null);
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

test("list reports every saved project by name", () => {
  withStore((store) => {
    store.create("Zeta", null);
    store.create("Alpha", null);
    assert.deepEqual(
      store.list().map((p) => p.name),
      ["Alpha", "Zeta"],
    );
    assert.equal(store.list()[0].tabs, 2);
  });
});

test("slugify folds case and punctuation to one folder name", () => {
  assert.equal(slugify("6502 SBC"), "6502-sbc");
  assert.equal(slugify("  Trim/Me  "), "trim-me");
  assert.equal(slugify("../escape"), "escape");
  assert.equal(slugify("***"), "");
});
