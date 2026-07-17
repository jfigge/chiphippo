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

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  DEFAULT_BOUNDS,
  resolveWindowBounds,
  isBoundsVisible,
  trackWindowState,
} = require("../window-state");

// A single 1920×1080 display whose work area reserves a 25px top menu bar.
const PRIMARY = [
  {
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 25, width: 1920, height: 1055 },
  },
];

// Primary + a secondary display sitting to its left (negative x).
const DUAL = [
  ...PRIMARY,
  {
    bounds: { x: -1440, y: 0, width: 1440, height: 900 },
    workArea: { x: -1440, y: 0, width: 1440, height: 900 },
  },
];

test("resolveWindowBounds: null/garbage → defaults", () => {
  assert.deepEqual(resolveWindowBounds(null, PRIMARY), { ...DEFAULT_BOUNDS });
  assert.deepEqual(resolveWindowBounds({}, PRIMARY), { ...DEFAULT_BOUNDS });
  assert.deepEqual(
    resolveWindowBounds({ x: "a", y: 0, width: 800, height: 600 }, PRIMARY),
    { ...DEFAULT_BOUNDS },
  );
});

test("resolveWindowBounds: a valid on-screen rect is restored", () => {
  const saved = { x: 100, y: 100, width: 1000, height: 700 };
  assert.deepEqual(resolveWindowBounds(saved, PRIMARY), saved);
});

test("resolveWindowBounds: larger than the display → defaults", () => {
  const tooWide = { x: 0, y: 25, width: 2000, height: 700 };
  assert.deepEqual(resolveWindowBounds(tooWide, PRIMARY), {
    ...DEFAULT_BOUNDS,
  });
  const tooTall = { x: 0, y: 25, width: 1000, height: 1100 };
  assert.deepEqual(resolveWindowBounds(tooTall, PRIMARY), {
    ...DEFAULT_BOUNDS,
  });
});

test("resolveWindowBounds: off-screen (stale monitor) → defaults", () => {
  const gone = { x: -1200, y: 100, width: 1000, height: 700 };
  assert.deepEqual(resolveWindowBounds(gone, PRIMARY), { ...DEFAULT_BOUNDS });
});

test("resolveWindowBounds: barely-visible sliver → defaults", () => {
  // Only ~20px of the window pokes onto the primary display; not reachable.
  const sliver = { x: 1900, y: 100, width: 1000, height: 700 };
  assert.deepEqual(resolveWindowBounds(sliver, PRIMARY), { ...DEFAULT_BOUNDS });
});

test("resolveWindowBounds: valid on a secondary display", () => {
  const onSecondary = { x: -1400, y: 50, width: 1000, height: 700 };
  assert.deepEqual(resolveWindowBounds(onSecondary, DUAL), onSecondary);
});

test("isBoundsVisible: empty/invalid display list is not visible", () => {
  const b = { x: 0, y: 25, width: 800, height: 600 };
  assert.equal(isBoundsVisible(b, []), false);
  assert.equal(isBoundsVisible(b, null), false);
});

// ── trackWindowState ──────────────────────────────────────────────────────────

function fakeWin(bounds) {
  const win = new EventEmitter();
  win._bounds = bounds;
  win._destroyed = false;
  win._minimized = false;
  win.isDestroyed = () => win._destroyed;
  win.isMinimized = () => win._minimized;
  win.getNormalBounds = () => win._bounds;
  return win;
}

test("trackWindowState: close flushes the current bounds synchronously", () => {
  const win = fakeWin({ x: 10, y: 20, width: 900, height: 650 });
  const saved = [];
  trackWindowState(win, { save: (b) => saved.push(b), delay: 10_000 });
  win.emit("close");
  assert.deepEqual(saved, [{ x: 10, y: 20, width: 900, height: 650 }]);
});

test("trackWindowState: move/resize debounce into one save", async () => {
  const win = fakeWin({ x: 0, y: 0, width: 800, height: 600 });
  const saved = [];
  trackWindowState(win, { save: (b) => saved.push(b), delay: 5 });
  win.emit("move");
  win._bounds = { x: 5, y: 5, width: 800, height: 600 };
  win.emit("move");
  win._bounds = { x: 9, y: 9, width: 800, height: 600 };
  win.emit("resize");
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(saved, [{ x: 9, y: 9, width: 800, height: 600 }]);
});

test("trackWindowState: skips destroyed and minimized windows", () => {
  const win = fakeWin({ x: 1, y: 2, width: 800, height: 600 });
  const saved = [];
  trackWindowState(win, { save: (b) => saved.push(b), delay: 5 });
  win._minimized = true;
  win.emit("close");
  win._minimized = false;
  win._destroyed = true;
  win.emit("close");
  assert.deepEqual(saved, []);
});

test("trackWindowState: the disposer cancels a pending save", async () => {
  const win = fakeWin({ x: 3, y: 4, width: 800, height: 600 });
  const saved = [];
  const dispose = trackWindowState(win, {
    save: (b) => saved.push(b),
    delay: 5,
  });
  win.emit("move");
  dispose();
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(saved, []);
});
