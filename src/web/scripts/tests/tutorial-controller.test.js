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

// The tutorials end to end, in jsdom, on a fast clock: the welcome gate's
// three answers, the menu, a tutorial on its own desktop, the keep/close
// question, the one global flag, Escape, the overlay's input block, and a
// tour stopping when its desktop leaves the screen.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { t } from "../i18n.js";

resetDom();
const { PopupManager } = await import("../popup-manager.js");
const { TutorialController, autoShowDismissed } =
  await import("../components/tutorial-controller.js");
const { TUTORIALS } = await import("../tutorials/definitions.js");
const { clearTargets, registerTarget } =
  await import("../tutorials/targets.js");

/** A clock whose every frame is 16 ms on and resolves at once. */
function fastClock() {
  const clock = {
    t: 0,
    hook: null,
    now: () => clock.t,
    frame: async () => {
      clock.t += 16;
      clock.hook?.(clock);
    },
  };
  return clock;
}

/** The workspace's tutorial surface, recorded. */
function fakeWorkspace() {
  const tabs = [{ id: "t1", name: "Desktop 1" }];
  const ws = {
    calls: [],
    active: "t1",
    isOpen: true,
    get activeTab() {
      return tabs.find((tab) => tab.id === ws.active);
    },
    tabById: (id) => tabs.find((tab) => tab.id === id) ?? null,
    async addTutorialTab(name) {
      ws.calls.push(["add", name]);
      tabs.push({ id: "t2", name });
      ws.active = "t2";
      return "t2";
    },
    keepTutorialTab() {
      ws.calls.push(["keep"]);
    },
    async closeTutorialTab(returnTo) {
      ws.calls.push(["close", returnTo]);
      tabs.pop();
      ws.active = returnTo;
    },
  };
  return ws;
}

function harness({ settings = {}, clock = fastClock() } = {}) {
  const win = resetDom();
  // jsdom lays nothing out, so every target answers with a rect of its own.
  clearTargets();
  const desk = {
    calls: [],
    trackPlacementAt: (x, y) => desk.calls.push(["track", x, y]),
    dropPlacementAt: (x, y) => {
      desk.calls.push(["drop", x, y]);
      return true;
    },
    cancelPlacement: () => desk.calls.push(["cancel"]),
  };
  const workspace = fakeWorkspace();
  const state = { settings: { ...settings }, writes: [] };
  const controller = new TutorialController({
    getWorkspace: () => workspace,
    getDesk: () => desk,
    getSettings: () => state.settings,
    setSettings: (patch) => {
      state.writes.push(patch);
      state.settings = { ...state.settings, ...patch };
    },
    mod: "⌘",
    clock,
    log: { warn: () => {} }, // jsdom lays nothing out: most targets are absent
  });
  return { win, controller, workspace, desk, state, clock };
}

/** A real element standing for a target, laid out where we say. */
function target(id, rect, attrs = {}) {
  const node = document.createElement("button");
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }); // prettier-ignore
  document.body.append(node);
  registerTarget(id, node);
  return node;
}

const buttonLabelled = (label) =>
  [...document.querySelectorAll(".popup-dialog button")].find(
    (b) => b.textContent.trim() === label,
  ) ?? null;

const click = (label) => {
  const b = buttonLabelled(label);
  assert.ok(b, `a "${label}" button is showing`);
  b.click();
};

const until = async (cond, what) => {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const endCard = () => document.querySelector(".tutorial-end");

test.afterEach(() => {
  while (PopupManager.isOpen()) PopupManager.close();
});

test("the welcome is offered until it is dismissed for good", () => {
  const h = harness({ settings: { tutorials: { autoShowDismissed: true } } });
  assert.equal(h.controller.offerWelcome(), false, "opted out: nothing shown");
  assert.equal(PopupManager.isOpen(), false);

  const fresh = harness();
  assert.equal(fresh.controller.offerWelcome(), true);
  const card = document.querySelector(".tutorial-welcome");
  assert.ok(card);
  assert.match(card.textContent, new RegExp(t("tutorials.welcome.title")));
  assert.ok(buttonLabelled(t("tutorials.welcome.yes")));
  assert.ok(card.querySelector('input[type="checkbox"]'));
});

test("Not now defers: no flag, no tutorial — unless the box is ticked", () => {
  const h = harness();
  h.controller.offerWelcome();
  click(t("tutorials.welcome.notNow"));
  assert.equal(PopupManager.isOpen(), false);
  assert.deepEqual(h.state.writes, [], "asked again next launch");
  assert.deepEqual(h.workspace.calls, [], "nothing started");

  h.controller.offerWelcome();
  document.querySelector(".tutorial-welcome-optout-box").checked = true;
  click(t("tutorials.welcome.notNow"));
  assert.deepEqual(h.state.writes, [
    { tutorials: { autoShowDismissed: true } },
  ]);
  assert.equal(autoShowDismissed(h.state.settings), true);
  assert.equal(h.controller.offerWelcome(), false, "and never again");
});

test("Yes starts Tutorial 1 on a desktop of its own; finishing it sets the flag and asks keep or close", async () => {
  const h = harness();
  h.controller.offerWelcome();
  click(t("tutorials.welcome.yes"));
  await until(() => h.workspace.calls.length > 0, "the tutorial desktop");
  assert.deepEqual(h.workspace.calls[0], [
    "add",
    t("tutorials.desktopName", { title: t("tutorials.gettingAround.title") }),
  ]);
  assert.ok(document.querySelector(".tutorial-overlay"), "the overlay is up");
  assert.equal(h.controller.playing, true);

  await until(endCard, "the end of the tour");
  assert.equal(document.querySelector(".tutorial-overlay"), null, "taken down");
  assert.equal(h.controller.playing, false);
  assert.deepEqual(h.state.writes, [
    { tutorials: { autoShowDismissed: true } },
  ]);
  assert.match(
    endCard().textContent,
    new RegExp(t("tutorials.end.finishedTitle")),
  );

  click(t("tutorials.end.close"));
  await until(() => h.workspace.calls.length > 1, "the close");
  assert.deepEqual(
    h.workspace.calls.at(-1),
    ["close", "t1"],
    "back to Desktop 1",
  );
});

test("the book's menu lists every tutorial in order, and a pick starts it", async () => {
  const h = harness();
  h.controller.openMenu();
  const items = [...document.querySelectorAll(".tutorial-menu-item")];
  assert.deepEqual(
    items.map((b) => b.dataset.tutorial),
    TUTORIALS.map((tut) => tut.id),
  );
  assert.match(
    items[1].textContent,
    new RegExp(t("tutorials.firstBreadboard.title")),
  );
  items[1].click();
  await until(endCard, "the end of the tour");
  assert.equal(h.workspace.calls[0][1].includes(t("tutorials.firstBreadboard.title")), true); // prettier-ignore
  assert.deepEqual(h.state.writes, [], "only Tutorial 1 sets the flag");
  click(t("tutorials.end.keep"));
  assert.deepEqual(h.workspace.calls.at(-1), ["keep"]);
});

test("the fake cursor drives the real handlers: the tray row's click, the desk's track and drop", async () => {
  const h = harness();
  const clicks = [];
  const boards = target("palette.boards", { left: 0, top: 60, width: 220, height: 24 }, { "aria-expanded": "false" }); // prettier-ignore
  boards.addEventListener("click", () => clicks.push("boards"));
  const full = target("palette.board.full", { left: 0, top: 90, width: 220, height: 24 }); // prettier-ignore
  full.addEventListener("click", () => clicks.push("full"));
  target("desk", { left: 240, top: 80, width: 760, height: 520 });
  await h.controller.start("first-breadboard");
  assert.deepEqual(clicks, ["boards", "full"], "each element's own listener");
  const tracks = h.desk.calls.filter(([k]) => k === "track");
  assert.ok(tracks.length > 10, "the ghost followed the cursor");
  const drop = h.desk.calls.find(([k]) => k === "drop");
  assert.deepEqual(drop, ["drop", 620, 80 + 520 * 0.58], "dropped where the step said"); // prettier-ignore
  assert.deepEqual(h.desk.calls.at(-1), ["cancel"], "nothing left in hand");
});

test("Escape exits at any step; the overlay swallows every other key", async () => {
  const h = harness();
  const reached = [];
  window.addEventListener("keydown", (e) => reached.push(e.key));
  h.clock.hook = (c) => {
    if (c.t === 16 * 50) {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "w", bubbles: true })); // prettier-ignore
    }
    if (c.t === 16 * 100) {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); // prettier-ignore
    }
  };
  const outcome = await h.controller.start("getting-around");
  assert.equal(outcome, "exited");
  assert.deepEqual(reached, [], "neither key reached the app");
  assert.deepEqual(h.state.writes, [], "an exited tour is not a seen one");
  assert.match(
    endCard().textContent,
    new RegExp(t("tutorials.end.stoppedTitle")),
  );
});

test("a tour whose desktop leaves the screen stops, with nothing to ask", async () => {
  const h = harness();
  h.clock.hook = (c) => {
    if (c.t === 16 * 20) h.controller.activeChanged({ id: "t9" });
  };
  const outcome = await h.controller.start("getting-around");
  assert.equal(outcome, "exited");
  assert.equal(endCard(), null);
  assert.deepEqual(h.workspace.calls.at(-1), ["keep"], "its hold released");
});

test("one tutorial at a time", async () => {
  const h = harness();
  const first = h.controller.start("getting-around");
  assert.equal(await h.controller.start("first-breadboard"), null);
  h.controller.activeChanged({ id: "elsewhere" });
  await first;
});

test("the controls are Previous · Pause · Next · Exit, and Previous is greyed on the first step", async () => {
  const h = harness();
  let seen = null;
  h.clock.hook = (c) => {
    if (c.t === 16 * 10) {
      seen = [...document.querySelectorAll(".tutorial-controls button")].map(
        (b) => [b.textContent, b.disabled],
      );
      h.controller.activeChanged({ id: "elsewhere" }); // done looking
    }
  };
  await h.controller.start("getting-around");
  assert.deepEqual(seen, [
    [t("tutorials.controls.previous"), true],
    [t("tutorials.controls.pause"), false],
    [t("tutorials.controls.next"), false],
    [t("tutorials.controls.exit"), false],
  ]);
});
