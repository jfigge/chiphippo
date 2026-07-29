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

test("the Settings-dialog keys carry their shipped defaults", () => {
  assert.equal(DEFAULTS.selectionColor, "#d0804a");
  assert.equal(DEFAULTS.defaultLedColor, "red");
});

test("the parts tray opens by default, at its shipped width", () => {
  assert.equal(DEFAULTS.paletteOpen, true);
  // Matches the .palette-panel CSS fallback; the tray's right edge writes it.
  assert.equal(DEFAULTS.paletteWidth, 232);
});

test("both bottom-docked panels ship shut, at the same height", () => {
  assert.equal(DEFAULTS.scopeOpen, false);
  assert.equal(DEFAULTS.aiOpen, false);
  assert.equal(DEFAULTS.aiHeight, DEFAULTS.scopeHeight);
});

test("the AI connection ships unconfigured, and carries NO key", () => {
  assert.deepEqual(DEFAULTS.ai, {
    provider: "anthropic",
    baseUrl: "",
    model: "",
  });
  // The key lives OS-encrypted in credential-store.js. Settings is plaintext
  // and is handed back to the renderer whole, so a key here would be readable
  // on disk and re-seeded into the dialog on every open.
  assert.equal(
    JSON.stringify(DEFAULTS).toLowerCase().includes("key"),
    false,
    "no key-shaped field anywhere in the defaults",
  );
});

test("set persists a Settings-dialog patch (selection colour + LED colour)", () => {
  const { dir, store } = freshStore();
  try {
    const next = store.set({
      selectionColor: "#ff8800",
      defaultLedColor: "green",
    });
    assert.equal(next.selectionColor, "#ff8800");
    assert.equal(next.defaultLedColor, "green");
    // A fresh reader sees the persisted values, other defaults intact.
    const reread = new SettingsStore(dir).get();
    assert.equal(reread.selectionColor, "#ff8800");
    assert.equal(reread.defaultLedColor, "green");
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
