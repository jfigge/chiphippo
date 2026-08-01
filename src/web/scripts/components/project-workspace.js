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
// THE PROJECT IS THE DOCUMENT. One file holds every desktop and every
// programmed ROM's bytes, so there is ONE dirty marker, ONE Save, ONE Save As,
// and one recent list. A desktop is STRUCTURE INSIDE that document, not a file
// of its own: adding, renaming, duplicating, importing and deleting one are
// ordinary unsaved changes.
//
// NOTHING IS WRITTEN TO YOUR FILE UNTIL YOU SAVE. Every eager write the
// previous design carried existed so the filesystem would not lie about where a
// desktop was; with no companion files there is nothing for it to lie about, so
// closing without saving is a complete, honest revert of the session.
//
// AND YET NOTHING IS LOST TO A CRASH, because those are different questions.
// Every AUTO_SAVE_MS the open project is stashed in the app's own WORKING SLOT
// — not in the user's file — so the • still means "not in your file", "discard"
// still discards, and a power cut still costs at most half a minute. See the
// Auto-save section below; the slot's two jobs are the whole trick.
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
// The ACTIVE desktop's document lives in the shared `DeskDoc`, not in the
// project meta — the meta's copy of it is a stash, refreshed by `#stash()`
// whenever the whole project is needed (a save, a switch, an export). Every
// OTHER desktop's document sits in `meta.tabs[].doc` exactly as its file will
// hold it. What each tab keeps of its own besides that:
//   · its camera, so a desktop is where you left it,
//   · its own HistoryStore — switch away, switch back, and ⌘Z undoes THAT
//     desk's last edit, not the other one's.
// A camera is deliberately NOT in the file: panning must never mark a design
// dirty.
//
// What never crosses a switch: the running simulation (run-volatile by
// definition) and the auxiliary windows — a pinout or memory inspector is
// pointing at a chip on the desk being left behind. What deliberately DOES
// cross: the controller's copy buffers. Carrying a design worked out on one
// desktop onto another is the whole feature.
//
// Every desktop is a PEER — there is no privileged main desk. Any of them can
// be renamed, duplicated, exported or deleted; the only rule is that a project
// keeps at least one.
//
// WHERE A SAVE GOES. An UNSAVED project (blank name, blank location) lives in
// the app's one fixed working file, and ⌘S writes it there with no dialog at
// all — designing a circuit and saving it must never require choosing a file.
// SAVE AS is what gives the project a real home, and it names an untitled
// project from the file the user picks, so there is no "name this project"
// prompt in front of the save panel.

import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { PartPropertiesDialog } from "./part-properties-dialog.js";
import { HistoryStore } from "../model/history-store.js";
import { DeskDoc, emptyDocument, isEmptyDocument } from "../model/desk-doc.js";
import {
  activeDesktop,
  addDesktop,
  duplicateDesktop,
  findDesktop,
  importDesktop,
  normalizeProject,
  projectForFile,
  projectSignature,
  removeDesktop,
  setActiveDesktop,
  setDesktopDoc,
  setDesktopField,
  setProjectField,
} from "../model/project-doc.js";

/**
 * How often the open project is stashed for crash recovery.
 *
 * A ceiling on what a crash can cost, not a promise about when: the tick only
 * writes when something changed, and Chromium clamps timers in a minimized or
 * occluded window — so the guarantee is "at most this much, while the window is
 * visible". A window nobody can see is not being edited, and `visibilitychange`
 * flushes on the way out of sight anyway.
 */
const AUTO_SAVE_MS = 30_000;

/** The one extra field the Properties dialog shows for a PROJECT. A function
    rather than a frozen constant because its label is translated, and `t()` must
    never run at module scope (see i18n.js). */
const locationField = () => ({
  key: "location",
  label: t("workspace.location"),
  type: "readonly",
});

/**
 * A document in the ONE canonical form the desk holds it in. A file — or an
 * older one brought forward by the migrations — can spell the same desk
 * differently from what `DeskDoc` normalizes it to, and the desk shows the
 * normalized version. Canonicalizing on the way IN is what lets the dirty
 * marker stay a plain string comparison instead of reporting every freshly
 * opened project as changed.
 */
const canonical = (raw) => new DeskDoc(raw).toJSON();

/** The last path segment of a file path (for a menu label / a message). */
const fileName = (p) => (p ? String(p).split(/[\\/]/).pop() : "");

/** A chosen file's name, minus the extension — what Save As calls an
    untitled project, so no separate name prompt is needed. */
function nameFromPath(filePath) {
  const base = fileName(filePath);
  return base.replace(/\.chiphippo$/i, "").trim() || t("common.untitled");
}

export class ProjectWorkspace {
  #bridge;
  #deskDoc;
  #controller;
  #sim;
  #tabsView;
  #getCamera;
  #setCamera;
  #onActiveChange;
  #project = null; // the normalized meta (model/project-doc.js) + `location`
  #state = new Map(); // tabId → { history, camera }
  #saved = null; // the signature of the project as its FILE holds it → the •
  #stashed = null; // …as the RECOVERY SLOT holds it → what the tick watches
  #locked = false; // editing frozen (the circuit is running)
  #examples = new Map(); // ref → the in-flight openExample promise
  #inFlight = null; // the write chain's tail, or null when nothing is writing
  #busy = false; // a leave/quit question is out, or a project is being swapped
  #autoSaveMs = 0; // 0 = off
  #autoTimer = null;
  #autoStopped = false; // the app is going away; nothing more may write
  #autoSaveFailed = false; // one quiet failure retires it (see autoSaveNow)
  #imagesTouched = false; // a ROM's bytes changed without the document changing
  #onHide = null; // the window-hidden flush listener, for teardown

  /**
   * Read the project this session opens with, BEFORE the desk is built — so
   * the app paints the right desktop once instead of painting a blank one and
   * swapping it out a moment later. Main decides WHICH project that is (the
   * unsaved one, the most recent, or a brand-new one), and answers with the
   * whole thing: every desktop's document is already in hand.
   *
   * @returns {Promise<{project: object, doc: object, warnings: string[]}|null>}
   *   null only when even creating a project failed — the app then runs on in
   *   a degraded state rather than showing nothing at all.
   */
  static async boot(bridge) {
    let raw = null;
    try {
      raw = await bridge?.project?.boot();
    } catch (err) {
      console.error("[renderer] project:boot failed:", err);
    }
    if (!raw?.tabs?.length) {
      try {
        raw = await bridge?.project?.create();
      } catch (err) {
        console.error("[renderer] project:new failed:", err);
        return null;
      }
    }
    const project = normalizeProject(raw);
    if (!project) return null;
    return {
      project,
      doc: activeDesktop(project).doc,
      warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
      // Main recovered a stash left by a session that did not finish, and hands
      // over the FACTS of it — `{name, path, homeless}`. It holds what the
      // project's file does not, so it must arrive UNSAVED: the • and the leave
      // guard are what let the user keep it or throw it away.
      restored: raw.restored ?? null,
    };
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
   *   desktop (or the project) changed: re-title and re-render.
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
    autoSaveMs = AUTO_SAVE_MS,
  }) {
    this.#bridge = bridge;
    this.#deskDoc = deskDoc;
    this.#controller = controller;
    this.#sim = sim;
    this.#tabsView = tabs;
    this.#getCamera = getCamera;
    this.#setCamera = setCamera;
    this.#onActiveChange = onActiveChange;
    this.#autoSaveMs = Number(autoSaveMs) > 0 ? Number(autoSaveMs) : 0;
    if (boot?.project) {
      this.#adopt(boot.project);
      if (boot.restored) {
        // A RESTORED project is unsaved by definition: it holds what its file
        // did not, which is why it was stashed. So it must read dirty — the •,
        // and the guard that stops it being thrown away a second time. Both
        // baselines are left null: the file is behind (hence dirty), and the
        // stash still matches, but saying so would need the file's own signature
        // and a null simply makes the first tick re-stash. Cheap and honest.
        this.#saved = null;
        this.#stashed = null;
      } else {
        // The desk already holds the booted desktop — app.js builds the DeskDoc
        // from `boot.doc` before there is a workspace to hand it to — so this is
        // the same "finished loading" moment `#swapProject` marks, reached from
        // the other end.
        this.#markClean();
      }
      this.#warn(boot.warnings);
      this.#notifyRestored(boot.restored);
    } else {
      this.#renderTabs();
    }
    this.#startAutoSave(); // after the baseline, so the first tick sees the truth
  }

  /**
   * Tell the user their unsaved work came back, in their own language.
   *
   * They have to be told, because the desk deliberately disagrees with the file
   * the title bar names — without a word for it the • is unexplainable. Its own
   * notice rather than `#warn`'s: that one is titled for desktops a migration
   * could not bring across, which this is the opposite of. The two cases differ
   * in what the way forward IS — a plain save, or a Save As, the project's own
   * file having gone.
   */
  #notifyRestored(restored) {
    if (!restored) return;
    PopupManager.notify({
      title: t("workspace.recoveredTitle"),
      message: restored.homeless
        ? t("workspace.recoveredHomeless", { path: restored.path })
        : t("workspace.recovered", { name: restored.name }),
    });
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

  /** The project file's path, or null while it lives in the working slot. */
  get projectLocation() {
    return this.#project?.location ?? null;
  }

  /**
   * Has this project never been given a home of its own? It is living in the
   * app's one working file, so starting or opening another replaces it —
   * which is why leaving is guarded.
   */
  get isUntitled() {
    return this.isOpen && !this.#project.location;
  }

  /** The active tab record `{id, name, description?, doc}`. */
  get activeTab() {
    return this.#project ? activeDesktop(this.#project) : null;
  }

  /**
   * THE dirty flag — the whole project against what its file holds: every
   * desktop's design, the desktops themselves, and their names. Which desktop
   * is on screen is deliberately not counted, and neither is the camera:
   * moving between tabs and panning are not changes to keep or throw away.
   */
  get dirty() {
    return this.isOpen && this.#signature() !== this.#saved;
  }

  /**
   * QUITTING (or closing the window): the same question changing projects
   * asks. Main waits on the answer, so this always settles.
   *
   * IT ALSO NEVER REJECTS, and that is a separate promise from settling. Main
   * waits on the reply with no timeout, and `app.js`'s handler cannot tell a
   * rejection from a refusal — it has one `ok` to send either way. So an
   * unexpected throw in here (the dirty test reads the live document, which is
   * a real thing that can fail) has to resolve to something, and the something
   * is FALSE: a guard that broke is not permission to throw the user's work
   * away. That costs a ⌘Q that appears to do nothing, which is recoverable —
   * main clears its latch on the reply, so the next one asks again — where
   * defaulting the other way costs the project.
   *
   * @returns {Promise<boolean>} whether it is safe to go.
   */
  confirmClose() {
    return this.#exclusive(async () => {
      const go = await this.#confirmLeaveProject({ quitting: true });
      if (!go) return false;
      // Going away for GOOD, and cleanly. Stop the timer first so nothing
      // writes behind a window on its way out, then throw away the stash — its
      // absence at the next launch is what says we finished properly. An
      // UNTITLED project keeps its slot: that is its home, not a stash of one.
      this.#stopAutoSave();
      if (!this.isUntitled) await this.#clearRecovery();
      return true;
    }).catch((err) => {
      // Loud, not quiet: a ⌘Q that silently declines is indistinguishable from
      // a wedged app, and the user needs to know to save by hand.
      this.#fail(t("workspace.failClose"), err);
      return false;
    });
  }

  /**
   * Run something that MUST NOT have a background write land inside it: the
   * leave/quit question, and the project swap behind it.
   *
   * The question can sit open indefinitely — the user is entitled to think about
   * it — and a stash arriving while it is out would preserve the very work they
   * are about to discard, into the slot the incoming project is about to claim.
   * "Discard" would stop being true, which is the one thing it has to be. The
   * swap is inside the window too: `#swapProject` awaits `#closeAuxWindows()`,
   * and the project on screen is being replaced across that await.
   */
  async #exclusive(run) {
    this.#busy = true;
    try {
      return await run();
    } finally {
      this.#busy = false;
    }
  }

  /** Freeze the destructive desktop affordances while the circuit runs — on
      the tab strip AND on the native Desktop menu, which must not offer what
      the strip forbids. */
  setEditingLocked(locked) {
    this.#locked = locked === true;
    this.#pushMenuState();
    this.#tabsView?.setEditingLocked(locked);
  }

  // ── The project: New / Open / Save / Save As ─────────────────────────────
  //
  // Every one of these is reached from the application's **File** menu
  // (main.js `buildAppMenu`) and from the toolbar's File pill, both of which
  // dispatch the same `chiphippo:project-*` event. The renderer owns the open
  // project, so main never does more than name the action.

  /**
   * New Project: a blank slate — no name, no location, ONE empty desktop,
   * living in the app's working file until it is saved somewhere real. No
   * dialog: a project is named by Save As, and never before. Whatever was open
   * is dealt with first (`#confirmLeaveProject`).
   */
  async newProject() {
    return this.#exclusive(async () => {
      if (!(await this.#confirmLeaveProject())) return;
      let raw;
      try {
        raw = await this.#bridge.project.create();
      } catch (err) {
        this.#fail(t("workspace.failStart"), err);
        return;
      }
      await this.#swapProject(raw);
    });
  }

  /** Open…: pick a `.chiphippo` project (or a loose design, which opens as a
      project of one desktop). */
  async loadProject() {
    return this.#exclusive(async () => {
      // The guard runs BEFORE the picker: opening a project takes over the
      // app's working slot, so nothing may be read until what is on screen has
      // been dealt with.
      if (!(await this.#confirmLeaveProject())) return;
      let raw;
      try {
        raw = await this.#bridge.project.open();
      } catch (err) {
        this.#fail(t("workspace.failOpen"), err);
        return;
      }
      if (!raw) return; // cancelled
      if (!raw.tabs?.length) {
        const err = new Error(t("workspace.noDesktops"));
        this.#fail(t("workspace.failOpen"), err);
        return;
      }
      await this.#swapProject(raw);
    });
  }

  /**
   * Open one of the recently used projects. Main only opens a path that is ON
   * its list, and a file that has since been moved or deleted comes back as
   * `missing` — the one moment the user can be sure the entry is dead.
   */
  async openRecentProject(filePath) {
    return this.#exclusive(async () => {
      if (!(await this.#confirmLeaveProject())) return;
      let res;
      try {
        res = await this.#bridge.project.openRecent(filePath);
      } catch (err) {
        this.#fail(t("workspace.failOpen"), err);
        return;
      }
      if (!res?.ok) {
        if (res?.code === "missing") return this.#offerForgetRecent(filePath);
        return PopupManager.notify({
          title: t("workspace.openFailTitle"),
          message: res?.error ?? t("workspace.unreadable"),
        });
      }
      await this.#swapProject(res.project);
    });
  }

  /**
   * The recent projects as a MENU — what the toolbar's Open button offers on a
   * secondary click, and the same list File ▸ Open Recent holds, since both
   * read main's one MRU (which is also the allowlist the open is checked
   * against).
   *
   * The list is asked for as the card opens rather than kept here: main
   * rewrites it on every save and every open, so anything remembered on this
   * side would be a second copy that could only fall behind.
   *
   * An EMPTY list still opens a card, carrying the disabled placeholder the
   * native submenu shows — a menu saying "nothing yet" is the answer to the
   * click, where a click that did nothing at all would read as a dead button.
   * Each row also carries the × `PopupManager` renders for an `onRemove`: an
   * entry whose project has been moved or deleted is otherwise only
   * discoverable by opening it, and dropping one is not a selection, so the
   * menu stays open.
   */
  async openRecentMenu(x = 0, y = 0) {
    let paths = [];
    try {
      paths = (await this.#bridge.project.recent.list()) ?? [];
    } catch (err) {
      console.error("[renderer] project:recent:list failed:", err);
    }
    PopupManager.menu({
      x,
      y,
      emptyLabel: t("menu.file.noRecent"),
      items: paths.map((filePath) => ({
        label: fileName(filePath),
        // The whole path is the only thing that tells two projects of the same
        // name apart; the row shows the file name alone, as the native submenu
        // does, and says where it lives on hover.
        title: filePath,
        onSelect: () => void this.openRecentProject(filePath),
        onRemove: () => void this.#forgetRecent(filePath),
      })),
    });
  }

  /**
   * Save: the whole project — every desktop, and every programmed ROM's bytes
   * — to the one file it lives in.
   *
   * A project that has never been given a home goes to the app's working file,
   * silently. That is the point of the working slot: designing something and
   * keeping it must never require choosing a file, and Save As is there for
   * when the user wants one.
   *
   * @returns {Promise<boolean>} whether it reached a file. A caller doing this
   *   on the user's behalf before something destructive must honour a `false`.
   */
  async save() {
    if (!this.isOpen) return false;
    return this.#writeProject(this.#project.location ?? null);
  }

  // ── Auto-save: the working slot's second job ──────────────────────────────
  //
  // THE USER'S FILE IS WRITTEN ONLY WHEN THEY ASK. Every AUTO_SAVE_MS the open
  // project is stashed in the app's own working slot instead, so all three of
  // these keep working at once: a crash costs at most half a minute, the • still
  // means "not in your file", and "close without saving" is still a revert. It
  // is the one place the two questions — "is my work safe?" and "have I
  // committed to it?" — get different answers, which is what they deserve.
  //
  // The slot therefore means one of two things, and the stamp is the difference:
  //   · UNSTAMPED — an untitled project's actual home, as it always was. For it,
  //     a stash IS a save, so the tick goes through `#writeProject` and the •
  //     clears. There is no file for it to be pending against.
  //   · STAMPED with `recoveryFor` — a copy of a project that has a file,
  //     holding work that file does not have. Dropped by a save and by a clean
  //     quit, so finding one at startup means the last session did not finish.
  //     That is the whole crash detector: no timestamps, which are the one thing
  //     cloud sync and a corrected clock will both lie about.
  //
  // TWO BASELINES follow from that. `#saved` is the project as its FILE holds it
  // and drives the •; `#stashed` is the project as the SLOT holds it and is what
  // the tick compares against. They are the same after any save, and they part
  // company the moment a stash gets ahead of the file — which for a titled
  // project is the normal state of affairs, and is exactly why the tick cannot
  // just watch `dirty`: that stays true from the first edit until ⌘S, so a
  // dirty-driven tick would rewrite the same bytes every 30 s forever.
  //
  // What it does NOT do is listen for `chiphippo:doc-changed`. That event is
  // wrong in both directions: `#setTabProperty` and `#setProjectProperty` never
  // dispatch it, so renaming a desktop or the project would never be stashed;
  // and it fires on load and on every undo/redo restore, where there is nothing
  // to write. A signature comparison is already right on all of those paths, and
  // costs ~0.3 ms on a real 8-desktop design.

  /** Begin the cadence. Idempotent; a no-op when `autoSaveMs` is 0. */
  #startAutoSave() {
    if (this.#autoTimer || this.#autoSaveMs <= 0) return;
    this.#autoStopped = false;
    this.#autoTimer = setInterval(() => void this.autoSaveNow(), this.#autoSaveMs); // prettier-ignore
    // In the renderer this is a number and `unref` does not exist — hence the
    // `?.`. Under `node --test` it is a real Timeout that would hold the event
    // loop open, and every test constructing a workspace would leak one.
    this.#autoTimer.unref?.();
    // Switching away is the cheapest moment to be safe: the user is done for
    // now, nothing is mid-gesture, and the alternative is leaving up to a whole
    // interval unprotected while the machine does something else.
    this.#onHide = () => {
      if (document.visibilityState === "hidden") void this.autoSaveNow();
    };
    document.addEventListener("visibilitychange", this.#onHide);
  }

  /**
   * Stop for good. This is a STATE, not merely an absent timer: `autoSaveNow` is
   * public, so "the app has agreed to close" has to be answerable by anything
   * that calls in, not only by the interval that no longer fires.
   */
  #stopAutoSave() {
    if (this.#autoTimer) clearInterval(this.#autoTimer);
    this.#autoTimer = null;
    this.#autoStopped = true;
    if (this.#onHide) {
      document.removeEventListener("visibilitychange", this.#onHide);
      this.#onHide = null;
    }
  }

  /**
   * One auto-save tick. Public so tests can drive the decision without a timer.
   *
   * @returns {Promise<boolean>} whether it wrote.
   */
  async autoSaveNow() {
    if (!this.isOpen) return false;
    if (this.#autoStopped) return false; // the window is on its way out
    if (this.#autoSaveFailed) return false; // retired; ⌘S is the way back
    if (this.#busy) return false; // a leave/quit question is out
    if (this.#inFlight) return false; // a write is already going; let it
    if (!(this.#stale || this.#imagesTouched)) return false;
    // Cleared BEFORE the write, so a ROM saved while it is in flight re-sets the
    // flag and the next tick carries the newer bytes. Clearing it after would
    // swallow that write until something else changed the document.
    this.#imagesTouched = false;
    const ok = this.isUntitled
      ? await this.#writeProject(null, { quiet: true })
      : await this.#writeRecovery({ quiet: true });
    // A failure here is not the user's doing and they never asked for the write,
    // so it cannot open a dialog — and it must not come back every
    // AUTO_SAVE_MS either. It retires instead, leaving the • standing as the
    // only honest signal that the work is not in the file.
    if (!ok) this.#autoSaveFailed = true;
    return ok;
  }

  /** Is the project different from what the RECOVERY SLOT holds? */
  get #stale() {
    return this.#signature() !== this.#stashed;
  }

  /**
   * A memory chip's BYTES changed, though the document may not have. Called
   * from MemoryBridge after a successful programmer load or inspector save.
   *
   * `params.programmed` is already `true` on a chip being re-saved, so the
   * document comes out byte-identical while the bytes the file has to carry are
   * new. Without this the edit would sit only in the userData cache, and the
   * next open would overwrite it with the stale copy the file still held.
   */
  markImagesChanged() {
    this.#imagesTouched = true;
  }

  /**
   * Save As…: the same whole-project save, but ALWAYS to a new file — and the
   * moment an untitled project gets both a home and a NAME, taken from the
   * file the user picked. Moving out of the app's working file empties that
   * slot (main deletes it), which is what makes the next launch open THIS
   * project rather than the blank one that used to live there.
   *
   * @returns {Promise<boolean>} whether the project reached the new file.
   */
  async saveAs() {
    if (!this.isOpen) return false;
    const current = this.#project.location;
    const chosen = await this.#pickLocation(
      "project",
      this.#project.name || t("common.untitled"),
      current,
    );
    if (!chosen) return false; // cancelled
    if (!this.#project.name) {
      this.#project = { ...this.#project, name: nameFromPath(chosen) };
    }
    // The slot is emptied by main on any save to a real path, so a project
    // moving out of it — and a recovery copy standing for one — both go with
    // this one write, which is why there is no `dropDefault` to pass any more.
    return this.#writeProject(chosen);
  }

  /**
   * Properties… for the PROJECT: the same shared dialog every part, board, and
   * desktop opens — the universal Name/Description pair, plus the read-only
   * Location of the file it is kept in (blank while it lives in the working
   * slot, since that file was never meant to be seen).
   */
  editProjectProperties() {
    if (!this.isOpen) return;
    PartPropertiesDialog.open({
      title: t("workspace.projectProperties"),
      fields: [locationField()],
      values: {
        name: this.#project.name,
        description: this.#project.description,
        location: this.#project.location ?? "",
      },
      onChange: (key, value) => this.#setProjectProperty(key, value),
    });
  }

  /** Apply one Properties-dialog field change to the project itself. */
  #setProjectProperty(key, value) {
    if (!this.isOpen) return;
    const next = setProjectField(this.#project, key, value);
    if (!next) return; // unchanged, or the read-only Location
    this.#project = next;
    this.#announce();
  }

  // ── Desktops ────────────────────────────────────────────────────────────

  /** Add a desktop: the next "Desktop N", empty, and land on it. */
  async addTab() {
    if (!this.#project) return;
    this.#stash();
    await this.#leaveActiveDesk();
    this.#project = addDesktop(this.#project, canonical(emptyDocument())).meta;
    this.#loadActive();
    this.#renderTabs();
    this.#announce();
  }

  /** Put another desktop on the desk. */
  async selectTab(id) {
    if (!this.#project || id === this.#project.activeTab) return;
    if (!findDesktop(this.#project, id)) return;
    this.#stash(); // the desk being left, exactly as it stands
    await this.#leaveActiveDesk();
    this.#project = setActiveDesktop(this.#project, id);
    this.#loadActive();
    this.#renderTabs();
    this.#announce();
  }

  /**
   * Copy a desktop, landing the copy right after it. Main reseats every memory
   * chip onto a fresh GUID and a fresh backing file, so the copy can never
   * share bytes with the original.
   */
  async duplicateTab(id) {
    const tab = this.#project ? findDesktop(this.#project, id) : null;
    if (!tab) return;
    this.#stash(); // so duplicating the ACTIVE desktop copies what is on screen
    let res;
    try {
      res = await this.#bridge.desktop.duplicate(
        findDesktop(this.#project, id).doc,
      );
    } catch (err) {
      this.#fail(t("workspace.failDuplicate"), err);
      return;
    }
    const next = duplicateDesktop(this.#project, id, canonical(res?.doc));
    if (!next) return;
    await this.#leaveActiveDesk();
    this.#project = next.meta;
    this.#loadActive();
    this.#renderTabs();
    this.#announce();
  }

  /**
   * Import Desktop…: read a `.desktop.chiphippo` snapshot (or a loose design)
   * as a NEW desktop. Always an addition — no file operation can replace the
   * desk you are looking at.
   */
  async importTab() {
    if (!this.#project) return;
    let res;
    try {
      res = await this.#bridge.desktop.import();
    } catch (err) {
      this.#fail(t("workspace.failImport"), err);
      return;
    }
    if (!res) return; // cancelled
    this.#stash();
    const next = importDesktop(this.#project, {
      name: res.name,
      description: res.description,
      doc: canonical(res.doc),
    });
    await this.#leaveActiveDesk();
    this.#project = next.meta;
    this.#loadActive();
    this.#renderTabs();
    this.#announce();
  }

  /**
   * Put a part's EXAMPLE CIRCUIT on the desk as a desktop of its own — the
   * demonstration bench `make demos` builds for every benchable 74xx part,
   * asked for from that part's pin-assignments window (which has a ref and
   * nothing else, so the request reaches here through main).
   *
   * It arrives the way an IMPORT does — an addition, landing on the new desk,
   * with its ROM guids reseated — with ONE difference: an example is a fixed,
   * named thing rather than a file the user chose, so asking for the same one
   * twice does not make a second copy; the desktop already holding it is put
   * back on the desk instead. The NAME is the whole identity test, which is
   * also its cost: rename the tab and the next ask brings a fresh one. That is
   * the honest answer, since the project schema keeps no per-tab marker a
   * rename could not erase.
   *
   * The caller FRAMES it (app.js's `fitActiveView`), because framing follows
   * the active view and the workspace has no opinion about which one is on
   * screen. Which is also why the answer is three-valued: framing a brand-new
   * desk is help, and re-framing one the user has already arranged is not.
   *
   * @param {string} ref - a catalog id ("74LS00").
   * @returns {Promise<"added"|"switched"|null>} null when it could not (already
   *   reported to the user).
   */
  openExample(ref) {
    if (!this.#project || typeof ref !== "string" || !ref) {
      return Promise.resolve(null);
    }
    // A double-click on the pinout window's button is TWO relays, and both
    // calls would look for an existing tab before either had added one. So the
    // second joins the first rather than racing it — the check and the insert
    // are separated by awaits, which is exactly where a duplicate gets in.
    const inFlight = this.#examples.get(ref);
    if (inFlight) return inFlight;
    const run = this.#addExample(ref).finally(() => this.#examples.delete(ref));
    this.#examples.set(ref, run);
    return run;
  }

  async #addExample(ref) {
    const name = `${ref} example`;
    const open = this.#project.tabs.find((tab) => tab.name === name);
    if (open) {
      await this.selectTab(open.id); // a no-op when it is already on the desk
      return "switched";
    }
    const failed = (err) => {
      this.#fail(t("workspace.failExample", { ref }), err);
      return null;
    };
    let demo;
    try {
      demo = await this.#bridge.demo?.read?.(ref);
    } catch (err) {
      return failed(err);
    }
    if (!demo?.doc) {
      return failed(new Error("no example circuit is bundled for that part"));
    }
    // A COPIED desktop is reseated, with no exception. No shipped example
    // carries a memory chip today (the Memory, Interface and PROCESSOR groups
    // have no bench), but "two chips can never share a ROM guid" is a rule
    // that must not have a door in it — opening the same example twice would
    // walk straight through one.
    let doc;
    try {
      doc = (await this.#bridge.desktop.duplicate(demo.doc))?.doc;
    } catch (err) {
      return failed(err);
    }
    if (!doc) return failed(new Error("the example could not be prepared"));
    this.#stash();
    const next = importDesktop(this.#project, {
      name,
      description: demo.title ?? "",
      doc: canonical(doc),
    });
    await this.#leaveActiveDesk();
    this.#project = next.meta;
    this.#loadActive();
    this.#renderTabs();
    this.#announce();
    return "added";
  }

  /**
   * Export Desktop…: write one desktop out as a self-contained snapshot — its
   * design and every programmed ROM's bytes — with no link retained. A copy
   * cannot dangle, which is exactly why this replaced a desktop's own Save As.
   *
   * @returns {Promise<boolean>} whether a file was written.
   */
  async exportTab(id) {
    const tab = this.#project ? findDesktop(this.#project, id) : null;
    if (!tab) return false;
    const doc =
      id === this.#project.activeTab ? this.#deskDoc.toJSON() : tab.doc;
    try {
      const res = await this.#bridge.desktop.export({
        name: tab.name,
        description: tab.description ?? "",
        doc,
      });
      return res != null; // null is a cancelled dialog, not a failure
    } catch (err) {
      this.#fail(t("workspace.failExport"), err);
      return false;
    }
  }

  /**
   * Properties… on a tab: the SAME shared dialog every part, board, and the
   * project itself opens. A desktop has just the universal Name/Description
   * pair — it is no longer a file, so there is no Location to show.
   */
  editTabProperties(id) {
    const tab = this.#project ? findDesktop(this.#project, id) : null;
    if (!tab) return;
    PartPropertiesDialog.open({
      title: t("workspace.desktopProperties"),
      values: { name: tab.name, description: tab.description },
      onChange: (key, value) => this.#setTabProperty(id, key, value),
    });
  }

  /**
   * Apply one Properties-dialog field change to a tab. The dialog applies live
   * (one change per control, on blur/Enter), so each field commits on its own.
   */
  #setTabProperty(id, key, value) {
    const next = setDesktopField(this.#project, id, key, value);
    if (!next) return; // unchanged, or a name that would blank the tab
    this.#project = next;
    this.#renderTabs();
    this.#announce();
  }

  /**
   * Delete a desktop. Any of them can go, EXCEPT the last one — a project with
   * no desktops has nothing to open.
   *
   * There is no save-or-lose question any more: the desktop is not a file, so
   * deleting it writes nothing. It is an unsaved change like any other, and
   * closing the project without saving brings it back.
   */
  async deleteTab(id) {
    const tab = this.#project ? findDesktop(this.#project, id) : null;
    if (!tab || this.#project.tabs.length <= 1) return;
    PopupManager.confirm({
      title: t("workspace.deleteTabTitle", { name: tab.name }),
      message: t("workspace.deleteTabMessage"),
      confirmLabel: t("common.delete"),
      confirmClass: "btn--danger",
      onConfirm: () => void this.#doDeleteTab(id),
    });
  }

  async #doDeleteTab(id) {
    if (!this.#project) return;
    const wasActive = this.#project.activeTab === id;
    this.#stash(); // whatever is on screen belongs to the ACTIVE desktop
    const next = removeDesktop(this.#project, id);
    if (!next) return;
    if (wasActive) await this.#leaveActiveDesk();
    this.#project = next;
    this.#state.delete(id);
    if (wasActive) this.#loadActive();
    this.#renderTabs();
    this.#announce();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * Take a project as the open one, from scratch: canonicalize every desktop's
   * document (so the dirty test is a plain string comparison), make it the
   * baseline, and start each tab's session state over.
   *
   * @returns {boolean} whether there was a project in it.
   */
  #adopt(raw) {
    const meta = normalizeProject(raw);
    if (!meta) return false;
    this.#project = {
      ...meta,
      tabs: meta.tabs.map((tab) => ({ ...tab, doc: canonical(tab.doc) })),
    };
    // It came from its file, so it IS its file — the baseline every later
    // change is measured against. Taken here as well as after the load (see
    // `#markClean`) so nothing in between — the doc-changed the load itself
    // fires — can read `dirty` against the OUTGOING project's baseline and
    // flash a • the user never earned.
    this.#saved = projectSignature(this.#project);
    this.#state.clear();
    this.#renderTabs();
    return true;
  }

  /**
   * A JUST-LOADED project is CLEAN, by construction: whatever the desk made of
   * the document on the way in becomes the baseline, so the • can only ever
   * stand for an edit the user made.
   *
   * The distinction from `#adopt`'s own baseline is which side is authoritative.
   * `#adopt` measures the project meta, because that is all there is until the
   * document reaches the desk; from then on the DESK holds the active desktop
   * and the dirty test reads it (`#liveMeta`), so the baseline has to be re-taken
   * from there. Anything the load normalizes that the stored copy spelled
   * differently is then part of the file as the app understands it — not an
   * unsaved change nobody made, sitting in front of the next New or Open as a
   * save-or-discard question about a project the user has not touched.
   */
  #markClean() {
    if (!this.#project) return;
    this.#saved = this.#signature();
    this.#stashed = this.#saved; // nothing pending, so nothing to re-stash
  }

  /** Put a just-opened/just-created project on the desk. */
  async #swapProject(raw) {
    this.#sim?.stop?.();
    await this.#closeAuxWindows();
    if (!this.#adopt(raw)) {
      this.#fail(t("workspace.failOpen"), new Error(t("workspace.noDesktops")));
      return;
    }
    this.#loadActive();
    this.#markClean(); // it is its file, exactly as the desk now holds it
    this.#announce();
    this.#warn(raw?.warnings);
  }

  /**
   * The live desk folded back into the project. The ACTIVE desktop's document
   * lives in the shared DeskDoc, so anything that needs the WHOLE project — a
   * save, the dirty test, a switch, an export — calls this first.
   */
  #stash() {
    if (!this.#project) return;
    const id = this.#project.activeTab;
    this.#project = setDesktopDoc(this.#project, id, this.#deskDoc.toJSON());
    const state = this.#state.get(id);
    if (state) state.camera = this.#getCamera?.() ?? state.camera;
  }

  /** The project as its file would hold it right now (live desk included). */
  #liveMeta() {
    return setDesktopDoc(
      this.#project,
      this.#project.activeTab,
      this.#deskDoc.toJSON(),
    );
  }

  /** The dirty test's left-hand side. */
  #signature() {
    return projectSignature(this.#liveMeta());
  }

  /**
   * Is there NOTHING in this project — the state a brand-new one is in until
   * the user does something with it? No name, no description, one desktop, an
   * empty desk, and nothing unsaved.
   *
   * This is the untitled guard's one exception, and it is deliberately the
   * whole project rather than the desk alone: a design, a second desktop, or a
   * project name are all things the working slot would be holding FOR the
   * user. Both halves are needed — an unsaved change is caught by `dirty`, and
   * one already ⌘S'd into the slot (which is not dirty at all) by the project
   * still having something in it.
   */
  #isPristine() {
    const meta = this.#project;
    if (!meta || meta.name || meta.description) return false;
    if (meta.tabs.length !== 1) return false;
    if (this.dirty) return false;
    return isEmptyDocument(this.#deskDoc.toJSON());
  }

  /**
   * Leaving the desk that is on screen: the simulation is run-volatile and
   * never crosses documents, and an open pinout or memory inspector would be
   * left pointing at a chip that is no longer there.
   */
  async #leaveActiveDesk() {
    this.#sim?.stop?.();
    await this.#closeAuxWindows();
  }

  /** Put the active desktop's document on the desk, with its own history. */
  #loadActive() {
    const id = this.#project.activeTab;
    let state = this.#state.get(id);
    if (!state) {
      state = { history: new HistoryStore(), camera: null };
      this.#state.set(id, state);
    }
    this.#controller.loadDocument(findDesktop(this.#project, id).doc, {
      history: state.history,
    });
    if (state.camera) this.#setCamera?.(state.camera);
  }

  /**
   * Write the project file and make it the new baseline.
   *
   * WRITES ARE SERIALIZED, and a queued one takes its OWN snapshot when its turn
   * comes rather than joining the one ahead of it — the later caller's bytes are
   * the newer ones. (This is why it differs from `openExample`'s in-flight map,
   * which joins: two clicks there want ONE desktop, whereas two writes want the
   * SECOND state on disk.) It matters because a background stash can now be in
   * flight when ⌘S arrives, and `#askUnsaved` reads a `false` as a cancel — so a
   * manual save must never fail merely for being second.
   *
   * @param {string|null} location - null means the app's working file.
   * @param {object} [opts]
   * @param {boolean} [opts.quiet] - report a failure to the console only.
   * @returns {Promise<boolean>} whether it reached a file.
   */
  #writeProject(location, opts = {}) {
    return this.#serialize(() => this.#doWrite(location, opts));
  }

  /**
   * Stash the open project in the recovery slot, leaving its own file alone.
   *
   * Only for a project that HAS a file: an untitled one lives in that same slot,
   * so for it a stash and a save are the same write and `#writeProject` is the
   * one to use (which is what makes the • clear for an untitled project and stay
   * for a titled one — the slot really is the untitled project's file).
   *
   * @returns {Promise<boolean>} whether it reached the slot.
   */
  #writeRecovery({ quiet = false } = {}) {
    return this.#serialize(async () => {
      // The WHOLE body is inside the try, `#stash()` and `projectForFile()`
      // included — see `#doWrite` for why "a write answers, it doesn't throw"
      // has to be enforced rather than assumed.
      try {
        this.#stash();
        const written = projectForFile(this.#project);
        await this.#bridge.project.recovery.write(
          written,
          this.#project.location,
        );
        // `#saved` is deliberately untouched: the project's own FILE has not
        // changed, so the • stands and "discard" is still the truth.
        this.#stashed = projectSignature(written);
        return true;
      } catch (err) {
        this.#fail(t("workspace.failSave"), err, { quiet });
        return false;
      }
    });
  }

  /** Throw away the stash — its project's file now holds everything. */
  async #clearRecovery() {
    try {
      await this.#bridge.project?.recovery?.clear?.();
    } catch (err) {
      console.error("[renderer] project:recovery:clear failed:", err);
    }
  }

  /** Run `task` after any write already going, and never concurrently with one. */
  #serialize(task) {
    const prior = this.#inFlight;
    const run = (async () => {
      // A write ANSWERS — it resolves false rather than throwing (see
      // `#doWrite`). The `.catch` is the belt to that brace: were one ever to
      // reject, awaiting it bare here would reject THIS call too, and every
      // later one queued behind it, turning one failed write into a chain of
      // rejected promises — the shape that left the close guard pending.
      // A failed predecessor is also no reason to refuse a fresh save: each
      // task takes its own snapshot when its turn comes.
      if (prior) await prior.catch(() => {});
      return task();
    })();
    this.#inFlight = run;
    const clear = () => {
      if (this.#inFlight === run) this.#inFlight = null;
    };
    run.then(clear, clear); // observed here, so the bookkeeping can't go unhandled
    return run;
  }

  /**
   * One write to the project's file, start to finish.
   *
   * THE BASELINE IS THE BYTES THAT WENT, not `#project` as it stands when the
   * write comes back. The two differ whenever an edit lands during the await,
   * and only one of them is safe: signing `#project` afterwards would fold that
   * edit into the baseline without ever having written it — the • would clear,
   * the leave/quit guard would stop asking, and the edit would be gone. A DESK
   * edit survived that anyway, because the dirty test re-reads the live
   * `DeskDoc` (`#liveMeta`); a META edit did not, because every one of them
   * (`addTab`, `#doDeleteTab`, `importTab`, `duplicateTab`, `#setTabProperty`,
   * `#setProjectProperty`) REASSIGNS `#project`. So the snapshot is taken once,
   * written, and signed — and anything that arrived while it was in flight stays
   * dirty, which is exactly what the next write is for.
   *
   * A WRITE ANSWERS; IT DOES NOT THROW. Every caller reads a `false` as "it did
   * not land" and acts on that — `#askUnsaved` treats it as a cancel, the
   * auto-save tick retires on it. A REJECTION means none of them hear anything:
   * it propagates out through `#serialize` into whatever was awaiting, and the
   * close guard's promise is left pending for good. So the whole body sits in
   * the try, `#stash()` and `projectForFile()` included — they are plain data
   * work today, which is exactly the kind of "it cannot throw" that stops being
   * true one refactor later.
   */
  async #doWrite(location, { quiet = false } = {}) {
    try {
      this.#stash(); // the file gets what is on screen, not the last stash
      const written = projectForFile(this.#project);
      const res = await this.#bridge.project.save(written, location);
      if (location) this.#project.location = res?.path ?? location;
      // Both baselines: the file now holds this, and main dropped any stash
      // that was standing for it — nothing for the next tick to catch up.
      this.#saved = projectSignature(written);
      this.#stashed = this.#saved;
      this.#announce();
      return true;
    } catch (err) {
      this.#fail(t("workspace.failSave"), err, { quiet });
      return false;
    }
  }

  /** Push the current desktops onto the strip — and, with them, what the
      native Desktop menu may offer (the tab set is half of that answer). */
  #renderTabs() {
    this.#tabsView?.setTabs(
      this.#project?.tabs ?? [],
      this.#project?.activeTab ?? null,
    );
    this.#pushMenuState();
  }

  /**
   * Tell main which Desktop-menu items apply, so the menu bar and the tab
   * strip can never disagree: Delete is off on the last remaining desktop (a
   * project cannot run out of them) and both are off while the circuit runs.
   * The conditions are the strip's own, stated once here and mirrored there.
   */
  #pushMenuState() {
    const count = this.#project?.tabs.length ?? 0;
    Promise.resolve(
      this.#bridge?.menu?.setDesktopState?.({
        canDelete: count > 1 && !this.#locked,
        canDuplicate: count > 0 && !this.#locked,
      }),
    ).catch((err) =>
      console.error("[renderer] menu:desktop-state failed:", err),
    );
  }

  #forgetRecent(filePath) {
    return Promise.resolve(this.#bridge.project.recent.remove(filePath)).catch(
      (err) => console.error("[renderer] project:recent:remove failed:", err),
    );
  }

  #offerForgetRecent(filePath) {
    PopupManager.confirm({
      title: t("workspace.missingTitle"),
      message: t("workspace.missingMessage", { name: fileName(filePath) }),
      note: filePath,
      confirmLabel: t("desk.remove.confirm"),
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
   * Ask WHERE to keep a project (or where to export a desktop). The native
   * save dialog is the whole of it — including the "that file already exists,
   * replace it?" question, which every platform's own save panel asks in its
   * own way. There is deliberately no prompt of ours on top: it would be the
   * second time the user was asked the same thing.
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
      this.#fail(t("workspace.failLocation"), err);
      return null;
    }
  }

  /**
   * CHANGING PROJECTS — or QUITTING: what is unsaved must be saved, discarded,
   * or the whole thing called off.
   *
   * QUITTING is the simple case, and the rule for it is: the user did not
   * click a Save button, so nothing is asked beyond the question itself — the
   * project goes to the file it already has, or to the app's working file,
   * which is where the next launch will look for it.
   *
   * CHANGING PROJECTS differs in exactly one way, and it is the reason an
   * UNTITLED project that HOLDS SOMETHING is asked about whether or not it is
   * dirty. It lives in the app's one working file, the project taking its place
   * is about to claim that file, and there is nowhere else for it to go:
   * replacing it is destructive whether or not anything is "unsaved" in the
   * ordinary sense, and a ⌘S into the slot does not make it any less so. That
   * is also why "Save" here means Save As, a home of its own.
   *
   * The exception is the state the app BOOTS INTO: a brand-new project holds
   * nothing at all, so there is nothing for the incoming one to destroy
   * (`#isPristine`). Asking about it would put a save-or-discard question in
   * front of the very first thing a session does — New Project, or Open… —
   * over a blank desk nobody has touched.
   *
   * A SAVED project is the ordinary case: it has a file of its own that nothing
   * is claiming, so it is asked about only when it is dirty.
   *
   * @param {{quitting?: boolean}} [opts]
   * @returns {Promise<boolean>} whether to proceed.
   */
  #confirmLeaveProject({ quitting = false } = {}) {
    if (!this.#project) return Promise.resolve(true);
    if (this.isUntitled && !quitting && !this.#isPristine()) {
      return this.#askUnsaved({
        title: t("workspace.untitledTitle"),
        message: t("workspace.untitledMessage"),
        save: () => this.saveAs(),
      });
    }
    if (!this.dirty) return Promise.resolve(true);
    const what = this.projectName
      ? `"${this.projectName}"`
      : t("workspace.thisProject");
    return this.#askUnsaved({
      title: t("workspace.dirtyTitle"),
      message: quitting
        ? t("workspace.dirtyQuitting", { what })
        : t("workspace.dirtyLeaving", { what }),
      save: () => this.save(),
    });
  }

  /**
   * The one save-or-discard-or-cancel question, in its wordings.
   *
   * THIS PROMISE MUST SETTLE, ALWAYS. `confirmClose()` is awaited by main
   * through `app:confirm-close`, which has no timeout by design — the user may
   * sit on this dialog as long as they like — so a promise that never settles
   * is not a slow answer, it is an app that can never be closed again (main
   * latches `closePending` until the reply arrives). The dangling path was real:
   * `PopupManager` fires `onChoose` and DISCARDS what it returns, so an async
   * callback that rejected — a `save()` that threw rather than answering false —
   * skipped `resolve` entirely and left this pending for the life of the
   * process. Hence the explicit catch: a question that broke resolves FALSE,
   * which cancels the close. Never true — a guard that failed is not permission
   * to throw the user's work away.
   */
  #askUnsaved({ title, message, save }) {
    return new Promise((resolve) => {
      PopupManager.choose({
        title,
        message,
        choices: [
          { label: t("common.save"), value: "save" },
          { label: t("workspace.discard"), value: "discard", class: "btn--danger" }, // prettier-ignore
        ],
        onChoose: (answer) =>
          (async () => {
            if (answer == null) return resolve(false); // cancelled
            // A save that never landed IS a cancel: the work is still only on
            // screen, so the action that got here is called off.
            if (answer === "save" && !(await save())) return resolve(false);
            resolve(true);
          })().catch((err) => {
            this.#fail(t("workspace.failSave"), err, { quiet: true });
            resolve(false);
          }),
      });
    });
  }

  /** Surface what opening a project could not bring across (a v3 desktop file
      that has gone missing, above all) — one notice, listing every one. */
  #warn(warnings) {
    if (!Array.isArray(warnings) || warnings.length === 0) return;
    PopupManager.notify({
      title: t("workspace.restoreWarnTitle"),
      message: warnings.join("\n"),
    });
  }

  #announce() {
    this.#onActiveChange?.(this.activeTab);
  }

  /**
   * Report a failure. `quiet` keeps the console line and drops the modal — for a
   * write nobody asked for, where a dialog would be the first the user hears of
   * a feature meant to be invisible, and would come back every AUTO_SAVE_MS.
   */
  #fail(title, err, { quiet = false } = {}) {
    console.error(`[renderer] ${title}:`, err);
    if (quiet) return;
    PopupManager.notify({ title, message: err?.message ?? String(err) });
  }
}
