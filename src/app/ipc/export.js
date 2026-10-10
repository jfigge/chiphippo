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
 * ipc/export.js — Desktop ▸ Export To (Feature 390): where the files a
 * renderer-side exporter produced (web/scripts/model/export/) are written.
 *
 *   desktop:export-to (format, files)
 *       format  "kicad" | "digital"
 *       files   [{ name, text }] — the export's files, by NAME only
 *
 * THE RENDERER NAMES FILES, NEVER PATHS. Main asks the user where (a native
 * dialog), checks every file name against the shape its format is allowed to
 * write, and writes. Nothing here can be aimed at a path by the renderer, so
 * there is no `knownPath` to consult — the same stance as `desktop:export`.
 *
 * A KICAD export is a FOLDER, chosen with an OPEN panel (`openDirectory`):
 * a project is four files, and in a Mac App Store build a SAVE panel grants
 * only the one file it names — the siblings would be refused. A folder grant
 * covers what is inside it. Inside the folder the files are split by who owns
 * them:
 *
 *   · ours — the schematic and `chiphippo.kicad_sym` — are rewritten, but a
 *     schematic some OTHER program wrote is never replaced (its `generator`
 *     line is checked): a user's hand-drawn sheet is not ours to overwrite;
 *   · the user's — the `.kicad_pro` (design rules, net classes…) and the
 *     `sym-lib-table` — are created when missing and otherwise left alone,
 *     except that our library's line is added to a table that lacks it.
 *
 * So exporting a desktop again into a folder where a board has been laid out
 * updates its schematic and nothing else, and the stable symbol UUIDs keep
 * every footprint linked.
 *
 * A DIGITAL export is one `.dig` file, chosen with an ordinary save panel.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { atomicWrite } = require("../store/io");

/** A file base name, as model/export/file-base.js makes one. */
const FILE_BASE = "[\\w][\\w .-]{0,59}";
/** Windows' device names (model/export/file-base.js RESERVED_FILE_BASE):
    refused, the stem before any dot, whatever the case. */
const RESERVED_BASE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** The library our symbols live in, and the generator stamp we write. */
const KICAD_LIB = "chiphippo";
const KICAD_GENERATOR = "chiphippo";
/** The most an export may hand over, all files together. */
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;

/**
 * Every format, with the file names it may write. A kicad export must carry
 * exactly one of each; the base names of its two project files must agree.
 */
const FORMATS = Object.freeze({
  kicad: Object.freeze({
    folder: true,
    files: Object.freeze([
      new RegExp(`^(${FILE_BASE})\\.kicad_sch$`),
      new RegExp(`^(${FILE_BASE})\\.kicad_pro$`),
      /^chiphippo\.kicad_sym$/,
      /^sym-lib-table$/,
    ]),
  }),
  digital: Object.freeze({
    folder: false,
    files: Object.freeze([new RegExp(`^(${FILE_BASE})\\.dig$`)]),
  }),
});

/**
 * Check an export request. Returns the files in FORMAT order, or null.
 * @returns {Array<{name:string, text:string}>|null}
 */
function validateExport(format, files) {
  const spec = Object.hasOwn(FORMATS, format) ? FORMATS[format] : null;
  if (!spec || !Array.isArray(files) || files.length !== spec.files.length) {
    return null;
  }
  let bytes = 0;
  const ordered = [];
  const bases = new Set();
  for (const re of spec.files) {
    const matches = files.filter(
      (f) =>
        f &&
        typeof f.name === "string" &&
        typeof f.text === "string" &&
        re.test(f.name),
    );
    if (matches.length !== 1) return null;
    const file = matches[0];
    const base = re.exec(file.name)[1];
    if (base != null && RESERVED_BASE.test(base.split(".")[0].trim())) {
      return null;
    }
    if (base != null) bases.add(base.trimEnd());
    bytes += Buffer.byteLength(file.text, "utf8");
    ordered.push({ name: file.name, text: file.text });
  }
  if (bases.size > 1 || bytes > MAX_EXPORT_BYTES) return null;
  return ordered;
}

/** The title-block line every export writes (model/export/kicad.js) — the
    mark that SURVIVES KiCad saving the schematic, which rewrites the
    generator line to its own. */
const KICAD_MARK = "Exported from Chip Hippo";

/**
 * Whether a schematic's text says Chip Hippo wrote it: our generator stamp,
 * or — once KiCad has saved it (`(generator "eeschema")`; even opening it to
 * annotate does that) — our title-block mark. Accepting only the stamp
 * refused every re-export into a folder whose schematic had ever been saved,
 * which is the guide's whole "Exporting again" workflow.
 */
function writtenByUs(text) {
  const head = new RegExp(`^\\s*\\(kicad_sch\\b`);
  if (!head.test(text)) return false;
  return (
    new RegExp(`^[\\s\\S]{0,400}?\\(generator\\s+"?${KICAD_GENERATOR}"?\\)`).test(text) || // prettier-ignore
    // No length bound: comment 1 before it is the desktop's description,
    // which is as long as the user made it.
    new RegExp(`\\(title_block\\b[\\s\\S]*?\\(comment\\s+2\\s+"${KICAD_MARK}"\\)`).test(text) // prettier-ignore
  );
}

/**
 * The project's library table with our library in it: the table as it is if
 * it already names ours, else our line added before its closing paren.
 * @param {string} existing
 * @param {string} ours - the table our export would write from scratch.
 * @returns {string}
 */
function mergeSymLibTable(existing, ours) {
  if (new RegExp(`\\(name\\s+"?${KICAD_LIB}"?\\)`).test(existing)) {
    return existing;
  }
  const lib = extractLib(ours);
  const close = existing.lastIndexOf(")");
  if (!lib || close < 0) return existing;
  return `${existing.slice(0, close).trimEnd()}\n  ${lib}\n)\n`;
}

/** The first `(lib …)` entry in a table, folded onto one line. */
function extractLib(table) {
  const start = table.indexOf("(lib");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < table.length; i++) {
    if (table[i] === "(") depth += 1;
    if (table[i] === ")" && --depth === 0) {
      return table.slice(start, i + 1).replace(/\s*\n\s*/g, " ");
    }
  }
  return null;
}

/**
 * Write a KiCad export into `dir` under the ownership rules in the file note.
 * @returns {{ok:true, written:string[], kept:string[]} |
 *   {ok:false, code:"foreign", file:string}}
 */
function writeKicadFolder(dir, files, io = { fs, atomicWrite }) {
  const at = (name) => path.join(dir, name);
  const exists = (name) => io.fs.existsSync(at(name));
  const read = (name) => io.fs.readFileSync(at(name), "utf8");

  // Refuse BEFORE writing anything: half an export is worse than none.
  const sch = files.find((f) => f.name.endsWith(".kicad_sch"));
  if (exists(sch.name) && !writtenByUs(read(sch.name))) {
    return { ok: false, code: "foreign", file: sch.name };
  }

  const written = [];
  const kept = [];
  for (const file of files) {
    if (file.name.endsWith(".kicad_pro")) {
      if (exists(file.name)) {
        kept.push(file.name);
        continue;
      }
    } else if (file.name === "sym-lib-table" && exists(file.name)) {
      const existing = read(file.name);
      const merged = mergeSymLibTable(existing, file.text);
      if (merged === existing) {
        kept.push(file.name);
        continue;
      }
      io.atomicWrite(at(file.name), merged);
      written.push(file.name);
      continue;
    }
    io.atomicWrite(at(file.name), file.text);
    written.push(file.name);
  }
  return { ok: true, written, kept };
}

/**
 * Register the export channel.
 *
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {Electron.Dialog} deps.dialog
 * @param {() => Electron.BrowserWindow|null} deps.getMainWindow
 * @param {(key: string, fallback: string) => string} deps.m - main's i18n
 * @param {() => object} deps.getBookmarks - the security-scoped bookmark store
 * @param {() => string} deps.defaultDir - where a first export's dialog opens
 */
function registerExportIpc(deps) {
  const { ipcMain, dialog, getMainWindow, m, getBookmarks } = deps;
  /** The folder each format was last exported to, for this session. */
  const lastDir = new Map();

  const show = async (kind, opts) => {
    const win = getMainWindow();
    const alive = win && !win.isDestroyed() ? win : null;
    const call =
      kind === "open" ? dialog.showOpenDialog : dialog.showSaveDialog;
    return alive ? call.call(dialog, alive, opts) : call.call(dialog, opts);
  };

  async function exportKicad(files) {
    const opts = getBookmarks().dialogOpts({
      title: m("dialog.exportKicad.title", "Export to KiCad"),
      message: m(
        "dialog.exportKicad.message",
        "Choose the folder for the KiCad project — a new one, or the one it was exported to before.",
      ),
      buttonLabel: m("dialog.exportKicad.button", "Export Here"),
      defaultPath: lastDir.get("kicad") ?? deps.defaultDir(),
      properties: ["openDirectory", "createDirectory", "promptToCreate"],
    });
    const result = await show("open", opts);
    if (result.canceled || !result.filePaths?.[0]) return null;
    getBookmarks().captureOpen(result);
    const dir = path.resolve(result.filePaths[0]);
    fs.mkdirSync(dir, { recursive: true });
    const res = writeKicadFolder(dir, files);
    if (!res.ok) return { ...res, path: dir };
    lastDir.set("kicad", dir);
    return { ...res, path: dir };
  }

  async function exportDigital(files) {
    const [file] = files;
    const from = lastDir.get("digital") ?? deps.defaultDir();
    const opts = getBookmarks().dialogOpts({
      title: m("dialog.exportDigital.title", "Export to Digital"),
      defaultPath: path.join(from, file.name),
      filters: [
        { name: m("dialog.filter.digital", "Digital circuit"), extensions: ["dig"] }, // prettier-ignore
      ],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    const result = await show("save", opts);
    if (result.canceled || !result.filePath) return null;
    getBookmarks().captureSave(result);
    const target = path.resolve(result.filePath);
    atomicWrite(target, file.text);
    lastDir.set("digital", path.dirname(target));
    return {
      ok: true,
      path: target,
      written: [path.basename(target)],
      kept: [],
    };
  }

  ipcMain.handle("desktop:export-to", async (_event, format, files) => {
    const valid = validateExport(format, files);
    if (!valid) return { ok: false, code: "invalid" };
    try {
      return format === "kicad"
        ? await exportKicad(valid)
        : await exportDigital(valid);
    } catch (err) {
      return { ok: false, code: "write", error: err.message };
    }
  });
}

module.exports = {
  registerExportIpc,
  validateExport,
  writeKicadFolder,
  mergeSymLibTable,
  writtenByUs,
  FORMATS,
};
