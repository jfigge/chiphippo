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

// jsdom tests for the desktop tabs: the workspace against a fake project
// store, driving the real tab strip and the real dialogs. What matters is that
// there is ALWAYS a project, that a switch stashes the desk it leaves, that
// each tab keeps its own baseline and history, that every file lands where its
// Location says — and that nothing is lost without being asked.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc, emptyDocument } from "../model/desk-doc.js";

const { ProjectWorkspace } = await import("../components/project-workspace.js");
const { ProjectTabs } = await import("../components/project-tabs.js");

/** The app's own folders, as main lays them out (store/project-store.js). */
const SAVES = "/data/saves";
const DEFAULT_PROJECT = `${SAVES}/default.project.chiphippo`;

const clone = (v) => (v == null ? v : structuredClone(v));

/**
 * An in-memory stand-in for main's file-backed project store, over the same
 * IPC shape: two maps standing for the filesystem (project files and desktop
 * documents), and a `control` object for the answers the native dialogs would
 * give.
 */
function fakeBridge() {
  const projects = new Map(); // path → project meta
  const docs = new Map(); // path → desk document
  const settings = {};
  const counts = { aux: 0 };
  const dropped = [];
  let recent = [];
  const control = {
    failWrites: false, // a write that never reaches a file
    pickPaths: [], // what the Save-As dialog returns, in order
    openProject: null, // what the project Open dialog returns
    openDesign: null, // what the design Open dialog returns
  };
  let minted = 0;
  const mintDesktop = () => `${SAVES}/guid-${++minted}.desktop.chiphippo`;
  /** Is this file inside the app's own saves folder? (main's isInsideSaves) */
  const appKept = (filePath) => String(filePath ?? "").startsWith(`${SAVES}/`);

  const remember = (filePath) => {
    recent = [filePath, ...recent.filter((p) => p !== filePath)].slice(0, 10);
  };

  const addDesktop = (meta) => {
    const index = meta.nextIndex;
    meta.nextIndex = index + 1;
    const tab = {
      id: `t${index}`,
      name: `Desktop ${index}`,
      file: mintDesktop(),
      defaultFile: true,
    };
    docs.set(tab.file, emptyDocument());
    meta.tabs.push(tab);
    return tab;
  };

  // A brand-new project: blank name, blank location, ONE desktop, kept in the
  // app's one default project file until it is saved somewhere real.
  const create = () => {
    const meta = {
      name: "",
      description: "",
      activeTab: null,
      nextIndex: 1,
      tabs: [],
      location: null,
    };
    meta.activeTab = addDesktop(meta).id;
    projects.set(DEFAULT_PROJECT, clone(meta));
    return clone(meta);
  };

  /** Read a project file, as main's `adoptProject` hands it over. */
  const adopt = (filePath) => {
    const meta = projects.get(filePath);
    if (!meta) return null;
    remember(filePath);
    if (filePath !== DEFAULT_PROJECT) projects.delete(DEFAULT_PROJECT);
    return { ...clone(meta), location: filePath };
  };

  const project = {
    boot: async () => {
      if (projects.has(DEFAULT_PROJECT)) {
        return { ...clone(projects.get(DEFAULT_PROJECT)), location: null };
      }
      for (const filePath of recent) {
        if (projects.has(filePath)) return adopt(filePath);
      }
      return create();
    },
    create: async () => create(),
    open: async () => (control.openProject ? adopt(control.openProject) : null),
    openRecent: async (filePath) => {
      if (!recent.includes(filePath)) {
        return { ok: false, code: "unknown", error: "not a recent project" };
      }
      if (!projects.has(filePath)) {
        return { ok: false, code: "missing", error: "file not found" };
      }
      return { ok: true, project: adopt(filePath) };
    },
    save: async (meta, filePath, dropDefault) => {
      const target = filePath ?? DEFAULT_PROJECT;
      projects.set(target, clone(meta));
      if (filePath) {
        remember(target);
        if (dropDefault === true && target !== DEFAULT_PROJECT) {
          projects.delete(DEFAULT_PROJECT);
        }
      }
      return { ok: true, path: target };
    },
    addTab: async (meta) => {
      const next = clone(meta);
      next.activeTab = addDesktop(next).id;
      return next;
    },
    readTab: async (filePath) => clone(docs.get(filePath) ?? emptyDocument()),
    // A write answers with where it landed AND whether that is inside the
    // app's own saves folder — the renderer never works that out itself.
    writeTab: async (filePath, doc) => {
      if (control.failWrites) throw new Error("no file to write to");
      docs.set(filePath, clone(doc));
      return { path: filePath, appKept: appKept(filePath) };
    },
    // The native Save-As dialog: the test queues the paths it answers with,
    // and an empty queue is a cancelled dialog. Replacing an existing file is
    // the native dialog's own question, so a path is all that comes back.
    choosePath: async (kind, name, current) => {
      control.lastPick = { kind, name, current };
      return control.pickPaths.shift() ?? null;
    },
    // The guard's Discard: every desktop the project ON DISK does not list
    // loses its app-kept file (main's discardChanges).
    discard: async (meta, filePath) => {
      const onDisk = projects.get(filePath || DEFAULT_PROJECT);
      const kept = new Set((onDisk?.tabs ?? []).map((t) => t.file));
      const removed = [];
      for (const tab of meta?.tabs ?? []) {
        if (kept.has(tab.file) || !appKept(tab.file)) continue;
        dropped.push(tab.file);
        docs.delete(tab.file);
        removed.push(tab.file);
      }
      return removed;
    },
    // WHERE the file is decides: inside the saves folder it is the app's to
    // delete, anywhere else it is the user's and this is a no-op.
    dropTemp: async (filePath) => {
      if (!appKept(filePath)) return false;
      dropped.push(filePath);
      return docs.delete(filePath);
    },
    recent: {
      list: async () => [...recent],
      remove: async (filePath) => {
        recent = recent.filter((p) => p !== filePath);
        return [...recent];
      },
    },
    closeAuxWindows: async () => {
      counts.aux += 1;
    },
  };

  return {
    bridge: {
      project,
      settings: { set: async (patch) => Object.assign(settings, patch) },
      desk: {
        open: async () =>
          control.openDesign
            ? {
                path: control.openDesign,
                doc: clone(docs.get(control.openDesign) ?? emptyDocument()),
                appKept: appKept(control.openDesign),
              }
            : null,
      },
    },
    projects,
    docs,
    settings,
    counts,
    control,
    dropped,
    recentList: () => [...recent],
    seedProject: (filePath, meta) => projects.set(filePath, clone(meta)),
    seedRecent: (filePath) => remember(filePath),
    seedDoc: (filePath, doc) => docs.set(filePath, clone(doc)),
  };
}

/** The pieces app.js normally wires up, as stubs the tests can inspect. */
async function harness({ doc = new DeskDoc(null), fake = fakeBridge() } = {}) {
  const win = resetDom();
  const sim = {
    stops: 0,
    stop() {
      this.stops += 1;
    },
  };
  // A stand-in for the controller's one seam: it does what the real
  // loadDocument does to the document, so dirty/baseline logic is exercised.
  const controller = {
    loads: [],
    loadDocument(raw, opts = {}) {
      this.loads.push(opts);
      doc.load(raw);
    },
  };
  let camera = { cx: 0, cy: 0, zoom: 1 };
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const tabs = new ProjectTabs(host, {});
  const boot = await ProjectWorkspace.boot(fake.bridge);
  if (boot?.doc) doc.load(boot.doc);
  const workspace = new ProjectWorkspace({
    bridge: fake.bridge,
    deskDoc: doc,
    controller,
    sim,
    tabs,
    getCamera: () => camera,
    setCamera: (c) => {
      camera = c;
    },
    boot,
  });
  return {
    ...fake,
    win,
    workspace,
    tabs,
    doc,
    controller,
    sim,
    boot,
    camera: () => camera,
    moveCamera: (c) => {
      camera = c;
    },
    /** The project as it stands on "disk", wherever it lives. */
    stored: (filePath = DEFAULT_PROJECT) => fake.projects.get(filePath),
    tabsOf: (filePath = DEFAULT_PROJECT) => fake.projects.get(filePath)?.tabs,
  };
}

/** Type into the open prompt dialog and accept it. */
function answerPrompt(text) {
  const input = document.querySelector(".popup-prompt .popup-input");
  assert.ok(input, "a prompt dialog is open");
  input.value = text;
  const ok = document.querySelector(".popup-prompt .btn--primary");
  ok.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

/** Edit one field of the open Properties dialog. Its text controls commit on
    `change` (blur/Enter), not per keystroke — see part-properties-dialog.js. */
function setProperty(selector, value) {
  const control = document.querySelector(`.properties-popup ${selector}`);
  assert.ok(control, `the properties dialog shows ${selector}`);
  control.value = value;
  control.dispatchEvent(new window.Event("change", { bubbles: true }));
}

/** Close whatever popup is open (the dialog's header ×). */
function closePopup() {
  document
    .querySelector(".popup-close")
    ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

/** Click a button by its label in the open dialog. */
function clickButton(label) {
  const btn = [...document.querySelectorAll(".popup-dialog button")].find(
    (b) => b.textContent.trim() === label,
  );
  assert.ok(btn, `a "${label}" button is showing`);
  btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

/** Let the click handlers' awaited work settle. */
const settle = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/** The open dialog's title, for the "which question was asked" assertions. */
const dialogTitle = () =>
  document.querySelector(".popup-title")?.textContent ?? "";

/** Name the open project and give it a home — what Save Project… does, with
    both of its questions answered. */
const saveProjectAs = async (h, name, filePath) => {
  h.control.pickPaths.push(filePath);
  const saving = h.workspace.saveProject();
  await settle();
  answerPrompt(name);
  const ok = await saving;
  await settle();
  return ok;
};

/** A project of TWO desktops, back on the first, with the setup's own switch
    not counted against whatever the test is about to assert. */
const twoDesktops = async (h) => {
  await h.workspace.addTab();
  await settle();
  await h.workspace.selectTab(h.workspace.activeTab.id === "t2" ? "t1" : "t2");
  await settle();
  h.sim.stops = 0;
  h.counts.aux = 0;
};

// ── There is always a project ────────────────────────────────────────────────

test("a first run boots onto a brand-new project of one desktop", async () => {
  const h = await harness();
  assert.equal(h.workspace.isOpen, true);
  assert.equal(h.workspace.projectName, "", "no name until it is saved");
  assert.equal(h.workspace.projectLocation, null, "and no home of its own");
  assert.equal(h.workspace.isUntitled, true);
  assert.equal(h.workspace.activeTab.name, "Desktop 1");
  // The strip shows it, with the "+" that is the only way to another desktop.
  const shown = [...h.tabs.element.querySelectorAll(".project-tab")];
  assert.deepEqual(
    shown.map((b) => b.textContent.trim()),
    ["Desktop 1"],
  );
  assert.equal(shown[0].classList.contains("project-tab--active"), true);
  assert.equal(h.tabs.element.querySelectorAll(".project-tab-add").length, 1);
  // Its desktop is an app-kept file, and the project is in the working slot.
  assert.equal(h.workspace.activeTab.defaultFile, true);
  assert.ok(h.stored(DEFAULT_PROJECT), "the default project file was written");
});

test("boot puts the session back on the desktop it left", async () => {
  const fake = fakeBridge();
  const file = `${SAVES}/kept.desktop.chiphippo`;
  fake.seedDoc(file, {
    ...emptyDocument(),
    boards: [{ id: "bb1", type: "pins-full", x: 2, y: 2, rot: 0, group: null }],
  });
  fake.seedProject("/home/six.project.chiphippo", {
    name: "6502 SBC",
    activeTab: "t2",
    nextIndex: 3,
    tabs: [
      { id: "t1", name: "Desktop 1", file: `${SAVES}/a.desktop.chiphippo`, defaultFile: true }, // prettier-ignore
      { id: "t2", name: "Bench", file },
    ],
  });
  fake.seedRecent("/home/six.project.chiphippo");

  const h = await harness({ fake });
  assert.equal(h.workspace.projectName, "6502 SBC");
  assert.equal(h.workspace.projectLocation, "/home/six.project.chiphippo");
  assert.equal(h.workspace.isUntitled, false);
  assert.equal(h.workspace.activeTab.name, "Bench");
  assert.equal(h.doc.boards.length, 1, "on the desk it was left on");
});

test("a project saved elsewhere wins only when the working slot is empty", async () => {
  const fake = fakeBridge();
  fake.seedProject("/home/old.project.chiphippo", {
    name: "Old",
    activeTab: "t1",
    nextIndex: 2,
    tabs: [{ id: "t1", name: "Desktop 1", file: `${SAVES}/o.desktop.chiphippo` }], // prettier-ignore
  });
  fake.seedRecent("/home/old.project.chiphippo");
  // An unsaved project is still in the app's default file, so THAT is the one
  // the session opens with — it is the work in progress.
  fake.seedProject(DEFAULT_PROJECT, {
    name: "",
    activeTab: "t1",
    nextIndex: 2,
    tabs: [{ id: "t1", name: "Desktop 1", file: `${SAVES}/w.desktop.chiphippo`, defaultFile: true }], // prettier-ignore
  });
  const h = await harness({ fake });
  assert.equal(h.workspace.isUntitled, true);
  assert.equal(h.workspace.projectName, "");
});

// ── Desktops ─────────────────────────────────────────────────────────────────

test("Add Desktop names the next one and lands you on it", async () => {
  const h = await harness();
  await h.workspace.addTab();
  await settle();
  assert.deepEqual(
    h.tabsOf().map((t) => t.name),
    ["Desktop 1", "Desktop 2"],
  );
  assert.equal(h.workspace.activeTab.name, "Desktop 2");
  assert.equal(h.tabs.element.querySelectorAll(".project-tab").length, 2);
  // Its file is the app's own, minted in the saves folder — no dialog asked.
  assert.match(h.workspace.activeTab.file, /^\/data\/saves\/guid-\d+\.desktop\.chiphippo$/); // prettier-ignore
  assert.equal(h.workspace.activeTab.defaultFile, true);
  assert.equal(document.querySelector(".popup-dialog"), null, "nothing asked");
});

test("switching desktops stashes the one you leave and loads the other", async () => {
  const h = await harness();
  await twoDesktops(h);
  h.doc.addBoard("pins-tiny", 0, 0);
  h.moveCamera({ cx: 12, cy: 8, zoom: 2 });
  const [first, second] = h.workspace.activeTab.id === "t1" ? ["t1", "t2"] : ["t2", "t1"]; // prettier-ignore

  await h.workspace.selectTab(second);
  assert.equal(h.workspace.activeTab.id, second);
  assert.equal(h.doc.boards.length, 0, "the other desktop is its own empty desk"); // prettier-ignore
  assert.equal(h.sim.stops, 1, "run state never crosses a switch");
  assert.equal(h.counts.aux, 1, "the orphaned pinout/inspector windows close");

  h.moveCamera({ cx: 0, cy: 0, zoom: 1 });
  await h.workspace.selectTab(first);
  assert.equal(h.doc.boards.length, 1);
  assert.deepEqual(h.camera(), { cx: 12, cy: 8, zoom: 2 });
});

test("each desktop is handed its own undo history", async () => {
  const h = await harness();
  await twoDesktops(h);
  await h.workspace.selectTab("t2");
  const first = h.controller.loads.at(-1).history;
  assert.ok(first, "a history store travelled with the document");
  await h.workspace.selectTab("t1");
  assert.notEqual(
    h.controller.loads.at(-1).history,
    first,
    "one per desktop, not one shared",
  );
});

test("the dirty marker is per desktop, and Save writes its own file", async () => {
  const h = await harness();
  await twoDesktops(h);
  assert.equal(h.workspace.activeDirty, false);

  h.doc.addBoard("pins-tiny", 0, 0);
  h.workspace.refreshDirty();
  assert.equal(h.workspace.activeDirty, true);
  assert.equal(
    h.tabs.element.querySelectorAll(".project-tab--dirty").length,
    1,
    "only the desktop that changed is marked",
  );

  const file = h.workspace.activeTab.file;
  assert.equal(await h.workspace.saveActiveTab(), true);
  assert.equal(h.workspace.activeDirty, false);
  assert.equal(h.docs.get(file).boards.length, 1, "written to its Location");
  assert.equal(
    h.tabs.element.querySelectorAll(".project-tab--dirty").length,
    0,
  );
  assert.equal(document.querySelector(".popup-dialog"), null, "and silently");
});

test("Save As gives a desktop a new home and drops the app-kept file", async () => {
  const h = await harness();
  h.doc.addBoard("pins-full", 0, 0);
  const before = h.workspace.activeTab.file;
  h.control.pickPaths.push("/home/clock.desktop.chiphippo");

  assert.equal(await h.workspace.saveActiveTabAs(), true);
  await settle();

  // The dialog was seeded from the desktop's NAME, not the GUID it had.
  assert.deepEqual(h.control.lastPick, {
    kind: "desktop",
    name: "Desktop 1",
    current: before,
  });
  assert.equal(h.workspace.activeTab.file, "/home/clock.desktop.chiphippo");
  assert.equal(h.workspace.activeTab.defaultFile, undefined);
  assert.equal(h.docs.get("/home/clock.desktop.chiphippo").boards.length, 1);
  assert.deepEqual(h.dropped, [before], "the temporary file is deleted");
  assert.equal(h.workspace.activeDirty, false);
  // The project file learned the new location without being asked to.
  assert.equal(h.stored().tabs[0].file, "/home/clock.desktop.chiphippo");
});

test("a cancelled Save-As dialog writes nothing and keeps the old file", async () => {
  const h = await harness();
  h.doc.addBoard("pins-full", 0, 0);
  const before = h.workspace.activeTab.file;

  // Nothing queued: the native dialog came back cancelled — which is also how
  // declining ITS "replace that file?" question arrives, since that prompt is
  // the OS's and never ours.
  assert.equal(await h.workspace.saveActiveTabAs(), false);
  await settle();
  assert.equal(document.querySelector(".popup-dialog"), null, "nothing asked");
  assert.equal(h.workspace.activeTab.file, before, "it keeps its own file");
  assert.deepEqual(h.dropped, [], "and its file was not dropped");
  assert.equal(h.workspace.activeDirty, true, "the work is still unsaved");
});

test("Save As over an existing file just replaces it — the OS asked", async () => {
  const h = await harness();
  h.seedDoc("/home/taken.desktop.chiphippo", emptyDocument());
  h.doc.addBoard("pins-tiny", 0, 0);
  h.control.pickPaths.push("/home/taken.desktop.chiphippo");

  assert.equal(await h.workspace.saveActiveTabAs(), true);
  await settle();
  assert.equal(document.querySelector(".popup-dialog"), null, "asked once, natively"); // prettier-ignore
  assert.equal(h.docs.get("/home/taken.desktop.chiphippo").boards.length, 1);
});

test("Load… into a desktop adopts that file as its Location", async () => {
  const h = await harness();
  const before = h.workspace.activeTab.file;
  h.seedDoc("/home/theirs.chiphippo", {
    ...emptyDocument(),
    boards: [{ id: "bb1", type: "pins-half", x: 0, y: 0, rot: 0, group: null }],
  });
  h.control.openDesign = "/home/theirs.chiphippo";

  await h.workspace.loadIntoActiveTab();
  await settle();

  assert.equal(h.doc.boards.length, 1, "the design is on the desk");
  assert.equal(h.workspace.activeTab.file, "/home/theirs.chiphippo");
  assert.equal(h.workspace.activeDirty, false, "it IS that file now");
  assert.deepEqual(h.dropped, [before], "the app-kept file is dropped");
});

test("New on a tab empties that desktop, and its file still holds the design", async () => {
  const h = await harness();
  h.doc.addBoard("pins-full", 0, 0);
  await h.workspace.saveActiveTab();

  await h.workspace.newActiveTab(); // clean — no prompt
  await settle();
  assert.equal(h.doc.boards.length, 0);
  assert.equal(h.workspace.activeDirty, true, "the file still holds the board");
  assert.equal(h.docs.get(h.workspace.activeTab.file).boards.length, 1);
});

test("'Save first' that never saves leaves the desktop alone", async () => {
  const h = await harness();
  h.doc.addBoard("pins-full", 0, 0);
  h.workspace.refreshDirty();

  h.control.failWrites = true;
  const emptied = h.workspace.newActiveTab();
  clickButton("Save first");
  await emptied;
  await settle();
  assert.equal(h.doc.boards.length, 1, "the desktop was not emptied");
  assert.equal(h.workspace.activeDirty, true, "and is still dirty");
});

// ── Deleting desktops ────────────────────────────────────────────────────────

test("any desktop can be deleted — including the first", async () => {
  const h = await harness();
  await twoDesktops(h);
  const removed = h.tabsOf()[0];

  await h.workspace.deleteTab(removed.id);
  clickButton("Delete");
  await settle();
  assert.deepEqual(
    h.tabsOf().map((t) => t.name),
    ["Desktop 2"],
  );
  assert.equal(h.workspace.activeTab.name, "Desktop 2", "the survivor is on the desk"); // prettier-ignore
  assert.deepEqual(h.dropped, [removed.file], "its app-kept file goes too");
});

test("a desktop kept outside the app's folder keeps its file when deleted", async () => {
  const h = await harness();
  await twoDesktops(h);
  h.control.pickPaths.push("/home/keepme.desktop.chiphippo");
  await h.workspace.saveActiveTabAs();
  await settle();
  h.dropped.length = 0;
  assert.equal(h.workspace.activeTab.defaultFile, undefined, "not app-kept");

  await h.workspace.deleteTab(h.workspace.activeTab.id);
  clickButton("Delete");
  await settle();
  assert.deepEqual(h.dropped, [], "a file the user keeps is theirs");
  assert.ok(h.docs.has("/home/keepme.desktop.chiphippo"));
});

test("a desktop saved INTO the app's folder is deleted with the desktop", async () => {
  const h = await harness();
  await twoDesktops(h);
  // Save As can land in the saves folder — it is what the dialog opens on —
  // and a file there is the app's to clean up, GUID or not.
  const inside = `${SAVES}/Clock module.desktop.chiphippo`;
  h.control.pickPaths.push(inside);
  await h.workspace.saveActiveTabAs();
  await settle();
  const tab = h.workspace.activeTab;
  assert.equal(tab.file, inside);
  assert.equal(tab.defaultFile, true, "still one of the app's own");
  h.dropped.length = 0;

  await h.workspace.deleteTab(tab.id);
  assert.match(
    document.querySelector(".popup-message").textContent,
    /the app is keeping for it is deleted/,
    "and the prompt says so",
  );
  clickButton("Delete");
  await settle();
  assert.deepEqual(h.dropped, [inside]);
  assert.equal(h.docs.has(inside), false, "the file goes with it");
});

test("the last desktop is never deleted — the project would have nothing", async () => {
  const h = await harness();
  await h.workspace.deleteTab(h.workspace.activeTab.id);
  assert.equal(document.querySelector(".popup-confirm"), null, "no dialog");
  assert.equal(h.workspace.activeTab.name, "Desktop 1", "it stays");

  // And the strip says so: Delete is disabled on the one tab left.
  h.tabs.element
    .querySelector(".project-tab")
    .dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true }));
  const del = [...document.querySelectorAll(".popup-menu-item")].find(
    (b) => b.textContent.trim() === "Delete Desktop",
  );
  assert.equal(del.disabled, true);
});

test("deleting a desktop with unsaved changes asks the three-way question", async () => {
  const h = await harness();
  await twoDesktops(h);
  const second = h.tabsOf()[1];
  await h.workspace.selectTab(second.id);
  h.doc.addBoard("pins-tiny", 0, 0); // unsaved work on that desktop
  h.workspace.refreshDirty();

  await h.workspace.deleteTab(second.id);
  assert.deepEqual(
    [...document.querySelectorAll(".popup-confirm button")].map((b) =>
      b.textContent.trim(),
    ),
    ["Cancel", "Save and delete", "Delete anyway"],
  );

  clickButton("Cancel");
  await settle();
  assert.equal(h.tabsOf().length, 2, "cancelling keeps it and its work");

  // It is still in the file the app minted for it, and the delete takes that
  // file with it — so keeping the work means choosing where it goes.
  h.control.pickPaths.push("/home/rescued.desktop.chiphippo");
  await h.workspace.deleteTab(second.id);
  clickButton("Save and delete");
  await settle();
  assert.equal(h.docs.get("/home/rescued.desktop.chiphippo").boards.length, 1);
  assert.equal(h.tabsOf().length, 1);
  assert.equal(h.workspace.activeTab.name, "Desktop 1");
  assert.equal(h.doc.boards.length, 0, "and the desk shows its document");
});

test("Save and delete keeps the desktop when the save never reaches a file", async () => {
  const h = await harness();
  await twoDesktops(h);
  const second = h.tabsOf()[1];
  await h.workspace.selectTab(second.id);
  h.doc.addBoard("pins-tiny", 0, 0);
  h.workspace.refreshDirty();

  // The save never lands: the Save-As dialog is cancelled (nothing queued).
  await h.workspace.deleteTab(second.id);
  clickButton("Save and delete");
  await settle();
  assert.equal(h.tabsOf().length, 2, "the desktop stays");
  assert.equal(h.workspace.activeTab.id, second.id, "and is still on the desk");
  assert.equal(h.doc.boards.length, 1, "with its work");
  assert.equal(h.workspace.activeDirty, true, "still dirty");
});

// ── Saving the project ───────────────────────────────────────────────────────

test("Save Project asks for a name, then for a home — and writes it all", async () => {
  const h = await harness();
  h.doc.addBoard("pins-full", 0, 0);
  await h.workspace.addTab();
  await settle();
  h.control.pickPaths.push("/home/6502 SBC.project.chiphippo");

  const saving = h.workspace.saveProject();
  await settle();
  assert.match(dialogTitle(), /Save project/);
  answerPrompt("6502 SBC");
  assert.equal(await saving, true);
  await settle();

  assert.equal(h.workspace.projectName, "6502 SBC");
  assert.equal(h.workspace.projectLocation, "/home/6502 SBC.project.chiphippo");
  assert.equal(h.workspace.isUntitled, false);
  // The location dialog was seeded from the name it had just been given.
  assert.equal(h.control.lastPick.kind, "project");
  assert.equal(h.control.lastPick.name, "6502 SBC");
  // Every desktop was written on the way, and the working slot is empty — so
  // the next launch opens THIS project, not a blank one.
  const stored = h.stored("/home/6502 SBC.project.chiphippo");
  assert.equal(stored.name, "6502 SBC");
  assert.equal(h.docs.get(stored.tabs[0].file).boards.length, 1);
  assert.equal(h.projects.has(DEFAULT_PROJECT), false);
  assert.deepEqual(h.recentList(), ["/home/6502 SBC.project.chiphippo"]);
});

test("Save Project on a named project writes silently, dialog-free", async () => {
  const h = await harness();
  await saveProjectAs(h, "Kept", "/home/kept.project.chiphippo");

  h.doc.addBoard("pins-tiny", 0, 0);
  assert.equal(await h.workspace.saveProject(), true);
  await settle();
  assert.equal(document.querySelector(".popup-dialog"), null, "nothing asked");
  assert.equal(
    h.docs.get(h.workspace.activeTab.file).boards.length,
    1,
    "the desktop was written too",
  );
});

test("cancelling either question of Save Project saves nothing", async () => {
  const h = await harness();
  // ① the name.
  let saving = h.workspace.saveProject();
  await settle();
  clickButton("Cancel");
  assert.equal(await saving, false);
  assert.equal(h.workspace.isUntitled, true);

  // ② the location. The name it was given is kept — it is not the part that
  // failed — but the project still has no home.
  saving = h.workspace.saveProject();
  await settle();
  answerPrompt("Bench");
  assert.equal(await saving, false, "no location was chosen");
  await settle();
  assert.equal(h.workspace.projectLocation, null);
  assert.equal(h.projects.has(DEFAULT_PROJECT), true, "still in the slot");
});

test("Save Project As moves a named project to a new file, keeping its name", async () => {
  const h = await harness();
  await saveProjectAs(h, "Kept", "/home/kept.project.chiphippo");
  h.doc.addBoard("pins-tiny", 0, 0);

  h.control.pickPaths.push("/home/elsewhere.project.chiphippo");
  assert.equal(await h.workspace.saveProjectAs(), true);
  await settle();

  // The name is not what Save As changes — the file is.
  assert.equal(document.querySelector(".popup-dialog"), null, "no name asked");
  assert.equal(h.workspace.projectName, "Kept");
  assert.equal(
    h.workspace.projectLocation,
    "/home/elsewhere.project.chiphippo",
  );
  // The dialog opened on the file it was in, as any Save As does.
  assert.equal(h.control.lastPick.current, "/home/kept.project.chiphippo");
  // Every desktop went with it, and the new file is the recent one.
  const stored = h.stored("/home/elsewhere.project.chiphippo");
  assert.equal(stored.name, "Kept");
  assert.equal(h.docs.get(stored.tabs[0].file).boards.length, 1);
  assert.equal(h.recentList()[0], "/home/elsewhere.project.chiphippo");
});

test("Save Project As on an unsaved project asks for the name too", async () => {
  const h = await harness();
  h.control.pickPaths.push("/home/named.project.chiphippo");
  const saving = h.workspace.saveProjectAs();
  await settle();
  assert.match(dialogTitle(), /Save project/, "an unnamed project still asks");
  answerPrompt("Named");
  assert.equal(await saving, true);
  await settle();

  assert.equal(h.workspace.projectName, "Named");
  assert.equal(h.workspace.projectLocation, "/home/named.project.chiphippo");
  // It came out of the app's working slot, exactly as Save Project would.
  assert.equal(h.projects.has(DEFAULT_PROJECT), false);
});

test("cancelling Save Project As leaves the project where it was", async () => {
  const h = await harness();
  await saveProjectAs(h, "Stays", "/home/stays.project.chiphippo");

  assert.equal(await h.workspace.saveProjectAs(), false, "no path chosen");
  await settle();
  assert.equal(h.workspace.projectLocation, "/home/stays.project.chiphippo");
  assert.equal(h.projects.has("/home/stays.project.chiphippo"), true);
});

test("Project Properties shows Name, Description, and the Location", async () => {
  const h = await harness();
  h.workspace.editProjectProperties();
  assert.equal(
    document.querySelector(".properties-value--path").textContent,
    "",
    "an unsaved project shows no location",
  );
  setProperty(".properties-text-input", "Bench");
  setProperty(".properties-textarea", "Where things get tried.");
  closePopup();
  await settle();
  assert.equal(h.workspace.projectName, "Bench");
  assert.equal(h.stored().name, "Bench", "and both are persisted");
  assert.equal(h.stored().description, "Where things get tried.");

  // Once saved, the Location is the file it is in.
  h.control.pickPaths.push("/home/bench.project.chiphippo");
  await h.workspace.saveProject();
  await settle();
  h.workspace.editProjectProperties();
  assert.equal(
    document.querySelector(".properties-value--path").textContent,
    "/home/bench.project.chiphippo",
  );
  closePopup();
});

// ── Leaving a project ────────────────────────────────────────────────────────

test("changing projects guards the unsaved one — even with every desktop saved", async () => {
  const h = await harness();
  await h.workspace.addTab();
  await settle();
  for (const tab of h.tabsOf()) await h.workspace.saveTab(tab.id);
  assert.equal(h.workspace.activeDirty, false);

  // Every desktop IS on disk, and it still has to be guarded: the working slot
  // is about to be reused and there is no name to come back to it by.
  const before = h.tabsOf().length;
  const replaced = h.workspace.newProject();
  await settle();
  assert.match(dialogTitle(), /hasn't been saved/);
  clickButton("Cancel");
  await replaced;
  await settle();
  assert.equal(h.tabsOf().length, before, "the project is untouched");
  assert.equal(h.workspace.isUntitled, true);
});

test("'Save' on the way out names the project AND carries on", async () => {
  const h = await harness();
  h.doc.addBoard("pins-full", 0, 0);
  await h.workspace.addTab();
  await settle();
  h.doc.addBoard("pins-tiny", 0, 20); // unsaved work on the desktop we are on
  h.control.pickPaths.push("/home/bench.project.chiphippo");

  const replaced = h.workspace.newProject();
  await settle();
  clickButton("Save");
  await settle(); // the desktops are written, then the name is asked for
  answerPrompt("Bench");
  await replaced;
  await settle();

  // The old project was saved under its name, desktops and all...
  const saved = h.stored("/home/bench.project.chiphippo");
  assert.ok(saved, "the project it was on is saved");
  assert.equal(h.docs.get(saved.tabs[1].file).boards.length, 1, "with its unsaved desktop written"); // prettier-ignore
  // ...and the action the user asked for went ahead anyway.
  assert.equal(h.workspace.isUntitled, true, "now on a new unsaved project");
  assert.equal(h.workspace.activeTab.name, "Desktop 1");
  assert.deepEqual(h.doc.boards, [], "which is a blank desk");
});

test("a project that never got saved calls the whole action off", async () => {
  const h = await harness();
  await h.workspace.addTab();
  await settle();
  const before = h.tabsOf().length;

  const replaced = h.workspace.newProject();
  await settle();
  clickButton("Save");
  await settle();
  clickButton("Cancel"); // the name dialog: nothing was saved
  await replaced;
  await settle();
  assert.equal(h.tabsOf().length, before, "nothing was replaced");
  assert.equal(h.workspace.isUntitled, true);
});

test("a saved project only asks about desktops whose work is on the desk", async () => {
  const h = await harness();
  await saveProjectAs(h, "Named", "/home/named.project.chiphippo");

  // Nothing dirty: Load Project goes straight through to the picker.
  h.control.openProject = null;
  await h.workspace.loadProject();
  await settle();
  assert.equal(document.querySelector(".popup-dialog"), null, "not asked");

  // Now with unsaved work, the question is about the desktop, not the name.
  h.doc.addBoard("pins-tiny", 0, 0);
  h.workspace.refreshDirty();
  const loading = h.workspace.loadProject();
  await settle();
  assert.match(dialogTitle(), /Unsaved changes/);
  clickButton("Save");
  await loading;
  await settle();
  assert.equal(h.docs.get(h.workspace.activeTab.file).boards.length, 1);
});

test("a desktop added since the last save is discarded, file and all", async () => {
  const h = await harness();
  await saveProjectAs(h, "Named", "/home/named.project.chiphippo");
  const savedTabs = h.stored("/home/named.project.chiphippo").tabs.length;

  // Adding a desktop is now a change to the PROJECT, waiting for a save.
  await h.workspace.addTab();
  await settle();
  const added = h.workspace.activeTab;
  assert.equal(h.workspace.projectDirty, true);
  assert.equal(
    h.stored("/home/named.project.chiphippo").tabs.length,
    savedTabs,
    "its file does not have the new desktop yet",
  );

  // Discarding: it is not coming back, so its app-kept file goes with it.
  const replaced = h.workspace.newProject();
  await settle();
  assert.match(dialogTitle(), /Unsaved/);
  clickButton("Discard");
  await replaced;
  await settle();
  assert.equal(h.docs.has(added.file), false, "no file left pointed at by nothing"); // prettier-ignore
  assert.deepEqual(
    h.stored("/home/named.project.chiphippo").tabs.length,
    savedTabs,
    "and the project on disk is untouched",
  );
});

test("discarding never touches a desktop the project still lists", async () => {
  const h = await harness();
  await h.workspace.addTab();
  await settle();
  await saveProjectAs(h, "Kept", "/home/kept.project.chiphippo");
  const files = h.workspace.activeTab ? h.tabsOf("/home/kept.project.chiphippo").map((t) => t.file) : []; // prettier-ignore

  // Only a DOCUMENT is unsaved now — the tab list is exactly its file.
  h.doc.addBoard("pins-tiny", 0, 0);
  h.workspace.refreshDirty();
  assert.equal(h.workspace.projectDirty, false);

  const replaced = h.workspace.newProject();
  await settle();
  clickButton("Discard");
  await replaced;
  await settle();
  for (const file of files) {
    assert.ok(h.docs.has(file), `${file} survived the discard`);
  }
  assert.deepEqual(h.dropped, [], "nothing was deleted");
});

test("a desktop saved OUTSIDE the app's folder survives a discard", async () => {
  const h = await harness();
  await saveProjectAs(h, "Outside", "/home/outside.project.chiphippo");
  await h.workspace.addTab();
  await settle();
  h.control.pickPaths.push("/home/extra.desktop.chiphippo");
  await h.workspace.saveActiveTabAs();
  await settle();

  const replaced = h.workspace.newProject();
  await settle();
  if (document.querySelector(".popup-confirm")) clickButton("Discard");
  await replaced;
  await settle();
  assert.ok(
    h.docs.has("/home/extra.desktop.chiphippo"),
    "a file the user keeps is never swept up",
  );
});

test("Load Project puts the chosen one on the desk", async () => {
  const h = await harness();
  h.seedDoc("/home/other.desktop.chiphippo", {
    ...emptyDocument(),
    boards: [{ id: "bb1", type: "pins-full", x: 1, y: 1, rot: 0, group: null }],
  });
  h.seedProject("/home/other.project.chiphippo", {
    name: "Other",
    activeTab: "t1",
    nextIndex: 2,
    tabs: [{ id: "t1", name: "Radio", file: "/home/other.desktop.chiphippo" }],
  });
  await saveProjectAs(h, "Mine", "/home/mine.project.chiphippo");
  h.control.openProject = "/home/other.project.chiphippo";

  await h.workspace.loadProject();
  await settle();
  assert.equal(h.workspace.projectName, "Other");
  assert.equal(h.workspace.activeTab.name, "Radio");
  assert.equal(h.doc.boards.length, 1);
  assert.equal(h.sim.stops >= 1, true, "the sim never crosses a project");
  assert.equal(h.projects.has(DEFAULT_PROJECT), false, "the slot is released");
});

test("a recent project that has gone offers to be forgotten", async () => {
  const h = await harness();
  await saveProjectAs(h, "Mine", "/home/mine.project.chiphippo");
  h.seedRecent("/home/vanished.project.chiphippo");
  await h.workspace.openRecentProject("/home/vanished.project.chiphippo");
  await settle();
  assert.match(dialogTitle(), /no longer there/);
  clickButton("Remove");
  await settle();
  assert.equal(
    h.recentList().includes("/home/vanished.project.chiphippo"),
    false,
    "the dead entry is dropped; the live one stays",
  );
});

test("quitting saves each dirty desktop where it already lives", async () => {
  const h = await harness();
  await saveProjectAs(h, "Quitting", "/home/quit.project.chiphippo");

  h.doc.addBoard("pins-tiny", 0, 0);
  h.workspace.refreshDirty();
  const asked = h.workspace.confirmClose();
  await settle();
  assert.match(dialogTitle(), /Unsaved changes/);
  clickButton("Save");
  assert.equal(await asked, true);
  await settle();
  // No dialog asked where to put it: the desktop and the project both already
  // have a Location, and that is where they went.
  assert.equal(document.querySelector(".popup-dialog"), null);
  assert.equal(h.docs.get(h.workspace.activeTab.file).boards.length, 1);
  assert.equal(h.control.pickPaths.length, 0);
});

test("cancelling the quit question stays put, and a clean desk never asks", async () => {
  const h = await harness();
  await saveProjectAs(h, "Stay", "/home/stay.project.chiphippo");

  assert.equal(await h.workspace.confirmClose(), true, "nothing to lose");
  assert.equal(document.querySelector(".popup-dialog"), null, "no dialog");

  h.doc.addBoard("pins-tiny", 0, 0);
  h.workspace.refreshDirty();
  const asked = h.workspace.confirmClose();
  await settle();
  clickButton("Cancel");
  assert.equal(await asked, false);
});

// ── The tab strip's own menu ─────────────────────────────────────────────────

test("a tab's context menu is the board's two items — no Pin Assignment", () => {
  const win = resetDom();
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const picked = [];
  const strip = new ProjectTabs(host, {
    onProperties: (id) => picked.push(`properties:${id}`),
    onDelete: (id) => picked.push(`delete:${id}`),
  });
  strip.setTabs(
    [
      { id: "t1", name: "Desktop 1" },
      { id: "t2", name: "Desktop 2" },
    ],
    "t1",
  );

  const second = strip.element.querySelectorAll(".project-tab")[1];
  second.dispatchEvent(new win.MouseEvent("contextmenu", { bubbles: true }));
  const items = [...document.querySelectorAll(".popup-menu-item")].map((b) =>
    b.textContent.trim(),
  );
  assert.deepEqual(items, ["Properties…", "Delete Desktop"]);
  assert.equal(
    document.querySelectorAll(".popup-menu-separator").length,
    1,
    "one rule, between the two items",
  );

  const properties = [...document.querySelectorAll(".popup-menu-item")].find(
    (b) => b.textContent.trim() === "Properties…",
  );
  properties.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(picked, ["properties:t2"]);
});

test("every tab gets the SAME menu — the first desktop included", () => {
  const win = resetDom();
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const strip = new ProjectTabs(host, {});
  strip.setTabs(
    [
      { id: "t1", name: "Desktop 1" },
      { id: "t2", name: "Desktop 2" },
    ],
    "t1",
  );

  const menuOf = (index) => {
    const tab = strip.element.querySelectorAll(".project-tab")[index];
    tab.dispatchEvent(new win.MouseEvent("contextmenu", { bubbles: true }));
    return [...document.querySelectorAll(".popup-menu-item")].map((b) => [
      b.textContent.trim(),
      b.disabled,
    ]);
  };
  assert.deepEqual(menuOf(0), menuOf(1), "no per-tab branching left");
  assert.deepEqual(menuOf(0), [
    ["Properties…", false],
    ["Delete Desktop", false],
  ]);
});

test("Properties… sets a desktop's Name and Description, and shows its file", async () => {
  const h = await harness();
  await twoDesktops(h);
  const sub = h.tabsOf()[1];

  h.workspace.editTabProperties(sub.id);
  assert.equal(
    document.querySelector(".properties-value--path").textContent,
    sub.file,
    "the Location is the file it is saved in",
  );
  setProperty(".properties-text-input", "Clock module");
  setProperty(".properties-textarea", "The 555 and its divider.");
  closePopup();
  await settle();
  const saved = h.tabsOf()[1];
  assert.equal(saved.name, "Clock module");
  assert.equal(saved.description, "The 555 and its divider.");
  const button = [...h.tabs.element.querySelectorAll(".project-tab")].find(
    (b) => b.textContent.trim() === "Clock module",
  );
  assert.ok(button, "the strip shows the new name");
  assert.match(
    button.title,
    /The 555 and its divider\./,
    "and the description",
  );
});

test("a desktop keeps its name when Properties… is left blank; an empty description clears", async () => {
  const h = await harness();
  await twoDesktops(h);
  const sub = h.tabsOf()[1];

  h.workspace.editTabProperties(sub.id);
  setProperty(".properties-textarea", "Scratch bench");
  setProperty(".properties-text-input", "   ");
  closePopup();
  await settle();
  assert.equal(h.tabsOf()[1].name, sub.name, "a desktop always has a name");
  assert.equal(h.tabsOf()[1].description, "Scratch bench");

  h.workspace.editTabProperties(sub.id);
  setProperty(".properties-textarea", "");
  closePopup();
  await settle();
  assert.equal(h.tabsOf()[1].description, "", "cleared, not kept");
});
