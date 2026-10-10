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

// Which window may call which channel (ipc-guard.js).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { senderAllowed, guardIpcMain, FORBIDDEN } = require("../ipc-guard");

const APP = { isApp: true, memoryCompId: null, isChipDesigner: false };
const INSPECTOR = { isApp: false, memoryCompId: "c3", isChipDesigner: false };
const DESIGNER = { isApp: false, memoryCompId: null, isChipDesigner: true };
const PINOUT = { isApp: false, memoryCompId: null, isChipDesigner: false };
const MONITOR = { isApp: false, memoryCompId: null, isChipDesigner: false, isCpuMonitor: true }; // prettier-ignore

test("the app window may call everything", () => {
  for (const ch of [
    "project:save",
    "desktop:import",
    "updater:install",
    "mem:program",
    "memory:open",
    "settings:set",
  ]) {
    // prettier-ignore
    assert.equal(senderAllowed(ch, [{}], APP), true, ch);
  }
});

test("an auxiliary window may not touch projects, ROM files, the serial port, downloads or the updater", () => {
  for (const who of [INSPECTOR, DESIGNER, PINOUT, MONITOR]) {
    for (const ch of [
      "project:save",
      "project:open",
      "desktop:export",
      "updater:install",
      "chipdesign:open",
      "cpumonitor:open",
      "cpumonitor:to-window",
      "memory:open",
      "memory:to-inspector",
      "mem:create",
      "mem:program",
      "mem:write",
      "mem:delete",
      "mem:path",
      "mem:pick-image",
      "serial:open",
      "serial:send",
      "serial:close",
      "datasheet:download",
      "integration:save-file",
    ]) {
      // prettier-ignore
      assert.equal(senderAllowed(ch, [], who), false, ch);
    }
  }
});

test("an inspector reads and exports images, and speaks for its OWN chip only", () => {
  assert.equal(senderAllowed("mem:load", [], INSPECTOR), true);
  assert.equal(senderAllowed("mem:export", [], INSPECTOR), true);
  assert.equal(senderAllowed("mem:load", [], PINOUT), false);
  assert.equal(senderAllowed("memory:to-host", ["c3", {}], INSPECTOR), true);
  assert.equal(senderAllowed("memory:to-host", ["c9", {}], INSPECTOR), false);
  assert.equal(senderAllowed("memory:to-host", ["c3", {}], PINOUT), false);
});

test("the designer may write its own layout settings, nothing else", () => {
  assert.equal(senderAllowed("settings:set", [{ chipDesignerLeftWidth: 400 }], DESIGNER), true); // prettier-ignore
  assert.equal(senderAllowed("settings:set", [{ datasheetDir: "/x" }], DESIGNER), false); // prettier-ignore
  assert.equal(senderAllowed("settings:set", [{ chipDesignerLeftWidth: 1, theme: "dark" }], DESIGNER), false); // prettier-ignore
  assert.equal(senderAllowed("settings:set", [{ chipDesignerLeftWidth: 1 }], PINOUT), false); // prettier-ignore
});

test("only the CPU monitor speaks for the CPU monitor", () => {
  assert.equal(senderAllowed("cpumonitor:to-host", [{}], MONITOR), true);
  for (const who of [APP, INSPECTOR, DESIGNER, PINOUT]) {
    assert.equal(senderAllowed("cpumonitor:to-host", [{}], who), false);
  }
  assert.equal(senderAllowed("cpumonitor:open", [], APP), true);
  assert.equal(senderAllowed("cpumonitor:to-window", [{}], APP), true);
});

test("everything else is open — reads, the docs, a pinout's own calls", () => {
  for (const ch of [
    "settings:get",
    "docs:read",
    "pinout:chip",
    "i18n:load",
    "serial:log",
  ]) {
    // prettier-ignore
    assert.equal(senderAllowed(ch, [], PINOUT), true, ch);
  }
});

test("guardIpcMain answers a refused call with FORBIDDEN and never runs it", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const app = {};
  const other = {};
  guardIpcMain(ipcMain, (sender) => (sender === app ? APP : PINOUT));
  let ran = 0;
  ipcMain.handle("project:save", () => (ran++, { ok: true }));
  assert.deepEqual(await handlers.get("project:save")({ sender: app }), { ok: true }); // prettier-ignore
  assert.equal(handlers.get("project:save")({ sender: other }), FORBIDDEN);
  assert.equal(ran, 1);
});
