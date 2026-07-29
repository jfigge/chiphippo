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

// jsdom tests for PopupManager: a second popup opened over an active one is
// QUEUED, and each popup's onClose fires only when THAT popup closes — so a
// dialog queued behind another does not reset its open-guard prematurely.
//
// Plus the menu()'s richer vocabulary (the toolbar File menu): a leading icon
// slot every label lines up against, right-aligned accelerators, submenu
// flyouts, and rows whose × removes the entry WITHOUT closing the menu (an
// Open Recent entry).
//
// And the popover() shape (the Wire button's color picker): the caller's own
// DOM in a positioned card, placed WHEN IT MOUNTS rather than when it was
// asked for — which is the whole point of `place`, since a queued popup is
// still unmounted and unmeasurable at request time.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { PopupManager } = await import("../popup-manager.js");
const { el } = await import("../dom.js");

test("onClose fires only for the popup that closes, never for a queued one", () => {
  resetDom();
  let aClosed = 0;
  let bClosed = 0;
  PopupManager.open({ element: el("div"), onClose: () => aClosed++ });
  PopupManager.open({ element: el("div"), onClose: () => bClosed++ }); // queued

  PopupManager.close(); // closes A, then mounts the queued B
  assert.equal(aClosed, 1, "A's guard reset when A closed");
  assert.equal(
    bClosed,
    0,
    "B's guard did NOT reset while B is now the active popup",
  );

  PopupManager.close(); // closes B
  assert.equal(bClosed, 1, "B's guard resets only when B itself closes");
});

const ICON = '<svg viewBox="0 0 24 24"><path d="M0 0"/></svg>';

/** Every item row of the root menu card (the first one in the dialog). */
const rootItems = () => [
  ...document.querySelector(".popup-menu").querySelectorAll(".popup-menu-item"),
];

const labelOf = (item) =>
  item.querySelector(".popup-menu-label").textContent.trim();

test("a plain menu item is unchanged — no icon slot, no accelerator", () => {
  resetDom();
  PopupManager.menu({
    items: [{ label: "Delete Component" }, { label: "Properties…" }],
  });
  assert.deepEqual(
    rootItems().map((b) => b.textContent.trim()),
    ["Delete Component", "Properties…"],
  );
  assert.equal(
    document.querySelectorAll(".popup-menu-icon").length,
    0,
    "a card with no icons reserves no icon slot",
  );
  PopupManager.close();
});

test("one item with an icon gives EVERY item in that card an icon slot", () => {
  resetDom();
  PopupManager.menu({
    items: [
      { label: "New Desktop", icon: ICON, accelerator: "⌘N" },
      { label: "Save As…", accelerator: "⇧⌘S" }, // no icon of its own
    ],
  });
  const [first, second] = rootItems();
  assert.equal(first.querySelectorAll(".popup-menu-icon").length, 1);
  assert.equal(
    second.querySelectorAll(".popup-menu-icon").length,
    1,
    "the iconless item still gets an empty slot, so the labels line up",
  );
  assert.equal(second.querySelector(".popup-menu-icon").innerHTML, "");
  assert.deepEqual(
    rootItems().map((b) => b.querySelector(".popup-menu-accel").textContent),
    ["⌘N", "⇧⌘S"],
  );
  PopupManager.close();
});

test("a submenu opens as a second card on hover and selects through it", () => {
  resetDom();
  let opened = null;
  PopupManager.menu({
    items: [
      { label: "Open…" },
      {
        label: "Open Recent",
        submenu: [
          { label: "alu.chiphippo", onSelect: () => (opened = "alu") },
          { label: "clock.chiphippo", onSelect: () => (opened = "clock") },
        ],
      },
    ],
  });
  assert.equal(document.querySelectorAll(".popup-menu").length, 1);

  const parent = rootItems().find((b) => labelOf(b) === "Open Recent");
  parent.dispatchEvent(new window.PointerEvent("pointerenter"));
  const cards = [...document.querySelectorAll(".popup-menu")];
  assert.equal(cards.length, 2, "the flyout is a sibling card, not nested");
  assert.deepEqual(
    [...cards[1].querySelectorAll(".popup-menu-item")].map(labelOf),
    ["alu.chiphippo", "clock.chiphippo"],
  );

  // Hovering the flyout's own entries must not shut it.
  cards[1]
    .querySelector(".popup-menu-item")
    .dispatchEvent(new window.PointerEvent("pointerenter"));
  assert.equal(document.querySelectorAll(".popup-menu").length, 2);

  cards[1].querySelectorAll(".popup-menu-item")[1].click();
  assert.equal(opened, "clock");
  assert.equal(PopupManager.isOpen(), false, "a selection closes the menu");
});

test("hovering another root item closes the open flyout", () => {
  resetDom();
  PopupManager.menu({
    items: [{ label: "Open…" }, { label: "Open Recent", submenu: [{}] }],
  });
  const [open, recent] = rootItems();
  recent.dispatchEvent(new window.PointerEvent("pointerenter"));
  assert.equal(document.querySelectorAll(".popup-menu").length, 2);
  open.dispatchEvent(new window.PointerEvent("pointerenter"));
  assert.equal(document.querySelectorAll(".popup-menu").length, 1);
  PopupManager.close();
});

test("an entry's × removes its row, keeps the menu open, and empties to the placeholder", () => {
  resetDom();
  const forgotten = [];
  PopupManager.menu({
    items: [
      {
        label: "Open Recent",
        emptyLabel: "No recent files",
        submenu: ["a.chiphippo", "b.chiphippo"].map((name) => ({
          label: name,
          onSelect: () => forgotten.push(`OPENED ${name}`),
          onRemove: () => forgotten.push(name),
        })),
      },
    ],
  });
  rootItems()[0].dispatchEvent(new window.PointerEvent("pointerenter"));
  const flyout = [...document.querySelectorAll(".popup-menu")][1];

  flyout.querySelector(".popup-menu-remove").click();
  assert.deepEqual(forgotten, ["a.chiphippo"], "removed, never selected");
  assert.equal(PopupManager.isOpen(), true, "the menu stays open");
  assert.deepEqual(
    [...flyout.querySelectorAll(".popup-menu-item")].map(labelOf),
    ["b.chiphippo"],
  );

  flyout.querySelector(".popup-menu-remove").click();
  assert.deepEqual(forgotten, ["a.chiphippo", "b.chiphippo"]);
  assert.deepEqual(
    [...flyout.querySelectorAll(".popup-menu-item")].map(labelOf),
    ["No recent files"],
    "the emptied card falls back to its placeholder",
  );
  assert.equal(
    flyout.querySelector(".popup-menu-item").disabled,
    true,
    "the placeholder is not selectable",
  );
  PopupManager.close();
});

test("an empty submenu shows its placeholder from the start", () => {
  resetDom();
  PopupManager.menu({
    items: [
      { label: "Open Recent", emptyLabel: "No recent files", submenu: [] },
    ],
  });
  rootItems()[0].dispatchEvent(new window.PointerEvent("pointerenter"));
  const flyout = [...document.querySelectorAll(".popup-menu")][1];
  assert.deepEqual(
    [...flyout.querySelectorAll(".popup-menu-item")].map(labelOf),
    ["No recent files"],
  );
  PopupManager.close();
});

// ── popover(): the caller's own DOM, positioned ─────────────────────────────

test("popover mounts the caller's DOM in a card placed at the given point", () => {
  resetDom();
  PopupManager.popover({
    x: 40,
    y: 60,
    element: el("div", { class: "probe", text: "content" }),
  });

  const host = document.querySelector(".popup-dialog--popover");
  assert.ok(host, "the non-dimming positioned host");
  const card = host.querySelector(".popup-popover");
  assert.ok(card.querySelector(".probe"), "the caller's node is inside it");
  assert.equal(
    card.getAttribute("role"),
    null,
    "the card adds no role — its content brings its own semantics",
  );
  // jsdom reports zero-size rects in a 1024×768 viewport, so placeCard's clamp
  // leaves the asked-for point alone.
  assert.equal(card.style.left, "40px");
  assert.equal(card.style.top, "60px");
  PopupManager.close();
});

test("a popover is dismissed by Escape and by a click outside it", () => {
  resetDom();
  let closed = 0;
  const open = () =>
    PopupManager.popover({
      element: el("div", { class: "probe" }),
      onClose: () => closed++,
    });

  open();
  // Escape reaches a native <dialog> as `cancel`.
  document
    .querySelector("dialog")
    .dispatchEvent(new window.Event("cancel", { cancelable: true }));
  assert.equal(PopupManager.isOpen(), false, "Escape dismissed it");
  assert.equal(closed, 1);

  open();
  // A click landing on the full-viewport host, not on the card, is "outside".
  document
    .querySelector("dialog")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(PopupManager.isOpen(), false, "an outside click dismissed it");
  assert.equal(closed, 2);
});

test("a QUEUED positioned popup is placed when it MOUNTS, not when asked for", () => {
  resetDom();
  PopupManager.open({ element: el("div") }); // the blocker
  const card = el("div", { class: "probe" });
  PopupManager.popover({ x: 40, y: 60, element: card });

  const queued = card.closest(".popup-popover");
  assert.equal(queued.style.left, "", "still unmounted — nothing to measure");

  PopupManager.close(); // the blocker goes; the popover mounts now
  assert.equal(queued.style.left, "40px");
  assert.equal(queued.style.top, "60px");
  PopupManager.close();
});
