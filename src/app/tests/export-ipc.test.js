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

/**
 * tests/export-ipc.test.js — main's half of Desktop ▸ Export To (Feature 390):
 * the renderer names FILES, never paths, and main writes a KiCad folder by
 * who owns each file in it.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  registerExportIpc,
  validateExport,
  writeKicadFolder,
  mergeSymLibTable,
  writtenByUs,
} = require("../ipc/export");

const TABLE =
  '(sym_lib_table\n\t(version 7)\n\t(lib\n\t\t(name "chiphippo")\n\t\t(type "KiCad")\n' +
  '\t\t(uri "${KIPRJMOD}/chiphippo.kicad_sym")\n\t\t(options "")\n\t\t(descr "x")\n\t)\n)\n';

const kicadFiles = (
  base = "Bench",
  sch = '(kicad_sch\n\t(version 20231120)\n\t(generator "chiphippo")\n)\n',
) => [
  // prettier-ignore
  { name: `${base}.kicad_sch`, text: sch },
  { name: `${base}.kicad_pro`, text: "{}\n" },
  { name: "chiphippo.kicad_sym", text: "(kicad_symbol_lib)\n" },
  { name: "sym-lib-table", text: TABLE },
];

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-export-"));

// ── validateExport ───────────────────────────────────────────────────────────

test("a request is exactly its format's files, by name, and nothing else", () => {
  assert.ok(validateExport("kicad", kicadFiles()));
  assert.ok(validateExport("digital", [{ name: "Bench.dig", text: "<x/>" }]));
  // Unknown format, wrong count, a path, a stray file, mismatched bases.
  assert.equal(validateExport("gerber", kicadFiles()), null);
  assert.equal(validateExport("kicad", kicadFiles().slice(1)), null);
  assert.equal(
    validateExport("digital", [{ name: "../evil.dig", text: "" }]),
    null,
  );
  assert.equal(
    validateExport("digital", [{ name: "/etc/passwd.dig", text: "" }]),
    null,
  );
  const stray = kicadFiles();
  stray[2] = { name: "other.kicad_sym", text: "" };
  assert.equal(validateExport("kicad", stray), null);
  const split = kicadFiles();
  split[1] = { name: "Other.kicad_pro", text: "{}" };
  assert.equal(validateExport("kicad", split), null, "one project name");
  assert.equal(validateExport("__proto__", []), null);
  assert.equal(validateExport("kicad", "nope"), null);
});

// ── writeKicadFolder ─────────────────────────────────────────────────────────

test("a fresh folder gets all four files", () => {
  const dir = tmp();
  const res = writeKicadFolder(dir, validateExport("kicad", kicadFiles()));
  assert.equal(res.ok, true);
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    "Bench.kicad_pro",
    "Bench.kicad_sch",
    "chiphippo.kicad_sym",
    "sym-lib-table",
  ]);
});

test("a re-export replaces ours and keeps the user's project file", () => {
  const dir = tmp();
  writeKicadFolder(dir, validateExport("kicad", kicadFiles()));
  fs.writeFileSync(path.join(dir, "Bench.kicad_pro"), '{"mine": true}');
  fs.writeFileSync(path.join(dir, "Bench.kicad_pcb"), "(board)");
  const next = kicadFiles(
    "Bench",
    '(kicad_sch (version 20231120) (generator "chiphippo") (new))',
  );
  const res = writeKicadFolder(dir, validateExport("kicad", next));
  assert.equal(res.ok, true);
  assert.deepEqual(res.kept.sort(), ["Bench.kicad_pro", "sym-lib-table"]);
  assert.match(fs.readFileSync(path.join(dir, "Bench.kicad_sch"), "utf8"), /\(new\)/); // prettier-ignore
  assert.equal(fs.readFileSync(path.join(dir, "Bench.kicad_pro"), "utf8"), '{"mine": true}'); // prettier-ignore
  assert.equal(fs.readFileSync(path.join(dir, "Bench.kicad_pcb"), "utf8"), "(board)"); // prettier-ignore
});

test("a schematic someone else wrote is never replaced — and nothing is written", () => {
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, "Bench.kicad_sch"),
    '(kicad_sch (version 20231120) (generator "eeschema"))',
  );
  const res = writeKicadFolder(dir, validateExport("kicad", kicadFiles()));
  assert.deepEqual(res, {
    ok: false,
    code: "foreign",
    file: "Bench.kicad_sch",
  });
  assert.deepEqual(fs.readdirSync(dir), ["Bench.kicad_sch"]);
});

test("our library joins a table that lacks it, once", () => {
  const theirs =
    '(sym_lib_table\n  (version 7)\n  (lib (name "mine")(type "KiCad")(uri "x")(options "")(descr ""))\n)\n';
  const merged = mergeSymLibTable(theirs, TABLE);
  assert.match(merged, /\(name "mine"\)/);
  assert.match(merged, /\(name "chiphippo"\)/);
  assert.equal(mergeSymLibTable(merged, TABLE), merged, "idempotent");
  // Still one balanced list.
  const depth = [...merged].reduce(
    (d, c) => (c === "(" ? d + 1 : c === ")" ? d - 1 : d),
    0,
  );
  assert.equal(depth, 0);
});

test("writtenByUs reads the generator line, not the whole file", () => {
  assert.ok(
    writtenByUs('(kicad_sch\n\t(version 1)\n\t(generator "chiphippo")'),
  );
  assert.ok(!writtenByUs('(kicad_sch (version 1) (generator "eeschema"))'));
  assert.ok(!writtenByUs('(something (generator "chiphippo"))'));
});

// ── The channel ──────────────────────────────────────────────────────────────

function harness({ open, save } = {}) {
  const handlers = new Map();
  const captured = [];
  registerExportIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    dialog: {
      showOpenDialog: async (_w, opts) => open(opts ?? _w),
      showSaveDialog: async (_w, opts) => save(opts ?? _w),
    },
    getMainWindow: () => null,
    m: (_key, fallback) => fallback,
    getBookmarks: () => ({
      dialogOpts: (o) => o,
      captureOpen: (r) => captured.push(["open", r]),
      captureSave: (r) => captured.push(["save", r]),
    }),
    defaultDir: () => os.tmpdir(),
  });
  return { call: handlers.get("desktop:export-to"), captured };
}

test("a KiCad export asks for a FOLDER and writes into it", async () => {
  const dir = tmp();
  let asked;
  const { call, captured } = harness({
    open: (opts) => {
      asked = opts;
      return { canceled: false, filePaths: [dir] };
    },
  });
  const res = await call({}, "kicad", kicadFiles());
  assert.ok(asked.properties.includes("openDirectory"));
  assert.equal(res.ok, true);
  assert.equal(res.path, dir);
  assert.equal(captured[0][0], "open", "the folder's grant is kept (MAS)");
  assert.equal(fs.readdirSync(dir).length, 4);
});

test("a cancelled dialog is null, a bad request is refused unwritten", async () => {
  const { call } = harness({
    open: () => ({ canceled: true, filePaths: [] }),
    save: () => ({ canceled: true }),
  });
  assert.equal(await call({}, "kicad", kicadFiles()), null);
  assert.equal(await call({}, "digital", [{ name: "x.dig", text: "" }]), null);
  assert.deepEqual(await call({}, "kicad", []), { ok: false, code: "invalid" });
});

test("a Digital export saves one file where the panel says", async () => {
  const dir = tmp();
  const target = path.join(dir, "Chosen.dig");
  const { call } = harness({
    save: (opts) => {
      assert.match(opts.defaultPath, /Bench\.dig$/);
      return { canceled: false, filePath: target };
    },
  });
  const res = await call({}, "digital", [{ name: "Bench.dig", text: "<c/>" }]);
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(target, "utf8"), "<c/>");
});
