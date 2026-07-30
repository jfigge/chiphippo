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
// there is ALWAYS a project, that THE PROJECT IS THE DOCUMENT (one file, one
// dirty flag, one Save), that a switch stashes the desk it leaves and keeps
// each tab's own history, that NOTHING is written until a save — and that
// nothing is lost without being asked.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc, emptyDocument } from "../model/desk-doc.js";

const { ProjectWorkspace } = await import("../components/project-workspace.js");
const { ProjectTabs } = await import("../components/project-tabs.js");
const { PopupManager } = await import("../popup-manager.js");

/** The app's own working slot, as main lays it out (store/project-store.js). */
const SAVES = "/data/saves";
const DEFAULT_PROJECT = `${SAVES}/default.chiphippo`;

const clone = (v) => (v == null ? v : structuredClone(v));

/** A desk document that is recognisably not the empty one. */
const someDesign = (id = "bb1") => ({
  ...emptyDocument(),
  boards: [{ id, type: "pins-full", x: 2, y: 2, rot: 0, group: null }],
  nextBoardId: 2,
});

/**
 * An in-memory stand-in for main's file-backed project store, over the same
 * IPC shape: ONE map standing for the filesystem (a project is one file), and
 * a `control` object for the answers the native dialogs would give.
 */
function fakeBridge() {
  const projects = new Map(); // path → the whole project, docs and all
  const settings = {};
  const counts = { aux: 0, saves: 0, stashes: 0, clears: 0 };
  let recent = [];
  // A write the test can HOLD OPEN, so an edit can land while one is in flight.
  // That is the only way to exercise the baseline race: the bytes that went are
  // decided at call time, and anything arriving before the write comes back must
  // still read as unsaved.
  let holdSave = null;
  const control = {
    failWrites: false, // a write that never reaches a file
    pickPaths: [], // what the Save-As dialog returns, in order
    openProject: null, // what the project Open dialog returns
    importDesktop: null, // what the Import dialog returns
    lastPick: null,
    lastExport: null,
  };
  let minted = 0;

  const remember = (filePath) => {
    recent = [filePath, ...recent.filter((p) => p !== filePath)].slice(0, 10);
  };

  // A brand-new project: blank name, blank location, ONE empty desktop, kept
  // in the app's working file until it is saved somewhere real.
  const create = () => {
    const meta = {
      name: "",
      description: "",
      activeTab: "t1",
      nextIndex: 2,
      tabs: [{ id: "t1", name: "Desktop 1", doc: emptyDocument() }],
      location: null,
    };
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
    // A save to a REAL path always empties the working slot: the slot holds only
    // what a project's own file does not, so once the file has everything there
    // is nothing left to hold — whether it was an untitled project's home or a
    // recovery copy stashed beside a saved one.
    save: async (meta, filePath) => {
      if (control.failWrites) throw new Error("no file to write to");
      counts.saves += 1; // counted where it STARTED, before any gate
      if (holdSave) await holdSave;
      const target = filePath ?? DEFAULT_PROJECT;
      projects.set(target, clone(meta));
      if (filePath) {
        remember(target);
        if (target !== DEFAULT_PROJECT) projects.delete(DEFAULT_PROJECT);
      }
      return { ok: true, path: target };
    },
    // The recovery slot's other job: the open project stashed in it WITHOUT its
    // own file being touched, stamped with the path it belongs to.
    recovery: {
      write: async (meta, location) => {
        if (control.failWrites) throw new Error("no file to write to");
        counts.stashes += 1;
        if (holdSave) await holdSave;
        if (!location) throw new Error("a recovery copy needs a project path");
        projects.set(DEFAULT_PROJECT, {
          ...clone(meta),
          recoveryFor: location,
        });
        return { ok: true };
      },
      clear: async () => {
        counts.clears += 1;
        projects.delete(DEFAULT_PROJECT);
        return { ok: true };
      },
    },
    // The native Save-As dialog: the test queues the paths it answers with,
    // and an empty queue is a cancelled dialog. Replacing an existing file is
    // the native dialog's own question, so a path is all that comes back.
    choosePath: async (kind, name, current) => {
      control.lastPick = { kind, name, current };
      return control.pickPaths.shift() ?? null;
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

  // Every COPY of a desktop comes back from main with its memory reseated, so
  // the fake marks the document it hands back — that is what a test asserts
  // on. The marker has to be a REAL document field: everything on its way into
  // the workspace is canonicalized through DeskDoc, which drops anything else.
  const reseat = (doc) => ({ ...clone(doc), nextBoardId: 100 + (minted += 1) });

  const desktop = {
    export: async (snapshot) => {
      control.lastExport = clone(snapshot);
      const chosen = control.pickPaths.shift();
      return chosen ? { path: chosen } : null;
    },
    import: async () =>
      control.importDesktop
        ? { ...clone(control.importDesktop), doc: reseat(control.importDesktop.doc) } // prettier-ignore
        : null,
    duplicate: async (doc) => ({ doc: reseat(doc) }),
  };

  // The bundled example circuits (Feature 270): main reads web/demos/<ref>.json
  // and hands over { ref, title, doc }; a part with no bench answers null.
  const examples = new Map(); // ref → { ref, title, doc }
  const demo = {
    open: async () => true, // the pinout window's half — never called from here
    read: async (ref) => {
      if (control.failExampleRead) throw new Error("unreadable example");
      return clone(examples.get(ref)) ?? null;
    },
  };

  // What the renderer last told main the native Desktop menu may offer. The
  // tab strip disables the same two items, so a test can hold the two answers
  // against each other.
  const desktopMenu = { canDelete: true, canDuplicate: true };

  return {
    bridge: {
      project,
      desktop,
      demo,
      settings: { set: async (patch) => Object.assign(settings, patch) },
      menu: {
        setEditState: async () => true,
        setDesktopState: async (state) => {
          Object.assign(desktopMenu, state);
          return true;
        },
      },
    },
    desktopMenu,
    projects,
    settings,
    counts,
    control,
    recentList: () => [...recent],
    /** Hold every write open until the returned release is called. */
    gateSaves: () => {
      let release;
      holdSave = new Promise((r) => {
        release = r;
      });
      return () => {
        holdSave = null;
        release();
      };
    },
    seedProject: (filePath, meta) => projects.set(filePath, clone(meta)),
    seedRecent: (filePath) => remember(filePath),
    seedExample: (ref, payload) => examples.set(ref, payload),
  };
}

/**
 * The pieces app.js normally wires up, as stubs the tests can inspect.
 *
 * `onLoad` stands for whatever the DESK makes of a document on the way in that
 * the stored copy spelled differently — a normalization, a migration, the
 * fit-to-screen recentre. It runs on every load, boot included, exactly where
 * the real controller's would.
 */
async function harness({
  doc = new DeskDoc(null),
  fake = fakeBridge(),
  onLoad = null,
  // Auto-save OFF unless a test asks for it: every other test here asserts on
  // what a DELIBERATE save wrote, and a background stash would move the working
  // slot underneath it. `0` is the real off switch, not a test-only escape.
  autoSaveMs = 0,
} = {}) {
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
      onLoad?.(doc);
    },
  };
  let camera = { cx: 0, cy: 0, zoom: 1 };
  const host = win.document.createElement("div");
  win.document.body.append(host);
  // Wired exactly as app.js wires it — the strip is built BEFORE the workspace
  // it reports to, so every callback reaches it through the same late binding.
  let workspace = null;
  const tabs = new ProjectTabs(host, {
    onSelect: (id) => void workspace?.selectTab(id),
    onAdd: () => void workspace?.addTab(),
    onImport: () => void workspace?.importTab(),
    onProperties: (id) => workspace?.editTabProperties(id),
    onDuplicate: (id) => void workspace?.duplicateTab(id),
    onExport: (id) => void workspace?.exportTab(id),
    onDelete: (id) => void workspace?.deleteTab(id),
  });
  const boot = await ProjectWorkspace.boot(fake.bridge);
  if (boot?.doc) {
    doc.load(boot.doc);
    onLoad?.(doc);
  }
  // What app.js's `updateTitle` is wired to — the • marker's one refresh seam.
  const announced = { count: 0 };
  workspace = new ProjectWorkspace({
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
    autoSaveMs,
    onActiveChange: () => {
      announced.count += 1;
    },
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
    announced,
    camera: () => camera,
    moveCamera: (c) => {
      camera = c;
    },
    /** The project as it stands on "disk", wherever it lives. */
    stored: (filePath = DEFAULT_PROJECT) => fake.projects.get(filePath),
    tabsOf: (filePath = DEFAULT_PROJECT) => fake.projects.get(filePath)?.tabs,
    /** The tab labels on the strip, in order. */
    strip: () =>
      [...tabs.element.querySelectorAll(".project-tab")].map((b) =>
        b.textContent.trim(),
      ),
  };
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
function findButton(label) {
  return (
    [...document.querySelectorAll(".popup-dialog button")].find(
      (b) => b.textContent.trim() === label,
    ) ?? null
  );
}

function clickButton(label) {
  const btn = findButton(label);
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

/** Give the open project a home — what Save As does, its one question
    answered. There is no name prompt: the file names the project. */
const saveAs = async (h, filePath) => {
  h.control.pickPaths.push(filePath);
  const ok = await h.workspace.saveAs();
  await settle();
  return ok;
};

/** Run something that LEAVES the open project, discarding it at the guard.
    An untitled project holding anything is asked about — the working slot it
    lives in is what the incoming project is about to claim — while a pristine
    one is let go silently, so the discard is conditional. */
const leaving = async (run) => {
  const done = run();
  await settle();
  if (findButton("Discard")) clickButton("Discard");
  const out = await done;
  await settle();
  return out;
};

/** A project of TWO desktops, back on the first, with the setup's own switch
    not counted against whatever the test is about to assert. */
const twoDesktops = async (h) => {
  await h.workspace.addTab();
  await settle();
  await h.workspace.selectTab("t1");
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
  assert.deepEqual(h.strip(), ["Desktop 1"]);
  assert.equal(
    h.tabs.element.querySelector(".project-tab").classList.contains("project-tab--active"), // prettier-ignore
    true,
  );
  assert.equal(h.tabs.element.querySelectorAll(".project-tab-add").length, 1);
  // A desktop is a DOCUMENT, not a file.
  assert.equal(h.workspace.activeTab.file, undefined);
  assert.ok(h.stored(DEFAULT_PROJECT), "the working file was written");
});

test("boot puts the session back on the desktop it left, design and all", async () => {
  const fake = fakeBridge();
  fake.seedProject("/home/six.chiphippo", {
    name: "6502 SBC",
    activeTab: "t2",
    nextIndex: 3,
    tabs: [
      { id: "t1", name: "Desktop 1", doc: emptyDocument() },
      { id: "t2", name: "Bench", doc: someDesign() },
    ],
  });
  fake.seedRecent("/home/six.chiphippo");
  const h = await harness({ fake });
  assert.equal(h.workspace.projectName, "6502 SBC");
  assert.equal(h.workspace.projectLocation, "/home/six.chiphippo");
  assert.equal(h.workspace.activeTab.name, "Bench");
  assert.deepEqual(
    h.doc.boards.map((b) => b.id),
    ["bb1"],
    "the desk shows that desktop's design, straight from the one file",
  );
  assert.equal(h.workspace.dirty, false, "and it IS its file");
});

test("a project that opens with warnings says so once", async () => {
  const fake = fakeBridge();
  const meta = {
    name: "Legacy",
    activeTab: "t1",
    nextIndex: 2,
    tabs: [{ id: "t1", name: "Gone", doc: emptyDocument() }],
    warnings: ['"Gone" opens empty — its file is gone: /old/x.desktop.chiphippo'], // prettier-ignore
  };
  fake.seedProject(DEFAULT_PROJECT, meta);
  await harness({ fake });
  assert.match(dialogTitle(), /could not be restored/);
});

// ── A just-loaded project is CLEAN ───────────────────────────────────────────
//
// Whatever the desk makes of a document on the way in — a normalization, a
// migration brought forward, a recentre — is the file as the app understands
// it, not an edit. The baseline is therefore taken from the DESK once it holds
// the document, so a project nobody has touched can never meet the next New or
// Open with a save-or-discard question.
//
// `onLoad` stands in for that: a rigid move of everything on the desk, which is
// exactly the shape of the fit-to-screen recentre.

test("boot is clean even when the desk moves the document loading it", async () => {
  const fake = fakeBridge();
  fake.seedProject("/home/six.chiphippo", {
    name: "6502 SBC",
    activeTab: "t1",
    nextIndex: 2,
    tabs: [{ id: "t1", name: "Bench", doc: someDesign() }],
  });
  fake.seedRecent("/home/six.chiphippo");
  const h = await harness({
    fake,
    onLoad: (doc) => doc.translateAll(-20, -20),
  });
  assert.deepEqual(
    h.doc.boards.map((b) => ({ x: b.x, y: b.y })),
    [{ x: -18, y: -18 }],
    "the desk did move it",
  );
  assert.equal(h.workspace.dirty, false, "and that is the baseline");
});

test("opening a project the desk moves loading it is clean too", async () => {
  const h = await harness({ onLoad: (doc) => doc.translateAll(-20, -20) });
  h.seedProject("/home/other.chiphippo", {
    name: "Other",
    activeTab: "t1",
    nextIndex: 2,
    tabs: [{ id: "t1", name: "Theirs", doc: someDesign("bb9") }],
  });
  h.control.openProject = "/home/other.chiphippo";
  await leaving(() => h.workspace.loadProject());
  assert.equal(h.workspace.projectName, "Other");
  assert.equal(h.workspace.dirty, false);

  // The baseline is the moved document, not the stored one — a save writes
  // what is on the desk, and an edit after it still registers.
  h.doc.load(someDesign("bb3"));
  assert.equal(h.workspace.dirty, true, "a real edit still counts");
});

// ── One document, one dirty flag ─────────────────────────────────────────────

test("editing ANY desktop makes the one project dirty", async () => {
  const h = await harness();
  assert.equal(h.workspace.dirty, false);
  h.doc.load(someDesign());
  assert.equal(h.workspace.dirty, true, "the desk on screen");

  await h.workspace.save();
  await settle();
  assert.equal(h.workspace.dirty, false);

  // A desktop that is NOT on screen counts exactly the same.
  await h.workspace.addTab();
  await settle();
  assert.equal(h.workspace.dirty, true, "adding one is a change to the file");
  await h.workspace.save();
  await settle();
  h.doc.load(someDesign("bb9"));
  await h.workspace.selectTab("t1");
  await settle();
  assert.equal(h.workspace.dirty, true, "the desk it stashed on the way out");
});

test("renaming a desktop or the project is an unsaved change", async () => {
  const h = await harness();
  await h.workspace.save();
  await settle();

  h.workspace.editTabProperties("t1");
  setProperty(".properties-text-input", "Clock module");
  closePopup();
  assert.equal(h.workspace.dirty, true);
  assert.deepEqual(h.strip(), ["Clock module"]);

  await h.workspace.save();
  await settle();
  h.workspace.editProjectProperties();
  setProperty(".properties-text-input", "6502 SBC");
  closePopup();
  assert.equal(h.workspace.dirty, true);
  assert.equal(h.workspace.projectName, "6502 SBC");
});

test("moving between desktops is not a change, and neither is panning", async () => {
  const h = await harness();
  await twoDesktops(h);
  await h.workspace.save();
  await settle();
  await h.workspace.selectTab("t2");
  await settle();
  h.moveCamera({ cx: 90, cy: 90, zoom: 3 });
  assert.equal(h.workspace.dirty, false);
});

test("the tab strip carries no dirty marker at all", async () => {
  const h = await harness();
  h.doc.load(someDesign());
  assert.equal(h.workspace.dirty, true);
  assert.equal(
    h.tabs.element.querySelector(".project-tab-marker"),
    null,
    "a desktop cannot be saved on its own, so a dot would be a lie",
  );
});

// ── Nothing is written until you save ────────────────────────────────────────

test("adding, renaming and deleting a desktop write nothing", async () => {
  const h = await harness();
  await h.workspace.save(); // the baseline in the working file
  await settle();
  const before = JSON.stringify(h.stored());

  await h.workspace.addTab();
  await settle();
  h.workspace.editTabProperties("t1");
  setProperty(".properties-text-input", "Renamed");
  closePopup();
  await h.workspace.deleteTab("t2");
  await settle();
  clickButton("Delete");
  await settle();

  assert.equal(JSON.stringify(h.stored()), before, "the file never moved");
  assert.equal(h.workspace.dirty, true, "it is all pending, and says so");
});

test("saving writes every desktop's design in one file", async () => {
  const h = await harness();
  h.doc.load(someDesign("bb1"));
  await h.workspace.addTab();
  await settle();
  h.doc.load(someDesign("bb7"));
  await h.workspace.save();
  await settle();

  const stored = h.stored();
  assert.deepEqual(
    stored.tabs.map((t) => t.doc.boards[0]?.id),
    ["bb1", "bb7"],
    "the desktop that was stashed AND the one on screen",
  );
  assert.equal(stored.tabs[0].file, undefined, "no companion files");
});

// ── Save, Save As, and the working slot ──────────────────────────────────────

test("Save on an untitled project asks nothing — the working file is its home", async () => {
  const h = await harness();
  h.doc.load(someDesign());
  assert.equal(await h.workspace.save(), true);
  await settle();
  assert.equal(h.control.lastPick, null, "no dialog was opened");
  assert.equal(h.workspace.isUntitled, true, "and it is still untitled");
  assert.equal(h.stored(DEFAULT_PROJECT).tabs[0].doc.boards.length, 1);
});

test("Save As names the project from the file, and empties the slot", async () => {
  const h = await harness();
  h.doc.load(someDesign());
  assert.equal(await saveAs(h, "/home/6502 SBC.chiphippo"), true);
  assert.equal(h.workspace.projectName, "6502 SBC", "no name prompt needed");
  assert.equal(h.workspace.projectLocation, "/home/6502 SBC.chiphippo");
  assert.equal(h.workspace.isUntitled, false);
  assert.equal(h.workspace.dirty, false);
  assert.equal(h.projects.has(DEFAULT_PROJECT), false, "the slot is free");
  assert.deepEqual(h.recentList(), ["/home/6502 SBC.chiphippo"]);
});

test("Save As on a NAMED project keeps its name; the file is a separate thing", async () => {
  const h = await harness();
  await saveAs(h, "/home/first.chiphippo");
  await saveAs(h, "/home/second.chiphippo");
  assert.equal(h.workspace.projectName, "first");
  assert.equal(h.workspace.projectLocation, "/home/second.chiphippo");
  assert.equal(h.control.lastPick.current, "/home/first.chiphippo");
});

test("a cancelled Save As is a cancel, not a save", async () => {
  const h = await harness();
  h.doc.load(someDesign());
  assert.equal(await h.workspace.saveAs(), false);
  assert.equal(h.workspace.dirty, true);
  assert.equal(h.workspace.projectLocation, null);
});

test("a failed write is reported and never claims to have saved", async () => {
  const h = await harness();
  h.doc.load(someDesign());
  h.control.failWrites = true;
  assert.equal(await h.workspace.save(), false);
  await settle();
  assert.match(dialogTitle(), /Could not save the project/);
  assert.equal(h.workspace.dirty, true);
});

// ── An edit landing while a write is in flight ───────────────────────────────
//
// The baseline is the bytes that WENT, never `#project` as it stands when the
// write comes back. A desk edit was always safe (the dirty test re-reads the
// live DeskDoc); a META edit was not, because every one of them reassigns
// `#project` — so signing it afterwards folded an unwritten change into the
// baseline, the • cleared, and the leave guard stopped asking about it.

test("a desk edit during a write stays unsaved, and lands on the next save", async () => {
  const h = await harness();
  const release = h.gateSaves();
  const writing = h.workspace.save();
  await settle();
  h.doc.load(someDesign("bb9")); // arrives mid-write
  release();
  assert.equal(await writing, true);
  await settle();

  assert.equal(h.workspace.dirty, true, "it was never written");
  assert.equal(h.stored().tabs[0].doc.boards.length, 0, "the file has neither");
  await h.workspace.save();
  await settle();
  assert.equal(h.stored().tabs[0].doc.boards[0].id, "bb9");
});

test("a desktop ADDED during a write stays unsaved", async () => {
  const h = await harness();
  const release = h.gateSaves();
  const writing = h.workspace.save();
  await settle();
  await h.workspace.addTab(); // reassigns #project mid-write
  await settle();
  release();
  assert.equal(await writing, true);
  await settle();

  assert.equal(h.workspace.dirty, true, "the new desktop is not in the file");
  assert.equal(h.tabsOf().length, 1, "and the file still shows one");
  await h.workspace.save();
  await settle();
  assert.equal(h.tabsOf().length, 2, "the next save carries it");
});

test("a desktop RENAMED during a write stays unsaved", async () => {
  const h = await harness();
  const release = h.gateSaves();
  const writing = h.workspace.save();
  await settle();
  h.workspace.editTabProperties("t1"); // #setTabProperty, no doc-changed at all
  setProperty(".properties-text-input", "Renamed");
  closePopup();
  release();
  assert.equal(await writing, true);
  await settle();

  assert.equal(h.workspace.dirty, true, "the rename is not in the file");
  assert.equal(h.tabsOf()[0].name, "Desktop 1");
});

// ── Auto-save: the working slot's second job ─────────────────────────────────
//
// THE USER'S FILE IS WRITTEN ONLY WHEN THEY ASK. A tick stashes the project in
// the app's own working slot instead, so a crash costs half a minute AND the •
// still means "not in your file" AND "discard" is still a revert. The tests
// drive `autoSaveNow()` directly — the decision is what matters, and a timer
// only says when. One test covers the cadence itself.

/** Give the project a home, then forget the setup's bookkeeping. */
const homed = async (h, at = "/home/adder.chiphippo") => {
  await saveAs(h, at);
  h.counts.saves = 0;
  h.counts.stashes = 0;
  h.counts.clears = 0;
  h.announced.count = 0;
  return at;
};

test("a tick stashes a SAVED project without touching its file", async () => {
  const h = await harness();
  const at = await homed(h);
  const onDisk = JSON.stringify(h.stored(at));
  h.doc.load(someDesign("bb4"));

  assert.equal(await h.workspace.autoSaveNow(), true);
  await settle();
  assert.equal(JSON.stringify(h.stored(at)), onDisk, "the FILE never moved");
  assert.equal(h.workspace.dirty, true, "so the • still stands");
  assert.equal(h.counts.saves, 0, "nothing went near the project file");
  // …and the work is in the slot, stamped with the file it belongs to.
  const slot = h.stored(DEFAULT_PROJECT);
  assert.equal(slot.tabs[0].doc.boards[0].id, "bb4");
  assert.equal(slot.recoveryFor, at, "the stamp says whose work this is");
});

test("a tick on an UNTITLED project is a real save — the slot is its home", async () => {
  const h = await harness();
  h.doc.load(someDesign("bb2"));

  assert.equal(await h.workspace.autoSaveNow(), true);
  await settle();
  const slot = h.stored(DEFAULT_PROJECT);
  assert.equal(slot.tabs[0].doc.boards[0].id, "bb2");
  assert.equal(slot.recoveryFor, undefined, "not a stash — its actual file");
  assert.equal(h.workspace.dirty, false, "so the • clears, honestly");
  assert.equal(h.counts.stashes, 0, "it took the ordinary save path");
});

test("a tick with nothing changed writes nothing at all", async () => {
  const h = await harness();
  await homed(h);
  assert.equal(await h.workspace.autoSaveNow(), false);
  assert.equal(h.counts.stashes, 0, "the write was never even started");
});

test("a stashed project is not re-stashed until it changes again", async () => {
  const h = await harness();
  await homed(h);
  h.doc.load(someDesign());
  assert.equal(await h.workspace.autoSaveNow(), true);
  await settle();

  // The • is still up (the file has none of this), so a dirty-driven tick would
  // rewrite the same bytes every 30 s forever. The stash baseline is what stops
  // it — this is why there are two baselines and not one.
  assert.equal(h.workspace.dirty, true);
  assert.equal(await h.workspace.autoSaveNow(), false, "nothing new to stash");
  assert.equal(h.counts.stashes, 1);

  h.doc.load(someDesign("bb5"));
  assert.equal(await h.workspace.autoSaveNow(), true, "…until it moves again");
  assert.equal(h.counts.stashes, 2);
});

test("a desktop RENAME is stashed, though it fires no doc-changed", async () => {
  const h = await harness();
  const at = await homed(h);
  h.workspace.editTabProperties("t1");
  setProperty(".properties-text-input", "Adder");
  closePopup();

  assert.equal(await h.workspace.autoSaveNow(), true, "the rename is a change");
  await settle();
  assert.equal(h.stored(DEFAULT_PROJECT).tabs[0].name, "Adder");
  assert.equal(h.stored(at).tabs[0].name, "Desktop 1", "not in the file yet");
});

test("saving throws the stash away — the file has everything now", async () => {
  const h = await harness();
  const at = await homed(h);
  h.doc.load(someDesign());
  await h.workspace.autoSaveNow();
  await settle();
  assert.equal(h.projects.has(DEFAULT_PROJECT), true, "a stash is waiting");

  assert.equal(await h.workspace.save(), true);
  await settle();
  assert.equal(h.projects.has(DEFAULT_PROJECT), false, "and now it is moot");
  assert.equal(h.workspace.dirty, false);
  assert.equal(h.stored(at).tabs[0].doc.boards.length, 1);
  assert.equal(await h.workspace.autoSaveNow(), false, "nothing to re-stash");
});

test("a quiet failure retires the tick rather than repeating a dialog", async () => {
  const h = await harness();
  await homed(h);
  h.doc.load(someDesign());
  h.control.failWrites = true;

  assert.equal(await h.workspace.autoSaveNow(), false);
  await settle();
  assert.equal(dialogTitle(), "", "a write nobody asked for cannot interrupt");
  assert.equal(h.workspace.dirty, true, "and the • stands as the only signal");

  h.control.failWrites = false;
  assert.equal(await h.workspace.autoSaveNow(), false, "retired");
  assert.equal(h.counts.stashes, 0);
  assert.equal(await h.workspace.save(), true, "⌘S is the way back");
});

test("a tick skips while a write is already in flight", async () => {
  const h = await harness();
  await homed(h);
  h.doc.load(someDesign());
  const release = h.gateSaves();
  const saving = h.workspace.save();
  await settle();

  assert.equal(await h.workspace.autoSaveNow(), false, "let the one going win");
  assert.equal(h.counts.stashes, 0);
  release();
  assert.equal(await saving, true);
});

test("a manual save during a tick still reports success", async () => {
  const h = await harness();
  const at = await homed(h);
  h.doc.load(someDesign("bb1"));
  const release = h.gateSaves();
  const ticking = h.workspace.autoSaveNow();
  await settle();
  // ⌘S lands on top of the background stash. It must never read as a cancel —
  // #askUnsaved treats a false as one, and would then keep the project open.
  const manual = h.workspace.save();
  release();
  await settle();
  assert.equal(await ticking, true);
  assert.equal(await manual, true, "queued behind it, not refused");
  assert.equal(h.workspace.dirty, false);
  assert.equal(h.stored(at).tabs[0].doc.boards[0].id, "bb1");
});

test("no tick fires while the leave question is open", async () => {
  const h = await harness();
  await homed(h);
  h.doc.load(someDesign());

  const leavingNow = h.workspace.newProject();
  await settle();
  assert.match(dialogTitle(), /unsaved/i, "the question is out");
  assert.equal(await h.workspace.autoSaveNow(), false, "nothing may write now");
  assert.equal(
    h.counts.stashes,
    0,
    "the discarded work never reached the slot",
  );

  clickButton("Discard");
  await leavingNow;
  await settle();
  assert.equal(h.stored().tabs[0].doc.boards.length, 0, "discard stayed true");
});

test("a clean quit throws the stash away — that is the crash signal", async () => {
  const h = await harness();
  await homed(h);
  h.doc.load(someDesign());
  await h.workspace.autoSaveNow();
  await settle();
  assert.equal(h.projects.has(DEFAULT_PROJECT), true);

  // Dirty, so it asks; discarding is still a real discard.
  const closing = h.workspace.confirmClose();
  await settle();
  clickButton("Discard");
  assert.equal(await closing, true);
  await settle();
  assert.equal(
    h.projects.has(DEFAULT_PROJECT),
    false,
    "no stash survives a session that ended properly",
  );
  assert.equal(
    await h.workspace.autoSaveNow(),
    false,
    "and nothing writes now",
  );
});

test("a clean quit KEEPS an untitled project's slot — it is its home", async () => {
  const h = await harness();
  h.doc.load(someDesign());
  await h.workspace.autoSaveNow(); // a real save, for an untitled project
  await settle();

  assert.equal(await h.workspace.confirmClose(), true, "clean: no question");
  assert.equal(
    h.stored(DEFAULT_PROJECT).tabs[0].doc.boards.length,
    1,
    "its work is in the slot and must still be there next launch",
  );
  assert.equal(h.counts.clears, 0);
});

test("a restored project arrives UNSAVED, so it can still be thrown away", async () => {
  // What main hands over after finding a stamped slot: the recovery, already
  // restored, flagged. It holds what its file does not, so the • has to be up.
  const fake = fakeBridge();
  fake.seedProject("/home/adder.chiphippo", {
    name: "adder",
    description: "",
    activeTab: "t1",
    nextIndex: 2,
    tabs: [{ id: "t1", name: "Desktop 1", doc: someDesign("bb1") }],
  });
  fake.projects.delete(DEFAULT_PROJECT);
  const boot = fake.bridge.project.boot;
  fake.bridge.project.boot = async () => {
    const meta = await boot();
    void meta;
    return {
      name: "adder",
      description: "",
      activeTab: "t1",
      nextIndex: 2,
      tabs: [{ id: "t1", name: "Desktop 1", doc: someDesign("bb7") }],
      location: "/home/adder.chiphippo",
      // Main hands over the FACTS; the renderer says the words, in the user's
      // own language (workspace.recovered*).
      restored: {
        name: "adder",
        path: "/home/adder.chiphippo",
        homeless: false,
      },
    };
  };
  const h = await harness({ fake });

  assert.equal(h.workspace.projectLocation, "/home/adder.chiphippo");
  assert.equal(
    h.doc.toJSON().boards[0].id,
    "bb7",
    "the recovery is on the desk",
  );
  assert.equal(h.workspace.dirty, true, "and it is not in the file");
  // The user is TOLD — a desk that silently disagreed with the file the title
  // bar names would make the • unexplainable. The wording is the catalog's, so
  // this asserts on the NAME it interpolated rather than the sentence.
  assert.match(dialogTitle(), /Recovered/);
  assert.match(
    document.querySelector(".popup-message")?.textContent ?? "",
    /adder/,
  );
  closePopup();
  // The way back is the one that always existed.
  assert.equal(await h.workspace.save(), true);
  assert.equal(h.stored("/home/adder.chiphippo").tabs[0].doc.boards[0].id, "bb7"); // prettier-ignore
});

test("a memory write is stashed even when the document is unchanged", async () => {
  const h = await harness();
  await homed(h);
  assert.equal(h.workspace.dirty, false, "nothing about the desk changed");

  // What MemoryBridge reports after writing a ROM's bytes: the chip was already
  // flagged programmed, so the document is identical and only the file moved.
  h.workspace.markImagesChanged();
  assert.equal(await h.workspace.autoSaveNow(), true, "the bytes must travel");
  await settle();
  assert.equal(await h.workspace.autoSaveNow(), false, "and only once");
});

test("the interval arms itself and keeps stashing", async () => {
  const h = await harness({ autoSaveMs: 5 });
  await saveAs(h, "/home/adder.chiphippo");
  h.doc.load(someDesign("bb1"));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(h.stored(DEFAULT_PROJECT)?.tabs[0].doc.boards[0].id, "bb1");

  h.doc.load(someDesign("bb2"));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(h.stored(DEFAULT_PROJECT)?.tabs[0].doc.boards[0].id, "bb2");
  const closing = h.workspace.confirmClose();
  await settle();
  if (findButton("Discard")) clickButton("Discard");
  assert.equal(await closing, true);
});

test("autoSaveMs 0 is a real off switch", async () => {
  const h = await harness({ autoSaveMs: 0 });
  await saveAs(h, "/home/adder.chiphippo");
  h.doc.load(someDesign());
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(h.projects.has(DEFAULT_PROJECT), false, "nothing was stashed");
  assert.equal(h.workspace.dirty, true);
});

// ── Desktops: switching, history, the desk it leaves ─────────────────────────

test("a switch stashes the desk it leaves and restores it on the way back", async () => {
  const h = await harness();
  h.doc.load(someDesign("bb1"));
  await h.workspace.addTab();
  await settle();
  assert.deepEqual(h.doc.boards, [], "a new desktop is empty");
  h.doc.load(someDesign("bb7"));

  await h.workspace.selectTab("t1");
  await settle();
  assert.deepEqual(
    h.doc.boards.map((b) => b.id),
    ["bb1"],
  );
  await h.workspace.selectTab("t2");
  await settle();
  assert.deepEqual(
    h.doc.boards.map((b) => b.id),
    ["bb7"],
    "exactly as it stood, with nothing written in between",
  );
});

test("each desktop keeps its own undo history and its own camera", async () => {
  const h = await harness();
  await h.workspace.addTab();
  await settle();
  const second = h.controller.loads.at(-1).history;
  h.moveCamera({ cx: 50, cy: 50, zoom: 2 });

  await h.workspace.selectTab("t1");
  await settle();
  const first = h.controller.loads.at(-1).history;
  assert.notEqual(first, second, "switching swaps the history too");

  await h.workspace.selectTab("t2");
  await settle();
  assert.equal(h.controller.loads.at(-1).history, second, "the same one back");
  assert.deepEqual(h.camera(), { cx: 50, cy: 50, zoom: 2 });
});

test("a switch stops the sim and drops the aux windows", async () => {
  const h = await harness();
  await twoDesktops(h);
  await h.workspace.selectTab("t2");
  await settle();
  assert.equal(h.sim.stops, 1, "run state never crosses documents");
  assert.equal(h.counts.aux, 1, "and neither does a pinout / inspector");
});

test("selecting the desktop already on the desk does nothing at all", async () => {
  const h = await harness();
  await twoDesktops(h);
  const loads = h.controller.loads.length;
  await h.workspace.selectTab(h.workspace.activeTab.id);
  await settle();
  assert.equal(h.controller.loads.length, loads);
  assert.equal(h.sim.stops, 0);
});

// ── Desktops: add, duplicate, import, export, delete ─────────────────────────

test("adding a desktop lands on a new empty desk", async () => {
  const h = await harness();
  h.doc.load(someDesign());
  await h.workspace.addTab();
  await settle();
  assert.deepEqual(h.strip(), ["Desktop 1", "Desktop 2"]);
  assert.equal(h.workspace.activeTab.name, "Desktop 2");
  assert.deepEqual(h.doc.boards, []);
  assert.equal(h.sim.stops, 1);
});

test("a duplicate copies the desk on screen, with its own memory", async () => {
  const h = await harness();
  h.doc.load(someDesign("bb3"));
  await h.workspace.duplicateTab("t1");
  await settle();
  assert.deepEqual(h.strip(), ["Desktop 1", "Desktop 1 copy"]);
  assert.equal(h.workspace.activeTab.name, "Desktop 1 copy");
  assert.deepEqual(
    h.doc.boards.map((b) => b.id),
    ["bb3"],
    "it duplicated what was on screen, not the last stash",
  );
  // Main reseated it: the copy's ROMs are its own files, never the source's.
  await h.workspace.save();
  await settle();
  const [source, copy] = h.stored().tabs;
  assert.ok(copy.doc.nextBoardId > 100, "the copy came back from main");
  assert.ok(source.doc.nextBoardId < 100, "the source was never reseated");
});

test("an import arrives as a NEW desktop, keeping its snapshot's name", async () => {
  const h = await harness();
  h.doc.load(someDesign("bb1"));
  h.control.importDesktop = {
    name: "Clock module",
    description: "the divider",
    doc: someDesign("bb5"),
  };
  await h.workspace.importTab();
  await settle();
  assert.deepEqual(h.strip(), ["Desktop 1", "Clock module"]);
  assert.deepEqual(
    h.doc.boards.map((b) => b.id),
    ["bb5"],
  );
  // Nothing was replaced: the desktop that was on screen is intact.
  await h.workspace.selectTab("t1");
  await settle();
  assert.deepEqual(
    h.doc.boards.map((b) => b.id),
    ["bb1"],
  );
});

test("importing the same snapshot twice gives each copy its own memory", async () => {
  const h = await harness();
  h.control.importDesktop = { name: "Bench", doc: someDesign() };
  await h.workspace.importTab();
  await settle();
  await h.workspace.importTab();
  await settle();
  await h.workspace.save();
  await settle();
  const [, one, two] = h.stored().tabs;
  assert.deepEqual([one.name, two.name], ["Bench", "Bench 2"]);
  assert.notEqual(one.doc.nextBoardId, two.doc.nextBoardId);
});

test("a cancelled import changes nothing", async () => {
  const h = await harness();
  h.control.importDesktop = null;
  await h.workspace.importTab();
  await settle();
  assert.deepEqual(h.strip(), ["Desktop 1"]);
});

// ── Example circuits (Feature 270) ──────────────────────────────────────────

test("a part's example arrives as a desktop named for it", async () => {
  const h = await harness();
  h.doc.load(someDesign("bb1"));
  h.seedExample("74LS00", {
    ref: "74LS00",
    title: "Quad 2-input NAND",
    doc: someDesign("bb7"),
  });
  assert.equal(await h.workspace.openExample("74LS00"), "added");
  await settle();
  assert.deepEqual(h.strip(), ["Desktop 1", "74LS00 example"]);
  assert.equal(h.workspace.activeTab.name, "74LS00 example");
  // The spec's title becomes the desktop's description — its tab tooltip.
  assert.equal(h.workspace.activeTab.description, "Quad 2-input NAND");
  assert.deepEqual(
    h.doc.boards.map((b) => b.id),
    ["bb7"],
  );
});

test("asking for the same example twice switches to it, never copies it", async () => {
  const h = await harness();
  h.seedExample("74LS00", { ref: "74LS00", title: "NAND", doc: someDesign() });
  await h.workspace.openExample("74LS00");
  await settle();
  await h.workspace.selectTab("t1");
  await settle();
  assert.equal(await h.workspace.openExample("74LS00"), "switched");
  await settle();
  assert.deepEqual(h.strip(), ["Desktop 1", "74LS00 example"]);
  assert.equal(h.workspace.activeTab.name, "74LS00 example");
});

test("two clicks in a row make ONE example desktop", async () => {
  const h = await harness();
  h.seedExample("74LS00", { ref: "74LS00", title: "NAND", doc: someDesign() });
  // Deliberately NOT awaited in turn: the name check and the insert are
  // separated by awaits, which is exactly where a double-click gets in.
  const [a, b] = await Promise.all([
    h.workspace.openExample("74LS00"),
    h.workspace.openExample("74LS00"),
  ]);
  await settle();
  assert.deepEqual([a, b], ["added", "added"], "both callers see one outcome");
  assert.deepEqual(h.strip(), ["Desktop 1", "74LS00 example"]);
});

test("an example is reseated like any other copy of a desktop", async () => {
  const h = await harness();
  h.seedExample("74LS00", { ref: "74LS00", title: "NAND", doc: someDesign() });
  await h.workspace.openExample("74LS00");
  await settle();
  // The fake marks a reseated document, so this proves desktop.duplicate was
  // in the path — two examples must never share a ROM guid.
  assert.equal(h.doc.toJSON().nextBoardId, 101);
});

test("an example is an unsaved change like any other desktop", async () => {
  const h = await harness();
  h.seedExample("74LS00", { ref: "74LS00", title: "NAND", doc: someDesign() });
  await h.workspace.openExample("74LS00");
  await settle();
  assert.equal(h.workspace.dirty, true);
  assert.equal(h.tabsOf().length, 1, "nothing was written");
});

test("a part with no bundled example is reported and changes nothing", async () => {
  const h = await harness();
  assert.equal(await h.workspace.openExample("ram-8k"), null);
  await settle();
  assert.match(dialogTitle(), /Could not open the ram-8k example/);
  assert.deepEqual(h.strip(), ["Desktop 1"]);
});

test("an unreadable example is reported and changes nothing", async () => {
  const h = await harness();
  h.control.failExampleRead = true;
  assert.equal(await h.workspace.openExample("74LS00"), null);
  await settle();
  assert.match(dialogTitle(), /Could not open the 74LS00 example/);
  assert.deepEqual(h.strip(), ["Desktop 1"]);
});

test("exporting hands over the desk on screen, name and all", async () => {
  const h = await harness();
  h.doc.load(someDesign("bb4"));
  h.workspace.editTabProperties("t1");
  setProperty(".properties-text-input", "Clock module");
  setProperty(".properties-textarea", "the divider");
  closePopup();

  h.control.pickPaths.push("/home/Clock module.desktop.chiphippo");
  assert.equal(await h.workspace.exportTab("t1"), true);
  assert.equal(h.control.lastExport.name, "Clock module");
  assert.equal(h.control.lastExport.description, "the divider");
  assert.deepEqual(
    h.control.lastExport.doc.boards.map((b) => b.id),
    ["bb4"],
    "what is on screen, not the last stash",
  );
  assert.equal(h.workspace.dirty, true, "an export is not a save");
});

test("exporting an inactive desktop takes ITS design", async () => {
  const h = await harness();
  h.doc.load(someDesign("bb1"));
  await h.workspace.addTab();
  await settle();
  h.doc.load(someDesign("bb7"));

  h.control.pickPaths.push("/home/one.desktop.chiphippo");
  await h.workspace.exportTab("t1");
  assert.deepEqual(
    h.control.lastExport.doc.boards.map((b) => b.id),
    ["bb1"],
  );
});

test("a cancelled export reports false", async () => {
  const h = await harness();
  assert.equal(await h.workspace.exportTab("t1"), false);
  assert.equal(await h.workspace.exportTab("t9"), false, "and an unknown tab");
});

test("deleting a desktop asks once, then removes it", async () => {
  const h = await harness();
  await twoDesktops(h);
  await h.workspace.deleteTab("t2");
  await settle();
  assert.match(dialogTitle(), /Delete "Desktop 2"/);
  clickButton("Delete");
  await settle();
  assert.deepEqual(h.strip(), ["Desktop 1"]);
  // No save-or-lose question: a desktop is not a file, so nothing was written.
  assert.equal(h.projects.has(DEFAULT_PROJECT), true);
});

test("deleting the ACTIVE desktop puts its neighbour on the desk", async () => {
  const h = await harness();
  h.doc.load(someDesign("bb1"));
  await h.workspace.addTab();
  await settle();
  h.doc.load(someDesign("bb7"));
  await h.workspace.deleteTab("t2");
  await settle();
  clickButton("Delete");
  await settle();
  assert.equal(h.workspace.activeTab.id, "t1");
  assert.deepEqual(
    h.doc.boards.map((b) => b.id),
    ["bb1"],
  );
  assert.equal(h.sim.stops > 0, true);
});

test("the last desktop cannot be deleted, and the strip disables it", async () => {
  const h = await harness();
  await h.workspace.deleteTab("t1");
  await settle();
  assert.equal(dialogTitle(), "", "not even asked");
  assert.deepEqual(h.strip(), ["Desktop 1"]);
});

// ── Leaving a project ────────────────────────────────────────────────────────

test("a brand-new project is not asked about — it holds nothing to lose", async () => {
  const h = await harness();
  assert.equal(h.workspace.dirty, false);
  await h.workspace.newProject();
  await settle();
  assert.equal(
    dialogTitle(),
    "",
    "the very first thing a session does must not open with a save question",
  );
  assert.deepEqual(h.strip(), ["Desktop 1"]);
  assert.equal(h.workspace.isUntitled, true, "and the new one is on the desk");
});

test("a second desktop is enough to be asked about", async () => {
  const h = await harness();
  await twoDesktops(h);
  const done = h.workspace.newProject();
  await settle();
  assert.match(dialogTitle(), /hasn't been saved/);
  clickButton("Discard");
  await done;
  await settle();
  assert.deepEqual(h.strip(), ["Desktop 1"], "one blank desktop again");
});

test("a SAVED project with nothing unsaved is not asked about", async () => {
  const h = await harness();
  await saveAs(h, "/home/six.chiphippo");
  await h.workspace.newProject();
  await settle();
  assert.equal(
    dialogTitle(),
    "",
    "it has a file of its own, and nothing is claiming it",
  );
  assert.equal(h.workspace.isUntitled, true, "and the new one is on the desk");
});

test("New Project offers to save the untitled work that is about to go", async () => {
  const h = await harness();
  h.doc.load(someDesign());
  const done = h.workspace.newProject();
  await settle();
  assert.match(dialogTitle(), /hasn't been saved/);
  h.control.pickPaths.push("/home/kept.chiphippo");
  clickButton("Save");
  await done;
  await settle();
  // It went to a home of its own — the working slot is the NEW project's now.
  assert.equal(h.projects.get("/home/kept.chiphippo").tabs[0].doc.boards.length, 1); // prettier-ignore
  assert.equal(h.workspace.projectLocation, null, "and this is the new one");
  assert.deepEqual(h.doc.boards, []);
});

test("a ⌘S into the slot does not make replacing it any less destructive", async () => {
  const h = await harness();
  h.doc.load(someDesign());
  await h.workspace.save(); // into the working slot: nothing is "unsaved"
  await settle();
  assert.equal(h.workspace.dirty, false);

  const done = h.workspace.newProject();
  await settle();
  assert.match(
    dialogTitle(),
    /hasn't been saved/,
    "the slot is about to be claimed, so the work still needs a home",
  );
  clickButton("Discard");
  await done;
  await settle();
});

test("Open… guards the untitled project the same way New Project does", async () => {
  const h = await harness();
  h.doc.load(someDesign()); // something in the slot for the guard to be about
  h.seedProject("/home/other.chiphippo", {
    name: "Other",
    activeTab: "t1",
    nextIndex: 2,
    tabs: [{ id: "t1", name: "Theirs", doc: someDesign("bb9") }],
  });
  h.control.openProject = "/home/other.chiphippo";
  const done = h.workspace.loadProject();
  await settle();
  assert.match(
    dialogTitle(),
    /hasn't been saved/,
    "the same claim on the slot",
  );
  clickButton("Discard");
  await done;
  await settle();
  assert.equal(h.workspace.projectName, "Other");
});

test("cancelling the guard calls the whole action off", async () => {
  const h = await harness();
  h.doc.load(someDesign());
  const done = h.workspace.newProject();
  await settle();
  clickButton("Cancel"); // every dismissal path answers, so nothing hangs
  await done;
  await settle();
  assert.deepEqual(
    h.doc.boards.map((b) => b.id),
    ["bb1"],
    "the project on screen is untouched",
  );
});

test("a save that never landed inside the guard is a cancel", async () => {
  const h = await harness();
  h.doc.load(someDesign());
  const done = h.workspace.newProject();
  await settle();
  clickButton("Save"); // …and no path is queued: the dialog is cancelled
  await done;
  await settle();
  assert.deepEqual(
    h.doc.boards.map((b) => b.id),
    ["bb1"],
    "the work is still only here, so New Project did not happen",
  );
});

test("a NAMED project's unsaved changes are offered on the way out", async () => {
  const h = await harness();
  await saveAs(h, "/home/six.chiphippo");
  h.doc.load(someDesign());
  const done = h.workspace.newProject();
  await settle();
  assert.match(dialogTitle(), /Unsaved changes/);
  clickButton("Save");
  await done;
  await settle();
  // Saved in place — no dialog, because it already has a home.
  assert.equal(h.projects.get("/home/six.chiphippo").tabs[0].doc.boards.length, 1); // prettier-ignore
});

test("quitting saves in place, asking nothing about where", async () => {
  const h = await harness();
  h.doc.load(someDesign());
  const closing = h.workspace.confirmClose();
  await settle();
  assert.match(dialogTitle(), /Unsaved changes/);
  clickButton("Save");
  assert.equal(await closing, true);
  await settle();
  assert.equal(h.control.lastPick, null, "no Save-As dialog when quitting");
  assert.equal(h.stored(DEFAULT_PROJECT).tabs[0].doc.boards.length, 1);
});

test("quitting a clean project asks nothing", async () => {
  const h = await harness();
  assert.equal(await h.workspace.confirmClose(), true);
  assert.equal(dialogTitle(), "");
});

// ── Opening another project ──────────────────────────────────────────────────

test("opening a project swaps the whole desk", async () => {
  const h = await harness();
  h.seedProject("/home/other.chiphippo", {
    name: "Other",
    activeTab: "t1",
    nextIndex: 2,
    tabs: [{ id: "t1", name: "Theirs", doc: someDesign("bb9") }],
  });
  h.control.openProject = "/home/other.chiphippo";
  await leaving(() => h.workspace.loadProject());
  assert.equal(h.workspace.projectName, "Other");
  assert.deepEqual(h.strip(), ["Theirs"]);
  assert.deepEqual(
    h.doc.boards.map((b) => b.id),
    ["bb9"],
  );
  assert.equal(h.workspace.dirty, false);
  assert.equal(h.sim.stops, 1);
  assert.equal(h.counts.aux, 1);
});

test("a recent project that has gone offers to be forgotten", async () => {
  const h = await harness();
  h.seedRecent("/home/gone.chiphippo");
  await leaving(() => h.workspace.openRecentProject("/home/gone.chiphippo"));
  assert.match(dialogTitle(), /no longer there/);
  clickButton("Remove");
  await settle();
  assert.equal(h.recentList().includes("/home/gone.chiphippo"), false);
});

test("a recent project that is still there opens", async () => {
  const h = await harness();
  h.seedProject("/home/six.chiphippo", {
    name: "6502 SBC",
    activeTab: "t1",
    nextIndex: 2,
    tabs: [{ id: "t1", name: "Main", doc: emptyDocument() }],
  });
  h.seedRecent("/home/six.chiphippo");
  await leaving(() => h.workspace.openRecentProject("/home/six.chiphippo"));
  assert.equal(h.workspace.projectName, "6502 SBC");
  assert.equal(h.workspace.projectLocation, "/home/six.chiphippo");
});

// ── The strip ────────────────────────────────────────────────────────────────

test("a desktop's description shows in its tab's tooltip", async () => {
  const h = await harness();
  h.workspace.editTabProperties("t1");
  setProperty(".properties-textarea", "the clock divider");
  closePopup();
  const tab = h.tabs.element.querySelector(".project-tab");
  assert.equal(tab.title, "Desktop 1\nthe clock divider");
});

/** The strip's "+", as a primary click and as a secondary one. */
const addButton = (h) => h.tabs.element.querySelector(".project-tab-add");
const clickAdd = (h) =>
  addButton(h).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const rightClickAdd = (h) =>
  addButton(h).dispatchEvent(
    new window.MouseEvent("contextmenu", { bubbles: true, clientX: 9, clientY: 9 }), // prettier-ignore
  );

test("a primary click on the + adds a desktop straight away", async () => {
  const h = await harness();
  h.doc.load(someDesign());
  clickAdd(h);
  await settle();
  assert.equal(
    document.querySelector(".popup-menu-item"),
    null,
    "no menu — the common thing just happens",
  );
  assert.deepEqual(h.strip(), ["Desktop 1", "Desktop 2"]);
  assert.equal(h.workspace.activeTab.name, "Desktop 2");
  assert.deepEqual(h.doc.boards, [], "and it lands you on the new desk");
});

test("the +'s secondary click offers New Desktop then Import Desktop", async () => {
  const h = await harness();
  rightClickAdd(h);
  assert.deepEqual(
    [...document.querySelectorAll(".popup-menu-item")].map((i) =>
      i.textContent.trim(),
    ),
    ["New Desktop", "Import Desktop…"],
  );
});

test("Import from the +'s menu brings a desktop in as a new tab", async () => {
  const h = await harness();
  h.doc.load(someDesign("bb1"));
  h.control.importDesktop = { name: "Clock module", doc: someDesign("bb5") };
  rightClickAdd(h);
  [...document.querySelectorAll(".popup-menu-item")]
    .find((i) => i.textContent.trim() === "Import Desktop…")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await settle();
  assert.deepEqual(h.strip(), ["Desktop 1", "Clock module"]);
  assert.deepEqual(
    h.doc.boards.map((b) => b.id),
    ["bb5"],
  );
});

test("the tab menu offers Properties, Duplicate, Export and Delete", async () => {
  const h = await harness();
  await twoDesktops(h);
  const tab = h.tabs.element.querySelector(".project-tab");
  tab.dispatchEvent(
    new window.MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }), // prettier-ignore
  );
  const labels = [...document.querySelectorAll(".popup-menu-item")].map((i) =>
    i.textContent.trim(),
  );
  assert.deepEqual(labels, [
    "Properties…",
    "Duplicate Desktop",
    "Export Desktop…",
    "Delete Desktop",
  ]);
  assert.equal(
    labels.includes("Pin Assignment"),
    false,
    "a desktop has no pins, so the board menu's shape is the right one",
  );
});

/** Which of the tab menu's items the strip currently offers, by label. A menu
    card has no header ×, so it is dismissed the way a click outside would —
    otherwise the next reading would find the last menu's items still there. */
function stripMenuEnabled(h, label) {
  const tab = h.tabs.element.querySelector(".project-tab");
  tab.dispatchEvent(
    new window.MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }), // prettier-ignore
  );
  const item = [...document.querySelectorAll(".popup-menu-item")].find(
    (i) => i.textContent.trim() === label,
  );
  const enabled = item != null && !item.disabled;
  PopupManager.close();
  return enabled;
}

test("the native Desktop menu is told what the strip disables — Delete", async () => {
  const h = await harness();
  // One desktop: a project cannot run out of them, so neither surface offers it.
  assert.equal(h.desktopMenu.canDelete, false);
  assert.equal(stripMenuEnabled(h, "Delete Desktop"), false);

  await h.workspace.addTab();
  await settle();
  assert.equal(h.desktopMenu.canDelete, true, "a second desktop enables it");
  assert.equal(stripMenuEnabled(h, "Delete Desktop"), true);

  // ...and back down again when the project is one desktop once more.
  await h.workspace.deleteTab("t2");
  await settle();
  clickButton("Delete");
  await settle();
  assert.equal(h.desktopMenu.canDelete, false);
  assert.equal(stripMenuEnabled(h, "Delete Desktop"), false);
});

test("the native Desktop menu is told what the strip disables — the run lock", async () => {
  const h = await harness();
  await twoDesktops(h);
  h.workspace.setEditingLocked(true);
  assert.deepEqual(h.desktopMenu, { canDelete: false, canDuplicate: false });
  assert.equal(stripMenuEnabled(h, "Duplicate Desktop"), false);
  assert.equal(stripMenuEnabled(h, "Delete Desktop"), false);

  h.workspace.setEditingLocked(false);
  assert.deepEqual(h.desktopMenu, { canDelete: true, canDuplicate: true });
  assert.equal(stripMenuEnabled(h, "Duplicate Desktop"), true);
  assert.equal(stripMenuEnabled(h, "Delete Desktop"), true);
});

test("opening another project re-reports what its desktops allow", async () => {
  const h = await harness();
  await twoDesktops(h);
  assert.equal(h.desktopMenu.canDelete, true);
  h.seedProject("/home/one.chiphippo", {
    name: "One",
    activeTab: "t1",
    nextIndex: 2,
    tabs: [{ id: "t1", name: "Only", doc: emptyDocument() }],
  });
  h.control.openProject = "/home/one.chiphippo";
  await leaving(() => h.workspace.loadProject());
  assert.equal(
    h.desktopMenu.canDelete,
    false,
    "the incoming project has one desktop, and the menu says so",
  );
});

test("running the circuit freezes the strip's destructive items", async () => {
  const h = await harness();
  await twoDesktops(h);
  h.workspace.setEditingLocked(true);
  const tab = h.tabs.element.querySelector(".project-tab");
  tab.dispatchEvent(
    new window.MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }), // prettier-ignore
  );
  const disabled = [...document.querySelectorAll(".popup-menu-item")]
    .filter((i) => i.disabled || i.getAttribute("aria-disabled") === "true")
    .map((i) => i.textContent.trim());
  assert.deepEqual(disabled, ["Duplicate Desktop", "Delete Desktop"]);
});
