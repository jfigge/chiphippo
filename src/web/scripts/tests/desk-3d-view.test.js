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

// The 3D view's DOM half, with no WebGL: it must hear a change of pixel
// density, which no CSS size reports (a window dragged to another screen).

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { Desk3DView } = await import("../components/desk-3d-view.js");
const { DeskDoc } = await import("../model/desk-doc.js");

test("the view re-arms its pixel-density query on every change, and lets go on dispose", () => {
  resetDom();
  const queries = [];
  window.matchMedia = (media) => {
    const q = new window.EventTarget();
    q.media = media;
    q.matches = false;
    q.listeners = 0;
    const add = q.addEventListener.bind(q);
    const remove = q.removeEventListener.bind(q);
    q.addEventListener = (...a) => (q.listeners++, add(...a));
    q.removeEventListener = (...a) => (q.listeners--, remove(...a));
    queries.push(q);
    return q;
  };
  globalThis.devicePixelRatio = 1;
  const viewport = document.createElement("section");
  document.body.append(viewport);
  const view = new Desk3DView(viewport, {
    doc: new DeskDoc(null),
    ledOf: () => null,
    segmentOf: () => null,
  });
  const dpr = () => queries.filter((q) => q.media.startsWith("(resolution"));
  assert.deepEqual(
    dpr().map((q) => q.media),
    ["(resolution: 1dppx)"],
  );

  globalThis.devicePixelRatio = 2; // dragged onto a Retina screen
  dpr()[0].dispatchEvent(new window.Event("change"));
  assert.deepEqual(dpr().map((q) => q.media), ["(resolution: 1dppx)", "(resolution: 2dppx)"]); // prettier-ignore
  assert.equal(dpr()[0].listeners, 0, "the old query is let go");
  assert.equal(dpr()[1].listeners, 1);

  view.dispose();
  assert.equal(dpr()[1].listeners, 0);
  delete globalThis.devicePixelRatio;
});
