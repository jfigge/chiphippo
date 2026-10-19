/*
 * Copyright 2026 Jason Figge
 *
 * This file is part of Chip Hippo.
 *
 * Chip Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * Chip Hippo is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Chip Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

// tutorial-controller.js — the guided tutorials, end to end: the Tutorials
// menu (the header's book), the first-run welcome, the tutorial's own
// desktop, and the player + overlay that run on it.
//
// EVERY TUTORIAL RUNS ON A DESKTOP OF ITS OWN. Starting one adds a tab named
// for it and lands there (`ProjectWorkspace.addTutorialTab`), so nothing a
// tutorial does can touch a desktop the user made. When it ends — completed
// or exited — the user is asked: keep the desktop (it becomes an ordinary
// one), or close it and go back to where they were. While it plays the tab
// is held out of the auto-save: it is not the user's work until they keep it.
// Should the tutorial's desktop stop being the one on screen some other way
// (⌘N or Open from the native menu, whose accelerators the overlay cannot
// intercept), the tour simply stops, with nothing to ask.
//
// THE FAKE CURSOR DRIVES THE APP'S OWN HANDLERS. A click is the target
// element's own `click()` — the very listener the user's click runs. A drag
// from the parts tray is what the user's is in this app: the click that picks
// the part up (the tray row's handler arms the placement ghost), then the
// desk tracking the pointer and the click that puts it down, reached through
// `DeskController.trackPlacementAt` / `dropPlacementAt` — the bodies of the
// desk's own pointermove and click handlers. So a breadboard a tutorial
// places is placed exactly as one the user places: same checks, same snap,
// same undo step.
//
// ONE GLOBAL FLAG, `settings.tutorials.autoShowDismissed`: set by the
// welcome's "Don't show tutorials automatically again", or by finishing the
// auto-shown tutorial. Only that tutorial is ever offered unasked; the book
// works whatever the flag says.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import {
  AUTO_SHOW_TUTORIAL,
  TUTORIALS,
  tutorialById,
} from "../tutorials/definitions.js";
import { TutorialPlayer } from "../tutorials/player.js";
import { resolveTarget, targetRect } from "../tutorials/targets.js";
import { TutorialOverlay } from "./tutorial-overlay.js";

/** Has the user opted out of — or already seen — the first-run tour? */
export function autoShowDismissed(settings) {
  return settings?.tutorials?.autoShowDismissed === true;
}

/** The app's animation clock: wall time and one promise per frame. A hidden
    window gets no frames, so a tour left playing behind another app waits
    for it rather than running on unseen. */
const FRAME_CLOCK = {
  now: () => performance.now(),
  frame: () => new Promise((resolve) => requestAnimationFrame(resolve)),
};

export class TutorialController {
  #getWorkspace;
  #getDesk;
  #getSettings;
  #setSettings;
  #prepare;
  #mod;
  #clock;
  #log;
  #run = null; // the tutorial in progress: { tutorial, tabId, player, aborted }

  /**
   * @param {object} opts
   * @param {() => object|null} opts.getWorkspace - the ProjectWorkspace.
   * @param {() => object|null} opts.getDesk - the DeskController.
   * @param {() => object} opts.getSettings - the live settings.
   * @param {(patch: object) => void} opts.setSettings - persist + apply.
   * @param {() => void} [opts.prepare] - put the app in the state a tutorial
   *   expects before it starts (the breadboard view, not the schematic).
   * @param {string} [opts.mod] - "⌘" or "Ctrl", for callout text.
   * @param {object} [opts.clock] - the animation clock (tests pass a fake).
   * @param {{warn: Function}} [opts.log] - where a step that cannot find its
   *   target says so.
   */
  constructor({
    getWorkspace,
    getDesk,
    getSettings,
    setSettings,
    prepare = null,
    mod = "Ctrl",
    clock = FRAME_CLOCK,
    log = console,
  }) {
    this.#getWorkspace = getWorkspace;
    this.#getDesk = getDesk;
    this.#getSettings = getSettings;
    this.#setSettings = setSettings;
    this.#prepare = prepare;
    this.#mod = mod;
    this.#clock = clock;
    this.#log = log;
  }

  /** Is a tutorial playing (or starting) right now? */
  get playing() {
    return this.#run != null;
  }

  // ── The menu (the header's book) ──────────────────────────────────────────

  /** The Tutorials menu: every tutorial, in order, title over description. */
  openMenu() {
    if (this.#run) return;
    const items = TUTORIALS.map((tutorial) =>
      el(
        "button",
        {
          class: "tutorial-menu-item",
          type: "button",
          dataset: { tutorial: tutorial.id },
          onClick: () => {
            PopupManager.close();
            void this.start(tutorial.id);
          },
        },
        [
          el("span", { class: "tutorial-menu-title", text: t(tutorial.title) }),
          el("span", {
            class: "tutorial-menu-desc",
            text: t(tutorial.description),
          }),
        ],
      ),
    );
    PopupManager.dialog({
      title: t("tutorials.menu.title"),
      className: "tutorial-menu-popup",
      body: [
        el("p", {
          class: "tutorial-menu-intro",
          text: t("tutorials.menu.intro"),
        }),
        el("div", { class: "tutorial-menu-list", role: "list" }, items),
      ],
    });
  }

  // ── The first-run welcome ─────────────────────────────────────────────────

  /**
   * At launch: offer the tour unless the user has seen it or opted out.
   * "Yes, show me" starts it, "Not now" (and Escape) leaves the offer for
   * next launch — and the checkbox sets the opt-out whichever way out is
   * taken.
   * @returns {boolean} whether the welcome was offered.
   */
  offerWelcome() {
    if (autoShowDismissed(this.#getSettings())) return false;
    const optOut = el("input", {
      type: "checkbox",
      class: "tutorial-welcome-optout-box",
    });
    const answer = (start) => () => {
      PopupManager.close();
      if (optOut.checked) this.#dismissAutoShow();
      if (start) void this.start(AUTO_SHOW_TUTORIAL);
    };
    const element = el(
      "div",
      {
        class: "popup popup-confirm tutorial-welcome",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": t("tutorials.welcome.title"),
      },
      [
        el("div", { class: "popup-header" }, [
          el("span", {
            class: "popup-title",
            text: t("tutorials.welcome.title"),
          }),
        ]),
        el("div", { class: "popup-body" }, [
          el("p", {
            class: "popup-message",
            text: t("tutorials.welcome.message"),
          }),
          el("label", { class: "tutorial-welcome-optout" }, [
            optOut,
            el("span", { text: t("tutorials.welcome.optOut") }),
          ]),
        ]),
        el("div", { class: "popup-footer" }, [
          el("button", {
            class: "btn popup-btn btn--secondary",
            type: "button",
            text: t("tutorials.welcome.notNow"),
            onClick: answer(false),
          }),
          el("button", {
            class: "btn popup-btn btn--primary",
            type: "button",
            text: t("tutorials.welcome.yes"),
            "data-autofocus": true,
            onClick: answer(true),
          }),
        ]),
      ],
    );
    PopupManager.open({ element, onMaskClick: answer(false) });
    return true;
  }

  #dismissAutoShow() {
    if (autoShowDismissed(this.#getSettings())) return;
    this.#setSettings({ tutorials: { autoShowDismissed: true } });
  }

  // ── Playing one ───────────────────────────────────────────────────────────

  /**
   * Start a tutorial on a new desktop of its own.
   * @param {string} id - a TUTORIALS id.
   * @returns {Promise<"completed"|"exited"|null>} null when it could not
   *   start (unknown id, another one already playing, no project).
   */
  async start(id) {
    const tutorial = tutorialById(id);
    const workspace = this.#getWorkspace();
    if (!tutorial || this.#run || !workspace?.isOpen) return null;
    const run = { tutorial, tabId: null, player: null, aborted: false };
    this.#run = run; // claimed before the first await: one tutorial at a time
    const title = t(tutorial.title);
    const previous = workspace.activeTab;
    let outcome = null;
    try {
      this.#prepare?.();
      run.tabId = await workspace.addTutorialTab(
        t("tutorials.desktopName", { title }),
      );
      if (!run.tabId) return null;
      run.player = new TutorialPlayer({
        tutorial,
        rect: targetRect,
        element: resolveTarget,
        view: null, // set below — the overlay's callbacks need the player
        actuator: this.#actuator(),
        clock: this.#clock,
        log: this.#log,
      });
      const overlay = new TutorialOverlay({
        title,
        mod: this.#mod,
        onExit: () => run.player.exit(),
        onNext: () => run.player.next(),
        onPrevious: () => run.player.previous(),
        onTogglePause: () => run.player.togglePause(),
      });
      run.player.attach(overlay);
      overlay.mount();
      try {
        outcome = await run.player.play();
      } finally {
        overlay.unmount();
        // A drag cut short by Exit must not leave a ghost armed on the desk.
        this.#getDesk()?.cancelPlacement?.();
      }
    } finally {
      this.#run = null;
    }
    if (outcome === "completed" && tutorial.autoShow) this.#dismissAutoShow();
    if (run.aborted) {
      // The desk went elsewhere under it; there is nothing left to ask about.
      workspace.keepTutorialTab();
    } else {
      this.#askKeep(workspace, run.tabId, previous, outcome);
    }
    return outcome;
  }

  /**
   * The desktop on screen changed. If it is no longer the tutorial's, the
   * tutorial stops — quietly, since whatever moved the desk is the user's.
   */
  activeChanged(tab) {
    const run = this.#run;
    if (!run?.tabId || !run.player) return;
    if (tab?.id === run.tabId) return;
    run.aborted = true;
    run.player.exit();
  }

  /** The app's own handlers, for the player's click and drag. */
  #actuator() {
    const desk = () => this.#getDesk();
    return {
      click: (target) => target?.click(),
      // Picking a part up IS a click on its tray row: that arms the ghost.
      dragStart: (target) => target?.click(),
      dragMove: (point) => desk()?.trackPlacementAt?.(point.x, point.y),
      dragEnd: (point) => desk()?.dropPlacementAt?.(point.x, point.y) ?? false,
    };
  }

  /** Keep the tutorial's desktop, or close it and go back. Dismissing the
      card keeps it — the one answer that loses nothing. */
  #askKeep(workspace, tabId, previous, outcome) {
    const tab = workspace.tabById?.(tabId);
    if (!tab) {
      workspace.keepTutorialTab();
      return;
    }
    const keep = () => {
      PopupManager.close();
      workspace.keepTutorialTab();
    };
    const close = () => {
      PopupManager.close();
      void workspace.closeTutorialTab(previous?.id ?? null);
    };
    const title =
      outcome === "completed"
        ? t("tutorials.end.finishedTitle")
        : t("tutorials.end.stoppedTitle");
    const element = el(
      "div",
      {
        class: "popup popup-confirm tutorial-end",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": title,
      },
      [
        el("div", { class: "popup-header" }, [
          el("span", { class: "popup-title", text: title }),
        ]),
        el("div", { class: "popup-body" }, [
          el("p", {
            class: "popup-message",
            text: t("tutorials.end.message", {
              name: tab.name,
              previous: previous?.name ?? "",
            }),
          }),
        ]),
        el("div", { class: "popup-footer" }, [
          el("button", {
            class: "btn popup-btn btn--secondary",
            type: "button",
            text: t("tutorials.end.close"),
            onClick: close,
          }),
          el("button", {
            class: "btn popup-btn btn--primary",
            type: "button",
            text: t("tutorials.end.keep"),
            "data-autofocus": true,
            onClick: keep,
          }),
        ]),
      ],
    );
    PopupManager.open({ element, onMaskClick: keep });
  }
}
