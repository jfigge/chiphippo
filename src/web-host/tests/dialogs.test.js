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

// dialogs.test.js — the host's pickers and cards in a jsdom tab: a picker
// that needs a click asks for one (ui.continueWith), a cancel there is a
// cancel, and a failure after the click is REPORTED (main's dialog rejects)
// rather than read as one; and a download from a popup gone cross-origin
// falls back to the tab (context.js).

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { continueWith } from "../ui.js";
import { Dialogs } from "../dialogs.js";
import { ctx, download } from "../context.js";

function tab() {
  const { window } = new JSDOM("<!doctype html><body></body>");
  // jsdom has no modal <dialog>
  window.HTMLDialogElement.prototype.showModal = function () {};
  window.HTMLDialogElement.prototype.close = function () {};
  return window;
}

/** The card's button, once the card is up. */
async function cardButton(doc, selector) {
  for (let i = 0; i < 50; i++) {
    const btn = doc.querySelector(`dialog ${selector}`);
    if (btn) return btn;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`no card with ${selector}`);
}

const named = (name, message = name) =>
  Object.assign(new Error(message), { name });

const quiet = async (fn) => {
  const error = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
  }
};

test("continueWith: the action's result, null when dismissed, its failure rejected", () =>
  quiet(async () => {
    const win = tab();
    const doc = win.document;
    const ok = continueWith(doc, { title: "Go", action: () => "picked" });
    (await cardButton(doc, ".btn--primary")).click();
    assert.equal(await ok, "picked");

    const dismissed = continueWith(doc, { title: "Go", action: () => "x" });
    (await cardButton(doc, ".btn--secondary")).click();
    assert.equal(await dismissed, null, "the card dismissed is a cancel");

    const failed = continueWith(doc, {
      title: "Go",
      action: async () => {
        throw new Error("the disk said no");
      },
    });
    (await cardButton(doc, ".btn--primary")).click();
    await assert.rejects(failed, /the disk said no/);
  }));

/** A Save As whose picker first wants a click, then does `second()`. */
async function saveAs(second) {
  const win = tab();
  let calls = 0;
  win.showOpenFilePicker = () => {};
  win.showSaveFilePicker = async () => {
    calls++;
    if (calls === 1) throw named("SecurityError", "needs a user gesture");
    return second();
  };
  const dialogs = new Dialogs({
    vfs: null,
    mounts: { mountFile: async (h) => `/Files/1/${h.name}` },
    download: () => {},
    windowOf: () => win,
  });
  const answer = dialogs.showSaveDialog({ defaultPath: "Bench.chiphippo" });
  (await cardButton(win.document, ".btn--primary")).click();
  return answer;
}

test("a Save As cancelled from the card's click is a cancel", () =>
  quiet(async () => {
    const r = await saveAs(() => {
      throw named("AbortError", "The user aborted a request.");
    });
    assert.deepEqual(r, { canceled: true, filePath: undefined });
  }));

test("a Save As that fails after the click is reported, not taken for a cancel", () =>
  quiet(async () => {
    await assert.rejects(
      saveAs(() => {
        throw named("NotAllowedError", "The request is not allowed");
      }),
      /not allowed/,
    );
    const r = await saveAs(() => ({ name: "Bench.chiphippo" }));
    assert.equal(r.filePath, "/Files/1/Bench.chiphippo");
  }));

test("a download from a popup gone cross-origin starts in the tab instead", () => {
  mock.timers.enable({ apis: ["setTimeout"] }); // the object URL's revoke
  const page = tab();
  const was = ctx.page;
  ctx.page = page;
  const clicked = [];
  page.HTMLAnchorElement.prototype.click = function () {
    clicked.push(this.download);
  };
  try {
    const away = {
      closed: false,
      get document() {
        throw named("SecurityError", "Blocked a frame from accessing");
      },
    };
    download("AT28C256.bin", new Uint8Array(4), away);
    assert.deepEqual(clicked, ["AT28C256.bin"]);
  } finally {
    ctx.page = was;
    mock.timers.reset();
  }
});
