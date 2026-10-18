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

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const {
  senderAllowed,
  guardIpcMain,
  FORBIDDEN,
  AUX_CHANNELS,
} = require("../ipc-guard");

const APP = { isApp: true, memoryCompId: null, isChipDesigner: false };
const INSPECTOR = { isApp: false, memoryCompId: "c3", memoryGuid: "g-3", isChipDesigner: false }; // prettier-ignore
const DESIGNER = { isApp: false, memoryCompId: null, isChipDesigner: true };
const PINOUT = { isApp: false, memoryCompId: null, isChipDesigner: false, isPinout: true }; // prettier-ignore
const MONITOR = { isApp: false, memoryCompId: null, isChipDesigner: false, isCpuMonitor: true }; // prettier-ignore
const TERMINAL = { isApp: false, memoryCompId: null, terminalCompId: "c7", isChipDesigner: false }; // prettier-ignore
const DOCS = { isApp: false, memoryCompId: null, isChipDesigner: false, isDocs: true }; // prettier-ignore
const LOG = { isApp: false, memoryCompId: null, isChipDesigner: false, isSerialLog: true }; // prettier-ignore
const UNKNOWN = { isApp: false, memoryCompId: null, isChipDesigner: false };
const AUX = [INSPECTOR, DESIGNER, PINOUT, MONITOR, DOCS, LOG, UNKNOWN];

test("the app window may call everything", () => {
  for (const ch of [
    "project:save",
    "desktop:import",
    "updater:install",
    "updater:check",
    "mem:program",
    "memory:open",
    "settings:set",
    "settings:choose-datasheet-dir",
    "menu:edit-state",
    "a:channel-added-later",
  ]) {
    // prettier-ignore
    assert.equal(senderAllowed(ch, [{}], APP), true, ch);
  }
});

test("deny by default: an auxiliary window may call only what it uses", () => {
  for (const who of AUX) {
    for (const ch of [
      "project:save",
      "project:open",
      "desktop:export",
      "updater:install",
      "updater:check",
      "settings:choose-datasheet-dir",
      "datasheet:download:cancel",
      "menu:edit-state",
      "menu:desktop-state",
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
      "serial:log:open",
      "datasheet:download",
      "integration:save-file",
      "ai:start",
      "a:channel-added-later",
    ]) {
      // prettier-ignore
      assert.equal(senderAllowed(ch, [], who), false, ch);
    }
    // What every window reads.
    assert.equal(senderAllowed("i18n:load", [], who), true);
    assert.equal(senderAllowed("settings:get", [], who), true);
  }
  assert.equal(senderAllowed("docs:read", [], DOCS), true);
  assert.equal(senderAllowed("docs:read", [], PINOUT), false);
  assert.equal(senderAllowed("pinout:chip", [], PINOUT), true);
  assert.equal(senderAllowed("demo:open", [], PINOUT), true);
  assert.equal(senderAllowed("demo:open", [], DOCS), false);
  assert.equal(senderAllowed("serial:log:read", [], LOG), true);
  assert.equal(senderAllowed("serial:mock:send", [], LOG), true);
  assert.equal(senderAllowed("serial:mock:send", [], PINOUT), false);
});

test("an inspector reads its OWN chip's file, exports, and speaks for its own chip only", () => {
  assert.equal(senderAllowed("mem:load", ["g-3", 32768], INSPECTOR), true);
  assert.equal(senderAllowed("mem:load", ["g-9", 32768], INSPECTOR), false, "another chip's file"); // prettier-ignore
  assert.equal(senderAllowed("mem:load", ["g-3"], { ...INSPECTOR, memoryGuid: null }), false, "told of no chip yet"); // prettier-ignore
  assert.equal(senderAllowed("mem:export", [], INSPECTOR), true);
  assert.equal(senderAllowed("mem:load", ["g-3"], PINOUT), false);
  assert.equal(senderAllowed("memory:to-host", ["c3", {}], INSPECTOR), true);
  assert.equal(senderAllowed("memory:to-host", ["c9", {}], INSPECTOR), false);
  assert.equal(senderAllowed("memory:to-host", ["c3", {}], PINOUT), false);
  assert.equal(senderAllowed("memory:to-host", ["c3", {}], APP), false);
});

test("the designer may write its own layout settings, nothing else", () => {
  assert.equal(senderAllowed("settings:set", [{ chipDesignerLeftWidth: 400 }], DESIGNER), true); // prettier-ignore
  assert.equal(senderAllowed("settings:set", [{ datasheetDir: "/x" }], DESIGNER), false); // prettier-ignore
  assert.equal(senderAllowed("settings:set", [{ chipDesignerLeftWidth: 1, theme: "dark" }], DESIGNER), false); // prettier-ignore
  assert.equal(senderAllowed("settings:set", [{ chipDesignerLeftWidth: 1 }], PINOUT), false); // prettier-ignore
  assert.equal(senderAllowed("chipdesign:to-host", [{}], DESIGNER), true);
  assert.equal(senderAllowed("chipdesign:to-host", [{}], PINOUT), false);
});

test("only the CPU monitor speaks for the CPU monitor", () => {
  assert.equal(senderAllowed("cpumonitor:to-host", [{}], MONITOR), true);
  for (const who of [APP, INSPECTOR, DESIGNER, PINOUT]) {
    assert.equal(senderAllowed("cpumonitor:to-host", [{}], who), false);
  }
  assert.equal(senderAllowed("cpumonitor:open", [], APP), true);
  assert.equal(senderAllowed("cpumonitor:to-window", [{}], APP), true);
});

// ── The lists, held to the code ─────────────────────────────────────────────
// Each auxiliary window's entry script and everything it imports, read for
// the bridge calls it makes: every channel it reaches must be allowed it (or
// the window breaks), and every channel listed for it must be one it reaches
// (or the list has gone stale and opens a door nobody uses).

const WEB = path.join(__dirname, "..", "..", "web");

/** The preload's bridge, as `{path: ["mem", "load"], channel}` per method. */
function bridgeMethods() {
  let api = null;
  let last = null;
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, value) => (api = value) },
    ipcRenderer: { invoke: (ch) => (last = ch), on() {}, send() {}, removeListener() {} }, // prettier-ignore
  };
  const realLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === "electron") return electron;
    return realLoad.call(this, request, ...rest);
  };
  const preload = require.resolve("../preload");
  try {
    delete require.cache[preload];
    require(preload);
  } finally {
    Module._load = realLoad;
    delete require.cache[preload];
  }
  const out = [];
  const walk = (obj, at) => {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "function") {
        last = null;
        try {
          value();
        } catch {
          // a method that needs real arguments to get as far as invoke
        }
        if (last) out.push({ path: [...at, key], channel: last });
      } else if (value && typeof value === "object") walk(value, [...at, key]);
    }
  };
  walk(api, []);
  return out;
}

/** The source of an entry script and every module it imports, relatively. */
function moduleGraph(entry) {
  const seen = new Set();
  const todo = [path.join(WEB, "scripts", entry)];
  let text = "";
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, "utf8");
    text += src;
    for (const m of src.matchAll(
      /(?:import|from)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g,
    )) {
      todo.push(path.resolve(path.dirname(file), m[1]));
    }
  }
  return text;
}

/** Which channels a window's code reaches through the bridge. */
function channelsUsed(entry, methods) {
  const text = moduleGraph(entry);
  const used = new Set();
  for (const { path: p, channel } of methods) {
    // `mem.load(`, `mem?.load?.(` — the last two names, then the call.
    const names = p.slice(-2).join(String.raw`\??\.`);
    const re = new RegExp(String.raw`\b${names}\??\.?\(`);
    if (re.test(text)) used.add(channel);
  }
  return used;
}

const WINDOWS = [
  ["pinout.js", "pinout", PINOUT],
  ["docs-window.js", "docs", DOCS],
  ["serial-log.js", "serialLog", LOG],
  ["memory.js", "memory", INSPECTOR],
  ["chip-designer.js", "chipDesigner", DESIGNER],
  ["cpu-monitor.js", "cpuMonitor", MONITOR],
  ["terminal.js", "terminal", TERMINAL],
];

test("each auxiliary window is allowed exactly the channels its code calls", () => {
  const methods = bridgeMethods();
  assert.ok(methods.length > 50, `${methods.length} bridge methods read`);
  for (const [entry, kind, who] of WINDOWS) {
    const used = channelsUsed(entry, methods);
    for (const ch of used) {
      const args = ch === "mem:load" ? [who.memoryGuid] : ch === "memory:to-host" ? [who.memoryCompId] : ch === "terminal:to-host" ? [who.terminalCompId] : ch === "settings:set" ? [{ chipDesignerX: 1 }] : []; // prettier-ignore
      assert.equal(senderAllowed(ch, args, who), true, `${entry} calls ${ch}`);
    }
    for (const ch of AUX_CHANNELS[kind]) {
      assert.ok(
        used.has(ch),
        `${kind} lists ${ch}, which ${entry} never calls`,
      );
    }
  }
});

test("the windows reach the bridge only in the shapes that audit can read", () => {
  // `channelsUsed` reads `name.method(` — a method pulled off by destructuring
  // (`const { load } = bridge.mem`) or reached by a computed member
  // (`bridge[area]`) would be called unseen, and refused at runtime. So
  // neither is allowed in an auxiliary window's code: a call stays visible.
  const root = String.raw`(?:window\.)?(?:chiphippo|bridge)\b`;
  const destructured = new RegExp(String.raw`\}\s*=\s*${root}(?:\??\.\w+)+`);
  const computed = new RegExp(String.raw`${root}(?:\??\.\w+)*\??\.?\[`);
  for (const [entry] of WINDOWS) {
    const text = moduleGraph(entry);
    assert.doesNotMatch(text, destructured, `${entry}: a destructured bridge method`); // prettier-ignore
    assert.doesNotMatch(text, computed, `${entry}: a computed bridge member`); // prettier-ignore
  }
  // …and the checks themselves can see one.
  assert.match("const { load } = bridge.mem;", destructured);
  assert.match("const { load } = window.chiphippo?.mem;", destructured);
  assert.match("bridge.mem[name](guid)", computed);
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

test("a Terminal speaks for its own adapter only, and calls nothing else", () => {
  assert.equal(senderAllowed("terminal:to-host", ["c7", {}], TERMINAL), true);
  assert.equal(senderAllowed("terminal:to-host", ["c8", {}], TERMINAL), false);
  assert.equal(senderAllowed("terminal:to-host", ["c7", {}], APP), false);
  assert.equal(senderAllowed("terminal:open", ["c7"], TERMINAL), false);
  assert.equal(senderAllowed("project:save", [], TERMINAL), false);
  assert.equal(senderAllowed("i18n:load", [], TERMINAL), true);
  assert.equal(senderAllowed("terminal:to-window", ["c7", {}], APP), true);
});
