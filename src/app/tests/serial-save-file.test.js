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

// Tests for Generate's Save As… — `integration:save-file` in ipc/serial.js
// and the pure memory behind it (serial/saved-files.js). Pinned: the panel
// opens where THAT file was last saved for THAT connection and design (and
// on the bare name the first time, or when the folder has gone); the filter
// follows the file's extension; the renderer's name is a suggestion that is
// never a path; a cancel remembers nothing; and deleting a connection forgets
// where its files went.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { registerSerialIpc } = require("../ipc/serial");
const {
  MAX_SCOPES,
  savedPath,
  rememberSaved,
  forgetDeleted,
} = require("../serial/saved-files");

const NANO = { id: "conn-0a0b0c0d0e0f", name: "Nano", port: "/dev/cu.nano" };
const UNO = { id: "conn-111111111111", name: "Uno", port: "/dev/cu.uno" };
const DESIGN = "/projects/bench.chiphippo|t1";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-save-"));
  const settings = { serialConnections: [NANO, UNO], codegenSaves: {} };
  const handlers = new Map();
  const panels = []; // every Save panel's options, in order
  let answer = null; // what the next panel returns: a path, or null (cancel)
  const ipc = registerSerialIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    BrowserWindow: class {},
    dialog: {
      showSaveDialog: async (opts) => {
        panels.push(opts);
        return answer
          ? { canceled: false, filePath: answer }
          : { canceled: true, filePath: "" };
      },
    },
    getSettings: () => settings,
    setSettings: (patch) => Object.assign(settings, patch),
    getMainWindow: () => null,
    m: (_key, fallback) => fallback,
    windowBackground: () => "#000",
    appDir: __dirname,
  });
  const save = (id, scope, name, text = "// text\n") =>
    handlers.get("integration:save-file")({}, id, scope, name, text);
  return {
    dir,
    settings,
    panels,
    save,
    answer: (p) => (answer = p),
    setConnections: (list) => {
      settings.serialConnections = list;
      ipc.forgetDeletedConnections();
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test("the first Save As… of a file offers its name; the next opens where it went", async () => {
  const s = setup();
  try {
    const target = path.join(s.dir, "ChipHippo.h");
    s.answer(target);
    const r = await s.save(NANO.id, DESIGN, "ChipHippo.h", "// header\n");
    assert.deepEqual(r, { ok: true, path: target });
    assert.equal(fs.readFileSync(target, "utf8"), "// header\n");
    assert.equal(s.panels[0].defaultPath, "ChipHippo.h");

    await s.save(NANO.id, DESIGN, "ChipHippo.h");
    assert.equal(s.panels[1].defaultPath, target, "where it was saved last");
  } finally {
    s.cleanup();
  }
});

test("the memory is per FILE, per CONNECTION and per DESIGN", async () => {
  const s = setup();
  try {
    s.answer(path.join(s.dir, "ChipHippo.h"));
    await s.save(NANO.id, DESIGN, "ChipHippo.h");

    await s.save(NANO.id, DESIGN, "ChipHippoExample.ino");
    await s.save(UNO.id, DESIGN, "ChipHippo.h");
    await s.save(NANO.id, "/projects/other.chiphippo|t1", "ChipHippo.h");
    await s.save(NANO.id, "/projects/bench.chiphippo|t2", "ChipHippo.h");
    assert.deepEqual(
      s.panels.slice(1).map((p) => p.defaultPath),
      ["ChipHippoExample.ino", "ChipHippo.h", "ChipHippo.h", "ChipHippo.h"],
      "another file, board, project or desktop starts afresh",
    );
  } finally {
    s.cleanup();
  }
});

test("a remembered folder that has gone falls back to the bare name", async () => {
  const s = setup();
  try {
    const gone = path.join(s.dir, "sketch");
    fs.mkdirSync(gone);
    s.answer(path.join(gone, "ChipHippo.h"));
    await s.save(NANO.id, DESIGN, "ChipHippo.h");
    fs.rmSync(gone, { recursive: true });
    s.answer(null);
    await s.save(NANO.id, DESIGN, "ChipHippo.h");
    assert.equal(s.panels[1].defaultPath, "ChipHippo.h");
  } finally {
    s.cleanup();
  }
});

test("the filter follows the extension, and a cancel writes and remembers nothing", async () => {
  const s = setup();
  try {
    s.answer(null);
    assert.equal(await s.save(NANO.id, DESIGN, "ChipHippo.h"), null);
    await s.save(NANO.id, DESIGN, "ChipHippoExample.ino");
    await s.save(NANO.id, DESIGN, "main.py");
    assert.deepEqual(
      s.panels.map((p) => p.filters),
      [
        [{ name: "C/C++ header", extensions: ["h"] }],
        [{ name: "Arduino sketch", extensions: ["ino"] }],
        [{ name: "Python source", extensions: ["py"] }],
      ],
    );
    assert.ok(
      s.panels.every((p) => p.properties.includes("showOverwriteConfirmation")),
      "replacing a file is the panel's question",
    );
    assert.deepEqual(s.settings.codegenSaves, {});
  } finally {
    s.cleanup();
  }
});

test("a name that is not a generated file's, or a bad connection, never reaches a panel", async () => {
  const s = setup();
  try {
    for (const [id, name] of [
      [NANO.id, "../../etc/passwd.h"],
      [NANO.id, "/tmp/ChipHippo.h"],
      [NANO.id, "ChipHippo.exe"],
      [NANO.id, ""],
      ["not a connection id", "ChipHippo.h"],
    ]) {
      assert.equal(await s.save(id, DESIGN, name), null, name);
    }
    assert.equal(await s.save(NANO.id, DESIGN, "ChipHippo.h", ""), null);
    assert.equal(await s.save(NANO.id, 42, "ChipHippo.h"), null);
    assert.equal(s.panels.length, 0);
  } finally {
    s.cleanup();
  }
});

test("a failed write says why and remembers nothing", async () => {
  const s = setup();
  try {
    s.answer(path.join(s.dir, "missing", "ChipHippo.h"));
    const r = await s.save(NANO.id, DESIGN, "ChipHippo.h");
    assert.equal(r.ok, false);
    assert.match(r.error, /ENOENT/);
    assert.deepEqual(s.settings.codegenSaves, {});
  } finally {
    s.cleanup();
  }
});

test("deleting a connection forgets where its files were saved", async () => {
  const s = setup();
  try {
    s.answer(path.join(s.dir, "ChipHippo.h"));
    await s.save(NANO.id, DESIGN, "ChipHippo.h");
    await s.save(UNO.id, DESIGN, "ChipHippo.h");
    s.setConnections([UNO]);
    assert.deepEqual(Object.keys(s.settings.codegenSaves), [UNO.id]);
  } finally {
    s.cleanup();
  }
});

test("saved-files: each connection keeps its most recent designs, a re-save counting as recent", () => {
  let all = {};
  for (let i = 0; i < MAX_SCOPES; i++) {
    all = rememberSaved(all, "c", `design${i}`, "a.h", `/d${i}/a.h`);
  }
  all = rememberSaved(all, "c", "design0", "a.h", "/d0/a.h"); // recent again
  all = rememberSaved(all, "c", "new", "a.h", "/new/a.h");
  assert.equal(Object.keys(all.c).length, MAX_SCOPES);
  assert.equal(savedPath(all, "c", "design1", "a.h"), null, "the oldest went");
  assert.equal(savedPath(all, "c", "design0", "a.h"), "/d0/a.h");
  assert.equal(savedPath(all, "c", "new", "a.h"), "/new/a.h");
});

test("saved-files: a stored value that is not a record reads as empty", () => {
  for (const junk of [null, undefined, "x", [], 7]) {
    assert.equal(savedPath(junk, "c", "s", "a.h"), null);
    assert.deepEqual(
      forgetDeleted(junk, () => true),
      {},
    );
    assert.deepEqual(rememberSaved(junk, "c", "s", "a.h", "/p"), {
      c: { s: { "a.h": "/p" } },
    });
  }
  assert.equal(savedPath({ c: { s: { "a.h": 5 } } }, "c", "s", "a.h"), null);
});
