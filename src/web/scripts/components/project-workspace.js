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

// project-workspace.js — the coordinator behind the desktop tabs (Feature
// 240): which project is open, which desktop is on the desk, and everything
// that has to happen when that changes.
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
// pointing at a chip on the desk being left behind, exactly the New/Open case
// main's `closeAuxWindows` already exists for.
//
// What deliberately DOES cross: the controller's copy buffers. Carrying a
// design from a sub-desktop into the main build is the whole feature.
//
// Saving follows the toolbar: New / Load / Save act on the ACTIVE TAB, whose
// file lives in the project folder, so Save never prompts for a path. The
// project file itself (the tab list) is written automatically whenever the set
// of tabs, their names, or the active one changes.

import { PopupManager } from "../popup-manager.js";
import { HistoryStore } from "../model/history-store.js";
import { DeskDoc, emptyDocument } from "../model/desk-doc.js";

/** The label a brand-new project's name dialog suggests nothing for. */
const NAME_PLACEHOLDER = "e.g. 6502 SBC";

/**
 * A document in the ONE canonical form the desk holds it in. A file — or an
 * older one brought forward by the migrations — can spell the same desk
 * differently from what `DeskDoc` normalizes it to, and the desk shows the
 * normalized version. Canonicalizing on the way IN is what lets the dirty
 * marker stay a plain string comparison instead of reporting every freshly
 * opened desktop as changed.
 */
const canonical = (raw) => new DeskDoc(raw).toJSON();

export class ProjectWorkspace {
  #bridge;
  #deskDoc;
  #controller;
  #sim;
  #tabsView;
  #getCamera;
  #setCamera;
  #onActiveChange;
  #project = null; // { id, name, tabs: [...], activeTab } | null
  #state = new Map(); // tabId → { doc, savedJson, history, camera }

  /**
   * Read back the project a previous session left open, BEFORE the desk is
   * built — so the app opens straight onto the right desktop instead of
   * painting the working desk and swapping it out a moment later.
   *
   * @returns {Promise<{project: object, doc: object}|null>} null when no
   *   project is open (or the one recorded has since gone).
   */
  static async boot(bridge, settings) {
    const id = settings?.currentProject;
    if (!id || !bridge?.project) return null;
    let project = null;
    try {
      project = await bridge.project.load(id);
    } catch (err) {
      console.error("[renderer] project:load failed:", err);
    }
    if (!project?.tabs?.length) return null;
    const active =
      project.tabs.find((t) => t.id === project.activeTab) ?? project.tabs[0];
    project.activeTab = active.id;
    let doc = null;
    try {
      doc = await bridge.project.readTab(project.id, active.file);
    } catch (err) {
      console.error("[renderer] project:read-tab failed:", err);
      return null;
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
    // The dirty marker is per desktop, so it re-derives on every edit — the
    // same whole-document comparison the window title has always made.
    window.addEventListener("chiphippo:doc-changed", () => this.refreshDirty());
  }

  // ── What the shell asks about ───────────────────────────────────────────

  /** Is a project open (so the toolbar acts on a tab)? */
  get isOpen() {
    return this.#project != null;
  }

  /** The open project's display name, or null. */
  get projectName() {
    return this.#project?.name ?? null;
  }

  /** The active tab record `{id, name, kind, file}`, or null. */
  get activeTab() {
    if (!this.#project) return null;
    return (
      this.#project.tabs.find((t) => t.id === this.#project.activeTab) ?? null
    );
  }

  /** Does the active desktop differ from what its file holds? */
  get activeDirty() {
    const state = this.#state.get(this.#project?.activeTab);
    if (!state) return false;
    return JSON.stringify(this.#deskDoc.toJSON()) !== state.savedJson;
  }

  /** Freeze the tab strip's destructive affordances while the circuit runs. */
  setEditingLocked(locked) {
    this.#tabsView?.setEditingLocked(locked);
  }

  /** Re-derive every tab's dirty marker (cheap enough: documents are small). */
  refreshDirty() {
    if (!this.#project) return;
    const dirty = [];
    for (const tab of this.#project.tabs) {
      const state = this.#state.get(tab.id);
      if (!state) continue; // never visited — it is exactly its file
      const json =
        tab.id === this.#project.activeTab
          ? JSON.stringify(this.#deskDoc.toJSON())
          : JSON.stringify(state.doc);
      if (json !== state.savedJson) dirty.push(tab.id);
    }
    this.#tabsView?.setDirty(dirty);
  }

  // ── The Projects menu (the toolbar button) ──────────────────────────────

  /**
   * The Projects menu: New / Load, then Add tab. With no project open, "Add
   * tab" IS the create flow — it asks for a name first and lands you on a
   * project with a Main desktop (adopting the desk you were already on) and
   * one sub-desktop.
   */
  openMenu({ x, y }) {
    PopupManager.menu({
      x,
      y,
      items: [
        { label: "New Project…", onSelect: () => this.newProject() },
        { label: "Load Project…", onSelect: () => this.loadProject() },
        { separator: true },
        {
          label: this.isOpen ? "Add tab" : "Add tab…",
          onSelect: () => this.addTab(),
        },
      ],
    });
  }

  // ── Project lifecycle ───────────────────────────────────────────────────

  /** New Project…: name it, then create it around the desk you are on. */
  async newProject() {
    if (!(await this.#confirmLeaveProject())) return;
    this.#askName(async (name) => {
      const taken = (await this.#savedProjects()).find(
        (p) => p.name.toLowerCase() === name.toLowerCase(),
      );
      if (taken) {
        this.#offerExisting(taken, () => this.newProject());
        return;
      }
      let project;
      try {
        project = await this.#bridge.project.create(
          name,
          this.#deskDoc.toJSON(),
          { subCount: 1 },
        );
      } catch (err) {
        // The store is the authority on uniqueness — two spellings of one name
        // collide there even when the list check above let them through.
        if (err?.message?.includes("already exists")) {
          const existing = (await this.#savedProjects()).find(
            (p) => p.name.toLowerCase() === name.toLowerCase(),
          );
          if (existing) {
            this.#offerExisting(existing, () => this.newProject());
            return;
          }
        }
        this.#fail("Could not create the project", err);
        return;
      }
      // The desk that became Main is already on screen, so adopt without
      // reloading it — it IS the active document.
      this.#adopt(project, this.#deskDoc.toJSON());
      await this.#persistCurrent();
      this.#announce();
    });
  }

  /** Load Project…: pick from the projects this app has saved. */
  async loadProject() {
    const projects = await this.#savedProjects();
    if (projects.length === 0) {
      PopupManager.notify({
        title: "No saved projects",
        message: "Create one with Projects ▸ New Project…",
      });
      return;
    }
    PopupManager.menu({
      x: window.innerWidth / 2 - 120,
      y: 120,
      items: projects.map((p) => ({
        label: `${p.name} (${p.tabs} desktop${p.tabs === 1 ? "" : "s"})`,
        onSelect: () => this.openProject(p.id),
      })),
    });
  }

  /** Open a saved project by id, replacing whatever is open. */
  async openProject(id) {
    if (!(await this.#confirmLeaveProject())) return;
    let project;
    try {
      project = await this.#bridge.project.load(id);
    } catch (err) {
      this.#fail("Could not open the project", err);
      return;
    }
    if (!project?.tabs?.length) {
      this.#fail("Could not open the project", new Error("it has no desktops"));
      return;
    }
    const active =
      project.tabs.find((t) => t.id === project.activeTab) ?? project.tabs[0];
    project.activeTab = active.id;
    let doc;
    try {
      doc = await this.#bridge.project.readTab(project.id, active.file);
    } catch (err) {
      this.#fail("Could not open the project", err);
      return;
    }
    this.#sim?.stop?.();
    await this.#closeAuxWindows();
    this.#state.clear();
    this.#adopt(project, doc);
    this.#controller.loadDocument(doc, {
      history: this.#state.get(active.id).history,
    });
    await this.#persistCurrent();
    this.#announce();
  }

  // ── Tabs ────────────────────────────────────────────────────────────────

  /** Add a sub-desktop — or, with no project open, create the project first. */
  async addTab() {
    if (!this.#project) {
      await this.newProject();
      return;
    }
    let project;
    try {
      project = await this.#bridge.project.addTab(this.#project.id);
    } catch (err) {
      this.#fail("Could not add a desktop", err);
      return;
    }
    const previous = this.#project.activeTab;
    this.#project = { ...project, activeTab: previous };
    this.#tabsView?.setTabs(this.#project.tabs, previous);
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
    this.#tabsView?.setTabs(this.#project.tabs, id);
    await this.#saveMeta();
    this.#announce();
  }

  /** Properties… on a tab: rename this desktop. */
  renameTab(id) {
    const tab = this.#project?.tabs.find((t) => t.id === id);
    if (!tab) return;
    PopupManager.prompt({
      title: "Desktop properties",
      label: "Name",
      value: tab.name,
      confirmLabel: "Rename",
      onConfirm: async (name) => {
        if (!name || name === tab.name) return;
        tab.name = name;
        this.#tabsView?.setTabs(this.#project.tabs, this.#project.activeTab);
        await this.#saveMeta();
        this.#announce();
      },
    });
  }

  /**
   * Delete a desktop. The Main tab is the project and can never go. A desktop
   * with unsaved changes asks the three-way question first — cancel, save it,
   * or lose it — because the delete is the last chance to keep that work.
   */
  async deleteTab(id) {
    const tab = this.#project?.tabs.find((t) => t.id === id);
    if (!tab || tab.kind === "main") return;
    const state = this.#state.get(id);
    const json =
      id === this.#project.activeTab
        ? JSON.stringify(this.#deskDoc.toJSON())
        : JSON.stringify(state?.doc ?? null);
    const dirty = state != null && json !== state.savedJson;
    if (!dirty) {
      PopupManager.confirm({
        title: `Delete "${tab.name}"?`,
        message: "Its design is removed from the project.",
        confirmLabel: "Delete",
        confirmClass: "btn--danger",
        onConfirm: () => this.#doDeleteTab(id),
      });
      return;
    }
    PopupManager.choose({
      title: `Delete "${tab.name}"?`,
      message: "It has unsaved changes.",
      choices: [
        { label: "Save and delete", value: "save" },
        { label: "Delete anyway", value: "discard", class: "btn--danger" },
      ],
      onChoose: async (answer) => {
        if (answer == null) return; // cancelled — the desktop stays
        if (answer === "save") await this.saveTab(id);
        await this.#doDeleteTab(id);
      },
    });
  }

  async #doDeleteTab(id) {
    let project;
    try {
      project = await this.#bridge.project.removeTab(this.#project.id, id);
    } catch (err) {
      this.#fail("Could not delete the desktop", err);
      return;
    }
    const wasActive = this.#project.activeTab === id;
    this.#state.delete(id);
    this.#project = {
      ...project,
      activeTab: wasActive ? project.activeTab : this.#project.activeTab,
    };
    this.#tabsView?.setTabs(this.#project.tabs, this.#project.activeTab);
    if (wasActive) {
      // The desk still shows the deleted desktop — put the surviving active
      // one on it. selectTab short-circuits on "already active", so load here.
      const tab = this.activeTab;
      const state = await this.#stateFor(tab);
      this.#sim?.stop?.();
      await this.#closeAuxWindows();
      this.#controller.loadDocument(state.doc, { history: state.history });
      if (state.camera) this.#setCamera?.(state.camera);
    }
    this.refreshDirty();
    this.#announce();
  }

  // ── The toolbar's file actions, aimed at the active tab ──────────────────

  /** Save the active desktop to its own file inside the project folder. */
  async saveActiveTab() {
    return this.saveTab(this.#project?.activeTab);
  }

  /**
   * Save one desktop — the live document when it is the active one, the
   * stashed copy otherwise (so "Save and delete" can save a desktop that is
   * not on screen).
   */
  async saveTab(id) {
    const tab = this.#project?.tabs.find((t) => t.id === id);
    if (!tab) return false;
    const state = await this.#stateFor(tab);
    const doc =
      id === this.#project.activeTab ? this.#deskDoc.toJSON() : state.doc;
    try {
      await this.#bridge.project.writeTab(this.#project.id, tab.file, doc);
    } catch (err) {
      this.#fail("Could not save the desktop", err);
      return false;
    }
    state.doc = doc;
    state.savedJson = JSON.stringify(doc);
    this.refreshDirty();
    this.#announce();
    return true;
  }

  /** New: empty the active desktop (its file keeps whatever was last saved). */
  async newActiveTab() {
    if (!this.#project) return;
    if (!(await this.#confirmDiscardActive())) return;
    const state = this.#state.get(this.#project.activeTab);
    this.#sim?.stop?.();
    await this.#closeAuxWindows();
    this.#controller.loadDocument(emptyDocument(), {
      history: state?.history ?? new HistoryStore(),
    });
    this.refreshDirty();
    this.#announce();
  }

  /** Load…: read a named `.chiphippo` into the active desktop. */
  async loadIntoActiveTab() {
    if (!this.#project) return;
    if (!(await this.#confirmDiscardActive())) return;
    let res;
    try {
      res = await this.#bridge.desk.open();
    } catch (err) {
      this.#fail("Could not open that schematic", err);
      return;
    }
    if (!res) return; // cancelled
    await this.#swapActiveDoc(res.doc);
  }

  /**
   * The same load, for a document the caller has ALREADY read — File ▸ Open
   * Recent, where main read the file (and vetted the path) before offering it.
   * @param {object} doc
   */
  async loadDocIntoActiveTab(doc) {
    if (!this.#project || !doc) return;
    if (!(await this.#confirmDiscardActive())) return;
    await this.#swapActiveDoc(doc);
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * Put `doc` on the desk as the active tab's document: stop the sim, drop the
   * aux windows pointing at the desk being replaced, then swap it in through
   * the controller's load path (keeping the tab's own undo history).
   */
  async #swapActiveDoc(doc) {
    const state = this.#state.get(this.#project.activeTab);
    this.#sim?.stop?.();
    await this.#closeAuxWindows();
    this.#controller.loadDocument(doc, {
      history: state?.history ?? new HistoryStore(),
    });
    this.refreshDirty();
    this.#announce();
  }

  /** Take a loaded project as the open one, seeding its active tab's state. */
  #adopt(project, doc) {
    this.#project = project;
    const canon = canonical(doc);
    this.#state.set(project.activeTab, {
      doc: canon,
      savedJson: JSON.stringify(canon),
      history: new HistoryStore(),
      camera: null,
    });
    this.#tabsView?.setTabs(project.tabs, project.activeTab);
    this.refreshDirty();
  }

  /** A tab's session state, reading its document from disk the first time. */
  async #stateFor(tab) {
    const known = this.#state.get(tab.id);
    if (known) return known;
    const raw = await this.#bridge.project.readTab(this.#project.id, tab.file);
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

  /** Persist the tab list — names, order, and which one is active. */
  async #saveMeta() {
    if (!this.#project) return;
    try {
      await this.#bridge.project.saveMeta(this.#project.id, {
        name: this.#project.name,
        activeTab: this.#project.activeTab,
        tabs: this.#project.tabs.map(({ id, name }) => ({ id, name })),
      });
    } catch (err) {
      console.error("[renderer] project:save-meta failed:", err);
    }
  }

  /** Remember (or forget) which project this app opens with. */
  async #persistCurrent() {
    try {
      await this.#bridge.settings.set({
        currentProject: this.#project?.id ?? null,
      });
    } catch (err) {
      console.error("[renderer] settings:set failed:", err);
    }
  }

  async #savedProjects() {
    try {
      return (await this.#bridge.project.list()) ?? [];
    } catch (err) {
      console.error("[renderer] project:list failed:", err);
      return [];
    }
  }

  #closeAuxWindows() {
    return Promise.resolve(this.#bridge.project?.closeAuxWindows?.()).catch(
      (err) => console.error("[renderer] project:closed-aux failed:", err),
    );
  }

  /** Ask for a project name (non-empty; the store owns uniqueness). */
  #askName(onName) {
    PopupManager.prompt({
      title: "New project",
      message: "A project holds your main desk plus any sub-desktops.",
      label: "Project name",
      placeholder: NAME_PLACEHOLDER,
      confirmLabel: "Create",
      onConfirm: (name) => {
        if (name) onName(name);
      },
    });
  }

  /** A name that is already saved: load that project, or pick another name. */
  #offerExisting(project, retry) {
    PopupManager.choose({
      title: `"${project.name}" already exists`,
      message: "Open the saved project, or choose a different name.",
      choices: [
        { label: "Open it", value: "open" },
        { label: "Choose another name", value: "rename" },
      ],
      onChoose: (answer) => {
        if (answer === "open") this.openProject(project.id);
        else if (answer === "rename") retry();
      },
    });
  }

  /** Guard leaving the open project with unsaved desktops behind. */
  #confirmLeaveProject() {
    if (!this.#project) return Promise.resolve(true);
    const dirty = this.#project.tabs.filter((tab) => {
      const state = this.#state.get(tab.id);
      if (!state) return false;
      const json =
        tab.id === this.#project.activeTab
          ? JSON.stringify(this.#deskDoc.toJSON())
          : JSON.stringify(state.doc);
      return json !== state.savedJson;
    });
    if (dirty.length === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      PopupManager.choose({
        title: "Unsaved desktops",
        message: `${dirty.length} desktop${dirty.length === 1 ? " has" : "s have"} unsaved changes.`,
        choices: [
          { label: "Save all", value: "save" },
          { label: "Discard", value: "discard", class: "btn--danger" },
        ],
        onChoose: async (answer) => {
          if (answer == null) return resolve(false);
          if (answer === "save") {
            for (const tab of dirty) await this.saveTab(tab.id);
          }
          resolve(true);
        },
      });
    });
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
          if (answer === "save") await this.saveActiveTab();
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
