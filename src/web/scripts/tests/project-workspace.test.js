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

/** An in-memory stand-in for main's project store, over the same IPC shape. */
function fakeBridge() {
  const projects = new Map();
  const files = new Map();
  const settings = {};
  const counts = { aux: 0 };
  const key = (id, file) => `${id}/${file}`;
  const project = {
    list: async () =>
      [...projects.values()].map((p) => ({
        id: p.id,
        name: p.name,
        tabs: p.tabs.length,
      })),
    create: async (name, mainDoc, { subCount = 1 } = {}) => {
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      if (projects.has(id)) {
        const err = new Error(`a project named "${name}" already exists`);
        err.code = "NAME_TAKEN";
        throw err;
      }
      const meta = {
        id,
        name,
        activeTab: "t1",
        nextSubIndex: 1,
        tabs: [
          { id: "t1", name: "Main", kind: "main", file: "main.chiphippo" },
        ],
      };
      files.set(key(id, "main.chiphippo"), structuredClone(mainDoc ?? {}));
      for (let i = 0; i < subCount; i += 1) addSub(meta);
      projects.set(id, meta);
      return structuredClone(meta);
    },
    load: async (id) =>
      projects.has(id) ? structuredClone(projects.get(id)) : null,
    saveMeta: async (id, meta) => {
      const current = projects.get(id);
      current.activeTab = meta.activeTab ?? current.activeTab;
      for (const patch of meta.tabs ?? []) {
        const tab = current.tabs.find((t) => t.id === patch.id);
        if (tab && patch.name) tab.name = patch.name;
      }
      return structuredClone(current);
    },
    addTab: async (id) => {
      const meta = projects.get(id);
      const tab = addSub(meta);
      meta.activeTab = tab.id;
      return structuredClone(meta);
    },
    removeTab: async (id, tabId) => {
      const meta = projects.get(id);
      meta.tabs = meta.tabs.filter((t) => t.id !== tabId);
      if (meta.activeTab === tabId) meta.activeTab = meta.tabs[0].id;
      return structuredClone(meta);
    },
    readTab: async (id, file) =>
      structuredClone(files.get(key(id, file)) ?? emptyDocument()),
    writeTab: async (id, file, doc) => {
      files.set(key(id, file), structuredClone(doc));
      return file;
    },
    closeAuxWindows: async () => {
      counts.aux += 1;
    },
  };
  function addSub(meta) {
    const index = meta.nextSubIndex;
    meta.nextSubIndex = index + 1;
    const tab = {
      id: `t${meta.tabs.length + 1}-${index}`,
      name: `Sub-Desktop #${index}`,
      kind: "sub",
      file: `sub-${index}.chiphippo`,
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
  };
}

/** The pieces app.js normally wires up, as stubs the tests can inspect. */
function harness({ boot = null, doc = new DeskDoc(null) } = {}) {
  const win = resetDom();
  const { bridge, projects, files, settings, counts } = fakeBridge();
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

test("with no project the strip is hidden and nothing claims the toolbar", () => {
  const { workspace, tabs } = harness();
  assert.equal(workspace.isOpen, false);
  assert.equal(workspace.activeTab, null);
  assert.equal(tabs.visible, false);
});

test("New Project adopts the desk you are on as Main, plus one sub-desktop", async () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const h = harness({ doc });

  await h.workspace.newProject();
  answerPrompt("6502 SBC");
  await settle();

  assert.equal(h.workspace.isOpen, true);
  assert.equal(h.workspace.projectName, "6502 SBC");
  assert.deepEqual(
    [...h.projects.values()][0].tabs.map((t) => t.name),
    ["Main", "Sub-Desktop #1"],
  );
  // Main holds the desk that was already there — nothing was discarded.
  assert.equal(h.files.get("6502-sbc/main.chiphippo").boards.length, 1);
  assert.equal(h.workspace.activeTab.name, "Main");
  assert.equal(h.settings.currentProject, "6502-sbc");
  assert.equal(h.tabs.visible, true);
  assert.equal(h.tabs.element.querySelectorAll(".project-tab").length, 2);
});

test("a name already saved offers to open that project instead", async () => {
  const h = harness();
  await h.workspace.newProject();
  answerPrompt("Clock");
  await settle();
  assert.equal(h.workspace.isOpen, true);

  // A second project by the same name: the dialog offers the saved one.
  await h.workspace.newProject();
  answerPrompt("clock");
  await settle();
  assert.ok(document.querySelector(".popup-confirm"));
  clickButton("Open it");
  await settle();
  assert.equal(h.projects.size, 1, "no second project was created");
  assert.equal(h.workspace.projectName, "Clock");
});

test("switching desktops stashes the one you leave and loads the other", async () => {
  const h = harness();
  await h.workspace.newProject();
  answerPrompt("Bench");
  await settle();
  // Put something on Main, and move the camera.
  h.doc.addBoard("pins-tiny", 0, 0);
  h.moveCamera({ cx: 12, cy: 8, zoom: 2 });
  const [main, sub] = h.workspace.activeTab
    ? [...h.projects.values()][0].tabs
    : [];

  await h.workspace.selectTab(sub.id);
  assert.equal(h.workspace.activeTab.id, sub.id);
  assert.equal(h.doc.boards.length, 0, "the sub-desktop is its own empty desk");
  assert.equal(h.sim.stops, 1, "run state never crosses a switch");
  assert.equal(h.counts.aux, 1, "the orphaned pinout/inspector windows close");

  // Back to Main: the board AND the camera come back.
  h.moveCamera({ cx: 0, cy: 0, zoom: 1 });
  await h.workspace.selectTab(main.id);
  assert.equal(h.doc.boards.length, 1);
  assert.deepEqual(h.camera(), { cx: 12, cy: 8, zoom: 2 });
});

test("each desktop is handed its own undo history", async () => {
  const h = harness();
  await h.workspace.newProject();
  answerPrompt("Histories");
  await settle();
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
  await h.workspace.newProject();
  answerPrompt("Dirt");
  await settle();
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
  assert.equal(h.files.get("dirt/main.chiphippo").boards.length, 1);
  assert.equal(
    h.tabs.element.querySelectorAll(".project-tab--dirty").length,
    0,
  );
});

test("Add tab lands you on the new sub-desktop", async () => {
  const h = harness();
  await h.workspace.newProject();
  answerPrompt("Growing");
  await settle();

  await h.workspace.addTab();
  const tabs = [...h.projects.values()][0].tabs;
  assert.equal(tabs.length, 3);
  assert.equal(h.workspace.activeTab.name, "Sub-Desktop #2");
  assert.equal(h.tabs.element.querySelectorAll(".project-tab").length, 3);
});

test("Add tab with no project open creates one first", async () => {
  const h = harness();
  await h.workspace.addTab();
  answerPrompt("From Scratch");
  await settle();
  assert.equal(h.workspace.isOpen, true);
  assert.deepEqual(
    [...h.projects.values()][0].tabs.map((t) => t.name),
    ["Main", "Sub-Desktop #1"],
  );
});

test("deleting a clean desktop just confirms; Main is never offered at all", async () => {
  const h = harness();
  await h.workspace.newProject();
  answerPrompt("Deletions");
  await settle();
  const [main, sub] = [...h.projects.values()][0].tabs;

  await h.workspace.deleteTab(main.id);
  assert.equal(document.querySelector(".popup-confirm"), null, "no dialog");
  assert.equal([...h.projects.values()][0].tabs.length, 2, "Main stays");

  await h.workspace.deleteTab(sub.id);
  clickButton("Delete");
  await settle();
  assert.deepEqual(
    [...h.projects.values()][0].tabs.map((t) => t.name),
    ["Main"],
  );
});

test("deleting a desktop with unsaved changes asks the three-way question", async () => {
  const h = harness();
  await h.workspace.newProject();
  answerPrompt("Unsaved");
  await settle();
  const [, sub] = [...h.projects.values()][0].tabs;
  await h.workspace.selectTab(sub.id);
  h.doc.addBoard("pins-tiny", 0, 0); // unsaved work on the sub-desktop
  h.workspace.refreshDirty();

  await h.workspace.deleteTab(sub.id);
  const labels = [...document.querySelectorAll(".popup-confirm button")].map(
    (b) => b.textContent.trim(),
  );
  assert.deepEqual(labels, ["Cancel", "Save and delete", "Delete anyway"]);

  // Cancelling keeps the desktop and its work.
  clickButton("Cancel");
  await settle();
  assert.equal([...h.projects.values()][0].tabs.length, 2);

  // Saving first writes the file, then removes the tab.
  await h.workspace.deleteTab(sub.id);
  clickButton("Save and delete");
  await settle();
  assert.equal(h.files.get("unsaved/sub-1.chiphippo").boards.length, 1);
  assert.equal([...h.projects.values()][0].tabs.length, 1);
  assert.equal(h.workspace.activeTab.name, "Main", "the desk falls back to Main"); // prettier-ignore
  assert.equal(h.doc.boards.length, 0, "and shows Main's document");
});

test("Properties… renames a desktop and persists it", async () => {
  const h = harness();
  await h.workspace.newProject();
  answerPrompt("Naming");
  await settle();
  const [, sub] = [...h.projects.values()][0].tabs;

  h.workspace.renameTab(sub.id);
  answerPrompt("Clock module");
  await settle();
  assert.equal([...h.projects.values()][0].tabs[1].name, "Clock module");
  assert.ok(
    [...h.tabs.element.querySelectorAll(".project-tab")].some(
      (b) => b.textContent.trim() === "Clock module",
    ),
  );
});

test("New on a tab empties that desktop after asking", async () => {
  const h = harness();
  h.doc.addBoard("pins-full", 0, 0);
  await h.workspace.newProject();
  answerPrompt("Clearing");
  await settle();
  assert.equal(h.doc.boards.length, 1);

  await h.workspace.newActiveTab(); // clean — no prompt
  assert.equal(h.doc.boards.length, 0);
  h.workspace.refreshDirty();
  assert.equal(h.workspace.activeDirty, true, "the file still holds the board");
});

test("boot puts the session back on the desktop it left", async () => {
  const { bridge, projects, files } = fakeBridge();
  const created = await bridge.project.create("Resume", {
    ...emptyDocument(),
    boards: [{ id: "bb1", type: "pins-tiny", x: 0, y: 0, rot: 0, group: null }],
  });
  // Left on the sub-desktop last time, with a board on it.
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
