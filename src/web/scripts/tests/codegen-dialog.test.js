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
// jsdom tests for components/codegen-dialog.js — the toolbar's Generate. The
// pure `codegenStatus` is what the toolbar's staleness dot is computed from,
// so its four answers are pinned first; then the dialog: one row per
// connection the desktop uses, Copy and Save aimed at THAT connection's
// header, and a save recording the hash that makes the row read up to date.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { CodegenDialog, codegenStatus } =
  await import("../components/codegen-dialog.js");
const { PopupManager } = await import("../popup-manager.js");
const { DeskDoc } = await import("../model/desk-doc.js");
const { designHash, hashHex } = await import("../model/integration-codegen.js");
const { normalizeConnection, CONNECTION_DEFAULTS, MOCK_CONNECTION } =
  await import("../model/serial-connections.js");

const conn = (id, name, extra = {}) =>
  normalizeConnection({
    id,
    name,
    ...CONNECTION_DEFAULTS,
    port: "/dev/cu.x",
    ...extra,
  });

function design() {
  const doc = new DeskDoc(null);
  doc.addIntegration({ kind: "output", connection: "conn-a", name: "Lamp" });
  doc.addIntegration({ kind: "input", width: 8, connection: "conn-a", name: "Keys" }); // prettier-ignore
  doc.addIntegration({ kind: "output", connection: "conn-b", name: "Motor" });
  doc.addIntegration({ kind: "output", name: "Loose" });
  return doc.integrations;
}

const CONNECTIONS = [conn("conn-a", "Nano"), conn("conn-b", "Uno")];

test("codegenStatus: one row per USED connection, with its counts", () => {
  const status = codegenStatus(design(), CONNECTIONS, () => null);
  assert.deepEqual(
    status.rows.map((r) => [r.id, r.outputs, r.inputs]),
    [
      ["conn-a", 1, 1],
      ["conn-b", 1, 0],
    ],
  );
  assert.equal(status.unassigned, 1, "the loose Output is counted apart");
});

test("codegenStatus: never generated, current, and stale", () => {
  const elements = design();
  const hashA = hashHex(designHash(CONNECTIONS[0], elements));
  const stored = { "conn-a": hashA, "conn-b": "0xDEADBEEF" };
  const status = codegenStatus(elements, CONNECTIONS, (id) => stored[id]);
  assert.deepEqual(
    status.rows.map((r) => r.status),
    ["current", "stale"],
  );
  assert.equal(status.rows[0].hash, hashA);
  assert.equal(status.stale, true, "one stale row lights the dot");

  const never = codegenStatus(elements, CONNECTIONS, (id) =>
    id === "conn-a" ? hashA : null,
  );
  assert.equal(never.rows[1].status, "never");
  assert.equal(never.stale, true, "a header never generated counts too");

  const allCurrent = codegenStatus(elements, CONNECTIONS, (id) =>
    hashHex(
      designHash(
        CONNECTIONS.find((c) => c.id === id),
        elements,
      ),
    ),
  );
  assert.equal(allCurrent.stale, false);
});

test("codegenStatus: a design change makes a current header stale", () => {
  const elements = design();
  const hashA = hashHex(designHash(CONNECTIONS[0], elements));
  const renamed = elements.map((e) =>
    e.name === "Lamp" ? { ...e, name: "Beacon" } : e,
  );
  const status = codegenStatus(renamed, CONNECTIONS, () => hashA);
  assert.equal(status.rows[0].status, "stale");
});

test("codegenStatus: a connection this computer does not know is 'unknown', not stale", () => {
  const status = codegenStatus(design(), [CONNECTIONS[0]], () => null);
  const b = status.rows.find((r) => r.id === "conn-b");
  assert.equal(b.status, "unknown");
  assert.equal(b.hash, null);
});

test("codegenStatus: no elements, no rows, nothing stale", () => {
  assert.deepEqual(
    codegenStatus([], CONNECTIONS, () => null),
    {
      rows: [],
      unassigned: 0,
      mock: false,
      stale: false,
    },
  );
});

test("codegenStatus: the Mock gets no row and is never stale", () => {
  const elements = [
    ...design(),
    { id: "out9", kind: "output", connection: "mock", fields: [] },
  ];
  const status = codegenStatus(
    elements,
    [MOCK_CONNECTION, ...CONNECTIONS],
    () => null,
  );
  assert.deepEqual(
    status.rows.map((r) => r.id),
    ["conn-a", "conn-b"],
  );
  assert.equal(status.mock, true);
  const onlyMock = codegenStatus(
    [{ id: "out1", kind: "output", connection: "mock", fields: [] }],
    [MOCK_CONNECTION],
    () => null,
  );
  assert.deepEqual(onlyMock.rows, []);
  assert.equal(onlyMock.mock, true);
  assert.equal(onlyMock.stale, false, "no dot for the Mock");
});

function openDialog({
  connections = CONNECTIONS,
  elements = design(),
  saveResult = { ok: true, path: "/sketch/ChipHippo.h" },
} = {}) {
  const win = resetDom();
  globalThis.CSS ??= { escape: (s) => String(s) };
  const stored = {};
  const saves = [];
  const recorded = [];
  CodegenDialog.open({
    elements,
    connections,
    projectName: "Bench",
    desktopName: "Desktop 1",
    appVersion: "1.2.3",
    storedHash: (id) => stored[id] ?? null,
    onSaved: (id, hash) => {
      stored[id] = hash;
      recorded.push([id, hash]);
    },
    bridge: {
      integration: {
        saveHeader: async (text, name) => {
          saves.push({ text, name });
          return saveResult; // null is the Save panel cancelled
        },
      },
    },
  });
  const row = (id) =>
    win.document.querySelector(`.codegen-row[data-connection-id="${id}"]`);
  const button = (id, label) =>
    [...row(id).querySelectorAll("button")].find(
      (b) => b.textContent === label,
    );
  return { win, row, button, saves, recorded, stored };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("the dialog shows one row per used connection, named, with its status", () => {
  const { win, row } = openDialog();
  try {
    const rows = [...win.document.querySelectorAll(".codegen-row")];
    assert.equal(rows.length, 2);
    assert.equal(
      row("conn-a").querySelector(".codegen-name").textContent,
      "Nano",
    );
    assert.equal(
      row("conn-a").querySelector(".codegen-status").textContent,
      "Not generated yet",
    );
    assert.equal(
      row("conn-a").querySelector(".codegen-counts").textContent,
      "Outputs: 1 · Inputs: 1",
    );
    assert.match(
      win.document.querySelector(".codegen-popup").textContent,
      /1 element has no connection/,
    );
  } finally {
    PopupManager.close();
  }
});

test("Save writes THAT connection's header, records its hash, and the row reads up to date", async () => {
  const { row, button, saves, recorded } = openDialog();
  try {
    button("conn-b", "Save header…").click();
    await settle();
    assert.equal(saves.length, 1);
    assert.equal(saves[0].name, "ChipHippo.h");
    assert.match(saves[0].text, /Motor/, "the Uno's header carries its Output");
    assert.doesNotMatch(saves[0].text, /Lamp/, "and not the Nano's");
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0][0], "conn-b");
    assert.match(recorded[0][1], /^0x[0-9A-F]{8}$/);
    assert.equal(
      row("conn-b").querySelector(".codegen-status").textContent,
      "Up to date",
    );
    assert.equal(
      row("conn-b").querySelector(".codegen-result").textContent,
      "Saved to /sketch/ChipHippo.h",
    );
    assert.equal(
      row("conn-a").querySelector(".codegen-status").textContent,
      "Not generated yet",
      "the other connection is untouched",
    );
  } finally {
    PopupManager.close();
  }
});

test("a cancelled save records nothing; a failed one says why", async () => {
  const cancelled = openDialog({ saveResult: null });
  try {
    cancelled.button("conn-a", "Save header…").click();
    await settle();
    assert.equal(cancelled.recorded.length, 0);
  } finally {
    PopupManager.close();
  }
  const failed = openDialog({ saveResult: { ok: false, error: "EACCES" } });
  try {
    failed.button("conn-a", "Save header…").click();
    await settle();
    assert.equal(failed.recorded.length, 0);
    assert.equal(
      failed.row("conn-a").querySelector(".codegen-result").textContent,
      "Couldn't save the file: EACCES",
    );
  } finally {
    PopupManager.close();
  }
});

test("a connection this computer does not know offers nothing to save", () => {
  const { row, button } = openDialog({ connections: [CONNECTIONS[0]] });
  try {
    assert.equal(
      row("conn-b").querySelector(".codegen-status").textContent,
      "Not configured on this computer",
    );
    assert.equal(button("conn-b", "Save header…").disabled, true);
    assert.equal(button("conn-b", "Copy").disabled, true);
    assert.equal(button("conn-a", "Save header…").disabled, false);
  } finally {
    PopupManager.close();
  }
});

test("a desktop with nothing connected says so instead of listing rows", () => {
  const doc = new DeskDoc(null);
  doc.addIntegration({ kind: "output" });
  const { win } = openDialog({ elements: doc.integrations });
  try {
    assert.equal(win.document.querySelectorAll(".codegen-row").length, 0);
    assert.match(
      win.document.querySelector(".codegen-list").textContent,
      /No Output or Input on this desktop has a connection/,
    );
  } finally {
    PopupManager.close();
  }
});

test("Copy puts that connection's header on the clipboard", async () => {
  const copied = [];
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText: async (text) => copied.push(text) },
    configurable: true,
  });
  const { row, button } = openDialog();
  try {
    button("conn-a", "Copy").click();
    await settle();
    assert.equal(copied.length, 1);
    assert.match(copied[0], /Lamp/);
    assert.equal(
      row("conn-a").querySelector(".codegen-result").textContent,
      "Copied to the clipboard.",
    );
  } finally {
    PopupManager.close();
    delete globalThis.navigator.clipboard;
  }
});

test("a desktop entirely on the Mock is told it has nothing to generate", () => {
  const { win } = openDialog({
    connections: [MOCK_CONNECTION],
    elements: [{ id: "out1", kind: "output", connection: "mock", fields: [] }],
  });
  try {
    assert.equal(win.document.querySelectorAll(".codegen-row").length, 0);
    assert.match(
      win.document.querySelector(".codegen-popup").textContent,
      /on the Mock, which needs no code/,
    );
  } finally {
    PopupManager.close();
  }
});

/** Close the viewer, then the Generate card it hands back to. */
async function closeViewer() {
  PopupManager.close();
  await settle();
  PopupManager.close();
}

test("View files replaces the card with THAT connection's header and example, one tab each", async () => {
  const { win, button } = openDialog();
  try {
    button("conn-a", "View files…").click();
    const doc = win.document;
    assert.equal(
      doc.querySelector(".codegen-popup"),
      null,
      "the card made way",
    );
    const viewer = doc.querySelector(".code-files-popup");
    assert.equal(
      viewer.querySelector(".popup-title").textContent,
      "Nano — header and example",
    );
    const tabs = [...viewer.querySelectorAll(".code-files-tab")];
    assert.deepEqual(
      tabs.map((b) => [b.textContent, b.getAttribute("aria-selected")]),
      [
        ["ChipHippo.h", "true"],
        ["ChipHippoExample.ino", "false"],
      ],
    );
    const panels = [...viewer.querySelectorAll(".code-files-panel")];
    assert.deepEqual(
      panels.map((p) => p.hidden),
      [false, true],
    );

    // Each file is a line-numbered table: row n reads n, then line n.
    const header = panels[0].querySelectorAll("tr");
    assert.equal(header[0].cells[0].textContent, "1");
    assert.match(header[0].cells[1].textContent, /^\/\/ ChipHippo\.h/);
    assert.ok(
      [...header].some((r) => /void LampIn\(bool/.test(r.cells[1].textContent)),
      "the Nano's Output, by its In name",
    );
    assert.ok(
      ![...header].some((r) => /Motor/.test(r.cells[1].textContent)),
      "and not the Uno's",
    );

    tabs[1].click();
    assert.deepEqual(
      panels.map((p) => p.hidden),
      [true, false],
    );
    assert.equal(tabs[1].getAttribute("aria-selected"), "true");
    const example = [...panels[1].querySelectorAll(".code-files-code")].map(
      (c) => c.textContent,
    );
    assert.ok(example.includes('#include "ChipHippo.h"'));
    assert.ok(example.includes("  ChipHippo.KeysOut.send();"));
    assert.equal(
      panels[1].querySelectorAll("tr").length,
      example.length,
      "one row per line",
    );
  } finally {
    await closeViewer();
  }
});

test("Copy in the viewer takes the file on show; closing the viewer brings the card back", async () => {
  const copied = [];
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText: async (text) => copied.push(text) },
    configurable: true,
  });
  const { win, button } = openDialog();
  try {
    button("conn-a", "View files…").click();
    const viewer = win.document.querySelector(".code-files-popup");
    viewer.querySelectorAll(".code-files-tab")[1].click();
    [...viewer.querySelectorAll("button")]
      .find((b) => b.textContent === "Copy")
      .click();
    await settle();
    assert.equal(copied.length, 1);
    assert.match(copied[0], /^\/\/ ChipHippoExample\.ino/);
    assert.equal(
      viewer.querySelector(".code-files-result").textContent,
      "Copied ChipHippoExample.ino to the clipboard.",
    );

    PopupManager.close();
    await settle();
    assert.equal(win.document.querySelector(".code-files-popup"), null);
    assert.ok(
      win.document.querySelector('.codegen-row[data-connection-id="conn-a"]'),
      "back on the Generate card",
    );
    PopupManager.close();
  } finally {
    delete globalThis.navigator.clipboard;
  }
});

test("a connection this computer does not know has no files to view", () => {
  const { button } = openDialog({ connections: [CONNECTIONS[0]] });
  try {
    assert.equal(button("conn-b", "View files…").disabled, true);
    assert.equal(button("conn-a", "View files…").disabled, false);
  } finally {
    PopupManager.close();
  }
});

test("a Python connection's row saves chiphippo.py, and its files are the module and three programs", async () => {
  const elements = design();
  const connections = [
    conn("conn-a", "Pico", { language: "python" }),
    CONNECTIONS[1],
  ];
  const { win, row, button, saves } = openDialog({ connections, elements });
  try {
    assert.equal(
      row("conn-a").querySelector(".codegen-language").textContent,
      "Python module for MicroPython and CircuitPython",
    );
    assert.equal(
      row("conn-b").querySelector(".codegen-language").textContent,
      "C++ header for Arduino",
    );
    assert.equal(button("conn-a", "Save header…"), undefined);
    button("conn-a", "Save module…").click();
    await settle();
    assert.equal(saves[0].name, "chiphippo.py");
    assert.match(saves[0].text, /^# chiphippo\.py — generated by Chip Hippo/);
    assert.match(saves[0].text, /def lamp_in\(self, fn\):/);

    button("conn-a", "View files…").click();
    const viewer = win.document.querySelector(".code-files-popup");
    assert.equal(
      viewer.querySelector(".popup-title").textContent,
      "Pico — module and examples",
    );
    assert.deepEqual(
      [...viewer.querySelectorAll(".code-files-tab")].map((b) => b.textContent),
      ["chiphippo.py", "main.py", "code.py", "boot.py"],
    );
  } finally {
    await closeViewer();
  }
});

test("a Python connection off 115200 baud, 8N1 says why a USB-serial-chip board will not connect", () => {
  const { row } = openDialog({
    connections: [conn("conn-a", "ESP32", { language: "python", baud: 9600 })],
  });
  try {
    assert.match(
      row("conn-a").querySelector(".codegen-warnings").textContent,
      /This connection is set to 9600 baud, 8N1\. .* always talks at 115200 baud, 8N1/,
    );
  } finally {
    PopupManager.close();
  }
});
