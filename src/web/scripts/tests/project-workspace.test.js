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

// jsdom tests for the desktop tabs (Feature 240): the workspace against a
// fake project store, driving the real tab strip and the real dialogs. What
// matters is that a switch stashes the desk it leaves, that each tab keeps its
// own baseline and history, and that nothing is lost without being asked.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc, emptyDocument } from "../model/desk-doc.js";

const { ProjectWorkspace } = await import("../components/project-workspace.js");
const { ProjectTabs } = await import("../components/project-tabs.js");

/** The store's reserved working-project slug (project-store.js). */
const WORKING_ID = "__working";

/** An in-memory stand-in for main's project store, over the same IPC shape. */
function fakeBridge() {
  const projects = new Map();
  const files = new Map();
  const settings = {};
  const counts = { aux: 0 };
  // Stand-in for a save that never reaches a file — the cancelled Save-As
  // dialog or the failed write the real store can hand back.
  const control = { failWrites: false };
  const key = (id, file) => `${id}/${file}`;
  const project = {
    // The working project is never one of the saved ones (the store skips its
    // folder), so it can't be listed or opened by name.
    list: async () =>
      [...projects.values()]
        .filter((p) => !p.untitled)
        .map((p) => ({ id: p.id, name: p.name, tabs: p.tabs.length })),
    // A new project is ALWAYS exactly one desktop — the store takes no count
    // to say otherwise, so nothing can ask for more.
    createUntitled: async (firstDoc) => {
      const id = WORKING_ID;
      projects.delete(id); // one working slot, replaced in place
      const meta = {
        id,
        name: "Untitled",
        untitled: true,
        activeTab: null,
        nextIndex: 1,
        tabs: [],
      };
      const only = addDesktop(meta);
      meta.activeTab = only.id;
      files.set(key(id, only.file), structuredClone(firstDoc ?? {}));
      projects.set(id, meta);
      return structuredClone(meta);
    },
    // Naming a project MOVES it: same tabs, same documents, new id.
    saveAs: async (id, name) => {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      if (projects.has(slug)) {
        const err = new Error(`a project named "${name}" already exists`);
        err.code = "NAME_TAKEN";
        throw err;
      }
      const meta = projects.get(id);
      projects.delete(id);
      for (const tab of meta.tabs) {
        files.set(key(slug, tab.file), files.get(key(id, tab.file)));
        files.delete(key(id, tab.file));
      }
      delete meta.untitled;
      meta.id = slug;
      meta.name = name;
      projects.set(slug, meta);
      return structuredClone(meta);
    },
    load: async (id) =>
      projects.has(id) ? structuredClone(projects.get(id)) : null,
    // The store's own whitelist, mirrored (project-store.js's saveMeta): only
    // name/description are taken from the caller, and an empty description
    // clears the key rather than storing "".
    saveMeta: async (id, meta) => {
      const current = projects.get(id);
      current.activeTab = meta.activeTab ?? current.activeTab;
      for (const patch of meta.tabs ?? []) {
        const tab = current.tabs.find((t) => t.id === patch.id);
        if (!tab) continue;
        if (patch.name) tab.name = patch.name;
        if (typeof patch.description === "string") {
          const text = patch.description.trim();
          if (text) tab.description = text;
          else delete tab.description;
        }
      }
      return structuredClone(current);
    },
    addTab: async (id) => {
      const meta = projects.get(id);
      const tab = addDesktop(meta);
      meta.activeTab = tab.id;
      return structuredClone(meta);
    },
    // Any desktop can go except the last — the store's one rule.
    removeTab: async (id, tabId) => {
      const meta = projects.get(id);
      if (meta.tabs.length <= 1) {
        const err = new Error("a project needs at least one desktop");
        err.code = "INVALID_ARG";
        throw err;
      }
      meta.tabs = meta.tabs.filter((t) => t.id !== tabId);
      if (meta.activeTab === tabId) meta.activeTab = meta.tabs[0].id;
      return structuredClone(meta);
    },
    readTab: async (id, file) =>
      structuredClone(files.get(key(id, file)) ?? emptyDocument()),
    writeTab: async (id, file, doc) => {
      if (control.failWrites) throw new Error("no file to write to");
      files.set(key(id, file), structuredClone(doc));
      return file;
    },
    closeAuxWindows: async () => {
      counts.aux += 1;
    },
  };
  function addDesktop(meta) {
    const index = meta.nextIndex;
    meta.nextIndex = index + 1;
    const tab = {
      id: `t${index}`,
      name: `Desktop ${index}`,
      file: `desktop-${index}.chiphippo`,
    };
    meta.tabs.push(tab);
    files.set(key(meta.id, tab.file), emptyDocument());
    return tab;
  }
  return {
    bridge: {
      project,
      settings: { set: async (patch) => Object.assign(settings, patch) },
      desk: { open: async () => null },
    },
    projects,
    files,
    settings,
    counts,
    control,
  };
}

/** The pieces app.js normally wires up, as stubs the tests can inspect. */
function harness({ boot = null, doc = new DeskDoc(null) } = {}) {
  const win = resetDom();
  const { bridge, projects, files, settings, counts, control } = fakeBridge();
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
  const workspace = new ProjectWorkspace({
    bridge,
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
    win,
    workspace,
    tabs,
    doc,
    controller,
    sim,
    bridge,
    projects,
    files,
    settings,
    counts,
    control,
    camera: () => camera,
    moveCamera: (c) => {
      camera = c;
    },
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
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/**
 * The state most of these tests start from: an untitled project AROUND the
 * desk (what "+" does — Desktop 1 IS that desk, Desktop 2 is the one just
 * added), back on Desktop 1, with the setup's own switch not counted against
 * whatever the test is about to assert.
 */
const startProject = async (h) => {
  await h.workspace.addTab();
  await settle();
  await h.workspace.selectTab([...h.projects.values()][0].tabs[0].id);
  await settle();
  h.sim.stops = 0;
  h.counts.aux = 0;
};

/** Answer the name dialog a still-in-flight Save Project is waiting on. */
const answerNameDialog = async (pending, name) => {
  await settle(); // the desktops are written first, then the name is asked for
  answerPrompt(name);
  const ok = await pending;
  await settle();
  return ok;
};

test("with no project open the strip still shows the working desk, and the +", () => {
  const { workspace, tabs } = harness();
  assert.equal(workspace.isOpen, false);
  assert.equal(workspace.activeTab, null, "nothing claims the toolbar");
  // The strip is the only home of the "+", so it is never hidden.
  const shown = [...tabs.element.querySelectorAll(".project-tab")];
  assert.deepEqual(
    shown.map((b) => b.textContent.trim()),
    ["Desktop 1"],
  );
  assert.equal(
    shown[0].classList.contains("project-tab--active"),
    true,
    "the desk you are on is the active tab",
  );
  assert.equal(tabs.element.querySelectorAll(".project-tab-add").length, 1);
});

test("the working tab can only be added to — not renamed or deleted", () => {
  const { tabs } = harness();
  tabs.element
    .querySelector(".project-tab")
    .dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true }));
  const items = [...document.querySelectorAll(".popup-menu-item")];
  assert.deepEqual(
    items.map((b) => b.textContent.trim()),
    ["Properties…", "Delete Desktop"],
    "the menu keeps its shape — only the enabled state changes",
  );
  assert.equal(items[0].disabled, true, "no project file to keep a name in");
  assert.equal(items[1].disabled, true, "it is the only desktop there is");
});

test("the working tab carries the working document's dirty marker", () => {
  const win = resetDom();
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const tabs = new ProjectTabs(host, {});
  let dirty = false;
  new ProjectWorkspace({
    bridge: fakeBridge().bridge,
    deskDoc: new DeskDoc(null),
    controller: { loadDocument() {} },
    sim: { stop() {} },
    tabs,
    isWorkingDirty: () => dirty,
  });
  assert.equal(tabs.element.querySelectorAll(".project-tab--dirty").length, 0);
  dirty = true;
  win.dispatchEvent(new win.CustomEvent("chiphippo:doc-changed"));
  assert.equal(tabs.element.querySelectorAll(".project-tab--dirty").length, 1);
});

test("New Project asks NOTHING, and is a blank slate: one empty desktop", async () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const h = harness({ doc });

  await h.workspace.newProject();
  await settle();

  // No dialog was opened at any point: a name is a save-time question.
  assert.equal(document.querySelector(".popup-prompt"), null);
  assert.equal(h.workspace.isOpen, true);
  assert.equal(h.workspace.isUntitled, true);
  assert.equal(h.workspace.projectName, "Untitled");
  assert.deepEqual(
    [...h.projects.values()][0].tabs.map((t) => t.name),
    ["Desktop 1"],
    "one new desktop — not the desk that was there",
  );
  assert.deepEqual(h.doc.boards, [], "and the desk is empty");
  assert.equal(h.settings.currentProject, WORKING_ID);
  assert.equal(h.tabs.element.querySelectorAll(".project-tab").length, 1);
});

test("the + starts the project AROUND the desk, and lands on the new desktop", async () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const h = harness({ doc });

  await h.workspace.addTab(); // the + — no dialog either
  await settle();

  assert.equal(document.querySelector(".popup-prompt"), null);
  assert.equal(h.workspace.isUntitled, true);
  assert.deepEqual(
    [...h.projects.values()][0].tabs.map((t) => t.name),
    ["Desktop 1", "Desktop 2"],
  );
  // Nothing was discarded: the desk became Desktop 1...
  assert.equal(h.files.get(`${WORKING_ID}/desktop-1.chiphippo`).boards.length, 1); // prettier-ignore
  // ...and, as everywhere else, "+" leaves you on the desktop it added.
  assert.equal(h.workspace.activeTab.name, "Desktop 2");
  assert.deepEqual(h.doc.boards, []);
});

test("Save Project… is the ONE place a name is asked for", async () => {
  const h = harness();
  h.doc.addBoard("pins-full", 0, 0);
  await h.workspace.addTab(); // the + — no dialog
  await settle();
  assert.equal(h.workspace.isUntitled, true);
  assert.equal(h.projects.has(WORKING_ID), true);

  assert.equal(await answerNameDialog(h.workspace.saveProject(), "6502 SBC"), true); // prettier-ignore

  // The whole project MOVED to its name: same tabs, same documents, new id.
  assert.equal(h.workspace.isUntitled, false);
  assert.equal(h.workspace.projectName, "6502 SBC");
  assert.equal(h.projects.has(WORKING_ID), false, "the working slot is free");
  assert.equal(h.settings.currentProject, "6502-sbc");
  assert.equal(h.files.get("6502-sbc/desktop-1.chiphippo").boards.length, 1);
  assert.deepEqual(
    (await h.bridge.project.list()).map((p) => p.name),
    ["6502 SBC"],
    "and it is a saved project now — the untitled one never was",
  );
});

test("the plain working desk is guarded too, before a project takes the screen", async () => {
  const win = resetDom();
  const { bridge, projects } = fakeBridge();
  const doc = new DeskDoc(null);
  const host = win.document.createElement("div");
  win.document.body.append(host);
  let workingSaved = false;
  const workspace = new ProjectWorkspace({
    bridge,
    deskDoc: doc,
    controller: { loadDocument: (raw) => doc.load(raw) },
    sim: { stop() {} },
    tabs: new ProjectTabs(host, {}),
    isWorkingDirty: () => !workingSaved,
    saveWorking: async () => {
      workingSaved = true;
      return true;
    },
  });

  // Cancelling the guard leaves the desk exactly where it was.
  let started = workspace.newProject();
  await settle();
  assert.match(
    document.querySelector(".popup-title").textContent,
    /desk has unsaved changes/,
  );
  clickButton("Cancel");
  await started;
  await settle();
  assert.equal(workspace.isOpen, false, "no project was started");

  // "Save first" hands off to the shell's Save, then carries on.
  started = workspace.newProject();
  await settle();
  clickButton("Save first");
  await started;
  await settle();
  assert.equal(workingSaved, true, "the desk reached its file");
  assert.equal(workspace.isOpen, true);
  assert.equal(projects.size, 1);
});

test("Save Project… refuses a name already saved and asks again", async () => {
  const h = harness();
  await h.workspace.addTab();
  await settle();
  await answerNameDialog(h.workspace.saveProject(), "Clock");
  assert.equal(h.workspace.projectName, "Clock");

  // A second project, saved under the same name: refused, re-asked. Opening
  // the saved one instead is NOT offered — it would discard this work.
  await h.workspace.newProject();
  await settle();
  const saved = h.workspace.saveProject();
  await settle();
  answerPrompt("clock");
  await settle();
  assert.match(
    document.querySelector(".popup-title").textContent,
    /already a saved project/,
  );
  clickButton("Dismiss");
  await settle();
  assert.ok(document.querySelector(".popup-prompt"), "asked again");
  answerPrompt("Clock II");
  assert.equal(await saved, true);
  await settle();
  assert.equal(h.workspace.projectName, "Clock II");
  assert.equal(h.projects.size, 2);
});

test("changing projects guards the untitled one — even with every desktop saved", async () => {
  const h = harness();
  await h.workspace.addTab();
  await settle();
  // Every desktop IS on disk, and it still has to be guarded: the working
  // slot is about to be reused and there is no name to come back to it by.
  for (const tab of [...h.projects.values()][0].tabs) {
    await h.workspace.saveTab(tab.id);
  }
  assert.equal(h.workspace.activeDirty, false);

  const before = [...h.projects.values()][0];
  const replaced = h.workspace.newProject();
  await settle();
  assert.match(
    document.querySelector(".popup-title").textContent,
    /hasn't been saved/,
  );
  clickButton("Cancel");
  await replaced;
  await settle();
  assert.equal([...h.projects.values()][0], before, "the project is untouched");
  assert.equal(h.workspace.isUntitled, true);
});

test("'Save it first' names the project AND carries on with the action", async () => {
  const h = harness();
  h.doc.addBoard("pins-full", 0, 0);
  await h.workspace.addTab();
  await settle();
  h.doc.addBoard("pins-tiny", 0, 20); // unsaved work on the desktop we are on

  // New Project, on top of an untitled project with unsaved desktops.
  const replaced = h.workspace.newProject();
  await settle();
  clickButton("Save it first");
  await settle(); // the desktops are written, then the name is asked for
  answerPrompt("Bench");
  await replaced;
  await settle();

  // The old project was saved under its name, desktops and all...
  const saved = [...h.projects.values()].find((p) => p.name === "Bench");
  assert.ok(saved, "the project it was on is saved");
  assert.equal(h.files.get("bench/desktop-2.chiphippo").boards.length, 1, "with its unsaved desktop written"); // prettier-ignore
  // ...and the action the user asked for went ahead anyway.
  assert.equal(h.workspace.isUntitled, true, "now on a new untitled project");
  assert.deepEqual(h.doc.boards, [], "which is a blank desk");
});

test("a project that never got saved calls the whole action off", async () => {
  const h = harness();
  await h.workspace.addTab();
  await settle();
  const before = [...h.projects.values()][0];

  const replaced = h.workspace.newProject();
  await settle();
  clickButton("Save it first");
  await settle();
  // The name dialog is cancelled: nothing was saved, so nothing is replaced.
  clickButton("Cancel");
  await replaced;
  await settle();
  assert.equal([...h.projects.values()][0], before);
  assert.equal(h.workspace.isUntitled, true);
});

test("switching desktops stashes the one you leave and loads the other", async () => {
  const h = harness();
  await startProject(h);
  // Put something on the first desktop, and move the camera.
  h.doc.addBoard("pins-tiny", 0, 0);
  h.moveCamera({ cx: 12, cy: 8, zoom: 2 });
  const [first, second] = [...h.projects.values()][0].tabs;

  await h.workspace.selectTab(second.id);
  assert.equal(h.workspace.activeTab.id, second.id);
  assert.equal(h.doc.boards.length, 0, "the other desktop is its own empty desk"); // prettier-ignore
  assert.equal(h.sim.stops, 1, "run state never crosses a switch");
  assert.equal(h.counts.aux, 1, "the orphaned pinout/inspector windows close");

  // Back to the first: the board AND the camera come back.
  h.moveCamera({ cx: 0, cy: 0, zoom: 1 });
  await h.workspace.selectTab(first.id);
  assert.equal(h.doc.boards.length, 1);
  assert.deepEqual(h.camera(), { cx: 12, cy: 8, zoom: 2 });
});

test("each desktop is handed its own undo history", async () => {
  const h = harness();
  await startProject(h);
  const [, sub] = [...h.projects.values()][0].tabs;

  await h.workspace.selectTab(sub.id);
  const first = h.controller.loads.at(-1).history;
  assert.ok(first, "a history store travelled with the document");
  await h.workspace.selectTab([...h.projects.values()][0].tabs[0].id);
  const second = h.controller.loads.at(-1).history;
  assert.notEqual(first, second, "one per desktop, not one shared");
});

test("the dirty marker is per desktop, and Save clears it", async () => {
  const h = harness();
  await startProject(h);
  assert.equal(h.workspace.activeDirty, false);

  h.doc.addBoard("pins-tiny", 0, 0);
  h.workspace.refreshDirty();
  assert.equal(h.workspace.activeDirty, true);
  assert.equal(
    h.tabs.element.querySelectorAll(".project-tab--dirty").length,
    1,
    "only the desktop that changed is marked",
  );

  await h.workspace.saveActiveTab();
  assert.equal(h.workspace.activeDirty, false);
  assert.equal(h.files.get(`${WORKING_ID}/desktop-1.chiphippo`).boards.length, 1); // prettier-ignore
  assert.equal(
    h.tabs.element.querySelectorAll(".project-tab--dirty").length,
    0,
  );
});

test("Add Desktop lands you on the new one", async () => {
  const h = harness();
  await startProject(h);

  await h.workspace.addTab();
  const tabs = [...h.projects.values()][0].tabs;
  assert.equal(tabs.length, 3);
  assert.equal(h.workspace.activeTab.name, "Desktop 3");
  assert.equal(h.tabs.element.querySelectorAll(".project-tab").length, 3);
});

test("Add Desktop with no project open creates one first", async () => {
  const h = harness();
  await h.workspace.addTab();
  await settle();
  assert.equal(h.workspace.isOpen, true);
  assert.deepEqual(
    [...h.projects.values()][0].tabs.map((t) => t.name),
    ["Desktop 1", "Desktop 2"],
  );
});

test("any desktop can be deleted — including the first", async () => {
  const h = harness();
  await startProject(h);
  const [first, second] = [...h.projects.values()][0].tabs;

  // The first desktop has no privilege left: it goes like any other.
  await h.workspace.deleteTab(first.id);
  clickButton("Delete");
  await settle();
  assert.deepEqual(
    [...h.projects.values()][0].tabs.map((t) => t.name),
    ["Desktop 2"],
  );
  assert.equal(h.workspace.activeTab.id, second.id, "the survivor is on the desk"); // prettier-ignore
});

test("the last desktop is never deleted — the project would have nothing", async () => {
  const h = harness();
  await startProject(h);
  const [first, second] = [...h.projects.values()][0].tabs;
  await h.workspace.deleteTab(second.id);
  clickButton("Delete");
  await settle();
  assert.equal([...h.projects.values()][0].tabs.length, 1);

  // Nothing is even asked — the request stops before the dialog.
  await h.workspace.deleteTab(first.id);
  assert.equal(document.querySelector(".popup-confirm"), null, "no dialog");
  assert.equal([...h.projects.values()][0].tabs.length, 1, "it stays");

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
  const h = harness();
  await startProject(h);
  const [, second] = [...h.projects.values()][0].tabs;
  await h.workspace.selectTab(second.id);
  h.doc.addBoard("pins-tiny", 0, 0); // unsaved work on that desktop
  h.workspace.refreshDirty();

  await h.workspace.deleteTab(second.id);
  const labels = [...document.querySelectorAll(".popup-confirm button")].map(
    (b) => b.textContent.trim(),
  );
  assert.deepEqual(labels, ["Cancel", "Save and delete", "Delete anyway"]);

  // Cancelling keeps the desktop and its work.
  clickButton("Cancel");
  await settle();
  assert.equal([...h.projects.values()][0].tabs.length, 2);

  // Saving first writes the file, then removes the tab.
  await h.workspace.deleteTab(second.id);
  clickButton("Save and delete");
  await settle();
  assert.equal(h.files.get(`${WORKING_ID}/desktop-2.chiphippo`).boards.length, 1); // prettier-ignore
  assert.equal([...h.projects.values()][0].tabs.length, 1);
  assert.equal(h.workspace.activeTab.name, "Desktop 1", "the desk falls back to the survivor"); // prettier-ignore
  assert.equal(h.doc.boards.length, 0, "and shows its document");
});

test("Save and delete keeps the desktop when the save never reaches a file", async () => {
  const h = harness();
  await startProject(h);
  const [, second] = [...h.projects.values()][0].tabs;
  await h.workspace.selectTab(second.id);
  h.doc.addBoard("pins-tiny", 0, 0);
  h.workspace.refreshDirty();

  // The save is refused (a cancelled Save-As dialog, a failed write): the
  // delete must not go ahead — that work only exists on the desk.
  h.control.failWrites = true;
  await h.workspace.deleteTab(second.id);
  clickButton("Save and delete");
  await settle();
  assert.equal([...h.projects.values()][0].tabs.length, 2, "the desktop stays");
  assert.equal(h.workspace.activeTab.id, second.id, "and is still on the desk");
  assert.equal(h.doc.boards.length, 1, "with its work");
  assert.equal(h.workspace.activeDirty, true, "still dirty");
});

test("'Save first' that never saves leaves the desktop alone", async () => {
  const h = harness();
  h.doc.addBoard("pins-full", 0, 0);
  await startProject(h);
  h.doc.addBoard("pins-tiny", 0, 20); // now dirty against its file
  h.workspace.refreshDirty();

  // New awaits its own guard dialog, so the answer has to be clicked while the
  // call is still in flight (the dialog opens synchronously).
  h.control.failWrites = true;
  const emptied = h.workspace.newActiveTab();
  clickButton("Save first");
  await emptied;
  await settle();
  assert.equal(h.doc.boards.length, 2, "the desktop was not emptied");
  assert.equal(h.workspace.activeDirty, true, "and is still dirty");
});

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

test("Properties… sets a desktop's Name and Description, and persists both", async () => {
  const h = harness();
  await startProject(h);
  const [, sub] = [...h.projects.values()][0].tabs;

  h.workspace.editTabProperties(sub.id);
  setProperty(".properties-text-input", "Clock module");
  setProperty(".properties-textarea", "The 555 and its divider.");
  closePopup();
  await settle();
  const saved = [...h.projects.values()][0].tabs[1];
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
  const h = harness();
  await startProject(h);
  const [, sub] = [...h.projects.values()][0].tabs;

  h.workspace.editTabProperties(sub.id);
  setProperty(".properties-textarea", "Scratch bench");
  setProperty(".properties-text-input", "   ");
  closePopup();
  await settle();
  let saved = [...h.projects.values()][0].tabs[1];
  assert.equal(saved.name, sub.name, "a desktop always has a name");
  assert.equal(saved.description, "Scratch bench");

  h.workspace.editTabProperties(sub.id);
  setProperty(".properties-textarea", "");
  closePopup();
  await settle();
  saved = [...h.projects.values()][0].tabs[1];
  assert.equal("description" in saved, false, "cleared, not stored empty");
});

test("New on a tab empties that desktop after asking", async () => {
  const h = harness();
  h.doc.addBoard("pins-full", 0, 0);
  await startProject(h);
  assert.equal(h.doc.boards.length, 1);

  await h.workspace.newActiveTab(); // clean — no prompt
  assert.equal(h.doc.boards.length, 0);
  h.workspace.refreshDirty();
  assert.equal(h.workspace.activeDirty, true, "the file still holds the board");
});

test("closing the window asks the same question changing projects does", async () => {
  const h = harness();
  await startProject(h);
  h.doc.addBoard("pins-tiny", 0, 0); // unsaved work on a desktop
  h.workspace.refreshDirty();

  // Cancel: it is not safe to go, and nothing was written.
  let asked = h.workspace.confirmClose();
  await settle();
  assert.match(
    document.querySelector(".popup-title").textContent,
    /hasn't been saved/,
  );
  clickButton("Cancel");
  assert.equal(await asked, false);

  // Save: the project is named, every desktop written, and the close goes on.
  asked = h.workspace.confirmClose();
  await settle();
  clickButton("Save it first");
  await settle();
  answerPrompt("Kept");
  assert.equal(await asked, true);
  await settle();
  assert.equal(h.files.get("kept/desktop-1.chiphippo").boards.length, 1);
});

test("a clean desk closes without a word", async () => {
  const h = harness();
  assert.equal(await h.workspace.confirmClose(), true, "nothing to lose");
  assert.equal(document.querySelector(".popup-dialog"), null, "no dialog");
});

test("boot puts the session back on the desktop it left", async () => {
  const { bridge, projects, files } = fakeBridge();
  const untitled = await bridge.project.createUntitled({
    ...emptyDocument(),
    boards: [{ id: "bb1", type: "pins-tiny", x: 0, y: 0, rot: 0, group: null }],
  });
  // A new project is one desktop; the second is added the only way there is.
  await bridge.project.addTab(untitled.id);
  const created = await bridge.project.saveAs(untitled.id, "Resume");
  // Left on the second desktop last time, with a board on it.
  const sub = created.tabs[1];
  projects.get(created.id).activeTab = sub.id;
  files.set(`${created.id}/${sub.file}`, {
    ...emptyDocument(),
    boards: [{ id: "bb1", type: "pins-full", x: 2, y: 2, rot: 0, group: null }],
  });

  const boot = await ProjectWorkspace.boot(bridge, {
    currentProject: created.id,
  });
  assert.equal(boot.project.activeTab, sub.id);
  assert.equal(boot.doc.boards[0].type, "pins-full");

  // A project that has since gone simply boots to no project at all.
  assert.equal(
    await ProjectWorkspace.boot(bridge, { currentProject: "vanished" }),
    null,
  );
  assert.equal(await ProjectWorkspace.boot(bridge, {}), null);
});
