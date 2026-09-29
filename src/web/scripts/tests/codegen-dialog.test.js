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
// jsdom tests for components/codegen-dialog.js — the toolbar's Generate — and
// the file viewer it opens (components/code-files-dialog.js). The pure
// `codegenStatus` is what the toolbar's staleness dot is computed from, so its
// four answers are pinned first; then the card: one row per connection the
// desktop uses, each with ONE button — Generate (records the hash, opens the
// files) until it is in sync, View files… after; then the viewer: a text view
// per file, Select All and Copy held to the file on show (the selection, or
// the whole file), and Save As… aimed at THAT connection and design.

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
  stored = {},
  saveResult = { ok: true, path: "/sketch/ChipHippo.h" },
} = {}) {
  const win = resetDom();
  globalThis.CSS ??= { escape: (s) => String(s) };
  const saves = [];
  const recorded = [];
  const opened = [];
  CodegenDialog.open({
    elements,
    connections,
    projectName: "Bench",
    desktopName: "Desktop 1",
    appVersion: "1.2.3",
    storedHash: (id) => stored[id] ?? null,
    onGenerated: (id, hash) => {
      stored[id] = hash;
      recorded.push([id, hash]);
    },
    saveScope: "/projects/bench.chiphippo|t1",
    bridge: {
      integration: {
        saveFile: async (id, scope, name, text) => {
          saves.push({ id, scope, name, text });
          return saveResult; // null is the Save panel cancelled
        },
      },
      docs: {
        open: async (slug) => {
          opened.push(slug);
          return true;
        },
      },
    },
  });
  const row = (id) =>
    win.document.querySelector(`.codegen-row[data-connection-id="${id}"]`);
  const buttons = (id) => [...row(id).querySelectorAll("button")];
  const viewer = () => win.document.querySelector(".code-files-popup");
  const viewerButton = (label) =>
    [...viewer().querySelectorAll("button")].find(
      (b) => b.textContent === label,
    );
  return {
    win,
    row,
    buttons,
    viewer,
    viewerButton,
    saves,
    recorded,
    stored,
    opened,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Close the viewer, then the Generate card it hands back to. */
async function closeViewer() {
  PopupManager.close();
  await settle();
  PopupManager.close();
}

/** A stub clipboard for the length of `fn`; returns what was written. */
async function withClipboard(fn) {
  const copied = [];
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText: async (text) => copied.push(text) },
    configurable: true,
  });
  try {
    await fn(copied);
  } finally {
    delete globalThis.navigator.clipboard;
  }
  return copied;
}

/** The current design's hash for a connection — what "in sync" means. */
const currentHash = (connection, elements) =>
  hashHex(designHash(connection, elements));

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

test("the header's book icon, left of the ×, opens the serial protocol page and leaves the card up", async () => {
  const { win, opened } = openDialog();
  try {
    const header = win.document.querySelector(".codegen-popup .popup-header");
    const actions = header.querySelector(".popup-header-actions");
    assert.ok(actions, "the header's buttons are grouped with the ×");
    assert.deepEqual(
      [...actions.children].map((b) => b.className),
      ["popup-header-btn", "popup-close"],
      "the book sits LEFT of the close button",
    );
    const book = actions.querySelector(".popup-header-btn");
    assert.equal(book.getAttribute("aria-label"), "Serial protocol reference");
    assert.equal(book.hidden, false);
    book.click();
    await settle();
    assert.deepEqual(opened, ["serial-protocol"]);
    assert.ok(
      win.document.querySelector(".codegen-popup"),
      "the guide is a window of its own: the card stays",
    );
  } finally {
    PopupManager.close();
  }
});

test("a row has ONE button: Generate until it is in sync, View files… after", () => {
  const elements = design();
  const { buttons } = openDialog({
    elements,
    stored: {
      "conn-a": currentHash(CONNECTIONS[0], elements),
      "conn-b": "0xDEADBEEF",
    },
  });
  try {
    assert.deepEqual(
      buttons("conn-a").map((b) => b.textContent),
      ["View files…"],
      "in sync: just look",
    );
    assert.deepEqual(
      buttons("conn-b").map((b) => b.textContent),
      ["Generate"],
      "out of date: generate again",
    );
  } finally {
    PopupManager.close();
  }
});

test("Generate records THAT connection's hash, opens its files, and the card comes back up to date", async () => {
  const { win, row, buttons, viewer, recorded } = openDialog();
  try {
    buttons("conn-b")[0].click();
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0][0], "conn-b");
    assert.match(recorded[0][1], /^0x[0-9A-F]{8}$/);
    assert.equal(
      win.document.querySelector(".codegen-popup"),
      null,
      "the card made way",
    );
    assert.equal(
      viewer().querySelector(".popup-title").textContent,
      "Uno — header and example",
    );
    const header = viewer().querySelector(".code-files-code").textContent;
    assert.match(header, /Motor/, "the Uno's header carries its Output");
    assert.doesNotMatch(header, /Lamp/, "and not the Nano's");

    PopupManager.close(); // the viewer
    await settle();
    assert.equal(
      row("conn-b").querySelector(".codegen-status").textContent,
      "Up to date",
    );
    assert.deepEqual(
      buttons("conn-b").map((b) => b.textContent),
      ["View files…"],
    );
    assert.equal(
      row("conn-a").querySelector(".codegen-status").textContent,
      "Not generated yet",
      "the other connection is untouched",
    );
    assert.deepEqual(
      buttons("conn-a").map((b) => b.textContent),
      ["Generate"],
    );
  } finally {
    PopupManager.close();
  }
});

test("View files… on a row in sync opens the files and records nothing", async () => {
  const elements = design();
  const { buttons, viewer, recorded } = openDialog({
    elements,
    stored: { "conn-a": currentHash(CONNECTIONS[0], elements) },
  });
  try {
    buttons("conn-a")[0].click();
    assert.ok(viewer(), "the viewer is up");
    assert.equal(recorded.length, 0);
  } finally {
    await closeViewer();
  }
});

test("a connection this computer does not know offers nothing to generate", () => {
  const { row, buttons } = openDialog({ connections: [CONNECTIONS[0]] });
  try {
    assert.equal(
      row("conn-b").querySelector(".codegen-status").textContent,
      "Not configured on this computer",
    );
    assert.equal(buttons("conn-b")[0].disabled, true);
    assert.equal(buttons("conn-a")[0].disabled, false);
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

test("the viewer shows each file as text beside a gutter of line numbers, one tab each", async () => {
  const { buttons, viewer } = openDialog();
  try {
    buttons("conn-a")[0].click();
    const tabs = [...viewer().querySelectorAll(".code-files-tab")];
    assert.deepEqual(
      tabs.map((b) => [b.textContent, b.getAttribute("aria-selected")]),
      [
        ["ChipHippo.h", "true"],
        ["ChipHippoExample.ino", "false"],
      ],
    );
    const panels = [...viewer().querySelectorAll(".code-files-panel")];
    assert.deepEqual(
      panels.map((p) => p.hidden),
      [false, true],
    );

    // The text is ONE run (what a selection sweeps); the numbers are apart.
    const code = panels[0].querySelector(".code-files-code");
    const gutter = panels[0].querySelector(".code-files-gutter");
    assert.equal(code.tagName, "PRE");
    assert.match(code.textContent, /^\/\/ ChipHippo\.h/);
    assert.match(code.textContent, /void LampIn\(bool/, "the Nano's Output");
    assert.doesNotMatch(code.textContent, /Motor/, "and not the Uno's");
    const lines = code.textContent.split("\n");
    assert.deepEqual(
      gutter.textContent.split("\n"),
      lines.map((_, i) => String(i + 1)),
      "one number per line",
    );
    assert.equal(gutter.getAttribute("aria-hidden"), "true");

    tabs[1].click();
    assert.deepEqual(
      panels.map((p) => p.hidden),
      [true, false],
    );
    assert.equal(tabs[1].getAttribute("aria-selected"), "true");
    const example = panels[1]
      .querySelector(".code-files-code")
      .textContent.split("\n");
    assert.ok(example.includes('#include "ChipHippo.h"'));
    assert.ok(example.includes("  ChipHippo.KeysOut.send();"));
  } finally {
    await closeViewer();
  }
});

test("Copy takes the WHOLE file on show when nothing is selected; closing the viewer brings the card back", async () => {
  const { win, buttons, viewer, viewerButton } = openDialog();
  const copied = await withClipboard(async () => {
    buttons("conn-a")[0].click();
    viewer().querySelectorAll(".code-files-tab")[1].click();
    viewerButton("Copy").click();
    await settle();
    assert.equal(
      viewer().querySelector(".code-files-result").textContent,
      "Copied ChipHippoExample.ino to the clipboard.",
    );
  });
  assert.equal(copied.length, 1);
  assert.match(copied[0], /^\/\/ ChipHippoExample\.ino/);
  assert.match(copied[0], /\n$/, "the file's own text, final newline and all");

  PopupManager.close();
  await settle();
  assert.equal(viewer(), null);
  assert.ok(
    win.document.querySelector('.codegen-row[data-connection-id="conn-a"]'),
    "back on the Generate card",
  );
  PopupManager.close();
});

test("Copy takes the SELECTION when there is one, cut back to the file", async () => {
  const { win, buttons, viewer, viewerButton } = openDialog();
  const doc = win.document;
  let copied = [];
  try {
    copied = await withClipboard(async () => {
      buttons("conn-a")[0].click();
      const code = viewer().querySelector(".code-files-code");
      const text = code.firstChild;
      const at = text.data.indexOf("void LampIn");
      const range = doc.createRange();
      range.setStart(text, at);
      range.setEnd(text, at + "void LampIn".length);
      doc.getSelection().removeAllRanges();
      doc.getSelection().addRange(range);
      viewerButton("Copy").click();
      await settle();
      assert.equal(
        viewer().querySelector(".code-files-result").textContent,
        "Copied the selection to the clipboard.",
      );

      // A selection that strays from the title into the text copies only the
      // text it reached.
      const title = viewer().querySelector(".popup-title");
      const straying = doc.createRange();
      straying.setStart(title.firstChild, 0);
      straying.setEnd(text, 2);
      doc.getSelection().removeAllRanges();
      doc.getSelection().addRange(straying);
      viewerButton("Copy").click();
      await settle();
    });
  } finally {
    await closeViewer();
  }
  assert.deepEqual(copied, ["void LampIn", "//"]);
});

test("Select All and Copy keys are the file's: ⌘A selects just its text, ⌘C copies the selection or all", async () => {
  const { win, buttons, viewer } = openDialog();
  const doc = win.document;
  const key = (k) => {
    const e = new win.KeyboardEvent("keydown", {
      key: k,
      ctrlKey: true, // not macOS here: Ctrl is the modifier
      bubbles: true,
      cancelable: true,
    });
    doc.body.dispatchEvent(e);
    return e;
  };
  let header = "";
  let copied = [];
  try {
    copied = await withClipboard(async () => {
      buttons("conn-a")[0].click();
      const code = viewer().querySelector(".code-files-code");
      header = code.textContent;

      const c = key("c");
      await settle();
      assert.equal(c.defaultPrevented, true, "the native Copy stands down");

      const a = key("a");
      assert.equal(
        a.defaultPrevented,
        true,
        "and so does the native Select All",
      );
      assert.equal(doc.getSelection().toString(), code.textContent);

      // Select All in the menu, clicked rather than keyed, does the same.
      doc.getSelection().removeAllRanges();
      win.dispatchEvent(new win.CustomEvent("chiphippo:edit-select-all"));
      assert.equal(doc.getSelection().toString(), code.textContent);

      // With the other tab showing, both keys mean THAT file.
      viewer().querySelectorAll(".code-files-tab")[1].click();
      assert.equal(doc.getSelection().toString(), "", "a tab switch drops it");
      key("a");
      key("c");
      await settle();
      assert.equal(
        viewer().querySelector(".code-files-result").textContent,
        "Copied ChipHippoExample.ino to the clipboard.",
        "everything selected IS the file",
      );
    });
  } finally {
    await closeViewer();
  }
  assert.equal(copied.length, 2);
  assert.equal(copied[0], `${header}\n`, "nothing selected: the whole file");
  assert.match(copied[1], /^\/\/ ChipHippoExample\.ino/);
  assert.match(
    copied[1],
    /\n$/,
    "select-all copies the file, final newline too",
  );

  // Once the viewer is gone the keys are nobody's business here.
  const late = new win.KeyboardEvent("keydown", {
    key: "a",
    ctrlKey: true,
    cancelable: true,
  });
  doc.dispatchEvent(late);
  assert.equal(late.defaultPrevented, false);
});

test("Edit ▸ Copy from the menu is held to the file too", async () => {
  const { win, buttons, viewer } = openDialog();
  const doc = win.document;
  try {
    buttons("conn-a")[0].click();
    const title = viewer().querySelector(".popup-title");
    const text = viewer().querySelector(".code-files-code").firstChild;
    const range = doc.createRange();
    range.setStart(title.firstChild, 0);
    range.setEnd(text, 2);
    doc.getSelection().removeAllRanges();
    doc.getSelection().addRange(range);
    const data = {};
    const e = new win.Event("copy", { bubbles: true, cancelable: true });
    e.clipboardData = { setData: (type, value) => (data[type] = value) };
    doc.body.dispatchEvent(e);
    assert.equal(e.defaultPrevented, true);
    assert.deepEqual(data, { "text/plain": "//" });
  } finally {
    await closeViewer();
  }
});

test("Save As… saves the file ON SHOW, for THAT connection and design, and says where", async () => {
  const { buttons, viewer, viewerButton, saves } = openDialog();
  try {
    buttons("conn-b")[0].click();
    viewer().querySelectorAll(".code-files-tab")[1].click();
    viewerButton("Save As…").click();
    await settle();
    assert.equal(saves.length, 1);
    assert.equal(saves[0].id, "conn-b");
    assert.equal(saves[0].scope, "/projects/bench.chiphippo|t1");
    assert.equal(saves[0].name, "ChipHippoExample.ino");
    assert.match(saves[0].text, /^\/\/ ChipHippoExample\.ino/);
    assert.equal(
      viewer().querySelector(".code-files-result").textContent,
      "Saved to /sketch/ChipHippo.h",
    );
  } finally {
    await closeViewer();
  }
});

test("a cancelled Save As… says nothing; a failed one says why", async () => {
  const cancelled = openDialog({ saveResult: null });
  try {
    cancelled.buttons("conn-a")[0].click();
    cancelled.viewerButton("Save As…").click();
    await settle();
    assert.equal(cancelled.saves.length, 1);
    assert.equal(
      cancelled.viewer().querySelector(".code-files-result").textContent,
      "",
    );
  } finally {
    await closeViewer();
  }
  const failed = openDialog({ saveResult: { ok: false, error: "EACCES" } });
  try {
    failed.buttons("conn-a")[0].click();
    failed.viewerButton("Save As…").click();
    await settle();
    assert.equal(
      failed.viewer().querySelector(".code-files-result").textContent,
      "Couldn't save the file: EACCES",
    );
  } finally {
    await closeViewer();
  }
});

test("a Python connection's files are the module and three programs, each saved by its own name", async () => {
  const elements = design();
  const connections = [
    conn("conn-a", "Pico", { language: "python" }),
    CONNECTIONS[1],
  ];
  const { row, buttons, viewer, viewerButton, saves } = openDialog({
    connections,
    elements,
  });
  try {
    assert.equal(
      row("conn-a").querySelector(".codegen-language").textContent,
      "Python module for MicroPython and CircuitPython",
    );
    assert.equal(
      row("conn-b").querySelector(".codegen-language").textContent,
      "C++ header for Arduino",
    );
    buttons("conn-a")[0].click();
    assert.equal(
      viewer().querySelector(".popup-title").textContent,
      "Pico — module and examples",
    );
    const tabs = [...viewer().querySelectorAll(".code-files-tab")];
    assert.deepEqual(
      tabs.map((b) => b.textContent),
      ["chiphippo.py", "main.py", "code.py", "boot.py"],
    );
    const module = viewer().querySelector(".code-files-code").textContent;
    assert.match(module, /^# chiphippo\.py — generated by Chip Hippo/);
    assert.match(module, /def lamp_in\(self, fn\):/);

    viewerButton("Save As…").click();
    tabs[1].click();
    viewerButton("Save As…").click();
    await settle();
    assert.deepEqual(
      saves.map((s) => s.name),
      ["chiphippo.py", "main.py"],
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

test("a field renamed because it may be a core macro says so, under its connection", () => {
  const { row } = openDialog({
    connections: [conn("conn-a", "Nano")],
    elements: [
      {
        id: "out1",
        kind: "output",
        connection: "conn-a",
        name: "Regs",
        fields: [{ type: "byte", name: "SP" }],
      },
    ],
  });
  try {
    assert.match(
      row("conn-a").querySelector(".codegen-warnings").textContent,
      /“SP” became SP_: Arduino code keeps names in capitals for its macros\./,
    );
  } finally {
    PopupManager.close();
  }
});
