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

// project-workspace.js — the coordinator behind the desktop tabs: which
// project is open, which desktop is on the desk, and everything that has to
// happen when either changes.
//
// THERE IS ALWAYS A PROJECT. The app boots onto one (main's `project:boot`
// answers with the unsaved one from the saves folder, the most recent saved
// one, or a brand-new one), so there is no second "working desk" mode beside
// it: the desk always shows a desktop of the open project.
//
// A TAB IS A DOCUMENT, NOT A SECOND DESK. There is exactly one DeskView,
// DeskController, SimController, palette, guide, and analyzer, as there always
// was. Switching desktops SWAPS THE DOCUMENT in place through
// `DeskController.loadDocument` — the same restore + full-rebuild path
// undo/redo has used since Feature 200. That is why a tab switch needs no
// `window.location.reload()`: reload is the app's guaranteed teardown for a
// scene it cannot otherwise dismantle, and `#rebuildScene` IS the in-process
// one.
//
// What each tab keeps of its own while it is off-screen:
//   · its document (live JSON, stashed on the way out),
//   · its camera, so a desktop is where you left it,
//   · its saved baseline, so the • dirty marker is per desktop,
//   · its own HistoryStore — switch away, switch back, and ⌘Z undoes THAT
//     desk's last edit, not the other one's.
//
// What never crosses a switch: the running simulation (run-volatile by
// definition) and the auxiliary windows — a pinout or memory inspector is
// pointing at a chip on the desk being left behind.
//
// What deliberately DOES cross: the controller's copy buffers. Carrying a
// design worked out on one desktop onto another is the whole feature.
//
// Every desktop is a PEER — there is no privileged main desk. Any of them can
// be renamed, relocated, or deleted; the only rule is that a project keeps at
// least one.
//
// WHAT IS SAVED WHEN. A DESKTOP is a document and follows the manual model:
// Save writes it back to its own Location, Save As gives it a new one, and
// until then the • on its tab says the work is only on screen.
//
// The PROJECT FILE follows it: adding a desktop, renaming one, moving between
// them — those are the project's own unsaved changes, and `Save Project`
// writes them (along with every desktop). Discard them and they are GONE: a
// desktop added since the last save is not in the file the project reloads
// from, so the app-kept file it was using is cleaned up rather than left
// behind pointed at by nothing (`#discardProjectChanges`).
//
// Two things are written the moment they happen, because holding them back
// would leave a file lying rather than a change pending:
//   · a desktop's own file MOVING (Save As / Open) or being deleted — the
//     project must not go on pointing at a file that is gone;
//   · anything at all about the UNSAVED project, whose default project file
//     is not a copy of it but IS it: the only record, and what the next
//     launch opens.
// A write for either reason necessarily carries whatever else was pending —
// the file is written whole — so a delete or a Save As commits the rename you
// had not saved yet. That is the honest trade: what is on disk always matches
// where the desktops actually are.

import { PopupManager } from "../popup-manager.js";
import { PartPropertiesDialog } from "./part-properties-dialog.js";
import { HistoryStore } from "../model/history-store.js";
import { DeskDoc, emptyDocument } from "../model/desk-doc.js";

/** The label the project name dialog suggests nothing for. */
const NAME_PLACEHOLDER = "e.g. 6502 SBC";

/** The one extra field the Properties dialog shows for a project/desktop. */
const LOCATION_FIELD = Object.freeze({
  key: "location",
  label: "Location",
  type: "readonly",
});

/**
 * A document in the ONE canonical form the desk holds it in. A file — or an
 * older one brought forward by the migrations — can spell the same desk
 * differently from what `DeskDoc` normalizes it to, and the desk shows the
 * normalized version. Canonicalizing on the way IN is what lets the dirty
 * marker stay a plain string comparison instead of reporting every freshly
 * opened desktop as changed.
 */
const canonical = (raw) => new DeskDoc(raw).toJSON();

/** The last path segment of a file path (for a menu label / a message). */
const fileName = (p) => (p ? String(p).split(/[\\/]/).pop() : "");

export class ProjectWorkspace {
  #bridge;
  #deskDoc;
  #controller;
  #sim;
  #tabsView;
  #getCamera;
  #setCamera;
  #onActiveChange;
  #project = null; // { name, description, location, tabs, activeTab, nextIndex }
  #state = new Map(); // tabId → { doc, savedJson, history, camera }
  #projectSaved = null; // the project as its file holds it (the dirty test)

  /**
   * Read the project this session opens with, BEFORE the desk is built — so
   * the app paints the right desktop once instead of painting a blank one and
   * swapping it out a moment later. Main decides WHICH project that is (the
   * unsaved one, the most recent, or a brand-new one); this only reads its
   * active desktop's document.
   *
   * @returns {Promise<{project: object, doc: object}|null>} null only when
   *   even creating a project failed — the app then runs on in a degraded
   *   state rather than showing nothing at all.
   */
  static async boot(bridge) {
    let project = null;
    try {
      project = await bridge?.project?.boot();
    } catch (err) {
      console.error("[renderer] project:boot failed:", err);
    }
    if (!project?.tabs?.length) {
      try {
        project = await bridge?.project?.create();
      } catch (err) {
        console.error("[renderer] project:new failed:", err);
        return null;
      }
    }
    if (!project?.tabs?.length) return null;
    const active =
      project.tabs.find((t) => t.id === project.activeTab) ?? project.tabs[0];
    project.activeTab = active.id;
    let doc = null;
    try {
      doc = await bridge.project.readTab(active.file);
    } catch (err) {
      console.error("[renderer] project:read-tab failed:", err);
    }
    return { project, doc };
  }

  /**
   * @param {object} opts
   * @param {object} opts.bridge - window.chiphippo.
   * @param {import('../model/desk-doc.js').DeskDoc} opts.deskDoc - the ONE
   *   live document every collaborator holds; tabs swap its contents.
   * @param {import('./desk-controller.js').DeskController} opts.controller
   * @param {object} opts.sim - the SimController (stopped across a switch).
   * @param {import('./project-tabs.js').ProjectTabs} opts.tabs - the strip.
   * @param {() => object} opts.getCamera - the desk's current camera.
   * @param {(camera: object) => void} opts.setCamera
   * @param {object|null} [opts.boot] - the result of `ProjectWorkspace.boot`.
   * @param {(tab: object|null) => void} [opts.onActiveChange] - the active
   *   desktop (or the project) changed: re-title, re-baseline, re-render.
   */
  constructor({
    bridge,
    deskDoc,
    controller,
    sim,
    tabs,
    getCamera,
    setCamera,
    boot = null,
    onActiveChange,
  }) {
    this.#bridge = bridge;
    this.#deskDoc = deskDoc;
    this.#controller = controller;
    this.#sim = sim;
    this.#tabsView = tabs;
    this.#getCamera = getCamera;
    this.#setCamera = setCamera;
    this.#onActiveChange = onActiveChange;
    if (boot?.project) this.#adopt(boot.project, boot.doc);
    else this.#renderTabs();
    // The dirty marker is per desktop, so it re-derives on every edit — the
    // same whole-document comparison the window title has always made.
    window.addEventListener("chiphippo:doc-changed", () => this.refreshDirty());
  }

  // ── What the shell asks about ───────────────────────────────────────────

  /** Is a project on the desk? (false only in the degraded no-boot case) */
  get isOpen() {
    return this.#project != null;
  }

  /** The open project's name — blank until it has been saved under one. */
  get projectName() {
    return this.#project?.name || "";
  }

  /** The project file's path, or null while it has never been saved. */
  get projectLocation() {
    return this.#project?.location ?? null;
  }

  /**
   * Has this project never been given a name and a home? It is living in the
   * app's one default project file, so starting or opening another replaces
   * it — which is why leaving is guarded.
   */
  get isUntitled() {
    return this.isOpen && !this.#project.location;
  }

  /** The active tab record `{id, name, description?, file, defaultFile}`. */
  get activeTab() {
    if (!this.#project) return null;
    return (
      this.#project.tabs.find((t) => t.id === this.#project.activeTab) ?? null
    );
  }

  /**
   * Does the PROJECT differ from what its file holds — a desktop added or
   * renamed, the project itself renamed? (Which desktop is on the desk is
   * deliberately not counted: moving between tabs is not a change to keep or
   * throw away.) The unsaved project is never dirty in this sense — its file
   * is written as it goes, because that file is the project.
   */
  get projectDirty() {
    if (!this.#project || !this.#project.location) return false;
    return this.#projectSignature() !== this.#projectSaved;
  }

  /** Does the active desktop differ from what its file holds? */
  get activeDirty() {
    const state = this.#state.get(this.#project?.activeTab);
    if (!state) return false;
    return JSON.stringify(this.#deskDoc.toJSON()) !== state.savedJson;
  }

  /**
   * QUITTING (or closing the window): the same question changing projects
   * asks. Main waits on the answer, so this always settles.
   *
   * @returns {Promise<boolean>} whether it is safe to go.
   */
  confirmClose() {
    return this.#confirmLeaveProject({ quitting: true });
  }

  /** Freeze the tab strip's destructive affordances while the circuit runs. */
  setEditingLocked(locked) {
    this.#tabsView?.setEditingLocked(locked);
  }

  /** Re-derive every tab's dirty marker (cheap enough: documents are small). */
  refreshDirty() {
    if (!this.#project) return;
    this.#tabsView?.setDirty(this.#dirtyTabs().map((tab) => tab.id));
  }

  /** The desktops whose work is only on screen. */
  #dirtyTabs() {
    if (!this.#project) return [];
    return this.#project.tabs.filter((tab) => {
      const state = this.#state.get(tab.id);
      if (!state) return false; // never visited — it is exactly its file
      const json =
        tab.id === this.#project.activeTab
          ? JSON.stringify(this.#deskDoc.toJSON())
          : JSON.stringify(state.doc);
      return json !== state.savedJson;
    });
  }

  // ── Project lifecycle ───────────────────────────────────────────────────
  //
  // Every one of these is reached from the application's **Project** menu
  // (main.js `buildAppMenu`), which pushes `menu:project-*` and arrives here
  // as a `chiphippo:project-*` event app.js forwards. The renderer owns the
  // open project, so main never does more than name the action.

  /**
   * New Project: a blank slate — no name, no location, ONE new empty desktop,
   * living in the app's default project file until it is saved. No dialog: a
   * name is asked for once, at Save Project…, and never before. Whatever was
   * open is dealt with first (`#confirmLeaveProject`).
   */
  async newProject() {
    if (!(await this.#confirmLeaveProject())) return;
    let project;
    try {
      project = await this.#bridge.project.create();
    } catch (err) {
      this.#fail("Could not start the project", err);
      return;
    }
    await this.#swapProject(project);
  }

  /** Load Project…: pick a `.project.chiphippo` file. */
  async loadProject() {
    // The guard runs BEFORE the picker: opening a project takes over the
    // app's working slot, so nothing may be read until what is on screen has
    // been dealt with.
    if (!(await this.#confirmLeaveProject())) return;
    let project;
    try {
      project = await this.#bridge.project.open();
    } catch (err) {
      this.#fail("Could not open the project", err);
      return;
    }
    if (!project) return; // cancelled
    if (!project.tabs?.length) {
      this.#fail("Could not open the project", new Error("it has no desktops"));
      return;
    }
    await this.#swapProject(project);
  }

  /**
   * Open one of the recently used projects. Main only opens a path that is ON
   * its list, and a file that has since been moved or deleted comes back as
   * `missing` — the one moment the user can be sure the entry is dead.
   */
  async openRecentProject(filePath) {
    if (!(await this.#confirmLeaveProject())) return;
    let res;
    try {
      res = await this.#bridge.project.openRecent(filePath);
    } catch (err) {
      this.#fail("Could not open the project", err);
      return;
    }
    if (!res?.ok) {
      if (res?.code === "missing") return this.#offerForgetRecent(filePath);
      return PopupManager.notify({
        title: "Could not open that project",
        message: res?.error ?? "The file could not be read.",
      });
    }
    await this.#swapProject(res.project);
  }

  /** Put a just-opened/just-created project on the desk, from scratch. */
  async #swapProject(project) {
    const active =
      project.tabs.find((t) => t.id === project.activeTab) ?? project.tabs[0];
    project.activeTab = active.id;
    let doc;
    try {
      doc = await this.#bridge.project.readTab(active.file);
    } catch (err) {
      this.#fail("Could not open that desktop", err);
      return;
    }
    this.#sim?.stop?.();
    await this.#closeAuxWindows();
    this.#state.clear();
    this.#adopt(project, doc);
    this.#controller.loadDocument(this.#state.get(project.activeTab).doc, {
      history: this.#state.get(project.activeTab).history,
    });
    this.#announce();
  }

  /**
   * Save Project…: SAVES ALL OF IT — every desktop to its own file first (a
   * project's changes are its desktops' changes), then the project itself.
   *
   * A project needs a NAME before it can have a home, so a blank one is asked
   * for here; a project with no LOCATION then picks one, its suggested file
   * name built from that name. Moving out of the app's default project file
   * empties that slot (main deletes it), which is what makes the next launch
   * open THIS project rather than the blank one that used to live there.
   *
   * @returns {Promise<boolean>} whether the project is now saved. A caller
   *   doing this on the user's behalf before something destructive must
   *   honour a `false`: a dialog was cancelled or a write failed, so the work
   *   is still only here.
   */
  async saveProject() {
    return this.#saveProject({ relocate: false });
  }

  /**
   * Save Project As…: the same whole-project save, but ALWAYS to a new file.
   * A named project keeps its name — a project's name and the file it lives
   * in are two different things, exactly as a desktop's Save As leaves the
   * desktop called what it was called.
   *
   * @returns {Promise<boolean>} whether the project reached the new file.
   */
  async saveProjectAs() {
    return this.#saveProject({ relocate: true });
  }

  /**
   * The one whole-project save. `relocate` is the only difference between
   * Save and Save As: Save picks a location only when there isn't one yet,
   * Save As always asks.
   */
  async #saveProject({ relocate }) {
    if (!this.isOpen) return false;
    for (const tab of this.#project.tabs) {
      if (!(await this.saveTab(tab.id))) return false;
    }
    if (!this.#project.name) {
      const name = await this.#askName();
      if (!name) return false; // cancelled
      this.#project.name = name;
    }
    const current = this.#project.location;
    const wasUntitled = !current;
    let location = current;
    if (relocate || !location) {
      // A project that has never been saved lives in the app's default project
      // file, which was never meant to be seen — main suggests a file name
      // from the project's own name instead, so `null` rather than `current`.
      location = await this.#pickLocation(
        "project",
        this.#project.name,
        wasUntitled ? null : current,
      );
      if (!location) return false; // cancelled
    }
    let res;
    try {
      res = await this.#bridge.project.save(
        this.#metaForFile(),
        location,
        wasUntitled,
      );
    } catch (err) {
      this.#fail("Could not save the project", err);
      return false;
    }
    this.#project.location = res?.path ?? location;
    this.#projectSaved = this.#projectSignature(); // it is its file again
    this.#announce();
    return true;
  }

  /**
   * Properties… for the PROJECT: the same shared dialog every part, board, and
   * desktop opens — the universal Name/Description pair, plus the read-only
   * Location the project file is kept in (blank while it has never been saved).
   */
  editProjectProperties() {
    if (!this.isOpen) return;
    PartPropertiesDialog.open({
      title: "Project Properties",
      fields: [LOCATION_FIELD],
      values: {
        name: this.#project.name,
        description: this.#project.description,
        location: this.#project.location ?? "",
      },
      onChange: (key, value) => void this.#setProjectProperty(key, value),
    });
  }

  /** Apply one Properties-dialog field change to the project itself. */
  async #setProjectProperty(key, value) {
    if (!this.isOpen) return;
    const text = typeof value === "string" ? value.trim() : "";
    if (key === "name") {
      if (text === (this.#project.name ?? "")) return;
      this.#project.name = text;
    } else if (key === "description") {
      if (text === (this.#project.description ?? "")) return;
      this.#project.description = text;
    } else {
      return; // Location is read-only: Save Project… is what changes it
    }
    await this.#noteProjectChanged();
    this.#announce();
  }

  // ── Tabs ────────────────────────────────────────────────────────────────

  /**
   * Add a desktop: the next "Desktop N", in a freshly minted file in the app's
   * saves folder until the user gives it one of their own with Save As.
   */
  async addTab() {
    if (!this.#project) return;
    let project;
    try {
      project = await this.#bridge.project.addTab(this.#metaForFile());
    } catch (err) {
      this.#fail("Could not add a desktop", err);
      return;
    }
    const previous = this.#project.activeTab;
    this.#project = {
      ...project,
      location: this.#project.location,
      activeTab: previous,
    };
    this.#renderTabs();
    // Land on the new desktop — the point of adding one is to work on it.
    await this.selectTab(project.tabs[project.tabs.length - 1].id);
  }

  /** Put another desktop on the desk. */
  async selectTab(id) {
    if (!this.#project || id === this.#project.activeTab) return;
    const tab = this.#project.tabs.find((t) => t.id === id);
    if (!tab) return;
    // Stash the desk we are leaving, exactly as it stands.
    const leaving = this.#state.get(this.#project.activeTab);
    if (leaving) {
      leaving.doc = this.#deskDoc.toJSON();
      leaving.camera = this.#getCamera?.() ?? leaving.camera;
    }
    let state;
    try {
      state = await this.#stateFor(tab);
    } catch (err) {
      this.#fail("Could not open that desktop", err);
      return;
    }
    this.#sim?.stop?.(); // run state never crosses documents
    await this.#closeAuxWindows();
    this.#project.activeTab = id;
    this.#controller.loadDocument(state.doc, { history: state.history });
    if (state.camera) this.#setCamera?.(state.camera);
    this.#renderTabs();
    await this.#noteProjectChanged();
    this.#announce();
  }

  /**
   * Properties… on a tab: the SAME shared dialog every part, board, and the
   * project itself opens — Name/Description, plus the read-only Location of
   * the file this desktop is saved in.
   */
  editTabProperties(id) {
    const tab = this.#project?.tabs.find((t) => t.id === id);
    if (!tab) return;
    PartPropertiesDialog.open({
      title: "Desktop Properties",
      fields: [LOCATION_FIELD],
      values: {
        name: tab.name,
        description: tab.description,
        location: tab.file ?? "",
      },
      onChange: (key, value) => void this.#setTabProperty(id, key, value),
    });
  }

  /**
   * Apply one Properties-dialog field change to a tab. The dialog applies live
   * (one change per control, on blur/Enter), so each field commits on its own.
   *
   * A desktop must keep a NAME: an empty one is ignored rather than stored, so
   * the strip can never render a blank tab. A description follows the
   * omit-when-empty convention DeskDoc.setComponentMeta uses.
   */
  async #setTabProperty(id, key, value) {
    const tab = this.#project?.tabs.find((t) => t.id === id);
    if (!tab) return;
    const text = typeof value === "string" ? value.trim() : "";
    if (key === "name") {
      if (!text || text === tab.name) return;
      tab.name = text;
    } else if (key === "description") {
      if (text === (tab.description ?? "")) return;
      if (text) tab.description = text;
      else delete tab.description;
    } else {
      return; // Location is read-only: Save As is what changes it
    }
    this.#renderTabs();
    await this.#noteProjectChanged();
    this.#announce();
  }

  /**
   * Delete a desktop. Any of them can go, EXCEPT the last one — a project with
   * no desktops has nothing to open. A desktop with unsaved changes asks the
   * three-way question first — cancel, save it, or lose it — because the
   * delete is the last chance to keep that work.
   */
  async deleteTab(id) {
    const tab = this.#project?.tabs.find((t) => t.id === id);
    if (!tab || this.#project.tabs.length <= 1) return;
    const dirty = this.#dirtyTabs().some((t) => t.id === id);
    if (!dirty) {
      PopupManager.confirm({
        title: `Delete "${tab.name}"?`,
        message: tab.defaultFile
          ? `Its design is removed from the project, and the file the app is keeping for it is deleted (${tab.file}).`
          : `Its design is removed from the project. The file it was saved in is left alone (${tab.file}).`,
        confirmLabel: "Delete",
        confirmClass: "btn--danger",
        onConfirm: () => this.#doDeleteTab(id),
      });
      return;
    }
    PopupManager.choose({
      title: `Delete "${tab.name}"?`,
      message: tab.defaultFile
        ? "It has unsaved changes, and its file is one the app is keeping — deleting the desktop deletes that file too, so saving it means choosing where it goes."
        : "It has unsaved changes.",
      choices: [
        { label: "Save and delete", value: "save" },
        { label: "Delete anyway", value: "discard", class: "btn--danger" },
      ],
      onChoose: async (answer) => {
        if (answer == null) return; // cancelled — the desktop stays
        // A save that never reached a file (a cancelled dialog, a failed
        // write) must not become a delete: the desktop stays, still dirty.
        // A desktop whose file is inside the app's own folder has to be given
        // a home outside it first — the delete takes that file with it, so
        // saving there would keep nothing.
        if (answer === "save") {
          const kept = tab.defaultFile
            ? await this.saveTabAs(id)
            : await this.saveTab(id);
          if (!kept) return;
        }
        await this.#doDeleteTab(id);
      },
    });
  }

  async #doDeleteTab(id) {
    const tab = this.#project.tabs.find((t) => t.id === id);
    if (!tab || this.#project.tabs.length <= 1) return;
    const wasActive = this.#project.activeTab === id;
    this.#project.tabs = this.#project.tabs.filter((t) => t.id !== id);
    if (wasActive) this.#project.activeTab = this.#project.tabs[0].id;
    this.#state.delete(id);
    this.#renderTabs();
    await this.#persistProject();
    // The file goes with the desktop when it lives in the app's own saves
    // folder — whether the app minted it or the user saved it there. Main
    // decides from the path alone and leaves anything else where it is, so
    // the file is simply handed over.
    await this.#dropTempFile(tab.file);
    if (wasActive) {
      // The desk still shows the deleted desktop — put the surviving active
      // one on it. selectTab short-circuits on "already active", so load here.
      const state = await this.#stateFor(this.activeTab);
      this.#sim?.stop?.();
      await this.#closeAuxWindows();
      this.#controller.loadDocument(state.doc, { history: state.history });
      if (state.camera) this.#setCamera?.(state.camera);
    }
    this.#announce();
  }

  // ── The toolbar's file actions, aimed at the active tab ──────────────────

  /**
   * Save the active desktop to the file its Location names.
   * @returns {Promise<boolean>} whether it reached its file.
   */
  async saveActiveTab() {
    return this.saveTab(this.#project?.activeTab);
  }

  /**
   * Save one desktop to its own Location — the live document when it is the
   * active one, the stashed copy otherwise (so "Save and delete" can save a
   * desktop that is not on screen).
   *
   * @returns {Promise<boolean>} whether the document reached its file. A
   *   caller that saves before discarding or deleting must honour a `false`.
   */
  async saveTab(id) {
    const tab = this.#project?.tabs.find((t) => t.id === id);
    if (!tab) return false;
    const state = await this.#stateFor(tab);
    const doc =
      id === this.#project.activeTab ? this.#deskDoc.toJSON() : state.doc;
    try {
      await this.#bridge.project.writeTab(tab.file, doc);
    } catch (err) {
      this.#fail("Could not save the desktop", err);
      return false;
    }
    state.doc = doc;
    state.savedJson = JSON.stringify(doc);
    this.#announce();
    return true;
  }

  /** Save As on the active desktop. */
  async saveActiveTabAs() {
    return this.saveTabAs(this.#project?.activeTab);
  }

  /**
   * Save As on a desktop: choose a new file for it, write the design there,
   * and make that its Location from now on.
   *
   * The suggested file name comes from the DESKTOP'S NAME whenever the current
   * location is the app's own (a GUID it minted when the desktop was added) —
   * that name was never meant to be seen. And once the design has a real home,
   * the app-kept file is deleted: nothing but this desktop ever pointed at it.
   *
   * @returns {Promise<boolean>} whether the document reached a file.
   */
  async saveTabAs(id) {
    const tab = this.#project?.tabs.find((t) => t.id === id);
    if (!tab) return false;
    const chosen = await this.#pickLocation("desktop", tab.name, tab.file);
    if (!chosen) return false; // cancelled
    const state = await this.#stateFor(tab);
    const doc =
      id === this.#project.activeTab ? this.#deskDoc.toJSON() : state.doc;
    let written;
    try {
      written = await this.#bridge.project.writeTab(chosen, doc);
    } catch (err) {
      this.#fail("Could not save the desktop", err);
      return false;
    }
    const previous = tab.file;
    tab.file = chosen;
    // Whether the new home is one of the app's own is main's answer, not a
    // guess: saving INTO the saves folder leaves the desktop app-kept.
    this.#markAppKept(tab, written?.appKept);
    state.doc = doc;
    state.savedJson = JSON.stringify(doc);
    // The project file must learn where this desktop lives BEFORE its old
    // home is deleted, or a crash between the two would leave the project
    // pointing at a file that is gone.
    await this.#persistProject();
    if (previous !== chosen) await this.#dropTempFile(previous);
    this.#renderTabs();
    this.#announce();
    return true;
  }

  /** New: empty the active desktop (its file keeps whatever was last saved). */
  async newActiveTab() {
    if (!this.#project) return;
    if (!(await this.#confirmDiscardActive())) return;
    await this.#swapActiveDoc(emptyDocument());
  }

  /**
   * Load…: read a design file into the active desktop. The desktop ADOPTS that
   * file as its Location — a desktop is a document, and this is now the
   * document it is — so the file it was in before is dropped if it was one of
   * the app's own.
   */
  async loadIntoActiveTab() {
    if (!this.#project) return;
    if (!(await this.#confirmDiscardActive())) return;
    let res;
    try {
      res = await this.#bridge.desk.open();
    } catch (err) {
      this.#fail("Could not open that design", err);
      return;
    }
    if (!res) return; // cancelled
    const tab = this.activeTab;
    const previous = tab?.file;
    if (tab && res.path && res.path !== previous) {
      tab.file = res.path;
      this.#markAppKept(tab, res.appKept);
      await this.#persistProject();
      await this.#dropTempFile(previous);
      this.#renderTabs();
    }
    await this.#swapActiveDoc(res.doc, { saved: true });
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * Put `doc` on the desk as the active tab's document: stop the sim, drop the
   * aux windows pointing at the desk being replaced, then swap it in through
   * the controller's load path (keeping the tab's own undo history).
   *
   * `saved` says the document is exactly what its file holds (it was just read
   * from it), so the baseline moves with it and the tab shows no •.
   */
  async #swapActiveDoc(doc, { saved = false } = {}) {
    const state = this.#state.get(this.#project.activeTab);
    this.#sim?.stop?.();
    await this.#closeAuxWindows();
    const canon = canonical(doc);
    this.#controller.loadDocument(canon, {
      history: state?.history ?? new HistoryStore(),
    });
    if (state) {
      state.doc = canon;
      if (saved) state.savedJson = JSON.stringify(canon);
    }
    this.#announce();
  }

  /** Push the current desktops onto the strip. */
  #renderTabs() {
    if (!this.#project) {
      this.#tabsView?.setTabs([], null);
      return;
    }
    this.#tabsView?.setTabs(this.#project.tabs, this.#project.activeTab);
  }

  /** Take a loaded project as the open one, seeding its active tab's state. */
  #adopt(project, doc) {
    this.#project = {
      description: "",
      ...project,
      location: project.location ?? null,
    };
    // It came from its file, so it IS its file — the baseline every later
    // change is measured against.
    this.#projectSaved = this.#projectSignature();
    const canon = canonical(doc);
    this.#state.set(project.activeTab, {
      doc: canon,
      savedJson: JSON.stringify(canon),
      history: new HistoryStore(),
      camera: null,
    });
    this.#renderTabs();
    this.refreshDirty();
  }

  /** A tab's session state, reading its document from disk the first time. */
  async #stateFor(tab) {
    const known = this.#state.get(tab.id);
    if (known) return known;
    const raw = await this.#bridge.project.readTab(tab.file);
    const doc = canonical(raw);
    const state = {
      doc,
      savedJson: JSON.stringify(doc),
      history: new HistoryStore(),
      camera: null,
    };
    this.#state.set(tab.id, state);
    return state;
  }

  /** The project as its file holds it (the fields the store keeps). */
  #metaForFile() {
    const project = this.#project;
    return {
      name: project.name ?? "",
      description: project.description ?? "",
      activeTab: project.activeTab,
      nextIndex: project.nextIndex,
      tabs: project.tabs.map((tab) => ({
        id: tab.id,
        name: tab.name,
        description: tab.description ?? "",
        file: tab.file,
        defaultFile: tab.defaultFile === true,
      })),
    };
  }

  /**
   * Write the project file NOW — to its own location, or to the app's default
   * project file while it has none.
   *
   * Used only where NOT writing would leave the file lying: a desktop's own
   * file has just moved (Save As / Open) or been deleted, so a project still
   * pointing at where it used to be would lose it. Everything else that
   * changes a project goes through `#noteProjectChanged`.
   */
  async #persistProject() {
    if (!this.#project) return;
    try {
      await this.#bridge.project.save(
        this.#metaForFile(),
        this.#project.location,
        false,
      );
      this.#projectSaved = this.#projectSignature();
    } catch (err) {
      console.error("[renderer] project:save failed:", err);
    }
  }

  /**
   * The project itself changed — a desktop added, something renamed, another
   * tab put on the desk.
   *
   * For a SAVED project these are its unsaved changes, and they wait for a
   * Save exactly as a desktop's design does: that is what makes them
   * DISCARDABLE, and a desktop added and then discarded takes its app-kept
   * file with it (`#discardProjectChanges`) rather than leaving one behind
   * that nothing points at.
   *
   * The UNSAVED project is the exception, and has to be: the app's default
   * project file is not a copy of it, it IS it — the only record, and what
   * the next launch opens — so there is nothing to hold changes back from.
   */
  async #noteProjectChanged() {
    if (!this.#project) return;
    if (!this.#project.location) await this.#persistProject();
  }

  /** The project as its file holds it, minus which desktop is on screen —
      moving between tabs is not a change to keep or throw away. */
  #projectSignature() {
    const { activeTab, ...rest } = this.#metaForFile();
    void activeTab;
    return JSON.stringify(rest);
  }

  /**
   * `defaultFile` on a tab means "this file is inside the app's own saves
   * folder", which is what decides whether removing the desktop takes the file
   * with it. Only main knows where that folder is, so the answer always comes
   * from there (a write, an open, or a project read) — never from a guess
   * here. Omitted when false, the same omit-when-empty shape the file uses.
   */
  #markAppKept(tab, appKept) {
    if (appKept === true) tab.defaultFile = true;
    else delete tab.defaultFile;
  }

  /**
   * Drop the file a desktop has left behind — removed from the project, or
   * moved to a new home. Main deletes it only when it is inside the app's own
   * saves folder; a file the user keeps elsewhere is left where it is.
   */
  async #dropTempFile(filePath) {
    if (!filePath) return;
    try {
      await this.#bridge.project.dropTemp(filePath);
    } catch (err) {
      console.error("[renderer] project:drop-temp failed:", err);
    }
  }

  #forgetRecent(filePath) {
    return Promise.resolve(this.#bridge.project.recent.remove(filePath)).catch(
      (err) => console.error("[renderer] project:recent:remove failed:", err),
    );
  }

  #offerForgetRecent(filePath) {
    PopupManager.confirm({
      title: "That project is no longer there",
      message: `"${fileName(filePath)}" could not be found. Remove it from the recent projects?`,
      note: filePath,
      confirmLabel: "Remove",
      confirmClass: "btn--danger",
      onConfirm: () => this.#forgetRecent(filePath),
    });
  }

  #closeAuxWindows() {
    return Promise.resolve(this.#bridge.project?.closeAuxWindows?.()).catch(
      (err) => console.error("[renderer] project:closed-aux failed:", err),
    );
  }

  /**
   * Ask WHERE to keep a project or a desktop. The native save dialog is the
   * whole of it — including the "that file already exists, replace it?"
   * question, which every platform's own dialog asks in its own way. There is
   * deliberately no prompt of ours on top: it would be the second time the
   * user was asked the same thing.
   *
   * @param {"project"|"desktop"} kind
   * @param {string} name - the display name the suggested file name is built
   *   from (main composes it; the renderer never builds a path).
   * @param {string|null} current - the file it is saved in now, if any.
   * @returns {Promise<string|null>} the chosen path, or null if cancelled.
   */
  async #pickLocation(kind, name, current) {
    try {
      return (await this.#bridge.project.choosePath(kind, name, current)) ?? null; // prettier-ignore
    } catch (err) {
      this.#fail("Could not choose a location", err);
      return null;
    }
  }

  /**
   * Ask for a project name.
   * @returns {Promise<string|null>} null for every way of dismissing it, so a
   *   caller waiting on the answer can never be left hanging.
   */
  #askName() {
    return new Promise((resolve) => {
      PopupManager.prompt({
        title: "Save project",
        message:
          "Name this project to keep it. Its desktops are saved with it.",
        label: "Project name",
        placeholder: NAME_PLACEHOLDER,
        confirmLabel: "Continue",
        onConfirm: (name) => resolve(name?.trim() || null),
        onCancel: () => resolve(null),
      });
    });
  }

  /**
   * CHANGING PROJECTS — or QUITTING: everything unsaved must be saved,
   * discarded, or the whole thing called off.
   *
   * QUITTING is the simple case, and rule for it is: the user did not click a
   * Save button, so nothing is asked beyond the question itself — each dirty
   * desktop goes to the file it already has, and the project file to its own
   * location (or, having none, to the app's default project file, which is
   * where the next launch will look for it).
   *
   * CHANGING PROJECTS is different in exactly one way: an UNNAMED project
   * lives in that same default project file, and the project taking its place
   * is about to claim it. There is nowhere else to keep it, so "Save" here
   * means the full Save Project… — a name, and a home of its own.
   *
   * @param {{quitting?: boolean}} [opts]
   * @returns {Promise<boolean>} whether to proceed.
   */
  #confirmLeaveProject({ quitting = false } = {}) {
    if (!this.#project) return Promise.resolve(true);
    if (this.isUntitled && !quitting) {
      return this.#askUnsaved({
        title: "This project hasn't been saved",
        message:
          "It has no name yet, so starting or opening another project " +
          "discards it — desktops and all.",
        save: () => this.saveProject(),
      });
    }
    const dirty = this.#dirtyTabs();
    const project = this.projectDirty;
    if (dirty.length === 0 && !project) return Promise.resolve(true);
    return this.#askUnsaved({
      title: project && dirty.length === 0 ? "Unsaved project" : "Unsaved changes", // prettier-ignore
      message: this.#unsavedMessage(dirty.length, project, quitting),
      save: () => this.#saveDirtyInPlace(dirty),
    });
  }

  /** What exactly is unsaved — desktops, the project itself, or both. */
  #unsavedMessage(dirty, project, quitting) {
    const parts = [];
    if (dirty > 0) {
      parts.push(`${dirty} desktop${dirty === 1 ? " has" : "s have"} unsaved changes`); // prettier-ignore
    }
    // "The project" means its list of desktops and their names — a desktop
    // added since the last save is not in its file, so discarding drops it.
    if (project) parts.push("the project itself has changes that aren't saved");
    const what = parts.join(", and ");
    return `${what[0].toUpperCase()}${what.slice(1)}. ${quitting ? "Quitting" : "Leaving"} now loses them.`; // prettier-ignore
  }

  /** The one save-or-discard-or-cancel question, in its wordings. */
  #askUnsaved({ title, message, save }) {
    return new Promise((resolve) => {
      PopupManager.choose({
        title,
        message,
        choices: [
          { label: "Save", value: "save" },
          { label: "Discard", value: "discard", class: "btn--danger" },
        ],
        onChoose: async (answer) => {
          if (answer == null) return resolve(false); // cancelled
          // A save that never landed IS a cancel: the work is still only on
          // screen, so the action that got here is called off.
          if (answer === "save" && !(await save())) return resolve(false);
          if (answer === "discard") await this.#discardProjectChanges();
          resolve(true);
        },
      });
    });
  }

  /**
   * The project's unsaved changes are being thrown away. A desktop ADDED since
   * the last save is not in the file the project reloads from, so it is not
   * coming back — and the file the app was keeping for it would sit in the
   * saves folder forever, pointed at by nothing. Main compares the live
   * project against the one ON DISK and removes exactly those files (never a
   * file the user keeps elsewhere, and never one the project still lists).
   */
  async #discardProjectChanges() {
    if (!this.#project) return;
    try {
      await this.#bridge.project.discard(
        this.#metaForFile(),
        this.#project.location,
      );
    } catch (err) {
      console.error("[renderer] project:discard failed:", err);
    }
  }

  /** Write each dirty desktop back to the file it already has, then the
      project file — no dialogs, because no Save button was clicked. */
  async #saveDirtyInPlace(dirty) {
    for (const tab of dirty) {
      if (!(await this.saveTab(tab.id))) return false;
    }
    await this.#persistProject();
    return true;
  }

  /** Guard replacing the ACTIVE desktop's document (New / Load into it). */
  #confirmDiscardActive() {
    if (!this.activeDirty) return Promise.resolve(true);
    const tab = this.activeTab;
    return new Promise((resolve) => {
      PopupManager.choose({
        title: "Discard unsaved changes?",
        message: `"${tab?.name ?? "This desktop"}" has unsaved changes.`,
        choices: [
          { label: "Save first", value: "save" },
          { label: "Discard", value: "discard", class: "btn--danger" },
        ],
        onChoose: async (answer) => {
          if (answer == null) return resolve(false);
          // "Save first" that did not save is a cancel, not a discard.
          if (answer === "save" && !(await this.saveActiveTab())) {
            return resolve(false);
          }
          resolve(true);
        },
      });
    });
  }

  #announce() {
    this.refreshDirty();
    this.#onActiveChange?.(this.activeTab);
  }

  #fail(title, err) {
    console.error(`[renderer] ${title}:`, err);
    PopupManager.notify({ title, message: err?.message ?? String(err) });
  }
}
