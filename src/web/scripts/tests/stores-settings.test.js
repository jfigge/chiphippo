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
  const calls = {
    removed: [],
    cancel: 0,
    revealed: [],
    browsed: [],
    invited: [],
  };
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
      reveal: async (id, opts) => (
        calls.revealed.push([id, opts ?? null]),
        true
      ),
      invite: async (id, login) => (
        calls.invited.push([id, login]),
        { ok: true }
      ),
      people: async () => ({ ok: true, people: [] }),
      githubSignIn: async () => ({ ok: true, userCode: "ABCD-1234" }),
      githubSignInWait: () => new Promise(() => {}),
      githubSignInCancel: async () => ((calls.cancel += 1), true),
      githubSignOut: async () => true,
      guide: async () => true,
    },
  };
  const root = document.createElement("div");
  document.body.append(root);
  const { rows, destroy } = buildStoresRows({ rowWithNote, bridge, onBrowse: (store) => calls.browsed.push(store.id) }); // prettier-ignore
  root.append(...rows);
  return { root, calls, copied, destroy, bridge };
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

const G = {
  id: "s-3333333333333333",
  name: "Lab",
  kind: "github",
  repo: "ann/lab",
};

test("each store line: Browse opens its tab, Show folder / Open on GitHub shows it, Invite (GitHub only) sends a name", async () => {
  const { root, calls } = panel([A, G]);
  await settle();
  const [a, g] = root.querySelectorAll(".settings-store");
  assert.equal(btn(a, "Invite"), undefined, "a folder store has no Invite");
  btn(a, "Browse").click();
  btn(a, "Show folder").click();
  btn(g, "Open on GitHub").click();
  assert.deepEqual(calls.browsed, [A.id]);
  assert.deepEqual(calls.revealed, [
    [A.id, null],
    [G.id, null],
  ]);
  btn(g, "Invite").click();
  await settle();
  assert.equal(btn(g, "Invite").getAttribute("aria-expanded"), "true");
  const login = g.querySelector(".store-invite-login");
  login.value = "bob";
  [...g.querySelectorAll(".store-invite button")].find((b) => b.textContent === "Invite").click(); // prettier-ignore
  await settle();
  assert.deepEqual(calls.invited, [[G.id, "bob"]]);
  btn(g, "Manage who has access on GitHub").click();
  assert.deepEqual(calls.revealed.at(-1), [G.id, { people: true }]);
});

test("a list read that fails draws the empty list — never an unhandled failure", async () => {
  resetDom();
  const bridge = { stores: { list: async () => { throw new Error("gone"); }, status: async () => { throw new Error("gone"); } } }; // prettier-ignore
  const root = document.createElement("div");
  document.body.append(root);
  const { rows } = buildStoresRows({ rowWithNote, bridge });
  root.append(...rows);
  await settle();
  assert.match(root.textContent, /No private stores yet/);
});

test("Show folder on a store whose folder has gone says so — the press never does nothing", async () => {
  const { root, bridge } = panel([A]);
  await settle();
  const line = root.querySelector(".settings-store");
  btn(line, "Show folder").click();
  await settle();
  assert.equal(
    line.querySelector(".settings-store-extra").hidden,
    true,
    "shown: nothing to say",
  );
  bridge.stores.reveal = async () => false; // moved, or not synced yet
  btn(line, "Show folder").click();
  await settle();
  const extra = line.querySelector(".settings-store-extra");
  assert.equal(extra.hidden, false);
  assert.match(extra.textContent, /could not be found/);
});

test("Remove, Sign out and the guide's close put the focus on Add Store… — never off the panel", async () => {
  const { root } = panel([A]);
  await settle();
  btn(root, "Remove").click();
  await settle();
  btn(root, "Remove from This Computer").click();
  await settle();
  assert.equal(document.activeElement, btn(root, "Add Store…"));
  btn(root, "Sign out").click();
  await settle();
  assert.equal(document.activeElement, btn(root, "Add Store…"));
  btn(root, "Add Store…").click();
  await settle();
  btn(root, "Cancel").click();
  await settle();
  assert.equal(document.activeElement, btn(root, "Add Store…"));
});

test("a slow list read landing after a newer one never draws the older list", async () => {
  resetDom();
  const answers = [];
  const bridge = {
    stores: {
      list: () => new Promise((r) => answers.push(r)),
      status: async () => ({ enabled: true, github: { configured: false } }),
      guide: async () => true,
    },
  };
  const root = document.createElement("div");
  document.body.append(root);
  const { rows } = buildStoresRows({ rowWithNote, bridge });
  root.append(...rows);
  await settle();
  // The guide opened and closed before the first read answered: a second read.
  btn(root, "Add Store…").click();
  await settle();
  btn(root, "Cancel").click();
  await settle();
  assert.equal(answers.length, 2);
  answers[1]([A]); // the newer read: one store
  await settle();
  answers[0]([A, B]); // the older one, late
  await settle();
  assert.equal(root.querySelectorAll(".settings-store").length, 1);
});
