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

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SettingsStore, DEFAULTS } = require("../store/settings-store");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-settings-"));
  return { dir, store: new SettingsStore(dir) };
}

test("get returns the defaults when nothing is stored", () => {
  const { dir, store } = freshStore();
  try {
    assert.deepEqual(store.get(), { ...DEFAULTS });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the Settings-dialog keys default off / unset", () => {
  assert.equal(DEFAULTS.showDeskHub, false);
  assert.equal(DEFAULTS.selectionColor, null);
});

test("set persists a Settings-dialog patch (desk hub + selection colour)", () => {
  const { dir, store } = freshStore();
  try {
    const next = store.set({ showDeskHub: true, selectionColor: "#ff8800" });
    assert.equal(next.showDeskHub, true);
    assert.equal(next.selectionColor, "#ff8800");
    // A fresh reader sees the persisted values, other defaults intact.
    const reread = new SettingsStore(dir).get();
    assert.equal(reread.showDeskHub, true);
    assert.equal(reread.selectionColor, "#ff8800");
    assert.equal(reread.pinoutFloat, DEFAULTS.pinoutFloat);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("set shallow-merges a patch and leaves other defaults intact", () => {
  const { dir, store } = freshStore();
  try {
    const viewport = { cx: 12, cy: -3, zoom: 1.6 };
    const next = store.set({ viewport });
    assert.deepEqual(next.viewport, viewport);
    assert.equal(next.windowBounds, DEFAULTS.windowBounds);
    assert.deepEqual(store.get().viewport, viewport);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("settings persist across a fresh store instance", () => {
  const { dir } = freshStore();
  try {
    new SettingsStore(dir).set({
      viewport: { cx: 1, cy: 2, zoom: 3 },
      windowBounds: { x: 10, y: 20, width: 1100, height: 700 },
    });
    const reread = new SettingsStore(dir).get();
    assert.deepEqual(reread.viewport, { cx: 1, cy: 2, zoom: 3 });
    assert.deepEqual(reread.windowBounds, {
      x: 10,
      y: 20,
      width: 1100,
      height: 700,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("set rejects a non-object patch", () => {
  const { dir, store } = freshStore();
  try {
    for (const bad of [null, undefined, "dark", 7, ["viewport"]]) {
      assert.throws(() => store.set(bad), { code: "INVALID_ARG" });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt settings file degrades to the defaults", () => {
  const { dir, store } = freshStore();
  try {
    fs.writeFileSync(path.join(dir, "settings.json"), "{ nope");
    assert.deepEqual(store.get(), { ...DEFAULTS });
    // …and the store keeps working afterwards.
    store.set({ viewport: { cx: 5, cy: 5, zoom: 2 } });
    assert.deepEqual(store.get().viewport, { cx: 5, cy: 5, zoom: 2 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
