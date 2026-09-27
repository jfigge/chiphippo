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

// Tests for ipc/serial.js's CONNECTION WINDOWS — where each was and how it
// was showing its stream, remembered in settings.connectionWindows. Pinned:
// the state is keyed by the connection's ID (so a rename keeps it), a window
// reopens where it was left, the built-in Mock is remembered like any other,
// and deleting a connection deletes its window's state — including when its
// window is still open and closes afterwards.

const test = require("node:test");
const assert = require("node:assert/strict");

const { registerSerialIpc } = require("../ipc/serial");

class FakeWindow {
  static made = [];
  constructor(opts) {
    this.opts = opts;
    this.bounds = { x: opts.x ?? 50, y: opts.y ?? 50, width: opts.width, height: opts.height }; // prettier-ignore
    this.handlers = {};
    this.destroyed = false;
    this.webContents = { send() {} };
    FakeWindow.made.push(this);
  }
  static fromWebContents() {
    return null;
  }
  on(event, fn) {
    (this.handlers[event] ??= []).push(fn);
    return this;
  }
  once(event, fn) {
    return this.on(event, fn);
  }
  emit(event, ...args) {
    for (const fn of this.handlers[event] ?? []) fn(...args);
  }
  setMenuBarVisibility() {}
  loadFile() {
    return Promise.resolve();
  }
  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return false;
  }
  isVisible() {
    return true;
  }
  getNormalBounds() {
    return { ...this.bounds };
  }
  setTitle(title) {
    this.opts.title = title;
  }
  show() {}
  focus() {}
  showInactive() {}
  /** The user moves it and closes it: the close flushes the save. */
  moveAndClose(bounds) {
    this.bounds = bounds;
    this.emit("close");
    this.destroyed = true;
    this.emit("closed");
  }
}

const NANO = { id: "conn-0a0b0c0d0e0f", name: "Nano", port: "/dev/cu.nano" };
const UNO = { id: "conn-111111111111", name: "Uno", port: "/dev/cu.uno" };

function setup(connections = [NANO, UNO]) {
  FakeWindow.made = [];
  const settings = { serialConnections: connections, connectionWindows: {} };
  const handlers = new Map();
  const ipc = registerSerialIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    BrowserWindow: FakeWindow,
    dialog: {},
    getSettings: () => settings,
    setSettings: (patch) => Object.assign(settings, patch),
    getDisplays: () => [{ workArea: { x: 0, y: 0, width: 2560, height: 1440 } }], // prettier-ignore
    getMainWindow: () => null,
    m: (_key, fallback) => fallback,
    windowBackground: () => "#000",
    appDir: __dirname,
  });
  const invoke = (channel, ...args) => handlers.get(channel)({}, ...args);
  /** Settings ▸ Integration writing the list, as main's settings:set does. */
  const setConnections = (list) => {
    settings.serialConnections = list;
    ipc.retitleLogs();
    ipc.forgetDeletedWindows();
  };
  return { settings, invoke, setConnections };
}

const HERE = { x: 300, y: 200, width: 700, height: 500 };

test("a window reopens where it was left, remembered under its connection's id", () => {
  const { settings, invoke } = setup();
  invoke("serial:log:open", NANO.id);
  FakeWindow.made[0].moveAndClose(HERE);
  assert.deepEqual(Object.keys(settings.connectionWindows), [NANO.id]);
  assert.deepEqual(settings.connectionWindows[NANO.id].bounds, HERE);
  invoke("serial:log:open", NANO.id);
  const reopened = FakeWindow.made[1].opts;
  assert.deepEqual(
    { x: reopened.x, y: reopened.y, width: reopened.width, height: reopened.height }, // prettier-ignore
    HERE,
  );
});

test("each connection keeps its own window, and filters ride with the bounds", () => {
  const { settings, invoke } = setup();
  invoke("serial:log:open", NANO.id);
  invoke("serial:log:open", UNO.id);
  invoke("serial:log:prefs", UNO.id, { protocol: true });
  FakeWindow.made[0].moveAndClose(HERE);
  FakeWindow.made[1].moveAndClose({ ...HERE, x: 900 });
  assert.equal(settings.connectionWindows[NANO.id].bounds.x, 300);
  assert.equal(settings.connectionWindows[UNO.id].bounds.x, 900);
  assert.equal(settings.connectionWindows[UNO.id].protocol, true);
  assert.equal(invoke("serial:log:read", UNO.id).view.protocol, true);
  assert.equal(invoke("serial:log:read", NANO.id).view.protocol, false);
});

test("a rename keeps the window where it was", () => {
  const { settings, invoke, setConnections } = setup();
  invoke("serial:log:open", NANO.id);
  FakeWindow.made[0].moveAndClose(HERE);
  setConnections([{ ...NANO, name: "Bench Nano" }, UNO]);
  assert.deepEqual(settings.connectionWindows[NANO.id].bounds, HERE);
  invoke("serial:log:open", NANO.id);
  assert.equal(FakeWindow.made[1].opts.x, HERE.x);
  assert.equal(FakeWindow.made[1].opts.title, "Bench Nano");
});

test("deleting a connection deletes its window's state, and only its", () => {
  const { settings, invoke, setConnections } = setup();
  invoke("serial:log:open", NANO.id);
  invoke("serial:log:open", UNO.id);
  FakeWindow.made[0].moveAndClose(HERE);
  FakeWindow.made[1].moveAndClose(HERE);
  setConnections([UNO]);
  assert.deepEqual(Object.keys(settings.connectionWindows), [UNO.id]);
});

test("a window still open when its connection is deleted saves nothing as it closes", () => {
  const { settings, invoke, setConnections } = setup();
  invoke("serial:log:open", NANO.id);
  invoke("serial:log:prefs", NANO.id, { data: false });
  setConnections([UNO]);
  assert.deepEqual(settings.connectionWindows, {});
  FakeWindow.made[0].moveAndClose(HERE);
  assert.deepEqual(settings.connectionWindows, {}, "not brought back");
});

test("the built-in Mock is remembered, and no connection list drops it", () => {
  const { settings, invoke, setConnections } = setup();
  invoke("serial:log:open", "mock");
  FakeWindow.made[0].moveAndClose(HERE);
  setConnections([]);
  assert.deepEqual(settings.connectionWindows.mock.bounds, HERE);
});

test("state kept under anything but a live connection's id is dropped", () => {
  const { settings, setConnections } = setup();
  settings.connectionWindows = {
    Nano: { bounds: HERE }, // keyed by NAME, as before
    [UNO.id]: { bounds: HERE },
  };
  setConnections([NANO, UNO]);
  assert.deepEqual(Object.keys(settings.connectionWindows), [UNO.id]);
});
