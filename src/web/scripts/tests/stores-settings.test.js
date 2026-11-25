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

// Settings ▸ Gallery ▸ Private (components/settings-stores-panel.js) in
// jsdom: Copy link copies, the friend's half said for the store's service,
// the two-step Remove, and the guide's sign-in stopped when Settings closes.
import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { el } from "../dom.js";
import { buildStoresRows } from "../components/settings-stores-panel.js";

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};
const btn = (root, label) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === label); // prettier-ignore
const rowWithNote = ({ label, control }) =>
  el("div", { class: "row", "data-label": label }, [control]);

function panel(stores) {
  resetDom();
  const calls = { removed: [], cancel: 0 };
  let list = [...stores];
  const copied = [];
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => copied.push(text) },
  });
  const bridge = {
    stores: {
      list: async () => list,
      status: async () => ({ enabled: true, github: { configured: true, signedIn: true, login: "ann" } }), // prettier-ignore
      link: async (id) => ({ web: `https://chiphippo.com/store/#${id}` }),
      remove: async (id) => (calls.removed.push(id), (list = list.filter((s) => s.id !== id)), true), // prettier-ignore
      reveal: async () => true,
      githubSignIn: async () => ({ ok: true, userCode: "ABCD-1234" }),
      githubSignInWait: () => new Promise(() => {}),
      githubSignInCancel: async () => ((calls.cancel += 1), true),
      githubSignOut: async () => true,
      guide: async () => true,
    },
  };
  const root = document.createElement("div");
  document.body.append(root);
  const { rows, destroy } = buildStoresRows({ rowWithNote, bridge });
  root.append(...rows);
  return { root, calls, copied, destroy };
}

const A = { id: "s-1111111111111111", name: "Bench club", kind: "folder", provider: "dropbox", path: "/x" }; // prettier-ignore
const B = { id: "s-2222222222222222", name: "Restored", kind: "folder", provider: "other", path: "/y" }; // prettier-ignore

test("Copy link copies the link, and says what the friend also needs — for the store's own service", async () => {
  const { root, copied } = panel([A, B]);
  await settle();
  const [a, b] = root.querySelectorAll(".settings-store");
  btn(a, "Copy link").click();
  await settle();
  assert.deepEqual(copied, [`https://chiphippo.com/store/#${A.id}`]);
  assert.match(a.textContent, /Link copied/);
  assert.match(a.textContent, /share it with them in Dropbox/);
  // Each button names its store, and says whether its panel is open.
  const copyA = btn(a, "Copy link");
  assert.equal(copyA.getAttribute("aria-label"), "Copy link: Bench club");
  assert.equal(copyA.getAttribute("aria-expanded"), "true");
  assert.equal(btn(a, "Remove").getAttribute("aria-expanded"), "false");
  btn(b, "Copy link").click();
  await settle();
  assert.doesNotMatch(b.textContent, /Another synced folder first/);
  assert.match(b.textContent, /make sure it reaches their computer/);
});

test("Remove asks first, and forgets the store here only", async () => {
  const { root, calls } = panel([A]);
  await settle();
  btn(root, "Remove").click();
  await settle();
  assert.match(root.textContent, /Nothing is deleted/);
  assert.deepEqual(calls.removed, []);
  btn(root, "Remove from This Computer").click();
  await settle();
  assert.deepEqual(calls.removed, [A.id]);
  assert.match(root.textContent, /No private stores yet/);
});

test("Sign out steps aside while the guide is up, and closing Settings stops a sign-in still waiting", async () => {
  const { root, calls, destroy } = panel([]);
  await settle();
  assert.equal(root.querySelector(".settings-stores-account").hidden, false);
  btn(root, "Add Store…").click();
  await settle();
  assert.equal(root.querySelector(".settings-stores-account").hidden, true);
  root.querySelectorAll(".store-setup-choice")[1].click();
  await settle();
  destroy();
  await settle();
  assert.equal(calls.cancel, 0, "nothing was waiting yet");
});
