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

// The toast stack every run warning, the updater and the auto-router share.
// What matters: a key collapses repeats and rewrites a live toast's words in
// place; a sticky or undismissable toast stays until its owner says; and an
// action button answers its offer without also firing the toast under it.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { NotificationStack } =
  await import("../components/notification-stack.js");

const toasts = () => [...document.querySelectorAll(".toast")];
const click = (node) =>
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

test("a key collapses repeats and rewrites the live toast's words in place", () => {
  resetDom();
  const stack = new NotificationStack(document.body);
  stack.notify({ key: "k", title: "One", message: "first", sticky: true });
  const node = toasts()[0];
  stack.notify({ key: "k", title: "Two", message: "second", sticky: true });
  assert.equal(toasts().length, 1, "no second toast");
  assert.equal(toasts()[0], node, "the SAME node: its button is not rebuilt");
  assert.equal(node.querySelector(".toast-title").textContent, "Two");
  assert.equal(node.querySelector(".toast-message").textContent, "second");
});

test("without a key, variant + message is the identity", () => {
  resetDom();
  const stack = new NotificationStack(document.body);
  stack.notify({ message: "short", sticky: true });
  stack.notify({ message: "short", sticky: true });
  stack.notify({ variant: "danger", message: "short", sticky: true });
  assert.equal(toasts().length, 2);
});

test("a click dismisses — unless the toast is a job's only interface", () => {
  resetDom();
  const stack = new NotificationStack(document.body);
  stack.notify({ key: "plain", message: "hi", sticky: true });
  stack.notify({ key: "job", message: "working", sticky: true, dismissible: false }); // prettier-ignore
  click(document.querySelector('[data-key="plain"]'));
  click(document.querySelector('[data-key="job"]'));
  assert.deepEqual(
    toasts().map((t) => t.dataset.key),
    ["job"],
  );
  stack.dismiss("job"); // its owner takes it down
  assert.equal(toasts().length, 0);
});

test("an action answers the offer, dismisses, and does not also click the toast", () => {
  resetDom();
  const stack = new NotificationStack(document.body);
  let acted = 0;
  stack.notify({
    key: "offer",
    message: "Update ready",
    sticky: true,
    actionLabel: "Restart",
    onAction: () => acted++,
  });
  click(document.querySelector(".toast-action"));
  assert.equal(acted, 1);
  assert.equal(toasts().length, 0);
});

test("a non-sticky toast times out on its own; dismissing an unknown key is a no-op", async (t) => {
  resetDom();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stack = new NotificationStack(document.body);
  stack.notify({ key: "brief", message: "gone soon" });
  assert.equal(toasts().length, 1);
  t.mock.timers.tick(6000);
  assert.equal(toasts().length, 0);
  assert.doesNotThrow(() => stack.dismiss("nobody"));
});
