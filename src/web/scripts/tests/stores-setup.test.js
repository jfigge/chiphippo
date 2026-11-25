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

// The Add Store guide (components/store-setup.js) in jsdom, against a fake
// bridge: the first step's four choices, and GitHub's two places a store can
// go — a new repository, or a folder in one the user already has.
import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { mountStoreSetup } from "../components/store-setup.js";

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};
const byText = (root, text) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === text); // prettier-ignore
const type = (input, value) => {
  input.value = value;
  input.dispatchEvent(new window.Event("input"));
};

/** A bridge signed in to GitHub, with two private repositories. */
function fakeBridge() {
  const calls = [];
  return {
    calls,
    stores: {
      status: async () => ({ enabled: true, github: { configured: true, signedIn: true, login: "ann" } }), // prettier-ignore
      githubRepos: async () => ({ ok: true, repos: [{ repo: "ann/website" }, { repo: "ann/notes" }] }), // prettier-ignore
      addGitHub: async (opts) => {
        calls.push(opts);
        return { ok: true, store: { id: "s-0123456789abcdef", name: opts.name, kind: "github", repo: opts.repo ?? "ann/Lab", dir: opts.dir } }; // prettier-ignore
      },
      link: async () => ({ web: "https://chiphippo.com/store/#x", app: "chiphippo://store/add#x" }), // prettier-ignore
      people: async () => ({ ok: true, people: [] }),
      guide: async () => true,
    },
  };
}

test("the first step offers four ways in: a synced folder, GitHub, a friend's link, a folder already here", async () => {
  resetDom();
  const root = document.createElement("div");
  document.body.append(root);
  mountStoreSetup(root, { bridge: fakeBridge() });
  await settle();
  const titles = [...root.querySelectorAll(".store-setup-choice-title")].map((n) => n.textContent); // prettier-ignore
  assert.equal(titles.length, 4);
  assert.ok(root.querySelectorAll(".store-setup-choice")[1].disabled === false, "GitHub on: configured"); // prettier-ignore
});

test("a build without GitHub sign-in shows no GitHub choice at all — never a greyed 'coming soon'", async () => {
  resetDom();
  const root = document.createElement("div");
  document.body.append(root);
  const bridge = fakeBridge();
  bridge.stores.status = async () => ({ enabled: true, github: { configured: false } }); // prettier-ignore
  mountStoreSetup(root, { bridge });
  await settle();
  const titles = [...root.querySelectorAll(".store-setup-choice-title")].map((n) => n.textContent); // prettier-ignore
  assert.equal(titles.length, 3);
  assert.ok(!titles.includes("GitHub"));
  assert.doesNotMatch(root.textContent, /coming soon/i);
});

test("GitHub: a new private repository by default, or a folder in one of mine", async () => {
  resetDom();
  const root = document.createElement("div");
  document.body.append(root);
  const bridge = fakeBridge();
  mountStoreSetup(root, { bridge });
  await settle();
  root.querySelectorAll(".store-setup-choice")[1].click();
  await settle();
  const where = root.querySelector(".store-setup-where");
  assert.equal(where.hidden, false, "offered once signed in");
  const [isNew, isExisting] = where.querySelectorAll("input[type=radio]");
  assert.equal(isNew.checked, true);
  assert.equal(root.querySelector(".store-setup-existing").hidden, true);
  // A folder in one of mine: the repositories are asked for, the folder
  // starts at "chiphippo".
  isExisting.checked = true;
  isExisting.dispatchEvent(new window.Event("change"));
  await settle();
  assert.equal(root.querySelector(".store-setup-existing").hidden, false);
  const pick = root.querySelector(".store-setup-repo");
  assert.deepEqual([...pick.options].map((o) => o.value), ["ann/website", "ann/notes"]); // prettier-ignore
  const folder = root.querySelector(".store-setup-folder");
  assert.equal(folder.value, "chiphippo");
  const make = root.querySelector(
    ".store-setup-footer .settings-action--primary",
  );
  assert.equal(make.disabled, true, "no name yet");
  type(root.querySelector(".store-setup-name"), "Lab");
  assert.equal(make.disabled, false);
  type(folder, "../up");
  assert.equal(make.disabled, true, "a folder name that cannot be used");
  type(folder, "designs/chiphippo");
  make.click();
  await settle();
  assert.deepEqual(bridge.calls.at(-1), { mode: "existing", repo: "ann/website", dir: "designs/chiphippo", name: "Lab" }); // prettier-ignore
  // Made: the next step names the repository and its folder.
  assert.match(root.textContent, /ann\/website\/designs\/chiphippo/);
  assert.ok(byText(root, "Invite"));
});

/** A bridge NOT signed in, counting what is asked of it. */
function countingBridge(over = {}) {
  const calls = { signIn: 0, cancel: 0, repos: 0, addFolder: [] };
  let finish;
  const bridge = {
    calls,
    finishSignIn: (res) => finish?.(res),
    stores: {
      status: async () => ({ enabled: true, github: { configured: true, signedIn: over.signedIn ?? false, login: "ann" } }), // prettier-ignore
      githubSignIn: async () => ((calls.signIn += 1), { ok: true, userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresIn: 900 }), // prettier-ignore
      githubSignInWait: () => new Promise((r) => (finish = r)),
      githubSignInCancel: async () => {
        calls.cancel += 1;
        finish?.({ ok: false, code: "cancelled" });
        return true;
      },
      githubRepos: async () => ((calls.repos += 1), over.repos ?? { ok: false, code: "rateLimited" }), // prettier-ignore
      addFolder: async (opts) => (calls.addFolder.push(opts), { ok: true, store: { id: "s-0123456789abcdef", name: "Lab", kind: "folder", provider: opts.provider, path: "/x" } }), // prettier-ignore
      addGitHub: async () => ({ ok: false, code: "unavailable" }),
      link: async () => ({ web: "https://chiphippo.com/store/#x" }),
      guide: async () => true,
    },
  };
  return bridge;
}

const mount = (bridge, opts = {}) => {
  resetDom();
  const root = document.createElement("div");
  document.body.append(root);
  const guide = mountStoreSetup(root, { bridge, ...opts });
  return { root, guide };
};

test("a repository list that fails is said once, with Try again — never asked again by itself", async () => {
  const bridge = countingBridge({ signedIn: true });
  const { root } = mount(bridge);
  await settle();
  root.querySelectorAll(".store-setup-choice")[1].click();
  await settle();
  const existing = root.querySelectorAll(".store-setup-where input[type=radio]")[1]; // prettier-ignore
  existing.checked = true;
  existing.dispatchEvent(new window.Event("change"));
  for (let i = 0; i < 5; i += 1) await settle();
  assert.equal(bridge.calls.repos, 1, "asked once, not in a loop");
  assert.match(root.querySelector(".store-setup-problem").textContent, /slow down/); // prettier-ignore
  // Typing elsewhere does not ask again either.
  const name = root.querySelector(".store-setup-name");
  name.value = "Lab";
  name.dispatchEvent(new window.Event("input"));
  await settle();
  assert.equal(bridge.calls.repos, 1);
  byText(root, "Try again").click();
  await settle();
  assert.equal(bridge.calls.repos, 2);
});

test("Sign In is one press: a double click starts one sign-in; Back while waiting stops it", async () => {
  const bridge = countingBridge();
  const { root } = mount(bridge);
  await settle();
  root.querySelectorAll(".store-setup-choice")[1].click();
  await settle();
  const signIn = byText(root, "Sign In to GitHub");
  signIn.click();
  signIn.click();
  await settle();
  assert.equal(bridge.calls.signIn, 1);
  assert.equal(
    root.querySelector(".store-setup-code").textContent,
    "ABCD-1234",
  );
  byText(root, "Back").click();
  await settle();
  assert.equal(bridge.calls.cancel, 1, "the waiting sign-in is stopped");
  assert.ok(
    root.querySelector(".store-setup-choices"),
    "back on the first step",
  );
});

test("closing the guide (Settings closed) stops a sign-in still waiting", async () => {
  const bridge = countingBridge();
  const { root, guide } = mount(bridge);
  await settle();
  root.querySelectorAll(".store-setup-choice")[1].click();
  await settle();
  byText(root, "Sign In to GitHub").click();
  await settle();
  guide.destroy();
  await settle();
  assert.equal(bridge.calls.cancel, 1);
});

test("restoring a store folder already here asks which service keeps it in step", async () => {
  const bridge = countingBridge();
  const { root } = mount(bridge);
  await settle();
  root.querySelectorAll(".store-setup-choice")[3].click();
  await settle();
  const provider = root.querySelector(".store-setup-provider");
  provider.value = "onedrive";
  byText(root, "Choose the Folder…").click();
  await settle();
  assert.deepEqual(bridge.calls.addFolder, [{ mode: "open", provider: "onedrive" }]); // prettier-ignore
  assert.match(root.textContent, /is added/);
  // Focus is never left on the page between steps.
  assert.notEqual(document.activeElement, document.body);
});

test("Back while GitHub is still answering the start stops that sign-in too", async () => {
  const bridge = countingBridge();
  let answerStart;
  bridge.stores.githubSignIn = () => new Promise((r) => (answerStart = r));
  const { root } = mount(bridge);
  await settle();
  root.querySelectorAll(".store-setup-choice")[1].click();
  await settle();
  byText(root, "Sign In to GitHub").click();
  await settle();
  byText(root, "Back").click();
  await settle();
  assert.equal(bridge.calls.cancel, 1, "cancelled while the start was out");
  answerStart({ ok: false, code: "cancelled" });
  await settle();
  assert.ok(
    root.querySelector(".store-setup-choices"),
    "still on the first step",
  );
});

test("a friend's link to 'another synced folder' says so plainly, with no service named", async () => {
  const bridge = countingBridge();
  const { root } = mount(bridge, { ref: { id: "s-0123456789abcdef", name: "Lab", kind: "folder", where: { provider: "other" } } }); // prettier-ignore
  await settle();
  assert.match(root.textContent, /a folder your friend shared with you\. Three steps/); // prettier-ignore
  assert.doesNotMatch(root.textContent, /in Another synced folder/);
});

test("a friend's GitHub link opened while another card is up: the guide still draws when its card shows", async () => {
  resetDom();
  const root = document.createElement("div"); // not on the page yet: queued
  const bridge = fakeBridge();
  mountStoreSetup(root, { bridge, ref: { id: "s-0123456789abcdef", name: "Lab", kind: "github", where: { repo: "ann/lab" } } }); // prettier-ignore
  await settle();
  document.body.append(root); // the card shows
  assert.match(root.textContent, /Signed in to GitHub as @ann/);
  assert.equal(byText(root, "Join the Store").disabled, false);
});

test("Make the Store stays off while a store is being made, whatever is typed", async () => {
  resetDom();
  const root = document.createElement("div");
  document.body.append(root);
  const bridge = fakeBridge();
  let finish;
  bridge.stores.addGitHub = (opts) => (bridge.calls.push(opts), new Promise((r) => (finish = r))); // prettier-ignore
  mountStoreSetup(root, { bridge });
  await settle();
  root.querySelectorAll(".store-setup-choice")[1].click();
  await settle();
  const name = root.querySelector(".store-setup-name");
  name.value = "Lab";
  name.dispatchEvent(new window.Event("input"));
  const make = byText(root, "Make the Store");
  make.click();
  name.value = "Lab2";
  name.dispatchEvent(new window.Event("input"));
  assert.equal(make.disabled, true, "no second press while the first is out");
  finish({ ok: false, code: "unavailable" });
  await settle();
  assert.equal(make.disabled, false);
  assert.equal(bridge.calls.length, 1);
});
