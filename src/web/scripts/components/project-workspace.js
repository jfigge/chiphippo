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
// design worked out on one desktop onto another is the whole feature.
//
// Every desktop is a PEER — there is no privileged main desk. Any of them can
// be renamed or deleted; the only rule is that a project keeps at least one,
// which the store enforces and the strip reflects by disabling Delete on the
// last remaining tab.
//
// Saving follows the toolbar: New / Load / Save act on the ACTIVE TAB, whose
// file lives in the project folder, so Save never prompts for a path. The
// project file itself (the tab list) is written automatically whenever the set
// of tabs, their names/descriptions, or the active one changes.

import { PopupManager } from "../popup-manager.js";
import { PartPropertiesDialog } from "./part-properties-dialog.js";
import { HistoryStore } from "../model/history-store.js";
import { DeskDoc, emptyDocument } from "../model/desk-doc.js";

/** The label a brand-new project's name dialog suggests nothing for. */
const NAME_PLACEHOLDER = "e.g. 6502 SBC";

/**
 * The tab the strip shows when NO project is open: the working desk itself.
 * The strip is always on screen (that is the only place the "+" lives), so it
 * always has something to show — and this tab is honest about what the desk
 * is, rather than pretending a project exists. Creating one adopts this very
 * desk as its first desktop under this very name, so the tab reads the same
 * before and after.
 */
const WORKING_TAB = Object.freeze({
  id: "working",
  name: "Desktop 1",
  kind: "working",
  description: "The desk you are on. Add a desktop to make it a project.",
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

export class ProjectWorkspace {
  #bridge;
  #deskDoc;
  #controller;
  #sim;
  #tabsView;
  #getCamera;
  #setCamera;
  #onActiveChange;
  #isWorkingDirty;
  #saveWorking;
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
   * @param {() => boolean} [opts.isWorkingDirty] - with no project open the
   *   desk is the working document, whose baseline the shell owns; this is
   *   how the working tab gets the same • marker a desktop's does.
   * @param {() => Promise<boolean>} [opts.saveWorking] - and this is how it
   *   can be SAVED before a project takes the screen from it (the shell owns
   *   its file and its Save-As dialog; resolves false if it never landed).
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
    isWorkingDirty,
    saveWorking,
  }) {
    this.#bridge = bridge;
    this.#deskDoc = deskDoc;
    this.#controller = controller;
    this.#sim = sim;
    this.#tabsView = tabs;
    this.#getCamera = getCamera;
    this.#setCamera = setCamera;
    this.#onActiveChange = onActiveChange;
    this.#isWorkingDirty = isWorkingDirty;
    this.#saveWorking = saveWorking;
    if (boot?.project) this.#adopt(boot.project, boot.doc);
    else this.#renderTabs(); // the working desk's own tab
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

  /**
   * Is the open project the UNTITLED working one — never given a name, and so
   * never one of the user's saved projects? This is the only thing Save
   * Project… acts on, and the reason leaving is guarded.
   */
  get isUntitled() {
    return this.#project?.untitled === true;
  }

  /** The active tab record `{id, name, description?, kind, file}`, or null. */
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

  /**
   * QUITTING (or closing the window): the same question changing projects
   * asks, in the same three states — nothing unsaved goes without being
   * offered a save. Main waits on the answer, so this always settles.
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
    if (!this.#project) {
      // No project: the one tab is the working desk, and its baseline is the
      // shell's (desk.json vs the last-saved snapshot), not ours.
      const dirty = this.#isWorkingDirty?.() ? [WORKING_TAB.id] : [];
      this.#tabsView?.setDirty(dirty);
      return;
    }
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
   * The Projects menu: New / Load / Save, then Add Desktop. Nothing here asks
   * for a name except Save Project… — a project is untitled until the user
   * decides to keep it, so adding a desktop never stops to fill in a dialog.
   */
  openMenu({ x, y }) {
    PopupManager.menu({
      x,
      y,
      items: [
        { label: "New Project", onSelect: () => this.newProject() },
        { label: "Load Project…", onSelect: () => this.loadProject() },
        {
          label: "Save Project…",
          // A named project's own file is already kept up to date; there is
          // nothing for Save to do but rename it, which is not what it means.
          disabled: !this.isUntitled,
          title: this.isOpen
            ? this.isUntitled
              ? "Give this project a name and keep it"
              : "This project is saved — its desktops and tab list are kept up to date"
            : "No project to save",
          onSelect: () => this.saveProject(),
        },
        { separator: true },
        { label: "Add Desktop", onSelect: () => this.addTab() },
      ],
    });
  }

  // ── Project lifecycle ───────────────────────────────────────────────────

  /**
   * New Project: a blank slate — a fresh UNTITLED project holding ONE new,
   * empty desktop. No dialog: a name is asked for once, at Save Project…, and
   * never before. Whatever was open is dealt with first (`#confirmLeaveProject`
   * — saved, discarded, or the whole action cancelled).
   */
  async newProject() {
    if (!(await this.#confirmLeaveProject())) return;
    const doc = emptyDocument();
    let project;
    try {
      project = await this.#bridge.project.createUntitled(doc);
    } catch (err) {
      this.#fail("Could not start the project", err);
      return;
    }
    await this.#swapProject(project, doc);
  }

  /**
   * The "+" with no project open: start the untitled project AROUND the desk
   * you are on, so nothing is discarded — it becomes that project's ONE
   * desktop. A new project is always exactly one desk (the store cannot make
   * it otherwise), so the desktop the "+" is asking for is added on top, by
   * the ordinary `addTab` path that grows any other project.
   */
  async #startProjectAroundDesk() {
    const doc = this.#deskDoc.toJSON();
    let project;
    try {
      project = await this.#bridge.project.createUntitled(doc);
    } catch (err) {
      this.#fail("Could not start the project", err);
      return;
    }
    // The desk is already on screen and IS that desktop, so adopt it without
    // reloading anything.
    this.#state.clear();
    this.#adopt(project, doc);
    await this.#persistCurrent();
    this.#announce();
  }

  /** Put a just-opened/just-created project on the desk, from scratch. */
  async #swapProject(project, doc) {
    this.#sim?.stop?.();
    await this.#closeAuxWindows();
    this.#state.clear();
    this.#adopt(project, doc);
    this.#controller.loadDocument(doc, {
      history: this.#state.get(project.activeTab).history,
    });
    await this.#persistCurrent();
    this.#announce();
  }

  /**
   * Save Project…: the ONE moment a project needs a name. SAVES ALL OF IT —
   * every desktop to its own file first (a project's changes are its
   * desktops' changes), then the project itself. Naming is a move of the
   * whole working folder, so no document changes desk and the tab ids — and
   * every per-tab state this workspace holds — survive it untouched.
   *
   * @returns {Promise<boolean>} whether the project is now saved. A caller
   *   doing this on the user's behalf before something destructive must
   *   honour a `false`: the name dialog was cancelled, or a write failed, so
   *   the work is still only here.
   */
  async saveProject() {
    if (!this.isOpen) return false;
    for (const tab of this.#project.tabs) {
      if (!(await this.saveTab(tab.id))) return false;
    }
    // A project that already has a name is saved by the above: its tab list
    // is written on every change, so there is nothing else to do.
    if (!this.isUntitled) return true;
    for (;;) {
      const name = await this.#askName();
      if (!name) return false; // cancelled
      try {
        const project = await this.#bridge.project.saveAs(
          this.#project.id,
          name,
        );
        this.#project = { ...project, activeTab: this.#project.activeTab };
        await this.#persistCurrent();
        this.#renderTabs();
        this.#announce();
        return true;
      } catch (err) {
        // The name is the identity, so a clash can't be merged into — ask for
        // another one rather than offering to open the project that has it
        // (which would throw away the work being saved).
        if (err?.message?.includes("already exists")) {
          await this.#notify(
            `"${name}" is already a saved project`,
            "Choose a different name.",
          );
          continue;
        }
        this.#fail("Could not save the project", err);
        return false;
      }
    }
  }

  /** Load Project…: pick from the projects this app has saved. */
  async loadProject() {
    const projects = await this.#savedProjects();
    if (projects.length === 0) {
      PopupManager.notify({
        title: "No saved projects",
        message:
          "Add a desktop to start one, then keep it with Projects ▸ " +
          "Save Project…",
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
    await this.#swapProject(project, doc);
  }

  // ── Tabs ────────────────────────────────────────────────────────────────

  /**
   * Add a desktop. With no project open this quietly starts the UNTITLED
   * working project around the desk you are on first — no dialog, no name:
   * that is asked for once, if and when the user saves the project.
   */
  async addTab() {
    // No project yet: one appears around the desk (holding it as its single
    // desktop), and then the desktop actually asked for is added below.
    if (!this.#project) await this.#startProjectAroundDesk();
    if (!this.#project) return; // it could not be started
    let project;
    try {
      project = await this.#bridge.project.addTab(this.#project.id);
    } catch (err) {
      this.#fail("Could not add a desktop", err);
      return;
    }
    const previous = this.#project.activeTab;
    this.#project = { ...project, activeTab: previous };
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
    await this.#saveMeta();
    this.#announce();
  }

  /**
   * Properties… on a tab: the SAME shared dialog every part, board, and wire
   * opens, with the same universal Name/Description pair. A desktop declares no
   * fields of its own, so — like a board (desk-controller.js's
   * #onOpenBoardProperties) — it passes no `fields` list at all.
   */
  editTabProperties(id) {
    const tab = this.#project?.tabs.find((t) => t.id === id);
    if (!tab) return;
    PartPropertiesDialog.open({
      title: "Desktop Properties",
      values: { name: tab.name, description: tab.description },
      onChange: (key, value) => void this.#setTabProperty(id, key, value),
    });
  }

  /**
   * Apply one Properties-dialog field change to a tab. The dialog applies live
   * (one change per control, on blur/Enter), so each field commits on its own —
   * there is no Save to batch them behind.
   *
   * A desktop must keep a NAME: an empty one is ignored rather than stored, so
   * the strip can never render a blank tab (the store falls back to the old
   * name too). A description follows the omit-when-empty convention
   * DeskDoc.setComponentMeta uses — cleared, the key goes away entirely.
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
      return;
    }
    this.#renderTabs();
    await this.#saveMeta();
    this.#announce();
  }

  /**
   * Delete a desktop. Any of them can go, EXCEPT the last one — a project
   * with no desktops has nothing to open (the store refuses it too). A desktop
   * with unsaved changes asks the three-way question first — cancel, save it,
   * or lose it — because the delete is the last chance to keep that work.
   */
  async deleteTab(id) {
    const tab = this.#project?.tabs.find((t) => t.id === id);
    if (!tab || this.#project.tabs.length <= 1) return;
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
        // A save that never reached a file (a cancelled dialog, a failed
        // write) must not become a delete: the desktop stays, still dirty.
        if (answer === "save" && !(await this.saveTab(id))) return;
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
    this.#renderTabs();
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

  /**
   * Save the active desktop to its own file inside the project folder.
   * @returns {Promise<boolean>} whether it reached its file.
   */
  async saveActiveTab() {
    return this.saveTab(this.#project?.activeTab);
  }

  /**
   * Save one desktop — the live document when it is the active one, the
   * stashed copy otherwise (so "Save and delete" can save a desktop that is
   * not on screen).
   *
   * @returns {Promise<boolean>} whether the document reached its file. A
   *   caller that saves before discarding or deleting must honour a `false`:
   *   nothing was written, so the work is still only on the desk.
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

  /**
   * Push the current desktops onto the strip — the ONE place that decides
   * what it shows. With a project open that is its tabs; without one it is
   * the working desk's single tab, because the strip is always on screen and
   * the "+" beside it is the only route to another desktop.
   */
  #renderTabs() {
    if (!this.#project) {
      this.#tabsView?.setTabs([WORKING_TAB], WORKING_TAB.id);
      return;
    }
    this.#tabsView?.setTabs(this.#project.tabs, this.#project.activeTab);
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
    this.#renderTabs();
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

  /** Persist the tab list — names, descriptions, order, and which one is
      active. The description is always sent as a string, empty included, so
      CLEARING one is expressible: an absent key means "leave what is stored". */
  async #saveMeta() {
    if (!this.#project) return;
    try {
      await this.#bridge.project.saveMeta(this.#project.id, {
        name: this.#project.name,
        activeTab: this.#project.activeTab,
        tabs: this.#project.tabs.map(({ id, name, description }) => ({
          id,
          name,
          description: description ?? "",
        })),
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

  /**
   * Ask for a project name (the store owns uniqueness).
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
        confirmLabel: "Save",
        onConfirm: (name) => resolve(name || null),
        onCancel: () => resolve(null),
      });
    });
  }

  /** A notice the caller waits on before carrying on. */
  #notify(title, message) {
    return new Promise((resolve) => {
      PopupManager.notify({ title, message, onClose: resolve });
    });
  }

  /**
   * CHANGING PROJECTS — or QUITTING: everything open must be saved,
   * discarded, or the whole thing called off. Three different losses to
   * catch, one per state:
   *
   * ① no project — the working desk itself has unsaved changes, and a project
   *    is about to take the screen from it (or the window is going away).
   * ② an UNTITLED project — it lives in the one working slot, so starting or
   *    opening another overwrites it whether or not its desktops reached
   *    their files. It was never named, so this is the last moment it can be
   *    kept at all; "Save it first" names it AND writes every desktop.
   * ③ a saved project with desktops whose work is only on the desk.
   *
   * Answering "save" and having it succeed lets the action GO AHEAD — the
   * point is to change projects (or to quit), not to make the user ask twice.
   *
   * Only the WORDING differs between the two callers: what is at stake, and
   * what happens next, are identical.
   *
   * @param {{quitting?: boolean}} [opts]
   * @returns {Promise<boolean>} whether to proceed.
   */
  #confirmLeaveProject({ quitting = false } = {}) {
    if (!this.#project) return this.#confirmLeaveWorkingDesk(quitting);
    if (this.isUntitled) return this.#confirmSaveUntitled(quitting);
    return this.#confirmSaveDirtyTabs();
  }

  /** ① The plain working desk, about to be replaced on screen by a project. */
  #confirmLeaveWorkingDesk(quitting) {
    if (!this.#isWorkingDirty?.()) return Promise.resolve(true);
    return new Promise((resolve) => {
      PopupManager.choose({
        title: "The desk has unsaved changes",
        message: quitting
          ? "Quitting now loses them."
          : "A project is about to take its place on screen.",
        choices: [
          // Only offered when the shell handed us its Save — it owns the
          // working document's file, not this workspace.
          this.#saveWorking && { label: "Save first", value: "save" },
          { label: "Discard", value: "discard", class: "btn--danger" },
        ].filter(Boolean),
        onChoose: async (answer) => {
          if (answer == null) return resolve(false);
          // A save that never reached a file is a cancel, not a discard.
          if (answer === "save" && !(await this.#saveWorking())) {
            return resolve(false);
          }
          resolve(true);
        },
      });
    });
  }

  /** ② The untitled project is about to be replaced: name it, or lose it. */
  #confirmSaveUntitled(quitting) {
    return new Promise((resolve) => {
      PopupManager.choose({
        title: "This project hasn't been saved",
        message: quitting
          ? "It has no name yet, so quitting discards it — desktops and all."
          : "It has no name yet, so starting or opening another project " +
            "discards it — desktops and all.",
        choices: [
          { label: "Save it first", value: "save" },
          { label: "Discard", value: "discard", class: "btn--danger" },
        ],
        onChoose: async (answer) => {
          if (answer == null) return resolve(false);
          // saveProject asks for the name and writes every desktop; a
          // cancelled dialog or a failed write means nothing was saved, so
          // the project stays and the action that got here is called off.
          if (answer === "save" && !(await this.saveProject())) {
            return resolve(false);
          }
          resolve(true);
        },
      });
    });
  }

  /** ③ Desktops whose work is only on the desk. */
  #confirmSaveDirtyTabs() {
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
            // Stop at the first desktop that did not reach its file rather
            // than leaving the project behind with that work only on screen.
            for (const tab of dirty) {
              if (!(await this.saveTab(tab.id))) return resolve(false);
            }
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
